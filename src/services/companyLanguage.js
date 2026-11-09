/**
 * Langue des textes que l'ENTREPRISE dit à ses appelants (accueil, répondeur, transfert, refus, annonces) : elle suit le PAYS DE LA
 * SOCIÉTÉ, jamais la langue de l'écran de celui qui règle. Logique pure (aucun accès base ni réseau), à garder alignée avec
 * `src/domain/companyLanguage.ts` du front (`languageForCountry`).
 *
 * Le mapping est ici, en un seul endroit, facile à ajuster :
 *   fr : FR BE CH LU MA SN CI (le Maroc reste en français d'affaires malgré l'arabe) ;
 *   en : GB US IE CA AU NZ, et tout autre pays (pas de langue produit dédiée) ;
 *   es : Espagne et pays hispanophones ;
 *   ar : pays arabophones (sauf le Maroc) ;
 *   pays absent ou inconnu : fr (comme avant ce réglage).
 */
export const COMPANY_LANGUAGES = ['fr', 'en', 'es', 'ar'];
export const DEFAULT_COMPANY_LANGUAGE = 'fr';

export const COUNTRIES_BY_LANGUAGE = Object.freeze({
  fr: ['FR', 'BE', 'CH', 'LU', 'MA', 'SN', 'CI'],
  en: ['GB', 'US', 'IE', 'CA', 'AU', 'NZ'],
  es: ['ES', 'MX', 'AR', 'CO', 'CL', 'PE', 'VE', 'EC', 'GT', 'CU', 'BO', 'DO', 'HN', 'PY', 'SV', 'NI', 'CR', 'PA', 'UY', 'PR', 'GQ'],
  ar: ['AE', 'SA', 'EG', 'JO', 'KW', 'QA', 'BH', 'OM', 'LB', 'IQ', 'DZ', 'TN', 'LY', 'SY', 'YE', 'SD', 'PS', 'MR'],
});

/** Langue des textes d'entreprise pour un code pays ISO 3166-1 alpha-2 (« UK » = GB). Absent ou illisible : français. */
export function languageForCountry(iso2) {
  let code = String(iso2 ?? '').trim().toUpperCase();
  if (code === 'UK') code = 'GB';
  if (!/^[A-Z]{2}$/.test(code)) return DEFAULT_COMPANY_LANGUAGE;
  for (const lang of COMPANY_LANGUAGES) if (COUNTRIES_BY_LANGUAGE[lang].includes(code)) return lang;
  return 'en';
}

/**
 * Pays déduit de l'indicatif d'un numéro E.164 (les indicatifs partagés ou inconnus ne donnent pas de pays précis). Sert à retrouver le
 * pays de la société quand seul son numéro de ligne est connu : le serveur déduit déjà ainsi le pays des appels sortants (outboundPolicy).
 * Les territoires français (+262, +590, +594, +596, +687, +689, +508, +681) comptent comme la France.
 */
const CALLING_CODE_COUNTRY = Object.freeze({
  '+1': 'US', '+20': 'EG', '+212': 'MA', '+213': 'DZ', '+216': 'TN', '+218': 'LY', '+221': 'SN', '+222': 'MR', '+225': 'CI', '+240': 'GQ',
  '+249': 'SD', '+262': 'FR', '+32': 'BE', '+33': 'FR', '+34': 'ES', '+352': 'LU', '+353': 'IE', '+41': 'CH', '+44': 'GB',
  '+502': 'GT', '+503': 'SV', '+504': 'HN', '+505': 'NI', '+506': 'CR', '+507': 'PA', '+508': 'FR', '+51': 'PE', '+52': 'MX', '+53': 'CU',
  '+54': 'AR', '+56': 'CL', '+57': 'CO', '+58': 'VE', '+590': 'FR', '+591': 'BO', '+593': 'EC', '+594': 'FR', '+595': 'PY', '+596': 'FR',
  '+598': 'UY', '+61': 'AU', '+64': 'NZ', '+681': 'FR', '+687': 'FR', '+689': 'FR', '+961': 'LB', '+962': 'JO', '+963': 'SY', '+964': 'IQ',
  '+965': 'KW', '+966': 'SA', '+967': 'YE', '+968': 'OM', '+970': 'PS', '+971': 'AE', '+973': 'BH', '+974': 'QA',
});

/**
 * Langue des textes d'entreprise d'après le numéro E.164 de la ligne de la société. Indicatif reconnu : langue de son pays (un indicatif
 * sans langue dédiée donne l'anglais) ; numéro absent ou illisible : `fallback` (français par défaut).
 */
export function languageForPhone(e164, fallback = DEFAULT_COMPANY_LANGUAGE) {
  let n = String(e164 ?? '').replace(/[\s().-]/g, '');
  if (n.startsWith('00')) n = `+${n.slice(2)}`;
  else if (/^[1-9]\d{7,14}$/.test(n)) n = `+${n}`; // numéros stockés sans « + »
  if (!/^\+[1-9]\d{7,14}$/.test(n)) return fallback;
  for (const len of [4, 3, 2]) {
    const prefix = n.slice(0, len);
    if (Object.prototype.hasOwnProperty.call(CALLING_CODE_COUNTRY, prefix) && CALLING_CODE_COUNTRY[prefix]) return languageForCountry(CALLING_CODE_COUNTRY[prefix]);
  }
  return 'en';
}

/** Langue valide du produit, sinon français. */
export const normalizeCompanyLanguage = (value) => {
  const code = String(value ?? '').trim().toLowerCase().slice(0, 2);
  return COMPANY_LANGUAGES.includes(code) ? code : DEFAULT_COMPANY_LANGUAGE;
};

/**
 * Voix Amazon Polly (via <Say>) par langue du produit, voix féminine / masculine. Le polly arabe n'a qu'une voix (Zeina) : elle sert aux deux.
 * Voix à vérifier avec de vrais appels (même réserve que routingLanguages.js).
 */
const SAY_VOICES = Object.freeze({
  fr: { language: 'fr-FR', female: 'Polly.Lea', male: 'Polly.Mathieu' },
  en: { language: 'en-US', female: 'Polly.Joanna', male: 'Polly.Matthew' },
  es: { language: 'es-ES', female: 'Polly.Lucia', male: 'Polly.Enrique' },
  ar: { language: 'arb', female: 'Polly.Zeina', male: 'Polly.Zeina' },
});

/** Attributs `language` et `voice` d'un <Say> dans la langue de la société (français si langue inconnue). */
export const sayVoice = (language, female = true) => {
  const v = SAY_VOICES[normalizeCompanyLanguage(language)];
  return { language: v.language, voice: female ? v.female : v.male };
};

/** Phrases fixes dites aux appelants, par langue (le français est la référence : ce sont les textes d'origine, inchangés). */
export const PHRASES = Object.freeze({
  fr: {
    voicemailPrompt: "Aucun conseiller n'est disponible pour le moment. Votre message sera enregistré. Laissez-le après le bip, nous vous rappelons rapidement.",
    noAnswer: "Aucun conseiller n'a pu répondre. Veuillez rappeler plus tard. Au revoir.",
    noAgent: "Cette ligne est active sur la plateforme Harx. Aucun conseiller n'est disponible pour le moment. Au revoir.",
    soloVoicemailPrompt: 'Je ne suis pas disponible pour le moment. Votre message sera enregistré. Laissez-le après le bip, je vous rappelle rapidement.',
    soloNoAnswer: "Je n'ai pas pu vous répondre. Veuillez rappeler plus tard. Au revoir.",
    soloNoAgent: "Cette ligne n'est pas joignable pour le moment. Veuillez rappeler plus tard. Au revoir.",
    voicemailThanks: 'Merci, votre message a bien été enregistré. Au revoir.',
    blocked: 'Nous ne pouvons pas donner suite à votre appel. Au revoir.',
    transferAnnounce: (name) => `Je vous passe ${name}, ne quittez pas.`,
    transferUnavailable: (name) => `${name} ne peut pas vous répondre pour le moment.`,
    transferFallbackName: 'La personne demandée',
    menuFor: (name, key) => `Pour ${name}, tapez ${key}.`,
  },
  en: {
    voicemailPrompt: 'No advisor is available at the moment. Your message will be recorded. Please leave it after the beep and we will call you back shortly.',
    noAnswer: 'No advisor was able to answer. Please call back later. Goodbye.',
    noAgent: 'This line is active on the Harx platform. No advisor is available at the moment. Goodbye.',
    soloVoicemailPrompt: 'I am not available at the moment. Your message will be recorded. Please leave it after the beep and I will call you back shortly.',
    soloNoAnswer: 'I was not able to answer. Please call back later. Goodbye.',
    soloNoAgent: 'This line cannot be reached at the moment. Please call back later. Goodbye.',
    voicemailThanks: 'Thank you, your message has been recorded. Goodbye.',
    blocked: 'We are unable to take your call. Goodbye.',
    transferAnnounce: (name) => `Putting you through to ${name}, please hold.`,
    transferUnavailable: (name) => `${name} is not available to take your call at the moment.`,
    transferFallbackName: 'The person you asked for',
    menuFor: (name, key) => `For ${name}, press ${key}.`,
  },
  es: {
    voicemailPrompt: 'En este momento no hay ningún asesor disponible. Su mensaje será grabado. Déjelo después de la señal y le llamaremos en breve.',
    noAnswer: 'Ningún asesor ha podido atenderle. Vuelva a llamar más tarde. Hasta pronto.',
    noAgent: 'Esta línea está activa en la plataforma Harx. En este momento no hay ningún asesor disponible. Hasta pronto.',
    soloVoicemailPrompt: 'No estoy disponible en este momento. Su mensaje será grabado. Déjelo después de la señal y le devolveré la llamada en breve.',
    soloNoAnswer: 'No he podido atenderle. Vuelva a llamar más tarde. Hasta pronto.',
    soloNoAgent: 'Esta línea no está disponible en este momento. Vuelva a llamar más tarde. Hasta pronto.',
    voicemailThanks: 'Gracias, su mensaje ha sido grabado. Hasta pronto.',
    blocked: 'No podemos atender su llamada. Hasta pronto.',
    transferAnnounce: (name) => `Le paso con ${name}, no cuelgue.`,
    transferUnavailable: (name) => `${name} no puede atenderle en este momento.`,
    transferFallbackName: 'La persona solicitada',
    menuFor: (name, key) => `Para ${name}, pulse ${key}.`,
  },
  ar: {
    voicemailPrompt: 'لا يوجد أي مستشار متاح حالياً. سيتم تسجيل رسالتك. اتركها بعد الصافرة وسنعاود الاتصال بك قريباً.',
    noAnswer: 'لم يتمكن أي مستشار من الرد. يرجى معاودة الاتصال لاحقاً. مع السلامة.',
    noAgent: 'هذا الخط مفعّل على منصة Harx. لا يوجد أي مستشار متاح حالياً. مع السلامة.',
    soloVoicemailPrompt: 'لست متاحاً حالياً. سيتم تسجيل رسالتك. اتركها بعد الصافرة وسأعاود الاتصال بك قريباً.',
    soloNoAnswer: 'لم أتمكن من الرد. يرجى معاودة الاتصال لاحقاً. مع السلامة.',
    soloNoAgent: 'لا يمكن الوصول إلى هذا الخط حالياً. يرجى معاودة الاتصال لاحقاً. مع السلامة.',
    voicemailThanks: 'شكراً، تم تسجيل رسالتك. مع السلامة.',
    blocked: 'لا يمكننا الرد على مكالمتك. مع السلامة.',
    transferAnnounce: (name) => `سأحوّلك إلى ${name}، يرجى الانتظار.`,
    transferUnavailable: (name) => `${name} غير متاح للرد حالياً.`,
    transferFallbackName: 'الشخص المطلوب',
    menuFor: (name, key) => `لـ ${name}، اضغط ${key}.`,
  },
});

export const phrasesFor = (language) => PHRASES[normalizeCompanyLanguage(language)];
