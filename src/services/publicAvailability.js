import { isNomadNumberCountry } from './nomadOffers.js';
import { createRateLimiter } from '../integrations/rateLimit.js';
import { clientIp } from '../integrations/clientIp.js';
import { normalizeCountryCode } from '../middleware/companyScope.js';
import { COUNTRY_LABELS_EN } from './outboundDestinations.js';
import { countryAvailability, AVAILABILITY_UNAVAILABLE } from './numberAvailability.js';

/**
 * Disponibilité PUBLIQUE des numéros d'un pays (décision du fondateur « oui me prévenir ») : la page NOMAD, visiteur non connecté,
 * remplace « Choisir cette offre » par « Me prévenir » quand le pays n'a pas de numéro.
 *  - sans `companyId` ni en-tête Authorization seulement (sinon : route inchangée, session, et appartenance à l'entreprise avec
 *    `companyId`) ;
 *  - réponse réduite à `{ available, reason?, countryCode }` : ni numéro, ni détail d'inventaire ;
 *  - `countryCode` validé strictement (ISO alpha-2 d'un pays connu), sinon 400 ;
 *  - débit limité par IP (30 requêtes / 10 min), 429 au-delà ;
 *  - cache par pays de `countryAvailability` (10 min « disponible », 1 h « indisponible ») et, sans entrée en cache, UNE seule
 *    recherche partagée par pays à la fois (requêtes simultanées regroupées) : aucune recherche Twilio par requête anonyme.
 * La garde du paiement (409 NO_NUMBERS_IN_COUNTRY, relecture sans cache) n'est pas concernée.
 */
export const PUBLIC_AVAILABILITY_LIMIT = 30;
export const PUBLIC_AVAILABILITY_WINDOW_MS = 10 * 60 * 1000;

/** Pays connus (ISO 3166-1 alpha-2) : ceux du catalogue des indicatifs. */
export const KNOWN_COUNTRY_CODES = Object.freeze(new Set(Object.values(COUNTRY_LABELS_EN).flatMap((e) => e.iso || [])));

export function isKnownCountry(code) {
  return KNOWN_COUNTRY_CODES.has(normalizeCountryCode(code));
}

const inflight = new Map();

/** Disponibilité d'un pays, recherches simultanées regroupées (une seule par pays à la fois), cache de `countryAvailability`. */
export function sharedCountryAvailability(cc, deps = {}) {
  const pending = inflight.get(cc);
  if (pending) return pending;
  const p = countryAvailability(cc, deps).finally(() => inflight.delete(cc));
  inflight.set(cc, p);
  return p;
}

/** Requête publique : aucune `companyId` (dans les paramètres, le corps ou la requête). */
export const isPublicAvailabilityRequest = (req) => {
  const v = req.params?.companyId ?? req.body?.companyId ?? req.query?.companyId;
  return v === undefined || v === null || v === '';
};

export function createPublicAvailabilityHandler({ limiter = createRateLimiter({ limit: PUBLIC_AVAILABILITY_LIMIT, windowMs: PUBLIC_AVAILABILITY_WINDOW_MS }), deps = {} } = {}) {
  return async function publicAvailability(req, res) {
    const cc = normalizeCountryCode(req.query?.countryCode);
    if (!/^[A-Z]{2}$/.test(cc) || !KNOWN_COUNTRY_CODES.has(cc)) {
      return res.status(400).json({ error: 'A known two-letter countryCode is required', code: 'COUNTRY_CODE_REQUIRED' });
    }
    const rate = limiter.check(clientIp(req));
    if (!rate.ok) {
      res.set('Retry-After', String(rate.retryAfterSeconds));
      return res.status(429).json({ error: 'Too many requests', code: 'RATE_LIMITED' });
    }
    // Offre NOMAD : seulement US, CA, GB, FR, DE, NL, BE (décision du 26/11/2026) ; ailleurs « non proposé », sans recherche opérateur.
    if (!isNomadNumberCountry(cc)) {
      res.set('Cache-Control', 'public, max-age=300');
      return res.json({ available: false, countryCode: cc, reason: 'not_offered' });
    }
    try {
      const value = await sharedCountryAvailability(cc, deps);
      const body = { available: value.available === true, countryCode: cc };
      if (!body.available && value.reason) body.reason = value.reason;
      res.set('Cache-Control', 'public, max-age=300');
      return res.json(body);
    } catch (error) {
      console.error('[telephony] disponibilité publique illisible:', error?.message);
      return res.status(503).json({ error: 'Number availability check failed', code: AVAILABILITY_UNAVAILABLE, retryable: true });
    }
  };
}

let handler = createPublicAvailabilityHandler();
/** Tests : remplace le gestionnaire (limiteur neuf, dépendances simulées). */
export function resetPublicAvailability(options) {
  handler = createPublicAvailabilityHandler(options);
}

/**
 * Avant la garde de la route : une requête anonyme (sans `companyId` NI en-tête Authorization) est servie ici, sans session ; toute
 * autre requête suit le chemin authentifié inchangé (session + entreprise), sans le limiteur public : un utilisateur connecté n'est
 * jamais compté avec les visiteurs de sa connexion.
 */
export function publicAvailabilityIfNoCompany(req, res, next) {
  if (!isPublicAvailabilityRequest(req) || req.headers?.authorization) return next();
  return handler(req, res);
}
