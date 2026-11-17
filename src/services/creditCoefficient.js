import { classifyZone } from './callZone.js';
import { toStrictE164 } from './outboundDestinations.js';

/**
 * Un crédit minute INTERNATIONAL = N crédits minute nationale. UN SEUL solde de minutes (MinutesCompany, packs et achats existants
 * inchangés). Un appel international débite N crédits par minute (minute entamée arrondie à la minute supérieure PUIS multipliée par N) ;
 * un appel national, UE ou DOM-TOM débite 1 crédit par minute, comme aujourd'hui.
 *
 * N (« coefficient ») n'est PAS écrit en dur : métadonnée `international_minute_credits` du produit Stripe du forfait, sinon variable
 * d'environnement `INTERNATIONAL_MINUTE_CREDITS`, sinon 1 (= comportement actuel inchangé : on déploie sans rien changer, puis on passe à
 * la valeur voulue en configuration). Borne : entier entre 1 et 100 ; une valeur invalide donne 1 et un avertissement.
 *
 * Classification (callZone.js) : sortant = zone de la destination ; entrant = coefficient national (1) SAUF provenance internationale
 * lisible (numéro appelant en E.164 d'un pays hors de la zone de l'entreprise) — choix documenté : un entrant se juge sur le pays d'où il
 * vient, comme un sortant sur le pays où il va ; provenance masquée ou illisible : 1. Pays de l'entreprise inconnu : 1 (historique).
 */
export const COEFFICIENT_METADATA_KEY = 'international_minute_credits';
export const COEFFICIENT_ENV = 'INTERNATIONAL_MINUTE_CREDITS';
export const COEFFICIENT_MIN = 1;
export const COEFFICIENT_MAX = 100;

/** Entier entre 1 et 100 (nombre ou texte), sinon null. */
export function parseCoefficient(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n >= COEFFICIENT_MIN && n <= COEFFICIENT_MAX ? n : null;
}

function metadataValue(metadata) {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const entries = metadata instanceof Map ? [...metadata.entries()] : Object.entries(metadata);
  return entries.find(([k]) => String(k).trim().toLowerCase().replace(/[\s-]+/g, '_') === COEFFICIENT_METADATA_KEY)?.[1];
}

/**
 * Coefficient d'un forfait : métadonnée du produit, sinon environnement, sinon 1. Invalide : 1 + avertissement (une métadonnée invalide ne
 * bascule PAS sur l'environnement : on ne devine pas l'intention).
 * @returns {{coefficient: number, source: 'plan'|'env'|'default', invalid: boolean}}
 */
export function resolveInternationalCoefficient({ metadata, env = process.env } = {}) {
  const fromPlan = metadataValue(metadata);
  if (fromPlan !== undefined && String(fromPlan).trim() !== '') {
    const n = parseCoefficient(fromPlan);
    if (n) return { coefficient: n, source: 'plan', invalid: false };
    console.warn(`[credits] ${COEFFICIENT_METADATA_KEY} invalide (« ${String(fromPlan).slice(0, 20)} », attendu : entier ${COEFFICIENT_MIN}–${COEFFICIENT_MAX}) : coefficient 1`);
    return { coefficient: 1, source: 'plan', invalid: true };
  }
  const fromEnv = env?.[COEFFICIENT_ENV];
  if (fromEnv !== undefined && String(fromEnv).trim() !== '') {
    const n = parseCoefficient(fromEnv);
    if (n) return { coefficient: n, source: 'env', invalid: false };
    console.warn(`[credits] ${COEFFICIENT_ENV} invalide (« ${String(fromEnv).slice(0, 20)} », attendu : entier ${COEFFICIENT_MIN}–${COEFFICIENT_MAX}) : coefficient 1`);
    return { coefficient: 1, source: 'env', invalid: true };
  }
  return { coefficient: 1, source: 'default', invalid: false };
}

const isInbound = (call) => call?.direction === 'inbound';

/** Crédits débités par minute pour cet appel : 1, ou le coefficient pour un appel de zone internationale. Ne lit rien d'autre. */
export function callCreditFactor(call, { coefficient = 1, companyCountry = '' } = {}) {
  if (!(coefficient > 1)) return 1;
  const remote = isInbound(call) ? call?.from : call?.to;
  if (!toStrictE164(remote)) return 1;
  const { zone } = classifyZone({ to: remote, companyCountry });
  if (zone === 'unknown') {
    console.warn("[credits] pays de l'entreprise inconnu (aucune ligne lisible) : 1 crédit par minute (comportement historique)");
    return 1;
  }
  return zone === 'international' ? coefficient : 1;
}

/** Crédits d'un appel : minute entamée arrondie à la minute supérieure, puis multipliée. */
export const callCredits = (call, options) => Math.ceil(Number(call?.duration || 0) / 60) * callCreditFactor(call, options);

const callKey = (c) => String(c?.sid || c?._id || '');

/** Pays de l'entreprise (indicatif de sa première ligne lisible), même règle que outboundPolicy ; '' si inconnu. */
export async function companyCountryOf(companyId, options) {
  const { resolveCompanyCountry } = await import('./outboundPolicy.js');
  return resolveCompanyCountry(companyId, options);
}

async function defaultLoadLimits(companyId) {
  const { loadCompanyPlanLimits } = await import('./planLimits.js');
  return loadCompanyPlanLimits(companyId);
}

/**
 * Prépare le débit d'un lot d'appels : { factorOf(appel), deferred }.
 *  - coefficient 1 (cas par défaut) : aucune lecture du pays, facteur 1 : comportement actuel ;
 *  - coefficient > 1 : facteur par appel d'après la zone ;
 *  - forfait illisible : le coefficient est INCONNU : les appels de type international sont différés (repris à la prochaine lecture,
 *    jamais débités à tort à 1), les autres débités normalement ; si le pays est lui aussi illisible, l'erreur remonte (on interrompt :
 *    mieux vaut retarder que mal débiter).
 */
export async function planCreditCharging({ companyId, calls, loadLimits = defaultLoadLimits, country = companyCountryOf }) {
  let limits = null;
  let known = true;
  try {
    limits = await loadLimits(companyId);
  } catch (error) {
    known = false;
    console.warn('[credits] forfait illisible, appels de type international différés :', error?.message || error);
  }
  const coefficient = known ? (limits?.internationalCoefficient ?? resolveInternationalCoefficient({}).coefficient) : null;
  if (known && !(coefficient > 1)) return { factorOf: () => 1, deferred: new Set(), coefficient: 1 };
  const home = await country(companyId);
  if (!known) {
    const deferred = new Set();
    for (const c of calls || []) {
      const remote = isInbound(c) ? c.from : c.to;
      if (callKey(c) && toStrictE164(remote) && classifyZone({ to: remote, companyCountry: home }).zone === 'international') deferred.add(callKey(c));
    }
    return { factorOf: () => 1, deferred, coefficient: null };
  }
  return { factorOf: (call) => callCreditFactor(call, { coefficient, companyCountry: home }), deferred: new Set(), coefficient };
}

/** Crédits par minute d'un appel déjà enregistré (charge-call) ; null si le forfait est illisible (rien n'est débité, la lecture du solde reprend). */
export async function creditFactorForCall({ companyId, call, loadLimits = defaultLoadLimits, country = companyCountryOf }) {
  let limits;
  try {
    limits = await loadLimits(companyId);
  } catch (error) {
    console.warn('[credits] forfait illisible, appel laissé à la lecture du solde :', error?.message || error);
    return null;
  }
  const coefficient = limits?.internationalCoefficient ?? resolveInternationalCoefficient({}).coefficient;
  if (!(coefficient > 1)) return 1;
  return callCreditFactor(call, { coefficient, companyCountry: await country(companyId) });
}

/**
 * Crédits par minute d'un appel sortant à venir vers `to` (webhook, rappel, transfert, pré-contrôle). `limits` : forfait déjà chargé.
 * Ne bloque jamais sur une lecture impossible : 1 (le débit réel, lui, reclasse l'appel à la lecture du solde).
 */
export async function outboundCreditFactor({ companyId, limits, to, country = companyCountryOf }) {
  const coefficient = limits?.internationalCoefficient ?? 1;
  if (!(coefficient > 1)) return 1;
  try {
    return callCreditFactor({ direction: 'outbound', to }, { coefficient, companyCountry: await country(companyId) });
  } catch (error) {
    console.warn('[credits] pays de l\'entreprise illisible, 1 crédit par minute :', error?.message || error);
    return 1;
  }
}

/** Messages (anglais par défaut, français additif) du refus « solde insuffisant pour un appel international ». */
export function insufficientInternationalMessages(credits) {
  return {
    message: `Insufficient balance for an international call: 1 minute = ${credits} credits.`,
    messageFr: `Solde insuffisant pour un appel international : 1 minute = ${credits} crédits.`,
  };
}

/** Vue en lecture seule pour l'écran Facturation : crédits restants, coefficient appliqué, minutes internationales équivalentes. */
export function buildCreditsOverview({ minutes, planMinutesIncluded = 0, coefficient, companyCountry = '' }) {
  const credits = typeof minutes === 'number' ? minutes : 0;
  const n = coefficient?.coefficient > 0 ? coefficient.coefficient : 1;
  const zone = classifyZone({ to: '', companyCountry });
  return {
    credits,
    includedMinutes: planMinutesIncluded,
    internationalCreditsPerMinute: n,
    coefficientSource: coefficient?.source || 'default',
    internationalMinutesEquivalent: Math.max(0, Math.floor(Math.floor(credits) / n)),
    zone: { companyCountry: companyCountry || '', euZone: zone.euZone },
  };
}
