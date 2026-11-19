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
const { Subscription } = await import('../models/Subscription.js');

// Offre de chaque société (forfait de l'abonnement) : Accueil par défaut ; `offers[companyId]` la remplace. Chaque lecture est notée.
const tierPlan = (tier) => ({ _id: `plan-${tier}`, name: tier, metadata: { harx_product: 'callcenter', callcenter_tier: tier } });
const offers = {};
const offerLookups = [];
Subscription.findOne = (f) => { offerLookups.push(String(f.companyId)); return { populate: async () => ({ planId: tierPlan(offers[String(f.companyId)] || 'accueil') }) }; };

const NOW = Date.parse('2026-11-02T10:00:00Z');
const FUTURE_REAL = () => new Date(Date.now() + 2 * 86400000).toISOString();
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
assert.equal(ok({ model: 'appointment', contactName: 'Mme Durand', dueAt: FUTURE, location: '  12 rue de la Paix, Paris ' }).value.location, '12 rue de la Paix, Paris', 'lieu du rendez-vous');
assert.equal(ok({ model: 'appointment', contactName: 'Mme Durand', dueAt: FUTURE }).value.location, '', 'lieu facultatif');
assert.match(ok({ model: 'appointment', contactName: 'Mme Durand', dueAt: FUTURE, location: 'x'.repeat(301) }).error, /300/);
assert.equal(ok({ model: 'transfer', assigneeId: 'u2', location: 'ailleurs' }).value.location, '', 'le lieu ne concerne que les rendez-vous');

// --- modification
const item = { model: 'missed_callback', status: 'todo', assigneeId: 'u2' };
assert.match(F.validatePatch({}, item, NOW).error, /Rien/);
assert.match(F.validatePatch({ status: 'archived' }, item, NOW).error, /Statut/);
assert.deepEqual(F.validatePatch({ status: 'done', note: ' ok ' }, item, NOW).value, { status: 'done', note: 'ok' });
assert.match(F.validatePatch({ dueAt: null }, item, NOW).error, /obligatoires/);
assert.equal(F.validatePatch({ dueAt: null }, { model: 'transfer' }, NOW).value.dueAt, null);
assert.equal(F.validatePatch({ location: ' Salle B ' }, { model: 'appointment', status: 'todo' }, NOW).value.location, 'Salle B');
assert.match(F.validatePatch({ location: 'Salle B' }, { model: 'transfer', status: 'todo' }, NOW).error, /rendez-vous/);
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
const { default: ReceptionDirectory } = await import('../models/ReceptionDirectory.js');
ReceptionDirectory.findOne = () => ({ lean: async () => null }); // annuaire d'accueil vide : une secrétaire ne confie qu'à elle-même
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
r = await call(ctl.create, { user: 'agent1', body: { companyId: COMPANY, model: 'missed_callback', origin: { type: 'missed_call', id: VM }, dueAt: FUTURE_REAL(), assigneeId: 'm2' } });
assert.equal(r.code, 422, 'une secrétaire confie seulement à une personne de l’annuaire (ou à elle-même)');
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

// --- une secrétaire crée rappels, rendez-vous et demandes / tâches, toujours pour la société active (jamais une autre, jamais de mélange)
{
  const A = COMPANY, B = SECOND, C = '64b0000000000000000000d9';
  const { default: InboundCall } = await import('../models/InboundCall.js');
  const origins = [];
  // Origines (message vocal, appel manqué) : chacune n'existe que dans SA société.
  const VM_A = '64b0000000000000000000a2', VM_B = '64b0000000000000000000b2', MISSED_A = '64b0000000000000000000a3';
  const own = { [VM_A]: A, [VM_B]: B, [MISSED_A]: A };
  const lookup = (f) => { origins.push([String(f._id), String(f.companyId)]); return own[String(f._id)] === String(f.companyId) ? { from: '+33600000000', followUpStatus: 'new' } : null; };
  Voicemail.findOne = (f) => ({ select: () => ({ lean: async () => lookup(f) }) });
  InboundCall.findOne = (f) => ({ select: () => ({ lean: async () => lookup(f) }) });
  // Annuaire de chaque société : la secrétaire s'y trouve (« Moi ») ; personne d'autre n'est requis.
  me = { isOwner: false, isAgent: true, companyId: A, companyIds: [A, B], permissions: {} };
  const before = store.length;
  const made = async (companyId, body) => call(ctl.create, { user: 'agent1', body: { ...(companyId ? { companyId } : {}), ...body } });

  // création pour A depuis A → A
  r = await made(A, { model: 'appointment', contactName: 'Mme Durand', dueAt: FUTURE_REAL() });
  assert.equal(r.code, 201, 'rendez-vous de la secrétaire'); assert.equal(String(store.at(-1).companyId), A, 'rendez-vous enregistré dans A');
  r = await made(A, { model: 'voicemail_callback', origin: { type: 'voicemail', id: VM_A } });
  assert.equal(r.code, 201, 'rappel d’un message vocal par la secrétaire'); assert.equal(String(store.at(-1).companyId), A);
  assert.equal(store.at(-1).assigneeId, 'agent1', 'confié à elle-même par défaut');
  r = await made(A, { model: 'missed_callback', origin: { type: 'missed_call', id: MISSED_A }, dueAt: FUTURE_REAL() });
  assert.equal(r.code, 201, 'rappel planifié par la secrétaire'); assert.equal(String(store.at(-1).companyId), A);
  r = await made(undefined, { model: 'appointment', contactName: 'M. Sans société', dueAt: FUTURE_REAL() });
  assert.equal(r.code, 201); assert.equal(String(store.at(-1).companyId), A, 'sans société précisée : sa société par défaut, jamais une autre');

  // création pour B depuis B → B ; une origine de A n'est pas trouvée depuis B (et inversement) : pas de mélange
  r = await made(B, { model: 'appointment', contactName: 'Mme B', dueAt: FUTURE_REAL() });
  assert.equal(r.code, 201); assert.equal(String(store.at(-1).companyId), B, 'rendez-vous enregistré dans B');
  r = await made(B, { model: 'voicemail_callback', origin: { type: 'voicemail', id: VM_B } });
  assert.equal(r.code, 201); assert.equal(String(store.at(-1).companyId), B);
  const count = store.length;
  r = await made(B, { model: 'missed_callback', origin: { type: 'missed_call', id: MISSED_A }, dueAt: FUTURE_REAL() });
  assert.equal(r.code, 404, 'appel manqué de A introuvable depuis B'); assert.equal(store.length, count, 'rien créé');
  r = await made(A, { model: 'voicemail_callback', origin: { type: 'voicemail', id: VM_B } });
  assert.equal(r.code, 404, 'message de B introuvable depuis A'); assert.equal(store.length, count, 'rien créé');
  assert.ok(origins.every(([, c]) => c === A || c === B), 'origines cherchées dans A ou B seulement');

  // pour C (pas l'un de ses emplois) → 403, rien créé, rien cherché
  const looked = origins.length;
  r = await made(C, { model: 'voicemail_callback', origin: { type: 'voicemail', id: VM_A } });
  assert.equal(r.code, 403, 'société non autorisée refusée'); assert.match(r.body.message, /pas rattaché à cette entreprise/);
  r = await made(C, { model: 'appointment', contactName: 'X', dueAt: FUTURE_REAL() });
  assert.equal(r.code, 403);
  assert.equal(store.length, count, 'rien créé pour C'); assert.equal(origins.length, looked, 'aucune lecture dans C');
  assert.equal(store.slice(before).filter((s) => String(s.companyId) === A).length, 4);
  assert.equal(store.slice(before).filter((s) => String(s.companyId) === B).length, 2);

  // elle ne réassigne toujours pas un élément existant
  r = await call(ctl.transfer, { user: 'agent1', params: { id: String(store.at(-1)._id) }, body: { companyId: B, assigneeId: 'm2' } });
  assert.equal(r.code, 403, 'réassigner reste réservé au titulaire et aux membres');

  // liste : seulement les éléments de la société demandée (filtre transmis à la base)
  const filters = [];
  FollowUpItem.find = (f) => { filters.push(f); return { sort() { return this; }, limit() { return this; }, lean: async () => store.filter((s) => String(s.companyId) === String(f.companyId) && (!f.assigneeId || s.assigneeId === f.assigneeId)).map((s) => s.toObject()) }; };
  r = await call(ctl.list, { user: 'agent1', query: { companyId: B } });
  assert.equal(r.code, 200);
  assert.ok(filters.length && filters.every((f) => String(f.companyId) === B), 'liste lue dans B seulement');

  // appels manqués de la ligne commune : visibles par la secrétaire, pour la société active seulement
  const missedFilters = [];
  InboundCall.find = (f) => { missedFilters.push(f); return { sort() { return this; }, limit() { return this; }, select() { return this; }, lean: async () => [] }; };
  FollowUpItem.find = (f) => { missedFilters.push(f); return { select() { return this; }, lean: async () => [] }; };
  r = await call(ctl.missedCalls, { user: 'agent1', query: { companyId: B } });
  assert.equal(r.code, 200, 'appels manqués de la ligne : lisibles par la secrétaire');
  assert.ok(missedFilters.length && missedFilters.every((f) => String(f.companyId) === B), 'appels manqués lus dans B seulement');
  r = await call(ctl.missedCalls, { user: 'agent1', query: { companyId: C } });
  assert.equal(r.code, 403, 'appels manqués d’une société non autorisée : refusé');
}

// --- décision du 19/11 : appels manqués réservés à l'offre Accueil. Un agent Call Centre crée rappels et tâches, mais ne lit pas
// les appels manqués (un appel entrant y est pris par un agent en ligne ou perdu). Titulaire et membres : inchangé.
{
  const A = COMPANY, B = SECOND, C = '64b0000000000000000000d9';
  const { default: InboundCall } = await import('../models/InboundCall.js');
  const VM_B = '64b0000000000000000000b4', MISSED_B = '64b0000000000000000000b5', MISSED_A = '64b0000000000000000000a5';
  const own = { [VM_B]: B, [MISSED_B]: B, [MISSED_A]: A };
  const missedReads = [];
  const lookup = (f) => (own[String(f._id)] === String(f.companyId) ? { from: '+33611111111', followUpStatus: 'new' } : null);
  Voicemail.findOne = (f) => ({ select: () => ({ lean: async () => lookup(f) }) });
  InboundCall.findOne = (f) => { missedReads.push(String(f.companyId)); return { select: () => ({ lean: async () => lookup(f) }) }; };
  InboundCall.find = (f) => { missedReads.push(String(f.companyId)); return { sort() { return this; }, limit() { return this; }, select() { return this; }, lean: async () => [{ _id: MISSED_B, from: '+33611111111', phoneNumber: '+33100000000', startedAt: new Date(), status: 'no-answer' }] }; };
  FollowUpItem.find = () => ({ select() { return this; }, lean: async () => [] });
  FollowUpItem.exists = async () => false;
  // A : Accueil (secrétaires) ; B : Call Centre Full Scope ; l'agent est employé par les deux.
  offers[A] = 'accueil'; offers[B] = 'full_scope';
  me = { isOwner: false, isAgent: true, companyId: A, companyIds: [A, B], permissions: {} };

  // secrétaire Accueil : lit les appels manqués de A
  r = await call(ctl.missedCalls, { user: 'agent1', query: { companyId: A } });
  assert.equal(r.code, 200, 'secrétaire de l’offre Accueil : appels manqués lisibles');
  assert.equal(offerLookups.at(-1), A, 'offre lue pour la société active');

  // agent Call Centre (B) : 403 sur les appels manqués, rien lu
  offerLookups.length = 0; missedReads.length = 0;
  r = await call(ctl.missedCalls, { user: 'agent1', query: { companyId: B } });
  assert.equal(r.code, 403, 'agent Call Centre : appels manqués refusés');
  assert.equal(r.body.code, 'MISSED_CALLS_RECEPTION_ONLY');
  assert.deepEqual(offerLookups, [B], 'offre lue pour la société active, jamais une autre');
  assert.equal(missedReads.length, 0, 'aucun appel manqué lu');
  for (const tier of ['multi_clients', 'nomad_solo']) {
    offers[B] = tier;
    assert.equal((await call(ctl.missedCalls, { user: 'agent1', query: { companyId: B } })).code, 403, `agent ${tier} : refusé`);
  }
  offers[B] = 'full_scope';

  // agent Call Centre : rappel d'un appel manqué refusé (il lirait l'appel), rien créé ni lu
  const count = store.length;
  r = await call(ctl.create, { user: 'agent1', body: { companyId: B, model: 'missed_callback', origin: { type: 'missed_call', id: MISSED_B }, dueAt: FUTURE_REAL() } });
  assert.equal(r.code, 403, 'agent Call Centre : rappel d’un appel manqué refusé'); assert.equal(r.body.code, 'MISSED_CALLS_RECEPTION_ONLY');
  assert.equal(store.length, count, 'rien créé'); assert.equal(missedReads.length, 0, 'appel manqué non lu');

  // … mais il crée toujours des rappels (message vocal), des tâches et des rendez-vous, dans la société active
  r = await call(ctl.create, { user: 'agent1', body: { companyId: B, model: 'voicemail_callback', origin: { type: 'voicemail', id: VM_B } } });
  assert.equal(r.code, 201, 'agent Call Centre : rappel d’un message vocal'); assert.equal(String(store.at(-1).companyId), B);
  r = await call(ctl.create, { user: 'agent1', body: { companyId: B, model: 'transfer', title: 'Rappeler M. Martin', assigneeId: 'agent1' } });
  assert.equal(r.code, 400, 'tâche à soi-même : refusée comme avant (validation inchangée)');
  ReceptionDirectory.findOne = (f) => ({ lean: async () => (String(f.companyId) === B ? { entries: [{ userId: 'm2', name: 'Membre Deux', kind: 'member' }] } : null) });
  r = await call(ctl.create, { user: 'agent1', body: { companyId: B, model: 'transfer', title: 'Rappeler M. Martin', assigneeId: 'm2' } });
  assert.equal(r.code, 201, 'agent Call Centre : demande / tâche'); assert.equal(String(store.at(-1).companyId), B);
  r = await call(ctl.create, { user: 'agent1', body: { companyId: B, model: 'appointment', contactName: 'M. Martin', dueAt: FUTURE_REAL() } });
  assert.equal(r.code, 201, 'agent Call Centre : rendez-vous'); assert.equal(String(store.at(-1).companyId), B);
  ReceptionDirectory.findOne = () => ({ lean: async () => null });

  // la même personne, sur A (Accueil), planifie le rappel d'un appel manqué de A ; un appel de B reste introuvable depuis A
  r = await call(ctl.create, { user: 'agent1', body: { companyId: A, model: 'missed_callback', origin: { type: 'missed_call', id: MISSED_A }, dueAt: FUTURE_REAL() } });
  assert.equal(r.code, 201, 'secrétaire Accueil : rappel d’un appel manqué'); assert.equal(String(store.at(-1).companyId), A);
  r = await call(ctl.create, { user: 'agent1', body: { companyId: A, model: 'missed_callback', origin: { type: 'missed_call', id: MISSED_B }, dueAt: FUTURE_REAL() } });
  assert.equal(r.code, 404, 'appel manqué de B introuvable depuis A');

  // société qui n'est pas l'un de ses emplois : 403 avant toute lecture d'offre
  offerLookups.length = 0;
  r = await call(ctl.missedCalls, { user: 'agent1', query: { companyId: C } });
  assert.equal(r.code, 403); assert.match(r.body.message, /pas rattaché à cette entreprise/); assert.equal(offerLookups.length, 0, 'offre de C jamais lue');

  // offre illisible : refus pour l'agent (jamais d'ouverture sur incident)
  const realFindOne = Subscription.findOne;
  Subscription.findOne = () => ({ populate: async () => { throw new Error('base indisponible'); } });
  assert.equal((await call(ctl.missedCalls, { user: 'agent1', query: { companyId: A } })).code, 403, 'offre illisible : refus');
  Subscription.findOne = realFindOne;

  // titulaire et membres d'un Call Centre : inchangé, l'offre n'est pas consultée
  offerLookups.length = 0;
  me = { isOwner: true, companyId: B, permissions: {} };
  r = await call(ctl.missedCalls, { query: { companyId: B } });
  assert.equal(r.code, 200, 'titulaire Call Centre : appels manqués lisibles'); assert.equal(r.body.data.items.length, 1);
  me = { isOwner: false, isAgent: false, companyId: B, permissions: { 'calls.view': true } };
  r = await call(ctl.missedCalls, { user: 'm2', query: { companyId: B } });
  assert.equal(r.code, 200, 'membre avec droit sur les appels : inchangé');
  assert.equal(offerLookups.length, 0, 'offre non consultée pour titulaire et membres');
  delete offers[A]; delete offers[B];
}

// Appel rattaché à un élément : validation
assert.equal(F.validateCallLog({ sid: 'CA1', durationSeconds: 42.4, status: 'completed' }).value.durationSeconds, 42);
assert.equal(F.validateCallLog({}).value.status, 'completed');
assert.ok(F.validateCallLog({ status: 'pirate' }).error);
assert.ok(F.validateCallLog({ durationSeconds: -1 }).error);
assert.ok(F.validateCallLog({ durationSeconds: 99999 }).error);
assert.deepEqual(F.toItem({ _id: 'a'.repeat(24), calls: [{ sid: 'CA1', at: NOW, durationSeconds: 5, status: 'completed', byId: 'u1', byName: 'Léa' }] }).calls, [{ sid: 'CA1', at: NOW, durationSeconds: 5, status: 'completed', by: { id: 'u1', name: 'Léa' } }]);
assert.deepEqual(F.toItem({ _id: 'a'.repeat(24) }).calls, []);

console.log('followUps: ok');
