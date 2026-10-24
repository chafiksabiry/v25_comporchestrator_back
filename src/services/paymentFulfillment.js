import CompanyPayment from '../models/CompanyPayment.js';
import MinutesCompany from '../models/MinutesCompany.js';
import TokensCompany from '../models/TokensCompany.js';
import PhoneNumberPayment from '../models/PhoneNumberPayment.js';
import WalletCompany from '../models/WalletCompany.js';
import WalletCompanyEntry from '../models/WalletCompanyEntry.js';
import { notifyCompany } from './companyNotificationService.js';

export async function fulfillWalletDeposit(payment) {
  const euros = Number((payment.amount / 100).toFixed(2));

  let wallet = await WalletCompany.findOne({ companyId: payment.companyId });
  if (!wallet) {
    wallet = new WalletCompany({ companyId: payment.companyId, balance: 0 });
  }
  wallet.balance = Number((wallet.balance + euros).toFixed(2));
  await wallet.save();

  try {
    await WalletCompanyEntry.create({
      companyId: payment.companyId,
      type: 'deposit',
      direction: 'credit',
      amount: euros,
      balanceAfter: wallet.balance,
      status: 'completed',
      description: `Dépôt de ${euros.toFixed(2)} € via ${payment.provider}`,
      meta: {
        method: payment.provider,
        providerRef: payment.providerRef || null,
        paymentId: payment._id
      }
    });
  } catch (logErr) {
    console.warn('WalletCompanyEntry log failed (PayPal deposit):', logErr.message);
  }

  await notifyCompany({
    companyId: payment.companyId,
    key: `payment-${payment._id}`,
    kind: 'wallet',
    title: 'Dépôt crédité',
    message: `${euros.toFixed(2)} € ont été ajoutés à votre portefeuille. Nouveau solde : ${Number(wallet.balance).toFixed(2)} €.`,
    actionPath: '/dashboard/wallet',
  });

  return { balance: wallet.balance, credited: euros };
}

export async function fulfillMinutesPurchase(payment) {
  const minutes = Number(payment.quantity || 0);
  if (minutes <= 0) {
    throw new Error('Invalid minutes quantity on payment');
  }

  let wallet = await MinutesCompany.findOne({ companyId: payment.companyId });
  if (!wallet) {
    wallet = new MinutesCompany({ companyId: payment.companyId, minutes: 0 });
  }
  wallet.minutes = Number((wallet.minutes + minutes).toFixed(2));
  wallet.purchasedMinutes = Number(((wallet.purchasedMinutes || 0) + minutes).toFixed(2));
  await wallet.save();

  await notifyCompany({
    companyId: payment.companyId,
    key: `payment-${payment._id}`,
    kind: 'minutes',
    title: 'Minutes ajoutées',
    message: `${minutes.toLocaleString('fr-FR')} minutes d'appel ont été ajoutées. Total : ${wallet.minutes.toLocaleString('fr-FR')} min.`,
    actionPath: '/dashboard/minutes',
  });

  return {
    minutes: wallet.minutes,
    purchasedMinutes: wallet.purchasedMinutes,
    credited: minutes
  };
}

export async function fulfillTokensPurchase(payment) {
  const tokens = Math.round(Number(payment.quantity || 0));
  if (tokens <= 0) {
    throw new Error('Invalid tokens quantity on payment');
  }

  let wallet = await TokensCompany.findOne({ companyId: payment.companyId });
  if (!wallet) {
    wallet = new TokensCompany({ companyId: payment.companyId, tokens: 0 });
  }
  wallet.tokens = (wallet.tokens || 0) + tokens;
  wallet.purchasedTokens = (wallet.purchasedTokens || 0) + tokens;
  wallet.lastPurchasedAt = new Date();
  await wallet.save();

  await notifyCompany({
    companyId: payment.companyId,
    key: `payment-${payment._id}`,
    kind: 'tokens',
    title: 'Tokens AI ajoutés',
    message: `${tokens.toLocaleString('fr-FR')} tokens AI ont été ajoutés. Solde : ${wallet.tokens.toLocaleString('fr-FR')}.`,
    actionPath: '/dashboard/tokens',
  });

  return {
    tokens: wallet.tokens,
    purchasedTokens: wallet.purchasedTokens,
    lastPurchasedAt: wallet.lastPurchasedAt,
    credited: tokens
  };
}

/**
 * Fulfill a one-shot Stripe Checkout Session (mode='payment') from a webhook.
 * Dispatches by `session.metadata.purpose`:
 *   - 'phone_line'                 → PhoneNumberPayment (status only; provisioning runs later)
 *   - 'wallet_deposit'             → CompanyPayment + fulfillWalletDeposit
 *   - 'minutes_purchase'           → CompanyPayment + fulfillMinutesPurchase
 *   - 'tokens_purchase'            → CompanyPayment + fulfillTokensPurchase
 *   - anything else                → CompanyPayment fallback (purpose read from the row)
 * All branches are idempotent.
 */
export async function fulfillStripeCheckoutSessionPayment(session) {
  if (!session || session.mode !== 'payment') {
    return { skipped: true, reason: `not a payment-mode session (mode=${session?.mode})` };
  }
  if (session.payment_status !== 'paid' && session.status !== 'complete') {
    return { skipped: true, reason: `session not paid yet (status=${session.payment_status || session.status})` };
  }

  const purpose = session.metadata?.purpose;
  if (purpose === 'phone_line') {
    return fulfillStripePhoneLineSession(session);
  }
  return fulfillStripeCompanyPaymentSession(session);
}

/**
 * Fulfill a one-shot Stripe Checkout Session for a wallet deposit / minutes pack.
 * Stored in the `CompanyPayment` model.
 */
async function fulfillStripeCompanyPaymentSession(session) {
  const paymentIdMeta = session.metadata?.paymentId || session.client_reference_id;
  let payment = null;
  if (session.id) {
    payment = await CompanyPayment.findOne({ providerRef: session.id });
  }
  if (!payment && paymentIdMeta) {
    try {
      payment = await CompanyPayment.findById(paymentIdMeta);
    } catch {
      payment = null;
    }
  }
  if (!payment) {
    console.warn(`[payments] No CompanyPayment found for Stripe session ${session.id}`);
    return { skipped: true, reason: 'payment record not found' };
  }
  if (payment.fulfilledAt) {
    return { skipped: true, reason: 'already fulfilled', paymentId: String(payment._id) };
  }

  if (payment.status !== 'succeeded') {
    payment.status = 'succeeded';
  }
  payment.providerRef = session.id || payment.providerRef;
  await payment.save();

  let result;
  if (payment.purpose === 'wallet_deposit') {
    result = await fulfillWalletDeposit(payment);
  } else if (payment.purpose === 'minutes_purchase') {
    result = await fulfillMinutesPurchase(payment);
  } else if (payment.purpose === 'tokens_purchase') {
    result = await fulfillTokensPurchase(payment);
  } else {
    console.warn(`[payments] Unknown CompanyPayment purpose '${payment.purpose}' for payment ${payment._id}`);
    return { skipped: true, reason: `unknown purpose ${payment.purpose}` };
  }

  payment.fulfilledAt = new Date();
  await payment.save();

  console.log(
    `✅ One-time Stripe payment fulfilled: payment=${payment._id} purpose=${payment.purpose} session=${session.id}`
  );
  return { fulfilled: true, paymentId: String(payment._id), purpose: payment.purpose, result };
}

/**
 * Fulfill a one-shot Stripe Checkout Session for a phone-line setup fee.
 * Stored in the `PhoneNumberPayment` model. Marks the payment as succeeded;
 * the actual line provisioning is performed later by `purchaseTwilioNumber`,
 * which checks that a succeeded PhoneNumberPayment exists.
 */
export async function fulfillStripePhoneLineSession(session) {
  const paymentIdMeta = session.metadata?.paymentId || session.client_reference_id;
  let payment = null;
  if (session.id) {
    payment = await PhoneNumberPayment.findOne({ providerRef: session.id });
  }
  if (!payment && paymentIdMeta) {
    try {
      payment = await PhoneNumberPayment.findById(paymentIdMeta);
    } catch {
      payment = null;
    }
  }
  if (!payment) {
    console.warn(`[payments] No PhoneNumberPayment found for Stripe session ${session.id}`);
    return { skipped: true, reason: 'phone-line payment record not found' };
  }
  if (payment.status === 'succeeded') {
    return { skipped: true, reason: 'already succeeded', paymentId: String(payment._id) };
  }
  if (payment.status === 'refunded' || payment.status === 'failed') {
    return { skipped: true, reason: `payment is ${payment.status}`, paymentId: String(payment._id) };
  }
  if (payment.status === 'authorized' && session.payment_status !== 'paid') {
    return { skipped: true, reason: 'already authorized', paymentId: String(payment._id) };
  }

  // Phone lines use manual capture: checkout completion only authorizes the
  // card. The charge is captured after the number order succeeds.
  payment.status = session.payment_status === 'paid' ? 'succeeded' : 'authorized';
  payment.providerRef = session.id || payment.providerRef;
  await payment.save();

  console.log(
    payment.status === 'succeeded'
      ? `✅ Phone-line Stripe payment fulfilled: payment=${payment._id} phone=${payment.phoneNumber} session=${session.id}`
      : `✅ Phone-line Stripe payment authorized (not captured yet): payment=${payment._id} phone=${payment.phoneNumber} session=${session.id}`
  );
  return { fulfilled: payment.status === 'succeeded', authorized: payment.status === 'authorized', paymentId: String(payment._id), purpose: 'phone_line' };
}
