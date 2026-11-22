import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

/**
 * Appel d'essai gratuit (Nomad Solo, avant paiement) : configuration lue UNIQUEMENT dans l'environnement.
 *
 * DÉSACTIVÉ PAR DÉFAUT. L'essai n'est proposé que si TOUT est réuni :
 *  - TRIAL_CALL_ENABLED vaut exactement « true » ;
 *  - TRIAL_CALL_HASH_SECRET (≥ 32 caractères) : secret des empreintes HMAC et des preuves signées ;
 *  - TURNSTILE_SITE_KEY + TURNSTILE_SECRET_KEY + TURNSTILE_ALLOWED_HOSTNAMES (Cloudflare Turnstile, vérifié côté serveur avant tout SMS) ;
 *  - TRIAL_CALL_MESSAGING_SERVICE_SID (service de messagerie Twilio « MG… » qui envoie le code SMS) ;
 *  - TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN ;
 *  - pour le pays : un numéro d'essai DÉDIÉ dans TRIAL_CALL_NUMBERS (« FR:+33…,GB:+44… »), jamais un numéro du stock client.
 * Pays ouverts : TRIAL_CALL_COUNTRIES (défaut FR,GB,US,CA,ES,BE,DE). Maroc, Algérie, Tunisie : toujours fermés (décision du 22/11/2026).
 * Il manque une seule de ces valeurs : l'essai reste invisible (aucune carte, routes qui répondent « indisponible »).
 *
 * Mesure avant/après (sans test A/B) : TRIAL_FUNNEL_EVENTS_ENABLED=true journalise les évènements du parcours d'inscription, même essai
 * désactivé (période « avant »). Désactivé par défaut lui aussi.
 */
export const DEFAULT_TRIAL_COUNTRIES = Object.freeze(['FR', 'GB', 'US', 'CA', 'ES', 'BE', 'DE']);
/** Maghreb : pas d'essai pour l'instant (décision du fondateur du 22/11/2026), quelle que soit la configuration. */
export const CLOSED_TRIAL_COUNTRIES = Object.freeze(['MA', 'DZ', 'TN']);
/**
 * Durées (décision du fondateur : « 59 secondes et tu coupes, on ne doit être facturé qu'une minute ») :
 *  - la jambe vers le proche est facturée dès son décroché ; l'annonce (<Number url>) est jouée SUR cette jambe, avant la mise en
 *    relation, donc elle est facturée et doit être DÉDUITE ;
 *  - budget de l'annonce : 7 s (texte le plus long ≈ 5 s à la voix Polly, voir le test) ;
 *  - timeLimit du <Dial> = 59 − 7 = 52 s, appliqué par Twilio lui-même (coupure principale, sans latence de notre côté). Que Twilio
 *    compte ce délai depuis le décroché ou depuis la mise en relation, la jambe dure au plus 7 + 52 = 59 s : toujours < 60 s ;
 *  - filet de secours (minuterie + balayeur) : 58 s après NOTRE horodatage du décroché (reçu après le décroché réel, avec la latence
 *    du compte rendu Twilio) : s'il devait servir, la coupure resterait sous 60 s facturées ; il ne coupe jamais avant la fin normale
 *    d'un appel dont l'annonce dure ≤ 6 s.
 */
export const TRIAL_BILLED_MAX_SECONDS = 59;
export const TRIAL_ANNOUNCE_BUDGET_SECONDS = 7;
export const TRIAL_DIAL_TIME_LIMIT = TRIAL_BILLED_MAX_SECONDS - TRIAL_ANNOUNCE_BUDGET_SECONDS;
export const TRIAL_CUT_SECONDS = 58;
/** Durée maximale enregistrée d'un essai (secondes facturables de la jambe du proche). */
export const TRIAL_MAX_SECONDS = TRIAL_BILLED_MAX_SECONDS;
/** Un essai dont le code a été validé expire s'il n'a pas été utilisé dans les 30 minutes. */
export const TRIAL_VERIFIED_TTL_MS = 30 * 60 * 1000;
/** Sonnerie maximale chez le proche. */
export const TRIAL_RING_TIMEOUT = 25;
/** Numérotations au plus par essai (l'essai n'est consommé qu'au décroché). */
export const TRIAL_MAX_DIALS = 3;
/** Durée de vie du jeton vocal Twilio de l'essai. */
export const TRIAL_TOKEN_TTL_S = 120;
/** Code SMS : 6 chiffres, valable 10 minutes, 5 essais de saisie. */
export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_AFTER_S = 30;
/** Conservation des empreintes et du journal : 12 mois. */
export const RETENTION_SECONDS = 365 * 24 * 3600;

const trimmed = (v) => String(v ?? '').trim();
const isTrue = (v) => trimmed(v).toLowerCase() === 'true';
const positive = (v, d) => { const n = Math.floor(Number(trimmed(v))); return Number.isFinite(n) && n > 0 ? n : d; };

/** « FR:+33184800042,GB:+442079460018 » -> { FR: '+33184800042', … } ; une entrée dont le numéro n'est pas de ce pays est ignorée. */
export function parseTrialNumbers(raw) {
  const out = {};
  for (const part of trimmed(raw).split(',')) {
    const m = /^([A-Za-z]{2})\s*[:=]\s*(\+[1-9]\d{7,14})$/.exec(part.trim());
    if (!m) continue;
    const cc = m[1].toUpperCase();
    const p = parsePhoneNumberFromString(m[2]);
    if (!p || !p.isValid() || p.country !== cc) continue;
    out[cc] = p.number;
  }
  return out;
}

export function parseCountries(raw) {
  const list = trimmed(raw).split(',').map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
  return (list.length ? list : [...DEFAULT_TRIAL_COUNTRIES]).filter((c) => !CLOSED_TRIAL_COUNTRIES.includes(c));
}

export function trialConfig(env = process.env) {
  const slack = trimmed(env.TRIAL_CALL_ALERT_SLACK_WEBHOOK_URL);
  const hostnames = trimmed(env.TURNSTILE_ALLOWED_HOSTNAMES).split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const webOtp = trimmed(env.TRIAL_CALL_WEBOTP_DOMAIN).toLowerCase();
  return {
    flag: isTrue(env.TRIAL_CALL_ENABLED),
    eventsFlag: isTrue(env.TRIAL_FUNNEL_EVENTS_ENABLED),
    hashSecret: trimmed(env.TRIAL_CALL_HASH_SECRET),
    turnstileSiteKey: trimmed(env.TURNSTILE_SITE_KEY),
    turnstileSecret: trimmed(env.TURNSTILE_SECRET_KEY),
    turnstileHostnames: hostnames,
    messagingServiceSid: trimmed(env.TRIAL_CALL_MESSAGING_SERVICE_SID),
    twilioAccountSid: trimmed(env.TWILIO_ACCOUNT_SID),
    twilioAuthToken: trimmed(env.TWILIO_AUTH_TOKEN),
    pinnedAppSid: /^AP[0-9a-f]{32}$/i.test(trimmed(env.TRIAL_CALL_TWIML_APP_SID)) ? trimmed(env.TRIAL_CALL_TWIML_APP_SID) : '',
    countries: parseCountries(env.TRIAL_CALL_COUNTRIES),
    numbers: parseTrialNumbers(env.TRIAL_CALL_NUMBERS),
    alertEmail: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed(env.TRIAL_CALL_ALERT_EMAIL)) ? trimmed(env.TRIAL_CALL_ALERT_EMAIL) : '',
    alertSlackUrl: /^https:\/\/hooks\.slack\.com\/\S+$/.test(slack) ? slack : '',
    webOtpDomain: /^[a-z0-9.-]+\.[a-z]{2,}$/.test(webOtp) ? webOtp : '',
    // Plafonds GLOBAUX persistants (en base) : leur dépassement met l'essai en pause et alerte (jamais le paiement).
    maxSmsPerHour: positive(env.TRIAL_CALL_MAX_SMS_PER_HOUR, 60),
    maxSmsPerDay: positive(env.TRIAL_CALL_MAX_SMS_PER_DAY, 400),
    maxLookupsPerHour: positive(env.TRIAL_CALL_MAX_LOOKUPS_PER_HOUR, 100),
    maxLookupsPerDay: positive(env.TRIAL_CALL_MAX_LOOKUPS_PER_DAY, 800),
  };
}

/** Noms des variables manquantes pour activer l'essai (jamais leurs valeurs). Vide = configuration complète. */
export function missingForActivation(cfg) {
  const missing = [];
  if (!cfg.flag) missing.push('TRIAL_CALL_ENABLED');
  if (cfg.hashSecret.length < 32) missing.push('TRIAL_CALL_HASH_SECRET');
  if (!cfg.turnstileSiteKey) missing.push('TURNSTILE_SITE_KEY');
  if (!cfg.turnstileSecret) missing.push('TURNSTILE_SECRET_KEY');
  if (!cfg.turnstileHostnames.length) missing.push('TURNSTILE_ALLOWED_HOSTNAMES');
  if (!/^MG[0-9a-f]{32}$/i.test(cfg.messagingServiceSid)) missing.push('TRIAL_CALL_MESSAGING_SERVICE_SID');
  if (!/^AC[0-9a-f]{32}$/i.test(cfg.twilioAccountSid) || !cfg.twilioAuthToken) missing.push('TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN');
  if (!Object.keys(cfg.numbers).some((cc) => cfg.countries.includes(cc))) missing.push('TRIAL_CALL_NUMBERS');
  return missing;
}

/** L'essai est-il actif (drapeau + configuration complète) ? */
export const trialEnabled = (cfg) => missingForActivation(cfg).length === 0;

/** Numéro d'essai du pays si le pays est ouvert à l'essai, sinon ''. Ne tient pas compte de la pause (voir le contrôleur). */
export function trialNumberFor(cfg, country) {
  const cc = trimmed(country).toUpperCase();
  if (!trialEnabled(cfg) || CLOSED_TRIAL_COUNTRIES.includes(cc) || !cfg.countries.includes(cc)) return '';
  return cfg.numbers[cc] || '';
}

/**
 * Numéros d'essai déclarés dans l'environnement, QUEL QUE SOIT le drapeau : jamais proposés à la vente (inventaire Twilio,
 * phoneNumberService.isInventoryCandidate), jamais appelables comme destination.
 */
export const configuredTrialNumbers = (env = process.env) => Object.values(parseTrialNumbers(env.TRIAL_CALL_NUMBERS));

/** Tous les numéros d'essai configurés (jamais appelables comme destination). */
export const allTrialNumbers = (cfg) => Object.values(cfg.numbers);
