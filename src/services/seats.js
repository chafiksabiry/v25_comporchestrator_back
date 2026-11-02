import mongoose from 'mongoose';
import { callcenterTierFromMetadata } from './callcenterTier.js';

/**
 * Sièges en plus : chaque offre Call Centre inclut 1 siège (le titulaire). Un siège = une personne rattachée au centre
 * (membres et agents, invités ou actifs, titulaire compris). Au-delà du premier, chaque siège est facturé chaque mois
 * (Accueil, Full Scope, Multi-clients) ; Nomad Solo n'en accepte aucun. Le code de lancement ne s'applique pas aux sièges.
 *
 * Le nombre de sièges est calculé côté serveur dans la base MongoDB partagée avec le service d'inscription
 * (collections `companies`, `companymemberships`, `agentinvitations`, `users`) : ce n'est jamais une valeur envoyée par le navigateur.
 * Les prix viennent de Stripe : produits portant `harx_product=callcenter_seat` et `seat_for_tier=<palier>`.
 */

export const SEAT_PRODUCT = 'callcenter_seat';
export const INCLUDED_SEATS = 1;
export const SEAT_TIERS = ['accueil', 'full_scope', 'multi_clients'];
export const ENTITLED_STATUSES = ['active', 'trialing'];
export const NOT_CONFIGURED_MESSAGE =
  "Facturation des sièges non configurée : aucun siège en plus n'est facturé pour le moment.";

const PRICE_CACHE_MS = 5 * 60 * 1000;
let priceCache = null;

export function clearSeatPriceCache() {
  priceCache = null;
}

/** Sièges en plus à facturer, pour `used` sièges occupés (titulaire compris). */
export function extraSeats(used) {
  const n = Math.floor(Number(used));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, n - INCLUDED_SEATS);
}

function metadataEntries(metadata) {
  if (!metadata) return {};
  const source = metadata instanceof Map ? Object.fromEntries(metadata.entries()) : metadata;
  if (typeof source !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(source)) out[String(k).trim().toLowerCase()] = v;
  return out;
}

function metaValue(metadata, key) {
  return String(metadataEntries(metadata)[key] ?? '').trim().toLowerCase();
}

export function isSeatMetadata(metadata) {
  return metaValue(metadata, 'harx_product') === SEAT_PRODUCT;
}

/** Palier d'un produit « siège » (`seat_for_tier`), accepte les alias de palier ; null si absent ou inconnu. */
export function seatTierFromMetadata(metadata) {
  if (!isSeatMetadata(metadata)) return null;
  return callcenterTierFromMetadata({ callcenter_tier: metaValue(metadata, 'seat_for_tier') });
}

function oid(value) {
  const s = String(value);
  return mongoose.isValidObjectId(s) ? new mongoose.Types.ObjectId(s) : s;
}

/**
 * Sièges occupés par le centre : titulaire + membres (rattachements et invitations en attente) + agents (comptes du centre
 * et invitations en attente ou acceptées). Une même personne ne compte qu'une fois. Mêmes règles que les listes
 * `GET /api/company-members` et `GET /api/call-center/agents` du service d'inscription.
 * @param {{ collection: (name: string) => any }} db
 */
export async function countSeatsUsed(db, companyId) {
  const company = oid(companyId);
  const companyDoc = await db.collection('companies').findOne({ _id: company });
  const ownerId = companyDoc?.userId ? String(companyDoc.userId) : null;
  const people = new Set();
  const add = (userId, email) => {
    const key = userId ? `u:${String(userId)}` : email ? `e:${String(email).trim().toLowerCase()}` : null;
    if (key) people.add(key);
  };
  const isOwner = (userId) => Boolean(ownerId && userId && String(userId) === ownerId);

  if (ownerId) add(ownerId, null);
  else people.add('owner');

  const memberships = await db.collection('companymemberships').find({ companyId: company }).toArray();
  for (const m of memberships) if (!isOwner(m.userId)) add(m.userId, m.email);

  const agentUsers = await db.collection('users').find({ employerCompanyId: company, typeUser: 'rep' }).toArray();
  for (const u of agentUsers) if (!isOwner(u._id)) add(u._id, u.email);

  const invitations = await db.collection('agentinvitations').find({ companyId: company }).toArray();
  for (const i of invitations) {
    const status = String(i.status || '');
    const open = i.kind === 'member' ? status === 'pending' : status === 'pending' || status === 'accepted';
    if (open && !isOwner(i.userId)) add(i.userId, i.email);
  }
  return people.size;
}

/** Abonnement actif ou en essai le plus récent du centre et palier Call Centre de son plan. */
export async function loadSeatContext(db, companyId) {
  const ids = [String(companyId)];
  if (mongoose.isValidObjectId(String(companyId))) ids.push(new mongoose.Types.ObjectId(String(companyId)));
  const subscription = await db
    .collection('subscriptions')
    .find({ companyId: { $in: ids }, status: { $in: ENTITLED_STATUSES } })
    .sort({ createdAt: -1 })
    .limit(1)
    .next();
  if (!subscription) return { subscription: null, tier: null };
  const plan = subscription.planId ? await db.collection('subscriptionplans').findOne({ _id: oid(subscription.planId) }) : null;
  const isCallcenter = metaValue(plan?.metadata, 'harx_product') === 'callcenter';
  return { subscription, tier: isCallcenter ? callcenterTierFromMetadata(metadataEntries(plan?.metadata)) : null };
}

async function listPrices(stripe, productId) {
  const res = await stripe.prices.list({ product: productId, active: true, type: 'recurring', limit: 10 });
  return (res?.data || []).filter((p) => p.recurring?.interval === 'month' && p.unit_amount != null);
}

/**
 * Prix des sièges par palier, retrouvés par métadonnées dans Stripe (aucun identifiant en dur).
 * @returns {Promise<Record<string, {priceId: string, productId: string, unitAmount: number, currency: string}>>} vide si rien n'est configuré
 */
export async function loadSeatPrices(stripe, { now = Date.now() } = {}) {
  if (priceCache && priceCache.stripe === stripe && now - priceCache.at < PRICE_CACHE_MS) return priceCache.prices;
  const prices = {};
  const products = await stripe.products.list({ active: true, limit: 100 });
  for (const product of products?.data || []) {
    const tier = seatTierFromMetadata(product.metadata);
    if (!tier || tier === 'nomad_solo' || prices[tier]) continue;
    let price = null;
    if (product.default_price && typeof product.default_price === 'object' && product.default_price.active !== false) {
      price = product.default_price;
    }
    if (!price) price = (await listPrices(stripe, product.id))[0] || null;
    if (price?.unit_amount == null) continue;
    prices[tier] = { priceId: price.id, productId: product.id, unitAmount: price.unit_amount, currency: price.currency || 'eur' };
  }
  priceCache = { stripe, at: now, prices };
  return prices;
}

function seatItemOf(stripeSubscription, seatPrice) {
  const items = stripeSubscription?.items?.data || [];
  return (
    items.find((it) => it.price?.id === seatPrice.priceId) ||
    items.find((it) => (typeof it.price?.product === 'string' ? it.price.product : it.price?.product?.id) === seatPrice.productId) ||
    items.find((it) => isSeatMetadata(it.metadata)) ||
    null
  );
}

/**
 * Le premier élément d'abonnement qui n'est pas une ligne « siège » (le forfait lui-même).
 * @param {Array<{metadata?: object}>} items
 */
export function pickPlanItem(items) {
  const list = items || [];
  return list.find((it) => !isSeatMetadata(it.metadata)) || list[0];
}

function euros(cents) {
  return Math.round(cents) / 100;
}

function base(used, tier, price) {
  const extra = extraSeats(used);
  return {
    tier,
    used,
    included: INCLUDED_SEATS,
    extra,
    unitPrice: price ? euros(price.unitAmount) : null,
    unitAmount: price ? price.unitAmount : null,
    currency: price ? price.currency : null,
    monthlyTotal: price ? euros(price.unitAmount * extra) : null,
  };
}

function notApplicable(reason, used, tier, message) {
  return { applicable: false, configured: false, reason, message, ...base(used, tier, null), billedQuantity: 0 };
}

/**
 * État des sièges d'un centre. Ne lève jamais d'erreur Stripe : sans configuration, `configured` vaut false.
 */
export async function getSeatsState({ db, stripe, companyId }) {
  const used = await countSeatsUsed(db, companyId);
  const { subscription, tier } = await loadSeatContext(db, companyId);
  if (!subscription || !tier) {
    return notApplicable('no_subscription', used, tier, "Aucun abonnement Call Centre actif ou en essai : pas de siège à facturer.");
  }
  if (tier === 'nomad_solo') {
    return notApplicable('nomad_solo', used, tier, "Nomad Solo : un seul utilisateur, aucun siège en plus.");
  }
  let price = null;
  let billedQuantity = null;
  let discountMayApplyToSeats = false;
  if (stripe) {
    try {
      price = (await loadSeatPrices(stripe))[tier] || null;
      if (price && subscription.stripeSubscriptionId) {
        const sub = await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId);
        const item = seatItemOf(sub, price);
        billedQuantity = item ? item.quantity || 0 : 0;
        discountMayApplyToSeats = Boolean(sub?.discount || (sub?.discounts || []).length);
      }
    } catch (err) {
      console.warn('[seats] lecture Stripe impossible :', err?.message || err);
      price = null;
    }
  }
  if (!price) {
    return { applicable: true, configured: false, reason: 'not_configured', message: NOT_CONFIGURED_MESSAGE, ...base(used, tier, null), billedQuantity: 0 };
  }
  return { applicable: true, configured: true, reason: null, message: null, ...base(used, tier, price), billedQuantity, discountMayApplyToSeats };
}

const locks = new Map();
/** Sérialise les synchronisations d'un même centre (deux invitations rapprochées ne se marchent pas dessus). */
function withLock(key, fn) {
  const previous = locks.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

/**
 * Aligne la quantité de la ligne « siège en plus » de l'abonnement Stripe sur max(0, sièges − 1), avec proration.
 * Idempotent : la quantité cible est comparée à celle de Stripe, sans écriture si elle est déjà bonne.
 * @returns {Promise<object>} état des sièges + `action` : 'created' | 'updated' | 'removed' | 'unchanged' | 'skipped'
 */
export function syncSeats({ db, stripe, companyId }) {
  return withLock(String(companyId), async () => {
    const state = await getSeatsState({ db, stripe, companyId });
    if (!state.applicable || !state.configured) return { ...state, action: 'skipped' };

    const { subscription } = await loadSeatContext(db, companyId);
    if (!subscription?.stripeSubscriptionId) {
      return { ...state, configured: false, reason: 'no_stripe_subscription', message: NOT_CONFIGURED_MESSAGE, action: 'skipped' };
    }
    const price = (await loadSeatPrices(stripe))[state.tier];
    const stripeSub = await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId);
    const item = seatItemOf(stripeSub, price);
    const target = state.extra;
    const current = item ? item.quantity || 0 : 0;

    let action = 'unchanged';
    if (item && target === 0) {
      await stripe.subscriptionItems.del(item.id, { proration_behavior: 'create_prorations' });
      action = 'removed';
    } else if (item && current !== target) {
      await stripe.subscriptionItems.update(item.id, { quantity: target, proration_behavior: 'create_prorations' });
      action = 'updated';
    } else if (!item && target > 0) {
      await stripe.subscriptionItems.create({
        subscription: subscription.stripeSubscriptionId,
        price: price.priceId,
        quantity: target,
        proration_behavior: 'create_prorations',
        metadata: { harx_product: SEAT_PRODUCT, company_id: String(companyId) },
      });
      action = 'created';
    }
    return { ...state, billedQuantity: target, action };
  });
}
