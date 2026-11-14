import { PhoneNumber } from '../models/PhoneNumber.js';
import { Subscription } from '../models/Subscription.js';
import { stripeService } from './stripeService.js';

/**
 * Abonnement mensuel par ligne (offres Call Centre) : un abonnement Stripe PAR LIGNE, sur le client Stripe de l'abonnement
 * d'offre, au prix `phone_line_price_cents` du produit de l'offre. Les lignes déjà achetées ne sont jamais concernées :
 * seules celles marquées `billingModel = 'monthly'` ont un abonnement.
 *
 * Module « feuille » (aucun import de phoneNumberService) : phoneNumberService.deletePhoneNumber peut donc l'appeler.
 */

/** Clé de métadonnée du PRODUIT Stripe de l'offre : prix mensuel d'une ligne supplémentaire, en centimes. */
export const PHONE_LINE_PRICE_METADATA_KEY = 'phone_line_price_cents';

/** Marqueur des lignes facturées par abonnement mensuel (les anciennes lignes n'ont pas de billingModel). */
export const BILLING_MODEL_MONTHLY = 'monthly';

/** Valeur de `metadata.kind` de l'abonnement Stripe d'une ligne (déjà utilisée par la facturation post-essai TaaS). */
export const PHONE_LINE_SUBSCRIPTION_KIND = 'phone_line_recurring';

/** Le 1er mois est payé à l'achat : le premier cycle de l'abonnement démarre ce nombre de mois plus tard. */
export const FIRST_CYCLE_OFFSET_MONTHS = 1;

// ── DEFAULTS CTO (faute de réponse du propriétaire) : faciles à changer, couverts par des tests ──
/** (a) Annulation d'une ligne : abonnement Stripe résilié tout de suite, sans prorata. */
export const CANCEL_LINE_SUBSCRIPTION_PRORATE = false;
/** (a) ... et sans facture finale ni remboursement du mois en cours. */
export const CANCEL_LINE_SUBSCRIPTION_INVOICE_NOW = false;
/** (b) Une ligne suspendue pour impayé est réactivée si le paiement est régularisé pendant le mois de grâce. */
export const REACTIVATE_LINE_ON_REGULARIZATION = true;
/** Mois de grâce après suspension (PAY-19 : un mois puis résiliation). */
export const SUSPENSION_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Résiliation de l'abonnement d'une ligne par le portail client Stripe (ou fin des relances Stripe) : Stripe envoie
 * customer.subscription.deleted sans que nous l'ayons demandé. Comportement DOCUMENTÉ et voulu : la ligne est traitée
 * comme un impayé, suspendue avec la même grâce de 30 jours, puis résiliée par terminateSuspendedLines. Pour résilier tout de
 * suite une ligne, le client passe par la suppression de la ligne (deletePhoneNumber), pas par le portail.
 */
export const PORTAL_CANCELLATION_GRACE_MS = SUSPENSION_GRACE_MS;
/** Statuts de l'abonnement d'offre dont le client Stripe porte les renouvellements des lignes. */
export const ACTIVE_OFFER_STATUSES = ['active', 'trialing'];
/** Une ligne mensuelle « pending » depuis plus longtemps que cela est reprise ou libérée par la réconciliation. */
export const PENDING_LINE_MAX_AGE_MS = 15 * 60 * 1000;

/** Prix mensuel d'une ligne (centimes entiers > 0) lu dans des métadonnées de produit ; null si absent ou invalide. */
export function phoneLinePriceCentsFromMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  const entries = metadata instanceof Map ? [...metadata.entries()] : Object.entries(metadata);
  const entry = entries.find(([k]) => String(k).trim().toLowerCase() === PHONE_LINE_PRICE_METADATA_KEY);
  if (!entry) return null;
  const raw = String(entry[1] ?? '').trim();
  if (!/^\d+$/.test(raw)) {
    if (raw) console.warn(`[phoneLine] ${PHONE_LINE_PRICE_METADATA_KEY}="${raw}" invalide : repli sur le prix par défaut`);
    return null;
  }
  const cents = Number(raw);
  return cents > 0 ? cents : null;
}

/** Date + n mois calendaires (le 31 janvier + 1 mois = fin février, comme Stripe). */
export function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

function codedError(code, message, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

/**
 * Client Stripe existant de l'entreprise (celui de son abonnement d'offre), s'il y en a un.
 * `activeOnly` : seulement l'abonnement d'offre ACTIF (renouvellements des lignes mensuelles) ; sans cela, comportement
 * historique (facturation TaaS post-essai) inchangé.
 */
export async function resolveCompanyStripeCustomerId(companyId, { activeOnly = false } = {}) {
  const sub = await Subscription.findOne({
    companyId: String(companyId),
    provider: 'stripe',
    stripeCustomerId: { $exists: true, $nin: [null, '', 'paypal'] },
    ...(activeOnly ? { status: { $in: ACTIVE_OFFER_STATUSES } } : {}),
  }).sort({ updatedAt: -1 }).lean();
  return sub?.stripeCustomerId || null;
}

/**
 * Vérifie, AVANT toute commande de numéro, que les renouvellements pourront être prélevés. Renvoie le client Stripe.
 * Lève LINE_SUBSCRIPTION_UNAVAILABLE (Stripe absent), LINE_SUBSCRIPTION_NO_CUSTOMER ou LINE_SUBSCRIPTION_NO_PAYMENT_METHOD.
 */
export async function assertMonthlyLineBillable(companyId) {
  if (!stripeService.isConfigured()) {
    throw codedError('LINE_SUBSCRIPTION_UNAVAILABLE', "L'abonnement mensuel de la ligne est indisponible pour le moment.");
  }
  const customerId = await resolveCompanyStripeCustomerId(companyId, { activeOnly: true });
  if (!customerId) {
    throw codedError(
      'LINE_SUBSCRIPTION_NO_CUSTOMER',
      "Aucun abonnement d'offre actif avec un moyen de paiement n'est enregistré : ajoutez-en un pour souscrire une ligne supplémentaire."
    );
  }
  if (!(await stripeService.hasUsablePaymentMethod(customerId))) {
    throw codedError(
      'LINE_SUBSCRIPTION_NO_PAYMENT_METHOD',
      "La carte de votre abonnement ne peut pas être prélevée automatiquement : mettez-la à jour pour souscrire une ligne supplémentaire."
    );
  }
  return customerId;
}

/**
 * Crée l'abonnement mensuel d'une ligne qui vient d'être achetée (1er mois déjà payé à l'achat : premier cycle décalé).
 * Idempotent : une ligne qui a déjà son abonnement n'en reçoit pas un second. Lève une erreur codée si la création échoue.
 * @param {{line: object, amountCents: number, currency: string, now?: Date}} args
 */
export async function startMonthlyLineSubscription({ line, amountCents, currency, now = new Date(), idempotencyKey }) {
  if (line.stripeSubscriptionId) return { subscriptionId: line.stripeSubscriptionId, alreadyStarted: true };
  const customerId = await assertMonthlyLineBillable(line.companyId);
  const firstCycleAt = addMonths(now, FIRST_CYCLE_OFFSET_MONTHS);
  let subscription;
  try {
    subscription = await stripeService.createPhoneLineSubscription({
      customerId,
      amountCents,
      currency,
      firstCycleAt,
      idempotencyKey: idempotencyKey || `phone-line-sub-${line._id}`,
      metadata: {
        kind: PHONE_LINE_SUBSCRIPTION_KIND,
        phoneNumberId: String(line._id),
        companyId: String(line.companyId),
      },
    });
  } catch (err) {
    throw codedError('LINE_SUBSCRIPTION_FAILED', `Création de l'abonnement de la ligne impossible : ${err.message}`, err);
  }
  line.billingModel = BILLING_MODEL_MONTHLY;
  // Reste « pending » : la ligne n'est active qu'une fois le premier mois encaissé (activateMonthlyLine).
  if (!line.billingStatus || line.billingStatus === 'n/a') line.billingStatus = 'pending';
  line.stripeSubscriptionId = subscription.id;
  line.paymentFailedAt = null;
  line.suspendedAt = null;
  line.terminatesAt = null;
  try {
    await line.save();
  } catch (saveErr) {
    // L'id n'a pas pu être écrit : on annule l'abonnement qu'on vient de créer plutôt que de laisser un orphelin facturable.
    line.stripeSubscriptionId = null;
    try {
      await stripeService.cancelPhoneLineSubscription(subscription.id, { prorate: CANCEL_LINE_SUBSCRIPTION_PRORATE, invoiceNow: CANCEL_LINE_SUBSCRIPTION_INVOICE_NOW });
    } catch (cancelErr) {
      console.error(JSON.stringify({ event: 'phone_line_orphan_subscription', lineId: String(line._id), subscriptionId: subscription.id, reason: cancelErr.message }));
    }
    throw codedError('LINE_SUBSCRIPTION_FAILED', `Enregistrement de l'abonnement de la ligne impossible : ${saveErr.message}`, saveErr);
  }
  return { subscriptionId: subscription.id, alreadyStarted: false };
}

/**
 * État du paiement du premier mois : 'captured' | 'refunded' | 'refund_pending' | 'authorized' | 'canceled' | 'unknown'. Stripe fait foi pour un
 * paiement Stripe ; un statut remboursé chez nous (refunded, ou refund_pending = remboursement à reprendre) l'emporte toujours (jamais de ligne active pour
 * un client remboursé). PayPal : état lu dans notre base seulement. Lève si Stripe est illisible (l'appelant ne tranche pas).
 */
export async function getLinePaymentState(payment) {
  if (payment.status === 'refunded') return 'refunded';
  if (payment.status === 'refund_pending') return 'refund_pending'; // remboursement encore dû : jamais de ligne active, remboursement à reprendre
  if (payment.provider === 'stripe' && payment.providerRef) {
    const state = await stripeService.getCheckoutPaymentState(payment.providerRef);
    if (state === 'unknown') throw new Error('Stripe payment state unknown');
    return state;
  }
  return payment.status === 'succeeded' ? 'captured' : payment.status === 'authorized' ? 'authorized' : 'unknown';
}

/** Premier mois encaissé : la ligne devient active. Idempotent. */
export async function activateMonthlyLine(line) {
  if (line.billingStatus === 'active') return line;
  line.billingStatus = 'active';
  await line.save();
  return line;
}

/**
 * La libération d'une ligne a échoué (opérateur ou Stripe) : trace durable sur la ligne (statut `release_failed`, repris par
 * reconcilePendingMonthlyLines) et log structuré pour l'alerte.
 */
// TODO(quota) : une ligne `release_failed` compte encore dans le quota de lignes de l'entreprise (countDocuments) tant que sa
// libération n'a pas abouti ; à exclure du décompte si cela gêne un client.
export async function markLineReleaseFailed(line, reason) {
  console.error(JSON.stringify({
    event: 'phone_line_release_failed',
    lineId: String(line._id),
    companyId: String(line.companyId),
    phoneNumber: line.phoneNumber,
    subscriptionId: line.stripeSubscriptionId || null,
    reason: String(reason || 'unknown'),
  }));
  line.billingStatus = 'release_failed';
  try {
    await line.save();
  } catch (saveErr) {
    console.error(JSON.stringify({ event: 'phone_line_release_failed_unsaved', lineId: String(line._id), reason: saveErr.message }));
  }
  return line;
}

/**
 * Résilie l'abonnement Stripe d'une ligne mensuelle, tout de suite (CANCEL_LINE_SUBSCRIPTION_*). Idempotent : déjà résilié ou
 * inexistant côté Stripe = succès. Ne touche jamais une ligne historique (sans billingModel mensuel).
 * Lève si Stripe échoue pour une autre raison : l'appelant ne doit alors pas supprimer la ligne.
 */
export async function cancelLineSubscription(line) {
  if (!line || line.billingModel !== BILLING_MODEL_MONTHLY) return { canceled: false, skipped: true };
  // Posé AVANT l'appel : le webhook customer.subscription.deleted qui suit ne doit pas traiter cette résiliation comme un impayé.
  if (!line.subscriptionCanceledAt) {
    line.subscriptionCanceledAt = new Date();
    await line.save();
  }
  let ids = line.stripeSubscriptionId ? [line.stripeSubscriptionId] : [];
  if (!ids.length && stripeService.isConfigured()) {
    // Id non enregistré (crash, échec d'écriture) : on retrouve l'éventuel abonnement orphelin par metadata.phoneNumberId.
    try {
      ids = await stripeService.findPhoneLineSubscriptionIds(String(line._id));
    } catch (searchErr) {
      console.warn(`[phoneLine] recherche d'abonnement orphelin impossible (${line._id}): ${searchErr.message}`);
    }
  }
  for (const id of ids) {
    try {
      await stripeService.cancelPhoneLineSubscription(id, {
        prorate: CANCEL_LINE_SUBSCRIPTION_PRORATE,
        invoiceNow: CANCEL_LINE_SUBSCRIPTION_INVOICE_NOW,
      });
    } catch (err) {
      const alreadyGone = err?.code === 'resource_missing' || err?.statusCode === 404 || /no such subscription/i.test(String(err?.message));
      if (!alreadyGone) throw err;
    }
  }
  return { canceled: ids.length > 0, skipped: false };
}

/** Ligne portant cet abonnement Stripe, ou à défaut celle désignée par la métadonnée `phoneNumberId`. */
async function findLineBySubscription(subscriptionId, metadata) {
  if (subscriptionId) {
    const line = await PhoneNumber.findOne({ stripeSubscriptionId: String(subscriptionId), billingModel: BILLING_MODEL_MONTHLY });
    if (line) return line;
  }
  if (metadata?.kind === PHONE_LINE_SUBSCRIPTION_KIND && metadata.phoneNumberId && !subscriptionId) {
    return PhoneNumber.findOne({ _id: metadata.phoneNumberId, billingModel: BILLING_MODEL_MONTHLY });
  }
  return null;
}

/** Id d'abonnement d'une facture Stripe, quelle que soit la version d'API (`subscription` ou `parent.subscription_details`). */
export function subscriptionIdFromInvoice(invoice) {
  const direct = invoice?.subscription;
  const nested = invoice?.parent?.subscription_details?.subscription;
  const id = direct || nested || null;
  return id && typeof id === 'object' ? id.id || null : id;
}

function invoiceSubscriptionMetadata(invoice) {
  return invoice?.parent?.subscription_details?.metadata || invoice?.subscription_details?.metadata || null;
}

/**
 * Impayé : suspension immédiate de la ligne + un mois de grâce avant résiliation (terminateSuspendedLines).
 * Idempotent : un webhook rejoué, ou une nouvelle tentative de prélèvement, ne repousse pas la date de résiliation.
 */
export async function markLineSubscriptionFailed(subscriptionId, { metadata = null, reason = 'payment_failed', now = new Date() } = {}) {
  const line = await findLineBySubscription(subscriptionId, metadata);
  if (!line) return { handled: false, reason: 'no_line' };
  if (line.subscriptionCanceledAt) return { handled: false, reason: 'canceled_by_us' };
  if (['suspended', 'payment_failed', 'terminated'].includes(line.billingStatus)) {
    return { handled: false, reason: 'already_suspended', lineId: String(line._id) };
  }
  line.billingStatus = 'suspended';
  line.paymentFailedAt = now;
  line.suspendedAt = now;
  line.terminatesAt = new Date(now.getTime() + SUSPENSION_GRACE_MS);
  await line.save();
  console.warn(`[phoneLineBilling] line ${line.phoneNumber} suspended (${reason})`);
  return { handled: true, lineId: String(line._id) };
}

/** L'abonnement Stripe est-il vivant (active / trialing) ? Introuvable = mort ; toute autre erreur Stripe remonte (Stripe rejouera). */
async function isSubscriptionAlive(subscriptionId) {
  if (!subscriptionId) return false; // pas d'id enregistré : pas d'abonnement vivant (jamais d'appel Stripe sans id)
  try {
    const sub = await stripeService.getSubscription(subscriptionId);
    return ACTIVE_OFFER_STATUSES.includes(sub?.status);
  } catch (err) {
    if (err?.code === 'resource_missing' || err?.statusCode === 404 || /no such subscription/i.test(String(err?.message))) return false;
    throw err;
  }
}

/**
 * Paiement régularisé pendant le mois de grâce : la ligne est réactivée (REACTIVATE_LINE_ON_REGULARIZATION), mais SEULEMENT si
 * son abonnement Stripe est vivant. Sinon (annulé entre-temps) un nouvel abonnement est créé, et la ligne n'est réactivée
 * que s'il l'est. Idempotent.
 */
export async function reactivateLineSubscription(subscriptionId, { metadata = null, now = new Date() } = {}) {
  if (!REACTIVATE_LINE_ON_REGULARIZATION) return { handled: false, reason: 'disabled' };
  const line = await findLineBySubscription(subscriptionId, metadata);
  if (!line) return { handled: false, reason: 'no_line' };
  if (line.subscriptionCanceledAt) return { handled: false, reason: 'canceled_by_us' };
  if (!['suspended', 'payment_failed'].includes(line.billingStatus)) {
    return { handled: false, reason: 'not_suspended', lineId: String(line._id) };
  }
  if (!(await isSubscriptionAlive(line.stripeSubscriptionId))) {
    const cents = Math.round(Number(line.price) * 100);
    if (!(cents > 0)) {
      console.error(JSON.stringify({ event: 'phone_line_reactivation_no_price', lineId: String(line._id) }));
      return { handled: false, reason: 'no_price', lineId: String(line._id) };
    }
    const oldId = line.stripeSubscriptionId;
    line.stripeSubscriptionId = null;
    try {
      await startMonthlyLineSubscription({ line, amountCents: cents, currency: line.currency || 'EUR', now, idempotencyKey: `phone-line-sub-${line._id}-after-${oldId}` });
    } catch (err) {
      line.stripeSubscriptionId = oldId;
      console.error(JSON.stringify({ event: 'phone_line_reactivation_resubscribe_failed', lineId: String(line._id), reason: err.message }));
      return { handled: false, reason: 'resubscribe_failed', lineId: String(line._id) };
    }
  }
  line.billingStatus = 'active';
  line.paymentFailedAt = null;
  line.suspendedAt = null;
  line.terminatesAt = null;
  await line.save();
  console.log(`[phoneLineBilling] line ${line.phoneNumber} reactivated (payment regularized)`);
  return { handled: true, lineId: String(line._id) };
}

/** Événements Stripe `invoice.*` : facture d'une ligne mensuelle impayée ou régularisée. Ignore toute autre facture. */
export async function handlePhoneLineInvoiceEvent(type, invoice) {
  const subscriptionId = subscriptionIdFromInvoice(invoice);
  const metadata = invoiceSubscriptionMetadata(invoice);
  if (type === 'invoice.payment_failed') {
    return markLineSubscriptionFailed(subscriptionId, { metadata, reason: 'invoice.payment_failed' });
  }
  if (type === 'invoice.paid' || type === 'invoice.payment_succeeded') {
    return reactivateLineSubscription(subscriptionId, { metadata });
  }
  return { handled: false, reason: 'ignored_event' };
}

/** `customer.subscription.deleted` d'une ligne mensuelle que nous n'avons pas résiliée nous-mêmes : traité comme un impayé. */
export async function handlePhoneLineSubscriptionDeleted(subscription) {
  return markLineSubscriptionFailed(subscription?.id, {
    metadata: subscription?.metadata || null,
    reason: 'customer.subscription.deleted',
  });
}
