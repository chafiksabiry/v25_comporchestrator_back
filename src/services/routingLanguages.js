/**
 * Langues gérées par le routage des files d'attente (liste fermée, codes ISO 639-1 en minuscules).
 * Module pur : aucun accès base ni réseau.
 *
 * ATTENTION - voix : les correspondances langue -> voix Amazon Polly (via Twilio <Say>) ci-dessous sont à VÉRIFIER avec de
 * vrais appels. Elles n'ont été testées que sur le format du TwiML produit, jamais sur une voix réellement jouée.
 * Une langue sans voix prévue (`voice: null`) est lue par la voix anglaise, avec la phrase anglaise.
 */
const L = (code, nameFr, nameNative, nameEn, voice, ttsLanguage, phrase) => ({ code, nameFr, nameNative, nameEn, voice, ttsLanguage, phrase });

export const ROUTING_LANGUAGES = [
  L('fr', 'français', 'Français', 'French', 'Polly.Lea', 'fr-FR', (k) => `Pour le français, tapez ${k}.`),
  L('en', 'anglais', 'English', 'English', 'Polly.Joanna', 'en-US', (k) => `For English, press ${k}.`),
  L('es', 'espagnol', 'Español', 'Spanish', 'Polly.Lucia', 'es-ES', (k) => `Para español, pulse ${k}.`),
  L('de', 'allemand', 'Deutsch', 'German', 'Polly.Vicki', 'de-DE', (k) => `Für Deutsch drücken Sie die ${k}.`),
  L('it', 'italien', 'Italiano', 'Italian', 'Polly.Carla', 'it-IT', (k) => `Per l'italiano, premi ${k}.`),
  L('pt', 'portugais', 'Português', 'Portuguese', 'Polly.Ines', 'pt-PT', (k) => `Para português, prima ${k}.`),
  L('nl', 'néerlandais', 'Nederlands', 'Dutch', 'Polly.Lotte', 'nl-NL', (k) => `Voor Nederlands, druk op ${k}.`),
  L('ar', 'arabe', 'العربية', 'Arabic', 'Polly.Zeina', 'arb', (k) => `للعربية، اضغط ${k}.`),
  L('ru', 'russe', 'Русский', 'Russian', 'Polly.Tatyana', 'ru-RU', (k) => `Для русского языка нажмите ${k}.`),
  L('tr', 'turc', 'Türkçe', 'Turkish', 'Polly.Filiz', 'tr-TR', (k) => `Türkçe için ${k} tuşuna basın.`),
  L('pl', 'polonais', 'Polski', 'Polish', 'Polly.Ewa', 'pl-PL', (k) => `Dla języka polskiego naciśnij ${k}.`),
  L('zh', 'chinois', '中文', 'Chinese', 'Polly.Zhiyu', 'cmn-CN', (k) => `中文请按${k}。`),
  L('ja', 'japonais', '日本語', 'Japanese', 'Polly.Mizuki', 'ja-JP', (k) => `日本語は${k}を押してください。`),
  L('ko', 'coréen', '한국어', 'Korean', 'Polly.Seoyeon', 'ko-KR', (k) => `한국어는 ${k}번을 누르세요.`),
  L('hi', 'hindi', 'हिन्दी', 'Hindi', 'Polly.Aditi', 'hi-IN', (k) => `हिंदी के लिए ${k} दबाएं।`),
  L('sv', 'suédois', 'Svenska', 'Swedish', 'Polly.Astrid', 'sv-SE', (k) => `För svenska, tryck ${k}.`),
  L('da', 'danois', 'Dansk', 'Danish', 'Polly.Naja', 'da-DK', (k) => `For dansk, tryk ${k}.`),
  L('ro', 'roumain', 'Română', 'Romanian', 'Polly.Carmen', 'ro-RO', (k) => `Pentru română, apăsați ${k}.`),
  // Sans voix prévue : repli sur la voix et la phrase anglaises.
  L('he', 'hébreu', 'עברית', 'Hebrew', null, null, null),
  L('vi', 'vietnamien', 'Tiếng Việt', 'Vietnamese', null, null, null),
];

const BY_CODE = new Map(ROUTING_LANGUAGES.map((l) => [l.code, l]));

export const ROUTING_LANGUAGE_CODES = ROUTING_LANGUAGES.map((l) => l.code);

/** Code normalisé (trim + minuscules) ou null si inconnu / pas du texte. */
export function normalizeLanguageCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().toLowerCase();
  return BY_CODE.has(code) ? code : null;
}

export const isRoutingLanguage = (value) => normalizeLanguageCode(value) !== null;

export const languageInfo = (code) => BY_CODE.get(code) || null;

/** Liste publique (code, nom en français, nom en langue native). */
export const listRoutingLanguages = () => ROUTING_LANGUAGES.map(({ code, nameFr, nameNative }) => ({ code, nameFr, nameNative }));

const ENGLISH = BY_CODE.get('en');

/** Voix + langue Twilio <Say> pour un code ; langue inconnue ou sans voix : voix anglaise. */
export function menuVoice(code) {
  const l = BY_CODE.get(code);
  if (l && l.voice) return { voice: l.voice, language: l.ttsLanguage };
  return { voice: ENGLISH.voice, language: ENGLISH.ttsLanguage };
}

/** Phrase par défaut du menu pour une langue et une touche (« Pour le français, tapez 1. »). */
export function defaultMenuPhrase(code, key) {
  const l = BY_CODE.get(code);
  if (l && l.phrase) return l.phrase(key);
  if (l) return `For ${l.nameEn}, press ${key}.`;
  return `Press ${key}.`;
}
