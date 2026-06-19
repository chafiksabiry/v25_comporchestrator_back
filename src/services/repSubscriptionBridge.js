import axios from 'axios';
import { SubscriptionPlan } from '../models/SubscriptionPlan.js';
import { stripeService } from './stripeService.js';

function repsWizardApiBase() {
  const raw =
    process.env.REPS_WIZARD_API_URL
    || process.env.REP_WIZARD_API_URL
    || process.env.VITE_REP_API_URL
    || '';
  return String(raw).replace(/\/$/, '').replace(/\/api$/, '');
}

function internalSecret() {
  return process.env.REPS_STRIPE_INTERNAL_SECRET || process.env.HARX_INTERNAL_API_SECRET || '';
}

async function postInternal(path, body) {
  const base = repsWizardApiBase();
  const secret = internalSecret();
  if (!base || !secret) {
    console.warn('[repSubscriptionBridge] REPS_WIZARD_API_URL or REPS_STRIPE_INTERNAL_SECRET not set');
    return null;
  }
  const url = `${base}/api/stripe/internal/${path}`;
  const { data } = await axios.post(url, body, {
    headers: { 'X-Harx-Internal-Secret': secret },
    timeout: 20000
  });
  return data;
}

export async function isRepStripePriceId(priceId) {
  if (!priceId) return false;
  const companyPlan = await SubscriptionPlan.findOne({ stripePriceId: priceId });
  if (companyPlan) return false;

  const base = repsWizardApiBase();
  const secret = internalSecret();
  if (!base || !secret) return false;

  try {
    const prices = await stripeService.getPublicPlans();
    const stripePrice = prices.find((p) => p.id === priceId);
    if (!stripePrice) return false;
    const name = String(stripePrice.product?.name || '').toLowerCase();
    return (
      name.includes('representative')
      || name.includes('freemium')
      || name.includes('elite rep')
      || name.includes('pro rep')
      || name.includes('standard rep')
    );
  } catch {
    return false;
  }
}

export async function fulfillRepCheckoutSession(session) {
  try {
    const result = await postInternal('fulfill', { session });
    return Boolean(result?.success);
  } catch (err) {
    console.error('[repSubscriptionBridge] fulfill failed:', err.response?.data || err.message);
    return false;
  }
}

export async function syncRepStripeSubscription(subscription) {
  try {
    const result = await postInternal('subscription/sync', { subscription });
    return Boolean(result?.success);
  } catch (err) {
    console.error('[repSubscriptionBridge] sync failed:', err.response?.data || err.message);
    return false;
  }
}

export async function cancelRepStripeSubscription(subscription) {
  try {
    const result = await postInternal('subscription/cancel', { subscription });
    return Boolean(result?.success);
  } catch (err) {
    console.error('[repSubscriptionBridge] cancel failed:', err.response?.data || err.message);
    return false;
  }
}
