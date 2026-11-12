// Run: JWT_SECRET=test node src/tests/reception.test.js
// Annuaire et consignes d'accueil + « Prendre un message ». Base, service d'inscription et messagerie simulés : aucun e-mail ni appel réel.
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
const D = await import('../services/receptionDirectory.js');
const F = await import('../services/followUps.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');
const { default: FollowUpItem } = await import('../models/FollowUpItem.js');
const { default: ReceptionDirectory } = await import('../models/ReceptionDirectory.js');
const { default: InboundCall } = await import('../models/InboundCall.js');
const { default: SecretariatTools } = await import('../models/SecretariatTools.js');
const { receptionController: ctl } = await import('../controllers/receptionController.js');
const { followUpController: fu } = await import('../controllers/followUpController.js');
const { setNotifyDeps, notifyByMail } = await import('../services/messageNotify.js');

// ---------------------------------------------------------------- numéros
assert.equal(D.normalizeE164('+33 6 12 34 56 78'), '+33612345678');
assert.equal(D.normalizeE164('+1 (415) 555-2671'), '+14155552671');
for (const v of ['0612345678', '33612345678', '+0612345678', '+33', '+336123456789012345', 'abc', '', null, 42]) assert.equal(D.normalizeE164(v), null, String(v));
assert.equal(D.cleanCallerPhone('06 12 34 56 78'), '0612345678');
assert.equal(D.cleanCallerPhone('+33612345678'), '+33612345678');
assert.equal(D.cleanCallerPhone('12'), null); assert.equal(D.cleanCallerPhone('abc'), null);

// ---------------------------------------------------------------- validation de l'annuaire
const E1 = '64b0000000000000000000e1';
const okD = (body) => { const r = D.validateDirectory(body); assert.equal(r.error, undefined, JSON.stringify([body, r])); return r.value; };
const koD = (body, re) => { const r = D.validateDirectory(body); assert.match(r.error || '', re, JSON.stringify(body)); };
assert.deepEqual(okD({}), { general: { companyName: '', greeting: '', tone: '', neverDisclose: '', other: '' }, entries: [] });
const full = okD({
  general: { companyName: ' Cabinet  Martin ', greeting: 'Cabinet Martin, bonjour', tone: 'Vouvoiement', neverDisclose: 'Jamais les tarifs' },
  entries: [{ id: E1, kind: 'owner', userId: 'u1', name: '  Mme   Martin ', role: 'Gérante', phone: '+33 6 12 34 56 78', extension: '204', email: 'MARTIN@cabinet.fr',
    hours: [{ day: 2, start: '14:00', end: '18:00' }, { day: 1, start: '09:00', end: '12:00' }], hoursNote: 'Pas le vendredi',
    instructions: { routeCalls: 'Les clients historiques', ifAbsent: 'Proposer le mobile de M. Roux', priority: 'Urgence médicale' } }],
});
assert.equal(full.general.companyName, 'Cabinet Martin');
assert.equal(full.entries[0].name, 'Mme Martin'); assert.equal(full.entries[0].phone, '+33612345678'); assert.equal(full.entries[0].email, 'martin@cabinet.fr');
assert.deepEqual(full.entries[0].hours.map((h) => h.day), [1, 2], 'plages triées');
koD({ entries: [{ name: '' }] }, /nom est obligatoire/);
koD({ entries: [{ name: 'A', phone: '0612345678' }] }, /international/);
koD({ entries: [{ name: 'A', extension: 'ab' }] }, /poste/);
koD({ entries: [{ name: 'A', email: 'pasunmail' }] }, /e-mail/);
koD({ entries: [{ name: 'A', kind: 'roi' }] }, /type inconnu/);
koD({ entries: [{ name: 'A', userId: 'bad id!' }] }, /compte invalide/);
koD({ entries: [{ name: 'A', hours: [{ day: 8, start: '09:00', end: '10:00' }] }] }, /Jour/);
koD({ entries: [{ name: 'A', hours: [{ day: 1, start: '9h', end: '10:00' }] }] }, /HH:MM/);
koD({ entries: [{ name: 'A', hours: [{ day: 1, start: '10:00', end: '09:00' }] }] }, /après/);
koD({ entries: [{ name: 'A', hours: [{ day: 1, start: '09:00', end: '11:00' }, { day: 1, start: '10:00', end: '12:00' }] }] }, /chevauchent/);
koD({ entries: [{ name: 'A', instructions: { routeCalls: 'x'.repeat(601) } }] }, /600/);
koD({ entries: [{ name: 'A', userId: 'u1' }, { name: 'B', userId: 'u1' }] }, /déjà/);
koD({ entries: [{ name: 'A', id: 'nope' }] }, /identifiant/);
koD({ entries: 'x' }, /liste/);
koD({ entries: Array.from({ length: 101 }, (_, i) => ({ name: `P${i}` })) }, /100/);
koD({ general: { greeting: 'x'.repeat(301) } }, /300/);
koD({ general: { tone: 5 } }, /texte/);

// ---------------------------------------------------------------- absences
assert.equal(D.todayIn('Europe/Paris', Date.parse('2026-11-05T23:30:00Z')), '2026-11-06', 'jour de l’entreprise');
const abs = D.parseAbsences({ data: [
  { userId: 'u1', kind: 'leave', status: 'approved', startDate: '2026-11-04', endDate: '2026-11-10' },
  { userId: 'u1', kind: 'sick', status: 'approved', startDate: '2026-11-11', endDate: '2026-11-12' },
  { userId: 'u2', kind: 'late_arrival', status: 'approved', startDate: '2026-11-05', endDate: '2026-11-05' },
  { userId: 'u3', kind: 'leave', status: 'pending', startDate: '2026-11-05', endDate: '2026-11-06' },
  { userId: 'u4', kind: 'leave', status: 'approved', startDate: '2026-10-01', endDate: '2026-10-03' },
  { userId: 'u5', kind: 'leave', status: 'approved', startDate: '2026-11-20', endDate: '2026-11-22' },
] }, '2026-11-05');
assert.deepEqual(abs.map((a) => a.userId), ['u1', 'u1', 'u5'], 'acceptées, journée entière, non terminées');
assert.deepEqual(D.absenceOf(abs, 'u1', '2026-11-05'), { from: '2026-11-04', until: '2026-11-12', kind: 'leave' }, 'absences qui se suivent : enchaînées');
assert.equal(D.absenceOf(abs, 'u5', '2026-11-05'), null, 'absence future : présente aujourd’hui');
assert.equal(D.absenceOf(abs, 'u2', '2026-11-05'), null); assert.equal(D.absenceOf(abs, '', '2026-11-05'), null);

// ---------------------------------------------------------------- message pris (pur)
const NOW = Date.parse('2026-11-05T10:00:00Z');
const okM = (b) => { const r = D.validateMessage(b, [E1], NOW); assert.equal(r.error, undefined, JSON.stringify(r)); return r.value; };
const koM = (b, re) => assert.match(D.validateMessage(b, [E1], NOW).error || '', re, JSON.stringify(b));
const base = { callerName: ' M.  Dupont ', forEntryId: E1, reason: 'Rappeler pour le devis' };
const m = okM({ ...base, callerCompany: 'SARL Dupont', callerPhone: '06 12 34 56 78', urgency: 'urgent', callbackBefore: '2026-11-05T15:00:00Z' });
assert.equal(m.callerName, 'M. Dupont'); assert.equal(m.callerPhone, '0612345678'); assert.equal(m.urgency, 'urgent'); assert.equal(m.callbackBefore.toISOString(), '2026-11-05T15:00:00.000Z');
assert.equal(okM(base).urgency, 'normal');
koM({ ...base, callerName: '' }, /nom de l’appelant/);
koM({ ...base, forEntryId: undefined }, /Choisissez/);
koM({ ...base, forEntryId: '64b0000000000000000000ff' }, /annuaire/);
koM({ ...base, reason: '  ' }, /motif/);
koM({ ...base, reason: 'x'.repeat(1001) }, /1000/);
koM({ ...base, urgency: 'critique' }, /Urgence/);
koM({ ...base, callbackBefore: '2026-11-04T10:00:00Z' }, /à venir/);
koM({ ...base, callbackBefore: 'demain' }, /invalides/);
koM({ ...base, callerPhone: 'abc' }, /Numéro/);
koM({ ...base, callId: 'x' }, /Appel/);
assert.equal(D.messageTitle('Mme Martin', 'urgent'), 'URGENT · Message pour Mme Martin');
assert.equal(D.messageTitle('x'.repeat(200), 'normal').length, 120);
const mail = D.messageEmail({ forName: 'Mme Martin', callerName: 'M. Dupont', callerCompany: 'SARL', callerPhone: '0612345678', reason: 'Devis', urgency: 'urgent', callbackBefore: '2026-11-05T15:00:00Z', takenByName: 'Léa', companyName: 'Cabinet Martin', timeZone: 'Europe/Paris' });
assert.match(mail, /Message URGENT pris à l’accueil de Cabinet Martin par Léa/); assert.match(mail, /16 h 00|16:00/); assert.match(mail, /Devis/);
for (const w of ['centre d’appels', 'call centre', 'siège', 'agent']) assert.ok(!mail.toLowerCase().includes(w), w);

// ---------------------------------------------------------------- toItem / tri / filtre : modèles existants intacts
const msgItem = { _id: 'i1', model: 'message_taken', title: 'x', status: 'todo', urgency: 'urgent', forName: 'Mme Martin', callerCompany: 'SARL', seenAt: null, emailStatus: 'sent' };
assert.deepEqual(F.toItem(msgItem).message, { callerCompany: 'SARL', forEntryId: '', forName: 'Mme Martin', urgency: 'urgent', seen: false, email: 'sent', motif: '', priority: false, reminded: false, escalated: false });
assert.equal('message' in F.toItem({ _id: 'i2', model: 'transfer', title: 'x', status: 'todo' }), false, 'les autres modèles ne changent pas');
assert.deepEqual(F.sortItems([{ id: 'n', status: 'todo', dueAt: '2026-11-01', createdAt: '2026-11-01' }, { id: 'u', status: 'todo', urgency: 'urgent', dueAt: null, createdAt: '2026-11-01' }]).map((i) => i.id), ['u', 'n'], 'urgent d’abord');
assert.deepEqual(F.parseListFilters({ model: 'message_taken' }).value, { model: 'message_taken' });
assert.ok(!F.MODELS.includes('message_taken'), 'la création générique ne crée pas de message pris');
assert.match(F.validateCreate({ model: 'message_taken' }, { userId: 'o' }).error, /inconnu/);

// ---------------------------------------------------------------- notification par e-mail (messagerie simulée)
const sent = []; const logs = [];
const deps = (over = {}) => ({
  loadEmailIdentity: async () => ({ provider: 'google' }),
  resolveMailbox: async () => ({ provider: 'google', account: 'accueil@cabinet.fr' }),
  loadUserProfile: async () => ({ name: 'Mme Martin', email: 'martin@cabinet.fr' }),
  sendViaConnection: async (c, p, msg) => { sent.push({ c, p, msg }); },
  countRecent: async () => 0, log: async (r) => { logs.push(r); },
  ...over,
});
const args = { companyId: '64b0000000000000000000c1', followUpId: 'f1', entry: { name: 'Mme Martin', userId: 'u1', email: '' }, message: { callerName: 'Dupont', callerCompany: '', callerPhone: '', reason: 'Devis', urgency: 'normal', callbackBefore: null }, takenBy: { id: 'a1', name: 'Léa' }, companyName: 'Cabinet', timeZone: 'Europe/Paris' };
setNotifyDeps(deps());
assert.equal(await notifyByMail(args), 'sent');
assert.equal(sent.length, 1); assert.deepEqual(sent[0].msg.to, ['martin@cabinet.fr']); assert.equal(sent[0].p, 'google'); assert.equal(sent[0].msg.replyTo.email, 'accueil@cabinet.fr');
assert.equal(logs[0].status, 'sent'); assert.equal(logs[0].template, 'message_taken');
sent.length = 0;
assert.equal(await notifyByMail({ ...args, entry: { ...args.entry, email: 'direct@cabinet.fr' } }), 'sent'); assert.deepEqual(sent[0].msg.to, ['direct@cabinet.fr'], 'adresse de la fiche prioritaire');
sent.length = 0;
setNotifyDeps(deps({ resolveMailbox: async () => ({ error: 'not_connected', provider: null }) }));
assert.equal(await notifyByMail(args), 'not_connected'); assert.equal(sent.length, 0, 'sans messagerie : rien ne part (jamais depuis HARX)');
setNotifyDeps(deps({ resolveMailbox: async () => ({ error: 'needs_reauth', provider: 'google' }) }));
assert.equal(await notifyByMail(args), 'needs_reauth');
setNotifyDeps(deps({ loadUserProfile: async () => ({ name: '', email: '' }) }));
assert.equal(await notifyByMail(args), 'no_recipient');
setNotifyDeps(deps({ countRecent: async () => 9999 }));
assert.equal(await notifyByMail(args), 'limit');
setNotifyDeps(deps({ sendViaConnection: async () => { throw new Error('boum'); } }));
assert.equal(await notifyByMail(args), 'failed', 'un échec du fournisseur ne lève jamais');
assert.equal(logs.at(-1).status, 'failed');
setNotifyDeps(deps({ loadEmailIdentity: async () => { throw new Error('base'); } }));
assert.equal(await notifyByMail(args), 'failed');

// ---------------------------------------------------------------- contrôleur
const C1 = '64b0000000000000000000c1'; const C2 = '64b0000000000000000000c2';
const people = { owner1: { isOwner: true, companyId: C1 }, mgr1: { isOwner: false, companyId: C1, permissions: { 'calls.view': true } }, mgrNo: { isOwner: false, companyId: C1, permissions: {} },
  sec1: { isOwner: false, isAgent: true, companyId: C1 }, sec2: { isOwner: false, isAgent: true, companyId: C1 }, multi: { isOwner: false, isAgent: true, companyId: C1, companyIds: [C1, C2] }, other: { isOwner: true, companyId: C2 } };
let schedulePayload = { status: 200, body: { data: [{ userId: 'sec1', kind: 'leave', status: 'approved', startDate: '2026-11-04', endDate: '2099-12-31' }] } };
const fetched = [];
global.fetch = async (url) => {
  const u = String(url); fetched.push(u);
  if (u.includes('/company-members/me')) return { ok: true, json: async () => ({ data: people[new URL(u).searchParams.get('userId')] || {} }) };
  if (u.includes('/api/company-members?')) return { ok: true, json: async () => ({ data: [{ userId: 'owner1', fullName: 'Chef', isOwner: true }, { userId: 'mgr1', fullName: 'Resp Un' }] }) };
  if (u.includes('/call-center/agents')) return { ok: true, json: async () => ({ data: [{ userId: 'sec1', fullName: 'Léa' }, { userId: 'sec2', fullName: 'Zoé' }] }) };
  if (u.includes('/schedule/requests')) return { ok: schedulePayload.status === 200, json: async () => schedulePayload.body };
  if (u.includes('/api/users/')) return { ok: true, json: async () => ({ data: { fullName: 'Léa', email: 'lea@x.fr' } }) };
  throw new Error(`fetch inattendu ${u}`);
};
SecretariatTools.findOne = () => ({ lean: async () => null });
let dirs = []; // un document par entreprise
const lean = (v) => ({ lean: async () => v, select() { return this; } });
const match = (d, f) => Object.entries(f).every(([k, v]) => (k === '$set' || k === '$setOnInsert' ? true : String(d[k]) === String(v)));
ReceptionDirectory.findOne = (f) => lean(dirs.find((d) => match(d, f)) || null);
ReceptionDirectory.findOneAndUpdate = (f, upd) => {
  let d = dirs.find((x) => match(x, f));
  if (!d) { d = { _id: `d${dirs.length}`, companyId: f.companyId, general: {}, entries: [], absences: [], ...(upd.$setOnInsert || {}) }; dirs.push(d); }
  const set = { ...upd.$set };
  if (set.entries) set.entries = set.entries.map((e, i) => ({ ...e, _id: e._id || `64b0000000000000000010${String(i).padStart(2, '0')}` }));
  Object.assign(d, set, { updatedAt: new Date() });
  return lean(structuredClone(d));
};
const store = [];
const mk = (doc) => { const d = { _id: `64b00000000000000000${String(store.length + 1).padStart(4, '0')}`, status: 'todo', createdAt: new Date(), transfers: [], seenAt: null, ...doc, async save() { return d; }, toObject() { const { save, toObject, ...rest } = d; return rest; } }; return d; };
FollowUpItem.create = async (doc) => { const d = mk(doc); store.push(d); return d; };
FollowUpItem.updateOne = async (f, upd) => { const d = store.find((s) => String(s._id) === String(f._id) && String(s.companyId) === String(f.companyId) && s.model === f.model && s.assigneeId === f.assigneeId && s.seenAt === null); if (d) Object.assign(d, upd.$set); return { modifiedCount: d ? 1 : 0 }; };
FollowUpItem.find = (f) => ({ sort() { return this; }, limit() { return this; }, lean: async () => store.filter((s) => String(s.companyId) === String(f.companyId)).filter((s) => !f.assigneeId || s.assigneeId === f.assigneeId).map((s) => s.toObject()) });
FollowUpItem.countDocuments = async (f) => store.filter((s) => (!f.model || s.model === f.model) && (!f.assigneeId || s.assigneeId === f.assigneeId) && (f.seenAt === undefined || s.seenAt === null) && (!f.status || s.status === f.status)).length;
InboundCall.findOne = (f) => ({ select: () => ({ lean: async () => (String(f._id) === '64b0000000000000000000ca' && String(f.companyId) === C1 ? { from: '+33699999999' } : null) }) });

async function call(fn, { user = 'owner1', body = {}, params = {}, query = {} } = {}) {
  clearCompanyCache();
  const tok = jwt.sign({ userId: user }, process.env.JWT_SECRET);
  return new Promise((resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); return this; } };
    fn({ user: { userId: user }, headers: { authorization: `Bearer ${tok}` }, body, params, query }, res);
  });
}

// lecture : vide au départ ; tout le personnel d'accueil peut lire, un responsable sans le droit d'appels non
let r = await call(ctl.getDirectory, { user: 'sec1' });
assert.equal(r.code, 200); assert.deepEqual(r.body.data.entries, []); assert.equal(r.body.data.canEdit, false);
assert.equal((await call(ctl.getDirectory, { user: 'mgrNo' })).code, 403);
assert.equal((await call(ctl.getDirectory, { user: 'owner1' })).body.data.canEdit, true);

// écriture : titulaire et responsables seulement
const entries = [
  { kind: 'owner', userId: 'owner1', name: 'Mme Martin', role: 'Gérante', phone: '+33612345678', instructions: { ifAbsent: 'Proposer le mobile' } },
  { kind: 'collaborator', userId: 'sec1', name: 'Léa Bernard', role: 'Comptabilité', email: 'lea@cabinet.fr' },
  { kind: 'service', name: 'Service technique', phone: '+33145678901' },
];
for (const user of ['sec1', 'mgrNo']) assert.equal((await call(ctl.putDirectory, { user, body: { entries } })).code, 403, `${user} ne peut pas écrire`);
assert.ok(dirs.every((d) => d.entries.length === 0 && !d.updatedById), 'un refus n’écrit rien');
assert.equal((await call(ctl.putDirectory, { user: 'owner1', body: { entries: [{ name: 'A', phone: '06' }] } })).code, 400);
r = await call(ctl.putDirectory, { user: 'owner1', body: { entries: [{ name: 'Intrus', userId: 'intrus1' }] } });
assert.equal(r.code, 422, 'compte hors entreprise refusé'); assert.match(r.body.message, /ne fait pas partie/);
r = await call(ctl.putDirectory, { user: 'mgr1', body: { general: { greeting: 'Cabinet Martin, bonjour', companyName: 'Cabinet Martin' }, entries } });
assert.equal(r.code, 200); assert.equal(r.body.data.entries.length, 3); assert.equal(r.body.data.entries[0].hasAccount, true); assert.equal(r.body.data.entries[2].hasAccount, false);
const ids = r.body.data.entries.map((e) => e.id);
assert.equal(dirs[0].updatedById, 'mgr1');

// isolation : l'autre entreprise ne voit rien ; un agent multi-entreprises choisit l'entreprise ; une entreprise étrangère est refusée
assert.deepEqual((await call(ctl.getDirectory, { user: 'other' })).body.data.entries, []);
assert.equal((await call(ctl.getDirectory, { user: 'sec1', query: { companyId: C2 } })).code, 403, 'entreprise non rattachée');
assert.equal((await call(ctl.getDirectory, { user: 'multi', query: { companyId: C2 } })).code, 200, 'agent employé par les deux');
assert.deepEqual((await call(ctl.getDirectory, { user: 'multi', query: { companyId: C2 } })).body.data.entries, []);
assert.equal((await call(ctl.getDirectory, { user: 'multi' })).body.data.entries.length, 3);
assert.equal((await call(ctl.getDirectory, { user: 'multi', query: { companyId: '64b0000000000000000000c9' } })).code, 403);

// absences : photo rafraîchie par le planning ; « absent·e jusqu'au » affiché à une secrétaire
r = await call(ctl.getDirectory, { user: 'owner1' });
assert.deepEqual(r.body.data.entries[1].absence, { from: '2026-11-04', until: '2099-12-31', kind: 'leave' });
assert.equal(r.body.data.entries[0].absence, null);
schedulePayload = { status: 403, body: {} }; dirs[0].absencesSyncedAt = new Date(0);
r = await call(ctl.getDirectory, { user: 'sec2' });
assert.equal(r.code, 200); assert.equal(r.body.data.entries[1].absence.until, '2099-12-31', 'planning illisible : photo précédente conservée');

// prendre un message
const msg = { callerName: 'M. Dupont', callerCompany: 'SARL Dupont', callerPhone: '06 12 34 56 78', forEntryId: ids[1], reason: 'Rappeler pour le devis', urgency: 'urgent', callbackBefore: new Date(Date.now() + 86400000).toISOString() };
sent.length = 0; setNotifyDeps(deps());
r = await call(ctl.takeMessage, { user: 'sec2', body: msg });
assert.equal(r.code, 201, JSON.stringify(r.body));
assert.equal(r.body.data.item.model, 'message_taken'); assert.equal(r.body.data.item.assignee.id, 'sec1'); assert.equal(r.body.data.item.assignee.name, 'Léa Bernard');
assert.equal(r.body.data.item.message.urgency, 'urgent'); assert.equal(r.body.data.item.contactPhone, '0612345678'); assert.equal(r.body.data.item.createdBy.id, 'sec2');
assert.deepEqual(r.body.data.notified, { inApp: true, email: 'sent', assigned: true });
assert.deepEqual(sent[0].msg.to, ['lea@cabinet.fr']);
assert.equal(store[0].seenAt, null, 'nouveau pour la personne visée');
// sans messagerie connectée : alerte dans l'application seulement, sans erreur
sent.length = 0; setNotifyDeps(deps({ resolveMailbox: async () => ({ error: 'not_connected', provider: null }) }));
r = await call(ctl.takeMessage, { user: 'sec1', body: { ...msg, urgency: 'normal', callbackBefore: undefined, callId: '64b0000000000000000000ca', callerPhone: '' } });
assert.equal(r.code, 201); assert.deepEqual(r.body.data.notified, { inApp: true, email: 'not_connected', assigned: true }); assert.equal(sent.length, 0);
assert.equal(r.body.data.item.contactPhone, '+33699999999', 'numéro repris de l’appel d’origine'); assert.equal(r.body.data.item.origin.type, 'call');
// service sans compte : message visible des responsables, non attribué
r = await call(ctl.takeMessage, { user: 'sec1', body: { ...msg, forEntryId: ids[2], callbackBefore: undefined } });
assert.equal(r.code, 201); assert.equal(r.body.data.item.assignee.id, ''); assert.equal(r.body.data.notified.assigned, false); assert.equal(r.body.data.notified.email, 'not_connected');
// refus
assert.equal((await call(ctl.takeMessage, { user: 'sec1', body: { ...msg, forEntryId: '64b0000000000000000000ff' } })).code, 400, 'personne hors annuaire');
assert.equal((await call(ctl.takeMessage, { user: 'other', body: msg })).code, 400, 'l’annuaire d’une autre entreprise n’est pas utilisable');
assert.equal((await call(ctl.takeMessage, { user: 'mgrNo', body: msg })).code, 403);
assert.equal((await call(ctl.takeMessage, { user: 'sec1', body: { ...msg, companyId: C2 } })).code, 403);
assert.equal(store.length, 3, 'les refus n’écrivent rien');

// compteur de nouveaux messages et « vu »
r = await call(fu.list, { user: 'sec1' });
assert.equal(r.body.data.counts.newMessages, 2, 'deux messages nouveaux pour Léa');
assert.equal((await call(ctl.markSeen, { user: 'sec2', params: { id: store[0]._id } })).body.data.updated, false, 'seule la personne visée l’ouvre');
r = await call(ctl.markSeen, { user: 'sec1', params: { id: store[0]._id } });
assert.equal(r.body.data.updated, true); assert.ok(store[0].seenAt);
assert.equal((await call(fu.list, { user: 'sec1' })).body.data.counts.newMessages, 1);
assert.equal((await call(ctl.markSeen, { user: 'sec1', params: { id: 'zzz' } })).code, 404);


// une secrétaire réserve un rendez-vous ou confie une tâche à une collègue (seuls modèles qu'elle crée), pour elle ou une personne de l'annuaire qui a un compte
const FUTURE = new Date(Date.now() + 5 * 86400000).toISOString();
r = await call(fu.directory, { user: 'sec2' });
assert.deepEqual(r.body.data.people.map((p) => p.id).sort(), ['owner1', 'sec1', 'sec2'], 'secrétaire : elle-même + les personnes de l’annuaire avec un compte');
r = await call(fu.create, { user: 'sec2', body: { model: 'transfer', title: 'Rappeler Mme Durand', assigneeId: 'sec1' } });
assert.equal(r.code, 201, JSON.stringify(r.body)); assert.equal(r.body.data.assignee.id, 'sec1', 'une secrétaire confie une tâche à une collègue');
assert.equal((await call(fu.create, { user: 'sec2', body: { model: 'missed_callback', origin: { type: 'none' }, dueAt: FUTURE } })).code, 403);
r = await call(fu.create, { user: 'sec2', body: { model: 'appointment', contactName: 'Mme Durand', dueAt: FUTURE, assigneeId: 'owner1' } });
assert.equal(r.code, 201, JSON.stringify(r.body)); assert.equal(r.body.data.assignee.id, 'owner1');
r = await call(fu.create, { user: 'sec2', body: { model: 'appointment', contactName: 'Mme Durand', dueAt: FUTURE, assigneeId: 'mgr1' } });
assert.equal(r.code, 422, 'hors annuaire : refusé');

console.log('reception.test.js : OK');
