import webpush from 'web-push';
import PushSubscription from '../models/PushSubscription.js';

/**
 * Notifications Web Push (VAPID). Les clés viennent UNIQUEMENT de l'environnement :
 * VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT. Sans elles, la fonction est désactivée proprement.
 * Une notification réveille l'utilisateur ; elle ne peut pas décrocher l'appel Twilio.
 */
export const PUSH_UNAVAILABLE_MESSAGE = 'Notifications indisponibles pour le moment.';

/** Services de notification des navigateurs : on refuse tout autre point d'arrivée (le serveur ne contacte que ceux-là). */
export const PUSH_HOST_SUFFIXES = ['fcm.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];

export function vapidConfig(env = process.env) {
  const publicKey = String(env.VAPID_PUBLIC_KEY || '').trim();
  const privateKey = String(env.VAPID_PRIVATE_KEY || '').trim();
  const subject = String(env.VAPID_SUBJECT || '').trim();
  if (!publicKey || !privateKey || !/^(mailto:|https:\/\/)/i.test(subject)) return null;
  return { publicKey, privateKey, subject };
}

export const pushAvailable = (env = process.env) => vapidConfig(env) !== null;

const isString = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

export function isAllowedEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    if (u.protocol !== 'https:' || u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    return PUSH_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
  } catch {
    return false;
  }
}

/** Valide un objet `PushSubscription` du navigateur (toJSON). */
export function validateSubscription(sub) {
  const errors = [];
  if (!sub || typeof sub !== 'object') return { ok: false, errors: ['Abonnement manquant.'], value: null };
  if (!isString(sub.endpoint, 2048) || !isAllowedEndpoint(sub.endpoint)) errors.push("Point d'arrivée de notification non reconnu.");
  if (!isString(sub.keys?.p256dh, 256) || !isString(sub.keys?.auth, 128)) errors.push('Clés de l’abonnement manquantes.');
  return errors.length ? { ok: false, errors, value: null } : { ok: true, errors, value: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } } };
}

export const callPayload = ({ from = '', to = '', callSid = '' } = {}) => ({
  kind: 'call',
  title: 'Appel entrant sur votre ligne',
  body: `${from || 'Numéro masqué'}${to ? ` → ${to}` : ''}. Touchez pour répondre ; sinon votre mobile sonne si le renvoi est activé.`,
  tag: callSid ? `call-${callSid}` : 'call',
  url: '/app/calls',
});

export const voicemailPayload = ({ from = '', durationSeconds = 0, recordingSid = '' } = {}) => ({
  kind: 'voicemail',
  title: 'Nouveau message sur le répondeur',
  body: `${from || 'Numéro masqué'}${durationSeconds ? ` · ${durationSeconds} s` : ''}`,
  tag: recordingSid ? `voicemail-${recordingSid}` : 'voicemail',
  url: '/app/voicemails',
});

/** Message pris à l'accueil, urgent (prise du message) ou relancé : le contenu du message reste dans l'application, la notification n'en dit que l'essentiel. */
export const messagePayload = ({ callerName = '', urgent = false, reminder = false, id = '' } = {}) => ({
  kind: 'message',
  title: reminder ? 'Rappel : un message vous attend' : urgent ? 'Message URGENT pour vous' : 'Un message a été pris pour vous',
  body: `${String(callerName).slice(0, 80) || 'Un appelant'} vous demande. Touchez pour ouvrir « Demandes à traiter ».`,
  tag: id ? `message-${id}${reminder ? '-reminder' : ''}` : 'message',
  url: '/app/followups',
});

/**
 * Envoie `payload` à ces abonnements. Renvoie les compteurs et les points d'arrivée à supprimer (404/410 : abonnement expiré).
 * `client` : bibliothèque web-push (simulée dans les tests).
 */
export async function sendToSubscriptions(subscriptions, payload, { client = webpush, env = process.env } = {}) {
  const vapid = vapidConfig(env);
  const result = { sent: 0, failed: 0, gone: [], ok: [], skipped: !vapid };
  if (!vapid) return result;
  const body = JSON.stringify(payload);
  for (const sub of subscriptions) {
    try {
      await client.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body, {
        vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
        TTL: payload.kind === 'call' ? 60 : 24 * 3600,
        urgency: 'high',
      });
      result.sent += 1;
      result.ok.push(sub.endpoint);
    } catch (e) {
      result.failed += 1;
      if (e?.statusCode === 404 || e?.statusCode === 410) result.gone.push(sub.endpoint);
      else console.error('[push] envoi échoué:', e?.statusCode || '', String(e?.message || '').slice(0, 120));
    }
  }
  return result;
}

/** Abonnements des titulaires d'un centre ou d'un utilisateur, envoi, puis nettoyage des abonnements expirés. Ne lève jamais. */
export async function notifyOwners({ companyId, userId } = {}, payload, { client, env = process.env, store = PushSubscription } = {}) {
  try {
    if (!pushAvailable(env)) return { sent: 0, failed: 0, gone: [], ok: [], skipped: true };
    const filter = userId ? { userId: String(userId) } : { companyId, role: 'owner' };
    const subs = await store.find(filter).lean();
    if (!subs.length) return { sent: 0, failed: 0, gone: [], ok: [], skipped: false };
    const result = await sendToSubscriptions(subs, payload, { client, env });
    if (result.gone.length) await store.deleteMany({ endpoint: { $in: result.gone } });
    if (result.ok.length) await store.updateMany({ endpoint: { $in: result.ok } }, { $set: { lastSuccessAt: new Date() } });
    return result;
  } catch (e) {
    console.error('[push] notification non envoyée:', e.message);
    return { sent: 0, failed: 0, gone: [], ok: [], skipped: false, error: true };
  }
}
