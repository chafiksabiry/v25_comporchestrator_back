// Run: JWT_SECRET=t node --test src/tests/errorCodesVoicemailInbound.test.js
// Lot 3e-1 (répondeur + réglages d'accueil) : chaque erreur gagne un `code` stable ; `error` / `message` restent EXACTEMENT ceux d'avant.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
const { voicemailController } = await import('../controllers/voicemailController.js');
const { inboundSettingsController } = await import('../controllers/inboundSettingsController.js');
const { validateSettingsInput } = await import('../services/inboundSettings.js');
const { validatePrefixList } = await import('../services/outboundDestinations.js');
const Voicemail = (await import('../models/Voicemail.js')).default;
const InboundSettings = (await import('../models/InboundSettings.js')).default;
const { clearCompanyCache } = await import('../middleware/companyScope.js');

const C1 = '64b0000000000000000000a1';
const VM = '64b0000000000000000000f1';
const mockRes = () => ({ statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; }, set() { return this; } });
const call = async (fn, req) => { const r = mockRes(); await fn(req, r); return r; };
const req = (over = {}) => ({ query: {}, params: {}, body: {}, headers: { authorization: 'Bearer t' }, user: { userId: 'u1' }, ...over });
let vmDoc;
beforeEach(() => {
  clearCompanyCache(); vmDoc = null;
  console.error = () => {}; console.warn = () => {}; console.log = () => {};
  Voicemail.findById = (id) => { const p = Promise.resolve(vmDoc); p.lean = async () => vmDoc; return p; };
  global.fetch = async () => ({ ok: true, json: async () => ({ success: true, data: { companyId: C1, isOwner: false, isAgent: true } }) });
});
const expectErr = (r, status, code, message) => {
  assert.equal(r.statusCode, status);
  assert.equal(r.body.success, false);
  assert.equal(r.body.code, code);
  assert.equal(r.body.error, message, 'error inchangé');
  assert.equal(r.body.message, message, 'message inchangé');
};

test('répondeur : codes stables, messages d\'origine inchangés', async () => {
  expectErr(await call(voicemailController.list, req({ query: { companyId: 'x' } })), 400, 'INVALID_COMPANY', 'companyId invalide.');
  expectErr(await call(voicemailController.list, req({ query: { companyId: C1, status: 'zzz' } })), 400, 'INVALID_FOLLOW_UP_STATUS', 'Statut de suivi invalide.');
  expectErr(await call(voicemailController.audio, req({ params: { id: 'bad' } })), 404, 'VOICEMAIL_NOT_FOUND', 'Message introuvable.');
  expectErr(await call(voicemailController.patch, req({ params: { id: VM } })), 404, 'VOICEMAIL_NOT_FOUND', 'Message introuvable.');
  expectErr(await call(voicemailController.analyze, req({ params: { id: VM } })), 404, 'VOICEMAIL_NOT_FOUND', 'Message introuvable.');
  vmDoc = { _id: VM, companyId: C1, save: async () => {}, toObject: () => ({ _id: VM }) };
  expectErr(await call(voicemailController.patch, req({ params: { id: VM }, body: { followUpStatus: 'zzz' } })), 400, 'INVALID_FOLLOW_UP_STATUS', 'Statut de suivi invalide.');
  expectErr(await call(voicemailController.patch, req({ params: { id: VM }, body: { note: 'x'.repeat(1001) } })), 400, 'INVALID_NOTE', 'La note doit être un texte de 1000 caractères maximum.');
  // erreur interne (save qui échoue)
  vmDoc.save = async () => { throw new Error('boom'); };
  expectErr(await call(voicemailController.patch, req({ params: { id: VM }, body: { note: 'ok' } })), 500, 'VOICEMAIL_UPDATE_FAILED', 'Mise à jour du message impossible.');
});

test('rappel : codes stables (authentification, identifiant, message, numéro, ligne)', async () => {
  expectErr(await call(voicemailController.callbackToken, req({ user: {}, params: { id: VM } })), 401, 'AUTH_REQUIRED', 'Authentification requise.');
  expectErr(await call(voicemailController.callbackToken, req({ params: { id: 'bad' } })), 400, 'INVALID_ID', 'Identifiant invalide.');
  expectErr(await call(voicemailController.callbackToken, req({ params: { id: VM } })), 404, 'VOICEMAIL_NOT_FOUND', 'Message introuvable.');
  vmDoc = { _id: VM, companyId: C1, from: 'anonymous', phoneNumber: '+33612340001' };
  expectErr(await call(voicemailController.callbackToken, req({ params: { id: VM } })), 422, 'NO_CALLBACK_NUMBER', 'Aucun numéro à rappeler : l’appelant n’a pas laissé de numéro exploitable.');
  vmDoc = { _id: VM, companyId: C1, from: '+33899123456', phoneNumber: '+33612340001' };
  const r = await call(voicemailController.callbackToken, req({ params: { id: VM } }));
  assert.equal(r.statusCode, 422); assert.equal(r.body.code, 'destination_not_allowed'); assert.equal(r.body.reason, 'premium_rate');
  assert.equal(r.body.message, 'Les numéros surtaxés ou à valeur ajoutée ne peuvent pas être appelés.');
});

test('réglages d\'accueil : codes stables ; validation = `issues` parallèles à `errors`', async () => {
  const get = await call(inboundSettingsController.get, req({ query: { companyId: 'x' } }));
  expectErr(get, 400, 'INVALID_COMPANY', 'companyId invalide.');
  InboundSettings.findOne = () => { throw new Error('boom'); };
  expectErr(await call(inboundSettingsController.get, req({ query: { companyId: C1 } })), 500, 'INBOUND_SETTINGS_READ_FAILED', "Lecture des réglages d'accueil impossible.");
  // validation
  let r = await call(inboundSettingsController.put, req({ body: { companyId: C1, voice: 'zzz', ringTimeoutSeconds: 1, greetingText: 5 } }));
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, r.body.errors[0]); assert.equal(r.body.message, r.body.errors[0]);
  assert.deepEqual(r.body.issues.map((i) => i.code), ['INVALID_TEXT', 'UNKNOWN_VOICE', 'INVALID_RING_TIMEOUT']);
  assert.equal(r.body.code, 'INVALID_TEXT');
  assert.equal(r.body.issues.length, r.body.errors.length);
  assert.equal(r.body.errors[0], "Le message d'accueil doit être un texte.", 'message inchangé');
  // droits : une secrétaire ne règle ni l'appel sortant ni les pays
  expectErr(await call(inboundSettingsController.put, req({ body: { companyId: C1, secretaryOutbound: true } })), 403, 'SECRETARY_OUTBOUND_MANAGER_ONLY', 'Seul le responsable peut régler les appels sortants des secrétaires.');
  expectErr(await call(inboundSettingsController.put, req({ body: { companyId: C1, outboundPrefixes: ['+33'] } })), 403, 'OUTBOUND_COUNTRIES_MANAGER_ONLY', 'Seul le responsable peut choisir les pays autorisés pour les appels sortants.');
  // audio
  expectErr(await call(inboundSettingsController.putAudio, req({ query: { companyId: 'x' }, params: { kind: 'greeting' } })), 400, 'INVALID_COMPANY', 'companyId invalide.');
  expectErr(await call(inboundSettingsController.putAudio, req({ query: { companyId: C1 }, params: { kind: 'zzz' } })), 400, 'INVALID_AUDIO_KIND', 'Type audio inconnu (greeting ou voicemail).');
  expectErr(await call(inboundSettingsController.putAudio, req({ query: { companyId: C1 }, params: { kind: 'greeting' }, body: Buffer.from('pas un mp3') })), 400, 'INVALID_AUDIO_FILE', 'Fichier audio invalide : un MP3 de plus de 1 ko est attendu.');
});

test('validateSettingsInput et validatePrefixList : codes additifs, champs d\'origine conservés', () => {
  const v = validateSettingsInput({ greetingText: 'x'.repeat(5000), voicemailEnabled: 'non', greetingEnabled: 1, secretaryOutbound: 'a' });
  assert.equal(v.ok, false);
  assert.equal(v.issues.length, v.errors.length);
  assert.deepEqual(v.issues.map((i) => i.code), ['TEXT_TOO_LONG', 'INVALID_BOOLEAN', 'INVALID_BOOLEAN', 'INVALID_BOOLEAN']);
  assert.deepEqual(v.issues.map((i) => i.field), ['greetingText', 'voicemailEnabled', 'greetingEnabled', 'secretaryOutbound']);
  assert.equal(typeof v.issues[0].params.max, 'number');
  assert.deepEqual(validateSettingsInput({ secretaryOutbound: false }).issues, []);
  const a = validatePrefixList('x'); assert.deepEqual([a.ok, a.code, a.error], [false, 'LIST_NOT_ARRAY', 'La liste des pays autorisés doit être un tableau.']);
  const b = validatePrefixList(['+999999']); assert.deepEqual([b.ok, b.code, b.params, b.error], [false, 'UNKNOWN_COUNTRY_PREFIX', { prefix: '+999999' }, 'Indicatif de pays inconnu : « +999999 ».']);
  assert.equal(validatePrefixList(['+33']).ok, true);
});
