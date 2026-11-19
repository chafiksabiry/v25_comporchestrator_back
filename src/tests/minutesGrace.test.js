// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/minutesGrace.test.js
// B.1 « Minutes : jamais de dépassement, 5 minutes de grâce puis coupure ». Base, forfait et client Twilio SIMULÉS (aucun appel réel) :
// refus au démarrage à solde 0 (sortant et entrant), échéance enregistrée (solde à zéro + 5 min), coupure par le serveur à l'échéance,
// idempotence, reprise après redémarrage, aucun dépassement facturé (le solde ne passe jamais sous zéro).
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
process.env.DASH_CALLS_API_URL = 'https://dash.test/api';
try { import.meta.resolve('web-push'); } catch {
  register('data:text/javascript,' + encodeURIComponent("export async function resolve(s,c,n){ if(s==='web-push') return {url:'data:text/javascript,export default {setVapidDetails(){},sendNotification(){}}',shortCircuit:true}; return n(s,c); }"));
}
const { default: CallQueue } = await import('../models/CallQueue.js');
const { default: StaffRouting } = await import('../models/StaffRouting.js');
const { default: InboundCall } = await import('../models/InboundCall.js');
const { default: InboundSettings } = await import('../models/InboundSettings.js');
const { default: ReachSettings } = await import('../models/ReachSettings.js');
const { default: MinutesCompany } = await import('../models/MinutesCompany.js');
const { default: CallGraceDeadline } = await import('../models/CallGraceDeadline.js');
const { default: CallRecordingStatus } = await import('../models/CallRecordingStatus.js');
const { PhoneNumber } = await import('../models/PhoneNumber.js');
const { Subscription } = await import('../models/Subscription.js');
const { markAvailable, clearPresence } = await import('../services/voicePresenceService.js');
const { signOutboundTicket, decideOutboundCall } = await import('../services/browserOutbound.js');
const { phoneNumberService } = await import('../services/phoneNumberService.js');
const { phoneNumberController: pc } = await import('../controllers/phoneNumberController.js');
const { minutesCompanyController } = await import('../controllers/minutesCompanyController.js');
const { syncMinutesFromCalls, chargeCallMinutes } = await import('../controllers/escrowController.js');
const { createGraceHandlers } = await import('../controllers/minutesGraceController.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');
const G = await import('../services/minutesGrace.js');

const C1 = '64b0000000000000000000c1';
const C2 = '64b0000000000000000000c2';
const LINE = '+33900000001';
const CALLER = '+33612345678';
const sid = (c) => `CA${String(c).repeat(32).slice(0, 32)}`;
const OFFERS = {
  nomad_solo: { harx_product: 'callcenter', callcenter_tier: 'nomad_solo' },
  accueil: { harx_product: 'callcenter', callcenter_tier: 'accueil' },
  full_scope: { harx_product: 'callcenter', callcenter_tier: 'full_scope' },
  multi_clients: { harx_product: 'callcenter', callcenter_tier: 'multi_clients' },
};
const lean = (v) => ({ lean: async () => v, select() { return this; }, sort() { return this; }, limit() { return this; }, then(r, j) { return Promise.resolve(v).then(r, j); } });
const clone = (v) => (v == null ? v : structuredClone(v));

/** Échéances en mémoire : même contrat que la collection (updateOne $setOnInsert/upsert, find, findOneAndUpdate, findOne). */
function memoryDeadlines() {
  const rows = new Map();
  let n = 0;
  const matches = (row, f) => Object.entries(f).every(([k, v]) => {
    if (k === '$or') return v.some((x) => matches(row, x));
    if (k === '_id') return row._id === v;
    if (k === 'childSids') return (row.childSids || []).includes(v);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('$lte' in v) return row[k] != null && new Date(row[k]).getTime() <= new Date(v.$lte).getTime();
      if ('$gt' in v) return row[k] != null && new Date(row[k]).getTime() > new Date(v.$gt).getTime();
    }
    if (v instanceof Date) return row[k] instanceof Date && row[k].getTime() === v.getTime();
    return String(row[k]) === String(v);
  });
  const apply = (row, u) => {
    Object.assign(row, u.$set || {});
    for (const [k, v] of Object.entries(u.$inc || {})) row[k] = (row[k] || 0) + v;
    for (const [k, v] of Object.entries(u.$addToSet || {})) { row[k] = row[k] || []; if (!row[k].includes(v)) row[k].push(v); }
  };
  const M = {
    rows,
    async updateOne(f, u, o = {}) {
      const row = [...rows.values()].find((r) => matches(r, f));
      if (!row) {
        if (!o.upsert) return { modifiedCount: 0 };
        const doc = { _id: `g${++n}`, childSids: [], ...(u.$setOnInsert || {}) };
        apply(doc, { $set: u.$set }); rows.set(doc._id, doc); return { upsertedCount: 1, modifiedCount: 0 };
      }
      if (u.$setOnInsert && !u.$set && !u.$inc && !u.$addToSet) return { modifiedCount: 0 };
      apply(row, u); return { modifiedCount: 1 };
    },
    find(f) { const out = [...rows.values()].filter((r) => matches(r, f)).sort((a, b) => a.deadline - b.deadline); return lean(out.map(clone)); },
    findOne(f) { const r = [...rows.values()].find((x) => matches(x, f)); return lean(clone(r) || null); },
    async findOneAndUpdate(f, u) { const r = [...rows.values()].find((x) => matches(x, f)); if (!r) return null; apply(r, u); return clone(r); },
  };
  return M;
}

/** Client Twilio simulé : les coupures sont notées, jamais envoyées. */
function fakeTwilio({ fail = null, parents = {}, statuses = {} } = {}) {
  const hangups = [];
  return {
    hangups,
    calls: (callSid) => ({
      update: async (params) => { if (fail) throw fail(callSid); hangups.push({ callSid, ...params }); return { sid: callSid, status: 'completed' }; },
      fetch: async () => ({ sid: callSid, status: statuses[callSid] || 'in-progress', parentCallSid: parents[callSid] || null }),
    }),
  };
}

let plan; let W; let CALLS; let DL; let twilio;
const savedLog = { log: console.log, warn: console.warn, error: console.error };
const realDbReady = pc.dbReady;
beforeEach(() => {
  if (!process.env.DBG) { console.log = () => {}; console.warn = () => {}; console.error = () => {}; }
  plan = 'full_scope'; CALLS = [];
  W = { companyId: C1, minutes: 10, consumedSeconds: 0, chargedCallSids: [], planGrantKeys: [], credits: [], purchasedMinutes: 0, planMinutesGranted: 0 };
  global.fetch = async (url) => {
    if (String(url).startsWith('https://dash.test')) return { ok: true, status: 200 };
    return { ok: true, json: async () => ({ success: true, data: { companyId: C1, isOwner: true } }) };
  };
  clearPresence(); clearCompanyCache();
  pc.dbReady = () => true;
  const lines = [{ _id: 'l1', companyId: C1, phoneNumber: LINE, provider: 'twilio', twilioId: 'PN1', status: 'active', billingStatus: 'active', assignedRole: 'shared', createdAt: new Date('2026-01-01'), gigId: null }];
  PhoneNumber.find = () => { const c = { sort: () => c, select: () => c, limit: () => c, lean: async () => lines, then: (r, j) => Promise.resolve(lines).then(r, j) }; return c; };
  PhoneNumber.findOne = () => { const c = { sort: () => c, select: () => c, lean: async () => lines[0], then: (r, j) => Promise.resolve(lines[0]).then(r, j) }; return c; };
  Subscription.findOne = () => ({ populate: async () => ({ planId: { name: 'Offre', metadata: OFFERS[plan] } }) });
  CallQueue.find = () => lean([]); CallQueue.findOneAndUpdate = () => lean(null); StaffRouting.find = () => lean([]);
  InboundCall.find = () => lean([]); InboundCall.updateOne = async () => ({}); InboundCall.findOne = async () => null;
  InboundSettings.findOne = () => lean({});
  ReachSettings.findOne = () => lean(null);
  CallRecordingStatus.findOne = () => lean(null); CallRecordingStatus.updateOne = async () => ({});
  // Portefeuille : lecture fraîche (select/lean) et débit atomique (filtre sur le solde lu, idempotence chargedCallSids).
  MinutesCompany.findOne = () => lean(clone(W));
  MinutesCompany.create = async (d) => { W = { minutes: 0, consumedSeconds: 0, chargedCallSids: [], ...d }; return clone(W); };
  MinutesCompany.findOneAndUpdate = async (filter, update) => {
    const ne = filter.chargedCallSids?.$ne; const nin = filter.chargedCallSids?.$nin;
    if (ne !== undefined && W.chargedCallSids.includes(ne)) return null;
    if (nin && nin.some((k) => W.chargedCallSids.includes(k))) return null;
    if ('minutes' in filter && filter.minutes !== W.minutes) return null;
    for (const [k, v] of Object.entries(update.$inc || {})) W[k] = (W[k] || 0) + v;
    for (const [k, v] of Object.entries(update.$addToSet || {})) for (const x of v.$each || [v]) if (!W[k].includes(x)) W[k].push(x);
    return clone(W);
  };
  DL = memoryDeadlines();
  for (const k of ['updateOne', 'find', 'findOne', 'findOneAndUpdate']) CallGraceDeadline[k] = DL[k];
  twilio = fakeTwilio();
  phoneNumberService.twilioClient = twilio;
  const db = { collection: () => ({
    find: () => { const c = { sort: () => c, limit: () => c, toArray: async () => CALLS, next: async () => null }; return c; },
    findOne: async (q) => CALLS.find((c) => c.sid === q?.sid) || null,
  }) };
  Object.defineProperty(mongoose.connection, 'db', { get: () => db, configurable: true });
});
after(() => { Object.assign(console, savedLog); pc.dbReady = realDbReady; });

const hit = async (method, { body = {}, query = {}, user } = {}) => {
  let out = null;
  const res = { type() { return this; }, status(c) { this.code = c; return this; }, json(x) { out = { code: this.code || 200, body: x }; return this; }, send(x) { out = x; return this; } };
  await pc[method]({ body, query, get: () => 'orch.test', headers: { authorization: 'Bearer tok' }, user }, res);
  return out;
};
const inbound = (callSid) => { markAvailable({ userId: 'ag1', companyId: C1 }); return hit('handleTwilioInboundCall', { body: { To: LINE, From: CALLER, CallSid: callSid } }); };
const outbound = (callSid) => {
  const identity = 'cc-own1';
  const ticket = signOutboundTicket({ secret: process.env.TWILIO_AUTH_TOKEN, companyId: C1, identity });
  return hit('handleBrowserOutbound', { body: { To: CALLER, From: `client:${identity}`, CompanyId: C1, Ticket: ticket, CallSid: callSid } });
};
const timeLimit = (xml) => Number((String(xml).match(/timeLimit="(\d+)"/) || [])[1]);
const MIN = 60_000;

// ---------------------------------------------------------------- règles pures

test('grâce : 5 minutes après les secondes couvertes ; timeLimit du <Dial> plafonné à 4 h ; 0 couvert => 0', () => {
  assert.equal(G.GRACE_SECONDS, 300);
  assert.equal(G.graceLimitSeconds(600), 900);
  assert.equal(G.graceLimitSeconds(14400), 14400, 'plafond de Twilio');
  assert.equal(G.graceLimitSeconds(0), 300, 'solde déjà réservé par les appels en cours : grâce dès le début');
  const p = G.planGrace({ coveredSeconds: 600, now: 1_000_000 });
  assert.equal(p.graceStartsAt.getTime(), 1_000_000 + 600_000);
  assert.equal(p.deadline.getTime(), 1_000_000 + 900_000);
  const big = G.planGrace({ coveredSeconds: 20000, now: 0 });
  assert.equal(big.deadline.getTime(), 20300 * 1000, 'la coupure par le serveur n\'a pas le plafond de 4 h');
});

test('débit borné : jamais sous zéro, le reste est consigné (non facturé) ; solde déjà négatif non creusé', () => {
  assert.deepEqual(G.clampDebit(3, 10), { debit: 3, waived: 0 });
  assert.deepEqual(G.clampDebit(7, 2), { debit: 2, waived: 5 });
  assert.deepEqual(G.clampDebit(4, 0), { debit: 0, waived: 4 });
  assert.deepEqual(G.clampDebit(4, -6), { debit: 0, waived: 4 });
});

// ---------------------------------------------------------------- démarrage refusé à solde 0

test('sortant, solde 0 : refus au démarrage (jeton / vérification : 402 MINUTES_INSUFFICIENT_FOR_DESTINATION ; webhook : refus parlé) et aucune échéance', async () => {
  for (const offer of Object.keys(OFFERS)) {
    plan = offer; W.minutes = 0; DL.rows.clear();
    const shortfall = await pc.minutesShortfall(C1);
    assert.equal(shortfall.code, 'MINUTES_INSUFFICIENT_FOR_DESTINATION', offer); assert.equal(shortfall.balance, 0);
    const xml = await outbound(sid('1'));
    assert.match(xml, /Solde de minutes insuffisant/, offer); assert.doesNotMatch(xml, /<Dial/);
    assert.equal(DL.rows.size, 0, offer);
  }
  W.minutes = -4;
  assert.equal((await pc.minutesShortfall(C1)).code, 'MINUTES_INSUFFICIENT_FOR_DESTINATION', 'solde négatif (historique) : refus');
  assert.equal(decideOutboundCall({ to: CALLER, line: { phoneNumber: LINE }, subscribed: true, minutes: 0 }).ok, false);
});

test('entrant, solde 0 : personne ne sonne (répondeur), aucune échéance ; solde illisible : flux habituel', async () => {
  for (const offer of Object.keys(OFFERS)) {
    plan = offer; W.minutes = 0; DL.rows.clear();
    const xml = await inbound(sid('2'));
    assert.doesNotMatch(xml, /<Client>/, offer);
    assert.equal(DL.rows.size, 0, offer);
  }
  W.minutes = 10; pc.dbReady = () => false;
  const xml = await inbound(sid('3'));
  assert.match(xml, /<Client>/, 'base indisponible : aucun blocage (comme les contrôles sortants)');
  assert.equal(DL.rows.size, 0);
});

// ---------------------------------------------------------------- échéance enregistrée au démarrage

test('sortant, solde 10 : timeLimit = 10 min + 5 min de grâce ; échéance enregistrée (grâce à +10 min, coupure à +15 min)', async () => {
  const before = Date.now();
  const xml = await outbound(sid('4'));
  assert.equal(timeLimit(xml), 900);
  const row = [...DL.rows.values()][0];
  assert.equal(row.callSid, sid('4')); assert.equal(row.path, 'outbound_browser'); assert.equal(row.coveredSeconds, 600); assert.equal(row.status, 'scheduled');
  assert.ok(row.graceStartsAt.getTime() - before >= 600_000 && row.graceStartsAt.getTime() - before < 605_000);
  assert.equal(row.deadline.getTime() - row.graceStartsAt.getTime(), 5 * MIN);
});

test('entrant, solde 10 : la sonnerie part et l\'échéance est enregistrée (coupure à +15 min) pour toutes les offres', async () => {
  for (const offer of Object.keys(OFFERS)) {
    plan = offer; DL.rows.clear();
    const xml = await inbound(sid('5'));
    assert.match(xml, /<Client>/, offer);
    const row = [...DL.rows.values()][0];
    assert.equal(row?.path, 'inbound', offer); assert.equal(row.coveredSeconds, 600);
    assert.equal(row.deadline.getTime() - row.startedAt.getTime(), 15 * MIN);
  }
});

test('échéance idempotente : un webhook rejoué ne la repousse pas', async () => {
  await G.scheduleGraceDeadline({ callSid: sid('6'), companyId: C1, path: 'inbound', coveredSeconds: 60, now: 0 }, { Model: DL });
  await G.scheduleGraceDeadline({ callSid: sid('6'), companyId: C1, path: 'inbound', coveredSeconds: 6000, now: 99 * MIN }, { Model: DL });
  assert.equal(DL.rows.size, 1);
  assert.equal([...DL.rows.values()][0].deadline.getTime(), 6 * MIN);
});

// ---------------------------------------------------------------- coupure à l'échéance

test('coupure : rien avant l\'échéance (ni au début de la grâce), raccroché UNE fois à +5 min de grâce par le client Twilio existant', async () => {
  await G.scheduleGraceDeadline({ callSid: sid('7'), companyId: C1, path: 'outbound_browser', coveredSeconds: 120, now: 0 }, { Model: DL });
  let r = await G.sweepGraceDeadlines({ Model: DL, client: twilio, now: 2 * MIN }); // début de la grâce
  assert.equal(r.hungUp, 0); assert.equal(twilio.hangups.length, 0);
  r = await G.sweepGraceDeadlines({ Model: DL, client: twilio, now: 7 * MIN - 1 });
  assert.equal(r.hungUp, 0);
  r = await G.sweepGraceDeadlines({ Model: DL, client: twilio, now: 7 * MIN });
  assert.equal(r.hungUp, 1); assert.deepEqual(twilio.hangups, [{ callSid: sid('7'), status: 'completed' }]);
  r = await G.sweepGraceDeadlines({ Model: DL, client: twilio, now: 8 * MIN });
  assert.equal(r.hungUp, 0); assert.equal(twilio.hangups.length, 1, 'jamais deux fois');
  assert.equal([...DL.rows.values()][0].status, 'hung_up');
});

test('reprise après redémarrage : l\'échéance est relue en base par un nouveau balayeur ; une prise abandonnée en cours de route est reprise', async () => {
  // Processus 1 : l'appel démarre (échéance écrite), puis le serveur s'arrête.
  await G.scheduleGraceDeadline({ callSid: sid('8'), companyId: C1, path: 'inbound', coveredSeconds: 60, now: 0 }, { Model: DL });
  // Processus 2 : un nouveau client, aucun état en mémoire ; seule la base compte.
  const fresh = fakeTwilio();
  const r = await G.sweepGraceDeadlines({ Model: DL, client: fresh, now: 30 * MIN });
  assert.equal(r.hungUp, 1); assert.equal(fresh.hangups[0].callSid, sid('8'));
  // Prise faite par une instance arrêtée avant d'appeler Twilio : reprise après 60 s, pas avant.
  await G.scheduleGraceDeadline({ callSid: sid('9'), companyId: C1, path: 'inbound', coveredSeconds: 60, now: 0 }, { Model: DL });
  const row = [...DL.rows.values()].find((x) => x.callSid === sid('9'));
  Object.assign(row, { status: 'hanging', claimedAt: new Date(10 * MIN) });
  const again = fakeTwilio();
  assert.equal((await G.sweepGraceDeadlines({ Model: DL, client: again, now: 10 * MIN + 30_000 })).hungUp, 0);
  assert.equal((await G.sweepGraceDeadlines({ Model: DL, client: again, now: 11 * MIN + 1 })).hungUp, 1);
  assert.equal(again.hangups.length, 1);
});

test('appel déjà terminé chez Twilio : « ended », pas de nouvel essai ; panne passagère : nouvel essai, abandon après 5', async () => {
  await G.scheduleGraceDeadline({ callSid: sid('a'), companyId: C1, path: 'inbound', coveredSeconds: 60, now: 0 }, { Model: DL });
  const over = fakeTwilio({ fail: () => Object.assign(new Error('Call is not in-progress'), { code: 21220 }) });
  assert.equal((await G.sweepGraceDeadlines({ Model: DL, client: over, now: 10 * MIN })).ended, 1);
  assert.equal((await G.sweepGraceDeadlines({ Model: DL, client: over, now: 11 * MIN })).ended, 0);
  DL.rows.clear();
  await G.scheduleGraceDeadline({ callSid: sid('b'), companyId: C1, path: 'inbound', coveredSeconds: 60, now: 0 }, { Model: DL });
  const down = fakeTwilio({ fail: () => new Error('ECONNRESET') });
  for (let i = 1; i <= 4; i += 1) assert.equal((await G.sweepGraceDeadlines({ Model: DL, client: down, now: 10 * MIN + i })).retried, 1);
  assert.equal((await G.sweepGraceDeadlines({ Model: DL, client: down, now: 11 * MIN })).failed, 1);
  assert.equal([...DL.rows.values()][0].status, 'failed');
});

test('fin normale de l\'appel : plus rien à couper', async () => {
  await G.scheduleGraceDeadline({ callSid: sid('c'), companyId: C1, path: 'inbound', coveredSeconds: 60, now: 0 }, { Model: DL });
  assert.equal(await G.markGraceEnded(sid('c'), { Model: DL }), true);
  assert.equal((await G.sweepGraceDeadlines({ Model: DL, client: twilio, now: 30 * MIN })).hungUp, 0);
  assert.equal(twilio.hangups.length, 0);
});

// ---------------------------------------------------------------- aucun dépassement facturé

test('aucun dépassement facturé : 2 min de solde, appel de 7 min (2 couvertes + 5 de grâce) => débit 2, solde 0, 5 non facturées (sortant et entrant)', async () => {
  for (const direction of ['outbound', 'inbound']) {
    W = { ...W, minutes: 2, chargedCallSids: [], graceWaivedMinutes: 0, consumedSeconds: 0 };
    CALLS = [{ sid: `CA_${direction}`, duration: 7 * 60, companyId: C1, direction, to: CALLER, from: LINE }];
    await syncMinutesFromCalls(C1);
    assert.equal(W.minutes, 0, direction); assert.equal(W.graceWaivedMinutes, 5, direction); assert.equal(W.consumedSeconds, 420);
    await syncMinutesFromCalls(C1);
    assert.equal(W.minutes, 0, 'idempotent');
  }
});

test('aucun dépassement facturé : POST /charge-call et chargeCallMinutes bornés à 0 ; appel suivant à solde 0 : rien débité', async () => {
  W.minutes = 3;
  CALLS = [{ sid: 'CA_X', duration: 8 * 60, companyId: C1, direction: 'outbound', to: CALLER, from: LINE }];
  const r = { code: 200 }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; };
  await minutesCompanyController.chargeCall({ body: { companyId: C1, callSid: 'CA_X', duration: 480 } }, r);
  assert.equal(r.body.charged, true); assert.equal(W.minutes, 0); assert.equal(W.graceWaivedMinutes, 5);
  assert.equal(await chargeCallMinutes(C1, { sid: 'CA_Y', duration: 125 }), true);
  assert.equal(W.minutes, 0); assert.equal(W.graceWaivedMinutes, 8);
  assert.equal(await chargeCallMinutes(C1, { sid: 'CA_Y', duration: 125 }), false, 'idempotent');
});

test('débit concurrent : le solde a changé entre lecture et écriture => relecture, jamais sous zéro', async () => {
  W.minutes = 4;
  const real = MinutesCompany.findOneAndUpdate;
  let first = true;
  MinutesCompany.findOneAndUpdate = async (f, u) => { if (first) { first = false; W.minutes = 1; return null; } return real(f, u); };
  const out = await G.debitMinutesClamped({ companyId: C1, keys: ['CA_Z'], cost: 3, seconds: 150 });
  assert.equal(out.debit, 1); assert.equal(out.waived, 2); assert.equal(W.minutes, 0);
});

// ---------------------------------------------------------------- lecture pour le portail

test('GET call-grace : vue de l\'appel (grâce, coupure) ; jambe du navigateur (entrant) résolue par l\'appel parent ; autre entreprise refusée', async () => {
  const t0 = Date.now();
  await G.scheduleGraceDeadline({ callSid: sid('d'), companyId: C1, path: 'inbound', coveredSeconds: 0, now: t0 }, { Model: DL });
  const parents = { [sid('e')]: sid('d') };
  const handlers = createGraceHandlers({
    getAccess: async (req) => ({ userId: 'u1', companyId: req.headers.c, companyIds: [req.headers.c], role: 'agent' }),
    getClient: async () => fakeTwilio({ parents }),
    find: (args) => G.findGraceForCall({ ...args, Model: DL }),
    now: () => t0 + 4 * MIN,
  });
  const get = async (companyId, callSid, c = C1) => { const r = { code: 200 }; r.status = (x) => { r.code = x; return r; }; r.json = (b) => { r.body = b; return r; }; await handlers.getCallGrace({ params: { companyId, callSid }, headers: { c } }, r); return r; };
  let r = await get(C1, sid('e'));
  assert.equal(r.code, 200); assert.equal(r.body.data.callSid, sid('d')); assert.equal(r.body.data.inGrace, true); assert.equal(r.body.data.secondsLeft, 60);
  assert.equal(r.body.data.graceSeconds, 300);
  r = await get(C1, sid('d')); assert.equal(r.body.data.callSid, sid('d'));
  r = await get(C2, sid('d'), C1); assert.equal(r.code, 403, 'entreprise qui n\'est pas la sienne');
  r = await get(C2, sid('d'), C2); assert.equal(r.body.data, null, 'jamais l\'appel d\'une autre entreprise');
  r = await get(C1, 'nope'); assert.equal(r.code, 400);
});

// ---------------------------------------------------------------- revue : appels simultanés, webhook entrant borné, filet entrant, retry_later

const spoken = (row) => (row.deadline.getTime() - row.startedAt.getTime()) / 1000;

test('3 appels sortants simultanés sur 10 min de solde : la somme des coupures ne dépasse pas 10 min + 3 × 5 min', async () => {
  W.minutes = 10;
  const limits = [];
  for (const c of ['1', '2', '3']) limits.push(timeLimit(await outbound(sid(c))));
  const rows = [...DL.rows.values()];
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((x) => x.coveredSeconds), [600, 0, 0], 'le premier réserve tout le solde, les suivants démarrent en grâce');
  assert.deepEqual(limits, [900, 300, 300], 'timeLimit = couvertes + 5 min');
  const total = rows.reduce((n, x) => n + spoken(x), 0);
  assert.ok(total <= 600 + 3 * 300, `total ${total} s`);
});

test('3 appels simultanés mélangés (entrant, sortant, entrant) : même plafond global ; un appel terminé libère sa réserve', async () => {
  W.minutes = 10;
  await inbound(sid('4')); await outbound(sid('5')); await inbound(sid('6'));
  const rows = [...DL.rows.values()];
  assert.ok(rows.reduce((n, x) => n + spoken(x), 0) <= 600 + 3 * 300);
  // Le premier appel est terminé chez Twilio : il ne réserve plus rien, le suivant retrouve tout le solde.
  DL.rows.clear();
  await outbound(sid('7'));
  twilio = fakeTwilio({ statuses: { [sid('7')]: 'completed' } }); phoneNumberService.twilioClient = twilio;
  await outbound(sid('8'));
  const row8 = [...DL.rows.values()].find((x) => x.callSid === sid('8'));
  assert.equal(row8.coveredSeconds, 600);
  assert.equal([...DL.rows.values()].find((x) => x.callSid === sid('7')).status, 'ended');
});

test('refus seulement à solde nul : solde > 0 entièrement réservé => l\'appel démarre (grâce), solde 0 => refus', async () => {
  W.minutes = 2;
  await outbound(sid('9'));
  const xml = await outbound(sid('a'));
  assert.match(xml, /<Dial/); assert.equal(timeLimit(xml), 300);
  W.minutes = 0;
  assert.doesNotMatch(await outbound(sid('b')), /<Dial/);
});

test('webhook entrant : lecture du solde qui pend => réponse en moins de 3 s, sonnerie sans blocage ni échéance', async () => {
  MinutesCompany.findOne = () => ({ select: () => ({ lean: () => new Promise(() => {}) }) });
  const t0 = Date.now();
  const xml = await inbound(sid('c'));
  assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
  assert.match(xml, /<Client>/);
  assert.doesNotMatch(xml, /timeLimit=/);
  assert.equal(DL.rows.size, 0);
});

test('webhook entrant : ni octroi de la période ni synchronisation des appels (lecture directe du portefeuille)', async () => {
  let synced = false;
  Object.defineProperty(mongoose.connection, 'db', { get: () => { synced = true; return { collection: () => ({ find: () => ({ toArray: async () => [] }), findOne: async () => null }) }; }, configurable: true });
  let subs = 0; Subscription.findOne = () => { subs += 1; return { populate: async () => ({ planId: { name: 'Offre', metadata: OFFERS[plan] } }) }; };
  const before = subs;
  assert.equal((await pc.inboundMinutes(C1)).coveredSeconds, 600);
  assert.equal(synced, false, 'collection calls non relue'); assert.equal(subs, before, 'abonnement (octroi) non relu');
});

test('filet entrant : <Dial> vers les navigateurs avec timeLimit = couvertes + 5 min', async () => {
  W.minutes = 10;
  const xml = await inbound(sid('d'));
  assert.match(xml, /<Dial [^>]*timeLimit="900"[^>]*>.*<Client>/);
});

test('/charge-call : verrou du solde perdu à chaque essai => reason « retry_later », rien débité (jamais « Already charged »)', async () => {
  W.minutes = 5;
  CALLS = [{ sid: 'CA_R', duration: 60, companyId: C1, direction: 'outbound', to: CALLER, from: LINE }];
  MinutesCompany.findOneAndUpdate = async () => { W.minutes += 0; return null; };
  const r = { code: 200 }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; };
  await minutesCompanyController.chargeCall({ body: { companyId: C1, callSid: 'CA_R', duration: 60 } }, r);
  assert.equal(r.body.charged, false); assert.equal(r.body.reason, 'retry_later');
  assert.equal(W.minutes, 5); assert.deepEqual(W.chargedCallSids, []);
});

