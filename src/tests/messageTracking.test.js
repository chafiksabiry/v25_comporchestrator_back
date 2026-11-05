// Run: JWT_SECRET=test node src/tests/messageTracking.test.js
// Suivi des messages pris (relances, escalade, tableau), réponses types par motif, appelants prioritaires / bloqués. Base, réseau et messagerie simulés.
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
const X = await import('../services/receptionExtras.js');
const { runMessageReminders, startMessageReminders } = await import('../services/messageReminders.js');
const { blockedCallBody } = await import('../services/blockedCallers.js');
const { messagePayload } = await import('../services/webPush.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');
const { default: FollowUpItem } = await import('../models/FollowUpItem.js');
const { default: ReceptionDirectory } = await import('../models/ReceptionDirectory.js');
const { default: SecretariatTools } = await import('../models/SecretariatTools.js');
const { receptionController: ctl } = await import('../controllers/receptionController.js');
const { receptionExtrasController: ex } = await import('../controllers/receptionExtrasController.js');
const { setNotifyDeps } = await import('../services/messageNotify.js');

const MIN = 60000;
const NOW = Date.parse('2026-11-05T12:00:00Z');
const ago = (m) => new Date(NOW - m * MIN);

// ---------------------------------------------------------------- scripts par motif
const okS = (b) => { const r = X.validateScripts(b); assert.equal(r.error, undefined, JSON.stringify(r)); return r.value; };
const koS = (b, re) => assert.match(X.validateScripts(b).error || '', re, JSON.stringify(b));
const scripts = okS({ scripts: [{ label: ' Devis ', answer: 'Nous répondons sous 48 h.', questions: ['  Quel   produit ? ', '', 'Quel budget ?'], suggestedUrgency: 'normal' }, { label: 'Réclamation', suggestedUrgency: 'urgent' }] });
assert.equal(scripts[0].label, 'Devis'); assert.deepEqual(scripts[0].questions, ['Quel produit ?', 'Quel budget ?']); assert.equal(scripts[1].suggestedUrgency, 'urgent'); assert.equal(scripts[1].answer, '');
assert.deepEqual(okS({ scripts: [] }), []);
koS({}, /liste/); koS({ scripts: [{ label: '' }] }, /nom du motif/); koS({ scripts: [{ label: 'A' }, { label: 'a' }] }, /déjà/);
koS({ scripts: [{ label: 'A', answer: 'x'.repeat(1001) }] }, /1000/); koS({ scripts: [{ label: 'A', questions: Array(11).fill('q') }] }, /10 questions/);
koS({ scripts: [{ label: 'A', questions: ['x'.repeat(201)] }] }, /200/); koS({ scripts: [{ label: 'A', suggestedUrgency: 'vite' }] }, /urgence/);
koS({ scripts: [{ label: 'A', id: 'nope' }] }, /identifiant/); koS({ scripts: Array.from({ length: 31 }, (_, i) => ({ label: `M${i}` })) }, /30/);
koS({ scripts: ['x'] }, /invalide/);

// ---------------------------------------------------------------- appelants prioritaires / bloqués
const okC = (b) => { const r = X.validateCallerLists(b); assert.equal(r.error, undefined, JSON.stringify(r)); return r.value; };
const koC = (b, re) => assert.match(X.validateCallerLists(b).error || '', re, JSON.stringify(b));
const lists = okC({ vip: [{ phone: '+33 6 12 34 56 78', label: ' Client  clé ' }], blocked: [{ phone: '+14155552671' }] });
assert.deepEqual(lists.vip, [{ phone: '+33612345678', label: 'Client clé' }]); assert.deepEqual(lists.blocked, [{ phone: '+14155552671', label: '' }]);
assert.equal(okC({ vip: [] }).blocked, undefined, 'liste absente = inchangée');
koC({ vip: [{ phone: '0612345678' }] }, /format international/); koC({ blocked: [{ phone: 'abc' }] }, /format international/);
koC({ vip: [{ phone: '+33612345678' }, { phone: '+33 6 12 34 56 78' }] }, /deux fois/);
koC({ vip: [{ phone: '+33612345678' }], blocked: [{ phone: '+33612345678' }] }, /à la fois/);
koC({ vip: Array.from({ length: 201 }, (_, i) => ({ phone: `+3361234${String(i).padStart(4, '0')}` })) }, /200/);
assert.equal(okC({ vip: Array.from({ length: 200 }, (_, i) => ({ phone: `+3361234${String(i).padStart(4, '0')}` })) }).vip.length, 200);
koC({}, /Rien/); koC({ vip: 'x' }, /liste/);
const VIP = [{ phone: '+33612345678', label: 'Client clé' }];
assert.equal(X.matchesNumber(VIP, '+33612345678').label, 'Client clé');
assert.equal(X.matchesNumber(VIP, '+33 6 12 34 56 78')?.phone, '+33612345678');
assert.equal(X.matchesNumber(VIP, '0033612345678')?.phone, '+33612345678', '00 international');
assert.equal(X.matchesNumber(VIP, '0612345678'), null, 'numéro national jamais deviné');
assert.equal(X.matchesNumber(VIP, ''), null); assert.equal(X.matchesNumber(VIP, 'anonymous'), null); assert.equal(X.matchesNumber(undefined, '+33612345678'), null);

// appel bloqué : message poli, ou repli sur le comportement actuel (null) en cas d'erreur
const C1 = '64b0000000000000000000c1'; const C2 = '64b0000000000000000000c2';
const load = async (id) => (String(id) === C1 ? { blockedNumbers: [{ phone: '+14155552671' }] } : { blockedNumbers: [] });
const body = await blockedCallBody(C1, '+14155552671', { load });
assert.match(body, /<Say[^>]*>Nous ne pouvons pas donner suite[^<]*<\/Say><Hangup\/>/);
assert.equal(await blockedCallBody(C1, '+14155552671', { load, env: { BLOCKED_CALL_MODE: 'reject' } }), '<Reject reason="rejected"/>');
assert.equal(await blockedCallBody(C1, '+33612345678', { load }), null, 'autre appelant : inchangé');
assert.equal(await blockedCallBody(C2, '+14155552671', { load }), null, 'liste d’une autre entreprise : inchangé');
assert.equal(await blockedCallBody(C1, '', { load }), null, 'numéro masqué : inchangé');
assert.equal(await blockedCallBody('pas-un-id', '+14155552671', { load }), null);
assert.equal(await blockedCallBody(C1, '+14155552671', { load: async () => { throw new Error('base'); } }), null, 'erreur : comportement actuel');

// ---------------------------------------------------------------- réglages
const S = X.DEFAULT_SETTINGS;
assert.deepEqual(X.settingsOf(null), { remindersEnabled: true, urgentUnseenMinutes: 120, escalateAfterMinutes: 60 });
assert.equal(X.validateSettings({ urgentUnseenMinutes: 90 }).value.urgentUnseenMinutes, 90);
for (const b of [{ urgentUnseenMinutes: 5 }, { escalateAfterMinutes: 2000 }, { urgentUnseenMinutes: 'x' }, { remindersEnabled: 'oui' }, {}]) assert.ok(X.validateSettings(b).error, JSON.stringify(b));

// ---------------------------------------------------------------- décisions de relance
const item = (o = {}) => ({ _id: 'i1', model: 'message_taken', status: 'todo', urgency: 'normal', seenAt: null, dueAt: null, createdAt: ago(10), remindedAt: null, escalatedAt: null, ...o });
const act = (o) => X.reminderAction(item(o), S, NOW);
assert.equal(act({}), null, 'rien à relancer');
assert.deepEqual(act({ dueAt: ago(1) }), { type: 'remind', reason: 'overdue' }, 'rappeler avant dépassé');
assert.equal(act({ dueAt: new Date(NOW + MIN) }), null);
assert.deepEqual(act({ urgency: 'urgent', createdAt: ago(121) }), { type: 'remind', reason: 'urgent_unseen' });
assert.equal(act({ urgency: 'urgent', createdAt: ago(119) }), null, 'avant 2 h');
assert.equal(act({ urgency: 'urgent', createdAt: ago(300), seenAt: ago(200) }), null, 'urgent mais déjà lu : pas de relance');
assert.equal(act({ createdAt: ago(1000) }), null, 'normal sans échéance : jamais relancé');
assert.equal(act({ dueAt: ago(1), status: 'done' }), null); assert.equal(act({ dueAt: ago(1), model: 'appointment' }), null);
assert.equal(act({ dueAt: ago(100), remindedAt: ago(59) }), null, 'escalade pas avant le délai');
assert.deepEqual(act({ dueAt: ago(100), remindedAt: ago(61) }), { type: 'escalate', reason: 'overdue' });
assert.equal(act({ dueAt: ago(100), remindedAt: ago(500), escalatedAt: ago(10) }), null, 'une escalade au plus');
assert.equal(X.reminderAction(item({ dueAt: ago(1) }), { ...S, remindersEnabled: false }, NOW), null, 'relances désactivées par le titulaire');
assert.deepEqual(X.reminderAction(item({ urgency: 'urgent', createdAt: ago(50) }), { ...S, urgentUnseenMinutes: 30 }, NOW), { type: 'remind', reason: 'urgent_unseen' }, 'seuil réglable');

// cibles d'escalade : titulaire et responsables, sauf la personne visée
const entries = [
  { _id: 'e1', kind: 'owner', userId: 'owner1', name: 'Mme Martin', email: 'martin@x.fr' }, { _id: 'e2', kind: 'manager', userId: 'mgr1', name: 'Resp Un' },
  { _id: 'e3', kind: 'collaborator', userId: 'sec1', name: 'Léa' }, { _id: 'e4', kind: 'manager', userId: '', name: 'Resp externe', email: 'ext@x.fr' },
];
assert.deepEqual(X.escalationTargets(entries, { forEntryId: 'e3', assigneeId: 'sec1' }).map((t) => t.name), ['Mme Martin', 'Resp Un', 'Resp externe']);
assert.deepEqual(X.escalationTargets(entries, { forEntryId: 'e1', assigneeId: 'owner1' }).map((t) => t.name), ['Resp Un', 'Resp externe'], 'le titulaire visé n’est pas son propre responsable');

// ---------------------------------------------------------------- minuteur : relance, escalade, idempotence
const rows = [
  item({ _id: 'a', companyId: C1, assigneeId: 'sec1', forEntryId: 'e3', forName: 'Léa', contactName: 'M. Dupont', note: 'Devis', dueAt: ago(5), seenAt: ago(30) }),
  item({ _id: 'b', companyId: C1, assigneeId: 'sec1', forEntryId: 'e3', forName: 'Léa', contactName: 'Mme Roux', urgency: 'urgent', createdAt: ago(130) }),
  item({ _id: 'c', companyId: C1, assigneeId: 'sec1', forEntryId: 'e3', forName: 'Léa', contactName: 'M. Petit', dueAt: ago(200), remindedAt: ago(90), seenAt: null }),
  item({ _id: 'd', companyId: C1, assigneeId: 'sec1', forEntryId: 'e3', forName: 'Léa', contactName: 'Calme' }),
];
const noMailRows = [];
const pushes = []; const mails = []; const claims = [];
const deps = {
  findOpen: async () => rows.filter((r) => r.status === 'todo' && !r.escalatedAt),
  loadDoc: async () => ({ entries, general: { companyName: 'Cabinet Martin' }, followUpSettings: {} }),
  claim: async (filter, set) => {
    const r = [...rows, ...noMailRows].find((x) => x._id === filter._id);
    if (!r || r.status !== filter.status) return false;
    if ('remindedAt' in filter && (filter.remindedAt === null ? r.remindedAt !== null : r.remindedAt === null)) return false;
    if ('escalatedAt' in filter && filter.escalatedAt === null && r.escalatedAt) return false;
    Object.assign(r, set); claims.push([r._id, Object.keys(set).join(',')]); return true;
  },
  push: async (userId, payload) => { pushes.push([userId, payload.title]); },
  mail: async (a) => { mails.push(a); return 'sent'; },
  timeZone: async () => 'Europe/Paris',
};
let res = await runMessageReminders({ now: NOW, deps });
assert.deepEqual(res, { checked: 4, reminded: 2, escalated: 1 });
assert.ok(rows[0].remindedAt && rows[0].remindReason === 'overdue' && rows[0].seenAt === null, 'relancé : redevient nouveau pour la personne visée');
assert.equal(rows[1].remindReason, 'urgent_unseen');
assert.ok(!rows[3].remindedAt, 'message calme intact');
assert.ok(rows[2].escalatedAt); assert.deepEqual(rows[2].escalatedToNames, ['Mme Martin', 'Resp Un', 'Resp externe']);
assert.deepEqual(pushes.filter((p) => p[0] === 'sec1').length, 2, 'push de relance à la personne visée');
assert.ok(pushes.some((p) => p[0] === 'owner1') && pushes.some((p) => p[0] === 'mgr1'), 'push aux responsables');
assert.deepEqual(mails.map((m) => m.entry.name), ['Mme Martin', 'Resp Un', 'Resp externe']);
assert.equal(mails[0].message.escalationFor, 'Léa'); assert.equal(mails[0].takenBy.id, 'system');
// idempotent : un second passage ne relance rien de plus
pushes.length = 0; mails.length = 0;
res = await runMessageReminders({ now: NOW + MIN, deps });
assert.deepEqual(res, { checked: 3, reminded: 0, escalated: 0 }); assert.equal(pushes.length, 0); assert.equal(mails.length, 0);
// plus tard, la relance des messages « a » et « b » monte au responsable, une seule fois
res = await runMessageReminders({ now: NOW + 61 * MIN, deps });
assert.equal(res.escalated, 2); assert.equal(mails.length, 6);
res = await runMessageReminders({ now: NOW + 600 * MIN, deps });
assert.deepEqual([res.reminded, res.escalated], [0, 0]);
// deux passages simultanés : la réservation atomique n'accepte qu'un seul
const race = [item({ _id: 'r', companyId: C1, assigneeId: 'sec1', forEntryId: 'e3', dueAt: ago(1) })];
let taken = false; const raceMails = [];
const raceDeps = { ...deps, findOpen: async () => race, claim: async () => { if (taken) return false; taken = true; return true; }, push: async () => { raceMails.push('p'); } };
const both = await Promise.all([runMessageReminders({ now: NOW, deps: raceDeps }), runMessageReminders({ now: NOW, deps: raceDeps })]);
assert.equal(both.reduce((n, r) => n + r.reminded, 0), 1, 'une seule relance');
// relances désactivées dans l'entreprise ; erreur sur un message : les autres continuent
const off = [item({ _id: 'o', companyId: C1, assigneeId: 'sec1', dueAt: ago(1) })];
assert.deepEqual(await runMessageReminders({ now: NOW, deps: { ...deps, findOpen: async () => off, loadDoc: async () => ({ entries, followUpSettings: { remindersEnabled: false } }) } }), { checked: 1, reminded: 0, escalated: 0 });
const mixed = [item({ _id: 'x1', companyId: C1, assigneeId: 'sec1', dueAt: ago(1) }), item({ _id: 'x2', companyId: C1, assigneeId: 'sec1', dueAt: ago(1) })];
let n = 0;
res = await runMessageReminders({ now: NOW, deps: { ...deps, findOpen: async () => mixed, claim: async () => { n += 1; if (n === 1) throw new Error('base'); return true; } } });
assert.equal(res.reminded, 1);
// l'escalade sans messagerie connectée : l'alerte seule, aucune erreur
const noMail = noMailRows; noMail.push(item({ _id: 'n', companyId: C1, assigneeId: 'sec1', forEntryId: 'e3', dueAt: ago(500), remindedAt: ago(200) }));
res = await runMessageReminders({ now: NOW, deps: { ...deps, findOpen: async () => noMail, mail: async () => 'not_connected' } });
assert.equal(res.escalated, 1); assert.ok(noMail[0].escalatedAt);

// minuteur désactivable
assert.equal(startMessageReminders({ env: { MESSAGE_REMINDERS_DISABLED: '1' }, run: async () => ({}) }), null);
assert.equal(startMessageReminders({ env: { MESSAGE_REMINDERS_DISABLED: 'true' } }), null);
const timer = startMessageReminders({ env: {}, run: async () => ({ reminded: 0, escalated: 0 }) });
assert.ok(timer); clearInterval(timer);

// push : contenu minimal, jamais le texte du message
const pl = messagePayload({ callerName: 'M. Dupont', urgent: true, id: 'abc' });
assert.equal(pl.kind, 'message'); assert.match(pl.title, /URGENT/); assert.equal(pl.url, '/app/followups'); assert.ok(!JSON.stringify(pl).includes('Devis'));
assert.match(messagePayload({ reminder: true }).title, /Rappel/);

// ---------------------------------------------------------------- statistiques
const st = X.computeStats([
  item({ _id: '1', assigneeId: 'sec1', forName: 'Léa', dueAt: ago(5), urgency: 'urgent' }),
  item({ _id: '2', assigneeId: 'sec1', forName: 'Léa', seenAt: ago(1), remindedAt: ago(10), escalatedAt: ago(1), priorityCaller: true }),
  item({ _id: '3', assigneeId: 'sec1', forName: 'Léa', status: 'done', createdAt: ago(100), closedAt: ago(40) }),
  item({ _id: '4', assigneeId: '', forEntryId: 'e9', forName: 'Service technique', status: 'done', createdAt: ago(30), closedAt: ago(0) }),
  item({ _id: '5', assigneeId: 'mgr1', forName: 'Resp Un', seenAt: ago(2) }),
  item({ _id: '6', model: 'appointment', assigneeId: 'sec1' }),
], NOW);
assert.deepEqual(st.totals, { open: 3, unseen: 1, urgentOpen: 1, overdue: 1, escalated: 1, reminded: 1, priorityOpen: 1, done: 2, avgHandlingMinutes: 45 });
const lea = st.perPerson.find((p) => p.id === 'sec1');
assert.deepEqual([lea.open, lea.unseen, lea.urgentOpen, lea.overdue, lea.escalated, lea.done, lea.avgHandlingMinutes], [2, 1, 1, 1, 1, 1, 60]);
assert.equal(st.perPerson[0].id, 'sec1', 'la personne la plus en difficulté en tête');
assert.equal(st.perPerson.length, 3);
assert.equal(X.computeStats([], NOW).totals.avgHandlingMinutes, null);

// ---------------------------------------------------------------- contrôleurs (routes)
const people = { owner1: { isOwner: true, companyId: C1 }, mgr1: { isOwner: false, companyId: C1, permissions: { 'calls.view': true } }, mgrNo: { isOwner: false, companyId: C1, permissions: {} },
  sec1: { isOwner: false, isAgent: true, companyId: C1 }, sec2: { isOwner: false, isAgent: true, companyId: C1 }, other: { isOwner: true, companyId: C2 } };
global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/company-members/me')) return { ok: true, json: async () => ({ data: people[new URL(u).searchParams.get('userId')] || {} }) };
  if (u.includes('/schedule/requests')) return { ok: false, json: async () => ({}) };
  if (u.includes('/api/users/')) return { ok: true, json: async () => ({ data: { fullName: 'Léa', email: 'lea@x.fr' } }) };
  throw new Error(`fetch inattendu ${u}`);
};
SecretariatTools.findOne = () => ({ lean: async () => null });
const dirs = [];
const lean = (v) => ({ lean: async () => v, select() { return this; } });
const match = (d, f) => Object.entries(f).every(([k, v]) => String(d[k]) === String(v));
ReceptionDirectory.findOne = (f) => lean(dirs.find((d) => match(d, f)) || null);
ReceptionDirectory.findOneAndUpdate = (f, upd) => {
  let d = dirs.find((x) => match(x, f));
  if (!d) { d = { _id: `d${dirs.length}`, companyId: f.companyId, general: {}, entries: [], scripts: [], vipNumbers: [], blockedNumbers: [], followUpSettings: {}, absences: [], absencesSyncedAt: new Date() }; dirs.push(d); }
  for (const [k, v] of Object.entries(upd.$set || {})) {
    if (k.includes('.')) { const [a, b] = k.split('.'); d[a] = { ...(d[a] || {}), [b]: v }; } else d[k] = k === 'scripts' ? v.map((s, i) => ({ ...s, _id: s._id || `64b00000000000000000a${i}0${i}`.slice(0, 24) })) : k === 'entries' ? v.map((e, i) => ({ ...e, _id: e._id || `64b0000000000000000010${String(i).padStart(2, '0')}` })) : v;
  }
  return lean(structuredClone(d));
};
const store = [];
FollowUpItem.create = async (doc) => { const d = { _id: `64b0000000000000000${String(store.length + 1).padStart(5, '0')}`, status: 'todo', createdAt: new Date(), seenAt: null, ...doc, async save() { return d; }, toObject() { const { save, toObject, ...r } = d; return r; } }; store.push(d); return d; };
FollowUpItem.find = () => ({ select() { return this; }, limit() { return this; }, lean: async () => store.map((s) => s.toObject()) });
setNotifyDeps({ resolveMailbox: async () => ({ error: 'not_connected', provider: null }) });

async function call(fn, { user = 'owner1', body = {}, query = {} } = {}) {
  clearCompanyCache();
  const tok = jwt.sign({ userId: user }, process.env.JWT_SECRET);
  return new Promise((resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); return this; } };
    fn({ user: { userId: user }, headers: { authorization: `Bearer ${tok}` }, body, params: {}, query }, res);
  });
}

// scripts : lecture pour l'accueil, écriture titulaire / responsables, isolation
let r = await call(ex.getScripts, { user: 'sec1' });
assert.equal(r.code, 200); assert.deepEqual(r.body.data.scripts, []); assert.equal(r.body.data.canEdit, false);
assert.equal((await call(ex.getScripts, { user: 'mgrNo' })).code, 403);
for (const user of ['sec1', 'mgrNo']) assert.equal((await call(ex.putScripts, { user, body: { scripts } })).code, 403, user);
assert.equal(dirs.length, 0, 'un refus n’écrit rien');
assert.equal((await call(ex.putScripts, { user: 'owner1', body: { scripts: [{ label: '' }] } })).code, 400);
r = await call(ex.putScripts, { user: 'mgr1', body: { scripts } });
assert.equal(r.code, 200); assert.equal(r.body.data.scripts.length, 2); assert.equal(r.body.data.scripts[0].label, 'Devis');
assert.equal((await call(ex.getScripts, { user: 'sec2' })).body.data.scripts.length, 2, 'la secrétaire voit les réponses types');
assert.deepEqual((await call(ex.getScripts, { user: 'other' })).body.data.scripts, [], 'autre entreprise : rien');
assert.equal((await call(ex.getScripts, { user: 'sec1', query: { companyId: C2 } })).code, 403);
assert.equal(dirs[0].updatedById, 'mgr1');

// appelants : lecture, écriture, vérification, isolation
assert.equal((await call(ex.putCallers, { user: 'sec1', body: { vip: VIP } })).code, 403);
assert.equal((await call(ex.putCallers, { user: 'owner1', body: { vip: [{ phone: '06' }] } })).code, 400);
r = await call(ex.putCallers, { user: 'owner1', body: { vip: VIP, blocked: [{ phone: '+14155552671', label: 'Démarcheur' }] } });
assert.equal(r.code, 200); assert.equal(r.body.data.vip.length, 1); assert.equal(r.body.data.blocked[0].label, 'Démarcheur');
r = await call(ex.putCallers, { user: 'owner1', body: { blocked: [{ phone: '+33612345678' }] } });
assert.equal(r.code, 400, 'un VIP ne peut pas être bloqué (contre la liste conservée)'); assert.match(r.body.message, /à la fois/);
assert.equal((await call(ex.getCallers, { user: 'sec1' })).body.data.blocked.length, 1);
assert.deepEqual((await call(ex.callerCheck, { user: 'sec1', query: { phone: '+33612345678' } })).body.data, { priority: true, label: 'Client clé' });
assert.deepEqual((await call(ex.callerCheck, { user: 'sec1', query: { phone: '+14155552671' } })).body.data, { priority: false, label: '' }, 'un numéro bloqué n’est pas annoncé');
assert.deepEqual((await call(ex.callerCheck, { user: 'other', query: { phone: '+33612345678' } })).body.data.priority, false, 'autre entreprise');
assert.deepEqual((await call(ex.getCallers, { user: 'other' })).body.data.vip, []);

// réglages
assert.deepEqual((await call(ex.getSettings, { user: 'sec1' })).body.data, { remindersEnabled: true, urgentUnseenMinutes: 120, escalateAfterMinutes: 60, canEdit: false });
assert.equal((await call(ex.putSettings, { user: 'sec1', body: { urgentUnseenMinutes: 60 } })).code, 403);
assert.equal((await call(ex.putSettings, { user: 'owner1', body: { urgentUnseenMinutes: 1 } })).code, 400);
r = await call(ex.putSettings, { user: 'owner1', body: { urgentUnseenMinutes: 45, remindersEnabled: false } });
assert.equal(r.code, 200); assert.equal(r.body.data.urgentUnseenMinutes, 45); assert.equal(r.body.data.remindersEnabled, false); assert.equal(r.body.data.escalateAfterMinutes, 60);
assert.equal((await call(ex.putSettings, { user: 'owner1', body: { remindersEnabled: true } })).body.data.urgentUnseenMinutes, 45, 'les autres seuils sont conservés');

// prise de message : motif, appelant prioritaire
const entryDir = await call((req, res) => ctl.putDirectory(req, res), { user: 'owner1', body: { entries: [{ kind: 'collaborator', userId: 'sec1', name: 'Léa Bernard' }] } });
assert.equal(entryDir.code, 422, 'le répertoire sans service d’inscription complet n’est pas utilisé ici'); // loadDirectory simulé vide
dirs[0].entries = [{ _id: '64b0000000000000000010aa', kind: 'collaborator', userId: 'sec1', name: 'Léa Bernard' }];
const devisId = dirs[0].scripts[0]._id;
const msg = { callerName: 'M. Dupont', callerPhone: '06 12 34 56 78', forEntryId: '64b0000000000000000010aa', reason: 'Devis', urgency: 'normal', scriptId: devisId };
r = await call(ctl.takeMessage, { user: 'sec2', body: msg });
assert.equal(r.code, 201, JSON.stringify(r.body)); assert.equal(store[0].motif, 'Devis'); assert.equal(store[0].priorityCaller, false, 'numéro national non reconnu');
r = await call(ctl.takeMessage, { user: 'sec2', body: { ...msg, callerPhone: '+33 6 12 34 56 78', scriptId: '' } });
assert.equal(r.code, 201); assert.equal(store[1].priorityCaller, true, 'appelant prioritaire'); assert.equal(store[1].motif, ''); assert.equal(r.body.data.item.message.priority, true);
r = await call(ctl.takeMessage, { user: 'sec2', body: { ...msg, scriptId: '64b00000000000000000ffff' } });
assert.equal(r.code, 201); assert.equal(store[2].motif, '', 'motif inconnu ignoré, jamais pris du navigateur');
assert.equal((await call(ctl.takeMessage, { user: 'sec2', body: { ...msg, scriptId: 'zzz' } })).code, 400);

// tableau de suivi : titulaire / responsables
assert.equal((await call(ex.stats, { user: 'sec1' })).code, 403);
r = await call(ex.stats, { user: 'mgr1' });
assert.equal(r.code, 200); assert.equal(r.body.data.totals.open, 3); assert.equal(r.body.data.totals.priorityOpen, 1); assert.equal(r.body.data.perPerson[0].name, 'Léa Bernard'); assert.equal(r.body.data.settings.urgentUnseenMinutes, 45);

console.log('messageTracking.test.js : OK');
