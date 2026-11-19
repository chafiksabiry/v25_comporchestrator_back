import crypto from 'crypto';
import { xmlEscape } from './inboundFlow.js';
import { normalizeDestination, buildRefusalTwiml, buildCallbackTwiml } from './voicemailCallback.js';
import { isPremiumRate } from './outboundDestinations.js';
import { languageForPhone } from './companyLanguage.js';
import { graceLimitSeconds } from './minutesGrace.js';

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
  return to && !isPremiumRate(to) && prefixes.some((p) => to.startsWith(p)) ? to : '';
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

/** Refus avant l'appel quand le solde de minutes est épuisé (code stable ; un seul nom, pour tous les endpoints). Messages EN. */
export const MINUTES_INSUFFICIENT_CODE = 'MINUTES_INSUFFICIENT_FOR_DESTINATION';
export const MINUTES_INSUFFICIENT_MESSAGE = 'You have no minutes for this destination. Top up in the web app.';

/** Les secrétaires peuvent-elles appeler ? Autorisé par défaut (réglage absent ou ancien document). */
export const secretaryOutboundAllowed = (settings) => settings?.secretaryOutbound !== false;

/**
 * Durée maximale (secondes) d'un appel pour ce solde de minutes : minutes entières × 60, 4 h au plus ; 0 si le solde ne
 * couvre pas une minute entière (toute minute commencée est facturée en entier).
 */
export function maxSecondsForBalance(minutes, options) {
  const whole = Math.floor(Number(minutes));
  // `options.creditFactor` : crédits débités par minute (appel international : coefficient N ; sinon 1). Minutes entières affordables = solde / N.
  // Un objet d'options (et non un nombre) pour rester sûr avec `.map(maxSecondsForBalance)`, qui passe l'indice en second argument.
  const creditFactor = typeof options?.creditFactor === 'number' ? options.creditFactor : 1;
  const affordable = creditFactor > 1 ? Math.floor(whole / creditFactor) : whole;
  return affordable >= 1 ? Math.min(affordable * 60, MAX_CALL_SECONDS) : 0;
}

/**
 * Messages PARLÉS des refus du webhook sortant (le TwiML ne peut porter aucun code). Anglais par défaut (`line_not_assigned` et `line_busy`, déjà
 * contractuellement anglais, ne sont qu'en anglais) ; français et espagnol selon la langue
 * de la ligne appelante ; toute autre langue (ou ligne inconnue) : anglais.
 */
export const SPOKEN_REFUSALS = Object.freeze({
  en: {
    not_authorized: 'Call not authorized.',
    number_not_allowed: 'Number not allowed.',
    no_subscription: 'No active subscription.',
    no_line: 'No line is available to place the call.',
    insufficient_minutes: 'Insufficient minutes balance.',
    insufficient_minutes_international: 'Insufficient balance for an international call: 1 minute = {credits} credits.',
    error: 'An error occurred.',
    secretary_outbound_disabled: 'The account owner has turned off outbound calls for secretaries.',
    invalid_number: 'Invalid number. Enter it in international format.',
    premium_rate: 'Premium-rate and value-added numbers cannot be called.',
    unknown_country: 'Calls to this country are not supported.',
    country_not_enabled: 'Calls to this country are not enabled for your company.',
    line_not_assigned: 'No line is assigned to you. Ask the account owner to assign you one.',
    line_busy: 'All lines are busy. Please try again in a moment.',
  },
  fr: {
    not_authorized: 'Appel non autorisé.',
    number_not_allowed: 'Numéro non autorisé.',
    no_subscription: 'Aucun abonnement actif.',
    no_line: 'Aucune ligne disponible pour appeler.',
    insufficient_minutes: 'Solde de minutes insuffisant.',
    insufficient_minutes_international: 'Solde insuffisant pour un appel international : 1 minute = {credits} crédits.',
    error: 'Une erreur est survenue.',
    secretary_outbound_disabled: SECRETARY_OUTBOUND_BLOCKED,
    invalid_number: 'Numéro invalide. Saisissez-le au format international.',
    premium_rate: 'Les numéros surtaxés ou à valeur ajoutée ne peuvent pas être appelés.',
    unknown_country: 'Les appels vers ce pays ne sont pas pris en charge.',
    country_not_enabled: 'Les appels vers ce pays ne sont pas activés pour votre entreprise.',
  },
  es: {
    not_authorized: 'Llamada no autorizada.',
    number_not_allowed: 'Número no permitido.',
    no_subscription: 'No hay ninguna suscripción activa.',
    no_line: 'No hay ninguna línea disponible para llamar.',
    insufficient_minutes: 'Saldo de minutos insuficiente.',
    insufficient_minutes_international: 'Saldo insuficiente para una llamada internacional: 1 minuto = {credits} créditos.',
    error: 'Se ha producido un error.',
    secretary_outbound_disabled: 'El titular de la cuenta ha desactivado las llamadas salientes para las secretarias.',
    invalid_number: 'Número no válido. Introdúzcalo en formato internacional.',
    premium_rate: 'No se pueden llamar a números de tarifa premium ni de valor añadido.',
    unknown_country: 'No se admiten llamadas a este país.',
    country_not_enabled: 'Las llamadas a este país no están activadas para su empresa.',
  },
});
const SPOKEN_VOICES = Object.freeze({ en: ['en-US', 'Polly.Joanna'], fr: ['fr-FR', 'Polly.Lea'], es: ['es-ES', 'Polly.Lucia'] });

/** Texte unique (par langue) du refus « solde insuffisant pour un appel international : 1 minute = N crédits », pour TOUS les canaux. */
export const internationalInsufficientText = (lang, credits) => (SPOKEN_REFUSALS[lang] || SPOKEN_REFUSALS.en).insufficient_minutes_international.replace('{credits}', String(credits ?? ''));

/** Langue parlée du refus d'après le numéro de la ligne appelante : fr / es si c'est celle de son pays, sinon anglais (ligne absente ou illisible comprise). */
export function spokenLanguage(linePhone) {
  const lang = languageForPhone(linePhone, 'en');
  return lang === 'fr' || lang === 'es' ? lang : 'en';
}

/** TwiML de refus parlé : clé de refus (voir SPOKEN_REFUSALS), langue (en par défaut). Clé inconnue : message d'erreur générique. */
export function spokenRefusal(key, language = 'en', params = {}) {
  const lang = SPOKEN_REFUSALS[language] ? language : 'en';
  const text = (SPOKEN_REFUSALS[lang][key] || SPOKEN_REFUSALS[lang].error).replace('{credits}', String(params?.credits ?? ''));
  const [voiceLanguage, voice] = SPOKEN_VOICES[lang];
  return buildRefusalTwiml(text, { language: voiceLanguage, voice });
}

/**
 * Décision de numérotation, sans accès réseau : renvoie la consigne TwiML à donner à Twilio.
 * `line` est la ligne Twilio de l'entreprise utilisée comme numéro appelant ; `minutes` le solde de minutes.
 */
export function decideOutboundCall({ to, line, subscribed, minutes, recording = null, action = null, creditFactor = 1 }) {
  if (!to) return { ok: false, message: 'Numéro non autorisé.', key: 'number_not_allowed' };
  if (!subscribed) return { ok: false, message: 'Aucun abonnement actif.', key: 'no_subscription' };
  if (!line) return { ok: false, message: 'Aucune ligne disponible pour appeler.', key: 'no_line' };
  // Toute minute commencée est facturée en entier : il faut au moins une minute entière pour démarrer. Quand les minutes entières du
  // solde sont écoulées, 5 minutes de grâce gratuites (B.1), puis coupure : `maxSeconds` = secondes couvertes par le solde,
  // `limitSeconds` = couvertes + grâce (timeLimit du <Dial>, filet natif de Twilio ; le serveur coupe aussi à l'échéance enregistrée).
  const maxSeconds = maxSecondsForBalance(minutes, { creditFactor });
  if (!maxSeconds) {
    // Appel international à N crédits la minute : le solde ne couvre pas une minute internationale (message clair avec N).
    return creditFactor > 1
      ? { ok: false, message: internationalInsufficientText('fr', creditFactor), key: 'insufficient_minutes_international', creditFactor }
      : { ok: false, message: 'Solde de minutes insuffisant.', key: 'insufficient_minutes' };
  }
  const limitSeconds = graceLimitSeconds(maxSeconds);
  return { ok: true, maxSeconds, limitSeconds, twiml: buildCallbackTwiml({ callerId: line.phoneNumber, to, maxSeconds: limitSeconds, recording, action }) };
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
