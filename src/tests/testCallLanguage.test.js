// Run: node --test src/tests/testCallLanguage.test.js
// Tests de ligne (appel de test sortant, touche 1, test d'appel entrant) : les phrases suivent le pays du numéro de la LIGNE
// (+44 -> anglais, +33 -> français, +212 -> français), paramètre de langue validé (inconnu -> anglais). Base et opérateur simulés.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
try { import.meta.resolve('web-push'); } catch {
  register('data:text/javascript,' + encodeURIComponent("export async function resolve(s,c,n){ if(s==='web-push') return {url:'data:text/javascript,export default {setVapidDetails(){},sendNotification(){}}',shortCircuit:true}; return n(s,c); }"));
}

const T = await import('../services/testCallTwiml.js');
const L = await import('../services/companyLanguage.js');
const { PhoneNumber } = await import('../models/PhoneNumber.js');
const { phoneNumberService } = await import('../services/phoneNumberService.js');
const { startInboundTest, clearInboundTests } = await import('../services/inboundTestService.js');
const { phoneNumberController: pc, testCallSessionsForTests } = await import('../controllers/phoneNumberController.js');

const C1 = '64b0000000000000000000c1';
const UK = '+442046522552';
const FR = '+33188732537';
const MA = '+212522000000';
const MOBILE = '+447700900123';

let lines; let created;
const savedLog = { log: console.log, warn: console.warn, error: console.error };
const savedCreate = phoneNumberService.twilioClient.calls.create;
const savedFindOne = PhoneNumber.findOne;
const savedUpdateMany = PhoneNumber.updateMany;
beforeEach(() => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  lines = [UK, FR, MA].map((n, i) => ({ _id: `l${i}`, companyId: C1, phoneNumber: n, provider: 'twilio', twilioId: `PN${i}` }));
  created = [];
  PhoneNumber.findOne = async (f) => lines.find((l) => String(l.phoneNumber) === String(f.phoneNumber)) || null;
  PhoneNumber.updateMany = async () => ({});
  phoneNumberService.twilioClient.calls.create = async (p) => { created.push(p); return { sid: `CA${created.length}`, status: 'queued' }; };
  testCallSessionsForTests.clear();
  clearInboundTests();
});
after(() => {
  Object.assign(console, savedLog);
  phoneNumberService.twilioClient.calls.create = savedCreate;
  PhoneNumber.findOne = savedFindOne;
  PhoneNumber.updateMany = savedUpdateMany;
});

const mkRes = () => {
  const r = { code: 200, body: null, type() { return r; }, status(c) { r.code = c; return r; }, send(b) { r.body = b; return r; }, json(b) { r.body = b; return r; } };
  return r;
};
const req = ({ body = {}, query = {} } = {}) => ({ body, query, get: () => 'api.test' });
const says = (xml) => [...String(xml).matchAll(/<Say language="([^"]+)" voice="([^"]+)">([^<]*)<\/Say>/g)].map((m) => ({ language: m[1], voice: m[2], text: m[3] }));

/** Lance l'appel de test depuis `from`, puis joue l'URL TwiML que Twilio recevrait. */
async function launchAndFetchTwiml(from) {
  const res = mkRes();
  await pc.testCall(req({ body: { fromNumber: from, toNumber: MOBILE, companyId: C1 } }), res);
  assert.equal(res.body?.success, true, JSON.stringify(res.body));
  const url = new URL(created.at(-1).url);
  const twimlRes = mkRes();
  await pc.handleTwilioTestCallTwiml(req({ body: { CallSid: 'CA1' }, query: Object.fromEntries(url.searchParams) }), twimlRes);
  return { url, xml: twimlRes.body };
}

test('ligne +44 : URL TwiML ?l=en, accueil / relance / aucune confirmation en anglais avec la voix anglaise, gather en ?l=en', async () => {
  const { url, xml } = await launchAndFetchTwiml(UK);
  assert.equal(url.pathname, '/api/phone-numbers/webhooks/twilio/test-call-twiml');
  assert.equal(url.searchParams.get('l'), 'en');
  const s = says(xml);
  assert.equal(s.length, 3);
  for (const x of s) assert.deepEqual([x.language, x.voice], ['en-US', 'Polly.Joanna-Generative']);
  assert.deepEqual(s.map((x) => x.text), [L.PHRASES.en.testCallGreeting, L.PHRASES.en.testCallRepeat, L.PHRASES.en.testCallNoConfirmation]);
  assert.match(xml, /<Gather numDigits="1" timeout="20" action="https:\/\/api\.test\/api\/phone-numbers\/webhooks\/twilio\/test-call-gather\?l=en" method="POST">/);
  assert.doesNotMatch(xml, /fr-FR|Polly\.Lea|Bonjour/);
  assert.equal(testCallSessionsForTests.get('CA1').language, 'en');
});

test('ligne +33 : français (textes d\'origine inchangés, Polly.Lea)', async () => {
  const { url, xml } = await launchAndFetchTwiml(FR);
  assert.equal(url.searchParams.get('l'), 'fr');
  const s = says(xml);
  for (const x of s) assert.deepEqual([x.language, x.voice], ['fr-FR', 'Polly.Lea-Generative']);
  assert.equal(s[0].text, 'Bonjour, ceci est un appel de test depuis la plateforme Harx. Appuyez sur la touche 1 pour confirmer que vous avez bien reçu cet appel.');
  assert.equal(s[1].text, 'Je répète : appuyez sur 1 maintenant pour confirmer.');
  assert.equal(s[2].text, 'Aucune confirmation reçue. Au revoir.');
  assert.match(xml, /test-call-gather\?l=fr"/);
});

test('ligne +212 (Maroc) : français', async () => {
  const { url, xml } = await launchAndFetchTwiml(MA);
  assert.equal(url.searchParams.get('l'), 'fr');
  assert.ok(says(xml).every((x) => x.language === 'fr-FR'));
});

test('paramètre l absent, inconnu ou piégé : anglais', async () => {
  for (const l of [undefined, '', 'xx', 'FR-fr', 'french', 'en"><Play>x</Play>', ['fr', 'en'], { a: 1 }]) {
    const res = mkRes();
    await pc.handleTwilioTestCallTwiml(req({ body: { CallSid: 'CAx' }, query: l === undefined ? {} : { l } }), res);
    const s = says(res.body);
    assert.equal(s.length, 3, String(l));
    assert.ok(s.every((x) => x.language === 'en-US' && x.voice === 'Polly.Joanna-Generative'), String(l));
    assert.match(res.body, /test-call-gather\?l=en"/);
    assert.doesNotMatch(res.body, /<Play>/);
  }
  assert.equal(T.testCallLanguageParam(' DE '), 'de');
  assert.equal(T.testCallLanguageParam('english'), 'en');
});

test('les 8 langues : voix Polly de la table commune, texte présent', () => {
  for (const lang of L.COMPANY_LANGUAGES) {
    const s = says(T.buildTestCallTwiml({ language: lang, gatherAction: 'https://h/g' }));
    const v = L.sayVoice(lang);
    assert.equal(s.length, 3, lang);
    assert.ok(s.every((x) => x.language === v.language && x.voice === v.voice && x.text.trim()), lang);
  }
});

test('touche 1 / autre touche : réponse dans la langue du paramètre (en, fr, invalide -> en)', async () => {
  const run = async (query, Digits) => { const r = mkRes(); await pc.handleTwilioTestCallGather(req({ body: { CallSid: 'CA9', Digits }, query }), r); return says(r.body); };
  assert.deepEqual(await run({ l: 'en' }, '1'), [{ language: 'en-US', voice: 'Polly.Joanna-Generative', text: L.PHRASES.en.testCallConfirmed }]);
  assert.deepEqual(await run({ l: 'en' }, '2'), [{ language: 'en-US', voice: 'Polly.Joanna-Generative', text: L.PHRASES.en.testCallInvalid }]);
  assert.deepEqual(await run({ l: 'fr' }, '1'), [{ language: 'fr-FR', voice: 'Polly.Lea-Generative', text: 'Merci. Confirmation reçue. Votre ligne fonctionne correctement. Au revoir.' }]);
  assert.deepEqual(await run({ l: 'fr' }, '9'), [{ language: 'fr-FR', voice: 'Polly.Lea-Generative', text: 'Confirmation invalide. Au revoir.' }]);
  assert.equal((await run({ l: 'zz' }, '1'))[0].language, 'en-US');
  assert.equal((await run({}, '1'))[0].language, 'en-US');
});

test('test d\'appel entrant réussi : langue de la ligne appelée (+44 anglais, +33 français, +212 français)', async () => {
  for (const [line, lang] of [[UK, 'en'], [FR, 'fr'], [MA, 'fr']]) {
    startInboundTest(line);
    const r = mkRes();
    await pc.handleTwilioInboundCall(req({ body: { To: line, From: MOBILE, CallSid: `CAin${lang}` } }), r);
    const s = says(r.body);
    assert.deepEqual(s, [{ ...L.sayVoice(lang), text: L.PHRASES[lang].inboundTestSuccess }], line);
    assert.match(r.body, /<Hangup\/>/);
  }
});

test('Telnyx : message parlé de l\'appel de test dans la langue de la ligne', () => {
  assert.deepEqual(T.telnyxTestSpeak('en'), { payload: L.PHRASES.en.testCallSpoken, voice: 'female', language: 'en-US' });
  assert.equal(T.telnyxTestSpeak('fr').payload, 'Bonjour. Ceci est un appel de test depuis la plateforme Harx. Votre ligne est parfaitement configurée. Au revoir !');
  assert.equal(T.telnyxTestSpeak('nope').language, 'en-US');
});

// ---------------------------------------------------------------- message d'accueil / de répondeur par défaut
const IS = await import('../services/inboundSettings.js');
const flow = await import('../services/inboundFlow.js');

test('accueil par défaut : aucun texte créé côté serveur (vide), donc rien de français enregistré à la création', () => {
  assert.equal(IS.DEFAULTS.greetingText, '');
  assert.equal(IS.DEFAULTS.voicemailText, '');
  const pub = IS.toPublicSettings(null);
  assert.equal(pub.greetingText, '');
  assert.equal(pub.voicemailText, '');
});

test('accueil par défaut sur une ligne +44 : pas d\'accueil dit, répondeur par défaut en anglais ; +33 et +212 : français', () => {
  for (const [line, lang] of [[UK, 'en'], [FR, 'fr'], [MA, 'fr']]) {
    const language = L.languageForPhone(line);
    assert.equal(language, lang, line);
    assert.equal(flow.greetingTwiml(null, 'https://api.test', C1, language), '', line);
    const xml = flow.buildNoAnswerTwiml({ settings: null, baseUrl: 'https://api.test', companyId: C1, dialStatus: 'no-answer', language });
    assert.deepEqual(says(xml)[0], { ...L.sayVoice(lang), text: flow.xmlEscape(L.PHRASES[lang].voicemailPrompt) }, line);
  }
});

test('texte écrit par l\'entreprise : jamais traduit (dit tel quel, même sur une ligne +44)', () => {
  const xml = flow.greetingTwiml({ greetingText: 'Bonjour et bienvenue chez Acme.' }, 'https://api.test', C1, L.languageForPhone(UK));
  assert.equal(says(xml)[0].text, 'Bonjour et bienvenue chez Acme.');
});
