import twilio from 'twilio';
import mongoose from 'mongoose';

/**
 * Jeton d'accès Twilio Voice pour le téléphone du navigateur (réception des appels entrants).
 * Twilio signe ces jetons avec une clé d'API : elle est créée une seule fois avec le compte, puis conservée en base.
 */
const keySchema = new mongoose.Schema({ sid: String, secret: String, createdAt: { type: Date, default: Date.now } });
const VoiceSigningKey = mongoose.models.VoiceSigningKey || mongoose.model('VoiceSigningKey', keySchema, 'voice_signing_keys');

export const VOICE_TOKEN_TTL_S = 3600;

let cached = null;

export async function signingKey(client) {
  if (cached) return cached;
  let doc = await VoiceSigningKey.findOne().lean();
  if (!doc) {
    const created = await client.newKeys.create({ friendlyName: 'harx-callcentre-voice' });
    doc = await VoiceSigningKey.create({ sid: created.sid, secret: created.secret });
  }
  cached = { sid: doc.sid, secret: doc.secret };
  return cached;
}

/** `outgoingApplicationSid` : autorise aussi les appels sortants du navigateur (rappels), traités par cette application TwiML. */
export async function createVoiceToken({ client, accountSid, identity, outgoingApplicationSid }) {
  const key = await signingKey(client);
  const { AccessToken } = twilio.jwt;
  const token = new AccessToken(accountSid, key.sid, key.secret, { identity, ttl: VOICE_TOKEN_TTL_S });
  token.addGrant(new AccessToken.VoiceGrant({ incomingAllow: true, ...(outgoingApplicationSid ? { outgoingApplicationSid } : {}) }));
  return token.toJwt();
}
