import crypto from 'crypto';
import { xmlEscape } from './inboundFlow.js';
import { normalizeDestination, buildRefusalTwiml, buildCallbackTwiml } from './voicemailCallback.js';

/**
 * Appel SORTANT depuis le navigateur (clavier de « Mon poste » de Nomad Solo).
 *
 * Le jeton vocal ne suffit pas : sans `outgoingApplicationSid`, Twilio refuse tout appel sortant du navigateur. Ce module
 * fournit l'application TwiML qui reçoit l'appel, la preuve signée délivrée avec le jeton (le serveur sait ainsi pour
 * quelle entreprise et quelle personne le jeton a été émis) et la consigne de numérotation. Le navigateur n'est jamais
 * cru sur l'entreprise : seule la preuve signée compte. La destination est limitée (France par défaut).
 */
export const OUTBOUND_APP_NAME = 'harx-callcentre-outbound';
export const OUTBOUND_WEBHOOK_PATH = '/api/phone-numbers/webhooks/twilio/browser-outbound';
/** Même durée que le jeton vocal (1 h) : la preuve doit rester valable aussi longtemps que lui. */
export const OUTBOUND_TICKET_TTL_MS = 60 * 60 * 1000;
/** Préfixes de destination autorisés ; OUTBOUND_ALLOWED_PREFIXES (liste séparée par des virgules) les remplace. */
export const DEFAULT_ALLOWED_PREFIXES = ['+33'];
/** Plafond de Twilio pour timeLimit (4 h). */
export const MAX_CALL_SECONDS = 14400;

export function allowedPrefixes(env = process.env.OUTBOUND_ALLOWED_PREFIXES) {
  const list = String(env ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => /^\+\d{1,4}$/.test(p));
  return list.length ? list : DEFAULT_ALLOWED_PREFIXES;
}

/** Numéro E.164 à composer, ou '' s'il est invalide ou hors des destinations autorisées. */
export function normalizeOutboundDestination(raw, prefixes = allowedPrefixes()) {
  const to = normalizeDestination(raw);
  return to && prefixes.some((p) => to.startsWith(p)) ? to : '';
}

const mac = (secret, companyId, identity, expiresAt, secretary = false) =>
  crypto.createHmac('sha256', String(secret)).update(`outbound${secretary ? '.secretary' : ''}.${companyId}.${identity}.${expiresAt}`).digest('hex');

/**
 * Preuve que cette personne (identity) a le droit d'appeler au nom de cette entreprise : délivrée avec le jeton.
 * `secretary` : la personne est une secrétaire (rôle `agent`). Le rôle est scellé dans la preuve pour que le serveur
 * puisse, au moment de composer, relire le réglage « les secrétaires peuvent appeler » sans croire le navigateur.
 */
export function signOutboundTicket({ secret, companyId, identity, now = Date.now(), secretary = false }) {
  const expiresAt = now + OUTBOUND_TICKET_TTL_MS;
  return `${expiresAt}.${mac(secret, companyId, identity, expiresAt, secretary === true)}`;
}

/** Rôle scellé dans la preuve : 'secretary', 'standard', ou null si la preuve est invalide ou périmée. */
export function outboundTicketRole({ secret, companyId, identity, ticket, now = Date.now() }) {
  const [exp, sig] = String(ticket ?? '').split('.');
  const expiresAt = Number(exp);
  if (!secret || !sig || !Number.isFinite(expiresAt) || expiresAt < now) return null;
  const a = Buffer.from(sig);
  for (const [role, secretary] of [['standard', false], ['secretary', true]]) {
    const b = Buffer.from(mac(secret, String(companyId), String(identity), expiresAt, secretary));
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return role;
  }
  return null;
}

export function verifyOutboundTicket(args) {
  return outboundTicketRole(args) !== null;
}

/** Message donné quand le titulaire a interdit les appels sortants aux secrétaires. */
export const SECRETARY_OUTBOUND_BLOCKED = 'Le responsable a désactivé les appels sortants pour les secrétaires.';

/** Les secrétaires peuvent-elles appeler ? Autorisé par défaut (réglage absent ou ancien document). */
export const secretaryOutboundAllowed = (settings) => settings?.secretaryOutbound !== false;

/**
 * Durée maximale (secondes) d'un appel pour ce solde de minutes : minutes entières × 60, 4 h au plus ; 0 si le solde ne
 * couvre pas une minute entière (toute minute commencée est facturée en entier).
 */
export function maxSecondsForBalance(minutes) {
  const whole = Math.floor(Number(minutes));
  return whole >= 1 ? Math.min(whole * 60, MAX_CALL_SECONDS) : 0;
}

/**
 * Décision de numérotation, sans accès réseau : renvoie la consigne TwiML à donner à Twilio.
 * `line` est la ligne Twilio de l'entreprise utilisée comme numéro appelant ; `minutes` le solde de minutes.
 */
export function decideOutboundCall({ to, line, subscribed, minutes }) {
  if (!to) return { ok: false, message: 'Numéro non autorisé.' };
  if (!subscribed) return { ok: false, message: 'Aucun abonnement actif.' };
  if (!line) return { ok: false, message: 'Aucune ligne disponible pour appeler.' };
  // Toute minute commencée est facturée en entier : il faut au moins une minute entière, et l'appel est coupé quand
  // les minutes entières du solde sont écoulées, pour que le solde ne passe jamais sous zéro.
  const maxSeconds = maxSecondsForBalance(minutes);
  if (!maxSeconds) return { ok: false, message: 'Solde de minutes insuffisant.' };
  return { ok: true, maxSeconds, twiml: buildCallbackTwiml({ callerId: line.phoneNumber, to, maxSeconds }) };
}

/**
 * Solde de minutes À JOUR avant de décider d'un appel sortant. Le débit d'un appel n'a lieu qu'à la lecture du solde
 * (syncMinutesFromCalls) et l'octroi des minutes de la période aussi (ensurePlanMinutesGranted) : lire le portefeuille
 * brut, comme le faisait le webhook, décidait sur un solde périmé tant que personne n'avait relu le solde.
 * `sync` / `grant` / `readWallet` sont injectés ; un échec de mise à jour n'empêche pas la lecture (solde alors périmé).
 */
export async function freshMinutesBalance(companyId, { sync, grant, readWallet }) {
  try { await grant(companyId); } catch (e) { console.warn('[browser-outbound] octroi des minutes ignoré:', e?.message || e); }
  try { await sync(companyId); } catch (e) { console.warn('[browser-outbound] débit des appels ignoré:', e?.message || e); }
  const wallet = await readWallet(companyId);
  return wallet?.minutes;
}

export const refusal = buildRefusalTwiml;
export { xmlEscape };

/**
 * Application TwiML des appels sortants du navigateur : retrouvée par son nom, créée si elle n'existe pas, pointée sur
 * le webhook de ce serveur. TWILIO_OUTBOUND_TWIML_APP_SID force une application existante.
 */
let cachedAppSid = null;
export async function ensureOutboundApp(client, voiceUrl) {
  if (process.env.TWILIO_OUTBOUND_TWIML_APP_SID) return process.env.TWILIO_OUTBOUND_TWIML_APP_SID;
  if (cachedAppSid) return cachedAppSid;
  const [existing] = await client.applications.list({ friendlyName: OUTBOUND_APP_NAME, limit: 1 });
  let app = existing;
  if (!app) app = await client.applications.create({ friendlyName: OUTBOUND_APP_NAME, voiceUrl, voiceMethod: 'POST' });
  else if (app.voiceUrl !== voiceUrl) app = await client.applications(app.sid).update({ voiceUrl, voiceMethod: 'POST' });
  cachedAppSid = app.sid;
  return cachedAppSid;
}
