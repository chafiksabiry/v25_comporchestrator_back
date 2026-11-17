import { stepFromStage } from './zohoClient.js';
import { isValidEmail } from './payload.js';

/** Outils exposés à Claude. lookup_candidate est la seule lecture de données ; send_reply et hand_off terminent la boucle. */
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
    name: 'hand_off',
    description: 'Passe la conversation à un humain de l\'équipe HARX.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Raison courte du transfert' },
        urgency: { type: 'string', enum: ['normal', 'priority', 'enterprise_prospect'] },
        visitor_message: { type: 'string', description: "Message d'attente poli pour le visiteur, sans promesse de délai, sans signature" },
        internal_summary: { type: 'string', description: "Résumé pour l'équipe : demande, étape trouvée, ce qui manque" },
      },
      required: ['reason', 'urgency', 'visitor_message', 'internal_summary'],
    },
  },
];

export const TERMINAL_TOOLS = new Set(['send_reply', 'hand_off']);

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
        return { error: 'CRM unavailable: do not guess, call hand_off' };
      }
    },
  };
}
