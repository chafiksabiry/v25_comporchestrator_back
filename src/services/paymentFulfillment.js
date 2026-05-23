import CompanyPayment from '../models/CompanyPayment.js';
import MinutesCompany from '../models/MinutesCompany.js';
import WalletCompany from '../models/WalletCompany.js';
import WalletCompanyEntry from '../models/WalletCompanyEntry.js';

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

  return {
    minutes: wallet.minutes,
    purchasedMinutes: wallet.purchasedMinutes,
    credited: minutes
  };
}

/**
 * Fulfill a one-shot Stripe Checkout Session (mode='payment') from a webhook.
 * Idempotent: if the matching CompanyPayment is already fulfilled, returns early.
 * Looks the payment up by providerRef = session.id, then by metadata.paymentId.
 */
export async function fulfillStripeCheckoutSessionPayment(session) {
  if (!session || session.mode !== 'payment') {
    return { skipped: true, reason: `not a payment-mode session (mode=${session?.mode})` };
  }
  if (session.payment_status !== 'paid' && session.status !== 'complete') {
    return { skipped: true, reason: `session not paid yet (status=${session.payment_status || session.status})` };
  }

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
  } else {
    console.warn(`[payments] Unknown purpose '${payment.purpose}' for payment ${payment._id}`);
    return { skipped: true, reason: `unknown purpose ${payment.purpose}` };
  }

  payment.fulfilledAt = new Date();
  await payment.save();

  console.log(
    `✅ One-time Stripe payment fulfilled: payment=${payment._id} purpose=${payment.purpose} session=${session.id}`
  );
  return { fulfilled: true, paymentId: String(payment._id), purpose: payment.purpose, result };
}
