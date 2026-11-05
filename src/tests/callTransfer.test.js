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
const { callTransferController: ctl, transferResult, setTransferDeps } = await import('../controllers/callTransferController.js');

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
  [SID_CHILD]: { to: 'client:cc-sec1', status: 'in-progress', parentCallSid: SID_PARENT, startTime: new Date(Date.parse('2026-11-02T09:00:08+01:00')) },
  [SID_OTHER_CHILD]: { to: 'client:cc-sec2', status: 'in-progress', parentCallSid: SID_PARENT },
  [`CA${'6'.repeat(32)}`]: { to: 'client:cc-other', status: 'in-progress', parentCallSid: SID_FOREIGN_PARENT },
  [SID_ENDED]: { to: 'client:cc-sec1', status: 'completed', parentCallSid: SID_PARENT },
};
const updates = [];
let failUpdate = false;
const client = { calls: (sid) => ({ fetch: async () => { if (!legs[sid]) throw new Error('404'); return legs[sid]; }, update: async (p) => { if (failUpdate) throw new Error('twilio down'); updates.push({ sid, ...p }); return {}; } }) };
setTransferDeps({ twilio: async () => client, minutes: async () => 30, now: () => NOW });

let calls = [];
const resetCalls = () => { calls = [
  { _id: 'k1', companyId: C1, callSid: SID_PARENT, phoneNumber: '+33140000000', from: '+33655555555', startedAt: new Date(Date.parse('2026-11-02T09:00:00+01:00')), status: 'ringing', waitSeconds: null, transfer: { startedAt: null } },
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
assert.match(updates[0].twiml, /timeLimit="1800"/); assert.match(updates[0].twiml, /callerId="\+33140000000"/);
assert.match(updates[0].twiml, /transfer-result\?s=/);
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
assert.deepEqual(Object.keys(r.body.data.transfers[0]).sort(), ['at', 'byName', 'byUserId', 'callId', 'callSid', 'from', 'mode', 'result', 'resultLabel', 'toEntryId', 'toName'].sort());
assert.equal(r.body.data.transfers[0].byName, 'Léa');
assert.equal((await call(ctl.list, { user: 'other' })).body.data.transfers.length, 0);
assert.equal((await call(ctl.list, { user: 'mgrNo' })).code, 403);

console.log('callTransfer.test.js : OK');
