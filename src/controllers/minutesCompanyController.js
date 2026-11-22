import MinutesCompany from '../models/MinutesCompany.js';
import { syncMinutesFromCalls } from './escrowController.js';
import { ensurePlanMinutesGranted } from '../services/planMinutesGrant.js';
import { callerAccess, ScopeError } from '../middleware/companyScope.js';
import mongoose from 'mongoose';
import { creditFactorForCall } from '../services/creditCoefficient.js';
import { debitMinutesClamped, raceTimeout, releaseForChargedKeys } from '../services/minutesGrace.js';
import { freeZeroKeys, recordOwnerLanguage, zeroInboundView } from '../services/zeroBalanceInbound.js';

async function readMinutes(companyId, res) {
  try {
    // Credit plan-included minutes (e.g. Starter 120) for the current period
    // when not yet granted — also backfills existing trialing/active subs.
    let planGrant = { granted: false, allowance: 0, planName: undefined };
    try {
      planGrant = await ensurePlanMinutesGranted(companyId);
    } catch (grantErr) {
      console.warn('[minutes] plan grant skipped:', grantErr?.message || grantErr);
    }

    // Ensure every completed call has been deducted from the balance.
    // Billing rule: any started minute is billed in full (ceil seconds/60).
    await syncMinutesFromCalls(companyId);

    let wallet = await MinutesCompany.findOne({ companyId });
    if (!wallet) {
      wallet = new MinutesCompany({ companyId, minutes: 0 });
      await wallet.save();
    }

    const minutes = typeof wallet.minutes === 'number' ? wallet.minutes : 0;
    const consumedSeconds =
      typeof wallet.consumedSeconds === 'number' ? wallet.consumedSeconds : 0;
    // Solde épuisé : réserve gratuite de 5 minutes d'appels entrants (bandeau du portail). Lecture bornée, jamais bloquante ; absente sinon.
    const zeroBalanceInbound = await raceTimeout(zeroInboundView({ companyId, wallet }), 1500, null);

    res.status(200).json({
      success: true,
      data: {
        companyId,
        minutes,
        purchasedMinutes: typeof wallet.purchasedMinutes === 'number' ? wallet.purchasedMinutes : 0,
        planMinutesIncluded: planGrant.allowance || 0,
        planMinutesGranted:
          typeof wallet.planMinutesGranted === 'number' ? wallet.planMinutesGranted : 0,
        planName: planGrant.planName || null,
        credits: Array.isArray(wallet.credits)
          ? [...wallet.credits].sort((a, b) => new Date(b.at) - new Date(a.at))
          : [],
        consumedSeconds,
        limitReached: minutes <= 0,
        ...(zeroBalanceInbound ? { zeroBalanceInbound } : {}),
      }
    });
  } catch (err) {
    console.error('Error fetching minutes:', err);
    res.status(500).json({ error: 'Failed to fetch minutes' });
  }
}

export const minutesCompanyController = {
  getMinutes: async (req, res) => {
    const { companyId } = req.params;
    if (!companyId) return res.status(400).json({ error: 'companyId is required' });
    // Isolation : un utilisateur authentifié ne lit que le solde de SA société (propriétaire ou membre ; pas un agent). La société vient du
    // service d'inscription (source de vérité), jamais du navigateur ; service indisponible : 503, jamais d'accès ouvert par défaut.
    try {
      const access = await callerAccess(req);
      if (!access.companyId || access.role === 'agent' || String(companyId) !== String(access.companyId)) {
        return res.status(403).json({ error: 'Forbidden', code: 'forbidden' });
      }
      // Langue de l'interface du TITULAIRE (portail : `?lang=fr|en|es|ar`) : langue des notifications « rechargez vos minutes ». Jamais bloquant.
      if (access.isOwner && req.query?.lang) void recordOwnerLanguage(companyId, req.query.lang).catch(() => undefined);
    } catch (error) {
      const status = error instanceof ScopeError ? error.status : 503;
      return res.status(status).json({ error: error.message || 'Company lookup failed', code: error.code || 'COMPANY_LOOKUP_FAILED' });
    }
    return readMinutes(companyId, res);
  },

  // Lecture serveur à serveur (dash_calls, portillon avant appel) : route interne SANS jeton, comportement d'origine conservé. Le contrôle de
  // propriété de getMinutes (jeton utilisateur) ne s'y applique pas : sans cette séparation le portillon recevrait 401 et s'ouvrirait en silence.
  getMinutesInternal: async (req, res) => {
    const { companyId } = req.params;
    if (!companyId) return res.status(400).json({ error: 'companyId is required' });
    return readMinutes(companyId, res);
  },

  buyMinutes: async (req, res) => {
    const { companyId, amount } = req.body;
    if (!companyId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'companyId and positive amount are required' });
    }
    try {
      let wallet = await MinutesCompany.findOne({ companyId });
      if (!wallet) {
        wallet = new MinutesCompany({ companyId, minutes: 0 });
      }
      const purchased = parseFloat(amount);
      wallet.minutes = Number((wallet.minutes + purchased).toFixed(2));
      wallet.purchasedMinutes = Number(((wallet.purchasedMinutes || 0) + purchased).toFixed(2));
      wallet.credits = wallet.credits || [];
      wallet.credits.push({
        at: new Date(),
        minutes: purchased,
        planName: '',
        kind: 'recharge',
        grantKey: `recharge:${Date.now()}`,
      });
      await wallet.save();

      res.status(200).json({ success: true, data: wallet });
    } catch (err) {
      console.error('Error buying minutes:', err);
      res.status(500).json({ error: 'Failed to buy minutes' });
    }
  },

  // Endpoint hit by other microservices (dash_calls_backend, Twilio and Telnyx paths) right after a call is saved so the
  // minute balance reflects the consumption immediately. Body: { companyId, callSid, duration|durationSeconds }.
  // The route is NOT authenticated (server-to-server, no caller identity), so nothing financial is believed from the body:
  // the call must exist in the `calls` collection for THAT company, and the debited duration is the stored one. The body only
  // says which call to look at. A call not saved yet (or without a duration) is left to syncMinutesFromCalls, which debits it
  // on the next balance read with the same idempotency key (the call's sid).
  chargeCall: async (req, res) => {
    const { companyId, callSid, duration, durationSeconds: durationSecondsBody } = req.body;
    if (!companyId || !callSid) {
      return res.status(400).json({ error: 'companyId and callSid are required' });
    }

    // Accept both `duration` (Twilio) and `durationSeconds` (Telnyx): only to ignore requests that carry no duration at all.
    if (Number(duration ?? durationSecondsBody ?? 0) <= 0) {
      return res.status(200).json({ success: true, charged: false, reason: 'No duration' });
    }

    try {
      // The real call: same company, a stored duration, not a test call. Anything else is not charged here.
      let stored = null;
      try {
        stored = await mongoose.connection.db.collection('calls').findOne({ sid: String(callSid) });
      } catch (lookupErr) {
        console.warn('[charge-call] calls lookup failed, nothing charged:', lookupErr?.message || lookupErr);
      }
      const durationSeconds = Number(stored?.duration);
      if (!stored || String(stored.companyId) !== String(companyId) || stored.isTest === true) {
        return res.status(200).json({ success: true, charged: false, reason: 'Call not found' });
      }
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        return res.status(200).json({ success: true, charged: false, reason: 'No duration' });
      }
      // Same idempotency key as syncMinutesFromCalls (`sid || _id`).
      const chargeKey = String(stored.sid || stored._id || callSid);

      // Crédits par minute selon la zone (1, ou N pour un appel international ; classement d'après la ligne de l'appel stocké). Forfait ou
      // lignes illisibles : 1 crédit, comme avant (le débit normal n'est jamais sauté).
      const factor = await creditFactorForCall({ companyId, call: stored });

      // Billing rule: any started minute is billed in full (10s → 1 min, 1m02s → 2 min), then multiplied by the credits of the zone.
      // B.1 : débit borné par le solde (jamais sous zéro) : les minutes de grâce ne sont pas facturées.
      // Appel entrant gratuit à solde nul (réserve de 5 minutes) : inscrit sans débit, jamais facturé.
      const free = (await freeZeroKeys([chargeKey, String(callSid)]).catch(() => new Set())).size > 0;
      const durationMinutes = free ? 0 : Math.ceil(durationSeconds / 60) * factor;
      const done = await debitMinutesClamped({ companyId, keys: [chargeKey], cost: durationMinutes, seconds: free ? 0 : durationSeconds });
      const updated = done?.wallet;

      // Verrou du solde perdu à chaque essai (débits concurrents) : rien n'est débité ici, la prochaine lecture du solde le reprendra.
      if (done?.retryLater) {
        return res.status(200).json({ success: true, charged: false, reason: 'retry_later' });
      }

      if (!updated) {
        const wallet = await MinutesCompany.findOne({ companyId });
        return res.status(200).json({
          success: true,
          charged: false,
          reason: 'Already charged',
          data: { minutes: wallet?.minutes ?? 0 }
        });
      }

      // B.1 : la réservation de l'appel est rendue au moment de son débit (idempotent).
      await releaseForChargedKeys([chargeKey, String(callSid)]);

      res.status(200).json({
        success: true,
        charged: true,
        data: { minutes: updated.minutes }
      });
    } catch (err) {
      console.error('Error charging call minutes:', err);
      res.status(500).json({ error: 'Failed to charge call minutes' });
    }
  }
};
