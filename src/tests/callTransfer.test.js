// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_AUTH_TOKEN=tok node src/tests/callTransfer.test.js
// Transfert d'un appel en cours : logique pure + contrôleur. Twilio, base et service d'inscription simulés : aucun appel ni e-mail réel.
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.TWILIO_AUTH_TOKEN = 'tok';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
const T = await import('../services/callTransfer.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');
const { default: InboundCall } = await import('../models/InboundCall.js');
const { default: InboundSettings } = await import('../models/InboundSettings.js');
const { default: ReceptionDirectory } = await import('../models/ReceptionDirectory.js');
const { default: SecretariatTools } = await import('../models/SecretariatTools.js');
const { callTransferController: ctl, transferResult, setTransferDeps, elapsedCredits } = await import('../controllers/callTransferController.js');

// ---------------------------------------------------------------- disponibilité
const hours = [{ day: 1, start: '09:00', end: '12:00' }, { day: 1, start: '14:00', end: '18:00' }];
const mon = (hhmm) => Date.parse(`2026-11-02T${hhmm}:00+01:00`); // lundi 2 nov. 2026 (heure de Paris)
const e = { name: 'Mme Martin', userId: 'u1', hours };
assert.equal(T.entryAvailability(e, [], mon('10:00')).state, 'available');
assert.equal(T.entryAvailability(e, [], mon('13:00')).state, 'later');
assert.match(T.entryAvailability(e, [], mon('13:00')).label, /14 h/);
assert.equal(T.entryAvailability(e, [], mon('19:00')).state, 'off');
assert.equal(T.entryAvailability(e, [], Date.parse('2026-11-03T10:00:00+01:00')).state, 'off', 'pas de plage le mardi');
assert.equal(T.entryAvailability({ name: 'X', hours: [] }, [], mon('10:00')).state, 'unknown');
const abs = [{ userId: 'u1', kind: 'leave', startDate: '2026-11-01', endDate: '2026-11-06' }];
const ab = T.entryAvailability(e, abs, mon('10:00'));
assert.equal(ab.state, 'absent'); assert.match(ab.label, /06\/11\/2026/);
assert.equal(T.isReachableNow(T.entryAvailability(e, [], mon('10:00'))), true);
assert.equal(T.isReachableNow(T.entryAvailability(e, [], mon('13:00'))), false, 'plus tard = hors horaires');
assert.equal(T.isReachableNow(ab), false);
assert.equal(T.isReachableNow({ state: 'unknown' }), true);
assert.equal(T.entryAvailability(e, [], Date.parse('2026-11-02T23:30:00Z')).state, 'off', 'fuseau de la société (mardi 00h30 à Paris)');

// ---------------------------------------------------------------- jeton d'état
const st = { secret: 's3', companyId: 'c1', callSid: `CA${'a'.repeat(32)}`, entryId: 'e1', userId: 'u1' };
const tok = T.signTransferState({ ...st, now: 1000 });
assert.deepEqual(T.verifyTransferState({ secret: 's3', token: tok, now: 2000 }), { companyId: 'c1', callSid: st.callSid, entryId: 'e1', userId: 'u1' });
assert.equal(T.verifyTransferState({ secret: 'autre', token: tok, now: 2000 }), null);
assert.equal(T.verifyTransferState({ secret: 's3', token: tok, now: 1000 + T.TRANSFER_STATE_TTL_MS + 1 }), null, 'périmé');
assert.equal(T.verifyTransferState({ secret: 's3', token: `${tok.split('.')[0]}x.${tok.split('.')[1]}`, now: 2000 }), null, 'altéré');
assert.equal(T.verifyTransferState({ secret: 's3', token: '', now: 2000 }), null);

// ---------------------------------------------------------------- TwiML
const x = T.buildTransferTwiml({ name: 'Mme <Martin>', number: '+33612345678', extension: '204', callerId: '+33140000000', resultUrl: 'https://h/api?s=a.b', maxSeconds: 600.7 });
assert.match(x, /Je vous passe Mme &lt;Martin&gt;, ne quittez pas\./); assert.match(x, /<Number sendDigits="wwww204">\+33612345678<\/Number>/);
assert.match(x, /timeLimit="600"/); assert.match(x, /callerId="\+33140000000"/); assert.match(x, /action="https:\/\/h\/api\?s=a\.b"/);
assert.ok(!/sendDigits/.test(T.buildTransferTwiml({ name: 'A', number: '+33612345678', extension: '', resultUrl: 'u' })));
assert.ok(!/sendDigits/.test(T.buildTransferTwiml({ name: 'A', number: '+33612345678', extension: '1"><x', resultUrl: 'u' })), 'poste non numérique ignoré');
const args = { name: 'Mme Martin', settings: { voicemailEnabled: true }, baseUrl: 'https://h', companyId: 'c1' };
assert.match(T.buildTransferResultTwiml({ ...args, dialStatus: 'no-answer' }), /ne peut pas vous répondre[\s\S]*<Record /);
assert.match(T.buildTransferResultTwiml({ ...args, dialStatus: 'busy' }), /<Record /);
assert.match(T.buildTransferResultTwiml({ ...args, dialStatus: 'completed' }), /<Hangup\/>/);
assert.ok(!/<Record/.test(T.buildTransferResultTwiml({ ...args, dialStatus: 'canceled' })));
assert.ok(!/<Record/.test(T.buildTransferResultTwiml({ ...args, settings: { voicemailEnabled: false }, dialStatus: 'no-answer' })), 'sans répondeur : on raccroche poliment');
assert.deepEqual(['completed', 'busy', 'no-answer', 'failed', 'canceled', ''].map(T.resultOfDial), ['answered', 'busy', 'no_answer', 'failed', 'caller_hung_up', 'no_answer']);
for (const w of ['centre d’appels', 'call centre', 'siège']) assert.ok(!(T.announceText('X') + T.unavailableText('X')).toLowerCase().includes(w), w);

// ---------------------------------------------------------------- jambe navigateur en cours
assert.equal(elapsedCredits({ startTime: new Date(1000), now: 1000 + 61000 }), 2, 'minute entamée');
assert.equal(elapsedCredits({ startTime: new Date(1000), now: 1000 + 60000, factor: 3 }), 3);
assert.equal(elapsedCredits({ startTime: null, now: 5000 }), 0, 'début inconnu');
assert.equal(elapsedCredits({ startTime: new Date(9000), now: 5000 }), 0, 'horloge décalée');

// ---------------------------------------------------------------- contrôleur
const C1 = '64b0000000000000000000c1'; const C2 = '64b0000000000000000000c2';
const E_ONE = '64b000000000000000001001'; const E_ABS = '64b000000000000000001002'; const E_NONUM = '64b000000000000000001003'; const E_FOREIGN = '64b000000000000000001004'; const E_OTHER = '64b000000000000000001005';
const people = { sec1: { isOwner: false, isAgent: true, companyId: C1 }, sec2: { isOwner: false, isAgent: true, companyId: C1 }, mgrNo: { isOwner: false, companyId: C1, permissions: {} },
  owner1: { isOwner: true, companyId: C1 }, other: { isOwner: true, companyId: C2 } };
global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/company-members/me')) return { ok: true, json: async () => ({ data: people[new URL(u).searchParams.get('userId')] || {} }) };
  if (u.includes('/api/users/')) return { ok: true, json: async () => ({ data: { fullName: 'Léa', email: 'lea@x.fr' } }) };
  throw new Error(`fetch inattendu ${u}`);
};
SecretariatTools.findOne = () => ({ lean: async () => ({ timeZone: 'Europe/Paris' }) });
const lean = (v) => ({ lean: async () => v, select() { return this; }, sort() { return this; }, limit() { return this; } });
const NOW = mon('10:00');
ReceptionDirectory.findOne = (f) => lean(String(f.companyId) === C1 ? {
  companyId: C1, absences: [{ userId: 'uabs', kind: 'leave', startDate: '2026-11-01', endDate: '2026-11-09' }],
  entries: [
    { _id: E_ONE, name: 'Mme Martin', userId: 'u1', phone: '+33612345678', extension: '204', hours },
    { _id: E_ABS, name: 'M. Roux', userId: 'uabs', phone: '+33699999999', hours },
    { _id: E_NONUM, name: 'Service technique', phone: '' },
    { _id: E_FOREIGN, name: 'M. Smith', phone: '+442079460958' },
  ],
} : { companyId: C2, entries: [{ _id: E_OTHER, name: 'Autre société', phone: '+33611111111' }], absences: [] });
InboundSettings.findOne = () => lean({ voicemailEnabled: true, voice: 'nova' });

const SID_CHILD = `CA${'1'.repeat(32)}`; const SID_PARENT = `CA${'2'.repeat(32)}`; const SID_OTHER_CHILD = `CA${'3'.repeat(32)}`; const SID_FOREIGN_PARENT = `CA${'4'.repeat(32)}`; const SID_ENDED = `CA${'5'.repeat(32)}`;
const legs = {
  [SID_CHILD]: { to: 'client:cc-sec1', status: 'in-progress', parentCallSid: SID_PARENT, startTime: new Date(Date.parse('2026-11-02T09:55:08+01:00')) },
  [SID_OTHER_CHILD]: { to: 'client:cc-sec2', status: 'in-progress', parentCallSid: SID_PARENT },
  [`CA${'6'.repeat(32)}`]: { to: 'client:cc-other', status: 'in-progress', parentCallSid: SID_FOREIGN_PARENT },
  [SID_ENDED]: { to: 'client:cc-sec1', status: 'completed', parentCallSid: SID_PARENT },
};
const updates = [];
let failUpdate = false;
const client = { calls: (sid) => ({ fetch: async () => { if (!legs[sid]) throw new Error('404'); return legs[sid]; }, update: async (p) => { if (failUpdate) throw new Error('twilio down'); updates.push({ sid, ...p }); return {}; } }) };
setTransferDeps({ twilio: async () => client, minutes: async () => 30, creditFactor: async () => 1, now: () => NOW });

let calls = [];
const resetCalls = () => { calls = [
  { _id: 'k1', companyId: C1, callSid: SID_PARENT, phoneNumber: '+33140000000', from: '+33655555555', startedAt: new Date(Date.parse('2026-11-02T09:55:00+01:00')), status: 'ringing', waitSeconds: null, transfer: { startedAt: null } },
  { _id: 'k2', companyId: C2, callSid: SID_FOREIGN_PARENT, phoneNumber: '+33150000000', from: '+33644444444', startedAt: new Date(), status: 'ringing', transfer: { startedAt: null } },
]; };
resetCalls();
const matches = (c, f) => Object.entries(f).every(([k, v]) => {
  if (k === '$set') return true;
  const val = k.split('.').reduce((o, p) => o?.[p], c);
  if (v && typeof v === 'object' && '$ne' in v) return val !== v.$ne;
  return String(val) === String(v) || (v === null && (val === null || val === undefined));
});
InboundCall.findOne = (f) => lean(calls.find((c) => matches(c, f)) || null);
InboundCall.updateOne = async (f, upd) => { const c = calls.find((x) => matches(x, f)); if (!c) return { modifiedCount: 0 }; for (const [k, v] of Object.entries(upd.$set)) { const p = k.split('.'); const last = p.pop(); const o = p.reduce((a, q) => (a[q] = a[q] || {}), c); o[last] = v; } return { modifiedCount: 1 }; };
InboundCall.findOneAndUpdate = (f, upd) => { const c = calls.find((x) => matches(x, f)); if (c) for (const [k, v] of Object.entries(upd.$set)) { const p = k.split('.'); const last = p.pop(); const o = p.reduce((a, q) => (a[q] = a[q] || {}), c); o[last] = v; } return lean(c ? structuredClone(c) : null); };
InboundCall.find = (f) => lean(calls.filter((c) => String(c.companyId) === String(f.companyId) && c.transfer?.startedAt));

async function call(fn, { user = 'sec1', body = {}, query = {} } = {}) {
  clearCompanyCache();
  const tok = jwt.sign({ userId: user }, process.env.JWT_SECRET);
  return new Promise((resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); return this; } };
    fn({ user: { userId: user }, headers: { authorization: `Bearer ${tok}` }, body, query, get: () => 'orch.test' }, res);
  });
}

// refus : droits, appel, fiche
let r = await call(ctl.transfer, { user: 'mgrNo', body: { callSid: SID_CHILD, entryId: E_ONE } });
assert.equal(r.code, 403, 'responsable sans le droit d’appels');
assert.equal((await call(ctl.transfer, { body: { callSid: 'CAx', entryId: E_ONE } })).code, 400);
assert.equal((await call(ctl.transfer, { body: { callSid: SID_CHILD, entryId: 'nope' } })).code, 400);

assert.equal((await call(ctl.transfer, { body: { callSid: SID_CHILD, entryId: E_OTHER } })).code, 404, 'fiche d’une autre société');
assert.equal((await call(ctl.transfer, { user: 'other', body: { callSid: SID_CHILD, entryId: E_OTHER } })).code, 403, 'jambe adressée à une autre personne');
assert.equal((await call(ctl.transfer, { user: 'sec2', body: { callSid: SID_CHILD, entryId: E_ONE } })).code, 403, 'décroché par une autre secrétaire');
assert.equal((await call(ctl.transfer, { body: { callSid: `CA${'9'.repeat(32)}`, entryId: E_ONE } })).code, 404, 'appel inconnu de Twilio');
assert.equal((await call(ctl.transfer, { body: { callSid: SID_ENDED, entryId: E_ONE } })).code, 409, 'appel terminé');
assert.equal((await call(ctl.transfer, { user: 'other', body: { callSid: `CA${'6'.repeat(32)}`, entryId: E_OTHER } })).code, 200, 'contrôle : la société C2 transfère son propre appel');
assert.equal(updates.length, 1); updates.length = 0; resetCalls();
// l'appel d'une société ne peut pas être transféré par une secrétaire d'une autre (jambe forgée vers cc-sec1 mais appel de C2)
legs[`CA${'7'.repeat(32)}`] = { to: 'client:cc-sec1', status: 'in-progress', parentCallSid: SID_FOREIGN_PARENT };
r = await call(ctl.transfer, { body: { callSid: `CA${'7'.repeat(32)}`, entryId: E_ONE } });
assert.equal(r.code, 403, 'appel d’une autre société'); assert.equal(updates.length, 0);
assert.equal((await call(ctl.transfer, { user: 'sec1', query: { companyId: C2 }, body: { callSid: SID_CHILD, entryId: E_ONE } })).code, 403, 'société non rattachée');

// fiche sans numéro, destination non autorisée
r = await call(ctl.transfer, { body: { callSid: SID_CHILD, entryId: E_NONUM } });
assert.equal(r.code, 422); assert.equal(r.body.error, 'no_number');
r = await call(ctl.transfer, { body: { callSid: SID_CHILD, entryId: E_FOREIGN, force: true } });
assert.equal(r.code, 422); assert.equal(r.body.error, 'destination_not_allowed');

// personne absente : confirmation demandée, rien n'est envoyé à Twilio
r = await call(ctl.transfer, { body: { callSid: SID_CHILD, entryId: E_ABS } });
assert.equal(r.code, 409); assert.equal(r.body.error, 'unavailable'); assert.equal(r.body.availability.state, 'absent'); assert.equal(updates.length, 0);
assert.equal(calls[0].transfer.startedAt, null, 'rien n’est consigné');

// solde épuisé
setTransferDeps({ minutes: async () => 0 });
assert.equal((await call(ctl.transfer, { body: { callSid: SID_CHILD, entryId: E_ONE } })).code, 402);
setTransferDeps({ minutes: async () => 30 });

// destination internationale à 4 crédits la minute : solde insuffisant pour une minute internationale => refus clair avec le coefficient
setTransferDeps({ minutes: async () => 3, creditFactor: async () => 4 });
r = await call(ctl.transfer, { body: { callSid: SID_CHILD, entryId: E_ONE } });
assert.equal(r.code, 402); assert.equal(r.body.code, 'no_minutes'); assert.equal(r.body.creditsPerMinute, 4); assert.match(r.body.message, /1 minute = 4 crédits/); assert.match(r.body.messageEn, /1 minute = 4 credits/); assert.match(r.body.messageEs, /1 minuto = 4 créditos/);
assert.equal(calls[0].transfer.startedAt, null, 'rien n’est consigné');
setTransferDeps({ minutes: async () => 30, creditFactor: async () => 1 });

// échec du fournisseur : l'appel reste à la secrétaire, rien de consigné
failUpdate = true;
r = await call(ctl.transfer, { body: { callSid: SID_CHILD, entryId: E_ONE } });
assert.equal(r.code, 502); assert.equal(calls[0].transfer.startedAt, null);
failUpdate = false;

// transfert réussi vers la fiche (numéro relu en base)
r = await call(ctl.transfer, { body: { callSid: SID_CHILD, entryId: E_ONE, to: '+33100000000', phone: '+33100000000' } });
assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.data.result, 'ringing'); assert.equal(r.body.data.name, 'Mme Martin');
assert.equal(updates.length, 1); assert.equal(updates[0].sid, SID_PARENT, 'la jambe de l’appelant est mise à jour, pas celle du navigateur');
assert.match(updates[0].twiml, /Je vous passe Mme Martin/); assert.match(updates[0].twiml, /\+33612345678/); assert.ok(!updates[0].twiml.includes('+33100000000'), 'jamais un numéro envoyé par le navigateur');
// solde 30 min, jambe navigateur en cours depuis 4 min 52 s (5 minutes entamées, pas encore enregistrée) : 25 min disponibles
assert.match(updates[0].twiml, /timeLimit="1500"/); assert.match(updates[0].twiml, /callerId="\+33140000000"/);
assert.match(updates[0].twiml, /transfer-result\?s=/);
{ const s0 = new URL(updates[0].twiml.match(/action="([^"]+)"/)[1].replace(/&amp;/g, '&')).searchParams.get('s'); const v = T.verifyTransferState({ secret: 'tok', token: s0, now: NOW }); assert.equal(v.to, '+33612345678', 'numéro composé signé pour le débit'); assert.equal(v.factor, 1); }
const t0 = calls[0].transfer;
assert.equal(t0.byUserId, 'sec1'); assert.equal(t0.byName, 'Léa'); assert.equal(t0.entryName, 'Mme Martin'); assert.equal(t0.result, 'ringing');
assert.equal(calls[0].status, 'answered'); assert.equal(calls[0].answeredBy, 'cc-sec1'); assert.equal(calls[0].waitSeconds, 8);
// un seul transfert par appel
assert.equal((await call(ctl.transfer, { body: { callSid: SID_CHILD, entryId: E_ONE } })).code, 409); assert.equal(updates.length, 1);

// webhook de fin de sonnerie : jeton obligatoire
const state = new URL(updates[0].twiml.match(/action="([^"]+)"/)[1].replace(/&amp;/g, '&')).searchParams.get('s');
const hook = (q, body) => new Promise((resolve) => { const res = { type() { return this; }, status() { return this; }, send: (x) => resolve(x) }; transferResult({ query: q, body, get: () => 'orch.test' }, res); });
assert.match(await hook({}, { CallSid: SID_PARENT, DialCallStatus: 'no-answer' }), /<Hangup\/>/, 'sans jeton : rien n’est consigné ni proposé');
assert.equal(calls[0].transfer.result, 'ringing');
assert.match(await hook({ s: state }, { CallSid: `CA${'8'.repeat(32)}`, DialCallStatus: 'no-answer' }), /<Hangup\/>/, 'jeton d’un autre appel');
const noAnswer = await hook({ s: state }, { CallSid: SID_PARENT, DialCallStatus: 'no-answer' });
assert.match(noAnswer, /Mme Martin ne peut pas vous répondre/); assert.match(noAnswer, /<Record /);
assert.equal(calls[0].transfer.result, 'no_answer'); assert.ok(calls[0].transfer.endedAt);
assert.match(await hook({ s: state }, { CallSid: SID_PARENT, DialCallStatus: 'completed', DialCallDuration: '42' }), /<Hangup\/>/);
assert.equal(calls[0].transfer.result, 'answered');

// message proposé directement (personne absente) : pas de numéro composé
resetCalls(); updates.length = 0;
r = await call(ctl.transfer, { body: { callSid: SID_CHILD, entryId: E_ABS, mode: 'message' } });
assert.equal(r.code, 200); assert.equal(r.body.data.result, 'message_offered');
assert.ok(!/<Dial/.test(updates[0].twiml) && /<Record /.test(updates[0].twiml) && /M\. Roux ne peut pas vous répondre/.test(updates[0].twiml));
assert.equal(calls[0].transfer.mode, 'message');

// passage en force vers une personne absente
resetCalls(); updates.length = 0;
r = await call(ctl.transfer, { body: { callSid: SID_CHILD, entryId: E_ABS, force: true } });
assert.equal(r.code, 200); assert.match(updates[0].twiml, /<Dial/);

// journal des transferts : isolé par société, sans numéro
r = await call(ctl.list, { user: 'owner1' });
assert.equal(r.code, 200); assert.equal(r.body.data.transfers.length, 1);
assert.deepEqual(Object.keys(r.body.data.transfers[0]).sort(), ['at', 'byName', 'byUserId', 'callId', 'callSid', 'from', 'mode', 'result', 'resultLabel', 'resultLabelEn', 'toEntryId', 'toName'].sort()); // resultLabelEn : champ additif (3e-1)
assert.equal(r.body.data.transfers[0].byName, 'Léa');
assert.equal((await call(ctl.list, { user: 'other' })).body.data.transfers.length, 0);
assert.equal((await call(ctl.list, { user: 'mgrNo' })).code, 403);

// ---------------------------------------------------------------- appel SORTANT du navigateur (poste de l'agent de centre d'appels)
// La jambe navigateur est le parent (from = identité de l'agent) ; la jambe du prospect (enfant) est redirigée vers la fiche.
const SID_OUT = `CA${'a'.repeat(32)}`; const SID_OUT_CHILD = `CA${'b'.repeat(32)}`; const SID_OUT_FOREIGN = `CA${'c'.repeat(32)}`; const SID_OUT_FOREIGN_CHILD = `CA${'d'.repeat(32)}`;
const SID_OUT_ALONE = `CA${'e'.repeat(32)}`;
legs[SID_OUT] = { from: 'client:cc-sec1', to: null, status: 'in-progress', parentCallSid: null };
legs[SID_OUT_FOREIGN] = { from: 'client:cc-sec1', to: null, status: 'in-progress', parentCallSid: null };
legs[SID_OUT_ALONE] = { from: 'client:cc-sec1', to: null, status: 'in-progress', parentCallSid: null };
const children = { [SID_OUT]: [{ sid: SID_OUT_CHILD, from: '+33140000000', to: '+33677777777', status: 'in-progress' }], [SID_OUT_FOREIGN]: [{ sid: SID_OUT_FOREIGN_CHILD, from: '+33150000000', to: '+33677777777', status: 'in-progress' }], [SID_OUT_ALONE]: [] };
const listCalls = [];
client.calls.list = async (q) => { listCalls.push(q); return children[q.parentCallSid] || []; };
const lines = { [C1]: ['+33140000000'], [C2]: ['+33150000000'] };
// Ligne de la société : seules les lignes ACTIVES comptent (filtre lu sur la requête réelle).
const { PhoneNumber } = await import('../models/PhoneNumber.js');
const { default: OutboundTransfer } = await import('../models/OutboundTransfer.js');
const existsFilters = [];
PhoneNumber.exists = async (f) => { existsFilters.push(f); return f.status === 'active' && (lines[String(f.companyId)] || []).includes(f.phoneNumber) ? { _id: 'p' } : null; };
const locks = new Map(); const leaseMoves = [];
OutboundTransfer.create = async (doc) => { if (locks.has(doc.callSid)) { const e = new Error('dup'); e.code = 11000; throw e; } locks.set(doc.callSid, { ...doc }); return doc; };
OutboundTransfer.deleteOne = async (f) => { locks.delete(f.callSid); return {}; };
OutboundTransfer.findOneAndUpdate = (f, upd) => { const row = locks.get(f.callSid); if (row && row.entryId === f.entryId) Object.assign(row, upd.$set); return lean(row ? { ...row } : null); };
const { transferDeps } = await import('../controllers/callTransferController.js');
const realMoveLease = transferDeps.moveLease;
const released = [];
setTransferDeps({ moveLease: async (a, b) => { leaseMoves.push([a, b]); return { moved: 1 }; }, releaseLine: async (sid) => { released.push(sid); return { released: 1 }; } });
resetCalls(); updates.length = 0;

r = await call(ctl.transfer, { user: 'sec2', body: { callSid: SID_OUT, entryId: E_ONE } });
assert.equal(r.code, 403, 'jambe sortante d’une autre personne'); assert.equal(updates.length, 0);
r = await call(ctl.transfer, { body: { callSid: SID_OUT_FOREIGN, entryId: E_ONE } });
assert.equal(r.code, 403, 'appel sortant depuis une ligne d’une autre société'); assert.equal(updates.length, 0);
r = await call(ctl.transfer, { body: { callSid: SID_OUT_ALONE, entryId: E_ONE } });
assert.equal(r.code, 409, 'correspondant pas encore en ligne'); assert.equal(updates.length, 0);
r = await call(ctl.transfer, { body: { callSid: SID_OUT, entryId: E_ABS } });
assert.equal(r.code, 409); assert.equal(r.body.error, 'unavailable'); assert.equal(updates.length, 0);
r = await call(ctl.transfer, { body: { callSid: SID_OUT, entryId: E_ONE, to: '+33100000000' } });
assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.data.name, 'Mme Martin');
assert.deepEqual(listCalls.at(-1), { parentCallSid: SID_OUT, status: 'in-progress', limit: 1 });
assert.equal(updates.length, 1); assert.equal(updates[0].sid, SID_OUT_CHILD, 'la jambe du prospect est redirigée, pas celle du navigateur');
assert.match(updates[0].twiml, /\+33612345678/); assert.match(updates[0].twiml, /callerId="\+33140000000"/); assert.ok(!updates[0].twiml.includes('+33100000000'));
// les deux jambes (correspondant + fiche) sont débitées : le plafond partage le solde (30 min / 2 crédits par minute = 15 min)
assert.match(updates[0].twiml, /timeLimit="900"/);
assert.ok(calls.every((c) => !c.transfer?.startedAt), 'aucun appel entrant consigné pour un appel sortant');
assert.deepEqual(existsFilters.at(-1), { companyId: existsFilters.at(-1).companyId, phoneNumber: '+33140000000', status: 'active' }, 'ligne active exigée');
// une ligne = un appel : le bail passe à la jambe du prospect, libérée par son statusCallback signé (pas par l'action du <Dial> du navigateur)
assert.deepEqual(leaseMoves.at(-1), [SID_OUT, SID_OUT_CHILD]);
assert.match(updates[0].statusCallback, /\/api\/phone-numbers\/webhooks\/twilio\/line-call-end\?t=[a-f0-9]{64}$/);
const { verifyLineCallEnd } = await import('../services/lineCalls.js');
assert.ok(verifyLineCallEnd({ secret: 'tok', callSid: SID_OUT_CHILD, token: new URL(updates[0].statusCallback).searchParams.get('t') }), 'jeton lié à la jambe du prospect');
// verrou : une seule redirection de la jambe du prospect
assert.equal(locks.get(SID_OUT_CHILD).byUserId, 'sec1');
r = await call(ctl.transfer, { body: { callSid: SID_OUT, entryId: E_ONE } });
assert.equal(r.code, 409, 'deuxième redirection de la même jambe'); assert.equal(updates.length, 1);
const outState = new URL(updates[0].twiml.match(/action="([^"]+)"/)[1].replace(/&amp;/g, '&')).searchParams.get('s');
assert.match(await hook({ s: outState }, { CallSid: SID_OUT_CHILD, DialCallStatus: 'no-answer' }), /<Record /, 'sans réponse : message proposé au correspondant');
assert.equal(locks.get(SID_OUT_CHILD).result, 'no_answer', 'résultat consigné sur le verrou sortant');
// échec du fournisseur : verrou levé et bail rendu à la jambe navigateur
// Statuts lus chez Twilio après l'échec (séquence par jambe ; 'throw' = lecture impossible). La 1re lecture du navigateur est celle
// du contrôle d'entrée (in-progress).
const seq = {};
const baseCalls = client.calls;
client.calls = Object.assign((sid) => { const b = baseCalls(sid); return { ...b, fetch: async () => { const q = seq[sid]; if (q && q.length) { const v = q.shift(); if (v === 'throw') throw new Error('lecture impossible'); return { ...(legs[sid] || {}), status: v }; } return b.fetch(); } }; }, { list: baseCalls.list });
const failCase = async (browserSeq, childSeq) => {
  locks.clear(); updates.length = 0; leaseMoves.length = 0; released.length = 0; failUpdate = true;
  seq[SID_OUT] = ['in-progress', ...browserSeq]; seq[SID_OUT_CHILD] = [...childSeq];
  const res = await call(ctl.transfer, { body: { callSid: SID_OUT, entryId: E_ONE } });
  failUpdate = false;
  assert.equal(res.code, 502); assert.equal(locks.size, 0, 'verrou levé');
  return { moves: leaseMoves.slice(), freed: released.slice() };
};
let fc = await failCase(['in-progress', 'in-progress'], []);
assert.deepEqual(fc.moves, [[SID_OUT, SID_OUT_CHILD], [SID_OUT_CHILD, SID_OUT]], 'navigateur en cours : bail rendu'); assert.deepEqual(fc.freed, [], 'rien libéré');
fc = await failCase(['in-progress', 'completed'], []);
assert.deepEqual(fc.moves, [[SID_OUT, SID_OUT_CHILD], [SID_OUT_CHILD, SID_OUT]]); assert.deepEqual(fc.freed, [SID_OUT], 'navigateur terminé entre-temps : ligne libérée');
fc = await failCase(['completed'], ['completed']);
assert.deepEqual(fc.moves, [[SID_OUT, SID_OUT_CHILD]]); assert.deepEqual(fc.freed, [SID_OUT_CHILD], 'les deux terminés : ligne libérée');
fc = await failCase(['completed'], ['in-progress']);
assert.deepEqual(fc.moves, [[SID_OUT, SID_OUT_CHILD]]); assert.deepEqual(fc.freed, [], 'correspondant en cours : bail laissé au correspondant');
fc = await failCase(['throw', 'throw'], []);
assert.deepEqual(fc.moves, [[SID_OUT, SID_OUT_CHILD], [SID_OUT_CHILD, SID_OUT]], 'état inconnu : bail rendu au navigateur'); assert.deepEqual(fc.freed, []);
client.calls = baseCalls;
const { ENDED } = await import('../services/lineCalls.js');
assert.deepEqual(ENDED, ['completed', 'failed', 'busy', 'no-answer', 'canceled']);
const ttl = OutboundTransfer.schema.path('startedAt').options.expires; assert.equal(ttl, 24 * 60 * 60, 'index TTL de 24 h');
assert.ok(OutboundTransfer.schema.indexes().some(([f, o]) => f.startedAt === 1 && o.expireAfterSeconds === 86400), 'index TTL déclaré');
// le déplacement réel du bail : emplacement par emplacement, idempotent
const moves = [];
const { transferLease } = await import('../services/lineCalls.js');
const out = await transferLease(SID_OUT, SID_OUT_CHILD, { Model: { updateMany: async (f, u) => { moves.push([f, u]); return { modifiedCount: Object.keys(f)[0].startsWith('activeCall.') ? 1 : 0 }; } } });
assert.equal(out.moved, 1); assert.equal(moves.length, 10); assert.deepEqual(moves[0], [{ 'activeCall.callSid': SID_OUT }, { $set: { 'activeCall.callSid': SID_OUT_CHILD } }]);
assert.equal(typeof realMoveLease, 'function');
// jambe navigateur sortante en cours depuis 10 min (déjà 10 crédits) : (30 − 10) / 2 jambes = 10 min ; vers l'international à 3 crédits
// avec un correspondant à 3 crédits : (30 − 10 × 3) = 0 -> refus
updates.length = 0; locks.clear(); legs[SID_OUT].startTime = new Date(NOW - 10 * 60000);
r = await call(ctl.transfer, { body: { callSid: SID_OUT, entryId: E_ONE } });
assert.equal(r.code, 200); assert.match(updates[0].twiml, /timeLimit="600"/);
updates.length = 0; locks.clear(); setTransferDeps({ creditFactor: async () => 3 });
r = await call(ctl.transfer, { body: { callSid: SID_OUT, entryId: E_ONE } });
assert.equal(r.code, 402, 'solde déjà consommé par la jambe en cours'); assert.equal(updates.length, 0);
setTransferDeps({ creditFactor: async () => 1 }); delete legs[SID_OUT].startTime;
// solde épuisé : refus, rien n'est redirigé
updates.length = 0; locks.clear(); setTransferDeps({ minutes: async () => 0 });
assert.equal((await call(ctl.transfer, { body: { callSid: SID_OUT, entryId: E_ONE } })).code, 402); assert.equal(updates.length, 0);
setTransferDeps({ minutes: async () => 30 });

console.log('callTransfer.test.js : OK');
