/**
 * ANCIENNE migration « Google sans lecture » (PR #115) : elle coupait la lecture, PURGEAIT les e-mails Google stockés et retirait gmail.readonly /
 * gmail.modify des scopes mémorisés, à chaque démarrage. La lecture Gmail est de nouveau autorisée (décision du propriétaire : lecture + envoi pour la
 * personne qui a connecté SA boîte) : relancée telle quelle, elle neutraliserait à chaque redémarrage les comptes qui viennent d'autoriser la lecture.
 *
 * DÉSORMAIS SANS EFFET : aucune requête en base, aucune suppression, aucune révocation, quelle que soit la configuration (GOOGLE_REVOKE_RESTRICTED_GRANTS
 * est ignoré). Elle n'est plus appelée au démarrage ; la fonction reste exportée (compatibilité) et journalise seulement qu'elle a été ignorée.
 */
export const RESTRICTED_GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
];

export async function neutralizeGoogleInbox({ log = console.log } = {}) {
  const result = { skipped: true, sharedReadDisabled: 0, emailsPurged: 0, connectionScopesStripped: 0, accountScopesStripped: 0, revoked: 0, revokeFailed: 0 };
  log(JSON.stringify({ event: 'google_inbox_neutralize_skipped' }));
  return result;
}
