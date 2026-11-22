import mongoose from 'mongoose';

/**
 * Appel d'essai gratuit (Nomad Solo, avant paiement). Aucune donnée en clair : empreintes HMAC (téléphone, e-mail normalisé, appareil,
 * IP, réseau IP, numéro appelé), préfixe du numéro appelé (indicatif + 3 chiffres), type de ligne Lookup. Aucun audio.
 * Conservation : 12 mois (index TTL sur createdAt).
 */
const RETENTION = 365 * 24 * 3600;

const trialCallSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  phoneHash: { type: String, index: true },
  emailHash: { type: String, index: true },
  deviceHash: { type: String, index: true },
  ipHash: { type: String, index: true },
  ipNetHash: String,
  country: String,
  lang: String,
  lineType: String,
  trialNumber: String,
  // verified -> dialing -> in_progress -> ended ; exhausted = 3 numérotations sans décroché.
  status: { type: String, default: 'verified', index: true },
  dialAttempts: { type: Number, default: 0 },
  ticketNonce: String,
  ticketExpiresAt: Date,
  callSid: String,
  childCallSid: String,
  toHash: { type: String, index: true },
  toPrefix: String,
  dialingAt: Date,
  answeredAt: Date,
  consumedAt: { type: Date, index: true },
  endedAt: Date,
  durationSec: Number,
  endReason: String,
  costUsd: Number,
  paidAt: Date,
  createdAt: { type: Date, default: Date.now },
}, { collection: 'trial_calls', versionKey: false });
trialCallSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION });

/** Envois de code SMS : un document par envoi (limites par téléphone / IP / appareil), effacé 24 h après. */
const trialOtpSchema = new mongoose.Schema({
  userId: { type: String, index: true },
  phoneHash: { type: String, index: true },
  deviceHash: { type: String, index: true },
  ipHash: { type: String, index: true },
  codeHash: String,
  attempts: { type: Number, default: 0 },
  expiresAt: Date,
  usedAt: Date,
  createdAt: { type: Date, default: Date.now },
}, { collection: 'trial_call_otps', versionKey: false });
trialOtpSchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 3600 });

/** Résultat Lookup mis en cache par empreinte de téléphone (type de ligne seulement), 30 jours. */
const trialLookupSchema = new mongoose.Schema({
  phoneHash: { type: String, unique: true },
  lineType: String,
  countryCode: String,
  createdAt: { type: Date, default: Date.now },
}, { collection: 'trial_call_lookups', versionKey: false });
trialLookupSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

/** Évènements du parcours d'inscription (mesure avant/après), 12 mois. */
const trialEventSchema = new mongoose.Schema({
  name: { type: String, index: true },
  userId: String,
  trialId: String,
  country: String,
  lang: String,
  props: { type: mongoose.Schema.Types.Mixed },
  at: { type: Date, default: Date.now },
}, { collection: 'trial_call_events', versionKey: false });
trialEventSchema.index({ at: 1 }, { expireAfterSeconds: RETENTION });

/** État global : pause automatique de la carte d'essai (détection d'anomalie), reprise manuelle. */
const trialStateSchema = new mongoose.Schema({
  _id: { type: String, default: 'global' },
  paused: { type: Boolean, default: false },
  reason: String,
  pausedAt: Date,
  resumedAt: Date,
}, { collection: 'trial_call_state', versionKey: false });

const model = (name, schema) => mongoose.models[name] || mongoose.model(name, schema);
export const TrialCall = model('TrialCall', trialCallSchema);
export const TrialOtp = model('TrialOtp', trialOtpSchema);
export const TrialLookup = model('TrialLookup', trialLookupSchema);
export const TrialEvent = model('TrialEvent', trialEventSchema);
export const TrialState = model('TrialState', trialStateSchema);
