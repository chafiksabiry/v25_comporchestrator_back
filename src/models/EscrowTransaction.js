import mongoose from 'mongoose';

/**
 * EscrowTransaction tracks COMPANY-ONLY cash movements:
 *   - deposit / withdrawal  : wallet recharges & retraits
 *   - buy_minutes           : achat de minutes (1€ = 1 minute)
 *   - escrow_lock / release / refund : ancien syst\u00e8me d'escrow (legacy)
 *
 * Les commissions (appel valid\u00e9, vente, bonus) NE sont PAS enregistr\u00e9es ici.
 * Pour les commissions, voir `RepTransaction` qui est la source unique du
 * ledger rep et qui d\u00e9bite directement `WalletCompany.balance`.
 *
 * Les valeurs d'enum legacy ('call_charge', 'reward_charge', etc.) restent
 * autoris\u00e9es UNIQUEMENT pour la r\u00e9trocompatibilit\u00e9 des documents historiques.
 */
const escrowTransactionSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true
  },
  type: {
    type: String,
    enum: [
      'deposit',
      'withdrawal',
      'buy_minutes',
      'escrow_lock',
      'escrow_release',
      'escrow_refund',
      // Legacy values: kept for historical rows only, never written anymore.
      'call_charge',
      'reward_charge',
      'transaction_charge',
      'bonus_charge'
    ],
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed'],
    default: 'completed'
  },
  credited: {
    type: Boolean,
    required: false,
    default: false
  },
  callId: {
    type: String,
    required: false,
    index: true
  },
  commission_rep: { type: Number, default: 0 },
  commission_harx: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
  minutes: { type: Number, default: 0 },
  transaction_detected: { type: Boolean, default: false },
  transaction_price: { type: Number, default: 0 },
  description: {
    type: String,
    required: false
  }
}, {
  timestamps: true
});

const EscrowTransaction = mongoose.model('EscrowTransaction', escrowTransactionSchema);
export default EscrowTransaction;
