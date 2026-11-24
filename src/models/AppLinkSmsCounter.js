import mongoose from 'mongoose';

/** Compteurs anti-abus de « M'envoyer le lien par SMS » (par compte, par minute et par jour) ; effacés à échéance (index TTL). */
const schema = new mongoose.Schema({
  _id: String,
  n: { type: Number, default: 0 },
  expiresAt: Date,
}, { collection: 'nomad_app_link_sms_counters', versionKey: false });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AppLinkSmsCounter = mongoose.models.AppLinkSmsCounter || mongoose.model('AppLinkSmsCounter', schema);
