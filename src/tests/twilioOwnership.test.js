// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/twilioOwnership.test.js
// /api/phone-numbers/twilio/bundles/:sid/items et /submit : le dossier (et la pièce ajoutée) doivent appartenir à la société de l'appelant. Avant : un simple JWT suffisait pour
// ajouter des pièces au dossier d'autrui ou le soumettre à Twilio avec n'importe quel sid. Maintenant : propriété enregistrée à la création (bundle, personne, document, adresse),
// vérifiée avant tout appel Twilio ; autre société ou sid inconnu : 404 sans appel Twilio.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
const { default: TwilioResourceOwner } = await import('../models/TwilioResourceOwner.js');
const { phoneNumberRoutes } = await import('../routes/phoneNumber.js');
const { phoneNumberService } = await import('../services/phoneNumberService.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');
const { bundleContactSources } = await import('../services/twilioBundleContact.js');

const C1 = '64b0000000000000000000c1'; const C2 = '64b0000000000000000000c2';
let who; let owners; let twilioCalls; let n = 0;
const saved = { log: console.log, warn: console.warn, error: console.error };
beforeEach(() => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  clearCompanyCache(); who = { companyId: C1, isOwner: true }; owners = []; twilioCalls = 0;
  const tw = (extra = {}) => async () => { twilioCalls += 1; return { ...extra }; };
  phoneNumberService.createTwilioBundle = tw({ sid: 'BU_new' }); phoneNumberService.createTwilioEndUser = tw({ sid: 'IT_new' }); phoneNumberService.createTwilioAddress = tw({ sid: 'AD_new' });
  phoneNumberService.createTwilioDocument = tw({ sid: 'RD_new' }); phoneNumberService.assignItemToBundle = tw({ ok: true }); phoneNumberService.submitTwilioBundle = tw({ status: 'pending-review' });
  TwilioResourceOwner.findOne = (q) => ({ select: () => ({ lean: async () => owners.find((o) => o.sid === q.sid && (!q.kind || o.kind === q.kind) && o.companyId === q.companyId) || null }) });
  TwilioResourceOwner.updateOne = async (q, u) => { if (!owners.find((o) => o.sid === q.sid)) owners.push({ ...u.$setOnInsert }); return {}; };
  global.fetch = async () => ({ ok: true, json: async () => ({ success: true, data: who }) });
  bundleContactSources.loadCompany = async () => ({ name: 'Société test', email: 'contact@societe.test' });
});
after(() => { Object.assign(console, saved); });

async function call(method, path, { params = {}, body = {} } = {}) {
  const layer = phoneNumberRoutes.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  assert.ok(layer, path); n += 1; let out;
  const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code || 200, body: b }; return this; } };
  const req = { params, body, query: {}, file: { buffer: Buffer.from('x'), mimetype: 'application/pdf', originalname: 'a.pdf' }, headers: { authorization: `Bearer ${jwt.sign({ userId: `u${n}` }, process.env.JWT_SECRET)}` } };
  for (const s of layer.route.stack) { if (s.name === 'multerMiddleware') continue; let next = false; await s.handle(req, res, () => { next = true; }); if (!next) break; }
  return out;
}

test('la création enregistre la propriété au nom de la société de l\'appelant (dossier, personne, document, adresse)', async () => {
  assert.equal((await call('post', '/twilio/bundles', { body: { friendlyName: 'b' } })).code, 200);
  assert.equal((await call('post', '/twilio/end-users', { body: { friendlyName: 'e' } })).code, 200);
  assert.equal((await call('post', '/twilio/documents', { body: { friendlyName: 'd' } })).code, 200);
  assert.equal((await call('post', '/twilio/addresses', { body: { customerName: 'c' } })).code, 200);
  assert.deepEqual(owners.map((o) => [o.kind, o.sid, o.companyId]), [['bundle', 'BU_new', C1], ['end_user', 'IT_new', C1], ['document', 'RD_new', C1], ['address', 'AD_new', C1]]);
});

test('items / submit : le dossier d\'une AUTRE société, une pièce d\'autrui ou un sid inconnu => 404 sans aucun appel Twilio', async () => {
  owners.push({ kind: 'bundle', sid: 'BU_c1', companyId: C1 }, { kind: 'end_user', sid: 'IT_c1', companyId: C1 }, { kind: 'end_user', sid: 'IT_c2', companyId: C2 });
  who = { companyId: C2, isOwner: true }; clearCompanyCache();
  assert.equal((await call('post', '/twilio/bundles/:sid/items', { params: { sid: 'BU_c1' }, body: { objectSid: 'IT_c2' } })).code, 404, 'dossier d\'autrui');
  assert.equal((await call('post', '/twilio/bundles/:sid/submit', { params: { sid: 'BU_c1' } })).code, 404, 'soumission du dossier d\'autrui');
  who = { companyId: C1, isOwner: true }; clearCompanyCache();
  assert.equal((await call('post', '/twilio/bundles/:sid/items', { params: { sid: 'BU_c1' }, body: { objectSid: 'IT_c2' } })).code, 404, 'pièce d\'une autre société');
  assert.equal((await call('post', '/twilio/bundles/:sid/items', { params: { sid: 'BU_inconnu' }, body: { objectSid: 'IT_c1' } })).code, 404, 'dossier inconnu (créé avant le déploiement)');
  assert.equal((await call('post', '/twilio/bundles/:sid/items', { params: { sid: 'IT_c1' }, body: { objectSid: 'IT_c1' } })).code, 404, 'un sid de personne n\'est pas un dossier');
  assert.equal(twilioCalls, 0, 'rien n\'a été envoyé à Twilio');
});

test('items / submit : la société propriétaire (propriétaire ou membre) ajoute SES pièces à SON dossier et le soumet', async () => {
  owners.push({ kind: 'bundle', sid: 'BU_c1', companyId: C1 }, { kind: 'document', sid: 'RD_c1', companyId: C1 });
  for (const isOwner of [true, false]) {
    who = { companyId: C1, isOwner }; clearCompanyCache(); twilioCalls = 0;
    assert.equal((await call('post', '/twilio/bundles/:sid/items', { params: { sid: 'BU_c1' }, body: { objectSid: 'RD_c1' } })).code, 200);
    assert.equal((await call('post', '/twilio/bundles/:sid/submit', { params: { sid: 'BU_c1' } })).code, 200);
    assert.equal(twilioCalls, 2);
  }
});
