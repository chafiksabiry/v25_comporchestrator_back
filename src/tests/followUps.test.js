// Run: JWT_SECRET=test node src/tests/followUps.test.js
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
const F = await import('../services/followUps.js');
const { syncAppointment, hasCalendarProvider } = await import('../services/calendarSync.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');
const { default: FollowUpItem } = await import('../models/FollowUpItem.js');
const { default: Voicemail } = await import('../models/Voicemail.js');
const { default: SecretariatTools } = await import('../models/SecretariatTools.js');
const { followUpController: ctl } = await import('../controllers/followUpController.js');

const NOW = Date.parse('2026-11-02T10:00:00Z');
const FUTURE = '2026-11-03T09:00:00Z';
const VM = '64b0000000000000000000a1';
const OWNER = { userId: 'owner1', role: 'owner', permissions: {} };
const AGENT = { userId: 'agent1', role: 'agent', permissions: {} };

// --- validation de création
const ok = (b, a = OWNER) => F.validateCreate(b, a, NOW);
assert.match(ok({ model: 'libre' }).error, /inconnu/);
assert.match(ok({ model: 'voicemail_callback' }).error, /répondeur/, 'rappel : part d’un message');
assert.equal(ok({ model: 'voicemail_callback', origin: { type: 'voicemail', id: VM } }).value.assigneeId, 'owner1', 'assigné par défaut : soi');
assert.match(ok({ model: 'voicemail_callback', origin: { type: 'voicemail', id: 'x' } }).error, /invalide/);
assert.match(ok({ model: 'missed_callback', origin: { type: 'voicemail', id: VM } }).error, /date et l’heure du rappel/);
assert.match(ok({ model: 'missed_callback', origin: { type: 'missed_call', id: VM }, dueAt: '2026-11-01T09:00:00Z' }).error, /futur/);
assert.match(ok({ model: 'missed_callback', origin: { type: 'missed_call', id: VM }, dueAt: 'pas une date' }).error, /invalides/);
assert.match(ok({ model: 'missed_callback', origin: { type: 'none' }, dueAt: FUTURE }).error, /appel manqué/);
assert.equal(ok({ model: 'missed_callback', origin: { type: 'missed_call', id: VM }, dueAt: FUTURE }).value.dueAt.toISOString(), '2026-11-03T09:00:00.000Z');
assert.match(ok({ model: 'appointment', dueAt: FUTURE }).error, /personne/);
assert.match(ok({ model: 'appointment', contactName: 'Mme Durand' }).error, /date et l’heure du rendez-vous/);
const rdv = ok({ model: 'appointment', contactName: 'Mme Durand', dueAt: FUTURE, title: '  Visite  ' }).value;
assert.equal(rdv.title, 'Visite'); assert.equal(rdv.durationMinutes, 30);
assert.match(ok({ model: 'appointment', contactName: 'A', dueAt: FUTURE, durationMinutes: 2 }).error, /durée/);
assert.match(ok({ model: 'appointment', contactName: 'A', dueAt: '2031-01-01T00:00:00Z' }).error, /lointaine/);
assert.match(ok({ model: 'transfer' }).error, /autre collaborateur/, 'transfert à soi-même refusé');
assert.equal(ok({ model: 'transfer', assigneeId: 'u2', note: 'Merci de rappeler' }).value.assigneeId, 'u2');
assert.match(ok({ model: 'transfer', assigneeId: 'u2', note: 'x'.repeat(1001) }).error, /1000/);
assert.equal(ok({ model: 'transfer', assigneeId: 'u2' }).value.title, 'À traiter', 'titre par défaut');

// --- modification
const item = { model: 'missed_callback', status: 'todo', assigneeId: 'u2' };
assert.match(F.validatePatch({}, item, NOW).error, /Rien/);
assert.match(F.validatePatch({ status: 'archived' }, item, NOW).error, /Statut/);
assert.deepEqual(F.validatePatch({ status: 'done', note: ' ok ' }, item, NOW).value, { status: 'done', note: 'ok' });
assert.match(F.validatePatch({ dueAt: null }, item, NOW).error, /obligatoires/);
assert.equal(F.validatePatch({ dueAt: null }, { model: 'transfer' }, NOW).value.dueAt, null);
assert.match(F.validatePatch({ title: '  ' }, item, NOW).error, /vide/);

// --- transfert
assert.match(F.validateTransfer({}, item, OWNER).error, /Choisissez/);
assert.match(F.validateTransfer({ assigneeId: 'u2' }, item, OWNER).error, /déjà/);
assert.match(F.validateTransfer({ assigneeId: 'u3' }, { ...item, status: 'done' }, OWNER).error, /à traiter/);
assert.deepEqual(F.validateTransfer({ assigneeId: 'u3', note: ' ok ' }, item, OWNER).value, { assigneeId: 'u3', note: 'ok' });

// --- droits
const member = (calls) => ({ userId: 'm1', role: 'member', permissions: { 'calls.view': calls } });
assert.equal(F.canUse(OWNER), true); assert.equal(F.canUse(AGENT), true);
assert.equal(F.canUse(member(true)), true); assert.equal(F.canUse(member(false)), false);
assert.equal(F.canManage(AGENT), false); assert.equal(F.canManage(member(true)), true);
assert.equal(F.canSeeItem(AGENT, { assigneeId: 'agent1' }), true);
assert.equal(F.canSeeItem(AGENT, { assigneeId: 'autre' }), false, 'un agent ne voit que ce qui lui est confié');
assert.equal(F.canSeeItem(member(true), { assigneeId: 'autre' }), true);
assert.deepEqual(F.allowedPatchFields(AGENT), ['status', 'note']);
assert.equal(F.visibilityFilter(AGENT, 'C').assigneeId, 'agent1');
assert.equal(F.visibilityFilter(OWNER, 'C').assigneeId, undefined);
assert.equal(F.visibilityFilter(OWNER, 'C', { mine: true }).assigneeId, 'owner1');

// --- fuseau horaire du rendez-vous (nom IANA)
const TZ = await import('../services/timeZone.js');
const apptBody = { model: 'appointment', contactName: 'Mme Durand', dueAt: '2026-11-06T09:30:00Z' };
assert.equal(F.validateCreate(apptBody, OWNER, NOW).value.timeZone, null, 'fuseau facultatif : null par défaut');
for (const tz of ['Africa/Casablanca', 'America/New_York', 'Asia/Tokyo', 'Europe/Paris', 'UTC']) {
  assert.equal(F.validateCreate({ ...apptBody, timeZone: tz }, OWNER, NOW).value.timeZone, tz, tz);
  assert.deepEqual(F.validatePatch({ timeZone: tz }, item, NOW).value, { timeZone: tz }, tz);
}
assert.equal(F.validateCreate({ ...apptBody, timeZone: ' europe/paris ' }, OWNER, NOW).value.timeZone, 'Europe/Paris', 'nom canonique');
for (const tz of ['Mars/Olympus', 'Paris', 'GMT+25', '+01:00', 42, {}, 'x'.repeat(200)]) {
  assert.deepEqual(F.validateCreate({ ...apptBody, timeZone: tz }, OWNER, NOW), { error: 'Fuseau horaire inconnu.' }, String(tz));
  assert.deepEqual(F.validatePatch({ timeZone: tz }, item, NOW), { error: 'Fuseau horaire inconnu.' }, String(tz));
}
assert.deepEqual(F.validatePatch({ timeZone: null }, item, NOW).value, { timeZone: null }, 'null efface le fuseau');
assert.deepEqual(F.validatePatch({ timeZone: '' }, item, NOW).value, { timeZone: null });
assert.ok(F.allowedPatchFields(OWNER).includes('timeZone') && !F.allowedPatchFields(AGENT).includes('timeZone'), 'modifiable par ceux qui modifient la date');
assert.equal(F.toItem({ _id: 'i1', model: 'appointment', title: 'x', status: 'todo', timeZone: 'Asia/Tokyo' }).timeZone, 'Asia/Tokyo');
assert.equal(F.toItem({ _id: 'i1', model: 'appointment', title: 'x', status: 'todo' }).timeZone, null, 'ancien élément : null');
// résolution : élément > centre > Paris
assert.equal(TZ.resolveItemTimeZone({ timeZone: 'Asia/Tokyo' }, { timeZone: 'America/New_York' }), 'Asia/Tokyo');
assert.equal(TZ.resolveItemTimeZone({ timeZone: null }, { timeZone: 'America/New_York' }), 'America/New_York');
assert.equal(TZ.resolveItemTimeZone({}, { timeZone: 'America/New_York' }), 'America/New_York');
assert.equal(TZ.resolveItemTimeZone({ timeZone: null }, { timeZone: '' }), 'Europe/Paris');
assert.equal(TZ.resolveItemTimeZone({}, {}), 'Europe/Paris');
assert.equal(TZ.resolveItemTimeZone(undefined, undefined), 'Europe/Paris', 'comportement historique');
assert.equal(TZ.resolveItemTimeZone({ timeZone: 'n’importe quoi' }, { timeZone: 'Asia/Tokyo' }), 'Asia/Tokyo', 'valeur invalide ignorée');

// --- tri : à faire par échéance, sans échéance ensuite, clos en dernier
const sorted = F.sortItems([
  { id: 'a', status: 'done', createdAt: '2026-11-01' }, { id: 'b', status: 'todo', dueAt: null, createdAt: '2026-11-01' },
  { id: 'c', status: 'todo', dueAt: '2026-11-05', createdAt: '2026-10-01' }, { id: 'd', status: 'todo', dueAt: '2026-11-03', createdAt: '2026-10-01' },
]).map((i) => i.id);
assert.deepEqual(sorted, ['d', 'c', 'b', 'a']);

// --- annuaire : seules les personnes avec un compte, dédoublonnées
const dir = F.parseDirectory(
  { data: [{ userId: 'o1', fullName: 'Chef', isOwner: true }, { userId: '', fullName: 'Invitée sans compte' }, { userId: 'm1', email: 'm@x.fr' }] },
  { data: [{ userId: 'a1', fullName: 'Agent Un' }, { userId: 'm1', fullName: 'doublon' }, { userId: 'bad id!' }] }
);
assert.deepEqual(dir.map((p) => [p.id, p.kind]), [['o1', 'owner'], ['m1', 'member'], ['a1', 'agent']]);
assert.equal(F.parseDirectory(null, undefined).length, 0);

// --- agenda externe : rien n'est simulé
assert.equal(hasCalendarProvider(), false);
assert.deepEqual(await syncAppointment({ id: '1' }), { status: 'not_connected', provider: null, externalId: null });

// --- contrôleur (base et service d'inscription simulés)
const tok = jwt.sign({ userId: 'owner1' }, process.env.JWT_SECRET);
const COMPANY = '64b0000000000000000000c1';
let me = { isOwner: true, companyId: COMPANY, permissions: {} };
global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/company-members/me')) return { ok: true, json: async () => ({ data: me }) };
  if (u.includes('/api/company-members?')) return { ok: true, json: async () => ({ data: [{ userId: 'owner1', fullName: 'Chef', isOwner: true }, { userId: 'm2', fullName: 'Membre Deux' }] }) };
  if (u.includes('/call-center/agents')) return { ok: true, json: async () => ({ data: [{ userId: 'agent1', fullName: 'Agent Un' }] }) };
  if (u.includes('/api/users/')) return { ok: true, json: async () => ({ data: { fullName: 'Moi-même' } }) };
  throw new Error(`fetch inattendu ${u}`);
};
SecretariatTools.findOne = () => ({ lean: async () => null }); // réglages du secrétariat : défauts (aucun agenda connecté)
const store = [];
FollowUpItem.create = async (doc) => { const d = { _id: `id${store.length + 1}`, status: 'todo', createdAt: new Date(), transfers: [], ...doc, save: async () => d, toObject() { const { save, toObject, ...rest } = d; return rest; } }; store.push(d); return d; };
FollowUpItem.exists = async (f) => store.some((s) => s.originId === f.originId && s.model === f.model && s.status === 'todo');
FollowUpItem.findOne = async (f) => store.find((s) => String(s._id) === String(f._id)) || null;
FollowUpItem.find = () => ({ sort() { return this; }, limit() { return this; }, lean: async () => store.map((s) => s.toObject()) });
FollowUpItem.countDocuments = async () => 0;
const vmUpdates = [];
Voicemail.findOne = () => ({ select: () => ({ lean: async () => ({ from: '+33612345678', followUpStatus: 'new' }) }) });
Voicemail.updateOne = async (...a) => { vmUpdates.push(a); return {}; };

async function call(fn, { user = 'owner1', body = {}, params = {}, query = {} } = {}) {
  clearCompanyCache();
  return new Promise((resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); return this; } };
    fn({ user: { userId: user }, headers: { authorization: `Bearer ${tok}` }, body, params, query, method: 'POST', originalUrl: '/x' }, res);
  });
}

let r = await call(ctl.create, { body: { companyId: COMPANY, model: 'voicemail_callback', origin: { type: 'voicemail', id: VM } } });
assert.equal(r.code, 201); assert.equal(r.body.data.assignee.name, 'Chef'); assert.equal(r.body.data.contactPhone, '+33612345678');
assert.equal(vmUpdates.length, 1, 'le message passe à « à rappeler »');
r = await call(ctl.create, { body: { companyId: COMPANY, model: 'voicemail_callback', origin: { type: 'voicemail', id: VM } } });
assert.equal(r.code, 409, 'pas de doublon pour un même message');
r = await call(ctl.create, { body: { companyId: COMPANY, model: 'transfer', assigneeId: 'inconnu', title: 'x' } });
assert.equal(r.code, 422, 'assigné hors du centre refusé');
r = await call(ctl.create, { body: { companyId: COMPANY, model: 'transfer', assigneeId: 'm2', note: 'Merci' } });
assert.equal(r.code, 201); assert.equal(r.body.data.assignee.name, 'Membre Deux'); assert.equal(r.body.data.transfers.length, 1);
r = await call(ctl.create, { body: { companyId: COMPANY, model: 'appointment', contactName: 'Mme Durand', dueAt: new Date(Date.now() + 30 * 86400000).toISOString() } });
assert.equal(r.code, 201); assert.equal(r.body.data.calendar.status, 'not_connected');
r = await call(ctl.create, { body: { companyId: '64b0000000000000000000d2', model: 'transfer', assigneeId: 'm2' } });
assert.equal(r.code, 403, 'autre centre refusé');

// un agent ne crée pas, ne transfère pas, ne touche pas ce qui n'est pas à lui
me = { isOwner: false, isAgent: true, companyId: COMPANY, permissions: {} };
r = await call(ctl.create, { user: 'agent1', body: { companyId: COMPANY, model: 'transfer', assigneeId: 'm2' } });
assert.equal(r.code, 403);
r = await call(ctl.patch, { user: 'agent1', params: { id: 'id1' }, body: { status: 'done' } });
assert.equal(r.code, 404, 'élément d’un autre : introuvable pour l’agent');
store[1].assigneeId = 'agent1';
r = await call(ctl.patch, { user: 'agent1', params: { id: '64b0000000000000000000e1' }, body: { status: 'done' } });
assert.equal(r.code, 404, 'identifiant inconnu');
store[1]._id = '64b0000000000000000000e2';
r = await call(ctl.patch, { user: 'agent1', params: { id: '64b0000000000000000000e2' }, body: { title: 'autre' } });
assert.equal(r.code, 403, 'un agent ne retitre pas');
r = await call(ctl.patch, { user: 'agent1', params: { id: '64b0000000000000000000e2' }, body: { status: 'done', note: 'fait' } });
assert.equal(r.code, 200); assert.equal(r.body.data.status, 'done');
r = await call(ctl.transfer, { user: 'agent1', params: { id: '64b0000000000000000000e2' }, body: { assigneeId: 'm2' } });
assert.equal(r.code, 403);
// un membre sans droit sur les appels n'a pas accès
me = { isOwner: false, isAgent: false, companyId: COMPANY, permissions: { 'calls.view': false } };
r = await call(ctl.list, { user: 'm9', query: { companyId: COMPANY } });
assert.equal(r.code, 403);

// un agent employé par plusieurs entreprises travaille sur celle qu'il a choisie, parmi ses emplois (jamais une autre)
const SECOND = '64b0000000000000000000c2';
me = { isOwner: false, isAgent: true, companyId: COMPANY, companyIds: [COMPANY, SECOND], permissions: {} };
r = await call(ctl.list, { user: 'agent1', query: { companyId: SECOND } });
assert.equal(r.code, 200, 'entreprise active choisie parmi ses emplois : acceptée');
r = await call(ctl.list, { user: 'agent1', query: { companyId: COMPANY } });
assert.equal(r.code, 200, 'entreprise par défaut : acceptée');
r = await call(ctl.list, { user: 'agent1', query: { companyId: '64b0000000000000000000d9' } });
assert.equal(r.code, 403, 'entreprise qui n’est pas l’un de ses emplois : refusée');
assert.match(r.body.message, /pas rattaché à cette entreprise/);

// Appel rattaché à un élément : validation
assert.equal(F.validateCallLog({ sid: 'CA1', durationSeconds: 42.4, status: 'completed' }).value.durationSeconds, 42);
assert.equal(F.validateCallLog({}).value.status, 'completed');
assert.ok(F.validateCallLog({ status: 'pirate' }).error);
assert.ok(F.validateCallLog({ durationSeconds: -1 }).error);
assert.ok(F.validateCallLog({ durationSeconds: 99999 }).error);
assert.deepEqual(F.toItem({ _id: 'a'.repeat(24), calls: [{ sid: 'CA1', at: NOW, durationSeconds: 5, status: 'completed', byId: 'u1', byName: 'Léa' }] }).calls, [{ sid: 'CA1', at: NOW, durationSeconds: 5, status: 'completed', by: { id: 'u1', name: 'Léa' } }]);
assert.deepEqual(F.toItem({ _id: 'a'.repeat(24) }).calls, []);

console.log('followUps: ok');
