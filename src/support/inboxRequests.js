import { sharedSupportNotifier } from './notify.js';

/**
 * Demandes de l'Inbox admin créées par le serveur lui-même (pas par l'assistant IA) : un dossier de vérification d'identité passé en
 * revue humaine devient une demande « à traiter » dans l'Inbox support, et l'équipe est prévenue comme pour une escalade.
 *
 * - Conversation `identity:<id du dossier>` dans le même stockage que WhatsApp / chat du site / SalesIQ (Inbox existante), avec un
 *   ticket ouvert et `handoff.active` (filtre « À traiter »).
 * - Aucune donnée de pièce d'identité : ni nom extrait, ni numéro, ni image ; seulement la société, le dossier, le motif et les liens.
 * - La demande se ferme d'elle-même quand l'équipe décide (page Admin › Identité).
 * - Jamais bloquant : toute erreur est journalisée puis avalée ; le parcours du client ne change pas.
 */
export const IDENTITY_PREFIX = 'identity:';
export const isIdentityConversation = (id) => String(id || '').startsWith(IDENTITY_PREFIX);
export const identityConversationId = (verificationId) => IDENTITY_PREFIX + String(verificationId);

/** Stockage de l'Inbox (enveloppé pour le temps réel), enregistré au démarrage par index.js. */
let desk = null;
export function registerSupportDesk(d) { desk = d && d.store ? d : null; }
export const getSupportDesk = () => desk;

/** Motifs de passage en revue, en clair pour l'équipe. */
const TRIGGER_LABEL = {
  HUMAN_REVIEW_REQUESTED: 'le client conteste le refus et demande une vérification par l’équipe',
  ATTEMPT_LIMIT: 'limite d’analyses automatiques atteinte',
  PROCESSING_ERROR: 'erreur interne pendant l’analyse',
  PROCESSING_INTERRUPTED: 'analyse interrompue (redémarrage du serveur)',
  AI_REVIEW: 'l’analyse automatique demande une revue humaine',
  PENDING_COUNTRY: 'dossier validé pour un pays ; l’autre pays attend la décision de l’équipe (le client n’est pas bloqué)',
};

export function identityReviewRequest(v, { trigger, reasonCodes = [], pendingCountries = [], adminUrl = '' }) {
  const id = String(v._id);
  const details = [`Société : ${v.companyId}`, `Dossier : ${id}`];
  if (reasonCodes.length) details.push(`Codes : ${reasonCodes.join(', ')}`);
  if (pendingCountries.length) details.push(`Pays en attente : ${pendingCountries.join(', ')}`);
  return {
    kind: 'identity_review',
    channel: 'identity',
    conversationId: identityConversationId(id),
    urgency: trigger === 'PENDING_COUNTRY' ? 'low' : 'normal',
    reason: TRIGGER_LABEL[trigger] || trigger,
    summary: 'Décision à prendre dans la page d’administration des vérifications d’identité. Engagement affiché au client : vérification sous 24 h ouvrées.',
    details,
    links: adminUrl ? [{ label: 'Décider (Admin › Identité)', url: adminUrl }] : [],
  };
}

const adminIdentityUrl = (env) => {
  const base = String(env.PUBLIC_API_BASE_URL || '').trim().replace(/\/+$/, '');
  return base ? `${base}/admin/identity` : '';
};

/**
 * @returns {{ opened: (v, info) => Promise<{created: boolean, ticketId?: string, notified?: object}>, decided: (v, outcome) => Promise<boolean> }}
 */
export function createIdentityInboxReporter({ getDesk = getSupportDesk, notify = null, env = process.env, logger = console, now = () => new Date() } = {}) {
  const send = (req) => (notify || sharedSupportNotifier())(req);

  async function opened(v, info = {}) {
    if (!v?._id) return { created: false };
    const req = identityReviewRequest(v, { ...info, adminUrl: adminIdentityUrl(env) });
    const d = getDesk();
    let ticketId = '';
    try {
      if (d?.store) {
        const store = d.store;
        const convId = req.conversationId;
        const existing = await store.getConversation(convId);
        // Une seule demande ouverte par dossier : pas de doublon ni de seconde notification.
        if (existing?.handoff?.active) return { created: false, ticketId: existing.handoff.ticketId || '' };
        await store.getOrCreateConversation(convId, { profileName: 'Vérification d’identité' });
        await store.appendMessage(convId, { role: 'system', text: `Dossier en revue humaine : ${req.reason}.\n${req.details.join('\n')}\n${req.summary}` });
        const ticket = await store.createTicket({ waId: convId, linkedUserId: v.userId ? String(v.userId) : null, reason: 'identity_review', summary: req.reason, urgency: req.urgency, language: '', transcript: [] });
        ticketId = ticket?.id ? String(ticket.id) : '';
        await store.updateConversation(convId, { handoff: { active: true, ticketId, at: now(), reason: 'identity_review' } });
      } else {
        logger.warn?.('[support-inbox] Inbox indisponible : demande d’identité non enregistrée (notification envoyée quand même)');
      }
    } catch (e) {
      logger.warn?.(`[support-inbox] demande d’identité non enregistrée : ${e?.message || e}`);
    }
    let notified = null;
    try { notified = await send({ ...req, ticketId }); } catch (e) { logger.warn?.(`[support-notify] ${e?.message || e}`); }
    return { created: Boolean(ticketId), ticketId, notified };
  }

  /** Décision de l'équipe : la demande correspondante est close. @returns {Promise<boolean>} true si une demande ouverte a été close. */
  async function decided(v, outcome) {
    try {
      const store = getDesk()?.store;
      if (!store || !v?._id) return false;
      const convId = identityConversationId(v._id);
      const conv = await store.getConversation(convId);
      if (!conv?.handoff?.active) return false;
      await store.appendMessage(convId, { role: 'system', text: `Décision de l’équipe : ${outcome}. Demande close.` });
      if (conv.handoff.ticketId) await store.updateTicket(conv.handoff.ticketId, { status: 'resolved', resolvedAt: now() });
      await store.updateConversation(convId, { handoff: { active: false } });
      return true;
    } catch (e) {
      logger.warn?.(`[support-inbox] clôture de la demande d’identité impossible : ${e?.message || e}`);
      return false;
    }
  }

  return { opened, decided };
}

let shared = null;
export function sharedIdentityInboxReporter() {
  if (!shared) shared = createIdentityInboxReporter();
  return shared;
}
