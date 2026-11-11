import jwt from 'jsonwebtoken';
import { sayVoice } from './companyLanguage.js';
import { xmlEscape } from './inboundFlow.js';
import { isTwilioRecordingUrl } from './voicemailMapping.js';
import { resolveDashCallsApi, SERVICE_ISSUER } from './voicemailAnalysis.js';

/**
 * Enregistrement des conversations (<Dial record>), réservé à certaines offres.
 *
 * Décision du propriétaire : enregistrés = Full Scope / Multi-clients (Call Centre) et forfaits TaaS ; JAMAIS enregistrés =
 * Nomad Solo et Accueil / Secrétariat. Liste blanche explicite, défaut = ne pas enregistrer (offre inconnue, absente, erreur).
 * Chaque appel enregistré est précédé d'une annonce vocale (consentement) ; un appel non enregistré n'entend rien de plus.
 * Module sans accès réseau sauf `attachCallRecording` (envoi de l'URL à dash_calls).
 */

/** Paliers Call Centre dont les appels sont enregistrés (valeurs canoniques de callcenterTier.js). */
export const RECORDED_CALLCENTER_TIERS = ['full_scope', 'multi_clients'];

/**
 * @param {{product: string|null, callcenterTier: string|null}|null} limits résultat de loadCompanyPlanLimits
 * Call Centre : palier de la liste blanche uniquement. Forfait sans `harx_product` (TaaS) : enregistré. Tout autre produit
 * (valeur inconnue) ou palier absent / inconnu : non enregistré.
 */
export function shouldRecordPlan(limits) {
  if (!limits || typeof limits !== 'object') return false;
  if (limits.product === 'callcenter') return RECORDED_CALLCENTER_TIERS.includes(limits.callcenterTier);
  return limits.product === null || limits.product === undefined;
}

/** Décision pour une entreprise ; toute erreur de lecture = ne pas enregistrer. `loadLimits` est injecté. */
export async function shouldRecordCompany(companyId, loadLimits) {
  if (!companyId) return false;
  try {
    return shouldRecordPlan(await loadLimits(companyId));
  } catch (e) {
    console.error('[call-recording] offre illisible, appel non enregistré:', e?.message || e);
    return false;
  }
}

// ---------------------------------------------------------------- consentement (annonce vocale)

export const CONSENT_TEXTS = {
  fr: 'Cet appel peut être enregistré pour la qualité du service et la formation. En poursuivant cet appel, vous acceptez cet enregistrement.',
  en: 'This call may be recorded for quality and training purposes. By continuing this call, you agree to being recorded.',
  es: 'Esta llamada puede ser grabada con fines de calidad y formación. Al continuar con esta llamada, acepta que se grabe.',
  ar: 'قد يتم تسجيل هذه المكالمة لأغراض الجودة والتدريب. بمتابعة هذه المكالمة، فإنك توافق على تسجيلها.',
  de: 'Dieses Gespräch kann zu Qualitäts- und Schulungszwecken aufgezeichnet werden. Wenn Sie das Gespräch fortsetzen, stimmen Sie der Aufzeichnung zu.',
  it: 'Questa chiamata può essere registrata per scopi di qualità e formazione. Proseguendo la chiamata, accetta la registrazione.',
  nl: 'Dit gesprek kan worden opgenomen voor kwaliteits- en opleidingsdoeleinden. Door dit gesprek voort te zetten, gaat u akkoord met de opname.',
  pt: 'Esta chamada pode ser gravada para fins de qualidade e formação. Ao continuar esta chamada, aceita a gravação.',
};
export const CONSENT_LANGUAGES = Object.keys(CONSENT_TEXTS);
export const DEFAULT_CONSENT_LANGUAGE = 'fr';

const ARABIC = ['+20', '+212', '+213', '+216', '+218', '+249', '+961', '+962', '+963', '+964', '+965', '+966', '+967', '+968', '+971', '+973', '+974'];
const SPANISH = ['+34', '+51', '+52', '+53', '+54', '+56', '+57', '+58', '+591', '+593', '+595', '+598'];
const ENGLISH = ['+1', '+44', '+61', '+64', '+353'];
const FRENCH = ['+33', '+32', '+41', '+352', '+221', '+225', '+262', '+590', '+594', '+596', '+687', '+689'];
const GERMAN = ['+49', '+43', '+423'];
const ITALIAN = ['+39', '+378', '+379'];
const DUTCH = ['+31'];
const PORTUGUESE = ['+351'];

/** Code de langue d'une annonce valide (fr/en/es/ar/de/it/nl/pt), sinon null. */
export const normalizeConsentLanguage = (value) => {
  const code = String(value ?? '').trim().toLowerCase();
  return CONSENT_LANGUAGES.includes(code) ? code : null;
};

/**
 * Langue de l'annonce selon l'indicatif du numéro de l'interlocuteur (E.164), quand il est reconnu (arabe, espagnol, anglais, français, allemand, italien, néerlandais, portugais).
 * Indicatif non reconnu ou numéro illisible : `fallback`, la langue de la ligne (`languageForPhone`), sinon le français comme avant.
 * Le comportement pour un indicatif reconnu est inchangé : la langue de l'interlocuteur prime sur celle de la société.
 */
export function consentLanguageFor(number, fallback = DEFAULT_CONSENT_LANGUAGE) {
  const fb = normalizeConsentLanguage(fallback) || DEFAULT_CONSENT_LANGUAGE;
  const n = String(number ?? '').replace(/[\s().-]/g, '');
  if (!n.startsWith('+')) return fb;
  const hit = (list) => list.some((p) => n.startsWith(p));
  if (hit(ARABIC)) return 'ar';
  if (hit(SPANISH)) return 'es';
  if (hit(ENGLISH)) return 'en';
  if (hit(FRENCH)) return 'fr';
  if (hit(GERMAN)) return 'de';
  if (hit(ITALIAN)) return 'it';
  if (hit(DUTCH)) return 'nl';
  if (hit(PORTUGUESE)) return 'pt';
  return fb;
}

/** <Say> de l'annonce, dans la langue et avec la voix féminine de la langue (sayVoice). */
export function consentSay(lang) {
  const code = normalizeConsentLanguage(lang) || DEFAULT_CONSENT_LANGUAGE;
  const { voice, language } = sayVoice(code);
  return `<Say language="${language}" voice="${voice}">${xmlEscape(CONSENT_TEXTS[code])}</Say>`;
}

/** Réponse TwiML complète de l'annonce jouée à la personne appelée (<Number url>), avant la mise en relation. */
export const consentTwiml = (lang) => `<?xml version="1.0" encoding="UTF-8"?><Response>${consentSay(lang)}</Response>`;

// ---------------------------------------------------------------- jeton signé du rappel d'enregistrement

export const RECORDING_TOKEN_AUDIENCE = 'call-recording';
/** Un appel peut durer 4 h, puis Twilio traite l'audio : le jeton reste valable 8 h. */
export const RECORDING_TOKEN_TTL_SECONDS = 8 * 60 * 60;
export const RECORDING_WEBHOOK_PATH = '/api/phone-numbers/webhooks/twilio/call-recording';
export const ANNOUNCE_WEBHOOK_PATH = '/api/phone-numbers/webhooks/twilio/call-announce';
const CALL_SID = /^CA[0-9a-zA-Z]{32}$/;

/** Le jeton lie le rappel à UNE entreprise et à UN appel : l'URL du rappel ne sert à rien d'autre. */
export function signRecordingToken({ secret = process.env.JWT_SECRET, companyId, callSid }) {
  if (!secret) throw new Error('JWT_SECRET is not configured');
  return jwt.sign({ c: String(companyId), s: String(callSid) }, secret, { algorithm: 'HS256', audience: RECORDING_TOKEN_AUDIENCE, expiresIn: RECORDING_TOKEN_TTL_SECONDS });
}

/** @returns {{companyId: string, callSid: string}|null} null si le jeton est absent, altéré, périmé ou mal formé */
export function verifyRecordingToken(token, secret = process.env.JWT_SECRET) {
  try {
    if (!secret || !token) return null;
    const d = jwt.verify(String(token), secret, { audience: RECORDING_TOKEN_AUDIENCE, algorithms: ['HS256'] });
    if (!/^[a-f0-9]{24}$/i.test(String(d.c)) || !CALL_SID.test(String(d.s))) return null;
    return { companyId: String(d.c), callSid: String(d.s) };
  } catch {
    return null;
  }
}

/**
 * Consigne d'enregistrement d'un appel : attributs du <Dial>, annonce à jouer, URL d'annonce pour l'appelé.
 * @returns {null|{attrs: string, say: string, announceUrl: string}} null = appel non enregistré (aucun attribut, aucune annonce)
 */
export function buildRecordingPlan({ record, companyId, callSid, baseUrl, language, secret }) {
  if (record !== true || !companyId || !CALL_SID.test(String(callSid || '')) || !baseUrl) return null;
  let token;
  try { token = signRecordingToken({ secret, companyId, callSid }); } catch (e) { console.error('[call-recording] jeton non signé, appel non enregistré:', e.message); return null; }
  const lang = normalizeConsentLanguage(language) || DEFAULT_CONSENT_LANGUAGE;
  const callbackUrl = `${baseUrl}${RECORDING_WEBHOOK_PATH}?t=${token}`;
  return {
    attrs: ` record="record-from-answer-dual" recordingStatusCallback="${xmlEscape(callbackUrl)}" recordingStatusCallbackEvent="completed" recordingStatusCallbackMethod="POST"`,
    say: consentSay(lang),
    announceUrl: `${baseUrl}${ANNOUNCE_WEBHOOK_PATH}?l=${lang}`,
  };
}

// ---------------------------------------------------------------- rappel Twilio -> dash_calls

/** @returns {{ignore:string}|{value:{recordingSid:string, recordingUrl:string, durationSeconds:number, callSid:string}}} */
export function mapCallRecordingCallback(body = {}) {
  const recordingSid = String(body.RecordingSid || '').trim();
  if (!/^RE[0-9a-zA-Z]{32}$/.test(recordingSid)) return { ignore: 'invalid_recording_sid' };
  if (String(body.RecordingStatus || 'completed').toLowerCase() !== 'completed') return { ignore: 'not_completed' };
  const callSid = String(body.CallSid || '').trim();
  if (!CALL_SID.test(callSid)) return { ignore: 'invalid_call_sid' };
  const recordingUrl = String(body.RecordingUrl || '').trim().replace(/\.(mp3|wav)$/i, '');
  if (!isTwilioRecordingUrl(recordingUrl)) return { ignore: 'invalid_recording_url' };
  const durationSeconds = Math.round(Number(body.RecordingDuration));
  if (!Number.isFinite(durationSeconds) || durationSeconds < 1) return { ignore: 'empty_recording' };
  return { value: { recordingSid, recordingUrl, durationSeconds, callSid } };
}

export const RECORDING_SERVICE_SCOPE = 'call-recording';
const signServiceToken = (secret = process.env.JWT_SECRET) => {
  if (!secret) throw new Error('JWT_SECRET is not configured');
  return jwt.sign({ scope: RECORDING_SERVICE_SCOPE }, secret, { algorithm: 'HS256', issuer: SERVICE_ISSUER, expiresIn: 120 });
};

/** Délais (ms) entre les tentatives : le document d'appel est écrit par le front à la fin de l'appel, parfois après le rappel Twilio. */
export const ATTACH_RETRY_DELAYS_MS = [10_000, 30_000, 90_000, 300_000];

/**
 * Rattache l'enregistrement au document d'appel existant (dash_calls, par CallSid). Ne lève jamais.
 * 404 = l'appel n'est pas encore inscrit : nouvelle tentative après chaque délai. Les tentatives vivent en mémoire
 * (un redémarrage du serveur les perd : l'URL reste dans les journaux).
 * @returns {Promise<'attached'|'pending'|'rejected'|'unconfigured'|'error'>}
 */
export async function attachCallRecording({ companyId, value }, { fetchImpl = fetch, env = process.env, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), delays = ATTACH_RETRY_DELAYS_MS } = {}) {
  const apiBase = resolveDashCallsApi(env);
  if (!apiBase) return 'unconfigured';
  let outcome = 'error';
  for (let i = 0; i <= delays.length; i++) {
    if (i > 0) await sleep(delays[i - 1]);
    try {
      const res = await fetchImpl(`${apiBase}/calls/recording`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signServiceToken(env.JWT_SECRET)}` },
        body: JSON.stringify({ sid: value.callSid, companyId: String(companyId), recordingSid: value.recordingSid, recordingUrl: value.recordingUrl, durationSeconds: value.durationSeconds }),
      });
      if (res.ok) return 'attached';
      if (res.status === 404) { outcome = 'pending'; continue; }
      if (res.status >= 400 && res.status < 500) { console.warn(`[call-recording] ${value.callSid} refusé par dash_calls (${res.status})`); return 'rejected'; }
      outcome = 'error';
    } catch (e) {
      console.error('[call-recording] rattachement impossible:', e?.message || e);
      outcome = 'error';
    }
  }
  console.warn(`[call-recording] ${value.callSid} non rattaché (${outcome}) ; enregistrement ${value.recordingSid}`);
  return outcome;
}
