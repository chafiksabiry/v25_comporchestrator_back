/**
 * TwiML des tests de ligne (appel de test sortant de l'onboarding, confirmation par la touche 1, test d'appel entrant). Ce sont des phrases
 * SYSTÈME : elles suivent le pays du numéro de la LIGNE (`languageForPhone`), comme le répondeur et les autres phrases fixes. Avant, tout était
 * codé en dur en français (fr-FR, Polly.Lea), y compris pour une ligne britannique.
 *
 * La langue est calculée au lancement de l'appel sortant depuis le numéro émetteur et passée dans l'URL TwiML (`?l=en`), puis reprise dans
 * l'URL du <Gather>. Le paramètre est validé contre une liste blanche : toute valeur absente ou inconnue donne l'anglais.
 */
import { COMPANY_LANGUAGES, DEFAULT_COMPANY_LANGUAGE, languageForPhone, phrasesFor, sayVoice } from './companyLanguage.js';

/** Langue lue dans le paramètre `l` d'un webhook de test : code exact de la liste blanche, sinon anglais. */
export const testCallLanguageParam = (raw) => {
  const code = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return COMPANY_LANGUAGES.includes(code) ? code : DEFAULT_COMPANY_LANGUAGE;
};

/** Langue des phrases du test pour une ligne (numéro E.164 émetteur). */
export const testCallLanguageForLine = (lineE164) => languageForPhone(lineE164);

/** Ajoute `?l=<langue>` (ou `&l=`) à une URL de webhook de test. */
export const withTestCallLanguage = (url, language) => `${url}${url.includes('?') ? '&' : '?'}l=${testCallLanguageParam(language)}`;

const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const say = (language, text) => {
  const v = sayVoice(language);
  return `<Say language="${v.language}" voice="${v.voice}">${escapeXml(text)}</Say>`;
};

const doc = (body) => `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${body}\n</Response>`;

/** Appel de test sortant : accueil, relance dans le <Gather>, « aucune confirmation », dans la langue de la ligne. */
export function buildTestCallTwiml({ language, gatherAction }) {
  const lang = testCallLanguageParam(language);
  const p = phrasesFor(lang);
  return doc(
    [
      `  ${say(lang, p.testCallGreeting)}`,
      `  <Gather numDigits="1" timeout="20" action="${escapeXml(withTestCallLanguage(gatherAction, lang))}" method="POST">`,
      `    ${say(lang, p.testCallRepeat)}`,
      '  </Gather>',
      `  ${say(lang, p.testCallNoConfirmation)}`,
      '  <Hangup/>',
    ].join('\n')
  );
}

/** Réponse au <Gather> de l'appel de test : merci (touche 1) ou confirmation invalide. */
export function buildTestCallGatherTwiml({ language, confirmed }) {
  const lang = testCallLanguageParam(language);
  const p = phrasesFor(lang);
  return doc(`  ${say(lang, confirmed ? p.testCallConfirmed : p.testCallInvalid)}\n  <Hangup/>`);
}

/** Corps TwiML (sans <Response>) du test d'appel entrant réussi, dans la langue de la ligne appelée. */
export function inboundTestSuccessBody(language) {
  const lang = testCallLanguageParam(language);
  return `${say(lang, phrasesFor(lang).inboundTestSuccess)}<Hangup/>`;
}

/** Message dit par Telnyx (action speak) à l'appel de test décroché : texte et code de langue. */
export function telnyxTestSpeak(language) {
  const lang = testCallLanguageParam(language);
  return { payload: phrasesFor(lang).testCallSpoken, voice: 'female', language: sayVoice(lang).language };
}
