import { stepFromStage } from './zohoClient.js';
import { isValidEmail } from './payload.js';

/** Outils exposés à Claude. lookup_candidate est la seule lecture de données ; send_reply et flag_for_team terminent la boucle. */
export const TOOL_DEFINITIONS = [
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

export function createToolRunner({ zoho, logger = console }) {
  return {
    definitions: TOOL_DEFINITIONS,
    /** Exécute un outil de données. Les échecs ne fuient jamais de détail à Claude. */
    async execute(name, input) {
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
