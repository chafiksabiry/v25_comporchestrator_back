/**
 * Signal « statut d'identité changé » vers les pages ouvertes de la société (portail : étape « Vérification » de la mise en route NOMAD,
 * bandeau d'identité de Mon poste), par le canal temps réel authentifié existant /escrow-updates (websocket/escrowUpdates.js).
 * Filtrage CÔTÉ SERVEUR : l'évènement ne part qu'aux connexions de CETTE société. Signal sans contenu (ni nom, ni pays, ni motif) :
 * la page relit ensuite son statut par GET /api/identity-verification/status, la seule source.
 * Jamais bloquant : une erreur d'envoi est ignorée (la page garde sa relecture de secours à la reprise de focus / toutes les 30 s).
 */
export const IDENTITY_STATUS_EVENT = 'identity_status_changed';

export function identityStatusEvent(companyId, status) {
  return { type: IDENTITY_STATUS_EVENT, companyId: String(companyId), status: String(status || '') };
}

export async function notifyIdentityChanged(companyId, status) {
  if (!companyId) return 0;
  try {
    const { broadcastUpdate } = await import('../../websocket/escrowUpdates.js');
    return broadcastUpdate(identityStatusEvent(companyId, status));
  } catch {
    return 0;
  }
}
