import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import CompanyNotification from '../models/CompanyNotification.js';

const KINDS = new Set([
  'enrollment_request', 'enrollment_accepted', 'enrollment_rejected',
  'matching', 'transaction', 'validation', 'fraud', 'resource',
  'wallet', 'tokens', 'minutes', 'phone', 'subscription', 'info',
]);

/** Server-to-server callers (matching…) prove themselves with a short-lived JWT signed with the shared secret. */
export const INGEST_SCOPE = 'company-notify';

export function verifyIngestToken(authorizationHeader) {
  const token = String(authorizationHeader || '').split(' ')[1];
  if (!token) return false;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded?.scope === INGEST_SCOPE;
  } catch {
    return false;
  }
}

/**
 * Creates the notification once per (companyId, key). Never throws: a notification must not break the
 * business flow that triggers it.
 */
export async function notifyCompany({ companyId, key, kind = 'info', title, message = '', gigId = null, actionPath = null }) {
  try {
    if (!companyId || !mongoose.Types.ObjectId.isValid(String(companyId)) || !key || !title) return null;
    return await CompanyNotification.findOneAndUpdate(
      { companyId, key: String(key) },
      {
        $setOnInsert: {
          companyId,
          key: String(key),
          kind: KINDS.has(kind) ? kind : 'info',
          title: String(title).slice(0, 200),
          message: String(message).slice(0, 600),
          gigId: gigId ? String(gigId) : null,
          actionPath: actionPath ? String(actionPath).slice(0, 200) : null,
          read: false,
        },
      },
      { upsert: true, new: true }
    ).lean();
  } catch (error) {
    console.error('[companyNotification] failed:', error.message);
    return null;
  }
}

export const toPublic = (row) => ({
  id: String(row._id),
  kind: row.kind,
  title: row.title,
  message: row.message,
  gigId: row.gigId || null,
  actionPath: row.actionPath || null,
  read: Boolean(row.read),
  createdAt: row.createdAt,
});

/** Below these balances the company is warned (override with env vars). */
export const LOW_THRESHOLDS = {
  wallet: Number(process.env.LOW_WALLET_EUR || 20),
  minutes: Number(process.env.LOW_MINUTES || 30),
  tokens: Number(process.env.LOW_TOKENS || 20),
};

const LOW_COPY = {
  wallet: {
    path: '/dashboard/wallet',
    label: 'portefeuille',
    format: (n) => `${Number(n).toFixed(2)} €`,
    low: 'Solde du portefeuille faible',
    empty: 'Portefeuille épuisé',
    hint: 'Rechargez-le pour continuer à rémunérer vos REPs.',
  },
  minutes: {
    path: '/dashboard/minutes?buy=1',
    label: "minutes d'appel",
    format: (n) => `${Math.max(0, Math.round(n))} min`,
    low: 'Minutes d’appel bientôt épuisées',
    empty: 'Plus de minutes d’appel',
    hint: 'Ajoutez des minutes pour que vos REPs puissent appeler.',
  },
  tokens: {
    path: '/dashboard/tokens',
    label: 'tokens AI',
    format: (n) => `${Math.max(0, Math.round(n))} tokens`,
    low: 'Tokens AI bientôt épuisés',
    empty: 'Plus de tokens AI',
    hint: 'Rechargez-les pour continuer à utiliser les outils AI.',
  },
};

/**
 * Warns the company once per 3-day window and level (low / empty) when a resource runs short.
 * @param {'wallet'|'minutes'|'tokens'} resource
 */
export async function notifyLowResource(companyId, resource, balance) {
  const threshold = LOW_THRESHOLDS[resource];
  const copy = LOW_COPY[resource];
  const value = Number(balance);
  if (!copy || !Number.isFinite(value) || value >= threshold) return null;
  const level = value <= 0 ? 'empty' : 'low';
  const bucket = Math.floor(Date.now() / (3 * 24 * 3600 * 1000));
  return notifyCompany({
    companyId,
    key: `low-${resource}-${level}-${bucket}`,
    kind: 'resource',
    title: copy[level],
    message: `Il reste ${copy.format(value)} (${copy.label}). ${copy.hint}`,
    actionPath: copy.path,
  });
}

/** Periodic safety net: covers every way a balance can drop (calls, usage, commissions). */
export async function scanLowResources() {
  const [{ default: WalletCompany }, { default: MinutesCompany }, { default: TokensCompany }] = await Promise.all([
    import('../models/WalletCompany.js'),
    import('../models/MinutesCompany.js'),
    import('../models/TokensCompany.js'),
  ]);
  let notified = 0;
  const check = async (Model, field, resource) => {
    const rows = await Model.find({ [field]: { $lt: LOW_THRESHOLDS[resource] } }).select(`companyId ${field}`).lean();
    for (const row of rows) {
      if (await notifyLowResource(row.companyId, resource, row[field])) notified += 1;
    }
  };
  await check(WalletCompany, 'balance', 'wallet');
  await check(MinutesCompany, 'minutes', 'minutes');
  await check(TokensCompany, 'tokens', 'tokens');
  return { notified };
}
