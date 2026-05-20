import mongoose from 'mongoose';
import CompanyPayment from '../models/CompanyPayment.js';
import { paypalService } from '../services/paypalService.js';
import { fulfillMinutesPurchase, fulfillWalletDeposit } from '../services/paymentFulfillment.js';

const CURRENCY = (process.env.PAYMENT_CURRENCY || 'EUR').toUpperCase();
const MINUTES_UNIT_PRICE_CENTS = parseInt(process.env.MINUTES_UNIT_PRICE_CENTS || '100', 10); // 1 min = 1 €

function paypalReturnBase() {
  return (
    process.env.PAYPAL_RETURN_BASE_URL
    || 'https://harxv25comporchestratorfront.netlify.app'
  ).replace(/\/$/, '');
}

function computeAmountCents(purpose, { amountEuros, minutes }) {
  if (purpose === 'wallet_deposit') {
    const euros = Number(amountEuros);
    if (!Number.isFinite(euros) || euros <= 0) return null;
    return Math.round(euros * 100);
  }
  if (purpose === 'minutes_purchase') {
    const qty = Number(minutes);
    if (!Number.isFinite(qty) || qty <= 0) return null;
    return Math.round(qty * MINUTES_UNIT_PRICE_CENTS);
  }
  return null;
}

async function fulfillPayment(payment) {
  if (payment.fulfilledAt) {
    if (payment.purpose === 'wallet_deposit') {
      const wallet = await import('../models/WalletCompany.js').then((m) =>
        m.default.findOne({ companyId: payment.companyId })
      );
      return { purpose: payment.purpose, data: { balance: wallet?.balance ?? 0 } };
    }
    const mins = await import('../models/MinutesCompany.js').then((m) =>
      m.default.findOne({ companyId: payment.companyId })
    );
    return {
      purpose: payment.purpose,
      data: { minutes: mins?.minutes ?? 0, purchasedMinutes: mins?.purchasedMinutes ?? 0 }
    };
  }

  let result;
  if (payment.purpose === 'wallet_deposit') {
    result = await fulfillWalletDeposit(payment);
  } else if (payment.purpose === 'minutes_purchase') {
    result = await fulfillMinutesPurchase(payment);
  } else {
    throw new Error(`Unknown payment purpose: ${payment.purpose}`);
  }

  payment.fulfilledAt = new Date();
  await payment.save();
  return { purpose: payment.purpose, data: result };
}

export const paymentCheckoutController = {
  getConfig(req, res) {
    res.json({
      success: true,
      paypal: {
        enabled: paypalService.isConfigured(),
        clientId: paypalService.getClientId(),
        mode: paypalService.getMode()
      },
      stripe: {
        enabled: Boolean(process.env.STRIPE_SECRET_KEY)
      },
      pricing: {
        currency: CURRENCY,
        minutesUnitPriceCents: MINUTES_UNIT_PRICE_CENTS,
        minutesUnitPriceEuros: MINUTES_UNIT_PRICE_CENTS / 100
      }
    });
  },

  async initCheckout(req, res) {
    try {
      const { companyId, purpose, provider, amountEuros, minutes } = req.body;

      if (!companyId || !mongoose.Types.ObjectId.isValid(companyId)) {
        return res.status(400).json({ error: 'Valid companyId is required' });
      }
      if (!['wallet_deposit', 'minutes_purchase'].includes(purpose)) {
        return res.status(400).json({ error: "purpose must be 'wallet_deposit' or 'minutes_purchase'" });
      }
      if (!['stripe', 'paypal'].includes(provider)) {
        return res.status(400).json({ error: "provider must be 'stripe' or 'paypal'" });
      }

      const amountCents = computeAmountCents(purpose, { amountEuros, minutes });
      if (amountCents == null || amountCents <= 0) {
        return res.status(400).json({ error: 'Invalid amount or minutes quantity' });
      }

      const quantity =
        purpose === 'minutes_purchase' ? Number(minutes) : Number(amountEuros);

      const payment = await CompanyPayment.create({
        companyId: new mongoose.Types.ObjectId(companyId),
        purpose,
        provider,
        amount: amountCents,
        currency: CURRENCY,
        quantity: purpose === 'minutes_purchase' ? quantity : undefined,
        status: 'pending'
      });

      let paypalOrderId;
      let paypalApproveUrl;
      let checkoutUrl;

      if (provider === 'paypal') {
        if (!paypalService.isConfigured()) {
          await CompanyPayment.findByIdAndDelete(payment._id);
          return res.status(503).json({
            error: 'PayPal not configured',
            message: 'Définissez PAYPAL_CLIENT_ID et PAYPAL_CLIENT_SECRET sur le serveur.'
          });
        }

        const returnBase = paypalReturnBase();
        const returnUrl = `${returnBase}/paypal-return.html?paymentId=${payment._id}`;
        const cancelUrl = `${returnBase}/paypal-cancel.html?paymentId=${payment._id}`;

        const label =
          purpose === 'wallet_deposit'
            ? `HARX — Crédit portefeuille ${(amountCents / 100).toFixed(2)} €`
            : `HARX — ${quantity} minutes d'appel`;

        const paypalOrder = await paypalService.createOrder({
          amountCents,
          currency: CURRENCY,
          description: label,
          customId: payment._id,
          returnUrl,
          cancelUrl
        });

        paypalOrderId = paypalOrder.id;
        paypalApproveUrl = paypalOrder.approveUrl;
        if (!paypalApproveUrl) {
          await CompanyPayment.findByIdAndDelete(payment._id);
          return res.status(502).json({
            error: 'PayPal order missing approval URL',
            message: "La commande PayPal n'a pas pu être créée."
          });
        }

        payment.providerRef = paypalOrderId;
        payment.checkoutUrl = paypalApproveUrl;
        await payment.save();
      } else if (provider === 'stripe' && process.env.STRIPE_SECRET_KEY) {
        checkoutUrl = undefined; // TODO: Stripe Checkout Session
      } else if (provider === 'stripe') {
        checkoutUrl = `internal://stub-checkout/${payment._id}`;
        payment.checkoutUrl = checkoutUrl;
        await payment.save();
      }

      res.status(201).json({
        success: true,
        paymentId: payment._id,
        purpose: payment.purpose,
        amount: payment.amount,
        amountEuros: amountCents / 100,
        currency: payment.currency,
        quantity: payment.quantity,
        provider: payment.provider,
        checkoutUrl,
        paypalOrderId,
        paypalApproveUrl,
        paypalMode: provider === 'paypal' ? paypalService.getMode() : undefined
      });
    } catch (error) {
      const code = error?.code;
      const message = error?.message || 'Failed to initialize checkout';

      if (
        code === 'PAYPAL_NOT_CONFIGURED'
        || code === 'PAYPAL_INVALID_CREDENTIALS'
        || code === 'PAYPAL_AUTH_FAILED'
      ) {
        return res.status(503).json({ error: 'PayPal authentication failed', message });
      }

      console.error('[payments/checkout/init]', message);
      res.status(500).json({ error: 'Failed to initialize checkout', message });
    }
  },

  async confirmCheckout(req, res) {
    try {
      const { paymentId, providerRef } = req.body;
      if (!paymentId || !mongoose.Types.ObjectId.isValid(paymentId)) {
        return res.status(400).json({ error: 'Valid paymentId is required' });
      }

      const payment = await CompanyPayment.findById(paymentId);
      if (!payment) {
        return res.status(404).json({ error: 'Payment not found' });
      }

      if (payment.status === 'succeeded') {
        const fulfillment = await fulfillPayment(payment);
        return res.status(200).json({ success: true, payment, fulfillment });
      }
      if (payment.status === 'failed' || payment.status === 'refunded') {
        return res.status(409).json({ error: `Payment is already ${payment.status}` });
      }

      if (payment.provider === 'paypal') {
        const orderId = providerRef || payment.providerRef;
        if (!orderId) {
          return res.status(400).json({ error: 'PayPal order ID (providerRef) is required' });
        }

        let capture;
        try {
          capture = await paypalService.captureOrder(orderId);
        } catch (paypalErr) {
          const detail = paypalErr?.message || 'PayPal capture failed';
          if (paypalErr?.code !== 'PAYPAL_NOT_APPROVED') {
            payment.status = 'failed';
            payment.failureReason = detail;
            await payment.save();
          }
          return res.status(402).json({
            error: paypalErr?.code === 'PAYPAL_NOT_APPROVED' ? 'PayPal not approved' : 'PayPal capture failed',
            message: detail
          });
        }

        if (capture.status !== 'COMPLETED') {
          return res.status(402).json({
            error: 'PayPal payment not completed',
            message: `Order status: ${capture.status}`
          });
        }

        payment.status = 'succeeded';
        payment.providerRef = orderId;
        await payment.save();
      } else {
        payment.status = 'succeeded';
        if (providerRef) payment.providerRef = providerRef;
        await payment.save();
      }

      const fulfillment = await fulfillPayment(payment);
      res.json({ success: true, payment, fulfillment });
    } catch (error) {
      console.error('[payments/checkout/confirm]', error);
      res.status(500).json({ error: 'Failed to confirm checkout', message: error.message });
    }
  }
};
