#!/usr/bin/env node
/**
 * Régénère les faits de la base de connaissances HARX directement depuis le code source :
 *   - routes API de chaque service (méthode + chemin + fichier),
 *   - catalogue des permissions d'équipe (application entreprise),
 *   - messages d'erreur renvoyés par les API (pour « expliquer les messages d'erreur »),
 *   - états et énumérations des modèles de données clés.
 * Sortie : src/whatsapp/kb/generated/*.json (relus par le moteur de recherche). À relancer quand la plateforme évolue :
 *
 *   node scripts/buildKnowledgeBase.mjs /chemin/vers/dossier-contenant-les-depots-v25_*
 *
 * Les rubriques rédigées (src/whatsapp/kb/*.md) restent éditées à la main ; leur front-matter `sources:` + `verified:`
 * indique où vérifier si une rubrique est devenue obsolète (voir `--check-sources`).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'src', 'whatsapp', 'kb', 'generated');
const ROOT = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.resolve(HERE, '..', '..'));

const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-bar', 'build', '.git', 'tests', 'test', '__tests__', 'scratch', 'temp', 'e2e']);
const SERVICE_LABEL = {
  v25_registration_backend: 'registration (accounts, login, company members, call-center)',
  v25_comporchestrator_back: 'orchestrator (subscriptions, billing, phone numbers, reception, wallet, minutes)',
  v25_gigsmanualcreation_backend: 'gigs (GIG creation and management)',
  v25_dash_calls_backend: 'calls (call journal, call analysis/QA, leads of the call dashboard)',
  v25_dashboard_backend: 'dashboard (leads import, CRM, integrations)',
  v25_matching_backend: 'matching (REP/GIG matching, enrollment, time slots and reservations)',
  v25_repscreationwizard_backend: 'REP profile wizard (REP profile, skills, languages, REP subscription)',
  v25_searchcompanywizard_backend: 'company profile wizard (company search/profile)',
  v25_knowledgebase_backend: 'knowledge base (documents and RAG)',
  v25_platform_training_backend: 'training (journeys, assessments)',
  v25_dash_rep_back: 'REP dashboard',
};

function* walk(dir, depth = 0) {
  if (depth > 8 || !fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(path.join(dir, e.name), depth + 1); } else yield path.join(dir, e.name);
  }
}
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const rel = (f) => path.relative(ROOT, f);

// ---------- 1. Routes ----------
function collectRoutes() {
  const chunks = [];
  for (const repo of fs.readdirSync(ROOT).filter((d) => d.startsWith('v25_') && SERVICE_LABEL[d])) {
    const files = [...walk(path.join(ROOT, repo, 'src'))].filter((f) => /\.(js|ts)$/.test(f) && !/\.d\.ts$/.test(f));
    // préfixes de montage : app.use('/api/x', fooRoutes)
    const mounts = new Map();
    const importFile = new Map();
    for (const f of files) {
      const src = read(f);
      for (const m of src.matchAll(/import\s+(?:\{\s*)?(\w+)(?:\s*\})?\s+from\s+['"](\.[^'"]+)['"]/g)) importFile.set(m[1], m[2]);
      for (const m of src.matchAll(/\.use\(\s*['"]([^'"]+)['"]\s*,\s*(\w+)\s*\)/g)) mounts.set(m[2], m[1]);
      for (const m of src.matchAll(/(\w+)\s*=\s*require\(['"](\.[^'"]+)['"]\)/g)) importFile.set(m[1], m[2]);
    }
    const prefixByFile = new Map();
    for (const [ident, prefix] of mounts) { const imp = importFile.get(ident); if (imp) prefixByFile.set(path.basename(imp).replace(/\.(js|ts)$/, ''), prefix); }
    for (const f of files) {
      const src = read(f);
      const lines = [...src.matchAll(/\b(?:router|app)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`);
      if (!lines.length) continue;
      const base = path.basename(f).replace(/\.(js|ts)$/, '');
      const prefix = prefixByFile.get(base) || prefixByFile.get(base.replace(/Routes?$/, '')) || '';
      for (let i = 0; i < lines.length; i += 30) {
        chunks.push({
          title: `API routes - ${repo} - ${base}`,
          heading: `${base}${prefix ? ` (mounted at ${prefix})` : ''}`,
          product: 'platform', audience: 'all', sources: [rel(f)],
          text: `Service: ${SERVICE_LABEL[repo]}\nRoute file: ${rel(f)}${prefix ? `\nMounted at: ${prefix}` : ''}\nEndpoints (relative to the mount):\n${lines.slice(i, i + 30).join('\n')}`,
        });
      }
    }
  }
  return chunks;
}

// ---------- 2. Permissions ----------
function collectPermissions() {
  const f = path.join(ROOT, 'v25_comporchestrator_front', 'src', 'constants', 'companyPermissions.ts');
  const src = read(f);
  if (!src) return [];
  const groups = [];
  for (const g of src.matchAll(/\{\s*id:\s*'(\w+)',\s*label:\s*'([^']+)',\s*actions:\s*\[([\s\S]*?)\],\s*\}/g)) {
    const actions = [...g[3].matchAll(/id:\s*'(\w+)',\s*label:\s*'([^']+)'/g)].map((a) => `${a[1]} (${a[2]})`);
    groups.push(`- ${g[2]} [${g[1]}]: ${actions.join(', ')}`);
  }
  const presets = src.match(/PRESET[\s\S]{0,1500}/)?.[0] || '';
  return [{
    title: 'Team permissions catalogue (company application)', heading: 'Permission groups and actions', product: 'taas', audience: 'company', sources: [rel(f)],
    text: `Company team members are given permissions per group; a permission is "<group>.<action>". Groups and actions:\n${groups.join('\n')}\n${presets ? `\nPresets excerpt:\n${presets.slice(0, 900)}` : ''}`,
  }];
}

// ---------- 3. Messages d'erreur ----------
function collectErrors() {
  const chunks = [];
  const re = /(?:status\((\d{3})\)\s*\.json\(\s*\{[^}]*?(?:error|message)\s*:\s*|(?:error|message)\s*:\s*)(['"`])((?:(?!\2)[^\\\n]|\\.){12,240})\2/g;
  for (const repo of fs.readdirSync(ROOT).filter((d) => d.startsWith('v25_') && SERVICE_LABEL[d])) {
    for (const f of walk(path.join(ROOT, repo, 'src'))) {
      if (!/\.(js|ts)$/.test(f) || /\.test\.|\.d\.ts$/.test(f)) continue;
      const src = read(f);
      const seen = new Set();
      const items = [];
      for (const m of src.matchAll(re)) {
        const msg = m[3].replace(/\\(['"`])/g, '$1');
        if (/\$\{|^[A-Za-z_]+$/.test(msg) || seen.has(msg) || !/[ a-zA-Zéèàç]{8,}/.test(msg)) continue;
        seen.add(msg);
        items.push(`${m[1] || '4xx/5xx'} - "${msg}"`);
      }
      if (items.length < 2) continue;
      const base = path.basename(f).replace(/\.(js|ts)$/, '');
      for (let i = 0; i < items.length; i += 25) {
        chunks.push({
          title: `Error messages - ${repo} - ${base}`, heading: `Messages returned by ${base}`, product: 'platform', audience: 'all', sources: [rel(f)],
          text: `API error / status messages returned by ${rel(f)} (${SERVICE_LABEL[repo]}). Use to explain an error the user quotes; the file name tells which area it belongs to.\n${items.slice(i, i + 25).join('\n')}`,
        });
      }
    }
  }
  return chunks;
}

// ---------- 4. Énumérations de statut des modèles ----------
function collectEnums() {
  const chunks = [];
  for (const repo of fs.readdirSync(ROOT).filter((d) => d.startsWith('v25_') && SERVICE_LABEL[d])) {
    for (const f of walk(path.join(ROOT, repo, 'src'))) {
      if (!/models?[\\/].+\.(js|ts)$/.test(f.replace(/\\/g, '/')) && !/models?[\\/]/.test(f)) continue;
      const src = read(f);
      const items = [...src.matchAll(/(\w+)\s*:\s*\{[^{}]*?enum\s*:\s*\[([^\]]+)\]/g)].map((m) => `${m[1]}: ${m[2].replace(/\s+/g, ' ').trim()}`);
      if (!items.length) continue;
      chunks.push({ title: `Data model states - ${path.basename(f)}`, heading: `Allowed values in ${path.basename(f)}`, product: 'platform', audience: 'all', sources: [rel(f)], text: `Allowed values of fields in the ${path.basename(f).replace(/\.(js|ts)$/, '')} model (${SERVICE_LABEL[repo]}):\n${items.join('\n')}` });
    }
  }
  return chunks;
}


// ---------- 5. Textes réels de l'interface (libellés, guides, messages) ----------
function flatten(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flatten(v, key, out);
    else if (typeof v === 'string' && v.trim().length >= 4) out.push([key, v.replace(/\s+/g, ' ').trim()]);
  }
  return out;
}
function jsonLocaleChunks(repo, file, product, audience, label) {
  const f = path.join(ROOT, repo, file);
  let json;
  try { json = JSON.parse(read(f)); } catch { return []; }
  const chunks = [];
  for (const [ns, val] of Object.entries(json)) {
    const pairs = flatten(val, ns);
    for (let i = 0; i < pairs.length; i += 18) {
      chunks.push({ title: `${label} screen texts - ${ns}`, heading: `${ns} (${i / 18 + 1})`, product, audience, sources: [rel(f)], text: `Real user-interface texts of the "${ns}" area of the ${label} (labels, guides, hints, error toasts). Use them to describe screens and steps exactly as the user sees them.\n${pairs.slice(i, i + 18).map(([k, v]) => `${k}: ${v}`).join('\n')}` });
    }
  }
  return chunks;
}
function callCenterChunks() {
  const f = path.join(ROOT, 'v25_callcenter_front', 'src', 'i18n', 'en.ts');
  const src = read(f);
  const pairs = [...src.matchAll(/^\s*"((?:[^"\\]|\\.)+)":\s*"((?:[^"\\]|\\.)*)",?\s*$/gm)].map((m) => [m[1], m[2]]).filter(([fr, en]) => fr.length >= 22 && en.length >= 18);
  const chunks = [];
  for (let i = 0; i < pairs.length; i += 14) {
    chunks.push({ title: 'HARX Telephony screen texts', heading: `Telephony UI texts (${i / 14 + 1})`, product: 'telephony', audience: 'company', sources: [rel(f)], text: `Real user-interface texts of the HARX Telephony application (French original => English translation).\n${pairs.slice(i, i + 14).map(([fr, en]) => `FR: ${fr}\nEN: ${en}`).join('\n')}` });
  }
  return chunks;
}

// ---------- Vérification des sources des rubriques rédigées ----------
function checkSources() {
  const kbDir = path.resolve(HERE, '..', 'src', 'whatsapp', 'kb');
  let missing = 0;
  for (const f of fs.readdirSync(kbDir).filter((x) => x.endsWith('.md'))) {
    const fm = /^---\n([\s\S]*?)\n---/.exec(read(path.join(kbDir, f)))?.[1] || '';
    const sources = (/sources:\s*\[(.*)\]/.exec(fm)?.[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const s of sources) if (!fs.existsSync(path.join(ROOT, s))) { console.log(`MISSING  ${f}: ${s}`); missing += 1; }
  }
  console.log(missing ? `${missing} source file(s) referenced by the knowledge base no longer exist: review those topics.` : 'All documented source files still exist.');
  process.exitCode = missing ? 1 : 0;
}

if (process.argv.includes('--check-sources')) { checkSources(); process.exit(); }

fs.mkdirSync(OUT, { recursive: true });
const outputs = { 'api-routes.json': collectRoutes(), 'permissions.json': collectPermissions(), 'error-messages.json': collectErrors(), 'model-states.json': collectEnums(),
  'ui-company-app.json': jsonLocaleChunks('v25_comporchestrator_front', 'src/i18n/locales/en.json', 'taas', 'company', 'HARX company application'),
  'ui-rep-app.json': jsonLocaleChunks('v25_reporchestrator_front', 'src/i18n/locales/en.json', 'taas', 'rep', 'HARX REP application'),
  'ui-telephony-app.json': callCenterChunks() };
for (const [name, chunks] of Object.entries(outputs)) {
  fs.writeFileSync(path.join(OUT, name), `${JSON.stringify({ generatedFrom: 'scripts/buildKnowledgeBase.mjs', chunks }, null, 1)}\n`);
  console.log(`${name.padEnd(22)} ${String(chunks.length).padStart(4)} chunks`);
}
