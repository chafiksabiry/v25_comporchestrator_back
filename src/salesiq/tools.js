import { stepFromStage } from './zohoClient.js';
import { isValidEmail } from './payload.js';

/** Outils exposés à Claude. lookup_candidate est la seule lecture de données ; send_reply et flag_for_team terminent la boucle. */
export const TOOL_DEFINITIONS = [
  {
    name: 'search_knowledge',
    description: "Cherche dans la base de connaissances HARX, construite à partir du code réel de la plateforme (parcours du rep : profil, marketplace, candidature, matching, formation, espace de travail, appels ; inscription, connexion, mot de passe ; présentation de HARX ; textes des écrans de l'application rep). À utiliser AVANT de conclure que tu n'as pas l'information. Écris la requête en anglais ou en français avec des noms de fonctionnalités (ex. « matching requirements languages skills », « apply to a gig », « password reset »). Renvoie des extraits ; s'ils ne répondent pas à la question, n'invente pas.",
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Requête en anglais ou en français.' } }, required: ['query'] },
  },
  {
    name: 'read_knowledge_topic',
    description: "Lit une rubrique complète de la base de connaissances (les identifiants sont listés dans l'index des rubriques de tes instructions), quand un extrait ne suffit pas.",
    input_schema: { type: 'object', properties: { topic_id: { type: 'string' } }, required: ['topic_id'] },
  },
  {
    name: 'lookup_candidate',
    description: "Cherche le candidat dans le CRM (lecture seule) d'après l'email utilisé à l'inscription. Renvoie found, et step (1 à 5 : étape documentée dans PIPELINE) ou null si l'étape n'est pas documentée. Ne renvoie jamais le nom interne de l'étape.",
    input_schema: { type: 'object', properties: { email: { type: 'string', description: "Email d'inscription du candidat" } }, required: ['email'] },
  },
  {
    name: 'send_reply',
    description: 'Envoie ta réponse au visiteur. Texte court, sans signature.',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'flag_for_team',
    description: "Enregistre la demande pour l'équipe HARX (note interne) et envoie visitor_message au visiteur. AUCUN transfert : la conversation reste avec toi.",
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Raison courte (pourquoi tu ne peux pas traiter la demande seul)' },
        urgency: { type: 'string', enum: ['normal', 'priority', 'enterprise_prospect'] },
        visitor_message: { type: 'string', description: 'Réponse honnête et courte pour le visiteur : ce que les sources permettent de dire, ce que tu ne sais pas, demande enregistrée pour l\'équipe. Sans promesse de délai ni de rappel, sans signature.' },
        internal_summary: { type: 'string', description: "Résumé pour l'équipe : demande, étape trouvée, ce qui manque" },
      },
      required: ['reason', 'urgency', 'visitor_message', 'internal_summary'],
    },
  },
];

export const TERMINAL_TOOLS = new Set(['send_reply', 'flag_for_team']);

export function createToolRunner({ zoho, kb = null, logger = console }) {
  return {
    // Sans base de connaissances (tests, configuration minimale), les outils de recherche ne sont pas proposés.
    definitions: kb ? TOOL_DEFINITIONS : TOOL_DEFINITIONS.filter((t) => !['search_knowledge', 'read_knowledge_topic'].includes(t.name)),
    /** Exécute un outil de données. Les échecs ne fuient jamais de détail à Claude. */
    async execute(name, input) {
      if (name === 'search_knowledge' && kb) {
        const results = kb.search(input?.query, { limit: 5 });
        return results.length ? { found: true, results } : { found: false, note: "Rien de pertinent dans la base : n'invente pas, appelle flag_for_team si tu ne peux pas répondre autrement." };
      }
      if (name === 'read_knowledge_topic' && kb) {
        const doc = kb.readTopic(String(input?.topic_id || ''));
        return doc ? { found: true, ...doc } : { found: false, available_topics: kb.docs.map((d) => d.id) };
      }
      if (name !== 'lookup_candidate') throw new Error(`unknown tool ${name}`);
      const email = String(input?.email || '').trim().toLowerCase();
      if (!isValidEmail(email)) return { found: false, error: 'invalid email' };
      try {
        const deals = await zoho.findDeals(email);
        if (!deals.length) return { found: false };
        return { found: true, step: stepFromStage(deals[0].stage) };
      } catch (e) {
        logger.warn('[salesiq] CRM lookup failed:', e.message);
        return { error: 'CRM unavailable: do not guess, call flag_for_team' };
      }
    },
  };
}
