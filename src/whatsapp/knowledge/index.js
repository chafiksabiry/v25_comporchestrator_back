import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Base de connaissances HARX : source de vérité de l'agent.
 *  - kb/*.md          : rubriques rédigées à partir du code réel (front, back, modèles) ; chaque fichier cite ses `sources`.
 *  - kb/generated/*.json : faits extraits automatiquement du code par scripts/buildKnowledgeBase.mjs (routes, permissions,
 *                          messages d'erreur, limites) -> se régénèrent quand la plateforme évolue.
 * Recherche : BM25 en mémoire (sans service externe). Claude formule les requêtes en français/anglais quelle que soit la
 * langue de l'utilisateur ; la base est donc écrite en anglais avec les libellés d'interface tels qu'ils apparaissent.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_KB_DIR = path.resolve(HERE, '..', 'kb');

const STOPWORDS = new Set('the a an and or of to in on for with is are be by at as it this that from how what why where when which who i you my your me do does can cant cannot le la les un une des du de et ou en pour avec est sont par au aux ce cet cette ces je tu il nous vous mon ma mes comment quoi pourquoi où quand que qui dans sur'.split(' '));

export function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .match(/[a-z0-9_]+/g)?.filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map((t) => (t.length > 4 ? t.replace(/(?:ing|ed|es|s|x)$/, '') : t)) || [];
}

function parseFrontMatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    meta[kv[1]] = v;
  }
  return { meta, body: m[2] };
}

/** Découpe un document Markdown en sections « ## ». Le titre du document est répété dans chaque chunk pour le contexte. */
function chunkMarkdown(meta, body) {
  const lines = body.split(/\r?\n/);
  const chunks = [];
  let heading = meta.title || meta.id;
  let buf = [];
  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) chunks.push({ heading, text });
    buf = [];
  };
  for (const line of lines) {
    if (/^##\s+/.test(line)) { flush(); heading = line.replace(/^##\s+/, '').trim(); } else if (/^#\s+/.test(line) && !chunks.length && !buf.length) { /* titre H1 : ignoré */ } else buf.push(line);
  }
  flush();
  // Sections très longues : on les coupe par paragraphes (~1800 caractères) pour garder des extraits ciblés.
  const out = [];
  for (const c of chunks) {
    if (c.text.length <= 2200) { out.push(c); continue; }
    let cur = '';
    for (const para of c.text.split(/\n{2,}/)) {
      if (cur && (cur + para).length > 1800) { out.push({ heading: c.heading, text: cur.trim() }); cur = ''; }
      cur += `${para}\n\n`;
    }
    if (cur.trim()) out.push({ heading: c.heading, text: cur.trim() });
  }
  return out;
}

export function loadKnowledgeBase(dir = DEFAULT_KB_DIR) {
  const docs = [];
  const chunks = [];
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort() : [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    const { meta, body } = parseFrontMatter(raw);
    const id = meta.id || f.replace(/\.md$/, '');
    const doc = { id, title: meta.title || id, product: meta.product || 'platform', audience: meta.audience || 'all', sources: meta.sources || [], verified: meta.verified || '', summary: meta.summary || '', file: f };
    docs.push(doc);
    chunkMarkdown(doc, body).forEach((c, i) => chunks.push({ id: `${id}#${i}`, docId: id, title: doc.title, heading: c.heading, text: c.text, product: doc.product, audience: doc.audience, sources: doc.sources, kind: 'doc' }));
  }
  const genDir = path.join(dir, 'generated');
  if (fs.existsSync(genDir)) {
    for (const f of fs.readdirSync(genDir).filter((x) => x.endsWith('.json')).sort()) {
      let arr;
      try { arr = JSON.parse(fs.readFileSync(path.join(genDir, f), 'utf8')); } catch { continue; }
      const items = Array.isArray(arr) ? arr : arr.chunks || [];
      items.forEach((c, i) => chunks.push({ id: `gen:${f}#${i}`, docId: `gen:${f}`, title: c.title || f, heading: c.heading || c.title || f, text: c.text, product: c.product || 'platform', audience: c.audience || 'all', sources: c.sources || [], kind: 'generated' }));
    }
  }
  return buildIndex(docs, chunks);
}

function buildIndex(docs, chunks) {
  const N = chunks.length;
  const df = new Map();
  const tfs = chunks.map((c) => {
    const toks = tokenize(`${c.title} ${c.heading} ${c.heading} ${c.text}`);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    return { tf, len: toks.length };
  });
  const avgLen = tfs.reduce((s, x) => s + x.len, 0) / Math.max(N, 1);
  const k1 = 1.4;
  const b = 0.75;

  return {
    docs,
    chunks,
    size: N,
    /**
     * @param {string} query
     * @param {{limit?: number, audience?: 'company'|'rep'|'all', product?: string}} opts
     */
    search(query, { limit = 5, audience = 'all', product = null } = {}) {
      const qt = [...new Set(tokenize(query))];
      if (!qt.length) return [];
      const scored = [];
      chunks.forEach((c, i) => {
        if (audience !== 'all' && c.audience !== 'all' && c.audience !== audience) return;
        if (product && c.product !== product && c.product !== 'platform') return;
        const { tf, len } = tfs[i];
        let s = 0;
        for (const t of qt) {
          const f = tf.get(t);
          if (!f) continue;
          const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
          s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / avgLen)));
        }
        if (s > 0) scored.push({ chunk: c, score: s });
      });
      scored.sort((x, y) => y.score - x.score);
      return scored.slice(0, limit).map(({ chunk, score }) => ({ id: chunk.id, title: chunk.title, heading: chunk.heading, text: chunk.text, sources: chunk.sources, kind: chunk.kind, score: Math.round(score * 100) / 100 }));
    },
    getDoc(id) {
      const doc = docs.find((d) => d.id === id);
      if (!doc) return null;
      return { ...doc, text: chunks.filter((c) => c.docId === id).map((c) => `## ${c.heading}\n${c.text}`).join('\n\n') };
    },
    /** Index compact (une ligne par rubrique) injecté dans le prompt système pour orienter les recherches de Claude. */
    topicIndex() {
      return docs.map((d) => `- ${d.id} [${d.product}/${d.audience}]: ${d.summary || d.title}`).join('\n');
    },
  };
}
