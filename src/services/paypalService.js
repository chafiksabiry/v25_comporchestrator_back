import axios from 'axios';

const SANDBOX_API = 'https://api-m.sandbox.paypal.com';
const LIVE_API = 'https://api-m.paypal.com';

function apiBase() {
  const mode = (process.env.PAYPAL_MODE || 'sandbox').toLowerCase();
  return mode === 'live' ? LIVE_API : SANDBOX_API;
}

let cachedToken = null;
let tokenExpiresAt = 0;

const PLACEHOLDER_SECRETS = new Set([
  'your_sandbox_secret',
  'your_paypal_secret',
  'changeme',
  'xxx'
]);

function looksLikePlaceholderSecret(secret) {
  if (!secret) return true;
  const s = secret.trim().toLowerCase();
  if (PLACEHOLDER_SECRETS.has(s)) return true;
  if (s.startsWith('your_')) return true;
  return false;
}

function requireCredentials() {
  const clientId = (process.env.PAYPAL_CLIENT_ID || '').trim();
  const clientSecret = (process.env.PAYPAL_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) {
    const err = new Error('PayPal credentials not configured (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET)');
    err.code = 'PAYPAL_NOT_CONFIGURED';
    throw err;
  }
  if (looksLikePlaceholderSecret(clientSecret)) {
    const err = new Error(
      'PAYPAL_CLIENT_SECRET is still a placeholder (e.g. your_sandbox_secret). Set the real Secret from PayPal Developer Dashboard → Apps & Credentials → Sandbox.'
    );
    err.code = 'PAYPAL_INVALID_CREDENTIALS';
    throw err;
  }
  return { clientId, clientSecret };
}

/** Turn PayPal OAuth/API errors into short, actionable messages (no stack dump). */
function mapPayPalError(err) {
  if (err?.code === 'PAYPAL_NOT_CONFIGURED' || err?.code === 'PAYPAL_INVALID_CREDENTIALS') {
    return err.message;
  }
  const status = err?.response?.status;
  const body = err?.response?.data;
  if (status === 401) {
    const desc = body?.error_description || body?.message;
    if (body?.error === 'invalid_client' || /authentication failed/i.test(desc || '')) {
      return 'Identifiants PayPal invalides : vérifiez PAYPAL_CLIENT_ID et PAYPAL_CLIENT_SECRET (Secret du compte Sandbox, pas le placeholder .env.example).';
    }
    return desc || 'Authentification PayPal refusée (401).';
  }
  if (status === 403) {
    return 'Accès PayPal refusé (403). Vérifiez les permissions de l’application REST.';
  }
  return err?.message || 'Erreur PayPal';
}

async function getAccessToken() {
  const { clientId, clientSecret } = requireCredentials();
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  try {
    const { data } = await axios.post(
      `${apiBase()}/v1/oauth2/token`,
      'grant_type=client_credentials',
      {
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    cachedToken = data.access_token;
    tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    return cachedToken;
  } catch (err) {
    const mapped = mapPayPalError(err);
    const error = new Error(mapped);
    error.code = err?.response?.status === 401 ? 'PAYPAL_AUTH_FAILED' : 'PAYPAL_API_ERROR';
    throw error;
  }
}

/**
 * Create a PayPal Checkout order (intent CAPTURE).
 * Returns the raw PayPal payload, augmented with a convenient `approveUrl`.
 */
async function createOrder({ amountCents, currency, description, customId, returnUrl, cancelUrl }) {
  const token = await getAccessToken();
  const value = (amountCents / 100).toFixed(2);

  const { data } = await axios.post(
    `${apiBase()}/v2/checkout/orders`,
    {
      intent: 'CAPTURE',
      purchase_units: [
        {
          custom_id: String(customId).slice(0, 127),
          description: (description || 'HARX phone line').slice(0, 127),
          amount: {
            currency_code: currency,
            value
          }
        }
      ],
      application_context: {
        brand_name: 'HARX',
        user_action: 'PAY_NOW',
        landing_page: 'LOGIN',
        shipping_preference: 'NO_SHIPPING',
        return_url: returnUrl,
        cancel_url: cancelUrl
      }
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `harx-${customId}-${Date.now()}`
      }
    }
  );

  const approveLink = Array.isArray(data?.links)
    ? data.links.find((l) => l.rel === 'approve')
    : null;

  return { ...data, approveUrl: approveLink?.href || null };
}

/**
 * Capture funds after buyer approval in the PayPal popup.
 */
async function captureOrder(orderId) {
  const existing = await getOrder(orderId);
  if (existing.status === 'COMPLETED') {
    return existing;
  }
  if (existing.status !== 'APPROVED') {
    const err = new Error(
      "Le paiement PayPal n'a pas encore été approuvé. Terminez la validation sur PayPal avant de fermer la fenêtre."
    );
    err.code = 'PAYPAL_NOT_APPROVED';
    err.paypalStatus = existing.status;
    throw err;
  }

  const token = await getAccessToken();
  try {
    const { data } = await axios.post(
      `${apiBase()}/v2/checkout/orders/${orderId}/capture`,
      {},
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return data;
  } catch (err) {
    const detail = err?.response?.data?.details?.[0]?.description
      || err?.response?.data?.message;
    const mapped = detail || mapPayPalError(err);
    const error = new Error(mapped);
    error.code = err?.response?.status === 422 ? 'PAYPAL_NOT_APPROVED' : 'PAYPAL_API_ERROR';
    throw error;
  }
}

async function getOrder(orderId) {
  const token = await getAccessToken();
  const { data } = await axios.get(`${apiBase()}/v2/checkout/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return data;
}

/**
 * Refund a previously captured PayPal order in full. Used to compensate
 * the buyer when the downstream provisioning fails after capture (e.g.
 * Twilio rejects the number with regulatory error 21649).
 *
 * Returns the PayPal refund payload on success.
 */
async function refundOrder(orderId, { reason } = {}) {
  if (!orderId) {
    const err = new Error('orderId is required to issue a PayPal refund.');
    err.code = 'PAYPAL_REFUND_NO_ORDER';
    throw err;
  }
  const order = await getOrder(orderId);
  const captureId = order?.purchase_units?.[0]?.payments?.captures?.[0]?.id;
  if (!captureId) {
    const err = new Error(`PayPal order ${orderId} has no captured payment to refund.`);
    err.code = 'PAYPAL_REFUND_NO_CAPTURE';
    throw err;
  }
  const token = await getAccessToken();
  const { data } = await axios.post(
    `${apiBase()}/v2/payments/captures/${captureId}/refund`,
    reason ? { note_to_payer: reason } : {},
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return data;
}

export const paypalService = {
  isConfigured() {
    try {
      requireCredentials();
      return true;
    } catch {
      return false;
    }
  },
  getClientId() {
    return process.env.PAYPAL_CLIENT_ID || null;
  },
  getMode() {
    return (process.env.PAYPAL_MODE || 'sandbox').toLowerCase();
  },
  createOrder,
  captureOrder,
  getOrder,
  refundOrder
};
