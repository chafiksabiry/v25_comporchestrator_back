import mongoose from 'mongoose';
import Voicemail from '../models/Voicemail.js';
import { analyzeVoicemail, getTokensBalance, MIN_TOKENS } from '../services/voicemailAnalysis.js';
import { ingestRecording, loadAudio } from '../services/voicemailStorage.js';

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
};
