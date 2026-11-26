// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/outboundRefusals.test.js
// Refus sortants : codes stables et messages anglais additifs (outbound-check, voice/token), minutes insuffisantes AVANT l'appel
// (402 MINUTES_INSUFFICIENT_FOR_DESTINATION), messages parlés du webhook en anglais par défaut (fr / es selon la ligne). Base, forfait et Twilio SIMULÉS.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.TWILIO_OUTBOUND_TWIML_APP_SID = 'AP00000000000000000000000000000000';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
const { default: InboundSettings } = await import('../models/InboundSettings.js');
const { default: MinutesCompany } = await import('../models/MinutesCompany.js');
const { PhoneNumber } = await import('../models/PhoneNumber.js');
const { Subscription } = await import('../models/Subscription.js');
const { clearCompanyCache } = await import('../services/planLimits.js').catch(() => ({ clearCompanyCache() {} }));
const BO = await import('../services/browserOutbound.js');
const { phoneNumberController: pc } = await import('../controllers/phoneNumberController.js');
const { phoneNumberService } = await import('../services/phoneNumberService.js');

const C1 = '64b0000000000000000000c1';
const PLAN = { harx_product: 'callcenter', callcenter_tier: 'full_scope', phone_line_price_cents: '1999' };
let lineNumber; let minutes; let walletError; let secretaryOutbound; let who;
const lean = (v) => ({ lean: async () => v, select() { return this; }, sort() { return this; }, limit() { return this; }, then(r, j) { return Promise.resolve(v).then(r, j); } });
const saved = { log: console.log, warn: console.warn, error: console.error };
beforeEach(() => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  clearCompanyCache?.();
  lineNumber = '+33611110001'; minutes = 100; walletError = false; secretaryOutbound = true; who = 'owner';
  const row = () => ({ _id: 'l1', companyId: C1, phoneNumber: lineNumber, provider: 'twilio', twilioId: 'PN1', status: 'active', billingStatus: 'active', createdAt: new Date('2026-01-01') });
  PhoneNumber.find = () => lean([row()]);
  PhoneNumber.findOne = () => lean(row());
  Subscription.findOne = () => ({ populate: async () => ({ planId: { name: 'Offre', metadata: PLAN } }) });
  InboundSettings.findOne = () => lean({ secretaryOutbound });
  MinutesCompany.findOne = () => ({ select: () => ({ lean: async () => { if (walletError) throw new Error('mongo down'); return minutes === undefined ? null : { minutes }; } }) });
  global.fetch = async () => ({ ok: true, json: async () => ({ success: true, data: who === 'agent' ? { companyId: C1, isOwner: false, isAgent: true } : { companyId: C1, isOwner: true } }) });
  mongoose.models.VoiceSigningKey.findOne = () => lean({ sid: 'SK00000000000000000000000000000000', secret: 'secret' });
  phoneNumberService.twilioClient = {};
  const db = { collection: () => ({ find: () => { const c = { sort: () => c, limit: () => c, toArray: async () => [], next: async () => null }; return c; }, findOne: async () => null }) };
  Object.defineProperty(mongoose.connection, 'db', { get: () => db, configurable: true });
});
after(() => { Object.assign(console, saved); });

const hit = async (method, body, extra = {}) => {
  let out = null; const res = { type() { return this; }, status(c) { this.code = c; return this; }, json(x) { out = { code: this.code || 200, body: x }; return this; }, send(x) { out = x; return this; } };
  await pc[method]({ body, query: {}, get: () => 'orch.test', headers: { authorization: 'Bearer tok' }, user: { userId: `${who}-${Math.random()}` }, ...extra }, res);
  return out;
};
const webhook = (to = '+33612345678', over = {}) => {
  const identity = 'cc-sec1';
  const ticket = over.ticket ?? BO.signOutboundTicket({ secret: process.env.TWILIO_AUTH_TOKEN, companyId: C1, identity, secretary: over.secretary ?? false });
  return hit('handleBrowserOutbound', { To: to, From: `client:${identity}`, CompanyId: C1, Ticket: ticket, CallSid: 'CA1' });
};
const said = (xml) => ({ text: (String(xml).match(/<Say[^>]*>([^<]*)<\/Say>/) || [])[1], language: (String(xml).match(/language="([^"]+)"/) || [])[1], voice: (String(xml).match(/voice="([^"]+)"/) || [])[1] });

test('refus parlés : anglais par défaut (en-US, Polly.Joanna), français et espagnol selon la langue de la ligne, repli anglais', () => {
  assert.deepEqual(said(BO.spokenRefusal('insufficient_minutes')), { text: 'Insufficient minutes balance.', language: 'en-US', voice: 'Polly.Joanna' });
  assert.deepEqual(said(BO.spokenRefusal('insufficient_minutes', 'fr')), { text: 'Solde de minutes insuffisant.', language: 'fr-FR', voice: 'Polly.Lea' });
  assert.deepEqual(said(BO.spokenRefusal('insufficient_minutes', 'es')), { text: 'Saldo de minutos insuficiente.', language: 'es-ES', voice: 'Polly.Lucia' });
  assert.equal(said(BO.spokenRefusal('insufficient_minutes', 'de')).language, 'en-US');
  assert.equal(said(BO.spokenRefusal('cle-inconnue', 'fr')).text, 'Une erreur est survenue.');
  for (const [n, l] of [['+33612345678', 'fr'], ['+34612345678', 'es'], ['+14155552671', 'en'], ['+4915112345678', 'en'], ['+212612345678', 'fr'], ['', 'en'], [null, 'en'], ['abc', 'en']]) assert.equal(BO.spokenLanguage(n), l, String(n));
  // chaque clé a ses trois textes, sauf les deux refus déjà contractuellement anglais
  for (const k of Object.keys(BO.SPOKEN_REFUSALS.en).filter((k) => !['line_not_assigned', 'line_busy'].includes(k))) for (const l of ['fr', 'es']) assert.ok(BO.SPOKEN_REFUSALS[l][k], `${l}.${k}`);
});

test('webhook : les refus parlés suivent la langue de la ligne (fr pour +33, anglais pour +1) ; les décisions ne changent pas', async () => {
  minutes = 0;
  assert.deepEqual(said(await webhook()), { text: 'Solde de minutes insuffisant.', language: 'fr-FR', voice: 'Polly.Lea' });
  // Destinations du même indicatif que la ligne (décision du 26/11/2026 : seul le pays de la ligne est appelable).
  lineNumber = '+14155552671';
  assert.deepEqual(said(await webhook('+14155550123')), { text: 'Insufficient minutes balance.', language: 'en-US', voice: 'Polly.Joanna' });
  lineNumber = '+34911234567';
  assert.equal(said(await webhook('+34612345678')).text, 'Saldo de minutos insuficiente.');
  minutes = 100; lineNumber = '+14155552671';
  assert.ok(String(await webhook('+14165550123')).includes('<Dial'), 'avec du solde : l\'appel part (États-Unis -> Canada, même indicatif +1)');
  assert.equal(said(await webhook('+33612345678')).text, 'From your line, you can only call numbers in its country.', 'ligne +1 -> France : refusé');
  Subscription.findOne = () => ({ populate: async () => null });
  assert.equal(said(await webhook('+14155550123')).text, 'No active subscription.');
});

test('webhook : preuve invalide, destination refusée, secrétaire non autorisée, erreur : anglais par défaut', async () => {
  assert.equal(said(await webhook('+33612345678', { ticket: 'faux' })).text, 'Call not authorized.');
  assert.equal(said(await webhook('+33612345678', { ticket: 'faux' })).language, 'en-US');
  assert.equal(said(await webhook('+1 900 555 1234')).text, 'Premium-rate and value-added numbers cannot be called.');
  assert.equal(said(await webhook('abc')).text, 'Invalid number. Enter it in international format.');
  assert.equal(said(await webhook('+4915112345678')).text, 'From your line, you can only call numbers in its country.', 'ligne française -> Allemagne : refusé');
  secretaryOutbound = false;
  assert.equal(said(await webhook('+33612345678', { secretary: true })).text, 'The account owner has turned off outbound calls for secretaries.');
});

const check = (to = '+33612345678') => hit('outboundCheck', { companyId: C1, to });

test('outbound-check : 422 portent `code` (= error), `reason`, message FR existant et `messageEn` additif', async () => {
  for (const [to, code, reason, en] of [
    ['abc', 'invalid_number', 'invalid_number', /Invalid number/],
    ['+1 900 555 1234', 'destination_not_allowed', 'premium_rate', /Premium-rate/],
    ['+999123456789', 'destination_not_allowed', 'unknown_country', /not supported/],
    ['+4915112345678', 'destination_not_allowed', 'not_line_country', /only call numbers in its country \(\+33\)/],
  ]) {
    const r = await check(to);
    assert.equal(r.code, 422, to);
    assert.deepEqual([r.body.success, r.body.error, r.body.code, r.body.reason], [false, code, code, reason], to);
    assert.match(r.body.messageEn, en); assert.ok(/[éèàç ]/.test(r.body.message) && r.body.message !== r.body.messageEn, 'message français inchangé');
  }
  const bad = await hit('outboundCheck', { companyId: 'x', to: '+33612345678' });
  assert.deepEqual([bad.code, bad.body.code, bad.body.error, bad.body.message, bad.body.messageEn], [400, 'invalid_company', 'invalid_company', 'Entreprise invalide.', 'Invalid company.']);
});

test('outbound-check : minutes insuffisantes AVANT l\'appel => 402 MINUTES_INSUFFICIENT_FOR_DESTINATION avec pays, zone null, solde, message EN', async () => {
  minutes = 0;
  const r = await check('+33 6 12 34 56 78');
  assert.equal(r.code, 402);
  assert.deepEqual(r.body, { success: false, error: 'MINUTES_INSUFFICIENT_FOR_DESTINATION', code: 'MINUTES_INSUFFICIENT_FOR_DESTINATION', country: 'FR', zone: null, balance: 0, message: 'You have no minutes for this destination. Top up in the web app.' });
  minutes = 0.9; assert.equal((await check()).code, 402, 'moins d\'une minute entière');
  minutes = -3; assert.equal((await check()).body.balance, -3, 'solde négatif rapporté tel quel');
  minutes = 1; assert.equal((await check()).code, 200, 'une minute entière suffit');
  minutes = undefined; const none = await check();
  assert.deepEqual([none.code, none.body.balance], [402, 0], 'sans portefeuille : comme le webhook, solde 0');
  minutes = 100; assert.deepEqual((await check()).body, { success: true, data: { to: '+33612345678' } });
});

test('règle du solde : lecture en échec => JAMAIS de blocage (outbound-check et voice/token)', async () => {
  walletError = true;
  assert.equal((await check()).code, 200);
  const t = await hit('voiceToken', { outbound: true, companyId: C1 });
  assert.equal(t.code, 200, JSON.stringify(t.body));
});

test('voice/token outbound:true : 402 sans minutes (pays null), jeton émis avec des minutes ; entrant jamais concerné', async () => {
  minutes = 0;
  const r = await hit('voiceToken', { outbound: true, companyId: C1 });
  assert.equal(r.code, 402);
  assert.deepEqual([r.body.code, r.body.error, r.body.country, r.body.zone, r.body.balance, r.body.success], ['MINUTES_INSUFFICIENT_FOR_DESTINATION', 'MINUTES_INSUFFICIENT_FOR_DESTINATION', null, null, 0, false]);
  assert.equal(r.body.message, 'You have no minutes for this destination. Top up in the web app.');
  const inbound = await hit('voiceToken', {});
  assert.equal(inbound.code, 200, 'le jeton entrant ne dépend pas des minutes');
  minutes = 50;
  const ok = await hit('voiceToken', { outbound: true, companyId: C1 });
  assert.equal(ok.code, 200); assert.ok(ok.body.data.token);
});

test('voice/token : 400 companyId invalide et 403 secrétaire non autorisée portent `code` et `messageEn` (message FR existant inchangé)', async () => {
  const bad = await hit('voiceToken', { outbound: true, companyId: 'x' });
  assert.deepEqual([bad.code, bad.body.error, bad.body.code, bad.body.messageEn], [400, 'Invalid companyId', 'invalid_company', 'Invalid company.']);
  who = 'agent'; secretaryOutbound = false;
  const r = await hit('voiceToken', { outbound: true, companyId: C1 });
  assert.equal(r.code, 403);
  assert.deepEqual([r.body.success, r.body.error, r.body.code], [false, 'secretary_outbound_disabled', 'secretary_outbound_disabled']);
  assert.equal(r.body.message, BO.SECRETARY_OUTBOUND_BLOCKED);
  assert.equal(r.body.messageEn, 'The account owner has turned off outbound calls for secretaries.');
});
