import WalletCompany from '../models/WalletCompany.js';
import WalletCompanyEntry from '../models/WalletCompanyEntry.js';
import EscrowTransaction from '../models/EscrowTransaction.js';
import AgentWithdrawal from '../models/AgentWithdrawal.js';
import mongoose from 'mongoose';
import { guardCompanyAccess } from '../middleware/companyGuard.js';

/** Montant strictement positif, fini, arrondi au centime ; null sinon (chaîne non numérique, NaN, Infinity, objet…). */
function parseAmount(raw) {
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  const cents = Math.round(n * 100) / 100;
  return cents > 0 ? cents : null;
}

export const walletCompanyController = {
  getWallet: async (req, res) => {
    const { companyId } = req.params;
    if (!companyId) return res.status(400).json({ error: 'companyId is required' });
    // Isolation : propriétaire ou membre de CETTE société (la lecture crée le portefeuille s'il manque : garde avant toute lecture).
    if (!(await guardCompanyAccess(req, res, companyId))) return;
    try {
      let wallet = await WalletCompany.findOne({ companyId });
      if (!wallet) {
        wallet = new WalletCompany({ companyId, balance: 0 });
        await wallet.save();
      }
      res.status(200).json({ success: true, data: wallet });
    } catch (err) {
      console.error('Error fetching wallet:', err);
      res.status(500).json({ error: 'Failed to fetch wallet' });
    }
  },

  // SUPPRIMÉ : cette route créditait le portefeuille d'un montant arbitraire SANS aucun paiement (n'importe quelle société, n'importe quelle somme).
  // Aucun appelant (front orchestrateur, autres services) : le dépôt réel passe par le paiement (/api/payments/checkout, purpose=wallet_deposit,
  // crédit après confirmation du paiement par Stripe / PayPal).
  deposit: async (req, res) => res.status(410).json({
    error: 'Deposits are only possible through the payment checkout',
    code: 'deposit_disabled',
    message: 'Utilisez le paiement (Stripe ou PayPal) pour alimenter le portefeuille.'
  }),

  withdraw: async (req, res) => {
    const { companyId, amount, description } = req.body;
    if (!companyId) return res.status(400).json({ error: 'companyId and positive amount are required' });
    // Mouvement d'argent : propriétaire de CETTE société uniquement (jamais un membre, un agent ou une autre société).
    if (!(await guardCompanyAccess(req, res, companyId, { ownerOnly: true }))) return;
    const value = parseAmount(amount);
    if (value === null) return res.status(400).json({ error: 'companyId and positive amount are required' });
    try {
      // Atomique : la condition de solde et la décrémentation sont une seule opération (deux retraits simultanés ne passent pas tous les deux).
      const wallet = await WalletCompany.findOneAndUpdate(
        { companyId, balance: { $gte: value } },
        { $inc: { balance: -value } },
        { new: true }
      );
      if (!wallet) {
        const exists = await WalletCompany.findOne({ companyId });
        return exists ? res.status(400).json({ error: 'Insufficient balance' }) : res.status(404).json({ error: 'Wallet not found' });
      }

      try {
        await WalletCompanyEntry.create({
          companyId,
          type: 'withdrawal',
          direction: 'debit',
          amount: value,
          balanceAfter: Number(Number(wallet.balance).toFixed(2)),
          status: 'completed',
          description: description || `Retrait de ${value.toFixed(2)} €`
        });
      } catch (logErr) {
        console.warn('WalletCompanyEntry log failed (withdrawal):', logErr.message);
      }

      res.status(200).json({ success: true, data: wallet });
    } catch (err) {
      console.error('Error during withdrawal:', err);
      res.status(500).json({ error: 'Failed to withdraw funds' });
    }
  },

  // History of every cash movement on the company's wallet (deposits,
  // withdrawals, refunds, manual adjustments).
  //
  // Sources merged:
  //   1. `WalletCompanyEntry` — the new authoritative ledger (written by
  //      every deposit/withdraw since the ledger was introduced).
  //   2. `EscrowTransaction` — legacy rows of type=deposit/withdrawal that
  //      were created BEFORE the ledger existed. We pick them up so the
  //      frontend can display the full history without a migration script.
  //
  // Rows from `EscrowTransaction` that have a matching `WalletCompanyEntry`
  // (same companyId + amount + createdAt within 5s) are dropped to avoid
  // duplicates when both writes happen back-to-back (deposit path goes
  // through both models today).
  getEntries: async (req, res) => {
    const { companyId } = req.params;
    if (!companyId) return res.status(400).json({ error: 'companyId is required' });
    if (!(await guardCompanyAccess(req, res, companyId))) return;
    try {
      const { type, direction, status, limit = 200 } = req.query;
      const maxLimit = Math.min(Number(limit) || 200, 500);

      // 1) New ledger rows
      const newFilter = { companyId };
      if (type) newFilter.type = type;
      if (direction) newFilter.direction = direction;
      if (status) newFilter.status = status;

      const newEntries = await WalletCompanyEntry.find(newFilter)
        .sort({ createdAt: -1 })
        .limit(maxLimit)
        .lean();

      // 2) Legacy rows — only deposits/withdrawals (commissions live in
      // RepTransaction now and must NOT leak into this view).
      const companyObjectId = mongoose.Types.ObjectId.isValid(companyId)
        ? new mongoose.Types.ObjectId(companyId)
        : companyId;
      const legacyFilter = {
        $or: [
          { companyId: companyObjectId },
          { companyId: String(companyId) }
        ],
        type: { $in: ['deposit', 'withdrawal'] }
      };
      if (status) legacyFilter.status = status;

      const legacyRows = await EscrowTransaction.find(legacyFilter)
        .sort({ createdAt: -1 })
        .limit(maxLimit)
        .lean();

      // Build a fingerprint set from the new ledger so we can dedupe.
      const fingerprint = (companyIdStr, type, amount, createdAt) =>
        `${companyIdStr}|${type}|${Number(amount).toFixed(2)}|${Math.floor(new Date(createdAt).getTime() / 5000)}`;
      const newFingerprints = new Set(
        newEntries.map(e => fingerprint(String(e.companyId), e.type, e.amount, e.createdAt))
      );

      // Project each legacy row into the same shape as WalletCompanyEntry.
      const projectedLegacy = legacyRows
        .map(row => ({
          _id: row._id,
          companyId: row.companyId,
          type: row.type,
          direction: row.type === 'withdrawal' ? 'debit' : 'credit',
          amount: row.amount,
          currency: 'EUR',
          balanceAfter: null, // unknown for legacy rows
          status: row.status || 'completed',
          description: row.description
            || `${row.type === 'withdrawal' ? 'Retrait' : 'Dépôt'} de ${Number(row.amount).toFixed(2)} €`,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          meta: { legacy: true, source: 'EscrowTransaction' }
        }))
        .filter(row => {
          // Drop if already mirrored into the new ledger.
          const fp = fingerprint(String(row.companyId), row.type, row.amount, row.createdAt);
          if (newFingerprints.has(fp)) return false;
          // Apply optional type/direction query filters.
          if (type && row.type !== type) return false;
          if (direction && row.direction !== direction) return false;
          return true;
        });

      // Merge + re-sort + cap
      const merged = [...newEntries, ...projectedLegacy]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, maxLimit);

      const totals = merged.reduce(
        (acc, e) => {
          if (e.direction === 'credit') acc.credit += e.amount || 0;
          else acc.debit += e.amount || 0;
          return acc;
        },
        { credit: 0, debit: 0 }
      );

      res.status(200).json({
        success: true,
        data: merged,
        totals: {
          credit: Number(totals.credit.toFixed(2)),
          debit: Number(totals.debit.toFixed(2)),
          net: Number((totals.credit - totals.debit).toFixed(2)),
          count: merged.length
        }
      });
    } catch (err) {
      console.error('Error fetching wallet entries:', err);
      res.status(500).json({ error: 'Failed to fetch wallet entries' });
    }
  },

  getAgentWithdrawals: async (req, res) => {
    const { companyId } = req.params;
    if (!companyId) return res.status(400).json({ error: 'companyId is required' });
    if (!(await guardCompanyAccess(req, res, companyId))) return;
    try {
      const companyObjectId = mongoose.Types.ObjectId.isValid(companyId) ? new mongoose.Types.ObjectId(companyId) : companyId;
      const withdrawals = await AgentWithdrawal.find({ 
        companyId: companyObjectId,
        status: 'pending'
      }).sort({ createdAt: -1 });

      const db = mongoose.connection.db;
      const result = [];

      for (const w of withdrawals) {
        const agentDoc = await db.collection('agents').findOne({ _id: w.agentId });
        result.push({
          ...w.toObject(),
          agentName: agentDoc?.personalInfo?.name || 'Unknown Agent',
          agentEmail: agentDoc?.personalInfo?.email || ''
        });
      }

      res.status(200).json({ success: true, data: result });
    } catch (err) {
      console.error('Error fetching agent withdrawals for company:', err);
      res.status(500).json({ error: 'Failed to fetch agent withdrawals' });
    }
  },

  approveOrRefuseAgentWithdrawal: async (req, res) => {
    const { withdrawalId } = req.params;
    const { action } = req.body || {}; // action: 'approve' or 'refuse'

    if (!withdrawalId || !mongoose.Types.ObjectId.isValid(withdrawalId) || !['approve', 'refuse'].includes(action)) {
      return res.status(400).json({ error: "A valid withdrawalId and action ('approve' or 'refuse') are required" });
    }
    // Propriétaire de la société de l'appelant uniquement ; le retrait est ensuite cherché DANS cette société (jamais celui d'une autre,
    // jamais un retrait sans société enregistrée : propriété invérifiable).
    const access = await guardCompanyAccess(req, res, null, { ownerOnly: true, ownCompany: true });
    if (!access) return;

    try {
      const companyObjectId = new mongoose.Types.ObjectId(String(access.companyId));
      // Atomique : seul un retrait EN ATTENTE est traité, une seule fois (plus de ré-approbation ni de retournement refus <-> approuvé,
      // qui aurait rendu l'argent à l'agent après coup).
      const withdrawal = await AgentWithdrawal.findOneAndUpdate(
        { _id: withdrawalId, companyId: companyObjectId, status: 'pending' },
        { $set: { status: action === 'approve' ? 'completed' : 'failed' } },
        { new: true }
      );
      if (!withdrawal) {
        const own = await AgentWithdrawal.findOne({ _id: withdrawalId, companyId: companyObjectId });
        return own
          ? res.status(409).json({ error: `Withdrawal already ${own.status}` })
          : res.status(404).json({ error: 'Withdrawal request not found' });
      }
      withdrawal.description = (withdrawal.description || '') + (action === 'approve' ? ' (Approuvé par la compagnie)' : ' (Refusé par la compagnie)');
      await withdrawal.save();

      res.status(200).json({ success: true, data: withdrawal });
    } catch (err) {
      console.error('Error approving/refusing agent withdrawal:', err);
      res.status(500).json({ error: 'Failed to process withdrawal action' });
    }
  }
};
