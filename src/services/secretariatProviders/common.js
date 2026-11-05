/** Briques communes aux connecteurs du secrétariat (Google, Microsoft 365, Zoom). */
export const PROVIDER_IDS = ['google', 'microsoft', 'zoom'];
export const isProviderId = (v) => typeof v === 'string' && PROVIDER_IDS.includes(v);
export const PROVIDER_LABEL = { google: 'Google', microsoft: 'Microsoft 365', zoom: 'Zoom' };

/**
 * Erreur « métier » des connecteurs. `message` est TOUJOURS un texte français sûr (jamais de jeton, d'en-tête ni de corps de réponse).
 * `code` : not_connected | needs_reauth | unavailable | provider_refused | provider_error | invalid_link | invalid_request.
 * `status` : statut HTTP du fournisseur (utile pour décider d'un rafraîchissement), jamais montré à l'utilisateur.
 */
export class SecretariatError extends Error {
  constructor(code, message, { status = null } = {}) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Retire retours à la ligne et caractères de contrôle d'une valeur destinée à un en-tête. */
export const cleanHeader = (v) => String(v ?? '').replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();

/**
 * Appel HTTP via le client injectable (`http` de integrations/http.js). Une panne réseau devient une SecretariatError
 * générique : le message d'origine pourrait contenir une URL ou un en-tête.
 */
export async function call(http, req) {
  try {
    return await http(req);
  } catch {
    throw new SecretariatError('provider_error', 'Le service du fournisseur ne répond pas. Réessayez dans un instant.');
  }
}

/** Réponse attendue : un des statuts `ok`, sinon erreur sûre (le détail du fournisseur n'est pas relayé). */
export function ensure(res, what, ok = [200, 201, 202, 204]) {
  if (ok.includes(res.status)) return res;
  if (res.status >= 500 || res.status === 429) throw new SecretariatError('provider_error', `${what} : le service du fournisseur est momentanément indisponible.`, { status: res.status });
  throw new SecretariatError('provider_refused', `${what} : le fournisseur a refusé la demande.`, { status: res.status });
}

/** Dates d'un événement (Date valides, fin après début). */
export function eventWindow(event) {
  const start = event.startsAt instanceof Date ? event.startsAt : new Date(event.startsAt);
  const end = event.endsAt instanceof Date ? event.endsAt : new Date(event.endsAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) throw new SecretariatError('invalid_request', 'Date du rendez-vous invalide.');
  return { start, end };
}

export const TIME_ZONE = 'Europe/Paris';

/**
 * Liens de visio acceptés par fournisseur (forme stricte). Un lien créé par un fournisseur n'est stocké que s'il a cette forme ;
 * le flux agenda ne diffuse un lien externe que s'il a cette forme ET que le rendez-vous a été créé par ce fournisseur (visio.js).
 * [À VÉRIFIER avec un vrai compte] : formes réelles des liens Teams et Zoom.
 */
export const VIDEO_LINK_RE = {
  google_meet: /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/,
  teams: /^https:\/\/(?:teams\.microsoft\.com\/l\/meetup-join\/|teams\.live\.com\/meet\/)[A-Za-z0-9%._~!$&()*+,;=:@/?-]{6,560}$/,
  zoom: /^https:\/\/(?:[a-z0-9-]+\.)?zoom\.us\/j\/\d{8,13}(?:\?pwd=[A-Za-z0-9._-]{1,200})?$/,
};
export const EXTERNAL_VIDEO_PROVIDERS = Object.keys(VIDEO_LINK_RE);
