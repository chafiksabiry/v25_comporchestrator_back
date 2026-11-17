import { classifyZone } from './callZone.js';
import { countryPrefixOf, toStrictE164 } from './outboundDestinations.js';
import { internationalInsufficientText } from './browserOutbound.js';

/**
 * Un crédit minute INTERNATIONAL = N crédits minute nationale. UN SEUL solde de minutes (MinutesCompany, packs et achats existants
 * inchangés). Un appel international débite N crédits par minute (minute entamée arrondie à la minute supérieure PUIS multipliée par N) ;
 * un appel national, UE ou DOM-TOM débite 1 crédit par minute, comme aujourd'hui.
 *
 * N (« coefficient ») n'est PAS écrit en dur : métadonnée `international_minute_credits` du produit Stripe du forfait, sinon variable
 * d'environnement `INTERNATIONAL_MINUTE_CREDITS`, sinon 1 (= comportement actuel inchangé : on déploie sans rien changer, puis on passe à
 * la valeur voulue en configuration). Borne : entier entre 1 et 100 ; une valeur invalide donne 1 et un avertissement.
 *
 * Classification (callZone.js) : sortant = zone de la destination, jugée depuis la ligne RÉELLEMENT utilisée (champ `from` de l'appel
 * stocké ; repli documenté sur la première ligne de l'entreprise si `from` n'est pas un numéro lisible, par exemple « client:… ») : le
 * résultat ne dépend donc pas de l'instant de la synchro. ENTRANTS : toujours 1 (décision du propriétaire : le périmètre ne porte que sur
 * les appels sortants vers l'international ; un débit après coup, sans pré-contrôle, pourrait rendre le solde négatif sans décision).
 * Pays de l'entreprise inconnu : 1 (historique). Toute lecture impossible (forfait, lignes) : 1, comme avant (jamais de report ni de blocage).
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

/**
 * Un SEUL point de résolution du coefficient (débit, webhook, pré-contrôle, rappel, transfert, lecture Facturation) : celui du forfait
 * (`limits.internationalCoefficient`, déjà résolu métadonnée → environnement → 1) ; sans forfait lisible (`limits` null) : environnement,
 * sinon 1.
 * @returns {{coefficient: number, source: string}}
 */
export function coefficientOf(limits) {
  if (typeof limits?.internationalCoefficient === 'number') return { coefficient: limits.internationalCoefficient, source: limits.internationalCoefficientSource || 'plan' };
  const { coefficient, source } = resolveInternationalCoefficient({});
  return { coefficient, source };
}

/**
 * Crédits débités par minute pour cet appel : 1, ou le coefficient pour un appel SORTANT de zone internationale. Entrant : 1.
 * Zone : depuis la ligne réellement utilisée (`call.from`) si c'est un numéro lisible, sinon depuis `companyCountry` (première ligne de
 * l'entreprise). Ne lit rien d'autre.
 */
export function callCreditFactor(call, { coefficient = 1, companyCountry = '' } = {}) {
  if (!(coefficient > 1) || isInbound(call)) return 1;
  if (!toStrictE164(call?.to)) return 1;
  const line = toStrictE164(call?.from);
  const home = line || companyCountry;
  const { zone } = classifyZone({ to: call.to, companyCountry: home });
  if (zone === 'unknown') {
    console.warn("[credits] pays de l'entreprise inconnu (aucune ligne lisible) : 1 crédit par minute (comportement historique)");
    return 1;
  }
  return zone === 'international' ? coefficient : 1;
}

/** Crédits d'un appel : minute entamée arrondie à la minute supérieure, puis multipliée. */
export const callCredits = (call, options) => Math.ceil(Number(call?.duration || 0) / 60) * callCreditFactor(call, options);

/** Numéro de la première ligne lisible de l'entreprise (permet de distinguer les territoires d'un même indicatif) ; '' si inconnu. */
export async function companyHomeOf(companyId, options) {
  const { resolveCompanyHome } = await import('./outboundPolicy.js');
  return resolveCompanyHome(companyId, options);
}

/** Durée pendant laquelle le forfait lu d'une société est réutilisé (une lecture au plus par société) : limite l'accès supplémentaire. */
export const COEFFICIENT_CACHE_MS = 30 * 1000;
const limitsCache = new Map();
export const clearCoefficientCache = () => limitsCache.clear();

/** Forfait de la société (loadCompanyPlanLimits), réutilisé brièvement. Une erreur n'est jamais mise en cache. */
export async function cachedPlanLimits(companyId, { load, now = () => Date.now() } = {}) {
  const key = String(companyId);
  const hit = limitsCache.get(key);
  if (hit && now() - hit.at < COEFFICIENT_CACHE_MS && now() >= hit.at) return hit.limits;
  const loader = load || (async (id) => (await import('./planLimits.js')).loadCompanyPlanLimits(id));
  const limits = await loader(companyId);
  limitsCache.set(key, { at: now(), limits });
  return limits;
}

const defaultLoadLimits = (companyId) => cachedPlanLimits(companyId);

/**
 * Prépare le débit d'un lot d'appels : { factorOf(appel) }. Coefficient 1 (cas par défaut) : aucune lecture du pays, facteur 1 :
 * comportement actuel. Coefficient > 1 : facteur par appel d'après la zone. Forfait ou lignes illisibles : facteur 1, comme avant
 * (jamais de report ni d'interruption : le débit normal n'est jamais sauté).
 */
export async function planCreditCharging({ companyId, calls, loadLimits = defaultLoadLimits, country = companyHomeOf }) {
  void calls;
  let limits = null;
  try {
    limits = await loadLimits(companyId);
  } catch (error) {
    console.warn('[credits] forfait illisible, 1 crédit par minute (comportement d\'avant) :', error?.message || error);
    return { factorOf: () => 1, deferred: new Set(), coefficient: 1 };
  }
  const { coefficient } = coefficientOf(limits);
  if (!(coefficient > 1)) return { factorOf: () => 1, deferred: new Set(), coefficient: 1 };
  let home = '';
  try {
    home = await country(companyId);
  } catch (error) {
    console.warn('[credits] lignes illisibles, 1 crédit par minute (comportement d\'avant) :', error?.message || error);
    return { factorOf: () => 1, deferred: new Set(), coefficient };
  }
  return { factorOf: (call) => callCreditFactor(call, { coefficient, companyCountry: home }), deferred: new Set(), coefficient };
}

/** Crédits par minute d'un appel déjà enregistré (charge-call) : 1 si le forfait ou les lignes sont illisibles (comme avant). */
export async function creditFactorForCall({ companyId, call, loadLimits = defaultLoadLimits, country = companyHomeOf }) {
  const plan = await planCreditCharging({ companyId, calls: [call], loadLimits, country });
  return plan.factorOf(call);
}

/**
 * Crédits par minute d'un appel sortant à venir vers `to` (webhook, rappel, transfert, pré-contrôle). `limits` : forfait déjà chargé
 * (peut être null). `lineNumber` : ligne qui passera l'appel (sinon première ligne de l'entreprise). Ne bloque jamais sur une lecture
 * impossible : 1 (le débit réel reclasse l'appel à la lecture du solde).
 */
export async function outboundCreditFactor({ companyId, limits, to, lineNumber = '', country = companyHomeOf }) {
  const { coefficient } = coefficientOf(limits);
  if (!(coefficient > 1)) return 1;
  try {
    const line = toStrictE164(lineNumber);
    return callCreditFactor({ direction: 'outbound', to, from: line || undefined }, { coefficient, companyCountry: line ? '' : await country(companyId) });
  } catch (error) {
    console.warn("[credits] lignes illisibles, 1 crédit par minute :", error?.message || error);
    return 1;
  }
}

/** Messages du refus « solde insuffisant pour un appel international : 1 minute = N crédits » : un seul texte par langue, tous canaux. */
export function insufficientInternationalMessages(credits) {
  return {
    message: internationalInsufficientText('en', credits),
    messageFr: internationalInsufficientText('fr', credits),
    messageEs: internationalInsufficientText('es', credits),
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
    zone: { companyCountry: countryPrefixOf(companyCountry) || '', euZone: zone.euZone },
  };
}
