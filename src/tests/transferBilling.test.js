// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=tok node --test src/tests/transferBilling.test.js
// Facturation des appels transférés (décision du 18/11/2026) : la suite de l'appel après un transfert est débitée des minutes prépayées
// comme tout autre appel, sans double compte. Base et Twilio SIMULÉS : aucun appel réel.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'tok';
const B = await import('../services/transferBilling.js');
const T = await import('../services/callTransfer.js');
const { default: InboundCall } = await import('../models/InboundCall.js');
const { default: InboundSettings } = await import('../models/InboundSettings.js');
const { default: MinutesCompany } = await import('../models/MinutesCompany.js');
const { default: CallCreditDecision } = await import('../models/CallCreditDecision.js');
const { PhoneNumber } = await import('../models/PhoneNumber.js');
const { Subscription } = await import('../models/Subscription.js');
const { syncMinutesFromCalls } = await import('../controllers/escrowController.js');
const { clearCoefficientCache } = await import('../services/creditCoefficient.js');
const { transferResult, billOutboundTransferRemainder, setTransferDeps, transferDeps } = await import('../controllers/callTransferController.js');
const realSignatureValid = transferDeps.signatureValid;
const { default: OutboundTransfer } = await import('../models/OutboundTransfer.js');
const { phoneNumberController: pc } = await import('../controllers/phoneNumberController.js');
const { signLineCallEnd } = await import('../services/lineCalls.js');

const C1 = '64b0000000000000000000c1';
const LINE = '+33140000000'; const ENTRY_FR = '+33612345678'; const ENTRY_GB = '+442079460958'; const PROSPECT = '+33677777777';
const sid = (c) => `CA${c.repeat(32)}`;
const CALLER = sid('1'); const DIAL = sid('2'); const BROWSER_OUT = sid('3'); const PROSPECT_LEG = sid('4'); const DIAL_OUT = sid('5');
const NOW = Date.parse('2026-11-18T10:00:00Z');
const clone = (v) => (v === null || v === undefined ? v : structuredClone(v));
const lean = (get) => ({ lean: async () => clone(typeof get === 'function' ? get() : get), select() { return this; }, sort() { return this; }, limit() { return this; } });

let CALLS; let W; let decisions; let inbound; let outboundRows;
const saved = { log: console.log, warn: console.warn, error: console.error };
beforeEach(() => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  delete process.env.INTERNATIONAL_MINUTE_CREDITS; clearCoefficientCache();
  CALLS = []; decisions = new Map();
  W = { companyId: C1, minutes: 100, consumedSeconds: 0, chargedCallSids: [] };
  // Collection `calls` simulée : upsert $setOnInsert sur le sid (comme Mongo), lecture pour le débit.
  const db = { collection: (name) => {
    assert.equal(name, 'calls');
    return {
      updateOne: async (f, u, o) => {
        if (CALLS.some((c) => c.sid === f.sid)) return { upsertedCount: 0, matchedCount: 1 };
        assert.ok(o?.upsert && u.$setOnInsert && !u.$set, 'insertion seule, jamais de réécriture');
        CALLS.push({ ...u.$setOnInsert }); return { upsertedCount: 1, matchedCount: 0 };
      },
      find: () => ({ toArray: async () => CALLS.filter((c) => c.duration > 0 && c.isTest !== true).map((c) => ({ ...c })) }),
    };
  } };
  Object.defineProperty(mongoose.connection, 'db', { get: () => db, configurable: true });
  MinutesCompany.findOne = () => ({ then: (r, j) => Promise.resolve(clone(W)).then(r, j), lean: async () => clone(W), select() { return this; } });
  MinutesCompany.create = async (d) => { W = { ...W, ...d }; return clone(W); };
  MinutesCompany.findOneAndUpdate = async (filter, update) => {
    const nin = filter.chargedCallSids?.$nin;
    if (nin && nin.some((k) => W.chargedCallSids.includes(k))) return null;
    Object.assign(W, update.$set || {});
    for (const [k, v] of Object.entries(update.$inc || {})) W[k] = (W[k] || 0) + v;
    for (const x of update.$addToSet.chargedCallSids.$each) if (!W.chargedCallSids.includes(x)) W.chargedCallSids.push(x);
    return clone(W);
  };
  CallCreditDecision.find = () => lean(() => [...decisions].map(([s, d]) => ({ sid: s, factor: d.factor, zone: d.zone })));
  CallCreditDecision.updateOne = async (f, u) => { if (!decisions.has(f.sid)) decisions.set(f.sid, { factor: u.$setOnInsert.factor, zone: u.$setOnInsert.zone }); return {}; };
  PhoneNumber.find = () => lean([{ phoneNumber: LINE, companyId: C1, status: 'active', createdAt: new Date('2026-01-01') }]);
  PhoneNumber.findOne = () => lean({ phoneNumber: LINE, companyId: C1, status: 'active' });
  Subscription.findOne = () => ({ populate: async () => null });
  InboundSettings.findOne = () => lean({ voicemailEnabled: true, voice: 'nova' });
  inbound = { _id: 'k1', companyId: C1, callSid: CALLER, phoneNumber: LINE, transfer: { startedAt: new Date(NOW - 120000), entryId: 'e1', entryName: 'Mme Martin', result: 'ringing' } };
  const setPath = (o, k, v) => { const p = k.split('.'); const last = p.pop(); p.reduce((a, q) => (a[q] = a[q] || {}), o)[last] = v; };
  const inboundHit = (f) => f.callSid === inbound.callSid && f['transfer.entryId'] === inbound.transfer.entryId && (f['transfer.result'] === undefined || inbound.transfer.result === f['transfer.result']);
  InboundCall.findOneAndUpdate = (f, u) => { const hit = inboundHit(f); if (hit) for (const [k, v] of Object.entries(u.$set)) setPath(inbound, k, v); return lean(() => (hit ? inbound : null)); };
  InboundCall.findOne = (f) => lean(() => (inboundHit(f) ? inbound : null));
  outboundRows = new Map();
  const outHit = (f) => { const r = outboundRows.get(f.callSid); return r && r.entryId === f.entryId && (f.result === undefined || r.result === f.result) ? r : null; };
  OutboundTransfer.findOneAndUpdate = (f, u) => { const r = outHit(f); if (r) Object.assign(r, u.$set); return lean(() => r); };
  OutboundTransfer.findOne = (f) => lean(() => outHit(f));
  setTransferDeps({
    now: () => NOW,
    signatureValid: () => true,
    creditFactor: async (_c, to) => (process.env.INTERNATIONAL_MINUTE_CREDITS && String(to).startsWith('+44') ? Number(process.env.INTERNATIONAL_MINUTE_CREDITS) : 1),
    findOutboundTransfer: async (callSid) => clone(outboundRows.get(callSid) || null),
    directory: async () => ({ entries: [{ _id: 'e1', name: 'Mme Martin', phone: ENTRY_FR }] }),
  });
});
after(() => { Object.assign(console, saved); delete process.env.INTERNATIONAL_MINUTE_CREDITS; });

const hook = (q, body) => new Promise((resolve) => { const res = { type() { return this; }, status() { return this; }, send: (x) => resolve(x) }; transferResult({ query: q, body, get: () => 'orch.test' }, res); });
const stateFor = (callSid, extra = {}) => T.signTransferState({ secret: 'tok', companyId: C1, callSid, entryId: 'e1', userId: 'u1', now: NOW - 60000, ...extra });

// --- logique pure --------------------------------------------------------------------------------------------------------------
test('jambe <Dial> : décrochée avec durée -> document ; sans réponse, durée nulle ou sid illisible -> rien', () => {
  const d = B.dialLegCall({ body: { DialCallSid: DIAL, DialCallStatus: 'completed', DialCallDuration: '125' }, companyId: C1, parentCallSid: CALLER, from: LINE, to: ENTRY_FR, now: NOW });
  assert.equal(d.sid, DIAL); assert.equal(d.duration, 125); assert.equal(d.direction, 'outbound'); assert.equal(d.source, 'transfer'); assert.equal(d.transferLeg, 'dial');
  assert.equal(d.from, LINE); assert.equal(d.to, ENTRY_FR); assert.equal(d.parentCallSid, CALLER); assert.equal(d.isTest, false);
  assert.equal(d.endTime.getTime() - d.startTime.getTime(), 125000);
  for (const body of [
    { DialCallSid: DIAL, DialCallStatus: 'no-answer', DialCallDuration: '0' },
    { DialCallSid: DIAL, DialCallStatus: 'busy' },
    { DialCallSid: DIAL, DialCallStatus: 'failed', DialCallDuration: '3' },
    { DialCallSid: DIAL, DialCallStatus: 'canceled', DialCallDuration: '0' },
    { DialCallSid: DIAL, DialCallStatus: 'completed', DialCallDuration: '0' },
    { DialCallSid: 'CAx', DialCallStatus: 'completed', DialCallDuration: '30' },
  ]) assert.equal(B.dialLegCall({ body, companyId: C1, parentCallSid: CALLER, now: NOW }), null, JSON.stringify(body));
});

test('reste de la jambe du correspondant : fin − début du transfert, borné par CallDuration', () => {
  const start = new Date(NOW - 300000);
  assert.equal(B.remainderSeconds({ callDuration: 900, transferStartedAt: start, endedAt: NOW }), 300);
  assert.equal(B.remainderSeconds({ callDuration: 200, transferStartedAt: start, endedAt: NOW }), 200, 'jamais plus que la jambe');
  assert.equal(B.remainderSeconds({ callDuration: 900, transferStartedAt: new Date(NOW + 5000), endedAt: NOW }), 0, 'horloges décalées : 0, pas négatif');
  assert.equal(B.remainderSeconds({ callDuration: 0, transferStartedAt: start, endedAt: NOW }), 0);
  assert.equal(B.legEndOf({ Timestamp: 'Wed, 18 Nov 2026 09:59:00 +0000' }, NOW), NOW - 60000);
  assert.equal(B.legEndOf({ Timestamp: 'n/a' }, NOW), NOW);
  const row = { callSid: PROSPECT_LEG, companyId: C1, browserCallSid: BROWSER_OUT, lineNumber: LINE, startedAt: start };
  assert.equal(B.outboundRemainderCall({ body: { CallSid: PROSPECT_LEG, CallStatus: 'busy', CallDuration: '0' }, row, now: NOW }), null);
  assert.equal(B.outboundRemainderCall({ body: { CallSid: sid('9'), CallStatus: 'completed', CallDuration: '900' }, row, now: NOW }), null, 'autre jambe');
  const d = B.outboundRemainderCall({ body: { CallSid: PROSPECT_LEG, CallStatus: 'completed', CallDuration: '900', To: PROSPECT }, row, now: NOW });
  assert.equal(d.duration, 300); assert.equal(d.from, LINE); assert.equal(d.to, PROSPECT); assert.equal(d.parentCallSid, BROWSER_OUT); assert.equal(d.transferLeg, 'remainder');
});

test('jeton : numéro et coefficient facultatifs, valable au-delà d’1 h (jambe jusqu’à 4 h)', () => {
  const s = T.verifyTransferState({ secret: 'tok', token: stateFor(CALLER, { to: ENTRY_GB, factor: 3 }), now: NOW + 4 * 3600 * 1000 });
  assert.equal(s.to, ENTRY_GB); assert.equal(s.factor, 3);
  assert.deepEqual(Object.keys(T.verifyTransferState({ secret: 'tok', token: stateFor(CALLER), now: NOW })).sort(), ['callSid', 'companyId', 'entryId', 'userId']);
});

// --- transfert ENTRANT : jambe vers la fiche débitée une fois ---------------------------------------------------------------------
test('entrant : jambe vers la fiche débitée une seule fois (minute entamée), rappel rejoué deux fois -> un seul document', async () => {
  const s = stateFor(CALLER, { to: ENTRY_FR, factor: 1 });
  const body = { CallSid: CALLER, DialCallSid: DIAL, DialCallStatus: 'completed', DialCallDuration: '125' };
  for (let i = 0; i < 3; i += 1) assert.match(await hook({ s }, body), /<Hangup\/>/);
  assert.equal(CALLS.length, 1, 'un seul document malgré les rappels rejoués');
  assert.equal(CALLS[0].sid, DIAL); assert.equal(CALLS[0].from, LINE); assert.equal(CALLS[0].to, ENTRY_FR); assert.equal(String(CALLS[0].companyId), C1);
  await syncMinutesFromCalls(C1); await syncMinutesFromCalls(C1);
  assert.equal(W.minutes, 97, '2 min 05 s = 3 minutes, débitées une fois'); assert.equal(W.consumedSeconds, 125);
  assert.equal(decisions.size, 0, 'coefficient 1 : aucune trace');
});

test('entrant : la jambe navigateur (portail) et la jambe vers la fiche sont débitées chacune, la jambe de l’appelant jamais', async () => {
  // Jambe navigateur enregistrée par le portail (avant le transfert) + jambe vers la fiche.
  CALLS.push({ sid: sid('a'), companyId: C1, direction: 'inbound', from: '+33655555555', to: LINE, duration: 90, source: 'center_portal' });
  await hook({ s: stateFor(CALLER, { to: ENTRY_FR, factor: 1 }) }, { CallSid: CALLER, DialCallSid: DIAL, DialCallStatus: 'completed', DialCallDuration: '60' });
  await syncMinutesFromCalls(C1);
  assert.equal(W.minutes, 100 - 2 - 1);
  assert.ok(!CALLS.some((c) => c.sid === CALLER), 'jambe de l’appelant non inscrite');
});

test('entrant : transfert sans réponse, occupé, échec ou appelant parti -> rien de débité', async () => {
  const s = stateFor(CALLER, { to: ENTRY_FR, factor: 1 });
  for (const st of ['no-answer', 'busy', 'failed', 'canceled']) await hook({ s }, { CallSid: CALLER, DialCallSid: DIAL, DialCallStatus: st, DialCallDuration: '0' });
  assert.equal(CALLS.length, 0);
  await syncMinutesFromCalls(C1);
  assert.equal(W.minutes, 100);
});

test('entrant : jeton altéré ou d’un autre appel -> rien de débité', async () => {
  await hook({ s: 'x.y' }, { CallSid: CALLER, DialCallSid: DIAL, DialCallStatus: 'completed', DialCallDuration: '60' });
  await hook({ s: stateFor(sid('8')) }, { CallSid: CALLER, DialCallSid: DIAL, DialCallStatus: 'completed', DialCallDuration: '60' });
  assert.equal(CALLS.length, 0);
});

test('fiche internationale à 3 crédits : trace du plafond posée sous le DialCallSid, débit × 3', async () => {
  process.env.INTERNATIONAL_MINUTE_CREDITS = '3';
  await hook({ s: stateFor(CALLER, { to: ENTRY_GB, factor: 3 }) }, { CallSid: CALLER, DialCallSid: DIAL, DialCallStatus: 'completed', DialCallDuration: '61' });
  assert.deepEqual(decisions.get(DIAL), { factor: 3, zone: 'international' });
  await syncMinutesFromCalls(C1);
  assert.equal(W.minutes, 100 - 2 * 3);
});

test('jeton émis avant cette version (sans numéro) : numéro relu sur la fiche', async () => {
  await hook({ s: stateFor(CALLER) }, { CallSid: CALLER, DialCallSid: DIAL, DialCallStatus: 'completed', DialCallDuration: '30' });
  assert.equal(CALLS[0].to, ENTRY_FR);
});

// --- transfert SORTANT : reste du correspondant sans recouvrement + jambe vers la fiche -----------------------------------------
test('sortant : reste de la jambe du correspondant débité SANS la part déjà débitée avec la jambe navigateur', async () => {
  const startedAt = new Date(NOW - 200000); // transfert 200 s avant la fin de la jambe du correspondant
  outboundRows.set(PROSPECT_LEG, { callSid: PROSPECT_LEG, companyId: C1, browserCallSid: BROWSER_OUT, lineNumber: LINE, entryId: 'e1', entryName: 'Mme Martin', result: 'ringing', startedAt });
  // Jambe navigateur enregistrée par le portail : 5 min de conversation avant le transfert.
  CALLS.push({ sid: BROWSER_OUT, companyId: C1, direction: 'outbound', from: LINE, to: PROSPECT, duration: 300, source: 'center_portal' });
  const end = { CallSid: PROSPECT_LEG, CallStatus: 'completed', CallDuration: '505', To: PROSPECT, From: LINE };
  // statusCallback signé reçu par line-call-end, rejoué deux fois.
  const lineEnd = () => new Promise((resolve) => { const res = { type() { return this; }, status(c) { this.c = c; return this; }, send() { resolve(this.c); } }; pc.handleLineCallEnd({ query: { t: signLineCallEnd({ secret: 'tok', callSid: PROSPECT_LEG }) }, body: end }, res); });
  assert.equal(await lineEnd(), 200); assert.equal(await lineEnd(), 200);
  const rows = CALLS.filter((c) => c.sid === PROSPECT_LEG);
  assert.equal(rows.length, 1); assert.equal(rows[0].duration, 200, '505 s de jambe − 305 s avant le transfert'); assert.equal(rows[0].to, PROSPECT); assert.equal(rows[0].from, LINE);
  // Jambe vers la fiche (action du <Dial> sur la jambe du correspondant).
  await hook({ s: stateFor(PROSPECT_LEG, { to: ENTRY_FR, factor: 1 }) }, { CallSid: PROSPECT_LEG, DialCallSid: DIAL_OUT, DialCallStatus: 'completed', DialCallDuration: '170' });
  await syncMinutesFromCalls(C1); await syncMinutesFromCalls(C1);
  assert.equal(W.minutes, 100 - 5 - 4 - 3, 'navigateur 5 min + reste 3 min 20 s (4) + fiche 2 min 50 s (3), chacun une fois');
  assert.equal(W.chargedCallSids.length, 3);
});

test('sortant : jeton absent ou faux -> rien (ni libération ni débit)', async () => {
  outboundRows.set(PROSPECT_LEG, { callSid: PROSPECT_LEG, companyId: C1, browserCallSid: BROWSER_OUT, lineNumber: LINE, startedAt: new Date(NOW - 60000) });
  const code = await new Promise((resolve) => { const res = { type() { return this; }, status(c) { this.c = c; return this; }, send() { resolve(this.c); } }; pc.handleLineCallEnd({ query: { t: 'faux' }, body: { CallSid: PROSPECT_LEG, CallStatus: 'completed', CallDuration: '60' } }, res); });
  assert.equal(code, 403); assert.equal(CALLS.length, 0);
});

test('sortant : action du <Dial> de la jambe navigateur (pas de transfert enregistré) -> rien ; correspondant non joint -> rien', async () => {
  assert.equal(await billOutboundTransferRemainder({ CallSid: BROWSER_OUT, CallStatus: 'completed', DialCallDuration: '60' }, { signed: true }), false);
  outboundRows.set(PROSPECT_LEG, { callSid: PROSPECT_LEG, companyId: C1, browserCallSid: BROWSER_OUT, lineNumber: LINE, startedAt: new Date(NOW - 60000) });
  assert.equal(await billOutboundTransferRemainder({ CallSid: PROSPECT_LEG, CallStatus: 'no-answer', CallDuration: '0' }, { signed: true }), false);
  assert.equal(CALLS.length, 0);
});

test('sortant international : la décision de crédit de la jambe navigateur est reprise pour le reste', async () => {
  process.env.INTERNATIONAL_MINUTE_CREDITS = '3';
  decisions.set(BROWSER_OUT, { factor: 3, zone: 'international' });
  outboundRows.set(PROSPECT_LEG, { callSid: PROSPECT_LEG, companyId: C1, browserCallSid: BROWSER_OUT, lineNumber: LINE, startedAt: new Date(NOW - 59000) });
  assert.equal(await billOutboundTransferRemainder({ CallSid: PROSPECT_LEG, CallStatus: 'completed', CallDuration: '400', To: ENTRY_GB }, { signed: true }), true);
  assert.deepEqual(decisions.get(PROSPECT_LEG), { factor: 3, zone: 'international' });
  await syncMinutesFromCalls(C1);
  assert.equal(W.minutes, 100 - 1 * 3);
});

test('débit : un même sid inscrit deux fois (sans index unique) n’est débité qu’une fois', async () => {
  CALLS.push({ sid: DIAL, companyId: C1, direction: 'outbound', to: ENTRY_FR, duration: 60 }, { sid: DIAL, companyId: C1, direction: 'outbound', to: ENTRY_FR, duration: 60 });
  await syncMinutesFromCalls(C1);
  assert.equal(W.minutes, 99);
});

// --- affichage : libellé « Transfert vers <fiche> » et personne qui a transféré ---------------------------------------------------
test('affichage : handledBy « Transfert vers <fiche> » (+ utilisateur qui a transféré), journal de consommation libellé', async () => {
  const U = '64b0000000000000000000a1';
  inbound.transfer.byUserId = U; inbound.transfer.byName = 'Léa';
  await hook({ s: stateFor(CALLER, { to: ENTRY_FR, factor: 1 }) }, { CallSid: CALLER, DialCallSid: DIAL, DialCallStatus: 'completed', DialCallDuration: '30' });
  assert.equal(CALLS[0].handledBy.name, 'Transfert vers Mme Martin'); assert.equal(String(CALLS[0].handledBy.userId), U); assert.equal(CALLS[0].handledBy.role, 'member');
  assert.deepEqual(CALLS[0].transfer, { leg: 'dial', entryName: 'Mme Martin', byUserId: U, byName: 'Léa' });
  // agent IA : pas d'identifiant utilisateur, libellé quand même ; nom de fiche relu dans l'annuaire s'il manque
  CALLS.length = 0; inbound.transfer = { entryId: 'e1', byUserId: 'ai-agent', byName: 'Agent IA', result: 'ringing' };
  await hook({ s: stateFor(CALLER, { to: ENTRY_FR, factor: 1, userId: 'ai-agent' }) }, { CallSid: CALLER, DialCallSid: DIAL, DialCallStatus: 'completed', DialCallDuration: '30' });
  assert.equal(CALLS[0].handledBy.name, 'Transfert vers Mme Martin'); assert.equal(CALLS[0].handledBy.userId, undefined);
  // reste sortant
  outboundRows.set(PROSPECT_LEG, { callSid: PROSPECT_LEG, companyId: C1, browserCallSid: BROWSER_OUT, lineNumber: LINE, entryName: 'M. Roux', byUserId: U, byName: 'Léa', startedAt: new Date(NOW - 60000) });
  await billOutboundTransferRemainder({ CallSid: PROSPECT_LEG, CallStatus: 'completed', CallDuration: '90', To: PROSPECT }, { signed: true });
  const rem = CALLS.find((c) => c.sid === PROSPECT_LEG);
  assert.equal(rem.handledBy.name, 'Transfert vers M. Roux'); assert.equal(rem.transfer.leg, 'remainder');
  // journal de consommation (orchestrateur) : libellé additif sur la ligne
  await syncMinutesFromCalls(C1);
  const { buildMinutesRows } = await import('../services/consumptionJournal.js');
  const { rows } = buildMinutesRows({ wallet: W, payments: [], calls: CALLS });
  const line = rows.find((r) => r.reference?.callSid === PROSPECT_LEG);
  assert.equal(line.reference.label, 'Transfert vers M. Roux'); assert.equal(line.reference.transferLeg, 'remainder'); assert.equal(line.quantity, -1);
  const plain = buildMinutesRows({ wallet: { chargedCallSids: ['X'] }, payments: [], calls: [{ sid: 'X', duration: 30, direction: 'outbound', to: ENTRY_FR }] }).rows.find((r) => r.reference?.callSid === 'X');
  assert.ok(!('label' in plain.reference), 'appel ordinaire inchangé');
});

// --- relecture : rejeu du jeton, signature Twilio, plafonds -------------------------------------------------------------------------
test('rejeu du jeton avec des DialCallSid inventés : 4 rejeux -> une seule ligne (la jambe consignée au passage)', async () => {
  const s = stateFor(CALLER, { to: ENTRY_FR, factor: 1 });
  await hook({ s }, { CallSid: CALLER, DialCallSid: DIAL, DialCallStatus: 'completed', DialCallDuration: '60' });
  for (const c of ['6', '7', '8', '9']) await hook({ s }, { CallSid: CALLER, DialCallSid: sid(c), DialCallStatus: 'completed', DialCallDuration: '14000' });
  assert.equal(CALLS.length, 1); assert.equal(CALLS[0].sid, DIAL); assert.equal(inbound.transfer.dialCallSid, DIAL);
  // nouvel essai de Twilio avec la même jambe : toujours une seule ligne
  await hook({ s }, { CallSid: CALLER, DialCallSid: DIAL, DialCallStatus: 'completed', DialCallDuration: '60' });
  assert.equal(CALLS.length, 1);
  await syncMinutesFromCalls(C1);
  assert.equal(W.minutes, 99);
});

test('sans signature Twilio valide : ni résultat ni facturation (jambe <Dial> et reste du correspondant)', async () => {
  setTransferDeps({ signatureValid: () => false });
  await hook({ s: stateFor(CALLER, { to: ENTRY_FR, factor: 1 }) }, { CallSid: CALLER, DialCallSid: DIAL, DialCallStatus: 'completed', DialCallDuration: '60' });
  assert.equal(inbound.transfer.result, 'ringing'); assert.equal(CALLS.length, 0);
  outboundRows.set(PROSPECT_LEG, { callSid: PROSPECT_LEG, companyId: C1, browserCallSid: BROWSER_OUT, lineNumber: LINE, startedAt: new Date(NOW - 60000) });
  const res = { type() { return this; }, status() { return this; }, send() {} };
  await pc.handleLineCallEnd({ query: { t: signLineCallEnd({ secret: 'tok', callSid: PROSPECT_LEG }) }, body: { CallSid: PROSPECT_LEG, CallStatus: 'completed', CallDuration: '1' } }, res);
  assert.equal(CALLS.length, 0, 'une requête forgée ne fige pas la jambe à 1 s');
  assert.equal(await billOutboundTransferRemainder({ CallSid: PROSPECT_LEG, CallStatus: 'completed', CallDuration: '60' }), false, 'non signé par défaut');
});

test('signature Twilio réelle : URL publique ou hôte reçu ; fausse signature refusée', async () => {
  const twilio = (await import('twilio')).default;
  const body = { CallSid: CALLER, DialCallSid: DIAL };
  const path = '/api/phone-numbers/webhooks/twilio/transfer-result?s=abc';
  const sig = twilio.getExpectedTwilioSignature('tok', `https://orch.test${path}`, body);
  const req = (signature, host = 'orch.test') => ({ originalUrl: path, body, headers: { 'x-twilio-signature': signature }, get: (h) => (h.toLowerCase() === 'host' ? host : h.toLowerCase() === 'x-twilio-signature' ? signature : undefined) });
  assert.equal(realSignatureValid(req(sig)), true, 'hôte reçu');
  assert.equal(realSignatureValid(req('faux')), false);
  assert.equal(realSignatureValid(req(sig, 'autre.test')), false, 'autre hôte');
  const { twilioRequestValid } = await import('../services/twilioSignature.js');
  assert.equal(twilioRequestValid(req(sig), { authToken: 'tok', env: {} }), false, 'sans option : comportement des autres webhooks inchangé');
});

test('plafonds : durée à 4 h (MAX_CALL_SECONDS), fin de jambe jamais dans le futur', async () => {
  const d = B.dialLegCall({ body: { DialCallSid: DIAL, DialCallStatus: 'completed', DialCallDuration: '999999' }, companyId: C1, parentCallSid: CALLER, now: NOW });
  assert.equal(d.duration, 14400);
  assert.equal(B.legEndOf({ Timestamp: 'Fri, 18 Nov 2033 10:00:00 +0000' }, NOW), NOW);
  const row = { callSid: PROSPECT_LEG, companyId: C1, browserCallSid: BROWSER_OUT, lineNumber: LINE, startedAt: new Date(NOW - 10 * 3600 * 1000) };
  const r = B.outboundRemainderCall({ body: { CallSid: PROSPECT_LEG, CallStatus: 'completed', CallDuration: '999999', Timestamp: 'Fri, 18 Nov 2033 10:00:00 +0000' }, row, now: NOW });
  assert.equal(r.duration, 14400); assert.equal(r.endTime.getTime(), NOW);
});
