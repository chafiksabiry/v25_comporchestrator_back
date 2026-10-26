import { PhoneNumber } from '../models/PhoneNumber.js';
import PhoneNumberPayment from '../models/PhoneNumberPayment.js';
import { authenticate } from './auth.js';
import { callerCompanyId, ScopeError } from './companyScope.js';

/**
 * Access control of the phone-number routes: a valid login, and for everything that targets a company, a line or
 * a payment, the caller must belong to that company (resolved by the registration backend).
 * COMPANY_SCOPE_MODE=log downgrades only the company check to a warning (authentication stays enforced).
 */

const pick = (req, key) => req.params?.[key] ?? req.body?.[key] ?? req.query?.[key];

/** Company ids that must all be the caller's. A required id that is missing denies the request (400). */
export const companyFrom = (...sources) => async (req) => {
  const ids = [];
  for (const source of sources) {
    const value = typeof source === 'function' ? await source(req) : pick(req, source);
    if (value === undefined || value === null || value === '') throw new ScopeError(400, 'companyId is required');
    ids.push(String(value));
  }
  return ids;
};

/** Company of the line designated by id / phoneNumber (params, body or query). No line found: nothing to check. */
export const ofNumber = async (req) => {
  const id = pick(req, 'id');
  const phoneNumber = pick(req, 'phoneNumber');
  if (!id && !phoneNumber) return undefined;
  const line = id ? await PhoneNumber.findById(id).lean().catch(() => null) : await PhoneNumber.findOne({ phoneNumber }).lean();
  if (!line) return undefined;
  if (!line.companyId) throw new ScopeError(403, 'This line is not attached to a company');
  return line.companyId;
};

/** Company of the payment designated by paymentId. */
export const ofPayment = async (req) => {
  const paymentId = pick(req, 'paymentId');
  if (!paymentId) return undefined;
  const payment = await PhoneNumberPayment.findById(paymentId).lean().catch(() => null);
  if (!payment) return undefined;
  return payment.companyId;
};

/** @param {(req) => Promise<string[]>} resolveCompanyIds */
export const requireCompany = (resolveCompanyIds) => async (req, res, next) => {
  try {
    const targets = (await resolveCompanyIds(req)).filter((id) => id !== undefined && id !== null);
    if (targets.length === 0) return next();
    const mine = await callerCompanyId(req);
    if (mine && targets.every((id) => String(id) === String(mine))) return next();
    if (String(process.env.COMPANY_SCOPE_MODE || '').toLowerCase() === 'log') {
      console.warn(`[phoneScope] would deny user ${req.user?.userId} (company ${mine}) on ${req.method} ${req.originalUrl}`);
      return next();
    }
    return res.status(403).json({ error: 'Not allowed for this company' });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error('[phoneScope] unexpected error', error);
    return res.status(500).json({ error: 'Access check failed' });
  }
};

/** authenticate, then the company check built from `sources` (line / payment resolvers allowed). */
export const guard = (...resolvers) => [
  authenticate,
  requireCompany(async (req) => {
    const out = [];
    for (const resolver of resolvers) out.push(...[].concat(await resolver(req)));
    return out;
  }),
];
