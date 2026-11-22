// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/zeroBalanceInbound.test.js
// Règle du fondateur : à solde nul, les appels entrants passent sur une réserve UNIQUE de 5 minutes, gratuite, remise à neuf à la recharge ;
// notification « rechargez vos minutes pour continuer à recevoir les appels » au passage à 0 puis quand la réserve est épuisée (une fois
// chacune). Base, forfait, notifications et client Twilio SIMULÉS (aucun appel, aucun e-mail réel). Même banc que minutesGrace.test.js.
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
const Z = await import('../services/zeroBalanceInbound.js');
const { default: ZeroBalanceReserve } = await import('../models/ZeroBalanceReserve.js');
const { default: CompanyNotification } = await import('../models/CompanyNotification.js');
const { startInboundTest, clearInboundTests } = await import('../services/inboundTestService.js');

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
    if (k === 'childSids') return v && typeof v === 'object' && '$in' in v ? (row.childSids || []).some((x) => v.$in.includes(x)) : (row.childSids || []).includes(v);
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

/** Réserve en mémoire (même contrat que la collection : findOne, findOneAndUpdate conditionnel, updateOne upsert, find). */
function memoryReserve() {
  const docs = new Map();
  let n = 0;
  const val = (d, k) => d[k];
  const ok = (d, f) => Object.entries(f).every(([k, v]) => {
    const cur = val(d, k);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      return Object.entries(v).every(([op, x]) => {
        if (op === '$ne') return cur !== x;
        if (op === '$gte') return (cur ?? 0) >= x;
        if (op === '$gt') return (cur ?? 0) > x;
        if (op === '$lte') return (cur ?? 0) <= x;
        if (op === '$in') return x.includes(cur ?? null);
        return false;
      });
    }
    if (v === null) return cur == null;
    return String(cur) === String(v);
  });
  const apply = (d, u) => {
    Object.assign(d, u.$set || {});
    for (const [k, v] of Object.entries(u.$inc || {})) d[k] = (d[k] || 0) + v;
  };
  const q = (v) => ({ lean: async () => clone(v), select() { return this; }, sort() { return this; }, limit() { return this; }, then(r, j) { return Promise.resolve(clone(v)).then(r, j); } });
  return {
    docs,
    findOne(f) { return q([...docs.values()].find((d) => ok(d, f)) || null); },
    find(f) { return q([...docs.values()].filter((d) => ok(d, f))); },
    async findOneAndUpdate(f, u) { await Promise.resolve(); const d = [...docs.values()].find((x) => ok(x, f)); if (!d) return null; apply(d, u); return clone(d); },
    async updateOne(f, u, o = {}) {
      await Promise.resolve();
      const d = [...docs.values()].find((x) => ok(x, f));
      if (!d) {
        if (!o.upsert) return { modifiedCount: 0 };
        if ([...docs.values()].some((x) => String(x.companyId) === String(f.companyId))) { const e = new Error('dup'); e.code = 11000; throw e; }
        const doc = { _id: `z${++n}`, episode: '', usedSeconds: 0, heldSeconds: 0, ...(u.$setOnInsert || {}) };
        apply(doc, { $set: u.$set }); docs.set(doc._id, doc); return { upsertedCount: 1, modifiedCount: 0 };
      }
      if (u.$setOnInsert && !u.$set && !u.$inc) return { modifiedCount: 0 };
      apply(d, u); return { modifiedCount: 1 };
    },
  };
}

let R; let NOTES;
const savedNotif = CompanyNotification.findOneAndUpdate;
beforeEach(() => {
  W.purchasedMinutes = 0; W.planMinutesGranted = 0;
  Z.setZeroReserveDbReady(() => true);
  R = memoryReserve();
  for (const k of ['findOne', 'find', 'findOneAndUpdate', 'updateOne']) ZeroBalanceReserve[k] = R[k];
  // Notification du portail (CompanyNotification, clé unique par entreprise) : simulée, rien n'est envoyé.
  NOTES = new Map();
  CompanyNotification.findOneAndUpdate = (f, u) => {
    const key = `${f.companyId}|${f.key}`;
    if (!NOTES.has(key)) NOTES.set(key, { companyId: String(f.companyId), ...u.$setOnInsert });
    return lean(NOTES.get(key));
  };
  clearInboundTests();
});
after(() => { Z.setZeroReserveDbReady(null); CompanyNotification.findOneAndUpdate = savedNotif; });

const flush = () => new Promise((r) => setTimeout(r, 20));
const reserve = () => [...R.docs.values()][0] || null;
const rowOf = (callSid) => [...DL.rows.values()].find((r) => r.callSid === callSid);
const notes = (event) => [...NOTES.values()].filter((x) => String(x.key).startsWith(`minutes-zero-inbound-${event}-`));
const dialResult = (callSid, { status = 'completed', duration, dialSid = '' } = {}) => hit('handleTwilioInboundDialResult', { body: { CallSid: callSid, DialCallStatus: status, DialCallDuration: duration === undefined ? undefined : String(duration), DialCallSid: dialSid } });
const T0 = Date.parse('2026-11-22T10:00:00Z');
const MIN = 60_000;

// ---------------------------------------------------------------- textes

test('textes : 4 langues (anglais par défaut), lien de recharge, aucun prix ni promotion', () => {
  for (const lang of ['fr', 'en', 'es', 'ar']) for (const ev of ['open', 'exhausted']) {
    const t = Z.ZERO_TEXTS[lang][ev];
    assert.ok(t.title && t.message, `${lang}/${ev}`);
    assert.doesNotMatch(`${t.title} ${t.message}`, /[€$£%]|promo|offre|offer|oferta|gratuit|free|gratis/i, `${lang}/${ev} : ni prix ni promotion`);
  }
  assert.equal(Z.zeroLanguage('de'), 'en'); assert.equal(Z.zeroLanguage(''), 'en'); assert.equal(Z.zeroLanguage('AR'), 'ar');
  const n = Z.zeroNotice({ event: 'open', episode: 'e1', language: 'xx' });
  assert.deepEqual(n, { key: 'minutes-zero-inbound-open-e1', kind: 'minutes', title: Z.ZERO_TEXTS.en.open.title, message: Z.ZERO_TEXTS.en.open.message, actionPath: '/app/billing' });
  assert.match(Z.ZERO_TEXTS.fr.open.message, /Rechargez vos minutes pour continuer à recevoir les appels/);
});

// ---------------------------------------------------------------- réserve

test('solde 0 : l\'appel entrant SONNE sur la réserve (tranche de 60 s, timeLimit = 300 s), notification « open » une seule fois', async () => {
  W.minutes = 0;
  const xml = await inbound(sid('1'));
  assert.match(xml, /<Client>/, 'personne ne sonnait avant : désormais la réserve laisse sonner');
  assert.equal(timeLimit(xml), 300, 'filet de Twilio : la réserve libre à l\'arrivée');
  const row = rowOf(sid('1'));
  assert.equal(row.zeroReserve, true); assert.equal(row.path, 'inbound_zero'); assert.equal(row.zeroStatus, 'held'); assert.equal(row.zeroAllottedSeconds, 60);
  assert.equal(row.reservationStatus, 'none', 'rien n\'est réservé sur le solde'); assert.equal(row.extensible, false, 'jamais prolongée par la grâce B.1');
  assert.equal(reserve().heldSeconds, 60);
  assert.ok(W.chargedCallSids.includes(sid('1')), 'clé inscrite sans débit (une synchronisation ne la débitera jamais)');
  await inbound(sid('2'));
  assert.equal(notes('open').length, 1, 'dédoublonnage : une seule notification par épisode');
  assert.equal(notes('open')[0].actionPath, '/app/billing');
  assert.equal(notes('open')[0].title, Z.ZERO_TEXTS.en.open.title, 'langue du titulaire inconnue : anglais');
  assert.equal(W.minutes, 0, 'le solde ne bouge pas');
});

test('partage ATOMIQUE : 6 appels simultanés, 5 tranches de 60 s au plus (300 s), le 6e va au répondeur', async () => {
  W.minutes = 0;
  const out = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map((c) => Z.startZeroCall({ callSid: sid(c), companyId: C1, now: T0 })));
  const granted = out.filter(Boolean);
  assert.equal(granted.length, 5);
  assert.equal(granted.reduce((s, g) => s + g.allottedSeconds, 0), 300);
  assert.equal(reserve().heldSeconds, 300, 'jamais plus que la réserve');
  assert.equal(Z.remainingOf(reserve()), 0);
  assert.equal(notes('exhausted').length, 1, 'réserve épuisée notifiée une fois');
  assert.equal(notes('open').length, 1, 'ouverture simultanée : un seul épisode, une seule notification');
  assert.equal(reserve().episodes, 1);
  assert.equal([...DL.rows.values()].filter((r) => r.zeroStatus === 'held').length, 5, 'le perdant ne tient rien (répondeur)');
});

test('tranches suivantes par le balayeur puis COUPURE quand la réserve est consommée (mécanisme de la grâce : échéance + API Twilio)', async () => {
  W.minutes = 0;
  await Z.startZeroCall({ callSid: sid('1'), companyId: C1, now: T0 });
  let t = T0;
  // Toutes les 10 s, comme le balayeur ; le compte rendu de fin n'arrive pas (appel en cours).
  for (let i = 0; i < 40; i += 1) { t += 10_000; await G.sweepGraceDeadlines({ client: twilio, now: t }); }
  const row = rowOf(sid('1'));
  assert.equal(row.zeroAllottedSeconds, 300, 'les 5 minutes, tranche par tranche');
  assert.equal(row.zeroFinal, true);
  assert.equal(twilio.hangups.length, 1, 'coupé une fois');
  assert.equal(twilio.hangups[0].callSid, sid('1'));
  assert.equal(row.status, 'hung_up');
  assert.ok(Math.abs(new Date(row.hungUpAt).getTime() - (T0 + 300_000)) <= 10_000, 'coupure à la fin des 5 minutes (au passage suivant du balayeur)');
  assert.equal(notes('exhausted').length, 1);
  assert.equal(W.minutes, 0); assert.equal(W.graceWaivedMinutes ?? 0, 0, 'rien de facturé, rien de « gracié » au titre de B.1');
});

test('deux appels simultanés : ils se partagent les 300 s (aucun dépassement), coupés tous les deux', async () => {
  W.minutes = 0;
  await Z.startZeroCall({ callSid: sid('1'), companyId: C1, now: T0 });
  await Z.startZeroCall({ callSid: sid('2'), companyId: C1, now: T0 });
  let t = T0;
  for (let i = 0; i < 30; i += 1) { t += 10_000; await G.sweepGraceDeadlines({ client: twilio, now: t }); }
  const a = rowOf(sid('1')); const b = rowOf(sid('2'));
  assert.equal(a.zeroAllottedSeconds + b.zeroAllottedSeconds, 300);
  assert.equal(twilio.hangups.length, 2);
});

test('fin d\'appel : durée décrochée consignée, part rendue, jamais débitée, solde jamais sous zéro', async () => {
  W.minutes = 0;
  await inbound(sid('1'));
  await dialResult(sid('1'), { duration: 42, dialSid: 'CAleg1' });
  const row = rowOf(sid('1'));
  assert.equal(row.zeroStatus, 'released'); assert.equal(row.zeroUsedSeconds, 42);
  assert.equal(reserve().heldSeconds, 0); assert.equal(reserve().usedSeconds, 42); assert.equal(reserve().totalFreeSeconds, 42);
  assert.equal(W.minutes, 0); assert.equal(W.consumedSeconds, 0, 'rien de consommé au sens de la facturation');
  assert.ok(W.chargedCallSids.includes('CAleg1'), 'jambe décrochée inscrite sans débit');
  // Compte rendu rejoué : idempotent.
  await dialResult(sid('1'), { duration: 42, dialSid: 'CAleg1' });
  assert.equal(reserve().usedSeconds, 42);
  assert.equal(Z.remainingOf(reserve()), 258);
});

test('réserve épuisée : comportement actuel (répondeur, personne ne sonne), notification « exhausted » une seule fois', async () => {
  W.minutes = 0;
  await Z.startZeroCall({ callSid: sid('1'), companyId: C1, now: T0 });
  await Z.endZeroCall(rowOf(sid('1')), 300);
  assert.equal(reserve().usedSeconds, 60, 'au plus la part tenue');
  for (const c of ['2', '3', '4', '5']) { await Z.startZeroCall({ callSid: sid(c), companyId: C1 }); await Z.endZeroCall(rowOf(sid(c)), 60); }
  assert.equal(reserve().usedSeconds, 300);
  assert.equal(notes('exhausted').length, 1);
  const xml = await inbound(sid('6'));
  assert.doesNotMatch(xml, /<Client>/, 'répondeur');
  assert.match(xml, /<Record|<Say|<Play/, 'le répondeur reste accessible');
  await inbound(sid('7'));
  assert.equal(notes('exhausted').length, 1, 'pas de spam');
  assert.equal(notes('open').length, 1);
});

test('aucun conseiller à faire sonner : l\'appel gratuit va au répondeur et rend sa part', async () => {
  W.minutes = 0;
  const xml = await hit('handleTwilioInboundCall', { body: { To: LINE, From: CALLER, CallSid: sid('1') } }); // personne de présent
  assert.doesNotMatch(xml, /<Client>/);
  assert.equal(reserve().heldSeconds, 0, 'part rendue');
  assert.equal(rowOf(sid('1')).status, 'ended');
  // Message laissé : compte rendu du répondeur sans effet sur la réserve.
  await hit('handleTwilioVoicemailDone', { body: { CallSid: sid('1'), To: LINE } });
  assert.equal(reserve().usedSeconds, 0);
});

test('appel gratuit non décroché puis répondeur : rien de consommé', async () => {
  W.minutes = 0;
  await inbound(sid('1'));
  await dialResult(sid('1'), { status: 'no-answer' });
  assert.equal(reserve().usedSeconds, 0); assert.equal(reserve().heldSeconds, 0);
  assert.equal(rowOf(sid('1')).status, 'ended', 'plus rien à couper pendant le message');
});

test('remise à neuf à la RECHARGE : appels payants comme avant, puis nouveau passage à 0 = nouvelle réserve de 5 min et nouvelle notification', async () => {
  W.minutes = 0;
  for (const c of ['1', '2', '3', '4', '5']) { await Z.startZeroCall({ callSid: sid(c), companyId: C1 }); await Z.endZeroCall(rowOf(sid(c)), 60); }
  assert.equal(Z.remainingOf(reserve()), 0);
  // Recharge de 3 minutes : appel entrant payant (grâce B.1 inchangée).
  W.minutes = 3; W.purchasedMinutes = 3;
  const xml = await inbound(sid('6'));
  assert.match(xml, /<Client>/);
  assert.equal(rowOf(sid('6')).path, 'inbound'); assert.equal(rowOf(sid('6')).zeroReserve ?? false, false);
  // Débit qui ramène le solde à 0 : passage à 0, épisode remis à neuf.
  await G.debitMinutesClamped({ companyId: C1, keys: ['CApaid'], cost: 3, seconds: 170 });
  await flush();
  assert.equal(W.minutes, 0);
  assert.equal(reserve().usedSeconds, 0, 'réserve remise à neuf');
  assert.equal(notes('open').length, 2, 'nouvel épisode, nouvelle notification');
  assert.ok(await Z.startZeroCall({ callSid: sid('7'), companyId: C1 }), 'l\'appel suivant sonne de nouveau');
});

test('remise à neuf constatée à l\'appel suivant même sans passage à 0 observé (recharge consommée entre-temps)', async () => {
  W.minutes = 0;
  for (const c of ['1', '2', '3', '4', '5']) { await Z.startZeroCall({ callSid: sid(c), companyId: C1 }); await Z.endZeroCall(rowOf(sid(c)), 60); }
  W.planMinutesGranted = 120; // octroi de la période, déjà consommé
  assert.ok(await Z.startZeroCall({ callSid: sid('6'), companyId: C1 }));
  assert.equal(reserve().heldSeconds, 60); assert.equal(reserve().usedSeconds, 0);
});

test('synchronisation des appels après une recharge : la jambe d\'un appel gratuit n\'est JAMAIS débitée', async () => {
  W.minutes = 0;
  await inbound(sid('1'));
  DL.rows.forEach((r) => { if (r.callSid === sid('1')) r.childSids = ['CAchild1']; });
  W.minutes = 50; W.purchasedMinutes = 50;
  CALLS = [{ sid: 'CAchild1', duration: 120, direction: 'inbound', companyId: C1 }, { sid: 'CApaid2', duration: 61, direction: 'inbound', companyId: C1 }];
  await syncMinutesFromCalls(C1);
  assert.equal(W.minutes, 48, 'seul l\'appel payant est débité (2 min)');
  assert.ok(W.chargedCallSids.includes('CAchild1'));
});

test('vue du portail pendant l\'appel : pas de « grâce de 5 min » annoncée, seulement la dernière minute', async () => {
  W.minutes = 0;
  await Z.startZeroCall({ callSid: sid('1'), companyId: C1, now: T0 });
  const v1 = G.graceView(rowOf(sid('1')), T0 + 10_000);
  assert.equal(v1.inGrace, false); assert.equal(v1.zeroReserve, true);
  DL.rows.forEach((r) => { r.zeroFinal = true; });
  const v2 = G.graceView(rowOf(sid('1')), T0 + 10_000);
  assert.equal(new Date(v2.deadline) - new Date(v2.graceStartsAt), 60_000, 'dernière tranche : avertissement « plus qu\'une minute » seulement');
  assert.equal(v2.inGrace, true);
  assert.equal(await G.remainingLimitFor(sid('1'), { now: T0 + 30_000 }), 270, 'timeLimit des <Dial> suivants (menu, mobile) : réserve libre à l\'arrivée');
});

test('filet : appel gratuit dont le compte rendu s\'est perdu, clôturé 2 min après l\'échéance avec la durée Twilio', async () => {
  W.minutes = 0;
  await Z.startZeroCall({ callSid: sid('1'), companyId: C1, now: T0 });
  DL.rows.forEach((r) => { r.zeroFinal = true; });
  const client = { calls: (s) => ({ update: async () => ({}), fetch: async () => ({ sid: s, status: 'completed', duration: '35' }) }) };
  await G.sweepGraceDeadlines({ client, now: T0 + 60_000 + 2 * MIN + 1000 });
  assert.equal(rowOf(sid('1')).zeroStatus, 'released');
  assert.equal(reserve().usedSeconds, 35); assert.equal(reserve().heldSeconds, 0);
});

test('lecture du solde : état de la réserve pour le bandeau ; langue du titulaire relevée et utilisée pour les notifications', async () => {
  W.minutes = 0;
  const get = async (lang) => { let out; const res = { status(c) { this.code = c; return this; }, json(b) { out = b; return this; } }; await minutesCompanyController.getMinutes({ params: { companyId: C1 }, query: lang ? { lang } : {}, user: { userId: 'own1' }, headers: { authorization: 'Bearer tok' } }, res); return out; };
  let b = await get('fr');
  assert.deepEqual(b.data.zeroBalanceInbound, { reserveSeconds: 300, remainingSeconds: 300, exhausted: false });
  await flush();
  assert.equal(reserve().ownerLanguage, 'fr');
  await Z.startZeroCall({ callSid: sid('1'), companyId: C1 });
  assert.equal(notes('open')[0].title, Z.ZERO_TEXTS.fr.open.title, 'langue de l\'interface du titulaire');
  await Z.endZeroCall(rowOf(sid('1')), 50);
  b = await get();
  assert.equal(b.data.zeroBalanceInbound.remainingSeconds, 250);
  W.minutes = 20;
  b = await get();
  assert.equal(b.data.zeroBalanceInbound, undefined, 'solde disponible : rien');
});

// ---------------------------------------------------------------- aucune régression

test('inchangé : test de ligne à solde 0 (validé, aucune réserve touchée)', async () => {
  W.minutes = 0;
  startInboundTest(LINE);
  const xml = await hit('handleTwilioInboundCall', { body: { To: LINE, From: CALLER, CallSid: sid('1') } });
  assert.doesNotMatch(xml, /<Dial/);
  assert.equal(R.docs.size, 0); assert.equal(DL.rows.size, 0);
});

test('inchangé : appel sortant à solde 0 refusé ; appel entrant payant suit la grâce B.1 ; base de réserve absente = répondeur', async () => {
  W.minutes = 0;
  const xml = await outbound(sid('1'));
  assert.doesNotMatch(xml, /<Dial/); assert.equal(DL.rows.size, 0); assert.equal(R.docs.size, 0);
  W.minutes = 10;
  const paid = await inbound(sid('2'));
  assert.equal(timeLimit(paid), 900); assert.equal(rowOf(sid('2')).path, 'inbound'); assert.equal(R.docs.size, 0);
  W.minutes = 0; Z.setZeroReserveDbReady(() => false);
  const vm = await inbound(sid('3'));
  assert.doesNotMatch(vm, /<Client>/, 'sans base de réserve : comportement d\'avant');
});
