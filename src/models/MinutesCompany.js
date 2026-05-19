import mongoose from 'mongoose';

const minutesCompanySchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    unique: true,
    index: true
  },
  minutes: {
    type: Number,
    required: true,
    default: 0,
    min: 0
  }
}, {
  timestamps: true
});

const MinutesCompany = mongoose.model('MinutesCompany', minutesCompanySchema);
export default MinutesCompany;
