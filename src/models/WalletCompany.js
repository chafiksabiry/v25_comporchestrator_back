import mongoose from 'mongoose';

const walletCompanySchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    unique: true,
    index: true
  },
  balance: {
    type: Number,
    required: true,
    default: 0,
    min: 0
  }
}, {
  timestamps: true
});

const WalletCompany = mongoose.model('WalletCompany', walletCompanySchema);
export default WalletCompany;
