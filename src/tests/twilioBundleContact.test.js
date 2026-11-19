// Run: node --test src/tests/twilioBundleContact.test.js
// POST /api/phone-numbers/twilio/bundles : l'e-mail du dossier (destinataire des notifications d'état de Twilio) et son libellé sont décidés par le serveur.
// Avant : le navigateur envoyait une adresse personnelle codée en dur et le libellé « France: Local - Business » quel que soit le pays.
// Maintenant : contact de l'entreprise, sinon e-mail du compte de l'appelant, sinon 400 contact_email_required (rien n'est envoyé à Twilio).
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
const { bundleContactSources, bundleFriendlyName, cleanEmail, countryLabel, resolveBundleContact, CONTACT_EMAIL_REQUIRED } = await import('../services/twilioBundleContact.js');

const C1 = '64b0000000000000000000c1';
let who; let company; let userProfile; let bundleCalls; let n = 0;
const saved = { log: console.log, warn: console.warn, error: console.error };

beforeEach(() => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  clearCompanyCache();
  who = { companyId: C1, isOwner: true };
  company = { name: 'Acme Conseil', email: 'Contact@Acme.example ' };
  userProfile = { name: 'Owner', email: 'owner@acme.example' };
  bundleCalls = [];
  phoneNumberService.createTwilioBundle = async (...args) => { bundleCalls.push(args); return { sid: 'BU_new' }; };
  TwilioResourceOwner.updateOne = async () => ({});
  bundleContactSources.loadCompany = async (id) => { assert.equal(id, C1, 'société de l\'appelant'); if (company instanceof Error) throw company; return company; };
  bundleContactSources.loadUser = async (id) => { assert.match(String(id), /^u\d+$/); if (userProfile instanceof Error) throw userProfile; return userProfile; };
  global.fetch = async () => ({ ok: true, json: async () => ({ success: true, data: who }) });
});
after(() => { Object.assign(console, saved); });

async function postBundle(body) {
  const layer = phoneNumberRoutes.stack.find((l) => l.route && l.route.path === '/twilio/bundles' && l.route.methods.post);
  assert.ok(layer); n += 1; let out;
  const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code || 200, body: b }; return this; } };
  const req = { params: {}, body, query: {}, headers: { authorization: `Bearer ${jwt.sign({ userId: `u${n}` }, process.env.JWT_SECRET)}` } };
  for (const s of layer.route.stack) { let next = false; await s.handle(req, res, () => { next = true; }); if (!next) break; }
  return out;
}

test('l\'e-mail et le libellé envoyés par le navigateur sont ignorés : contact de l\'entreprise + libellé calculé', async () => {
  const out = await postBundle({ friendlyName: 'France: Local - Business', email: 'someone@elsewhere.example', regulationSid: 'RN123', isoCountry: 'GB' });
  assert.equal(out.code, 200);
  assert.equal(bundleCalls.length, 1);
  const [friendlyName, email, statusCallback, regulationSid, isoCountry] = bundleCalls[0];
  assert.equal(email, 'contact@acme.example');
  assert.equal(friendlyName, 'United Kingdom: Local - Business - Acme Conseil');
  assert.equal(statusCallback, undefined);
  assert.equal(regulationSid, 'RN123');
  assert.equal(isoCountry, 'GB');
});

test('type / endUserType fournis : repris dans le libellé (valeurs inconnues => Local / Business)', async () => {
  await postBundle({ regulationSid: 'RN1', isoCountry: 'FR', type: 'mobile', endUserType: 'individual' });
  assert.equal(bundleCalls[0][0], 'France: Mobile - Individual - Acme Conseil');
  await postBundle({ regulationSid: 'RN1', isoCountry: 'FR', type: '<script>', endUserType: 'robot' });
  assert.equal(bundleCalls[1][0], 'France: Local - Business - Acme Conseil');
});

test('sans e-mail de contact de l\'entreprise : e-mail du compte de l\'appelant', async () => {
  company = { name: 'Acme Conseil', email: '' };
  const out = await postBundle({ regulationSid: 'RN1', isoCountry: 'FR' });
  assert.equal(out.code, 200);
  assert.equal(bundleCalls[0][1], 'owner@acme.example');
});

test('lecture de l\'entreprise en échec : repli sur l\'e-mail du compte', async () => {
  company = new Error('db down');
  const out = await postBundle({ regulationSid: 'RN1', isoCountry: 'FR' });
  assert.equal(out.code, 200);
  assert.equal(bundleCalls[0][1], 'owner@acme.example');
  assert.equal(bundleCalls[0][0], 'France: Local - Business');
});

test('aucune adresse exploitable : 400 contact_email_required, rien n\'est envoyé à Twilio', async () => {
  company = { name: 'Acme Conseil', email: 'pas-une-adresse' };
  userProfile = { name: 'Owner', email: '' };
  const out = await postBundle({ regulationSid: 'RN1', isoCountry: 'FR', email: 'someone@elsewhere.example' });
  assert.equal(out.code, 400);
  assert.equal(out.body.code, CONTACT_EMAIL_REQUIRED);
  assert.ok(out.body.message);
  assert.equal(bundleCalls.length, 0);
});

test('agent : 403 avant toute lecture du contact', async () => {
  who = { companyId: C1, isAgent: true };
  bundleContactSources.loadCompany = async () => { throw new Error('ne doit pas être lu'); };
  const out = await postBundle({ regulationSid: 'RN1', isoCountry: 'FR' });
  assert.equal(out.code, 403);
  assert.equal(bundleCalls.length, 0);
});

test('helpers : cleanEmail, countryLabel, bundleFriendlyName, resolveBundleContact', async () => {
  assert.equal(cleanEmail(' A@B.example '), 'a@b.example');
  assert.equal(cleanEmail('a@b'), '');
  assert.equal(cleanEmail('a b@c.example'), '');
  assert.equal(cleanEmail(undefined), '');
  assert.equal(countryLabel('fr'), 'France');
  assert.equal(countryLabel('UK'), 'United Kingdom');
  assert.equal(countryLabel(''), 'Unknown');
  assert.equal(bundleFriendlyName({ isoCountry: 'DE', type: 'toll-free' }), 'Germany: Toll-free - Business');
  assert.ok(bundleFriendlyName({ isoCountry: 'FR', companyName: 'X'.repeat(200) }).length <= 64);
  assert.equal(bundleFriendlyName({ isoCountry: 'FR', companyName: 'A\nB' }), 'France: Local - Business - A B');
  const none = await resolveBundleContact({ companyId: C1 }, { loadCompany: async () => null, loadUser: async () => ({ email: 'x@y.example' }) });
  assert.deepEqual(none, { email: '', companyName: '', source: '' }, 'sans userId, pas de repli');
});
