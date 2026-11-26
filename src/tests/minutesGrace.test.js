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
const { signPlan } = await import('../services/queueRouting.js');
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
    if (k === '_id') return v && typeof v === 'object' && '$nin' in v ? !v.$nin.includes(row._id) : row._id === v;
    if (k === 'childSids') return (row.childSids || []).includes(v);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const t = row[k] == null ? null : new Date(row[k]).getTime();
      return Object.entries(v).every(([op, x]) => {
        if (op === '$lte') return t != null && t <= new Date(x).getTime();
        if (op === '$gt') return t != null && t > new Date(x).getTime();
        if (op === '$in') return x.includes(row[k]);
        return false;
      });
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
    // Tri et limite appliqués comme en base (le balayeur pagine par lots).
    find(f) {
      let out = [...rows.values()].filter((r) => matches(r, f));
      const q = {
        sort(spec) { const [[key, dir]] = Object.entries(spec || { deadline: 1 }); out = out.sort((a, b) => (new Date(a[key]) - new Date(b[key])) * dir); return q; },
        limit(n) { out = out.slice(0, n); return q; },
        select() { return q; },
        lean: async () => out.map(clone),
        then(res, rej) { return Promise.resolve(out.map(clone)).then(res, rej); },
      };
      return q;
    },
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
const realEndReportAuthentic = pc.endReportAuthentic;
beforeEach(() => {
  if (!process.env.DBG) { console.log = () => {}; console.warn = () => {}; console.error = () => {}; }
  plan = 'full_scope'; CALLS = [];
  W = { companyId: C1, minutes: 10, consumedSeconds: 0, chargedCallSids: [], planGrantKeys: [], credits: [], purchasedMinutes: 0, planMinutesGranted: 0 };
  global.fetch = async (url) => {
    if (String(url).startsWith('https://dash.test')) return { ok: true, status: 200 };
    return { ok: true, json: async () => ({ success: true, data: { companyId: C1, isOwner: true } }) };
  };
  clearPresence(); clearCompanyCache();
  pc.dbReady = () => true; G.setGraceDbReady(() => true);
  pc.grantPlanMinutes = async () => undefined;
  pc.endReportAuthentic = () => true;
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
  MinutesCompany.updateOne = async (filter, update) => {
    const f = filter.reservedCredits; const cur = W.reservedCredits ?? 0;
    if (f && typeof f === 'object' && '$lt' in f && !(cur < f.$lt)) return { modifiedCount: 0 };
    Object.assign(W, update.$set || {}); return { modifiedCount: 1 };
  };
  MinutesCompany.find = () => lean((W.reservedCredits || 0) > 0 ? [clone(W)] : []);
  MinutesCompany.create = async (d) => { W = { minutes: 0, consumedSeconds: 0, chargedCallSids: [], ...d }; return clone(W); };
  MinutesCompany.findOneAndUpdate = async (filter, update) => {
    await Promise.resolve(); // entrelacement réaliste des démarrages simultanés ; le contrôle + l'écriture restent atomiques, comme en base
    const ne = filter.chargedCallSids?.$ne; const nin = filter.chargedCallSids?.$nin;
    if (ne !== undefined && W.chargedCallSids.includes(ne)) return null;
    if (nin && nin.some((k) => W.chargedCallSids.includes(k))) return null;
    if ('minutes' in filter && filter.minutes !== W.minutes) return null;
    if ('reservedCredits' in filter) {
      const f = filter.reservedCredits; const cur = W.reservedCredits ?? null;
      const ok = f && typeof f === 'object' ? ('$gte' in f ? (cur ?? 0) >= f.$gte : '$lt' in f ? (cur ?? 0) < f.$lt : f.$in.includes(cur)) : cur === f;
      if (!ok) return null;
    }
    Object.assign(W, update.$set || {});
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
after(() => { Object.assign(console, savedLog); pc.dbReady = realDbReady; G.setGraceDbReady(null); });

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
  // NOMAD : ses 120 minutes incluses (26/11/2026) sont accordées à la lecture du solde : le solde n'est pas nul (voir le test qui suit).
  for (const offer of Object.keys(OFFERS).filter((o) => o !== 'nomad_solo')) {
    plan = offer; W.minutes = 0; DL.rows.clear();
    const shortfall = await pc.minutesShortfall(C1);
    assert.equal(shortfall.code, 'MINUTES_INSUFFICIENT_FOR_DESTINATION', offer); assert.equal(shortfall.balance, 0);
    const xml = await outbound(sid('1'));
    assert.match(xml, /Solde de minutes insuffisant/, offer); assert.doesNotMatch(xml, /<Dial/);
    assert.equal(DL.rows.size, 0, offer);
  }
  W.minutes = -4;
  assert.equal((await pc.minutesShortfall(C1)).code, 'MINUTES_INSUFFICIENT_FOR_DESTINATION', 'solde négatif (historique) : refus');
  plan = 'nomad_solo'; W.minutes = 0; DL.rows.clear();
  assert.equal(await pc.minutesShortfall(C1), null, 'NOMAD : 120 minutes incluses accordées, l\'appel peut partir');
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
    plan = offer; DL.rows.clear(); W.reservedCredits = 0;
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
  assert.deepEqual(limits, [900, 900, 900], 'timeLimit = filet large (solde total + 5 min) ; le serveur coupe précisément');
  const total = rows.reduce((n, x) => n + spoken(x), 0);
  assert.ok(total <= 600 + 3 * 300, `total ${total} s`);
});

test('3 appels simultanés mélangés (entrant, sortant, entrant) : même plafond global ; un appel terminé rend sa réserve', async () => {
  W.minutes = 10;
  await inbound(sid('4')); await outbound(sid('5')); await inbound(sid('6'));
  const rows = [...DL.rows.values()];
  assert.ok(rows.reduce((n, x) => n + spoken(x), 0) <= 600 + 3 * 300);
  assert.equal(W.reservedCredits, 10);
  DL.rows.clear(); W.reservedCredits = 0;
  await outbound(sid('7'));
  assert.equal(W.reservedCredits, 10);
  await G.endGraceCall(sid('7')); // durée inconnue : réserve gardée jusqu'au débit
  assert.equal(W.reservedCredits, 10);
  await G.endGraceCall(sid('7'), { durationSeconds: 50 }); // compte rendu de fin avec la durée : débit (1 min), puis réserve rendue
  assert.equal(W.minutes, 9); assert.equal(W.reservedCredits, 0);
  await outbound(sid('8'));
  assert.equal([...DL.rows.values()].find((x) => x.callSid === sid('8')).coveredSeconds, 540);
});

test('refus seulement à solde nul : solde > 0 entièrement réservé => l\'appel démarre (grâce), solde 0 => refus', async () => {
  W.minutes = 2;
  await outbound(sid('9'));
  const xml = await outbound(sid('a'));
  assert.match(xml, /<Dial/); assert.equal(timeLimit(xml), 420, 'filet large : solde total (2 min) + 5 min');
  const row = [...DL.rows.values()].find((x) => x.callSid === sid('a'));
  assert.equal(row.coveredSeconds, 0); assert.equal(row.deadline.getTime() - row.startedAt.getTime(), 300_000, 'grâce dès le début (rien de libre)');
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
  assert.deepEqual(await pc.inboundMinutes(C1), { minutes: 10, exhausted: false });
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

// ---------------------------------------------------------------- 2e revue : réservation atomique

test('A démarre ; B à +6 min puis C pendant la grâce de A : couverts seulement par le non réservé ; jamais plus de 5 min gratuites par appel', async () => {
  W.minutes = 10;
  const t0 = Date.parse('2026-11-20T10:00:00Z');
  const a = await G.startGraceCall({ callSid: sid('1'), companyId: C1, path: 'outbound_browser', maxCoveredSeconds: 600, now: t0 });
  const b = await G.startGraceCall({ callSid: sid('2'), companyId: C1, path: 'inbound', maxCoveredSeconds: 600, now: t0 + 6 * MIN });
  const c = await G.startGraceCall({ callSid: sid('3'), companyId: C1, path: 'inbound', maxCoveredSeconds: 600, now: t0 + 12 * MIN });
  assert.deepEqual([a.coveredSeconds, b.coveredSeconds, c.coveredSeconds], [600, 0, 0], 'A a réservé tout le solde (débit seulement en fin d\'appel)');
  for (const p of [a, b, c]) assert.equal((p.deadline - p.graceStartsAt) / 1000, 300, 'grâce gratuite : 5 min au plus');
  assert.equal(W.reservedCredits, 10);
  // A se termine et est débité : sa réserve est rendue au débit ; un appel suivant n'est couvert que par le reste.
  CALLS = [{ sid: sid('1'), duration: 8 * 60, companyId: C1, direction: 'outbound', to: CALLER, from: LINE }];
  await syncMinutesFromCalls(C1);
  assert.equal(W.minutes, 2); assert.equal(W.reservedCredits, 0);
  const d = await G.startGraceCall({ callSid: sid('4'), companyId: C1, path: 'inbound', maxCoveredSeconds: 600, now: t0 + 13 * MIN });
  assert.equal(d.coveredSeconds, 120);
});

test('5 démarrages concurrents (Promise.all) : la somme des réservations ne dépasse jamais le solde', async () => {
  W.minutes = 10; W.reservedCredits = 0;
  const plans = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((c) => G.startGraceCall({ callSid: sid(c), companyId: C1, path: 'inbound', maxCoveredSeconds: 180 })));
  const sum = plans.reduce((n, p) => n + p.reservedCredits, 0);
  assert.ok(sum <= 10, `réservé ${sum}`);
  assert.equal(W.reservedCredits, sum);
  assert.equal([...DL.rows.values()].reduce((n, x) => n + x.reservedCredits, 0), sum, 'chaque échéance porte sa réservation');
  for (const p of plans) assert.equal(p.coveredSeconds, (p.reservedCredits) * 60);
});

test('libération idempotente : deux comptes rendus de fin (et le débit) ne débitent et ne rendent qu\'une fois', async () => {
  W.minutes = 10; W.reservedCredits = 4; // 4 crédits déjà tenus par un autre appel
  await G.startGraceCall({ callSid: sid('f'), companyId: C1, path: 'outbound_browser' });
  assert.equal(W.reservedCredits, 10, 'tranche = le libre (6 min)');
  assert.equal(await G.endGraceCall(sid('f'), { durationSeconds: 90 }), 6);
  assert.equal(W.minutes, 8, 'débité AVANT de rendre la réserve (2 min)');
  assert.equal(await G.endGraceCall(sid('f'), { durationSeconds: 90 }), 0);
  assert.equal(await G.releaseForChargedKeys([sid('f')]), 0);
  assert.equal(W.minutes, 8); assert.equal(W.reservedCredits, 4, 'la réserve de l\'autre appel est intacte');
  CALLS = [{ sid: sid('f'), duration: 90, companyId: C1, direction: 'outbound', to: CALLER, from: LINE }];
  await syncMinutesFromCalls(C1);
  assert.equal(W.minutes, 8, 'la synchronisation ne le débite pas une seconde fois');
  // Jambe du navigateur (entrant) vue par le portail : la libération passe aussi par elle.
  await G.startGraceCall({ callSid: sid('g'), companyId: C1, path: 'inbound' });
  [...DL.rows.values()].find((x) => x.callSid === sid('g')).childSids.push(sid('h'));
  assert.equal(await G.releaseForChargedKeys([sid('h')]), 4);
  assert.equal(W.reservedCredits, 4);
});

test('balayeur : une réservation orpheline (fin perdue, redémarrage) est DÉBITÉE puis rendue 2 min après la coupure, pas avant', async () => {
  W.minutes = 10; W.reservedCredits = 0;
  await G.startGraceCall({ callSid: sid('i'), companyId: C1, path: 'inbound', now: 0 }); // tranche 10 min, coupure à 15 min
  assert.equal(W.reservedCredits, 10);
  let r = await G.sweepGraceDeadlines({ client: null, now: 16 * MIN });
  assert.equal(r.released, 0); assert.equal(W.reservedCredits, 10);
  r = await G.sweepGraceDeadlines({ client: null, now: 17 * MIN + 1 });
  assert.equal(r.released, 1); assert.equal(W.reservedCredits, 0);
  assert.equal(W.minutes, 0, 'durée inconnue : le temps couvert réservé est débité');
  r = await G.sweepGraceDeadlines({ client: null, now: 20 * MIN });
  assert.equal(r.released, 0, 'jamais deux fois');
  // Durée connue chez Twilio : c'est elle qui est débitée.
  W.minutes = 10; W.chargedCallSids = [];
  await G.startGraceCall({ callSid: sid('n'), companyId: C1, path: 'outbound_browser', now: 0 });
  await G.sweepGraceDeadlines({ client: fakeTwilio({ statuses: { [sid('n')]: 'completed' } }), now: 17 * MIN + 1 });
  assert.equal(W.reservedCredits, 0);
});

test('nouvelle période : solde 0 avec forfait renouvelé => octroi (borné) puis relecture, l\'appel est accepté', async () => {
  W.minutes = 0; let granted = 0;
  pc.grantPlanMinutes = async () => { granted += 1; W.minutes = 30; };
  const xml = await inbound(sid('j'));
  assert.equal(granted, 1);
  assert.match(xml, /<Client>/);
  assert.equal([...DL.rows.values()][0].coveredSeconds, 600, 'une tranche de 10 min');
  // Octroi sans effet (pas de période renouvelée) : refus après relecture.
  W.minutes = 0; W.reservedCredits = 0; DL.rows.clear(); pc.grantPlanMinutes = async () => undefined;
  assert.doesNotMatch(await inbound(sid('k')), /<Client>/);
  // Octroi qui pend : borné, la relecture décide (toujours 0 : refus), réponse rapide.
  pc.grantPlanMinutes = () => new Promise(() => {});
  const t0 = Date.now(); await inbound(sid('l')); assert.ok(Date.now() - t0 < 3000);
});

test('file d\'attente et mobile tenté : chaque <Dial> reçoit le temps restant jusqu\'à la coupure', async () => {
  assert.equal(G.withDialTimeLimit('<Dial timeout="20"><Client>a</Client></Dial><Dial timeLimit="9"></Dial>', 600), '<Dial timeout="20" timeLimit="600"><Client>a</Client></Dial><Dial timeLimit="9"></Dial>');
  assert.equal(G.withDialTimeLimit('<Dial></Dial>', 0), '<Dial></Dial>');
  W.minutes = 10;
  await G.startGraceCall({ callSid: sid('m'), companyId: C1, path: 'inbound', maxCoveredSeconds: 600 });
  // Tentative suivante d'une file à tour de rôle.
  const plan = [{ ids: ['cc-a'], t: 20 }, { ids: ['cc-b'], t: 20 }];
  let out = null;
  const res = { type() { return this; }, status() { return this; }, send(x) { out = x; return this; }, json() { return this; } };
  await pc.handleTwilioInboundQueueNext({ body: { CallSid: sid('m'), DialCallStatus: 'no-answer', To: LINE, From: CALLER }, query: { s: signPlan(plan, 1, C1) }, get: () => 'orch.test', headers: {} }, res);
  const limitOf = (x) => Number((String(x).match(/<Dial[^>]*timeLimit="(\d+)"/) || [])[1]);
  assert.match(out, /<Client>cc-b<\/Client>/);
  assert.ok(limitOf(out) > 890 && limitOf(out) <= 900, String(limitOf(out)));
  // Le navigateur n'a pas décroché : le mobile du titulaire est tenté avec le même plafond.
  ReachSettings.findOne = () => lean({ forwardEnabled: true, mobileNumber: '+33611223344', mobileRingSeconds: 25 });
  InboundCall.findOne = async () => ({ companyId: C1, phoneNumber: LINE, from: CALLER, startedAt: new Date(), mobileTried: false, save: async () => {} });
  await pc.handleTwilioInboundDialResult({ body: { CallSid: sid('m'), DialCallStatus: 'no-answer' }, query: {}, get: () => 'orch.test', headers: {} }, res);
  assert.match(out, /<Number>\+33611223344<\/Number>/);
  assert.ok(limitOf(out) > 890 && limitOf(out) <= 900);
  // Fin de la sonnerie du mobile (décroché puis raccroché) : réserve rendue.
  InboundCall.findOne = async () => ({ companyId: C1, phoneNumber: LINE, from: CALLER, startedAt: new Date(), mobileTried: true, save: async () => {} });
  await pc.handleTwilioInboundDialResult({ body: { CallSid: sid('m'), DialCallStatus: 'completed', DialCallDuration: '30' }, query: { leg: 'mobile' }, get: () => 'orch.test', headers: {} }, res);
  assert.equal(W.reservedCredits, 0);
});

// ---------------------------------------------------------------- 3e revue : tranches, débit en fin d'appel, réserve auto-réparatrice

test('100 min de solde : l\'agent 1 décroche, l\'agent 2 appelle 30 s après : couvert par une tranche, pas de coupure à 5 min', async () => {
  W.minutes = 100;
  await inbound(sid('1'));
  const xml = await outbound(sid('2'));
  const row = [...DL.rows.values()].find((x) => x.callSid === sid('2'));
  assert.equal(row.coveredSeconds, 600); assert.equal(row.graceStartsAt.getTime() - row.startedAt.getTime(), 600_000);
  assert.equal(timeLimit(xml), 100 * 60 + 300, 'filet large : solde total (100 min) + 5 min');
  assert.equal(W.reservedCredits, 20);
});

test('Nomad Solo, 10 min : 4 appels entrants successifs de 12 min sans portail => au plus 5 min offertes, le reste refusé', async () => {
  plan = 'nomad_solo'; W.minutes = 10;
  await inbound(sid('3'));
  const row = [...DL.rows.values()][0]; const t0 = row.startedAt.getTime();
  await G.sweepGraceDeadlines({ client: twilio, now: t0 + 541_000 }); // 60 s avant la fin de la tranche : rien de libre
  assert.equal(DL.rows.get(row._id).coveredSeconds, 600, 'rien de libre : pas de tranche de plus');
  assert.equal(twilio.hangups.length, 0);
  // Fin réelle à 12 min (compte rendu signé de fin de sonnerie) : débit borné au solde, puis réserve rendue.
  await G.endGraceCall(sid('3'), { durationSeconds: 720 });
  assert.equal(W.minutes, 0); assert.equal(W.reservedCredits, 0);
  for (const c of ['4', '5', '6']) assert.doesNotMatch(await inbound(sid(c)), /<Client>/, 'solde nul : refus (répondeur)');
  assert.ok((W.graceWaivedMinutes || 0) <= 5, `offert ${W.graceWaivedMinutes}`);
  // Un appel qui irait au-delà serait coupé à l'heure : coupure à 10 + 5 min.
  assert.equal(row.deadline.getTime() - t0, 15 * MIN);
});

test('appel long : prolongé tranche par tranche par le balayeur tant que du solde est libre, puis grâce de 5 min et coupure', async () => {
  W.minutes = 25; const t0 = Date.parse('2026-11-20T09:00:00Z');
  await G.startGraceCall({ callSid: sid('7'), companyId: C1, path: 'outbound_browser', now: t0 });
  const row = () => [...DL.rows.values()].find((x) => x.callSid === sid('7'));
  let r = await G.sweepGraceDeadlines({ client: twilio, now: t0 + 9 * MIN - 1000 });
  assert.equal(r.extended, 0, 'trop tôt');
  r = await G.sweepGraceDeadlines({ client: twilio, now: t0 + 9 * MIN + 1000 });
  assert.equal(r.extended, 1); assert.equal(row().coveredSeconds, 1200); assert.equal(W.reservedCredits, 20);
  r = await G.sweepGraceDeadlines({ client: twilio, now: t0 + 19 * MIN + 1000 });
  assert.equal(r.extended, 1); assert.equal(row().coveredSeconds, 1500, 'dernière tranche partielle (5 min)');
  r = await G.sweepGraceDeadlines({ client: twilio, now: t0 + 24 * MIN + 1000 });
  assert.equal(r.exhausted, 1); assert.equal(row().extensible, true, 'nouvel essai à chaque passage');
  assert.equal(row().graceStartsAt.getTime(), t0 + 25 * MIN); assert.equal(row().deadline.getTime(), t0 + 30 * MIN);
  r = await G.sweepGraceDeadlines({ client: twilio, now: t0 + 30 * MIN });
  assert.equal(r.hungUp, 1); assert.deepEqual(twilio.hangups, [{ callSid: sid('7'), status: 'completed' }]);
});

test('appel terminé dont le compte rendu s\'est perdu : la prolongation le voit fini chez Twilio, le débite puis rend la réserve', async () => {
  W.minutes = 30; const t0 = Date.parse('2026-11-20T09:00:00Z');
  await G.startGraceCall({ callSid: sid('8'), companyId: C1, path: 'outbound_browser', now: t0 });
  const client = fakeTwilio({ statuses: { [sid('8')]: 'completed' } });
  client.calls = ((orig) => (id) => ({ ...orig(id), fetch: async () => ({ sid: id, status: 'completed', duration: '125' }) }))(client.calls);
  const r = await G.sweepGraceDeadlines({ client, now: t0 + 9 * MIN + 1000 });
  assert.equal(r.finished, 1); assert.equal(W.minutes, 27); assert.equal(W.reservedCredits, 0);
});

test('crash entre la réservation et l\'échéance : le balayeur recalcule la réserve (somme des échéances tenues)', async () => {
  W.minutes = 20; W.reservedCredits = 0;
  await G.startGraceCall({ callSid: sid('9'), companyId: C1, path: 'inbound' }); // tient 10
  W.reservedCredits += 7; // réserve gonflée : crash après le $inc, avant l'écriture de l'échéance
  await G.sweepGraceDeadlines({ client: null });
  assert.equal(W.reservedCredits, 10);
  // Démarrage en cours (échéance pending récente) : le recalcul attend.
  await DL.updateOne({ callSid: sid('a') }, { $setOnInsert: { callSid: sid('a'), companyId: C1, path: 'inbound', startedAt: new Date(), reservationStatus: 'pending', status: 'scheduled', graceStartsAt: new Date(Date.now() + 9e6), deadline: new Date(Date.now() + 9e6) } }, { upsert: true });
  W.reservedCredits = 13;
  await G.sweepGraceDeadlines({ client: null });
  assert.equal(W.reservedCredits, 13);
});

test('signature Twilio invalide sur call-status, inbound-dial-result et voicemail-done : rien n\'est débité ni rendu', async () => {
  pc.endReportAuthentic = realEndReportAuthentic; // vraie vérification : aucune en-tête X-Twilio-Signature
  W.minutes = 10;
  await G.startGraceCall({ callSid: sid('b'), companyId: C1, path: 'inbound' });
  const res = { type() { return this; }, status() { return this; }, send() { return this; }, json() { return this; } };
  const req = (body, query = {}) => ({ body, query, get: () => 'orch.test', headers: {} });
  InboundCall.findOne = async () => ({ companyId: C1, phoneNumber: LINE, from: CALLER, startedAt: new Date(), mobileTried: true, save: async () => {} });
  await pc.handleTwilioCallStatusWebhook(req({ CallSid: sid('b'), CallStatus: 'completed', CallDuration: '30' }), res);
  await pc.handleTwilioInboundDialResult(req({ CallSid: sid('b'), DialCallStatus: 'completed', DialCallDuration: '30' }), res);
  await pc.handleTwilioVoicemailDone(req({ CallSid: sid('b') }), res);
  assert.equal(W.reservedCredits, 10); assert.equal(W.minutes, 10); assert.deepEqual(W.chargedCallSids, []);
});

test('startGrace qui pend : le webhook répond en moins de 3 s, sans échéance, avec le filet large', async () => {
  W.minutes = 10;
  CallGraceDeadline.findOne = () => ({ lean: () => new Promise(() => {}) });
  let t0 = Date.now();
  const xml = await outbound(sid('c'));
  assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
  assert.equal(timeLimit(xml), 900);
  t0 = Date.now();
  assert.match(await inbound(sid('d')), /<Dial [^>]*timeLimit="900"/);
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(DL.rows.size, 0); assert.equal(W.reservedCredits || 0, 0);
});

// ---------------------------------------------------------------- 4e revue : manque momentané de solde libre

test('8 min de solde : A réserve 8, B démarre sans rien de libre (grâce), A raccroche à 30 s => B est prolongé, pas coupé à 5 min', async () => {
  W.minutes = 8; const t0 = Date.parse('2026-11-20T11:00:00Z');
  await G.startGraceCall({ callSid: sid('1'), companyId: C1, path: 'inbound', now: t0 });
  await G.startGraceCall({ callSid: sid('2'), companyId: C1, path: 'outbound_browser', now: t0 });
  const b = () => [...DL.rows.values()].find((x) => x.callSid === sid('2'));
  assert.equal(b().coveredSeconds, 0); assert.equal(b().deadline.getTime(), t0 + 5 * MIN);
  let r = await G.sweepGraceDeadlines({ client: twilio, now: t0 + 20_000 });
  assert.equal(r.exhausted >= 1, true, 'rien de libre : nouvel essai plus tard');
  await G.endGraceCall(sid('1'), { durationSeconds: 30 }); // A raccroche : 1 min débitée, 8 rendues
  assert.equal(W.minutes, 7); assert.equal(W.reservedCredits, 0);
  r = await G.sweepGraceDeadlines({ client: twilio, now: t0 + 40_000 });
  assert.equal(r.extended, 1);
  assert.equal(b().coveredSeconds, 420); assert.equal(W.reservedCredits, 7);
  assert.equal(b().graceStartsAt.getTime(), t0 + 40_000 + 7 * MIN, 'sort de la grâce : couvert à partir de maintenant');
  assert.equal(b().deadline.getTime() - b().graceStartsAt.getTime(), 260_000, 'grâce restante : 5 min − 40 s déjà passées');
  r = await G.sweepGraceDeadlines({ client: twilio, now: t0 + 5 * MIN });
  assert.equal(r.hungUp, 0); assert.equal(twilio.hangups.length, 0, 'pas coupé à 5 min');
});

test('en cours de prolongation : A à 9 min sans solde libre, B raccroche => A est prolongé', async () => {
  W.minutes = 20; const t0 = Date.parse('2026-11-20T12:00:00Z');
  await G.startGraceCall({ callSid: sid('3'), companyId: C1, path: 'outbound_browser', now: t0 });
  await G.startGraceCall({ callSid: sid('4'), companyId: C1, path: 'inbound', now: t0 + MIN });
  const a = () => [...DL.rows.values()].find((x) => x.callSid === sid('3'));
  let r = await G.sweepGraceDeadlines({ client: twilio, now: t0 + 9 * MIN + 1000 });
  assert.equal(a().coveredSeconds, 600, 'rien de libre à 9 min');
  await G.endGraceCall(sid('4'), { durationSeconds: 30 }); // B raccroche : 1 min débitée, 10 rendues
  r = await G.sweepGraceDeadlines({ client: twilio, now: t0 + 9 * MIN + 11_000 });
  assert.equal(r.extended, 1); assert.equal(a().coveredSeconds, 600 + 540, 'tranche suivante = le libre (9 min)');
  assert.equal(a().graceStartsAt.getTime(), t0 + 19 * MIN);
});

test('réserve trop basse : remontée seulement si l\'écart persiste deux passages ; trop haute : baissée tout de suite', async () => {
  W.minutes = 20;
  await G.startGraceCall({ callSid: sid('5'), companyId: C1, path: 'inbound' }); // tient 10
  W.reservedCredits = 4;
  await G.reconcileReserves({});
  assert.equal(W.reservedCredits, 4, 'premier passage : on attend');
  await G.reconcileReserves({});
  assert.equal(W.reservedCredits, 10, 'écart persistant : remontée');
  W.reservedCredits = 15;
  await G.reconcileReserves({});
  assert.equal(W.reservedCredits, 10);
});

test('entrant transféré : débit total = durée secrétaire + durée transférée, une seule fois chacune (jamais sous la clé du parent)', async () => {
  W.minutes = 30; W.chargedCallSids = [];
  const P = sid('6'); const C = sid('7'); const D = sid('8');
  await G.startGraceCall({ callSid: P, companyId: C1, path: 'inbound' });
  // Transfert après 2 min 05 de conversation avec la secrétaire (clôture faite par le contrôleur de transfert).
  await G.endGraceCall(P, { durationSeconds: 125, keys: [C] });
  assert.equal(W.minutes, 27); assert.equal(W.reservedCredits, 0);
  // Jambe navigateur enregistrée par le portail (sid C), jambe transférée (sid D, 4 min 10), journal du parent (sid P) : seul D est débité.
  CALLS = [
    { sid: C, duration: 126, companyId: C1, direction: 'inbound', from: CALLER, to: LINE },
    { sid: D, duration: 250, companyId: C1, direction: 'outbound', to: '+33612345678', from: LINE, source: 'transfer' },
    { sid: P, duration: 400, companyId: C1, direction: 'inbound', from: CALLER, to: LINE },
  ];
  await syncMinutesFromCalls(C1);
  assert.equal(W.minutes, 30 - 3 - 5, 'secrétaire 3 min + transfert 5 min');
  // Le balayeur ne débite plus rien sous la clé du parent (échéance clôturée).
  await G.sweepGraceDeadlines({ client: null, now: Date.now() + 60 * MIN });
  await syncMinutesFromCalls(C1);
  assert.equal(W.minutes, 22);
});

// ---------------------------------------------------------------- relecture avant production : famine du balayeur, prise de coupure

test('famine : 60 appels en grâce sans solde + 1 appel payé en fin de tranche => l\'appel payé est prolongé', async () => {
  const t0 = Date.parse('2026-11-20T14:00:00Z');
  W.minutes = 0; W.reservedCredits = 0;
  for (let i = 0; i < 60; i += 1) await G.startGraceCall({ callSid: `CA${String(i).padStart(32, '0')}`, companyId: C1, path: 'inbound', now: t0 }); // rien de libre : grâce
  W.minutes = 30;
  await G.startGraceCall({ callSid: sid('p'), companyId: C1, path: 'outbound_browser', now: t0 - 9 * MIN }); // tranche de 10 min qui finit à t0 + 1 min
  W.minutes = 20; // le solde libre restant ne suffit qu'à une tranche
  const paid = () => [...DL.rows.values()].find((x) => x.callSid === sid('p'));
  const r = await G.sweepGraceDeadlines({ client: twilio, now: t0 + 30_000 });
  assert.equal(paid().coveredSeconds, 1200, 'prolongé en premier, malgré 60 appels en grâce triés avant lui');
  assert.ok(r.extended >= 1);
});

test('prise de coupure : une prolongation entre la lecture et la prise gagne, l\'appel n\'est pas coupé', async () => {
  const t0 = Date.parse('2026-11-20T15:00:00Z');
  await G.scheduleGraceDeadline({ callSid: sid('q'), companyId: C1, path: 'inbound', coveredSeconds: 60, now: t0 }, { Model: DL }); // coupure à t0 + 6 min
  const orig = DL.findOneAndUpdate;
  let raced = false;
  CallGraceDeadline.findOneAndUpdate = async (f, u, o) => {
    if (!raced && u?.$set?.status === 'hanging') { // une autre instance prolonge l'appel juste avant notre prise
      raced = true;
      const row = [...DL.rows.values()].find((x) => x.callSid === sid('q'));
      row.deadline = new Date(row.deadline.getTime() + 10 * MIN); row.graceStartsAt = new Date(row.graceStartsAt.getTime() + 10 * MIN);
    }
    return orig(f, u, o);
  };
  const r = await G.sweepGraceDeadlines({ client: twilio, now: t0 + 6 * MIN });
  assert.equal(raced, true);
  assert.equal(r.hungUp, 0); assert.equal(twilio.hangups.length, 0);
  assert.equal([...DL.rows.values()].find((x) => x.callSid === sid('q')).status, 'scheduled');
});


// ---------------------------------------------------------------- robustesse du passage : erreur par appel, ordre et rythme

test('prolongation : un appel qui lève une erreur à chaque passage ne bloque pas les suivants', async () => {
  const t0 = Date.parse('2026-11-20T16:00:00Z');
  W.minutes = 0; W.reservedCredits = 0;
  // Appel en erreur, trié en premier (grâce la plus ancienne) : sa société lève à chaque lecture du portefeuille.
  await DL.updateOne({ callSid: sid('r') }, { $setOnInsert: { callSid: sid('r'), companyId: C2, path: 'inbound', startedAt: new Date(t0 - MIN), creditFactor: 1, coveredSeconds: 0, reservedCredits: 0, reservationStatus: 'none', extensible: true, status: 'scheduled', graceStartsAt: new Date(t0 - MIN), deadline: new Date(t0 + 4 * MIN) } }, { upsert: true });
  await G.startGraceCall({ callSid: sid('s'), companyId: C1, path: 'inbound', now: t0 }); // rien de libre : grâce
  W.minutes = 10;
  const realFindOne = MinutesCompany.findOne;
  MinutesCompany.findOne = (f) => { if (String(f?.companyId) === C2) throw new Error('lecture impossible'); return realFindOne(f); };
  for (const dt of [10_000, 20_000]) {
    const r = await G.sweepGraceDeadlines({ client: twilio, now: t0 + dt });
    assert.ok(r.errors >= 1, 'l\'erreur est comptée, pas propagée');
  }
  assert.equal([...DL.rows.values()].find((x) => x.callSid === sid('s')).coveredSeconds, 600, 'l\'appel suivant est prolongé malgré tout');
});

test('rythme : lectures Twilio lentes => les coupures dues passent quand même dans le même passage, lectures 5 par 5', async () => {
  const t0 = Date.parse('2026-11-20T17:00:00Z');
  W.minutes = 100; W.reservedCredits = 0;
  await G.scheduleGraceDeadline({ callSid: sid('t'), companyId: C1, path: 'inbound', coveredSeconds: 0, now: t0 - 6 * MIN }, { Model: DL }); // coupure due
  for (let i = 0; i < 10; i += 1) await G.startGraceCall({ callSid: `CA${String(i + 100).padStart(32, '0')}`, companyId: C1, path: 'outbound_browser', now: t0 - 9 * MIN - 30_000 }); // fin de tranche
  W.minutes = 300; // du solde libre pour une tranche de plus chacun
  const slow = fakeTwilio();
  let inFlight = 0; let peak = 0;
  slow.calls = ((orig) => (id) => ({ ...orig(id), fetch: async () => { inFlight += 1; peak = Math.max(peak, inFlight); await new Promise((res) => setTimeout(res, 300)); inFlight -= 1; return { sid: id, status: 'in-progress' }; } }))(slow.calls);
  const started = Date.now();
  const r = await G.sweepGraceDeadlines({ client: slow, now: t0 });
  assert.equal(r.hungUp, 1); assert.equal(slow.hangups[0].callSid, sid('t'));
  assert.equal(r.extended, 10);
  assert.equal(peak, 5, 'lectures Twilio 5 à la fois');
  assert.ok(Date.now() - started < 1500, `${Date.now() - started} ms (une à une : 3 s)`);
});
