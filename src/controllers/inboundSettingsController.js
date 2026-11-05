import mongoose from 'mongoose';
import InboundSettings from '../models/InboundSettings.js';
import { KINDS, audioVersion, isMp3, toPublicSettings, validateSettingsInput } from '../services/inboundSettings.js';
import { callerAccess, ScopeError } from '../middleware/companyScope.js';
import { phoneNumberController } from './phoneNumberController.js';
import { COUNTRY_CATALOG, validatePrefixList } from '../services/outboundDestinations.js';
import { resolveOutboundPolicy } from '../services/outboundPolicy.js';

/** Pays autorisés pour les appels sortants, avec le catalogue pour les cocher (réglages du responsable). */
const outboundView = async (companyId) => {
  const p = await resolveOutboundPolicy(companyId);
  return { countries: COUNTRY_CATALOG, selected: p.prefixes, customized: p.customized, defaults: p.defaults, companyCountry: p.companyCountry };
};

const NO_BYTES = '-greetingAudio.data -voicemailAudio.data';
const validId = (v) => mongoose.Types.ObjectId.isValid(String(v)) && String(v).length === 24;
const fail = (res, status, message) => res.status(status).json({ success: false, error: message, message });

export const inboundSettingsController = {
  async get(req, res) {
    try {
      const { companyId } = req.query || {};
      if (!validId(companyId)) return fail(res, 400, 'companyId invalide.');
      const doc = await InboundSettings.findOne({ companyId }).select(NO_BYTES).lean();
      res.json({ success: true, data: { ...toPublicSettings(doc), outbound: await outboundView(companyId) } });
    } catch (error) {
      console.error('inbound-settings get:', error.message);
      fail(res, 500, "Lecture des réglages d'accueil impossible.");
    }
  },

  async put(req, res) {
    try {
      const { companyId } = req.body || {};
      if (!validId(companyId)) return fail(res, 400, 'companyId invalide.');
      const { ok, errors, value } = validateSettingsInput(req.body);
      if (!ok) return res.status(400).json({ success: false, error: errors[0], message: errors[0], errors });
      // Seul le responsable (titulaire ou membre) autorise ou interdit les appels sortants : une secrétaire ne se l'accorde pas.
      if (value.secretaryOutbound !== undefined) {
        const access = await callerAccess(req).catch((e) => { if (e instanceof ScopeError) return null; throw e; });
        if (!access || access.role === 'agent') return fail(res, 403, 'Seul le responsable peut régler les appels sortants des secrétaires.');
      }
      // Pays autorisés pour les appels sortants : liste d'indicatifs connus, ou null pour revenir au réglage par défaut.
      // Réservé au responsable (même règle que l'autorisation des secrétaires) ; validé par le serveur.
      const update = { $set: value, $setOnInsert: { companyId } };
      if (req.body.outboundPrefixes !== undefined) {
        const access = await callerAccess(req).catch((e) => { if (e instanceof ScopeError) return null; throw e; });
        if (!access || access.role === 'agent') return fail(res, 403, 'Seul le responsable peut choisir les pays autorisés pour les appels sortants.');
        if (req.body.outboundPrefixes === null) update.$unset = { outboundPrefixes: '' };
        else {
          const checked = validatePrefixList(req.body.outboundPrefixes);
          if (!checked.ok) return fail(res, 400, checked.error);
          update.$set.outboundPrefixes = checked.value;
        }
      }
      const doc = await InboundSettings.findOneAndUpdate(
        { companyId },
        update,
        { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
      ).select(NO_BYTES).lean();
      const data = { ...toPublicSettings(doc), outbound: await outboundView(companyId) };
      // Le répondeur doit fonctionner même si aucun conseiller n'est connecté : on branche les lignes tout de suite.
      if (data.voicemailEnabled) {
        const voiceUrl = `https://${req.get('host')}/api/phone-numbers/webhooks/twilio/inbound-call`;
        phoneNumberController.ensureInboundWebhook(companyId, voiceUrl).catch((e) => console.error('ensureInboundWebhook (inbound-settings):', e.message));
      }
      res.json({ success: true, data });
    } catch (error) {
      console.error('inbound-settings put:', error.message);
      fail(res, 500, "Enregistrement des réglages d'accueil impossible.");
    }
  },

  async putAudio(req, res) {
    try {
      const { companyId } = req.query || {};
      const { kind } = req.params;
      if (!validId(companyId)) return fail(res, 400, 'companyId invalide.');
      if (!KINDS.includes(kind)) return fail(res, 400, 'Type audio inconnu (greeting ou voicemail).');
      const bytes = req.body;
      if (!isMp3(bytes)) return fail(res, 400, 'Fichier audio invalide : un MP3 de plus de 1 ko est attendu.');
      const settings = await InboundSettings.findOne({ companyId }).select(NO_BYTES).lean();
      const text = settings?.[`${kind}Text`];
      if (!text) return fail(res, 409, "Enregistrez d'abord le texte correspondant dans les réglages.");
      const version = audioVersion(bytes);
      const voice = settings.voice || 'nova';
      const updated = await InboundSettings.findOneAndUpdate(
        { companyId },
        { $set: { [`${kind}Audio`]: { data: bytes, mime: 'audio/mpeg', text, voice, version }, validatedAt: new Date() } },
        { new: true }
      ).select(NO_BYTES).lean();
      res.json({ success: true, data: toPublicSettings(updated) });
    } catch (error) {
      console.error('inbound-settings putAudio:', error.message);
      fail(res, 500, "Enregistrement de l'audio impossible.");
    }
  },

  /** Public : Twilio télécharge l'audio. L'URL contient la version, donc le contenu est immuable. */
  async getAudio(req, res) {
    try {
      const { companyId, kind, version } = req.params;
      if (!validId(companyId) || !KINDS.includes(kind)) return res.status(404).end();
      const doc = await InboundSettings.findOne({ companyId }).select(`${kind}Audio`).lean();
      const audio = doc?.[`${kind}Audio`];
      if (!audio?.data || audio.version !== version) return res.status(404).end();
      const buf = Buffer.isBuffer(audio.data) ? audio.data : Buffer.from(audio.data.buffer || audio.data);
      res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Length': String(buf.length) });
      res.status(200).send(buf);
    } catch (error) {
      console.error('inbound-settings getAudio:', error.message);
      res.status(500).end();
    }
  },
};
