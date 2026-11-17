import InternationalMinutesCompany from '../models/InternationalMinutesCompany.js';
import { classifyZone } from './callZone.js';
import { toStrictE164 } from './outboundDestinations.js';

/**
 * Second solde de minutes INTERNATIONALES, séparé du solde normal.
 *
 * Une offre est concernée quand le PRODUIT Stripe de l'offre porte la métadonnée `international_pack` (true / 1 / yes / required) :
 * lue dans loadCompanyPlanLimits (`limits.internationalPack`). Aucune offre n'est écrite dans le code ; absente, TOUT reste comme
 * avant (un seul solde, appels internationaux débités du solde normal, aucun accès au second solde).
 * Pour une offre concernée :
 *   - un appel sortant INTERNATIONAL (voir callZone.js) est plafonné au solde international et débité de lui seul ;
 *   - solde nul : refus « pack de minutes internationales requis », jamais de débit du solde normal ;
 *   - appels sortants domestiques et entrants : solde normal, inchangé.
 */
export const INTERNATIONAL_PACK_CODE = 'INTERNATIONAL_PACK_REQUIRED';

export const internationalPackApplies = (limits) => limits?.internationalPack === true;

/** Valeur de la métadonnée `international_pack` d'un produit d'offre. */
export function internationalPackFromMetadata(metadata) {
  const entries = !metadata ? [] : metadata instanceof Map ? [...metadata.entries()] : typeof metadata === 'object' ? Object.entries(metadata) : [];
  const entry = entries.find(([k]) => String(k).trim().toLowerCase().replace(/[\s-]+/g, '_') === 'international_pack');
  return ['true', '1', 'yes', 'oui', 'required'].includes(String(entry?.[1] ?? '').trim().toLowerCase());
}

/** Messages du refus (anglais par défaut, français additif). Entreprise de l'UE : rappelle que l'UE est incluse dans le solde normal. */
export function internationalPackRefusal({ euZone = false } = {}) {
  return {
    message: `An international minutes pack is required to call this destination.${euZone ? ' Calls to your country and to EU countries use your regular minutes.' : ' Calls to your own country use your regular minutes.'}`,
    messageFr: `Un pack de minutes internationales est requis pour appeler cette destination.${euZone ? ' Les appels vers votre pays et vers les pays de l’UE utilisent vos minutes habituelles.' : ' Les appels vers votre pays utilisent vos minutes habituelles.'}`,
  };
}

/** Magasin MongoDB du second solde : écritures conditionnelles atomiques (idempotence par clé). */
export const mongoStore = {
  async read(companyId) { return InternationalMinutesCompany.findOne({ companyId }).lean(); },
  async ensure(companyId) {
    try { await InternationalMinutesCompany.updateOne({ companyId }, { $setOnInsert: { companyId, minutes: 0 } }, { upsert: true }); } catch (e) { if (e?.code !== 11000) throw e; }
  },
  async debit(companyId, key, { minutes, seconds }) {
    const done = await InternationalMinutesCompany.findOneAndUpdate(
      { companyId, chargedCallSids: { $ne: key } },
      { $inc: { minutes: -minutes, consumedSeconds: seconds }, $addToSet: { chargedCallSids: key } },
      { new: true }
    );
    return Boolean(done);
  },
  async credit(companyId, { minutes, grantKey, at }) {
    const done = await InternationalMinutesCompany.findOneAndUpdate(
      { companyId, 'credits.grantKey': { $ne: grantKey } },
      { $inc: { minutes, purchasedMinutes: minutes }, $push: { credits: { at, minutes, kind: 'pack', grantKey } } },
      { new: true }
    );
    return Boolean(done);
  },
};

/** Crédite un pack payé sur le second solde, une seule fois par paiement. @returns {Promise<boolean>} true si crédité maintenant. */
export async function creditInternationalPack({ companyId, minutes, paymentId, store = mongoStore, at = new Date() }) {
  const qty = Number(minutes);
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('Invalid international minutes quantity');
  if (!paymentId) throw new Error('paymentId is required');
  await store.ensure(companyId);
  return store.credit(companyId, { minutes: qty, grantKey: `pack:${paymentId}`, at });
}

/** Pays de l'entreprise (indicatif de sa première ligne), comme outboundPolicy. */
export async function companyCountryOf(companyId, options) {
  const { resolveOutboundPolicy } = await import('./outboundPolicy.js');
  return (await resolveOutboundPolicy(companyId, options)).companyCountry || '';
}

const callKey = (c) => String(c?.sid || c?._id || '');
const isOutbound = (c) => c?.direction !== 'inbound';

/**
 * Prend en charge les appels sortants INTERNATIONAUX d'une entreprise concernée : chacun est débité du solde international (minute
 * entamée = minute entière, idempotent par appel). Renvoie les clés des appels écartés du solde normal (débités ici maintenant ou
 * déjà débités). Offre non concernée ou erreur : ensemble vide (tout reste au solde normal, comme avant).
 */
export async function settleInternationalCalls({ companyId, calls, limits, store = mongoStore, country = companyCountryOf }) {
  const handled = new Set();
  if (!internationalPackApplies(limits)) return handled;
  const home = await country(companyId);
  let ensured = false;
  for (const c of calls || []) {
    const key = callKey(c);
    const seconds = Number(c?.duration || 0);
    if (!key || !(seconds > 0) || !isOutbound(c) || !toStrictE164(c.to)) continue;
    if (classifyZone({ to: c.to, companyCountry: home }).zone !== 'international') continue;
    if (!ensured) { await store.ensure(companyId); ensured = true; }
    await store.debit(companyId, key, { minutes: Math.ceil(seconds / 60), seconds });
    handled.add(key);
  }
  return handled;
}

/**
 * Solde à utiliser pour un appel sortant vers `to` : { kind: 'international', minutes } (solde international) ou
 * { kind: 'national', minutes: nationalMinutes } (solde normal, inchangé). Offre non concernée, destination domestique ou lecture
 * impossible : solde normal, comme avant. Ne lève jamais.
 */
export async function resolveOutboundBalance({ companyId, limits, to, nationalMinutes, store = mongoStore, country = companyCountryOf }) {
  const fallback = { kind: 'national', minutes: nationalMinutes, zone: null, euZone: null };
  if (!internationalPackApplies(limits)) return fallback;
  try {
    const { zone, euZone } = classifyZone({ to, companyCountry: await country(companyId) });
    if (zone !== 'international') return { kind: 'national', minutes: nationalMinutes, zone, euZone };
    const wallet = await store.read(companyId);
    return { kind: 'international', minutes: typeof wallet?.minutes === 'number' ? wallet.minutes : 0, zone, euZone };
  } catch (error) {
    console.warn('[international] solde illisible, comportement habituel :', error?.message || error);
    return fallback;
  }
}

/** Vue en lecture seule des deux soldes (écran Facturation). */
export function buildBalancesOverview({ limits, national, international, companyCountry, packs }) {
  const zone = classifyZone({ to: '', companyCountry });
  return {
    national: { minutes: national?.minutes ?? 0, includedMinutes: national?.planMinutesIncluded ?? 0 },
    international: {
      applies: internationalPackApplies(limits),
      minutes: international?.minutes ?? 0,
      purchasedMinutes: international?.purchasedMinutes ?? 0,
      consumedSeconds: international?.consumedSeconds ?? 0,
    },
    zone: { companyCountry: companyCountry || '', euZone: zone.euZone },
    packs: packs || [],
  };
}
