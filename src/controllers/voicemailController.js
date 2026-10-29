import mongoose from 'mongoose';
import Voicemail from '../models/Voicemail.js';
import { analyzeVoicemail, getTokensBalance, MIN_TOKENS } from '../services/voicemailAnalysis.js';
import { ingestRecording, loadAudio } from '../services/voicemailStorage.js';
import { PhoneNumber } from '../models/PhoneNumber.js';
import { config } from '../config/env.js';
import { phoneNumberService } from '../services/phoneNumberService.js';
import { createVoiceToken } from '../services/voiceTokenService.js';
import { voiceIdentity } from '../services/voicePresenceService.js';
import { buildCallbackTwiml, buildRefusalTwiml, CALLBACK_WEBHOOK_PATH, ensureCallbackApp, pickDestination, signTicket, verifyTicket } from '../services/voicemailCallback.js';

const FOLLOW_UPS = ['new', 'to_call', 'called', 'closed'];
const validId = (v) => mongoose.Types.ObjectId.isValid(String(v)) && String(v).length === 24;
const fail = (res, status, message) => res.status(status).json({ success: false, error: message, message });

export const toItem = (v) => ({
  id: String(v._id),
  from: v.from,
  to: v.phoneNumber,
  gigId: v.gigId ? String(v.gigId) : null,
  createdAt: v.createdAt,
  durationSeconds: v.durationSeconds,
  listened: Boolean(v.listenedAt),
  followUpStatus: v.followUpStatus,
  note: v.note || '',
  analysisStatus: v.analysisStatus,
  analysis: v.analysisStatus === 'done' && v.analysis ? v.analysis : null,
});

/** Ligne Twilio de l'entreprise qui a reçu le message ; null si elle n'existe plus ou n'est pas chez Twilio. */
async function callbackLine(voicemail) {
  if (!voicemail.phoneNumber) return null;
  const line = await PhoneNumber.findOne({ phoneNumber: voicemail.phoneNumber, companyId: voicemail.companyId }).lean();
  if (!line) return null;
  const provider = String(line.provider || (line.twilioId ? 'twilio' : '')).toLowerCase();
  return provider === 'twilio' ? line : null;
}

export const voicemailController = {
  async list(req, res) {
    try {
      const { companyId, status } = req.query || {};
      if (!validId(companyId)) return fail(res, 400, 'companyId invalide.');
      if (status !== undefined && !FOLLOW_UPS.includes(status)) return fail(res, 400, 'Statut de suivi invalide.');
      const limit = Math.min(200, Math.max(1, Math.floor(Number(req.query.limit)) || 50));
      const filter = { companyId };
      if (status) filter.followUpStatus = status;
      const cid = new mongoose.Types.ObjectId(companyId);
      const [rows, unlistened, toCall, total] = await Promise.all([
        Voicemail.find(filter).sort({ createdAt: -1 }).limit(limit).lean(),
        Voicemail.countDocuments({ companyId: cid, listenedAt: null }),
        Voicemail.countDocuments({ companyId: cid, followUpStatus: 'to_call' }),
        Voicemail.countDocuments({ companyId: cid }),
      ]);
      res.json({ success: true, data: { items: rows.map(toItem), counts: { unlistened, toCall, total } } });
    } catch (error) {
      console.error('voicemails list:', error.message);
      fail(res, 500, 'Lecture du répondeur impossible.');
    }
  },

  async audio(req, res) {
    try {
      const vm = validId(req.params.id) ? await Voicemail.findById(req.params.id).lean() : null;
      if (!vm) return fail(res, 404, 'Message introuvable.');
      // Copie conservée par HARX ; les anciens messages se relisent encore depuis Twilio.
      const audio = await loadAudio(vm);
      if (!vm.listenedAt) await Voicemail.updateOne({ _id: vm._id, listenedAt: null }, { $set: { listenedAt: new Date() } });
      res.set('Content-Type', 'audio/mpeg');
      res.set('Cache-Control', 'private, no-store');
      res.set('Content-Length', String(audio.length));
      res.end(audio);
    } catch (error) {
      console.error('voicemails audio:', error.name, error.message);
      if (!res.headersSent) fail(res, 502, 'Enregistrement indisponible.');
    }
  },

  async patch(req, res) {
    try {
      const vm = validId(req.params.id) ? await Voicemail.findById(req.params.id) : null;
      if (!vm) return fail(res, 404, 'Message introuvable.');
      const { followUpStatus, note } = req.body || {};
      if (followUpStatus !== undefined && !FOLLOW_UPS.includes(followUpStatus)) return fail(res, 400, 'Statut de suivi invalide.');
      if (note !== undefined && (typeof note !== 'string' || note.length > 1000)) return fail(res, 400, 'La note doit être un texte de 1000 caractères maximum.');
      if (followUpStatus !== undefined) vm.followUpStatus = followUpStatus;
      if (note !== undefined) vm.note = note;
      if (followUpStatus !== undefined || note !== undefined) vm.handledBy = String(req.user?.userId || req.user?.id || '') || null;
      await vm.save();
      res.json({ success: true, data: toItem(vm.toObject()) });
    } catch (error) {
      console.error('voicemails patch:', error.message);
      fail(res, 500, 'Mise à jour du message impossible.');
    }
  },

  async analyze(req, res) {
    try {
      const vm = validId(req.params.id) ? await Voicemail.findById(req.params.id) : null;
      if (!vm) return fail(res, 404, 'Message introuvable.');
      if ((await getTokensBalance(vm.companyId)) < MIN_TOKENS) {
        vm.analysisStatus = 'needs_tokens';
        await vm.save();
        return res.status(402).json({ success: false, error: 'insufficient_tokens', message: `Solde de jetons insuffisant (minimum ${MIN_TOKENS}).`, data: toItem(vm.toObject()) });
      }
      vm.analysisStatus = 'pending';
      await vm.save();
      ingestRecording(vm._id).then(() => analyzeVoicemail(vm._id)).catch((e) => console.error('analyzeVoicemail:', e.message));
      res.status(202).json({ success: true, data: toItem(vm.toObject()) });
    } catch (error) {
      console.error('voicemails analyze:', error.message);
      fail(res, 500, "Lancement de l'analyse impossible.");
    }
  },
  /**
   * Rappel depuis le navigateur : jeton de téléphone autorisé à appeler, et preuve signée que cette personne peut rappeler
   * CE message. Le numéro composé est choisi par le serveur (webhook), jamais envoyé par le navigateur.
   */
  async callbackToken(req, res) {
    try {
      const userId = req.user?.userId || req.user?.id;
      if (!userId) return fail(res, 401, 'Authentification requise.');
      if (!validId(req.params.id)) return fail(res, 400, 'Identifiant invalide.');
      const vm = await Voicemail.findById(req.params.id).lean();
      if (!vm) return fail(res, 404, 'Message introuvable.');
      const to = pickDestination(vm);
      if (!to) return fail(res, 422, 'Aucun numéro à rappeler : l’appelant n’a pas laissé de numéro exploitable.');
      const line = await callbackLine(vm);
      if (!line) return fail(res, 422, 'Le rappel n’est disponible que depuis une ligne Twilio de votre centre : la ligne qui a reçu ce message est introuvable.');
      if (!config.twilioAccountSid || !config.twilioAuthToken) return fail(res, 500, 'La configuration téléphonie du serveur est incomplète.');
      const client = phoneNumberService.twilioClient;
      const appSid = await ensureCallbackApp(client, `https://${req.get('host')}${CALLBACK_WEBHOOK_PATH}`);
      const identity = voiceIdentity(userId);
      const token = await createVoiceToken({ client, accountSid: config.twilioAccountSid, identity, outgoingApplicationSid: appSid });
      const voicemailId = String(vm._id);
      const ticket = signTicket({ secret: config.twilioAuthToken, voicemailId, identity });
      res.json({ success: true, data: { token, identity, params: { VoicemailId: voicemailId, Ticket: ticket }, from: line.phoneNumber, to } });
    } catch (error) {
      console.error('[voicemail] callbackToken failed:', error.message);
      fail(res, 500, 'Le téléphone du navigateur n’est pas disponible pour le moment.');
    }
  },

  /** Webhook Twilio de l'application de rappel : compose le numéro du message depuis la ligne qui l'a reçu, si la preuve est valide. */
  async callbackVoice(req, res) {
    const send = (xml) => res.type('text/xml').status(200).send(xml);
    try {
      const { VoicemailId, Ticket, From } = req.body || {};
      const identity = String(From || '').replace(/^client:/, '');
      if (!validId(VoicemailId) || !verifyTicket({ secret: config.twilioAuthToken, voicemailId: String(VoicemailId), identity, ticket: Ticket })) {
        return send(buildRefusalTwiml('Rappel non autorisé.'));
      }
      const vm = await Voicemail.findById(VoicemailId).lean();
      const to = vm ? pickDestination(vm) : '';
      const line = vm ? await callbackLine(vm) : null;
      if (!vm || !to || !line) return send(buildRefusalTwiml('Impossible de rappeler ce numéro.'));
      return send(buildCallbackTwiml({ callerId: line.phoneNumber, to }));
    } catch (error) {
      console.error('[voicemail] callbackVoice failed:', error.message);
      return send(buildRefusalTwiml('Une erreur est survenue.'));
    }
  },
};
