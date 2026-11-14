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

/** Client Stripe existant de l'entreprise (celui de son abonnement d'offre), s'il y en a un. */
export async function resolveCompanyStripeCustomerId(companyId) {
  const sub = await Subscription.findOne({
    companyId: String(companyId),
    provider: 'stripe',
    stripeCustomerId: { $exists: true, $nin: [null, '', 'paypal'] },
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
  const customerId = await resolveCompanyStripeCustomerId(companyId);
  if (!customerId) {
    throw codedError(
      'LINE_SUBSCRIPTION_NO_CUSTOMER',
      "Aucun moyen de paiement n'est enregistré sur votre abonnement : ajoutez-en un pour souscrire une ligne supplémentaire."
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
export async function startMonthlyLineSubscription({ line, amountCents, currency, now = new Date() }) {
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
      idempotencyKey: `phone-line-sub-${line._id}`,
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
  line.billingStatus = 'active';
  line.stripeSubscriptionId = subscription.id;
  line.paymentFailedAt = null;
  line.suspendedAt = null;
  line.terminatesAt = null;
  await line.save();
  return { subscriptionId: subscription.id, alreadyStarted: false };
}

/**
 * Résilie l'abonnement Stripe d'une ligne mensuelle, tout de suite (CANCEL_LINE_SUBSCRIPTION_*). Idempotent : déjà résilié ou
 * inexistant côté Stripe = succès. Ne touche jamais une ligne historique (sans billingModel mensuel).
 * Lève si Stripe échoue pour une autre raison : l'appelant ne doit alors pas supprimer la ligne.
 */
export async function cancelLineSubscription(line) {
  if (!line || line.billingModel !== BILLING_MODEL_MONTHLY || !line.stripeSubscriptionId) {
    return { canceled: false, skipped: true };
  }
  // Posé AVANT l'appel : le webhook customer.subscription.deleted qui suit ne doit pas traiter cette résiliation comme un impayé.
  if (!line.subscriptionCanceledAt) {
    line.subscriptionCanceledAt = new Date();
    await line.save();
  }
  try {
    await stripeService.cancelPhoneLineSubscription(line.stripeSubscriptionId, {
      prorate: CANCEL_LINE_SUBSCRIPTION_PRORATE,
      invoiceNow: CANCEL_LINE_SUBSCRIPTION_INVOICE_NOW,
    });
  } catch (err) {
    const alreadyGone = err?.code === 'resource_missing' || err?.statusCode === 404 || /no such subscription/i.test(String(err?.message));
    if (!alreadyGone) throw err;
  }
  return { canceled: true, skipped: false };
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

/** Paiement régularisé pendant le mois de grâce : la ligne est réactivée (REACTIVATE_LINE_ON_REGULARIZATION). Idempotent. */
export async function reactivateLineSubscription(subscriptionId, { metadata = null } = {}) {
  if (!REACTIVATE_LINE_ON_REGULARIZATION) return { handled: false, reason: 'disabled' };
  const line = await findLineBySubscription(subscriptionId, metadata);
  if (!line) return { handled: false, reason: 'no_line' };
  if (line.subscriptionCanceledAt) return { handled: false, reason: 'canceled_by_us' };
  if (!['suspended', 'payment_failed'].includes(line.billingStatus)) {
    return { handled: false, reason: 'not_suspended', lineId: String(line._id) };
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
