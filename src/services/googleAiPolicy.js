import { SecretariatError } from './secretariatProviders/common.js';

/**
 * POLITIQUE « AUCUNE DONNÉE GOOGLE ENVOYÉE À UNE IA » (Gmail, scope restreint gmail.readonly) : le contenu d'un e-mail Google (corps, objet, extrait,
 * expéditeur) n'est jamais remis pour une analyse IA. Ce serveur n'envoie lui-même aucun e-mail à une IA ; ce module bloque les demandes qui le
 * feraient (corps demandé avec `purpose=ai`) et signale `aiAllowed: false` sur chaque e-mail Google pour que les clients n'en proposent pas.
 * Microsoft : inchangé.
 */
export const GOOGLE_AI_CODE = 'google_ai_disabled';
export const GOOGLE_AI_MESSAGE = 'Le contenu des e-mails Gmail ne peut pas être analysé par l’IA : aucune donnée Google n’est envoyée à une IA.';

/** Un e-mail de ce fournisseur peut-il être remis à une IA ? */
export const aiAllowedFor = (provider) => provider !== 'google';

/** Lève 409 `google_ai_disabled` pour un e-mail Google. */
export function assertAiAllowed(provider) {
  if (!aiAllowedFor(provider)) throw new SecretariatError(GOOGLE_AI_CODE, GOOGLE_AI_MESSAGE, { status: 409 });
}
