import mongoose from 'mongoose';

const harxWalletSchema = new mongoose.Schema({
  balance: {
    type: Number,
    required: true,
    default: 0,
    min: 0
  },
  lifetimeEarnings: {
    type: Number,
    required: true,
    default: 0,
    min: 0
  }
}, {
  timestamps: true
});

const HarxWallet = mongoose.model('HarxWallet', harxWalletSchema);
export default HarxWallet;
