/**
 * Langue des phrases SYSTÈME que la ligne dit à ses appelants (répondeur, repli sans conseiller, remerciement, transfert, refus d'appelant
 * bloqué, menu vocal, annonce d'enregistrement) : elle suit le PAYS DU NUMÉRO DE TÉLÉPHONE DE LA LIGNE (décision du propriétaire), pas le
 * pays de la société ni la langue de l'écran de celui qui règle. Une société française qui achète un numéro allemand (permis par la règle
 * « toute l'Europe ») entend donc de l'allemand sur cette ligne. Logique pure (aucun accès base ni réseau), à garder alignée avec
 * `src/domain/companyLanguage.ts` du front (`languageForCountry`).
 *
 * Limite : le texte d'accueil / de répondeur écrit (ou validé, audio généré) par l'entreprise n'est JAMAIS traduit ; il est dit tel quel,
 * dans la langue où le client l'a écrit. Seules les phrases fixes ci-dessous suivent la ligne.
 *
 * Le mapping pays -> langue est le tableau COUNTRIES_BY_LANGUAGE ci-dessous (un seul endroit, à ajuster ici) :
 *   fr : FR BE CH LU MA SN CI (BE et CH restent en français ; le Maroc reste en français d'affaires malgré l'arabe) ;
 *   de : DE AT LI (la Suisse reste en français) ;
 *   it : IT SM VA ;
 *   nl : NL (la Belgique reste en français) ;
 *   pt : PT ;
 *   en : GB US IE CA AU NZ, et tout autre pays (pas de langue produit dédiée, ex. Grèce, Pologne, Suède) ;
 *   es : Espagne et pays hispanophones ;
 *   ar : pays arabophones (sauf le Maroc) ;
 *   pays absent ou inconnu : fr (comme avant ce réglage).
 */
export const COMPANY_LANGUAGES = ['fr', 'en', 'es', 'ar', 'de', 'it', 'nl', 'pt'];
export const DEFAULT_COMPANY_LANGUAGE = 'fr';

export const COUNTRIES_BY_LANGUAGE = Object.freeze({
  fr: ['FR', 'BE', 'CH', 'LU', 'MA', 'SN', 'CI'],
  en: ['GB', 'US', 'IE', 'CA', 'AU', 'NZ'],
  es: ['ES', 'MX', 'AR', 'CO', 'CL', 'PE', 'VE', 'EC', 'GT', 'CU', 'BO', 'DO', 'HN', 'PY', 'SV', 'NI', 'CR', 'PA', 'UY', 'PR', 'GQ'],
  ar: ['AE', 'SA', 'EG', 'JO', 'KW', 'QA', 'BH', 'OM', 'LB', 'IQ', 'DZ', 'TN', 'LY', 'SY', 'YE', 'SD', 'PS', 'MR'],
  de: ['DE', 'AT', 'LI'],
  it: ['IT', 'SM', 'VA'],
  nl: ['NL'],
  pt: ['PT'],
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
  '+249': 'SD', '+262': 'FR', '+31': 'NL', '+32': 'BE', '+33': 'FR', '+34': 'ES', '+351': 'PT', '+352': 'LU', '+353': 'IE', '+378': 'SM',
  '+379': 'VA', '+39': 'IT', '+41': 'CH', '+423': 'LI', '+43': 'AT', '+44': 'GB', '+49': 'DE',
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
 * Noms et codes de langue contrôlés contre les types du SDK Twilio (VoiceResponse.d.ts) : « Polly.Ines » s'écrit sans accent, et Daniel,
 * Adriano et Laura n'existent que sous leur forme neuronale (« -Neural »). Jamais écoutées en vrai appel (même réserve que routingLanguages.js).
 */
const SAY_VOICES = Object.freeze({
  fr: { language: 'fr-FR', female: 'Polly.Lea', male: 'Polly.Mathieu' },
  en: { language: 'en-US', female: 'Polly.Joanna', male: 'Polly.Matthew' },
  es: { language: 'es-ES', female: 'Polly.Lucia', male: 'Polly.Enrique' },
  ar: { language: 'arb', female: 'Polly.Zeina', male: 'Polly.Zeina' },
  de: { language: 'de-DE', female: 'Polly.Vicki', male: 'Polly.Daniel-Neural' },
  it: { language: 'it-IT', female: 'Polly.Bianca', male: 'Polly.Adriano-Neural' },
  nl: { language: 'nl-NL', female: 'Polly.Laura-Neural', male: 'Polly.Ruben' },
  pt: { language: 'pt-PT', female: 'Polly.Ines', male: 'Polly.Cristiano' },
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
  de: {
    voicemailPrompt: 'Im Moment ist kein Berater verfügbar. Ihre Nachricht wird aufgezeichnet. Sprechen Sie sie nach dem Signalton auf, wir rufen Sie in Kürze zurück.',
    noAnswer: 'Leider konnte kein Berater Ihren Anruf entgegennehmen. Bitte rufen Sie später noch einmal an. Auf Wiederhören.',
    noAgent: 'Diese Leitung ist auf der Harx-Plattform aktiv. Im Moment ist kein Berater verfügbar. Auf Wiederhören.',
    soloVoicemailPrompt: 'Ich bin im Moment nicht erreichbar. Ihre Nachricht wird aufgezeichnet. Sprechen Sie sie nach dem Signalton auf, ich rufe Sie in Kürze zurück.',
    soloNoAnswer: 'Ich konnte Ihren Anruf nicht entgegennehmen. Bitte rufen Sie später noch einmal an. Auf Wiederhören.',
    soloNoAgent: 'Diese Leitung ist im Moment nicht erreichbar. Bitte rufen Sie später noch einmal an. Auf Wiederhören.',
    voicemailThanks: 'Vielen Dank, Ihre Nachricht wurde aufgezeichnet. Auf Wiederhören.',
    blocked: 'Wir können Ihren Anruf leider nicht annehmen. Auf Wiederhören.',
    transferAnnounce: (name) => `Ich verbinde Sie mit ${name}, bitte bleiben Sie in der Leitung.`,
    transferUnavailable: (name) => `${name} ist im Moment nicht erreichbar.`,
    transferFallbackName: 'Die gewünschte Person',
    menuFor: (name, key) => `Für ${name} drücken Sie die ${key}.`,
  },
  it: {
    voicemailPrompt: 'Al momento nessun consulente è disponibile. Il suo messaggio verrà registrato. Lo lasci dopo il segnale acustico e la richiameremo al più presto.',
    noAnswer: 'Nessun consulente ha potuto rispondere. La preghiamo di richiamare più tardi. Arrivederci.',
    noAgent: 'Questa linea è attiva sulla piattaforma Harx. Al momento nessun consulente è disponibile. Arrivederci.',
    soloVoicemailPrompt: 'Al momento non sono disponibile. Il suo messaggio verrà registrato. Lo lasci dopo il segnale acustico e la richiamerò al più presto.',
    soloNoAnswer: 'Non ho potuto rispondere. La prego di richiamare più tardi. Arrivederci.',
    soloNoAgent: 'Questa linea al momento non è raggiungibile. La preghiamo di richiamare più tardi. Arrivederci.',
    voicemailThanks: 'Grazie, il suo messaggio è stato registrato. Arrivederci.',
    blocked: 'Non possiamo dare seguito alla sua chiamata. Arrivederci.',
    transferAnnounce: (name) => `La metto in contatto con ${name}, resti in linea.`,
    transferUnavailable: (name) => `${name} al momento non è disponibile.`,
    transferFallbackName: 'La persona richiesta',
    menuFor: (name, key) => `Per ${name}, prema ${key}.`,
  },
  nl: {
    voicemailPrompt: 'Er is op dit moment geen adviseur beschikbaar. Uw bericht wordt opgenomen. Spreek het in na de piep, dan bellen we u zo snel mogelijk terug.',
    noAnswer: 'Geen enkele adviseur kon uw oproep beantwoorden. Bel later nog eens. Tot ziens.',
    noAgent: 'Deze lijn is actief op het Harx-platform. Er is op dit moment geen adviseur beschikbaar. Tot ziens.',
    soloVoicemailPrompt: 'Ik ben op dit moment niet beschikbaar. Uw bericht wordt opgenomen. Spreek het in na de piep, dan bel ik u zo snel mogelijk terug.',
    soloNoAnswer: 'Ik kon uw oproep niet beantwoorden. Bel later nog eens. Tot ziens.',
    soloNoAgent: 'Deze lijn is op dit moment niet bereikbaar. Bel later nog eens. Tot ziens.',
    voicemailThanks: 'Bedankt, uw bericht is opgenomen. Tot ziens.',
    blocked: 'Wij kunnen uw oproep helaas niet aannemen. Tot ziens.',
    transferAnnounce: (name) => `Ik verbind u door met ${name}, blijft u aan de lijn.`,
    transferUnavailable: (name) => `${name} is op dit moment niet beschikbaar.`,
    transferFallbackName: 'De gevraagde persoon',
    menuFor: (name, key) => `Voor ${name}, druk op ${key}.`,
  },
  pt: {
    voicemailPrompt: 'Neste momento não há nenhum consultor disponível. A sua mensagem será gravada. Deixe-a após o sinal e voltaremos a ligar-lhe em breve.',
    noAnswer: 'Nenhum consultor conseguiu atender. Volte a ligar mais tarde. Até breve.',
    noAgent: 'Esta linha está ativa na plataforma Harx. Neste momento não há nenhum consultor disponível. Até breve.',
    soloVoicemailPrompt: 'Neste momento não estou disponível. A sua mensagem será gravada. Deixe-a após o sinal e voltarei a ligar-lhe em breve.',
    soloNoAnswer: 'Não consegui atender. Volte a ligar mais tarde. Até breve.',
    soloNoAgent: 'Esta linha não está disponível neste momento. Volte a ligar mais tarde. Até breve.',
    voicemailThanks: 'Obrigado, a sua mensagem foi gravada. Até breve.',
    blocked: 'Não podemos dar seguimento à sua chamada. Até breve.',
    transferAnnounce: (name) => `Vou transferir a chamada para ${name}, aguarde um momento.`,
    transferUnavailable: (name) => `${name} não está disponível neste momento.`,
    transferFallbackName: 'A pessoa pretendida',
    menuFor: (name, key) => `Para ${name}, marque ${key}.`,
  },
});

export const phrasesFor = (language) => PHRASES[normalizeCompanyLanguage(language)];
