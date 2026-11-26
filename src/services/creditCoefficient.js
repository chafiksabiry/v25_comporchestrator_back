import { classifyZone } from './callZone.js';
import { countryPrefixOf, toStrictE164 } from './outboundDestinations.js';
import { internationalInsufficientText } from './browserOutbound.js';
import { affordableMinutes, creditsForSeconds, normalizeFactor, roundCredits } from './creditMath.js';

/**
 * Un crédit minute INTERNATIONAL = N crédits minute nationale. UN SEUL solde de minutes (MinutesCompany, packs et achats existants
 * inchangés). Un appel international débite N crédits par minute (minute entamée arrondie à la minute supérieure PUIS multipliée par N) ;
 * un appel national, UE ou DOM-TOM débite 1 crédit par minute, comme aujourd'hui.
 *
 * N (« coefficient ») n'est PAS écrit en dur : métadonnée `international_minute_credits` du produit Stripe du forfait, sinon variable
 * d'environnement `INTERNATIONAL_MINUTE_CREDITS`, sinon 1 (= comportement actuel inchangé : on déploie sans rien changer, puis on passe à
 * la valeur voulue en configuration). Borne : nombre entre 1 et 100, DÉCIMAL au centième accepté (« 4 », « 4.2 », « 4,25 ») ; une valeur
 * invalide (hors bornes, plus de deux décimales, texte) donne 1 et un avertissement.
 *
 * COEFFICIENT DÉCIMAL (décision du 26/11/2026 : minute internationale = multiple réglable de la minute locale, ex. 0,60 € = 4 × 0,15 €,
 * ou 0,63 € = 4,2 × 0,15 €) : la minute entamée est toujours arrondie à la minute supérieure PUIS multipliée par le coefficient ; le
 * débit est calculé et écrit AU CENTIÈME DE MINUTE sans perte (creditMath.js : entiers de centièmes, nouveau solde écrit sous garde du
 * solde lu, jamais de `$inc` flottant). Exemple : 1 min 05 s internationale à 4,2 = 2 min × 4,2 = 8,40 minutes locales débitées.
 *
 * Classification (callZone.js) : sortant = zone de la destination, jugée depuis la ligne RÉELLEMENT utilisée (champ `from` de l'appel
 * stocké ; repli documenté sur la première ligne de l'entreprise si `from` n'est pas un numéro lisible, par exemple « client:… ») : le
 * résultat ne dépend donc pas de l'instant de la synchro. ENTRANTS : toujours 1 (décision du propriétaire : le périmètre ne porte que sur
 * les appels sortants vers l'international ; un débit après coup, sans pré-contrôle, pourrait rendre le solde négatif sans décision).
 * Pays de l'entreprise inconnu : 1 (historique). Toute lecture impossible (forfait, lignes) : 1, comme avant (jamais de report ni de blocage).
 *
 * SOUS-FACTURATION ASSUMÉE : si le forfait ou les lignes sont illisibles pendant un appel international, cet appel est débité à 1 crédit la
 * minute (jamais bloqué ni reporté) : à N > 1 cela facture moins que prévu, jamais plus.
 * PÉRIMÈTRE de « aucun accès supplémentaire à N = 1 » : il vaut pour les LIGNES (aucune lecture du pays à N = 1) ; le FORFAIT est lu (cache 30 s)
 * par les chemins du webhook, du rappel, du transfert et du débit, comme avant l'arrivée du coefficient pour le plafond de durée.
 *
 * ENTRANT / SORTANT : un appel n'est facturé au coefficient que s'il est EXPLICITEMENT sortant (`direction` commence par « outbound » :
 * outbound, outbound-api, outbound-dial). Direction absente, « incoming », « inbound », jambe de transfert : 1. Un appel dont la destination
 * est une ligne de l'entreprise : 1 (appel interne).
 * TRACE DU WEBHOOK : l'appel sortant du navigateur enregistre sa décision (ligne retenue, zone, facteur) sous son sid ; le débit la réutilise
 * (`CallCreditDecision`) au lieu de reclasser, et ne reclasse que les appels sans trace (autres canaux).
 */
export const COEFFICIENT_METADATA_KEY = 'international_minute_credits';
export const COEFFICIENT_ENV = 'INTERNATIONAL_MINUTE_CREDITS';
export const COEFFICIENT_MIN = 1;
export const COEFFICIENT_MAX = 100;

/** Nombre entre 1 et 100, au centième au plus (nombre ou texte, virgule ou point décimal), sinon null. */
export function parseCoefficient(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  const text = String(value).trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const n = roundCredits(Number(text));
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
    console.warn(`[credits] ${COEFFICIENT_METADATA_KEY} invalide (« ${String(fromPlan).slice(0, 20)} », attendu : nombre ${COEFFICIENT_MIN}–${COEFFICIENT_MAX}, au centième) : coefficient 1`);
    return { coefficient: 1, source: 'plan', invalid: true };
  }
  const fromEnv = env?.[COEFFICIENT_ENV];
  if (fromEnv !== undefined && String(fromEnv).trim() !== '') {
    const n = parseCoefficient(fromEnv);
    if (n) return { coefficient: n, source: 'env', invalid: false };
    console.warn(`[credits] ${COEFFICIENT_ENV} invalide (« ${String(fromEnv).slice(0, 20)} », attendu : nombre ${COEFFICIENT_MIN}–${COEFFICIENT_MAX}, au centième) : coefficient 1`);
    return { coefficient: 1, source: 'env', invalid: true };
  }
  return { coefficient: 1, source: 'default', invalid: false };
}

/** Sortant EXPLICITE seulement (outbound, outbound-api, outbound-dial…). Tout le reste (absent, incoming, inbound, transfert) : entrant. */
export const isExplicitOutbound = (call) => /^outbound/i.test(String(call?.direction || '').trim());

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
export function callCreditDetail(call, { coefficient = 1, companyCountry = '', companyLines = null } = {}) {
  if (!(coefficient > 1)) return { factor: 1, zone: null };
  if (!isExplicitOutbound(call)) return { factor: 1, zone: 'domestic' };
  const dest = toStrictE164(call?.to);
  if (!dest) return { factor: 1, zone: null };
  // Destination = une ligne de l'entreprise : appel interne, 1.
  if (companyLines && companyLines.has(dest)) return { factor: 1, zone: 'domestic' };
  const line = toStrictE164(call?.from);
  const home = line || companyCountry;
  const { zone } = classifyZone({ to: call.to, companyCountry: home });
  if (zone === 'unknown') return { factor: 1, zone: null, unknownHome: true };
  return { factor: zone === 'international' ? coefficient : 1, zone };
}

export function callCreditFactor(call, options = {}) {
  const d = callCreditDetail(call, options);
  if (d.unknownHome) console.warn("[credits] pays de l'entreprise inconnu (aucune ligne lisible) : 1 crédit par minute (comportement historique)");
  return d.factor;
}

/** Crédits d'un appel : minute entamée arrondie à la minute supérieure, puis multipliée (au centième, sans perte). */
export const callCredits = (call, options) => creditsForSeconds(call?.duration, callCreditFactor(call, options));

/** Numéro de la première ligne lisible de l'entreprise (permet de distinguer les territoires d'un même indicatif) ; '' si inconnu. */
export async function companyHomeOf(companyId, options) {
  const { resolveCompanyHome } = await import('./outboundPolicy.js');
  return resolveCompanyHome(companyId, options);
}

/** Numéros E.164 des lignes de l'entreprise (pour reconnaître un appel interne). Illisible : ensemble vide (comportement d'avant). */
export async function companyLinesOf(companyId) {
  try {
    const { PhoneNumber } = await import('../models/PhoneNumber.js');
    const rows = await PhoneNumber.find({ companyId }).select('phoneNumber').lean();
    return new Set((rows || []).map((r) => toStrictE164(r.phoneNumber)).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** Durée pendant laquelle le forfait lu d'une société est réutilisé (une lecture au plus par société) : limite l'accès supplémentaire. */
export const COEFFICIENT_CACHE_MS = 30 * 1000;
/** Nombre maximal de sociétés gardées en mémoire (la plus ancienne est évincée). */
export const COEFFICIENT_CACHE_MAX = 500;
const limitsCache = new Map();
const inflight = new Map();
export const clearCoefficientCache = () => { limitsCache.clear(); inflight.clear(); };

/**
 * Forfait de la société (loadCompanyPlanLimits), réutilisé brièvement. Jamais mis en cache : une erreur ni une absence de forfait (null) :
 * la lecture suivante réessaie. Lectures simultanées d'une même société : une seule requête partagée. Mémoire bornée.
 */
export async function cachedPlanLimits(companyId, { load, now = () => Date.now() } = {}) {
  const key = String(companyId);
  const hit = limitsCache.get(key);
  if (hit && now() - hit.at < COEFFICIENT_CACHE_MS && now() >= hit.at) return hit.limits;
  if (inflight.has(key)) return inflight.get(key);
  const loader = load || (async (id) => (await import('./planLimits.js')).loadCompanyPlanLimits(id));
  const pending = (async () => {
    try {
      const limits = await loader(companyId);
      if (limits !== null && limits !== undefined) {
        limitsCache.delete(key);
        limitsCache.set(key, { at: now(), limits });
        while (limitsCache.size > COEFFICIENT_CACHE_MAX) limitsCache.delete(limitsCache.keys().next().value);
      }
      return limits;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, pending);
  return pending;
}

const defaultLoadLimits = (companyId) => cachedPlanLimits(companyId);

/** Décisions du webhook pour ces sids : Map sid -> { factor, zone }. Illisible : Map vide (reclassement, comme avant). */
export async function loadCallDecisions(sids) {
  const list = [...new Set((sids || []).map(String).filter(Boolean))];
  if (!list.length) return new Map();
  try {
    const { default: CallCreditDecision } = await import('../models/CallCreditDecision.js');
    const rows = await CallCreditDecision.find({ sid: { $in: list } }).select('sid factor zone').lean();
    return new Map((rows || []).map((r) => [String(r.sid), { factor: normalizeFactor(r.factor), zone: r.zone === 'international' || r.zone === 'domestic' ? r.zone : null }]));
  } catch (error) {
    console.warn('[credits] traces de décision illisibles, reclassement des appels :', error?.message || error);
    return new Map();
  }
}

/** Enregistre la décision du webhook (le premier enregistrement fait foi). Ne bloque ni ne fait échouer jamais l'appel. */
export async function recordCallDecision({ sid, companyId, factor, zone = '', line = '' }) {
  const key = String(sid || '').trim();
  if (!key || !companyId || !(factor >= 1)) return false;
  try {
    const { default: CallCreditDecision } = await import('../models/CallCreditDecision.js');
    await CallCreditDecision.updateOne({ sid: key }, { $setOnInsert: { sid: key, companyId: String(companyId), factor, zone, line } }, { upsert: true });
    return true;
  } catch (error) {
    console.warn("[credits] décision non enregistrée (le débit reclassera l'appel) :", error?.message || error);
    return false;
  }
}

/**
 * Prépare le débit d'un lot d'appels : { factorOf(appel) }. Trace du webhook d'abord (même zone et même facteur que le plafond), sinon
 * reclassement. Coefficient 1 (cas par défaut) : facteur 1 sans lire ni lignes ni traces. Forfait ou lignes illisibles : facteur 1, comme
 * avant (jamais de report ni d'interruption : le débit normal n'est jamais sauté).
 */
export async function planCreditCharging({ companyId, calls = [], loadLimits = defaultLoadLimits, country = companyHomeOf, lines = companyLinesOf, decisions = loadCallDecisions }) {
  let limits = null;
  try {
    limits = await loadLimits(companyId);
  } catch (error) {
    console.warn('[credits] forfait illisible, 1 crédit par minute (comportement d\'avant) :', error?.message || error);
    return { factorOf: () => 1, coefficient: 1 };
  }
  const { coefficient } = coefficientOf(limits);
  if (!(coefficient > 1)) return { factorOf: () => 1, coefficient: 1 };
  let home = '';
  let companyLines = new Set();
  try {
    home = await country(companyId);
    companyLines = await lines(companyId);
  } catch (error) {
    console.warn('[credits] lignes illisibles, 1 crédit par minute (comportement d\'avant) :', error?.message || error);
    return { factorOf: () => 1, coefficient };
  }
  const recorded = await decisions(calls.map((c) => c?.sid || c?._id));
  return {
    factorOf: (call) => {
      const traced = recorded.get(String(call?.sid || call?._id || ''));
      return traced !== undefined ? traced.factor : callCreditFactor(call, { coefficient, companyCountry: home, companyLines });
    },
    coefficient,
  };
}

/** Crédits par minute d'un appel déjà enregistré (charge-call) : 1 si le forfait ou les lignes sont illisibles (comme avant). */
export async function creditFactorForCall({ companyId, call, loadLimits = defaultLoadLimits, country = companyHomeOf }) {
  const plan = await planCreditCharging({ companyId, calls: [call], loadLimits, country });
  return plan.factorOf(call);
}

/**
 * Décision pour un appel sortant à venir vers `to` (webhook, rappel, transfert, pré-contrôle) : { factor, zone, line }. `limits` : forfait
 * déjà chargé (peut être null). `lineNumber` : ligne RÉELLEMENT utilisée (sinon première ligne de l'entreprise). Ne bloque jamais sur une
 * lecture impossible : facteur 1 (le débit relira la trace ou reclassera).
 */
export async function outboundCreditDecision({ companyId, limits, to, lineNumber = '', country = companyHomeOf, lines = companyLinesOf }) {
  const { coefficient } = coefficientOf(limits);
  if (!(coefficient > 1)) return { factor: 1, zone: '', line: toStrictE164(lineNumber) || '', coefficient };
  try {
    const line = toStrictE164(lineNumber);
    const home = line || (await country(companyId));
    const companyLines = await lines(companyId);
    const call = { direction: 'outbound', to };
    const factor = callCreditFactor(call, { coefficient, companyCountry: home, companyLines });
    const zone = classifyZone({ to, companyCountry: home }).zone;
    return { factor, zone, line: line || '', coefficient };
  } catch (error) {
    console.warn('[credits] lignes illisibles, 1 crédit par minute :', error?.message || error);
    return { factor: 1, zone: '', line: '', coefficient };
  }
}

/** Crédits par minute d'un appel sortant à venir (nombre seul) : voir outboundCreditDecision. */
export async function outboundCreditFactor(options) {
  return (await outboundCreditDecision(options)).factor;
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
  const n = normalizeFactor(coefficient?.coefficient);
  const zone = classifyZone({ to: '', companyCountry });
  return {
    credits: roundCredits(credits),
    includedMinutes: planMinutesIncluded,
    internationalCreditsPerMinute: n,
    coefficientSource: coefficient?.source || 'default',
    internationalMinutesEquivalent: affordableMinutes(credits, n),
    zone: { companyCountry: countryPrefixOf(companyCountry) || '', euZone: zone.euZone },
  };
}

/**
 * Débits RÉELS appliqués aux appels d'une société, pour le journal de consommation : { [sid]: { coefficient, zone } }, avec la MÊME règle que le débit
 * (trace du webhook d'abord, sinon reclassement). Coefficient 1 (cas par défaut) : objet vide (quantité historique, aucune lecture en plus). Forfait ou
 * lignes illisibles : objet vide (le journal montre la quantité historique, comme le débit l'a appliquée à défaut de mieux).
 */
export async function debitsForCalls({ companyId, calls = [], loadLimits = defaultLoadLimits, country = companyHomeOf, lines = companyLinesOf, decisions = loadCallDecisions }) {
  const out = {};
  try {
    const { coefficient } = coefficientOf(await loadLimits(companyId));
    if (!(coefficient > 1)) return out;
    const [home, companyLines, recorded] = await Promise.all([country(companyId), lines(companyId), decisions(calls.map((c) => c?.sid || c?._id))]);
    for (const call of calls) {
      const key = String(call?.sid || call?._id || '');
      if (!key) continue;
      const traced = recorded.get(key);
      const d = traced !== undefined ? { factor: traced.factor, zone: traced.zone } : callCreditDetail(call, { coefficient, companyCountry: home, companyLines });
      if (d.zone === 'domestic' || d.zone === 'international') out[key] = { coefficient: d.factor, zone: d.zone };
    }
  } catch (error) {
    console.warn('[credits] débits du journal illisibles, quantité historique :', error?.message || error);
    return {};
  }
  return out;
}
