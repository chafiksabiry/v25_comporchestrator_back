import twilio from 'twilio';
import { signingKey } from '../voiceTokenService.js';

/**
 * Jeton vocal de l'appel d'essai : VARIANTE de createVoiceToken (voiceTokenService.js, inchangé) — même clé de signature, mais
 * durée de vie courte (120 s), AUCUN appel entrant (incomingAllow: false) et seulement l'application TwiML dédiée à l'essai.
 */
export async function createTrialVoiceToken({ client, accountSid, identity, outgoingApplicationSid, ttl }) {
  const key = await signingKey(client);
  const { AccessToken } = twilio.jwt;
  const token = new AccessToken(accountSid, key.sid, key.secret, { identity, ttl });
  token.addGrant(new AccessToken.VoiceGrant({ incomingAllow: false, outgoingApplicationSid }));
  return token.toJwt();
}
