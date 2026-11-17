import crypto from 'node:crypto';
import MinutesCompany from '../models/MinutesCompany.js';
import { stripeService } from './stripeService.js';
import { callcenterTierFromMetadata, isCallcenterMetadata } from './callcenterTier.js';
import { countryPrefixOf, toStrictE164 } from './outboundDestinations.js';
import { allowedPrefixes, MAX_CALL_SECONDS, maxSecondsForBalance } from './browserOutbound.js';

/**
 * Minutes d'appel HORS FORFAIT de l'offre Multi-clients (`callcenter_tier=multi_clients`).
 *
 * Tout vient des métadonnées du PRODUIT Stripe (aucun montant dans le code) :
 *   overage_national_cents      prix d'une minute nationale hors forfait, en centimes
 *   overage_international_cents prix d'une minute internationale hors forfait, en centimes
 *   overage_cap_cents           (facultatif) plafond de dépassement par période de facturation, en centimes
 * Les deux tarifs sont requis : sinon (ou pour tout autre palier / forfait) AUCUN dépassement n'est géré et le comportement
 * historique s'applique (sortant coupé au solde nul, solde débité en entier).
 *
 * Principe : le solde de minutes (MinutesCompany.minutes) reste la source des minutes INCLUSES. Pour une entreprise concernée,
 * un appel ne débite que les minutes entières encore disponibles ; le reste (minutes entamées, arrondi à la minute supérieure)
 * est enregistré dans `overageCalls` AVEC le débit, dans la même écriture atomique du portefeuille (idempotente par appel).
 * Le solde ne devient donc jamais négatif et un dépassement n'est jamais consommé par l'octroi du mois suivant.
 */

export const OVERAGE_TIER = 'multi_clients';
const CLASSES = ['national', 'international'];
const MAX_SETTLE_ATTEMPTS = 5;

function metadataEntries(metadata) {
  if (!metadata || typeof metadata !== 'object') return [];
  return metadata instanceof Map ? [...metadata.entries()] : Object.entries(metadata);
}

/**
 * Tarifs de dépassement d'un produit, ou null (palier autre que Multi-clients, produit non Call Centre, tarif absent ou illisible).
 * @returns {{nationalCents: number, internationalCents: number, capCents: number|null}|null}
 */
export function overageConfigFromMetadata(metadata) {
  if (!isCallcenterMetadata(metadata) || callcenterTierFromMetadata(metadata) !== OVERAGE_TIER) return null;
  const limits = stripeService.extractStripeProductLimits({ metadata: Object.fromEntries(metadataEntries(metadata)) });
  if (!Number.isFinite(limits.overageNationalCents) || !Number.isFinite(limits.overageInternationalCents)) return null;
  return {
    nationalCents: limits.overageNationalCents,
    internationalCents: limits.overageInternationalCents,
    capCents: Number.isFinite(limits.overageCapCents) ? limits.overageCapCents : null,
  };
}

/** Prix d'une minute de cette classe (centimes). */
export const unitCentsFor = (config, klass) => (klass === 'international' ? config.internationalCents : config.nationalCents);

/** Toute minute commencée est facturée en entier (10 s → 1 min, 1 min 02 → 2 min) : même règle que le débit historique. */
export const billableMinutes = (seconds) => Math.ceil(Number(seconds) / 60);

/**
 * Classe d'un appel. Sortant : pays de la destination comparé au pays de l'entreprise (même règle que outboundPolicy : indicatif
 * pays). Entrant : selon la provenance quand elle est connue (numéro appelant lisible), sinon NATIONAL. Sortant à destination
 * illisible : national par défaut (`basis: 'default'`, repérable dans l'enregistrement).
 * `companyCountry` vide : premier préfixe par défaut de la politique sortante (comme outboundPolicy).
 * @returns {{klass: 'national'|'international', basis: 'destination'|'origin'|'default'}}
 */
export function classifyCall({ direction, to, from } = {}, companyCountry = '') {
  const home = companyCountry || allowedPrefixes()[0];
  const inbound = direction === 'inbound';
  const remote = countryPrefixOf(toStrictE164(inbound ? from : to));
  if (!remote) return { klass: 'national', basis: 'default' };
  return { klass: remote === home ? 'national' : 'international', basis: inbound ? 'origin' : 'destination' };
}

/** Répartition d'un appel : minutes entières du solde dans le forfait, le reste en dépassement. */
export function splitIncludedMinutes(balance, callMinutes) {
  const whole = Math.floor(Number(balance));
  const available = Number.isFinite(whole) && whole > 0 ? whole : 0;
  const included = Math.min(available, callMinutes);
  return { included, overage: callMinutes - included };
}

const atMs = (e) => new Date(e?.at || 0).getTime();

/**
 * Montants d'une période, du plus ancien au plus récent, plafond appliqué (le plafond de la période est celui enregistré par
 * le dernier appel : il vient du produit Stripe au moment de l'appel ; `capOverride` impose le plafond courant, null = aucun).
 * Les tarifs sont ceux enregistrés avec chaque appel.
 */
export function summarizePeriod(entries, periodKey, capOverride) {
  const rows = (entries || []).filter((e) => e && e.periodKey === periodKey && e.overageMinutes > 0).sort((a, b) => atMs(a) - atMs(b));
  const caps = rows.map((e) => e.capCents).filter((c) => Number.isFinite(c));
  const capCents = capOverride !== undefined ? capOverride : caps.length ? caps[caps.length - 1] : null;
  const out = { national: { minutes: 0, cents: 0 }, international: { minutes: 0, cents: 0 }, totalCents: 0, capCents, capReached: false };
  let remaining = capCents;
  for (const e of rows) {
    const klass = e.klass === 'international' ? 'international' : 'national';
    let cents = e.overageMinutes * e.unitCents;
    if (remaining !== null) { cents = Math.max(0, Math.min(cents, remaining)); remaining -= cents; }
    out[klass].minutes += e.overageMinutes;
    out[klass].cents += cents;
    out.totalCents += cents;
  }
  out.capReached = capCents !== null && out.totalCents >= capCents;
  return out;
}

/**
 * Durée maximale (secondes) d'un appel sortant : minutes entières du solde + minutes de dépassement autorisées (sans plafond :
 * jusqu'au maximum de Twilio ; avec plafond : ce que le plafond restant paie à ce tarif). Sans configuration de dépassement :
 * exactement `maxSecondsForBalance`. 0 = appel refusé.
 */
export function outboundMaxSeconds({ minutes, config, klass, usedCents = 0 }) {
  const balanceSeconds = maxSecondsForBalance(minutes);
  if (!config) return balanceSeconds;
  if (config.capCents === null || config.capCents === undefined) return MAX_CALL_SECONDS;
  const unit = unitCentsFor(config, klass);
  const overageMinutes = unit > 0 ? Math.floor(Math.max(0, config.capCents - usedCents) / unit) : 0;
  const whole = Math.floor(Number(minutes));
  const balanceMinutes = Number.isFinite(whole) && whole > 0 ? whole : 0;
  return Math.min((balanceMinutes + overageMinutes) * 60, MAX_CALL_SECONDS);
}

// --- Accès au portefeuille (atomique par appel) ------------------------------------------------------------------------

/** Magasin MongoDB : une seule écriture conditionnelle par appel (débit + enregistrement du dépassement + clé d'idempotence). */
export const mongoStore = {
  async read(companyId) {
    return MinutesCompany.findOne({ companyId }).lean();
  },
  async applyCall(companyId, key, { expectMinutes, debitMinutes, seconds, entry }) {
    const update = { $inc: { minutes: -debitMinutes, consumedSeconds: seconds }, $addToSet: { chargedCallSids: key } };
    if (entry) update.$push = { overageCalls: entry };
    const done = await MinutesCompany.findOneAndUpdate({ companyId, chargedCallSids: { $ne: key }, minutes: expectMinutes }, update, { new: true });
    return Boolean(done);
  },
  async markBilled(companyId, callSids, { invoiceItemId, at }) {
    await MinutesCompany.updateOne(
      { companyId },
      { $set: { 'overageCalls.$[e].invoiceItemId': invoiceItemId, 'overageCalls.$[e].billedAt': at } },
      { arrayFilters: [{ 'e.callSid': { $in: callSids }, 'e.invoiceItemId': { $exists: false } }] }
    );
  },
  async companiesWithClosedOverage(now) {
    const rows = await MinutesCompany.find({ overageCalls: { $elemMatch: { invoiceItemId: { $exists: false }, periodEnd: { $lte: now } } } }).select('companyId').lean();
    return rows.map((r) => String(r.companyId));
  },
  async ensure(companyId) {
    let wallet = await MinutesCompany.findOne({ companyId });
    if (!wallet) wallet = await MinutesCompany.create({ companyId, minutes: 0 });
    return wallet;
  },
};

/**
 * Compte des appels terminés pour une entreprise concernée : pour chacun, ordre chronologique, répartit forfait / dépassement
 * et applique débit + enregistrement en une écriture atomique. Idempotent par appel (`chargedCallSids`). Une écriture perdue
 * à la suite d'un débit concurrent est rejouée avec le solde relu.
 * @param {{companyId: string, calls: Array<{sid?: string, _id?: any, duration: number, direction?: string, to?: string, from?: string, startTime?: any, createdAt?: any}>,
 *   ctx: {config: object, periodKey: string, periodStart?: Date, periodEnd?: Date}, companyCountry?: string, store?: object, now?: Date}} args
 * @returns {Promise<{charged: string[], overageMinutes: number}>}
 */
export async function settleCalls({ companyId, calls, ctx, companyCountry = '', store = mongoStore, now = new Date() }) {
  const charged = [];
  let overageMinutes = 0;
  const ordered = [...(calls || [])].sort((a, b) => new Date(a.startTime || a.createdAt || 0) - new Date(b.startTime || b.createdAt || 0));
  for (const c of ordered) {
    const key = String(c.sid || c._id || '');
    const seconds = Number(c.duration || 0);
    if (!key || !(seconds > 0)) continue;
    const callMinutes = billableMinutes(seconds);
    const { klass, basis } = classifyCall(c, companyCountry);
    let settled = false;
    for (let attempt = 0; attempt < MAX_SETTLE_ATTEMPTS; attempt += 1) {
      const wallet = await store.read(companyId);
      if (!wallet) { settled = true; break; }
      if ((wallet.chargedCallSids || []).includes(key)) { settled = true; break; }
      const { included, overage } = splitIncludedMinutes(wallet.minutes, callMinutes);
      const entry = overage > 0 ? {
        callSid: key, periodKey: ctx.periodKey, periodStart: ctx.periodStart, periodEnd: ctx.periodEnd,
        klass, basis, direction: c.direction === 'inbound' ? 'inbound' : 'outbound',
        countryPrefix: countryPrefixOf(toStrictE164(c.direction === 'inbound' ? c.from : c.to)) || '',
        seconds, callMinutes, includedMinutes: included, overageMinutes: overage,
        unitCents: unitCentsFor(ctx.config, klass), capCents: ctx.config.capCents ?? null,
        at: new Date(c.startTime || c.createdAt || now),
      } : null;
      if (await store.applyCall(companyId, key, { expectMinutes: wallet.minutes, debitMinutes: included, seconds, entry })) {
        charged.push(key);
        overageMinutes += overage;
        settled = true;
        break;
      }
    }
    // Conflits répétés : l'appel reste non compté et sera repris à la prochaine lecture du solde (idempotent).
    if (!settled) console.warn(`[overage] appel ${key} non compté après ${MAX_SETTLE_ATTEMPTS} tentatives (débits concurrents), repris à la prochaine lecture`);
  }
  return { charged, overageMinutes };
}

// --- Contexte d'une entreprise (forfait, période, client Stripe) -------------------------------------------------------

/** Clé de période : identique à celle de l'octroi des minutes (abonnement + début de période). */
export function periodKeyOf(subscription) {
  const subRef = subscription?.stripeSubscriptionId || String(subscription?._id);
  const start = subscription?.currentPeriodStart ? new Date(subscription.currentPeriodStart).toISOString() : 'unknown';
  return `${subRef}:${start}`;
}

/** Contexte de dépassement à partir d'un abonnement dont `planId` est peuplé, ou null si l'entreprise n'est pas concernée. */
export function overageContextOf(subscription) {
  const plan = subscription?.planId;
  if (!plan || typeof plan === 'string') return null;
  const config = overageConfigFromMetadata(plan.metadata);
  if (!config) return null;
  return {
    config,
    periodKey: periodKeyOf(subscription),
    periodStart: subscription.currentPeriodStart ? new Date(subscription.currentPeriodStart) : undefined,
    periodEnd: subscription.currentPeriodEnd ? new Date(subscription.currentPeriodEnd) : undefined,
    customerId: subscription.stripeCustomerId && subscription.stripeCustomerId !== 'paypal' ? subscription.stripeCustomerId : null,
    currency: String(plan.currency || 'eur').toLowerCase(),
    planName: plan.name ? String(plan.name) : null,
  };
}

/** Contexte de l'abonnement actif de l'entreprise (même sélection que loadCompanyPlanLimits). Ne lève jamais : null en cas d'échec. */
export async function loadOverageContext(companyId, { findSubscription } = {}) {
  try {
    if (!companyId) return null;
    const find = findSubscription || (async (id) => {
      const { Subscription } = await import('../models/Subscription.js');
      return Subscription.findOne({ companyId: String(id), status: { $in: ['active', 'trialing', 'past_due'] } }).populate('planId');
    });
    return overageContextOf(await find(companyId));
  } catch (error) {
    console.warn('[overage] contexte illisible, comportement historique :', error?.message || error);
    return null;
  }
}

/** Pays de l'entreprise (indicatif de sa première ligne), comme outboundPolicy. */
export async function companyCountryOf(companyId, options) {
  const { resolveOutboundPolicy } = await import('./outboundPolicy.js');
  return (await resolveOutboundPolicy(companyId, options)).companyCountry || '';
}

/**
 * Durée maximale d'un appel sortant vers `to` : consigne unique pour tous les points d'entrée sortants. Sans dépassement configuré
 * (autre forfait, métadonnées absentes, palier autre que Multi-clients) : `maxSecondsForBalance(minutes)`, comme avant.
 * `limits.overage` / `limits.periodKey` viennent de loadCompanyPlanLimits. Ne lève jamais.
 */
export async function maxSecondsForOutbound({ companyId, limits, to, minutes, readWallet = (id) => mongoStore.read(id), country = companyCountryOf }) {
  const config = limits?.overage || null;
  if (!config) return maxSecondsForBalance(minutes);
  try {
    const wallet = await readWallet(companyId);
    const usedCents = summarizePeriod(wallet?.overageCalls, limits.periodKey, config.capCents).totalCents;
    const { klass } = classifyCall({ direction: 'outbound', to }, await country(companyId));
    return outboundMaxSeconds({ minutes, config, klass, usedCents });
  } catch (error) {
    console.warn('[overage] durée maximale : repli sur le solde :', error?.message || error);
    return maxSecondsForBalance(minutes);
  }
}

/**
 * Compte les appels `calls` d'une entreprise concernée par le dépassement. Renvoie null si elle n'est pas concernée (l'appelant
 * applique alors son débit historique, inchangé), sinon le résultat de settleCalls.
 */
export async function settleCompanyCalls(companyId, calls, { loadContext = loadOverageContext, country = companyCountryOf, store = mongoStore } = {}) {
  const ctx = await loadContext(companyId);
  if (!ctx) return null;
  await store.ensure?.(companyId);
  return settleCalls({ companyId, calls, ctx, companyCountry: await country(companyId), store });
}

// --- Facturation -------------------------------------------------------------------------------------------------------

const batchHash = (callSids) => crypto.createHash('sha1').update([...callSids].sort().join(',')).digest('hex').slice(0, 12);
const money = (cents, currency) => `${(cents / 100).toFixed(2).replace('.', ',')} ${String(currency).toLowerCase() === 'eur' ? '€' : String(currency).toUpperCase()}`;

/** Ligne déjà créée chez Stripe pour cette clé (retrouvée par sa métadonnée : la clé d'idempotence de Stripe expire après 24 h). */
async function findExistingItem(stripe, customerId, key, since) {
  let startingAfter;
  for (let page = 0; page < 5; page += 1) {
    const res = await stripe.invoiceItems.list({ customer: customerId, limit: 100, created: { gte: Math.floor(since / 1000) }, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    const hit = (res?.data || []).find((i) => i?.metadata?.overage_key === key);
    if (hit) return hit;
    if (!res?.has_more || !res.data?.length) return null;
    startingAfter = res.data[res.data.length - 1].id;
  }
  return null;
}

/**
 * Facture les minutes hors forfait des périodes CLOSES (`periodEnd` passé) : une ligne de facture Stripe (invoice item) par
 * période et par classe, « minutes nationales » / « minutes internationales », sur le client Stripe de l'entreprise (ou sur la
 * facture brouillon `invoiceId`). Idempotent : les appels facturés sont marqués ; la clé (entreprise + période + classe + lot
 * d'appels) sert aussi de clé d'idempotence Stripe et de métadonnée, relue avant toute création. Un échec est journalisé et
 * n'interrompt rien (les appels restent à facturer à la passe suivante) ; il ne bloque jamais les appels.
 * @returns {Promise<{created: object[], failed: object[]}>}
 */
export async function billClosedPeriods({ companyId, store = mongoStore, stripe, customerId, currency = 'eur', now = new Date(), invoiceId = null }) {
  const result = { created: [], failed: [] };
  if (!stripe || !customerId) return result;
  const wallet = await store.read(companyId);
  const all = wallet?.overageCalls || [];
  const closedKeys = [...new Set(all.filter((e) => e.periodEnd && new Date(e.periodEnd) <= now && !e.invoiceItemId && e.overageMinutes > 0).map((e) => e.periodKey))];
  for (const periodKey of closedKeys) {
    const periodEntries = all.filter((e) => e.periodKey === periodKey);
    const summary = summarizePeriod(periodEntries, periodKey);
    // Montants plafonnés du lot non encore facturé, par classe : calculés sur toute la période (le plafond est partagé), du plus ancien au plus récent.
    const ordered = periodEntries.filter((e) => e.overageMinutes > 0).sort((a, b) => atMs(a) - atMs(b));
    let remaining = summary.capCents;
    const perClass = Object.fromEntries(CLASSES.map((k) => [k, { sids: [], minutes: 0, cents: 0, rawCents: 0, units: new Set() }]));
    for (const e of ordered) {
      const raw = e.overageMinutes * e.unitCents;
      let cents = raw;
      if (remaining !== null) { cents = Math.max(0, Math.min(cents, remaining)); remaining -= cents; }
      if (e.invoiceItemId) continue;
      const bucket = perClass[e.klass === 'international' ? 'international' : 'national'];
      bucket.sids.push(e.callSid); bucket.minutes += e.overageMinutes; bucket.cents += cents; bucket.rawCents += raw; bucket.units.add(e.unitCents);
    }
    const periodEnd = new Date(periodEntries.find((e) => e.periodEnd)?.periodEnd || now);
    for (const klass of CLASSES) {
      const lot = perClass[klass];
      if (!lot.sids.length) continue;
      if (lot.cents <= 0) {
        // Rien à facturer (plafond atteint) : lot soldé pour ne pas être réexaminé.
        await store.markBilled(companyId, lot.sids, { invoiceItemId: 'none:cap', at: now }).catch(() => null);
        continue;
      }
      const key = `overage:${companyId}:${periodKey}:${klass}:${batchHash(lot.sids)}`;
      try {
        let item = await findExistingItem(stripe, customerId, key, periodEnd.getTime());
        if (!item) {
          const label = klass === 'international' ? 'internationales' : 'nationales';
          const detail = lot.cents < lot.rawCents ? ' (plafond de dépassement appliqué)' : lot.units.size === 1 ? ` × ${money([...lot.units][0], currency)}` : '';
          item = await stripe.invoiceItems.create({
            customer: customerId,
            currency,
            amount: lot.cents,
            description: `Minutes ${label} hors forfait — ${lot.minutes} min${detail}`,
            metadata: { overage_key: key, overage_class: klass, company_id: String(companyId), period_key: periodKey, overage_minutes: String(lot.minutes) },
            ...(invoiceId ? { invoice: invoiceId } : {}),
          }, { idempotencyKey: key });
          result.created.push({ klass, key, amount: lot.cents, itemId: item.id });
        }
        await store.markBilled(companyId, lot.sids, { invoiceItemId: item.id, at: now });
      } catch (error) {
        console.warn(`[overage] facturation impossible (entreprise ${companyId}, ${klass}) :`, error?.message || error);
        result.failed.push({ klass, key, error: String(error?.message || error) });
      }
    }
  }
  return result;
}

/** Une passe de facturation pour une entreprise : contexte Stripe lu de son abonnement. Ne lève jamais. */
export async function billCompany(companyId, { stripe = stripeService.isConfigured() ? stripeService.getSharedClient() : null, invoiceId = null, store = mongoStore, now = new Date(), findCustomer, sync } = {}) {
  try {
    // Les appels ne sont comptés qu'à la lecture du solde : rattrape ceux qui n'auraient pas encore été comptés avant de facturer.
    try { await (sync || (await import('../controllers/escrowController.js')).syncMinutesFromCalls)(companyId); } catch (error) { console.warn('[overage] comptage des appels ignoré :', error?.message || error); }
    const { Subscription } = await import('../models/Subscription.js');
    const sub = await Subscription.findOne({ companyId: String(companyId), provider: { $ne: 'paypal' }, stripeCustomerId: { $exists: true, $nin: [null, '', 'paypal'] } }).sort({ updatedAt: -1 }).populate('planId').lean();
    const customerId = findCustomer ? await findCustomer(companyId) : sub?.stripeCustomerId || null;
    const currency = String(sub?.planId?.currency || 'eur').toLowerCase();
    return await billClosedPeriods({ companyId, store, stripe, customerId, currency, now, invoiceId });
  } catch (error) {
    console.warn(`[overage] passe de facturation ignorée (entreprise ${companyId}) :`, error?.message || error);
    return { created: [], failed: [] };
  }
}

/** Tâche périodique : facture toutes les entreprises ayant des dépassements de période close non facturés. Ne lève jamais. */
export async function billAllClosedPeriods({ store = mongoStore, now = new Date(), ...rest } = {}) {
  let companies = [];
  try { companies = await store.companiesWithClosedOverage(now); } catch (error) { console.warn('[overage] balayage impossible :', error?.message || error); return { companies: 0, created: 0 }; }
  let created = 0;
  for (const id of companies) created += (await billCompany(id, { store, now, ...rest })).created.length;
  return { companies: companies.length, created };
}

// --- Lecture pour l'écran Facturation ----------------------------------------------------------------------------------

/**
 * Vue en lecture seule : minutes incluses restantes, minutes de dépassement nationales / internationales et montant estimé de la
 * période courante. `applicable: false` pour les entreprises non concernées (autre forfait, métadonnées absentes).
 */
export function buildOverageOverview({ ctx, wallet, planMinutesIncluded = 0, now = new Date() }) {
  const minutes = typeof wallet?.minutes === 'number' ? wallet.minutes : 0;
  const includedRemaining = Math.max(0, Math.floor(minutes));
  if (!ctx) {
    return { applicable: false, includedMinutes: planMinutesIncluded, includedRemaining, overage: null, period: null, currency: null };
  }
  const s = summarizePeriod(wallet?.overageCalls, ctx.periodKey, ctx.config.capCents);
  return {
    applicable: true,
    includedMinutes: planMinutesIncluded,
    includedRemaining,
    period: { start: ctx.periodStart ? ctx.periodStart.toISOString() : null, end: ctx.periodEnd ? ctx.periodEnd.toISOString() : null },
    currency: ctx.currency,
    overage: {
      national: { minutes: s.national.minutes, unitCents: ctx.config.nationalCents, cents: s.national.cents },
      international: { minutes: s.international.minutes, unitCents: ctx.config.internationalCents, cents: s.international.cents },
      estimatedCents: s.totalCents,
      capCents: ctx.config.capCents,
      capReached: ctx.config.capCents !== null && s.totalCents >= ctx.config.capCents,
    },
    estimate: true,
    generatedAt: now.toISOString(),
  };
}
