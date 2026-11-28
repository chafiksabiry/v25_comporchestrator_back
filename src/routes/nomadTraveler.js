/**
 * NOMAD Traveler (décisions du fondateur du 26/11/2026) : /api/nomad/traveler/*
 *  - GET  /offer                    public : prix (centimes, même chiffre en €, $, £), durée, minutes incluses, pays du numéro ;
 *  - GET  /status                   titulaire : identité vérifiée, visa exigé, pièces, abonnement Traveler, dernier achat de numéro ;
 *  (pièces Traveler : passeport, billet, visa, déposés et lus dans la vérification d'identité, /api/identity-verification, 27/11/2026) ;
 *  - GET  /numbers?country=US|CA|GB|FR  titulaire : numéros proposés ;
 *  - POST /checkout/init            titulaire : paiement unique Stripe (confirmation : /api/payments/checkout/confirm) ;
 *  - POST /admin/:companyId/review  admin HARX (JWT `typeUser === 'admin'`) : approved / rejected.
 */
import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { guardCompanyAccess } from '../middleware/companyGuard.js';
import { adminFromToken } from './identityVerification.js';
import { paymentCheckoutController } from '../controllers/paymentCheckoutController.js';
import {
  TravelerError, reviewTravelerDocuments, searchTravelerNumbers, travelerStatus, TRAVELER_PURPOSE,
} from '../services/nomadTraveler.js';
import { TRAVELER_DAYS, TRAVELER_INCLUDED_MINUTES, TRAVELER_NUMBER_COUNTRIES, TRAVELER_PRICE_CENTS, TRAVELER_PRICES, OFFER_CURRENCIES } from '../services/nomadOffers.js';
import CompanyPayment from '../models/CompanyPayment.js';

const router = express.Router();

const sendError = (res, e) => {
  if (e instanceof TravelerError) return res.status(e.status).json({ error: e.code, code: e.code, ...e.extra });
  if (e?.code === 'IDENTITY_FILES_KEY_MISSING' || e?.name === 'IdentityDisabledError') return res.status(503).json({ error: 'DOCUMENTS_UNAVAILABLE', code: 'DOCUMENTS_UNAVAILABLE' });
  console.error('[nomad-traveler]', e?.message || e);
  return res.status(500).json({ error: 'TRAVELER_ERROR', code: 'TRAVELER_ERROR' });
};

const owner = async (req, res, next) => {
  const access = await guardCompanyAccess(req, res, undefined, { ownCompany: true, ownerOnly: true });
  if (!access) return undefined;
  req.travelerCompanyId = String(access.companyId);
  req.travelerUserId = String(access.userId || req.user?.userId || req.user?.id || '');
  return next();
};

router.get('/offer', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ priceCents: TRAVELER_PRICE_CENTS, prices: TRAVELER_PRICES, currencies: OFFER_CURRENCIES, days: TRAVELER_DAYS, includedMinutes: TRAVELER_INCLUDED_MINUTES, numberCountries: TRAVELER_NUMBER_COUNTRIES, oneTime: true });
});

router.get('/status', authenticate, owner, async (req, res) => {
  try {
    const status = await travelerStatus(req.travelerCompanyId);
    const last = await CompanyPayment.findOne({ companyId: req.travelerCompanyId, purpose: TRAVELER_PURPOSE }).sort({ createdAt: -1 }).select('status meta.numberPurchase meta.chosenNumber currency').lean();
    res.set('Cache-Control', 'no-store');
    return res.json({ ...status, lastPayment: last ? { status: last.status, currency: last.currency, numberPurchase: last.meta?.numberPurchase || null, chosenNumber: last.meta?.chosenNumber || null } : null });
  } catch (e) { return sendError(res, e); }
});

router.get('/numbers', authenticate, owner, async (req, res) => {
  try {
    return res.json({ numbers: await searchTravelerNumbers(req.query.country, { limit: req.query.limit, locality: req.query.locality }) });
  } catch (e) {
    if (e instanceof TravelerError) return sendError(res, e);
    console.error('[nomad-traveler] recherche de numéros :', e?.message || e);
    return res.status(503).json({ error: 'NUMBER_SEARCH_UNAVAILABLE', code: 'NUMBER_SEARCH_UNAVAILABLE', retryable: true });
  }
});

router.post('/checkout/init', authenticate, (req, res) => paymentCheckoutController.initTravelerCheckout(req, res));

router.post('/admin/:companyId/review', express.json({ limit: '10kb' }), async (req, res) => {
  const admin = adminFromToken(req);
  if (!admin) return res.status(401).json({ error: 'ADMIN_REQUIRED', code: 'ADMIN_REQUIRED' });
  try {
    return res.json(await reviewTravelerDocuments(req.params.companyId, { decision: req.body?.decision, reason: req.body?.reason, reviewer: admin }));
  } catch (e) { return sendError(res, e); }
});

export const nomadTravelerRoutes = router;
