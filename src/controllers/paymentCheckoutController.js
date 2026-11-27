import { stripeLocaleFromRequest } from '../services/stripeLocale.js';
import { findCompanyStripeCustomerId } from '../services/billingCustomer.js';
import mongoose from 'mongoose';
import { guardCompanyAccess } from '../middleware/companyGuard.js';
import CompanyPayment from '../models/CompanyPayment.js';
import { paypalService } from '../services/paypalService.js';
import { stripeService } from '../services/stripeService.js';
import { fulfillCompanyPaymentOnce } from '../services/paymentFulfillment.js';
import { bundleAmountCents, bundleLabel, parseBundleQuantities } from '../services/bundlePurchase.js';
import { config } from '../config/env.js';
import { paypalCaptureId, paypalCaptureNotCompleted, paypalOrderMismatch, stripeSessionMismatch } from '../services/paymentVerification.js';
import { FALLBACK_PURCHASE_CURRENCY, formatAmountLabel, offerPurchaseCurrency } from '../services/purchaseCurrency.js';
import { blockCentsFor, minutePacksFor, MINUTE_BLOCK, NOMAD_INCLUDED_MINUTES, TRAVELER_DAYS, TRAVELER_INCLUDED_MINUTES, TRAVELER_NUMBER_COUNTRIES, TRAVELER_PRICE_CENTS, NOMAD_ACTIVE_COUNTRIES, NOMAD_SOON_COUNTRIES } from '../services/nomadOffers.js';
import {
  computeMinutesPurchaseCents,
  computeTokensPurchaseCents,
  getPlatformPricing,
} from '../config/minutesPricing.js';

// Le portefeuille (dépôt) reste en EUR : c'est le registre des commissions, pas un achat de produit.
const WALLET_CURRENCY = 'EUR';

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
  return config.publicApiBaseUrl;
}

function sanitizePaymentReturnUrl(url, fallback) {
  if (!url || typeof url !== 'string') return fallback;
  try {
    const parsed = new URL(url);
    const allowed = new Set([
      new URL(stripeReturnBase()).origin,
      'https://harx.ai',
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

async function computeAmountCents(purpose, { amountEuros, minutes, tokens, currency }) {
  if (purpose === 'wallet_deposit') {
    const euros = Number(amountEuros);
    if (!Number.isFinite(euros) || euros <= 0) return null;
    return Math.round(euros * 100);
  }
  if (purpose === 'minutes_purchase') {
    return computeMinutesPurchaseCents(minutes, currency);
  }
  if (purpose === 'tokens_purchase') {
    return computeTokensPurchaseCents(tokens);
  }
  if (purpose === 'bundle_purchase') {
    const qty = parseBundleQuantities({ minutes, tokens });
    if (!qty) return null;
    return bundleAmountCents(await computeMinutesPurchaseCents(qty.minutes, currency), await computeTokensPurchaseCents(qty.tokens));
  }
  return null;
}

export const paymentCheckoutController = {
  async getConfig(req, res) {
    try {
      const pricing = await getPlatformPricing();
      // `?companyId=` : devise de l'abonnement du client (mêmes montants dans les trois devises, décision du 26/11) ; sinon EUR.
      const currency = req.query?.companyId ? await offerPurchaseCurrency(req, req.query.companyId) : FALLBACK_PURCHASE_CURRENCY;
      res.json({
        success: true,
        paypal: {
          enabled: paypalService.isConfigured(),
          clientId: paypalService.getClientId(),
          mode: paypalService.getMode()
        },
        stripe: {
          enabled: stripeService.isConfigured(),
          /** 'test' ou 'live' (jamais la clé) : la recette doit répondre 'test'. */
          mode: stripeService.isConfigured() ? stripeService.getStripeMode() : null
        },
        /** Recharges de minutes : Stripe seulement (décision du 26/11 : pas de PayPal pour les minutes). */
        minutesProviders: ['stripe'],
        offers: {
          nomad: { includedMinutes: NOMAD_INCLUDED_MINUTES, numberCountries: NOMAD_ACTIVE_COUNTRIES, comingSoonCountries: NOMAD_SOON_COUNTRIES },
          traveler: { priceCents: TRAVELER_PRICE_CENTS, days: TRAVELER_DAYS, includedMinutes: TRAVELER_INCLUDED_MINUTES, numberCountries: TRAVELER_NUMBER_COUNTRIES, oneTime: true },
        },
        pricing: {
          currency,
          // Prix dans la devise du client : 30 min = 5 (€, $, £) ou 8 (dollar canadien).
          minuteBlock: { minutes: MINUTE_BLOCK.minutes, priceCents: blockCentsFor(currency) },
          minutePacks: minutePacksFor(currency),
          minutesCustomRateCents: blockCentsFor(currency) / MINUTE_BLOCK.minutes,
          minutesCustomRateEuros: blockCentsFor(currency) / MINUTE_BLOCK.minutes / 100,
          tokenPacks: pricing.tokenPacks,
          tokensCustomRateCents: pricing.tokensCustomRateCents,
          tokensCustomRateEuros: pricing.tokensCustomRateCents / 100,
        }
      });
    } catch (error) {
      console.error('[payments/checkout/config]', error.message);
      res.status(500).json({ error: 'Failed to load checkout config' });
    }
  },

  async initCheckout(req, res) {
    try {
      const { companyId, purpose, provider, amountEuros, minutes, tokens, returnUrl, apiBaseUrl } = req.body;

      if (!companyId || !mongoose.Types.ObjectId.isValid(companyId)) {
        return res.status(400).json({ error: 'Valid companyId is required' });
      }
      // On ne déclenche un paiement que pour SA société (propriétaire) : 403 avant toute création de paiement ou de session chez Stripe/PayPal.
      if (!(await guardCompanyAccess(req, res, companyId, { ownerOnly: true }))) return;
      if (!['wallet_deposit', 'minutes_purchase', 'tokens_purchase', 'bundle_purchase'].includes(purpose)) {
        return res.status(400).json({
          error: "purpose must be 'wallet_deposit', 'minutes_purchase', 'tokens_purchase' or 'bundle_purchase'"
        });
      }
      if (!['stripe', 'paypal'].includes(provider)) {
        return res.status(400).json({ error: "provider must be 'stripe' or 'paypal'" });
      }
      // Recharges de minutes (seules ou avec des jetons) : Stripe seulement (décision du fondateur du 26/11/2026).
      if (provider !== 'stripe' && (purpose === 'minutes_purchase' || purpose === 'bundle_purchase')) {
        return res.status(400).json({ error: 'stripe_only', code: 'STRIPE_ONLY_FOR_MINUTES', message: 'Les minutes s’achètent par carte (Stripe) uniquement.' });
      }

      const currency = purpose === 'wallet_deposit' ? WALLET_CURRENCY : await offerPurchaseCurrency(req, companyId);
      const amountCents = await computeAmountCents(purpose, { amountEuros, minutes, tokens, currency });
      if (amountCents == null || amountCents <= 0) {
        // Minutes : par tranche de 30 min seulement (30, 60, 90…).
        return res.status(400).json({ error: 'Invalid amount, minutes or tokens quantity', ...(purpose === 'minutes_purchase' || purpose === 'bundle_purchase' ? { code: 'MINUTES_BLOCK_REQUIRED', blockMinutes: MINUTE_BLOCK.minutes } : {}) });
      }

      const quantity =
        purpose === 'minutes_purchase'
          ? Number(minutes)
          : purpose === 'tokens_purchase'
            ? Number(tokens)
            : Number(amountEuros);

      const bundle = purpose === 'bundle_purchase' ? parseBundleQuantities({ minutes, tokens }) : null;
      const payment = await CompanyPayment.create({
        companyId: new mongoose.Types.ObjectId(companyId),
        purpose,
        provider,
        amount: amountCents,
        currency,
        quantity:
          purpose === 'minutes_purchase' || purpose === 'tokens_purchase'
            ? quantity
            : undefined,
        ...(bundle ? { meta: { minutes: bundle.minutes, tokens: bundle.tokens } } : {}),
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
            ? `HARX — Crédit portefeuille ${formatAmountLabel(amountCents, currency)}`
            : purpose === 'bundle_purchase'
              ? bundleLabel(bundle)
              : purpose === 'tokens_purchase'
                ? `HARX — ${quantity.toLocaleString('fr-FR')} tokens AI`
                : `HARX — ${quantity} minutes d'appel`;

        const paypalOrder = await paypalService.createOrder({
          amountCents,
          currency,
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
            ? `HARX — Crédit portefeuille ${formatAmountLabel(amountCents, currency)}`
            : purpose === 'bundle_purchase'
              ? bundleLabel(bundle)
              : purpose === 'tokens_purchase'
                ? `HARX — ${quantity.toLocaleString('fr-FR')} tokens AI`
                : `HARX — ${quantity} minutes d'appel`;

        try {
          const session = await stripeService.createOneShotCheckoutSession({
            amountCents,
            currency,
            productName,
            successUrl,
            cancelUrl,
            clientReferenceId: payment._id,
            customerId: await findCompanyStripeCustomerId(companyId),
            locale: stripeLocaleFromRequest(req),
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

  /**
   * POST /api/nomad/traveler/checkout/init { companyId, chosenNumber: { phoneNumber }, currency?, returnUrl? } — NOMAD Traveler :
   * paiement UNIQUE Stripe (mode payment, jamais d'abonnement ni de PayPal), 9,99 dans la devise choisie (€, $, £ : même chiffre).
   * Gardes avant toute création de paiement : propriétaire de SA société, aucun abonnement NOMAD/Traveler en cours, identité vérifiée,
   * pièces de voyage conformes, numéro d'un pays Traveler encore disponible. Confirmation : POST /api/payments/checkout/confirm.
   */
  async initTravelerCheckout(req, res) {
    try {
      const { companyId, chosenNumber, currency: askedCurrency, returnUrl, apiBaseUrl } = req.body || {};
      if (!companyId || !mongoose.Types.ObjectId.isValid(companyId)) return res.status(400).json({ error: 'Valid companyId is required', code: 'INVALID_COMPANY' });
      const access = await guardCompanyAccess(req, res, companyId, { ownerOnly: true });
      if (!access) return;
      const traveler = await import('../services/nomadTraveler.js');
      const gate = await traveler.travelerPaymentGate(companyId, { chosenNumber });
      if (!gate.ok) return res.status(gate.status).json(gate.body);
      const availability = await traveler.travelerNumberAvailable(gate.chosen.phoneNumber);
      if (availability.unknown) return res.status(503).json({ error: 'NUMBER_CHECK_UNAVAILABLE', code: 'NUMBER_CHECK_UNAVAILABLE', retryable: true });
      if (!availability.available) return res.status(409).json({ error: 'NUMBER_NO_LONGER_AVAILABLE', code: 'NUMBER_NO_LONGER_AVAILABLE' });
      if (!stripeService.isConfigured()) return res.status(503).json({ error: 'Stripe not configured', code: 'STRIPE_UNAVAILABLE' });
      const currency = traveler.travelerCurrency(askedCurrency, await offerPurchaseCurrency(req, companyId));
      const payment = await CompanyPayment.create({
        companyId: new mongoose.Types.ObjectId(companyId),
        purpose: 'traveler_purchase',
        provider: 'stripe',
        amount: TRAVELER_PRICE_CENTS,
        currency,
        status: 'pending',
        meta: { userId: String(access.userId), companyId: String(companyId), chosenNumber: gate.chosen, offer: 'nomad_traveler', days: TRAVELER_DAYS },
      });
      const returnBase = stripeReturnBase();
      const returnTo = sanitizePaymentReturnUrl(returnUrl, `${returnBase}/`);
      const apiBase = ((apiBaseUrl && String(apiBaseUrl)) || publicApiBase()).replace(/\/$/, '');
      const successQuery = new URLSearchParams({ paymentId: String(payment._id), flow: 'payment', returnTo, apiBase });
      try {
        const session = await stripeService.createOneShotCheckoutSession({
          amountCents: TRAVELER_PRICE_CENTS,
          currency,
          productName: `NOMAD Traveler — ${TRAVELER_DAYS} jours`,
          successUrl: `${returnBase}/stripe-return.html?${successQuery.toString()}&session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${returnBase}/stripe-cancel.html?paymentId=${payment._id}&returnTo=${encodeURIComponent(returnTo)}`,
          clientReferenceId: payment._id,
          customerId: await findCompanyStripeCustomerId(companyId),
          locale: stripeLocaleFromRequest(req),
          metadata: { purpose: 'traveler_purchase', companyId: String(companyId), paymentId: String(payment._id) },
        });
        payment.providerRef = session.id;
        payment.checkoutUrl = session.url;
        await payment.save();
        return res.status(201).json({ success: true, paymentId: payment._id, checkoutUrl: session.url, amount: TRAVELER_PRICE_CENTS, currency, provider: 'stripe' });
      } catch (stripeErr) {
        await CompanyPayment.findByIdAndDelete(payment._id);
        console.error('[nomad-traveler] Stripe :', stripeErr.message);
        return res.status(502).json({ error: 'Stripe checkout creation failed', code: 'STRIPE_CHECKOUT_FAILED' });
      }
    } catch (error) {
      console.error('[nomad-traveler/checkout/init]', error?.message || error);
      return res.status(500).json({ error: 'Failed to initialize checkout' });
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

      // Route anonyme : la réponse ne porte jamais le document paiement (société, référence, lien) ni de solde.
      const done = () => res.status(200).json({ success: true, status: payment.status, purpose: payment.purpose });

      if (payment.status === 'succeeded') {
        await fulfillCompanyPaymentOnce(payment);
        return done();
      }
      if (payment.status === 'failed' || payment.status === 'refunded' || payment.status === 'review') {
        return res.status(409).json({ error: `Payment is already ${payment.status}` });
      }

      if (payment.provider === 'paypal') {
        // La commande est celle créée pour CE paiement : jamais un identifiant imposé par le client (capturer la commande d'un autre).
        const orderId = payment.providerRef;
        if (!orderId) {
          return res.status(400).json({ error: 'PayPal order ID is missing on this payment' });
        }
        if (providerRef && providerRef !== orderId) {
          console.warn(`[payments/checkout/confirm] commande PayPal étrangère refusée pour le paiement ${payment._id}`);
          return res.status(400).json({ error: 'PayPal order does not belong to this payment' });
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

        // Capture non terminée (ex. paiement en attente) : rien n'est crédité, le paiement reste « pending » pour une confirmation ultérieure.
        if (paypalCaptureNotCompleted(capture)) {
          return res.status(402).json({ error: 'PayPal capture not completed' });
        }
        // L'argent EST capturé ici : un contrôle en échec ne doit pas le laisser sans trace. Statut dédié « review » (plus de recapture, plus de
        // crédit), alerte explicite avec la commande et la capture ; à traiter à la main (voir la PR : remboursement).
        const orderMismatch = paypalOrderMismatch(capture, payment);
        if (orderMismatch) {
          const captureId = paypalCaptureId(capture);
          console.error(`[ALERT][payments] PayPal CAPTURED but NOT credited, manual review needed: payment=${payment._id} order=${orderId} capture=${captureId} reason=${orderMismatch}`);
          payment.status = 'review';
          payment.failureReason = orderMismatch;
          payment.meta = { ...(payment.meta || {}), review: { captureId, orderId, reason: orderMismatch, at: new Date().toISOString() } };
          await payment.save();
          return res.status(409).json({ error: 'Payment held for review' });
        }

        payment.status = 'succeeded';
        payment.providerRef = orderId;
        await payment.save();
      } else if (payment.provider === 'stripe') {
        // La session est celle créée pour CE paiement : jamais un identifiant imposé par le client (payer peu, créditer beaucoup).
        const sessionId = payment.providerRef;
        if (!sessionId) {
          return res.status(400).json({ error: 'Stripe session ID is missing on this payment' });
        }
        if (providerRef && providerRef !== sessionId) {
          console.warn(`[payments/checkout/confirm] session Stripe étrangère refusée pour le paiement ${payment._id}`);
          return res.status(400).json({ error: 'Stripe session does not belong to this payment' });
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

        if (session.payment_status !== 'paid') {
          return res.status(402).json({
            error: 'Stripe payment not completed',
            message: `Session status: ${session.payment_status || session.status}`
          });
        }
        // Même paiement, même montant, même devise : sinon rien n'est crédité.
        const sessionMismatch = stripeSessionMismatch(session, payment);
        if (sessionMismatch) {
          console.warn(`[payments/checkout/confirm] session Stripe refusée pour le paiement ${payment._id} : ${sessionMismatch}`);
          return res.status(409).json({ error: 'Stripe session does not match this payment' });
        }

        payment.status = 'succeeded';
        payment.providerRef = session.id;
        await payment.save();
      } else {
        // Fournisseur inconnu : jamais marqué réussi sans vérification.
        return res.status(400).json({ error: 'Unsupported payment provider' });
      }

      await fulfillCompanyPaymentOnce(payment);
      return done();
    } catch (error) {
      console.error('[payments/checkout/confirm]', error);
      res.status(500).json({ error: 'Failed to confirm checkout' });
    }
  }
};
