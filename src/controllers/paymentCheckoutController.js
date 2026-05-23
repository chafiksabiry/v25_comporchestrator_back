import mongoose from 'mongoose';
import CompanyPayment from '../models/CompanyPayment.js';
import { paypalService } from '../services/paypalService.js';
import { stripeService } from '../services/stripeService.js';
import { fulfillMinutesPurchase, fulfillWalletDeposit } from '../services/paymentFulfillment.js';

const CURRENCY = (process.env.PAYMENT_CURRENCY || 'EUR').toUpperCase();
const MINUTES_UNIT_PRICE_CENTS = parseInt(process.env.MINUTES_UNIT_PRICE_CENTS || '100', 10); // 1 min = 1 €

function paypalReturnBase() {
  return (
    process.env.PAYPAL_RETURN_BASE_URL
    || 'https://harxv25comporchestratorfront.netlify.app'
  ).replace(/\/$/, '');
}

// Static return pages for Stripe live on the same Netlify host as PayPal pages.
function stripeReturnBase() {
  return (
    process.env.STRIPE_RETURN_BASE_URL
    || process.env.PAYPAL_RETURN_BASE_URL
    || 'https://harxv25comporchestratorfront.netlify.app'
  ).replace(/\/$/, '');
}

// Public API base URL injected into the Stripe success URL so that
// stripe-return.html can call back to the orchestrator's /payments/checkout/confirm.
function publicApiBase() {
  return (
    process.env.PUBLIC_API_BASE_URL
    || process.env.API_BASE_URL
    || 'https://harxv25comporchestrator.up.railway.app/api'
  ).replace(/\/$/, '');
}

function sanitizePaymentReturnUrl(url, fallback) {
  if (!url || typeof url !== 'string') return fallback;
  try {
    const parsed = new URL(url);
    const allowed = new Set([
      new URL(stripeReturnBase()).origin,
      'https://harx25pageslinks.netlify.app',
      'http://localhost:5183',
      'http://127.0.0.1:5183',
      'http://localhost:3000',
    ]);
    if (process.env.STRIPE_RETURN_ALLOWED_ORIGINS) {
      process.env.STRIPE_RETURN_ALLOWED_ORIGINS.split(',').forEach((o) => {
        const trimmed = o.trim();
        if (!trimmed) return;
        try {
          const origin = trimmed.startsWith('http')
            ? new URL(trimmed).origin
            : new URL(`https://${trimmed}`).origin;
          allowed.add(origin);
        } catch {
          /* skip invalid entry */
        }
      });
    }
    if (allowed.has(parsed.origin)) return url;
  } catch {
    /* invalid URL */
  }
  return fallback;
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
        enabled: stripeService.isConfigured()
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
      const { companyId, purpose, provider, amountEuros, minutes, returnUrl, apiBaseUrl } = req.body;

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
      } else if (provider === 'stripe') {
        if (!stripeService.isConfigured()) {
          await CompanyPayment.findByIdAndDelete(payment._id);
          return res.status(503).json({
            error: 'Stripe not configured',
            message: 'Définissez STRIPE_SECRET_KEY sur le serveur.'
          });
        }

        const returnBase = stripeReturnBase();
        const returnTo = sanitizePaymentReturnUrl(returnUrl, `${returnBase}/`);
        const apiBase = ((apiBaseUrl && String(apiBaseUrl)) || publicApiBase()).replace(/\/$/, '');
        const successQuery = new URLSearchParams({
          paymentId: String(payment._id),
          flow: 'payment',
          returnTo,
          apiBase
        });
        const successUrl = `${returnBase}/stripe-return.html?${successQuery.toString()}&session_id={CHECKOUT_SESSION_ID}`;
        const cancelUrl = `${returnBase}/stripe-cancel.html?paymentId=${payment._id}&returnTo=${encodeURIComponent(returnTo)}`;

        const productName =
          purpose === 'wallet_deposit'
            ? `HARX — Crédit portefeuille ${(amountCents / 100).toFixed(2)} €`
            : `HARX — ${quantity} minutes d'appel`;

        try {
          const session = await stripeService.createOneShotCheckoutSession({
            amountCents,
            currency: CURRENCY,
            productName,
            successUrl,
            cancelUrl,
            clientReferenceId: payment._id,
            metadata: { purpose, companyId: String(companyId) }
          });

          checkoutUrl = session.url;
          payment.providerRef = session.id;
          payment.checkoutUrl = checkoutUrl;
          await payment.save();
        } catch (stripeErr) {
          await CompanyPayment.findByIdAndDelete(payment._id);
          console.error('[payments/checkout/init] Stripe error:', stripeErr.message);
          return res.status(502).json({
            error: 'Stripe checkout creation failed',
            message: stripeErr.message
          });
        }
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
      } else if (payment.provider === 'stripe') {
        const sessionId = providerRef || payment.providerRef;
        if (!sessionId) {
          return res.status(400).json({ error: 'Stripe session ID (providerRef) is required' });
        }

        let session;
        try {
          session = await stripeService.retrieveSession(sessionId);
        } catch (stripeErr) {
          payment.status = 'failed';
          payment.failureReason = stripeErr.message;
          await payment.save();
          return res.status(502).json({
            error: 'Stripe session retrieval failed',
            message: stripeErr.message
          });
        }

        if (session.payment_status !== 'paid' && session.status !== 'complete') {
          return res.status(402).json({
            error: 'Stripe payment not completed',
            message: `Session status: ${session.payment_status || session.status}`
          });
        }

        payment.status = 'succeeded';
        payment.providerRef = session.id;
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
