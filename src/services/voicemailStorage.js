import { createHash } from 'node:crypto';
import Voicemail from '../models/Voicemail.js';
import VoicemailAudio from '../models/VoicemailAudio.js';
import { config } from '../config/env.js';
import { isTwilioRecordingUrl } from './voicemailMapping.js';

const DOWNLOAD_TIMEOUT_MS = 30 * 1000;
const MAX_BYTES = 8 * 1024 * 1024;

const cloudinaryConf = () => ({
  cloud: process.env.CLOUDINARY_CLOUD_NAME,
  key: process.env.CLOUDINARY_API_KEY,
  secret: process.env.CLOUDINARY_API_SECRET,
});
export const cloudinaryEnabled = () => { const c = cloudinaryConf(); return Boolean(c.cloud && c.key && c.secret); };

/** Signature Cloudinary : paramètres triés, concaténés, suivis du secret, hachés en SHA-1. */
export function signCloudinary(params, secret) {
  const base = Object.keys(params).filter((k) => params[k] !== undefined && params[k] !== '').sort().map((k) => `${k}=${params[k]}`).join('&');
  return createHash('sha1').update(base + secret).digest('hex');
}

/** Dépose l'audio dans Cloudinary en accès privé (jamais d'URL publique : ce sont des messages de clients). */
export async function uploadToCloudinary(voicemailId, data) {
  const { cloud, key, secret } = cloudinaryConf();
  const params = { folder: 'harx/callcentre/voicemails', public_id: String(voicemailId), type: 'private', timestamp: Math.floor(Date.now() / 1000) };
  const form = new FormData();
  for (const [k, v] of Object.entries(params)) form.append(k, String(v));
  form.append('api_key', key);
  form.append('signature', signCloudinary(params, secret));
  form.append('file', new Blob([data], { type: 'audio/mpeg' }), `${voicemailId}.mp3`);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/video/upload`, { method: 'POST', body: form, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.public_id) throw new Error(`cloudinary upload status ${res.status} ${body?.error?.message || ''}`.trim());
  return body.public_id;
}

/** Relit un audio privé de Cloudinary par l'URL de téléchargement signée de l'API. */
export async function downloadFromCloudinary(publicId) {
  const { cloud, key, secret } = cloudinaryConf();
  const params = { public_id: publicId, format: 'mp3', type: 'private', timestamp: Math.floor(Date.now() / 1000) };
  const qs = new URLSearchParams({ ...params, api_key: key, signature: signCloudinary(params, secret) });
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/video/download?${qs}`, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`cloudinary download status ${res.status}`);
  const audio = Buffer.from(await res.arrayBuffer());
  if (!audio.length) throw new Error('empty cloudinary audio');
  return audio;
}

const basicAuth = () => `Basic ${Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString('base64')}`;

/** Télécharge l'enregistrement chez Twilio (uniquement depuis api.twilio.com : nos identifiants ne partent jamais ailleurs). */
export async function downloadFromTwilio(recordingUrl) {
  if (!isTwilioRecordingUrl(recordingUrl)) throw new Error('invalid recording url');
  const res = await fetch(`${recordingUrl}.mp3`, { headers: { Authorization: basicAuth() }, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`recording download status ${res.status}`);
  const audio = Buffer.from(await res.arrayBuffer());
  if (!audio.length) throw new Error('empty recording');
  if (audio.length > MAX_BYTES) throw new Error('recording too large');
  return audio;
}

/** Supprime l'enregistrement chez Twilio : plus de frais de stockage, HARX garde sa propre copie. */
export async function deleteTwilioRecording(recordingUrl) {
  if (!isTwilioRecordingUrl(recordingUrl)) throw new Error('invalid recording url');
  const res = await fetch(`${recordingUrl}.json`, { method: 'DELETE', headers: { Authorization: basicAuth() }, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok && res.status !== 404) throw new Error(`recording delete status ${res.status}`);
}

/**
 * Rapatrie le message chez HARX (copie en base), puis supprime l'original chez Twilio.
 * Ne lève jamais d'exception ; renvoie true quand HARX détient l'audio.
 */
export async function ingestRecording(voicemailId) {
  try {
    const vm = await Voicemail.findById(voicemailId).lean();
    if (!vm) return false;
    if (!vm.audioStored) {
      const data = await downloadFromTwilio(vm.recordingUrl);
      let publicId = '';
      if (cloudinaryEnabled()) {
        try { publicId = await uploadToCloudinary(vm._id, data); }
        catch (e) { console.error(`[voicemailStorage] ${vm.recordingSid} Cloudinary indisponible, copie en base: ${e.message}`); }
      }
      // Sans Cloudinary (ou en cas d'échec), HARX garde l'audio en base plutôt que de le perdre.
      if (!publicId) await VoicemailAudio.updateOne({ voicemailId: vm._id }, { $set: { data, mime: 'audio/mpeg', size: data.length } }, { upsert: true });
      await Voicemail.updateOne({ _id: vm._id }, { $set: { audioStored: true, cloudinaryPublicId: publicId } });
    }
    if (!vm.twilioRecordingDeleted) {
      try {
        await deleteTwilioRecording(vm.recordingUrl);
        await Voicemail.updateOne({ _id: vm._id }, { $set: { twilioRecordingDeleted: true } });
      } catch (e) {
        console.error(`[voicemailStorage] ${vm.recordingSid} suppression chez Twilio impossible: ${e.message}`);
      }
    }
    return true;
  } catch (error) {
    console.error(`[voicemailStorage] ${voicemailId} rapatriement impossible: ${error.name}: ${error.message}`);
    return false;
  }
}

/** Audio du message : Cloudinary, sinon la copie en base, sinon (anciens messages) l'enregistrement encore chez Twilio. */
export async function loadAudio(vm) {
  if (vm.cloudinaryPublicId) return downloadFromCloudinary(vm.cloudinaryPublicId);
  const stored = await VoicemailAudio.findOne({ voicemailId: vm._id });
  if (stored?.data?.length) return Buffer.from(stored.data);
  return downloadFromTwilio(vm.recordingUrl);
}
