import { loadKnowledgeBase } from '../whatsapp/knowledge/index.js';

/**
 * Vue filtrée sur la base de connaissances HARX construite à partir du code réel de la plateforme (src/whatsapp/kb).
 * L'agent SalesIQ parle à des visiteurs anonymes : seules les rubriques listées ici sont consultables. Les routes d'API,
 * les messages d'erreur du back-office, la facturation, les rôles, la téléphonie… restent hors de portée.
 * Les chemins de fichiers sources ne sont jamais renvoyés à Claude, donc jamais cités au visiteur.
 */
export const DEFAULT_KB_TOPICS = ['reps-matching', 'account-signup-login', 'platform-overview', 'gen:ui-rep-app.json'];

export function createVisitorKb({ kb = loadKnowledgeBase(), topics = DEFAULT_KB_TOPICS } = {}) {
  const allowed = new Set(topics);
  const docIdOf = (chunkId) => String(chunkId).split('#')[0];
  const docs = kb.docs.filter((d) => allowed.has(d.id));
  return {
    kind: 'visitor-kb',
    topics: [...allowed],
    docs,
    get size() { return kb.chunks.filter((c) => allowed.has(c.docId)).length; },
    /** @returns {Array<{topic: string, section: string, excerpt: string}>} sans chemins de fichiers */
    search(query, { limit = 5 } = {}) {
      const hits = kb.search(String(query || '').slice(0, 300), { limit: 60, audience: 'all' });
      return hits.filter((h) => allowed.has(docIdOf(h.id))).slice(0, limit)
        .map((h) => ({ topic: h.title, section: h.heading, excerpt: h.text.slice(0, 1800) }));
    },
    /** Rubrique complète, si elle est autorisée. */
    readTopic(id) {
      if (!allowed.has(id) || id.startsWith('gen:')) return null;
      const doc = kb.getDoc(id);
      return doc ? { title: doc.title, text: doc.text.slice(0, 9000) } : null;
    },
    topicIndex() {
      return docs.map((d) => `- ${d.id}: ${d.summary || d.title}`).join('\n');
    },
  };
}
