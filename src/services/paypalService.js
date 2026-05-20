import axios from 'axios';

const SANDBOX_API = 'https://api-m.sandbox.paypal.com';
const LIVE_API = 'https://api-m.paypal.com';

function apiBase() {
  const mode = (process.env.PAYPAL_MODE || 'sandbox').toLowerCase();
  return mode === 'live' ? LIVE_API : SANDBOX_API;
}

let cachedToken = null;
let tokenExpiresAt = 0;

function requireCredentials() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const err = new Error('PayPal credentials not configured (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET)');
    err.code = 'PAYPAL_NOT_CONFIGURED';
    throw err;
  }
  return { clientId, clientSecret };
}

async function getAccessToken() {
  const { clientId, clientSecret } = requireCredentials();
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
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
  const token = await getAccessToken();
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
}

async function getOrder(orderId) {
  const token = await getAccessToken();
  const { data } = await axios.get(`${apiBase()}/v2/checkout/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return data;
}

export const paypalService = {
  isConfigured() {
    return Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
  },
  getClientId() {
    return process.env.PAYPAL_CLIENT_ID || null;
  },
  getMode() {
    return (process.env.PAYPAL_MODE || 'sandbox').toLowerCase();
  },
  createOrder,
  captureOrder,
  getOrder
};
