import Voicemail from '../models/Voicemail.js';
import VoicemailAudio from '../models/VoicemailAudio.js';
import { config } from '../config/env.js';
import { isTwilioRecordingUrl } from './voicemailMapping.js';

const DOWNLOAD_TIMEOUT_MS = 30 * 1000;
const MAX_BYTES = 8 * 1024 * 1024;

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
      await VoicemailAudio.updateOne({ voicemailId: vm._id }, { $set: { data, mime: 'audio/mpeg', size: data.length } }, { upsert: true });
      await Voicemail.updateOne({ _id: vm._id }, { $set: { audioStored: true } });
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

/** Audio du message : la copie HARX, sinon (anciens messages) l'enregistrement encore chez Twilio. */
export async function loadAudio(vm) {
  const stored = await VoicemailAudio.findOne({ voicemailId: vm._id });
  if (stored?.data?.length) return Buffer.from(stored.data);
  return downloadFromTwilio(vm.recordingUrl);
}
