// Run: JWT_SECRET=test TELNYX_API_KEY=x node src/tests/companyLanguage.test.js
// Langue des textes de l'entreprise dits aux appelants (pays de la société) : mapping, TwiML, annonces. Base et réseau simulés.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

process.env.JWT_SECRET = 'test-secret';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.DASH_CALLS_API_URL = 'https://dash.test/api';
try { import.meta.resolve('web-push'); } catch {
  register('data:text/javascript,' + encodeURIComponent("export async function resolve(s,c,n){ if(s==='web-push') return {url:'data:text/javascript,export default {setVapidDetails(){},sendNotification(){}}',shortCircuit:true}; return n(s,c);}"));
}

const L = await import('../services/companyLanguage.js');
const { companyLanguage, clearCompanyLanguageCache } = await import('../services/companyLanguageLookup.js');
const flow = await import('../services/inboundFlow.js');
const transfer = await import('../services/callTransfer.js');
const { blockedCallBody } = await import('../services/blockedCallers.js');
const rec = await import('../services/callRecording.js');
const { menuLine, buildMenuBody } = await import('../services/queueRouting.js');
const { buildAnalyzeUrl } = await import('../services/voicemailAnalysis.js');

test('pays -> langue : anglophones, hispanophones, arabophones (sauf le Maroc), francophones, autres, inconnu', () => {
  for (const c of ['GB', 'US', 'IE', 'CA', 'AU', 'NZ']) assert.equal(L.languageForCountry(c), 'en', c);
  for (const c of ['ES', 'MX', 'AR', 'CO']) assert.equal(L.languageForCountry(c), 'es', c);
  for (const c of ['AE', 'SA', 'EG', 'JO', 'KW', 'QA', 'BH', 'OM', 'LB', 'IQ', 'DZ', 'TN', 'LY']) assert.equal(L.languageForCountry(c), 'ar', c);
  for (const c of ['FR', 'BE', 'CH', 'LU', 'MA', 'SN', 'CI']) assert.equal(L.languageForCountry(c), 'fr', c);
  for (const c of ['DE', 'IT', 'PT', 'NL', 'JP', 'BR']) assert.equal(L.languageForCountry(c), 'en', c);
  for (const c of [undefined, null, '', ' ', 'X', 'XYZ', '12']) assert.equal(L.languageForCountry(c), 'fr', String(c));
  assert.equal(L.languageForCountry(' uk '), 'en');
  assert.equal(L.languageForCountry('ma'), 'fr');
});

test('aucun pays dans deux groupes', () => {
  const all = Object.values(L.COUNTRIES_BY_LANGUAGE).flat();
  assert.equal(new Set(all).size, all.length);
});

test('langue déduite du numéro de la ligne', () => {
  assert.equal(L.languageForPhone('+442071234567'), 'en');
  assert.equal(L.languageForPhone('+12125551234'), 'en');
  assert.equal(L.languageForPhone('+34912345678'), 'es');
  assert.equal(L.languageForPhone('+971501234567'), 'ar');
  assert.equal(L.languageForPhone('+212612345678'), 'fr', 'le Maroc reste en français');
  assert.equal(L.languageForPhone('+33612345678'), 'fr');
  assert.equal(L.languageForPhone('+262692123456'), 'fr', 'La Réunion = France');
  assert.equal(L.languageForPhone('+4915112345678'), 'en', 'autre pays : anglais');
  assert.equal(L.languageForPhone('442071234567'), 'en', 'numéro stocké sans +');
  for (const bad of [undefined, '', 'abc', '+1', '0612345678']) assert.equal(L.languageForPhone(bad), 'fr', String(bad));
  assert.equal(L.languageForPhone('', ''), '');
});

test('voix de <Say> par langue, féminine ou masculine', () => {
  assert.deepEqual(L.sayVoice('fr'), { language: 'fr-FR', voice: 'Polly.Lea' });
  assert.deepEqual(L.sayVoice('fr', false), { language: 'fr-FR', voice: 'Polly.Mathieu' });
  assert.deepEqual(L.sayVoice('en'), { language: 'en-US', voice: 'Polly.Joanna' });
  assert.deepEqual(L.sayVoice('en', false), { language: 'en-US', voice: 'Polly.Matthew' });
  assert.deepEqual(L.sayVoice('es', false), { language: 'es-ES', voice: 'Polly.Enrique' });
  assert.equal(L.sayVoice('ar', false).voice, 'Polly.Zeina');
  assert.deepEqual(L.sayVoice('xx'), L.sayVoice('fr'));
});

test('phrases : chaque langue a les mêmes clés que le français', () => {
  for (const lang of ['en', 'es', 'ar']) assert.deepEqual(Object.keys(L.PHRASES[lang]).sort(), Object.keys(L.PHRASES.fr).sort(), lang);
});

test('accueil, répondeur, repli : français inchangé par défaut, langue de la société sinon', () => {
  const base = { settings: null, baseUrl: 'https://x.test', companyId: 'c1', identities: [], resultUrl: 'https://x.test/r' };
  const fr = flow.buildInboundTwiml(base);
  assert.match(fr, /<Say language="fr-FR" voice="Polly.Lea">Aucun conseiller n&apos;est disponible/);
  const en = flow.buildInboundTwiml({ ...base, language: 'en' });
  assert.match(en, /<Say language="en-US" voice="Polly.Joanna">No advisor is available at the moment/);
  assert.doesNotMatch(en, /Aucun|conseiller/);
  const solo = flow.buildInboundTwiml({ ...base, language: 'es', solo: true });
  assert.match(solo, /<Say language="es-ES" voice="Polly.Lucia">No estoy disponible/);
  const noVm = flow.buildInboundTwiml({ ...base, settings: { voicemailEnabled: false }, language: 'ar' });
  assert.match(noVm, /<Say language="arb" voice="Polly.Zeina">.*<\/Say><Hangup\/>/);
});

test('texte d’accueil de l’entreprise : voix de la langue, masculine selon le réglage ; audio validé inchangé', () => {
  const settings = { greetingText: 'Welcome to Acme.', voice: 'onyx', voicemailEnabled: false };
  const en = flow.buildInboundTwiml({ settings, baseUrl: 'https://x.test', companyId: 'c1', identities: [], resultUrl: 'r', language: 'en' });
  assert.match(en, /<Say language="en-US" voice="Polly.Matthew">Welcome to Acme.<\/Say>/);
  const validated = flow.buildInboundTwiml({ settings: { ...settings, greetingValidated: true, greetingAudioVersion: 'abc123' }, baseUrl: 'https://x.test', companyId: 'c1', identities: [], resultUrl: 'r', language: 'en' });
  assert.match(validated, /<Play>https:\/\/x.test\/api\/inbound-settings\/audio\/c1\/greeting\/abc123.mp3<\/Play>/);
});

test('après la sonnerie et remerciement du répondeur dans la langue de la société', () => {
  const noAnswer = flow.buildNoAnswerTwiml({ settings: { voicemailEnabled: false }, baseUrl: 'b', companyId: 'c1', dialStatus: 'no-answer', language: 'en' });
  assert.match(noAnswer, /No advisor was able to answer/);
  assert.match(flow.buildVoicemailDoneTwiml('en'), /Thank you, your message has been recorded/);
  assert.match(flow.buildVoicemailDoneTwiml(), /Merci, votre message a bien été enregistré/);
  assert.equal(flow.NO_ANSWER_MESSAGE, "Aucun conseiller n'a pu répondre. Veuillez rappeler plus tard. Au revoir.");
});

test('transfert : annonce et indisponibilité dans la langue de la société, français par défaut', () => {
  assert.equal(transfer.announceText('Marie  Durand'), 'Je vous passe Marie Durand, ne quittez pas.');
  assert.equal(transfer.announceText('Sam Lee', 'en'), 'Putting you through to Sam Lee, please hold.');
  assert.equal(transfer.unavailableText('Sam Lee', 'es'), 'Sam Lee no puede atenderle en este momento.');
  const twiml = transfer.buildTransferTwiml({ name: 'Sam Lee', number: '+442071234567', resultUrl: 'https://x.test/t', language: 'en' });
  assert.match(twiml, /<Say language="en-US" voice="Polly.Joanna">Putting you through to Sam Lee, please hold.<\/Say><Dial/);
  const msg = transfer.buildTransferMessageTwiml({ name: 'Sam Lee', settings: { voicemailEnabled: false }, baseUrl: 'b', companyId: 'c1', language: 'en' });
  assert.match(msg, /Sam Lee is not available to take your call/);
  assert.match(msg, /No advisor was able to answer/);
  const fr = transfer.buildTransferTwiml({ name: 'Sam', number: '+33612345678', resultUrl: 'r' });
  assert.match(fr, /<Say language="fr-FR" voice="Polly.Lea">Je vous passe Sam/);
});

test('appelant bloqué : refus poli dans la langue de la société', async () => {
  const load = async () => ({ blockedNumbers: [{ phone: '+33611111111' }] });
  const fr = await blockedCallBody('64b0000000000000000000c1', '+33611111111', { load, env: {} });
  assert.match(fr, /Polly.Lea">Nous ne pouvons pas donner suite à votre appel/);
  const en = await blockedCallBody('64b0000000000000000000c1', '+33611111111', { load, env: {}, language: 'en' });
  assert.match(en, /language="en-US" voice="Polly.Joanna">We are unable to take your call. Goodbye./);
});

test('annonce d’enregistrement : la langue de l’interlocuteur prime, sinon celle de la société, sinon le français', () => {
  assert.equal(rec.consentLanguageFor('+971501234567', 'en'), 'ar');
  assert.equal(rec.consentLanguageFor('+33612345678', 'en'), 'fr', 'indicatif français reconnu : français');
  assert.equal(rec.consentLanguageFor('+4915112345678', 'en'), 'en', 'indicatif non reconnu : langue de la société');
  assert.equal(rec.consentLanguageFor('anonymous', 'es'), 'es');
  assert.equal(rec.consentLanguageFor('+4915112345678'), 'fr', 'sans langue de société : français comme avant');
  assert.equal(rec.consentLanguageFor('+4915112345678', 'zz'), 'fr');
  assert.equal(rec.consentLanguageFor('+442071234567', 'fr'), 'en');
  const plan = rec.buildRecordingPlan({ record: true, companyId: '64b0000000000000000000c1', callSid: `CA${'a'.repeat(32)}`, baseUrl: 'https://x.test', language: rec.consentLanguageFor('+4915112345678', 'en') });
  assert.match(plan.say, /This call may be recorded/);
});

test('menu vocal : phrase générique dans la langue de la société ; langue de file inchangée', () => {
  const q = { name: 'Billing', menuKey: '2', languages: [], prompt: '' };
  assert.equal(menuLine(q).text, 'Pour Billing, tapez 2.');
  assert.deepEqual(menuLine(q, 'en'), { language: 'en-US', voice: 'Polly.Joanna', text: 'For Billing, press 2.' });
  assert.equal(menuLine({ ...q, languages: ['es'] }, 'en').text, 'Para español, pulse 2.');
  assert.equal(menuLine({ ...q, prompt: 'Welcome' }, 'en').language, 'en-US', 'texte sans langue : voix de la société');
  assert.equal(menuLine({ ...q, prompt: 'Hola', promptLanguage: 'es' }, 'en').language, 'es-ES');
  assert.match(buildMenuBody({ queues: [{ ...q, menuKey: '1' }, { ...q, name: 'Sales', menuKey: '2' }], baseUrl: 'https://x.test', language: 'en' }), /For Billing, press 1\..*For Sales, press 2\./);
});

test('analyse du répondeur : la langue de la société est envoyée à dash_calls, rien sans langue', () => {
  const p = { apiBase: 'https://dash.test/api', companyId: 'c1', from: '+33600000000', recordingSid: 'RE1' };
  assert.equal(new URL(buildAnalyzeUrl({ ...p, language: 'en' })).searchParams.get('language'), 'en');
  assert.equal(new URL(buildAnalyzeUrl(p)).searchParams.has('language'), false);
});

test('langue de l’entreprise lue sur ses lignes : première ligne lisible, cache, repli français', async () => {
  clearCompanyLanguageCache();
  let calls = 0;
  const loadLines = async () => { calls += 1; return [{ phoneNumber: 'inconnu' }, { phoneNumber: '+442071234567' }]; };
  assert.equal(await companyLanguage('c1', { loadLines }), 'en');
  assert.equal(await companyLanguage('c1', { loadLines }), 'en');
  assert.equal(calls, 1, 'résultat gardé en cache');
  assert.equal(await companyLanguage('c2', { loadLines: async () => [] }), 'fr');
  assert.equal(await companyLanguage('c3', { loadLines: async () => { throw new Error('base indisponible'); } }), 'fr');
  assert.equal(await companyLanguage(''), 'fr');
});
