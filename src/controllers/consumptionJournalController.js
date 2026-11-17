import mongoose from 'mongoose';
import { callerAccess, ScopeError } from '../middleware/companyScope.js';
import MinutesCompany from '../models/MinutesCompany.js';
import TokensCompany from '../models/TokensCompany.js';
import TokensUsageLedger from '../models/TokensUsageLedger.js';
import CompanyPayment from '../models/CompanyPayment.js';
import {
  CSV_MAX_ROWS, QueryError, buildMinutesRows, buildTokensRows, inPeriod, paginate, parseQuery, sortWithBalances, summarize, toCsv,
} from '../services/consumptionJournal.js';

/**
 * Journal de consommation des minutes et des jetons IA : LECTURE SEULE, titulaire du compte uniquement.
 * Ce module ne lit que : il n'appelle ni débit, ni octroi, ni synchronisation (qui, eux, écrivent le solde).
 * La société vient de l'authentification (jamais de la requête). Dépendances injectables pour les tests.
 */
const fail = (res, status, code, message) => res.status(status).json({ success: false, code, message });

const toOid = (id) => (mongoose.Types.ObjectId.isValid(String(id)) ? new mongoose.Types.ObjectId(String(id)) : null);

const defaultLoaders = {
  async minutes(companyId) {
    const oid = toOid(companyId);
    if (!oid) return { wallet: null, payments: [], calls: [] };
    const [wallet, payments, calls] = await Promise.all([
      MinutesCompany.findOne({ companyId: oid }).select('minutes planGrantKeys chargedCallSids credits').lean(),
      CompanyPayment.find({ companyId: oid, status: 'succeeded', purpose: { $in: ['minutes_purchase', 'bundle_purchase'] } }).lean(),
      mongoose.connection.db.collection('calls').find(
        { $or: [{ companyId: oid }, { companyId: String(oid) }], duration: { $gt: 0 }, isTest: { $ne: true } },
        { projection: { sid: 1, duration: 1, direction: 1, from: 1, to: 1, startTime: 1, createdAt: 1, endTime: 1, isTest: 1 } },
      ).toArray(),
    ]);
    return { wallet, payments, calls };
  },
  async tokens(companyId) {
    const oid = toOid(companyId);
    if (!oid) return { wallet: null, payments: [], usage: [] };
    const [wallet, payments, usage] = await Promise.all([
      TokensCompany.findOne({ companyId: oid }).select('tokens planTokensGranted planGrantKeys').lean(),
      CompanyPayment.find({ companyId: oid, status: 'succeeded', purpose: { $in: ['tokens_purchase', 'bundle_purchase'] } }).lean(),
      TokensUsageLedger.find({ companyId: oid }).select('-meta').lean(),
    ]);
    return { wallet, payments, usage };
  },
};

export function createJournalHandlers(deps = {}) {
  const getAccess = deps.getAccess || callerAccess;
  const loaders = deps.loaders || defaultLoaders;

  /** Accès titulaire + paramètres ; renvoie null si la réponse d'erreur est déjà envoyée. */
  async function context(req, res, { paged }) {
    let access;
    try {
      access = await getAccess(req);
    } catch (error) {
      const status = error instanceof ScopeError ? error.status : 503;
      fail(res, status, status === 503 ? 'unavailable' : 'unauthorized', status === 503 ? 'Service indisponible.' : 'Authentification requise.');
      return null;
    }
    if (!access?.companyId) { fail(res, 404, 'no_company', 'Entreprise introuvable.'); return null; }
    if (access.role !== 'owner') { fail(res, 403, 'forbidden', 'Accès refusé.'); return null; }
    let q;
    try {
      q = parseQuery(req.query || {}, { paged });
    } catch (error) {
      if (error instanceof QueryError) { fail(res, 400, error.code, error.message); return null; }
      throw error;
    }
    return { companyId: String(access.companyId), q };
  }

  /** Toutes les lignes de la société, triées, avec solde après opération, plus les totaux (indépendants du filtre de nature). */
  async function compute(companyId, q) {
    let built;
    let balance;
    let extra;
    if (q.type === 'minutes') {
      const src = await loaders.minutes(companyId);
      const { rows, orphanDebitedCalls } = buildMinutesRows(src);
      built = rows; balance = src.wallet?.minutes ?? 0; extra = { orphanDebitedCalls };
    } else {
      const src = await loaders.tokens(companyId);
      const { rows, unattributedPlanGrant } = buildTokensRows(src);
      built = rows; balance = src.wallet?.tokens ?? 0; extra = { unattributedPlanGrant };
    }
    const all = sortWithBalances(built, balance);
    const summary = summarize(all, { from: q.from, to: q.to, currentBalance: balance, extra });
    const filtered = all.filter((r) => inPeriod(r, q.from, q.to) && (!q.natures || q.natures.includes(r.nature)));
    return { filtered, summary };
  }

  const guarded = (fn) => async (req, res) => {
    try {
      return await fn(req, res);
    } catch (error) {
      console.error('[consumption-journal] échec:', String(error?.message || '').slice(0, 200));
      return fail(res, 500, 'server_error', 'Impossible de lire le journal pour le moment.');
    }
  };

  return {
    list: guarded(async (req, res) => {
      const ctx = await context(req, res, { paged: true });
      if (!ctx) return undefined;
      const { filtered, summary } = await compute(ctx.companyId, ctx.q);
      const page = paginate(filtered, ctx.q.page, ctx.q.limit);
      return res.json({ success: true, data: { type: ctx.q.type, ...page, summary } });
    }),

    exportCsv: guarded(async (req, res) => {
      const ctx = await context(req, res, { paged: false });
      if (!ctx) return undefined;
      const { filtered } = await compute(ctx.companyId, ctx.q);
      const rows = filtered.slice(0, CSV_MAX_ROWS);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="journal-consommation-${ctx.q.type}-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.setHeader('Cache-Control', 'no-store');
      if (filtered.length > rows.length) res.setHeader('X-Journal-Truncated', 'true');
      return res.send(toCsv(rows));
    }),
  };
}

export const consumptionJournalController = createJournalHandlers();
