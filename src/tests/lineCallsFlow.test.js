// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/lineCallsFlow.test.js
// Lot 5 (Accueil) : « une ligne = un appel actif ». Règle datée inactive / autre offre : comportement INCHANGÉ. Base, forfait, présence et Twilio SIMULÉS.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { register } from 'node:module';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.TWILIO_OUTBOUND_TWIML_APP_SID = 'AP00000000000000000000000000000000';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
try { import.meta.resolve('web-push'); } catch {
  register('data:text/javascript,' + encodeURIComponent("export async function resolve(s,c,n){ if(s==='web-push') return {url:'data:text/javascript,export default {setVapidDetails(){},sendNotification(){}}',shortCircuit:true}; return n(s,c); }"));
}
const { default: CallQueue } = await import('../models/CallQueue.js');
const { default: StaffRouting } = await import('../models/StaffRouting.js');
const { default: InboundCall } = await import('../models/InboundCall.js');
const { default: InboundSettings } = await import('../models/InboundSettings.js');
const { default: ReachSettings } = await import('../models/ReachSettings.js');
const { default: MinutesCompany } = await import('../models/MinutesCompany.js');
const { PhoneNumber } = await import('../models/PhoneNumber.js');
const { Subscription } = await import('../models/Subscription.js');
const { markAvailable, clearPresence } = await import('../services/voicePresenceService.js');
const { signOutboundTicket } = await import('../services/browserOutbound.js');
const { phoneNumberService } = await import('../services/phoneNumberService.js');
const { phoneNumberController: pc } = await import('../controllers/phoneNumberController.js');

const C1 = '64b0000000000000000000c1';
const L1 = '+33900000001'; const L2 = '+33900000002';
const CALLER = '+33612345678';
const PAST = '2026-01-01T00:00:00Z'; const FUTURE = '2099-01-01T00:00:00Z';
const OFFERS = {
  accueil: { harx_product: 'callcenter', callcenter_tier: 'accueil' },
  full_scope: { harx_product: 'callcenter', callcenter_tier: 'full_scope' },
  nomad: { harx_product: 'callcenter', callcenter_tier: 'nomad_solo' },
};
let plan; let lines; let reachDoc; let twilioCalls;
const lean = (v) => ({ lean: async () => v, select() { return this; }, sort() { return this; }, limit() { return this; }, then(r, j) { return Promise.resolve(v).then(r, j); } });

// Mini-matcher MongoDB (égalité, $exists, $ne, $in, $nin, $lte, $or, chemins pointés) ; les mises à jour d'UN document sont synchrones donc atomiques.
const get = (d, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), d);
const cond = (v, c) => {
  if (c && typeof c === 'object' && !(c instanceof Date) && !Array.isArray(c)) {
    if ('$exists' in c) return (v !== undefined) === c.$exists;
    if ('$ne' in c) return String(v ?? null) !== String(c.$ne);
    if ('$in' in c) return c.$in.map(String).includes(String(v));
    if ('$nin' in c) return !c.$nin.map(String).includes(String(v));
    if ('$lte' in c) return v !== undefined && v !== null && new Date(v).getTime() <= new Date(c.$lte).getTime();
  }
  if (c === null) return v === null || v === undefined;
  return String(v) === String(c);
};
const match = (d, f) => Object.entries(f).every(([k, c]) => (k === '$or' ? c.some((s) => match(d, s)) : cond(get(d, k), c)));

const savedLog = { log: console.log, warn: console.warn, error: console.error };
beforeEach(() => {
  if (!process.env.DBG) { console.log = () => {}; console.warn = () => {}; console.error = () => {}; }
  plan = 'accueil'; reachDoc = null; twilioCalls = {};
  global.fetch = async () => ({ ok: true, json: async () => ({ success: true, data: { companyId: C1, isOwner: true } }) });
  clearPresence();
  delete process.env.LINE_ENFORCEMENT_FROM; delete process.env.LINE_ENFORCEMENT_RULE_STARTS;
  lines = [
    { _id: 'l1', companyId: C1, phoneNumber: L1, provider: 'twilio', twilioId: 'PN1', status: 'active', billingStatus: 'active', assignedRole: 'shared', createdAt: new Date('2026-01-01T00:00:00Z'), gigId: null },
    { _id: 'l2', companyId: C1, phoneNumber: L2, provider: 'twilio', twilioId: 'PN2', status: 'active', billingStatus: 'active', assignedRole: 'shared', createdAt: new Date('2026-01-02T00:00:00Z'), gigId: null },
  ];
  const rowsOf = (f) => lines.filter((l) => match(l, f));
  PhoneNumber.find = (f) => { let rows = rowsOf(f); const c = { sort: (s) => { const [[k, dir]] = Object.entries(s); rows = [...rows].sort((a, b) => (new Date(a[k]) - new Date(b[k])) * dir); return c; }, select: () => c, limit: () => c, lean: async () => rows, then: (r, j) => Promise.resolve(rows).then(r, j) }; return c; };
  PhoneNumber.findOne = (f) => { let rows = rowsOf(f); const c = { sort: (s) => { const [[k, dir]] = Object.entries(s); rows = [...rows].sort((a, b) => (new Date(a[k]) - new Date(b[k])) * dir); return c; }, select: () => c, lean: async () => rows[0] || null, then: (r, j) => Promise.resolve(rows[0] || null).then(r, j) }; return c; };
  PhoneNumber.updateOne = async (f, u) => { const d = lines.find((l) => match(l, f)); if (!d) return { matchedCount: 0, modifiedCount: 0 }; Object.assign(d, u.$set || {}); for (const k of Object.keys(u.$unset || {})) delete d[k]; return { matchedCount: 1, modifiedCount: 1 }; };
  PhoneNumber.updateMany = async (f, u) => { let n = 0; for (const d of lines) if (match(d, f)) { for (const k of Object.keys(u.$unset || {})) delete d[k]; Object.assign(d, u.$set || {}); n += 1; } return { matchedCount: n, modifiedCount: n }; };
  Subscription.findOne = () => ({ populate: async () => (OFFERS[plan] ? { planId: { name: 'Offre', metadata: OFFERS[plan] } } : null) });
  CallQueue.find = () => lean([]); CallQueue.findOneAndUpdate = () => lean(null); StaffRouting.find = () => lean([]);
  InboundCall.find = () => lean([]); InboundCall.updateOne = async () => ({}); InboundCall.findOne = async () => null;
  InboundSettings.findOne = () => lean({});
  ReachSettings.findOne = () => lean(reachDoc);
  MinutesCompany.findOne = () => ({ select: () => ({ lean: async () => ({ minutes: 100 }) }) });
  phoneNumberService.twilioClient = { calls: (sid) => ({ fetch: async () => { if (twilioCalls[sid] instanceof Error) throw twilioCalls[sid]; return { status: twilioCalls[sid] || 'in-progress' }; } }) };
  const db = { collection: () => ({ find: () => { const c = { sort: () => c, limit: () => c, toArray: async () => [], next: async () => null }; return c; }, findOne: async () => null }) };
  Object.defineProperty(mongoose.connection, 'db', { get: () => db, configurable: true });
});
after(() => { Object.assign(console, savedLog); });

const rule = (from = PAST) => { process.env.LINE_ENFORCEMENT_FROM = from; };
const hit = async (method, { body = {}, query = {} } = {}) => {
  let out = null; const res = { type() { return this; }, status(c) { this.code = c; return this; }, json(x) { out = { code: this.code || 200, body: x }; return this; }, send(x) { out = x; return this; } };
  await pc[method]({ body, query, get: () => 'orch.test', headers: { authorization: 'Bearer tok' }, user: { userId: 'owner' } }, res);
  return out;
};
const outbound = (callSid, { companyId = C1, to = CALLER } = {}) => {
  const identity = 'cc-sec1';
  const ticket = signOutboundTicket({ secret: process.env.TWILIO_AUTH_TOKEN, companyId, identity, secretary: true });
  return hit('handleBrowserOutbound', { body: { To: to, From: `client:${identity}`, CompanyId: companyId, Ticket: ticket, CallSid: callSid } });
};
const callerIdOf = (twiml) => (String(twiml).match(/callerId="([^"]+)"/) || [])[1];
const busy = (id) => Boolean(lines.find((l) => l._id === id).activeCall);

test('règle inactive ou en préavis : l\'appel sortant garde le comportement actuel (ligne la plus ancienne, aucun bail posé, pas d\'action sur le <Dial>)', async () => {
  for (const r of [undefined, FUTURE]) {
    if (r) rule(r);
    const xml = await outbound(`CA-${r}`);
    assert.equal(callerIdOf(xml), L1);
    assert.ok(!String(xml).includes('line-call-end'));
    assert.ok(!busy('l1') && !busy('l2'));
  }
});

test('règle active, Accueil : deux appels sortants simultanés prennent deux lignes ; le troisième est refusé « ligne occupée » (anglais)', async () => {
  rule();
  const a = await outbound('CA1'); const b = await outbound('CA2');
  assert.deepEqual([callerIdOf(a), callerIdOf(b)], [L1, L2]);
  assert.match(a, /action="https:\/\/orch\.test\/api\/phone-numbers\/webhooks\/twilio\/line-call-end"/);
  const c = await outbound('CA3');
  assert.match(c, /All lines are busy/); assert.match(c, /language="en-US"/); assert.ok(!c.includes('<Dial'));
  assert.deepEqual([busy('l1'), busy('l2')], [true, true]);
});

test('libération : fin d\'appel (action du <Dial>) libère la ligne, idempotente ; la ligne est de nouveau prenable', async () => {
  rule();
  await outbound('CA1'); await outbound('CA2');
  const r = await hit('handleLineCallEnd', { body: { CallSid: 'CA1' } });
  assert.match(r, /<Response\/>/);
  assert.deepEqual([busy('l1'), busy('l2')], [false, true]);
  await hit('handleLineCallEnd', { body: { CallSid: 'CA1' } });
  assert.deepEqual([busy('l1'), busy('l2')], [false, true], 'deuxième livraison : sans effet');
  assert.equal(callerIdOf(await outbound('CA4')), L1);
});

test('concurrence sortante : 10 appels simultanés sur 2 lignes ⇒ exactement 2 passent', async () => {
  rule();
  const xs = await Promise.all(Array.from({ length: 10 }, (_, i) => outbound(`CAX${i}`)));
  assert.equal(xs.filter((x) => String(x).includes('<Dial')).length, 2);
  assert.equal(xs.filter((x) => /All lines are busy/.test(x)).length, 8);
});

test('un appel refusé pour une autre raison (solde nul) ne retient aucune ligne', async () => {
  rule();
  MinutesCompany.findOne = () => ({ select: () => ({ lean: async () => ({ minutes: 0 }) }) });
  const x = await outbound('CA1');
  assert.ok(!String(x).includes('<Dial'));
  assert.ok(!busy('l1') && !busy('l2'));
});

test('bail oublié : constaté périmé par Twilio à la prise (appel terminé) ; Twilio injoignable ⇒ la ligne reste occupée', async () => {
  rule();
  lines.forEach((l) => { l.activeCall = { callSid: `OLD-${l._id}`, direction: 'inbound', startedAt: new Date(), expiresAt: new Date(Date.now() + 3600_000) }; });
  twilioCalls['OLD-l1'] = 'completed'; twilioCalls['OLD-l2'] = new Error('twilio down');
  const x = await outbound('CA1');
  assert.equal(callerIdOf(x), L1, 'l1 libérée car terminée');
  assert.equal(lines[1].activeCall.callSid, 'OLD-l2', 'l2 : vérification impossible, reste occupée');
});

test('autres offres : Nomad (règle active) et Full Scope (règle inactive) : aucun bail, appel inchangé', async () => {
  plan = 'full_scope';
  assert.ok(String(await outbound('CA-fs')).includes('<Dial'));
  rule(); plan = 'nomad';
  assert.ok(String(await outbound('CA-nomad')).includes('<Dial'));
  assert.ok(!busy('l1') && !busy('l2'));
});

test('panne de la base de lignes : l\'appel passe comme avant (aucun blocage sur incident)', async () => {
  rule();
  PhoneNumber.updateOne = async () => { throw new Error('mongo down'); };
  assert.ok(String(await outbound('CA1')).includes('<Dial'));
});

test('outbound-check : 409 LINE_BUSY (anglais) quand toutes les lignes sont occupées, sans rien prendre ; règle inactive : inchangé', async () => {
  const check = () => hit('outboundCheck', { body: { companyId: C1, to: CALLER } });
  assert.equal((await check()).code, 200);
  rule();
  assert.equal((await check()).code, 200);
  await outbound('CA1'); await outbound('CA2');
  const r = await check();
  assert.equal(r.code, 409);
  assert.deepEqual([r.body.code, r.body.error, r.body.success], ['LINE_BUSY', 'LINE_BUSY', false]);
  assert.match(r.body.message, /All lines are busy/);
  await hit('handleLineCallEnd', { body: { CallSid: 'CA2' } });
  assert.equal((await check()).code, 200);
  assert.equal(lines[1].activeCall, undefined, 'outbound-check ne prend jamais de ligne');
});

// ───────── entrant : une ligne tenue par un appel renvoie les suivants vers « aucun conseiller disponible » ─────────
const present = (...users) => { clearPresence(); for (const u of users) markAvailable({ userId: u, companyId: C1 }); };
const inbound = (to, callSid) => hit('handleTwilioInboundCall', { body: { To: to, From: CALLER, CallSid: callSid } });
const rings = (twiml) => /<Client>/.test(String(twiml));
const holder = (id) => lines.find((l) => l._id === id).activeCall?.callSid;

test('entrant, règle inactive : deux appels sur la même ligne sonnent tous les deux, aucun bail (comportement actuel)', async () => {
  present('owner');
  assert.ok(rings(await inbound(L1, 'CA1')) && rings(await inbound(L1, 'CA2')));
  assert.ok(!busy('l1'));
  rule(FUTURE);
  assert.ok(rings(await inbound(L1, 'CA3')) && rings(await inbound(L1, 'CA4')));
  assert.ok(!busy('l1'));
});

test('entrant, règle active : le premier appel sonne et tient la ligne ; le second, sur la même ligne, ne sonne chez personne (même branche que « aucun conseiller ») ; l\'autre ligne reste libre', async () => {
  rule(); present('owner', 'sec1');
  assert.ok(rings(await inbound(L1, 'CA1')));
  assert.equal(holder('l1'), 'CA1');
  const second = await inbound(L1, 'CA2');
  assert.ok(!rings(second), 'ligne occupée : personne ne sonne');
  assert.equal(holder('l1'), 'CA1', 'le premier appel garde sa ligne');
  assert.ok(rings(await inbound(L2, 'CA3')), 'l\'autre ligne sonne');
  assert.equal(holder('l2'), 'CA3');
});

test('entrant occupé = EXACTEMENT le flux « aucun conseiller disponible » existant, avec ou sans répondeur activé (voicemailEnabled inchangé)', async () => {
  for (const voicemailEnabled of [true, false]) {
    InboundSettings.findOne = () => lean({ voicemailEnabled });
    delete process.env.LINE_ENFORCEMENT_FROM; present(); lines.forEach((l) => delete l.activeCall);
    const reference = await inbound(L1, 'CAREF'); // règle inactive, personne en ligne : flux existant
    rule(); present('owner'); lines.forEach((l) => delete l.activeCall);
    await inbound(L1, 'CA1');
    const busyTwiml = await inbound(L1, 'CA2');
    assert.equal(busyTwiml, reference, `voicemailEnabled=${voicemailEnabled}`);
  }
});

test('entrant occupé avec mobile du titulaire configuré : même repli qu\'un appel sans conseiller (le mobile sonne)', async () => {
  rule(); present('owner');
  reachDoc = { forwardEnabled: true, mobileNumber: '+33611223344', mobileRingSeconds: 25 };
  await inbound(L1, 'CA1');
  const second = await inbound(L1, 'CA2');
  assert.ok(String(second).includes('<Number>+33611223344</Number>'));
  assert.equal(holder('l1'), 'CA1');
});

test('entrant sans aucun conseiller (répondeur d\'emblée) : la ligne n\'est PAS retenue', async () => {
  rule(); present();
  await inbound(L1, 'CA1');
  assert.ok(!busy('l1'));
});

test('un appel sortant occupe la ligne pour les entrants, et un entrant pour les sortants (même ligne)', async () => {
  rule(); present('owner');
  lines = lines.slice(0, 1);
  await outbound('CAOUT');
  assert.ok(!rings(await inbound(L1, 'CAIN')), 'sortant en cours : l\'entrant va au répondeur');
  await hit('handleLineCallEnd', { body: { CallSid: 'CAOUT' } });
  assert.ok(rings(await inbound(L1, 'CAIN2')));
  assert.match(await outbound('CAOUT2'), /All lines are busy/, 'entrant en cours : le sortant est refusé');
});

test('fin de la sonnerie (inbound-dial-result) libère la ligne, idempotent ; sonnerie du mobile à suivre : la ligne reste tenue', async () => {
  rule(); present('owner');
  await inbound(L1, 'CA1');
  await hit('handleTwilioInboundDialResult', { body: { CallSid: 'CA1', DialCallStatus: 'completed', DialCallDuration: '30' }, query: {} });
  assert.ok(!busy('l1'));
  await hit('handleTwilioInboundDialResult', { body: { CallSid: 'CA1', DialCallStatus: 'completed' }, query: {} });
  assert.ok(!busy('l1'), 'redite sans effet');
  assert.ok(rings(await inbound(L1, 'CA2')));
  // non décroché dans le navigateur, mobile du titulaire à faire sonner : la ligne reste tenue jusqu'à la fin du mobile
  reachDoc = { forwardEnabled: true, mobileNumber: '+33611223344', mobileRingSeconds: 25 };
  InboundCall.findOne = async () => ({ callSid: 'CA2', companyId: C1, phoneNumber: L1, startedAt: new Date(), mobileTried: false, async save() { return this; } });
  await hit('handleTwilioInboundDialResult', { body: { CallSid: 'CA2', DialCallStatus: 'no-answer' }, query: { leg: 'browser' } });
  assert.equal(holder('l1'), 'CA2');
  await hit('handleTwilioInboundDialResult', { body: { CallSid: 'CA2', DialCallStatus: 'no-answer' }, query: { leg: 'mobile' } });
  assert.ok(!busy('l1'));
});

test('concurrence entrante : 6 appels simultanés sur la même ligne ⇒ un seul sonne', async () => {
  rule(); present('owner');
  const xs = await Promise.all(Array.from({ length: 6 }, (_, i) => inbound(L1, `CAC${i}`)));
  assert.equal(xs.filter(rings).length, 1);
});

test('entrant : Full Scope / Nomad, règle active : aucun bail, tous les appels sonnent', async () => {
  rule(); present('owner');
  for (const p of ['full_scope', 'nomad']) {
    plan = p;
    assert.ok(rings(await inbound(L1, `CA1-${p}`)) && rings(await inbound(L1, `CA2-${p}`)));
    assert.ok(!busy('l1'));
  }
});

test('entrant : panne du contrôle de ligne => l\'appel sonne comme avant', async () => {
  rule(); present('owner');
  PhoneNumber.updateOne = async () => { throw new Error('mongo down'); };
  assert.ok(rings(await inbound(L1, 'CA1')));
});
