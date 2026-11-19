import crypto from 'node:crypto';

/**
 * Enregistre chaque échange SalesIQ (message du visiteur + réponse de l'agent) dans la base de l'Inbox support (même stockage que
 * WhatsApp et le chat du site, conversation `salesiq:<empreinte>`), pour qu'ils apparaissent dans l'Inbox du tableau de bord admin.
 *
 * - Jamais bloquant : appelé sans attente par l'agent ; toute erreur (base indisponible comprise) est avalée, le visiteur reçoit sa réponse quoi qu'il arrive.
 * - L'identifiant de conversation est une empreinte (SHA-256) de la clé visiteur SalesIQ : ni e-mail ni identifiant Zoho dans l'URL ou l'interface.
 * - Mode « shadow » : la réponse de Claude n'est pas envoyée au visiteur, elle est enregistrée comme brouillon.
 * - Une demande que Claude ne peut pas traiter seul (`flag_for_team`) marque la conversation « à traiter ».
 * - Désactivable : SALESIQ_INBOX_RECORD=0.
 */
export const SIQ_PREFIX = 'salesiq:';
export const isSalesIqConversation = (id) => String(id || '').startsWith(SIQ_PREFIX);

export const siqConversationId = (key) => SIQ_PREFIX + crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 20);

export function createInboxRecorder(store, { logger = console, enabled = true } = {}) {
  if (!enabled || !store) return null;
  return async ({ key, text, decision, sent = true, language = null }) => {
    try {
      if (!key || key === 'anonymous') return; // visiteur non identifiable : on ne mélange pas des visiteurs différents
      const id = siqConversationId(key);
      await store.getOrCreateConversation(id, {});
      await store.appendMessage(id, { role: 'user', text: String(text || '') });
      const reply = String(decision?.text || '');
      await store.appendMessage(id, { role: 'assistant', text: sent ? reply : `(Brouillon non envoyé au visiteur) ${reply}`, lang: language });
      const patch = {};
      if (language) patch.language = { language };
      if (decision?.kind === 'flag') patch.handoff = { active: true, reason: String(decision.reason || '').slice(0, 200), at: new Date() };
      if (Object.keys(patch).length) await store.updateConversation(id, patch);
    } catch (e) {
      logger.warn?.(`[salesiq] inbox recording failed (ignored): ${e.message}`);
    }
  };
}
