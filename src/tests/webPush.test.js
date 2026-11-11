// Run: JWT_SECRET=test node src/tests/webPush.test.js
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
for (const k of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']) delete process.env[k];
const W = await import('../services/webPush.js');
const { default: PushSubscription } = await import('../models/PushSubscription.js');
const { createReachController } = await import('../controllers/reachController.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');
const webpush = (await import('web-push')).default;

// --- configuration VAPID : uniquement par l'environnement
const keys = webpush.generateVAPIDKeys(); // clés jetables du test, jamais écrites
const env = { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'mailto:ops@example.com' };
assert.equal(W.vapidConfig({}), null);
assert.equal(W.pushAvailable({}), false);
assert.equal(W.vapidConfig({ ...env, VAPID_PRIVATE_KEY: '' }), null);
assert.equal(W.vapidConfig({ ...env, VAPID_SUBJECT: 'ops@example.com' }), null, 'sujet mailto: ou https:// exigé');
assert.deepEqual(W.vapidConfig(env), { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: 'mailto:ops@example.com' });
assert.equal(W.pushAvailable(env), true);

// --- validation de l'abonnement
const good = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'BPk', auth: 'au' } };
assert.equal(W.validateSubscription(good).ok, true);
assert.equal(W.validateSubscription({ ...good, endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/x' }).ok, true);
assert.equal(W.validateSubscription({ ...good, endpoint: 'https://web.push.apple.com/x' }).ok, true);
assert.equal(W.validateSubscription({ ...good, endpoint: 'https://wns2-par02p.notify.windows.com/w/?token=x' }).ok, true);
for (const bad of ['http://fcm.googleapis.com/x', 'https://evil.example/x', 'https://fcm.googleapis.com.evil.example/x', 'https://localhost/x', 'https://169.254.169.254/x', 'https://u:p@fcm.googleapis.com/x', 'nope', '']) {
  assert.equal(W.validateSubscription({ ...good, endpoint: bad }).ok, false, bad);
}
assert.equal(W.validateSubscription({ endpoint: good.endpoint }).ok, false);
assert.equal(W.validateSubscription({ endpoint: good.endpoint, keys: { p256dh: 'x' } }).ok, false);
assert.equal(W.validateSubscription(null).ok, false);

// --- modèle d'abonnement
const m = new PushSubscription({ userId: 'u1', companyId: '64b0000000000000000000c1', endpoint: good.endpoint, keys: good.keys });
assert.equal(m.validateSync(), undefined);
assert.equal(m.role, 'owner');
assert.ok(new PushSubscription({ userId: 'u1' }).validateSync().errors.endpoint, 'endpoint obligatoire');
assert.ok(new PushSubscription({ userId: 'u1', companyId: '64b0000000000000000000c1', endpoint: 'x' }).validateSync().errors['keys.auth'], 'clés obligatoires');
assert.equal(PushSubscription.schema.path('endpoint').options.unique, true);

// --- envoi avec client web-push simulé
const sent = [];
const client = (failures = {}) => ({
  sendNotification: async (sub, body, opts) => {
    sent.push({ sub, body: JSON.parse(body), opts });
    if (failures[sub.endpoint]) throw Object.assign(new Error('x'), { statusCode: failures[sub.endpoint] });
  },
});
const subs = [
  { endpoint: 'https://fcm.googleapis.com/a', keys: { p256dh: 'p', auth: 'a' } },
  { endpoint: 'https://fcm.googleapis.com/gone', keys: { p256dh: 'p', auth: 'a' } },
  { endpoint: 'https://fcm.googleapis.com/err', keys: { p256dh: 'p', auth: 'a' } },
];
let r = await W.sendToSubscriptions(subs, W.callPayload({ from: '+33611111111', to: '+33900000001', callSid: 'CA1' }), { client: client({ 'https://fcm.googleapis.com/gone': 410, 'https://fcm.googleapis.com/err': 500 }), env });
assert.deepEqual([r.sent, r.failed, r.gone], [1, 2, ['https://fcm.googleapis.com/gone']]);
assert.equal(sent[0].opts.vapidDetails.subject, 'mailto:ops@example.com');
assert.equal(sent[0].opts.vapidDetails.privateKey, keys.privateKey);
assert.equal(sent[0].body.kind, 'call');
assert.match(sent[0].body.body, /Touchez pour répondre/);
assert.match(sent[0].body.body, /mobile sonne si le renvoi est activé/);
assert.equal(sent[0].body.tag, 'call-CA1');
assert.equal(W.voicemailPayload({ from: '+33611111111', durationSeconds: 12, recordingSid: 'RE1' }).url, '/app/voicemails');
sent.length = 0;
r = await W.sendToSubscriptions(subs, { kind: 'x' }, { client: client(), env: {} });
assert.deepEqual([r.sent, r.skipped, sent.length], [0, true, 0], 'sans clés : aucun envoi');
let r404 = await W.sendToSubscriptions([subs[1]], { kind: 'x' }, { client: client({ [subs[1].endpoint]: 404 }), env });
assert.deepEqual(r404.gone, [subs[1].endpoint]);

// --- notifyOwners : lecture, envoi, nettoyage des 404/410 (magasin simulé)
const COMPANY = '64b0000000000000000000c1';
let rows = subs.map((s) => ({ ...s, userId: 'owner1', companyId: COMPANY, role: 'owner' }));
const finds = [];
const store = {
  find: (f) => { finds.push(f); return { lean: async () => rows }; },
  deleteMany: async (f) => { rows = rows.filter((x) => !f.endpoint.$in.includes(x.endpoint)); },
  updateMany: async () => ({}),
};
sent.length = 0;
r = await W.notifyOwners({ companyId: COMPANY }, W.voicemailPayload({ from: '+33611111111' }), { client: client({ 'https://fcm.googleapis.com/gone': 410 }), env, store });
assert.deepEqual(finds[0], { companyId: COMPANY, role: 'owner' });
assert.equal(r.sent, 2);
assert.deepEqual(rows.map((x) => x.endpoint), ['https://fcm.googleapis.com/a', 'https://fcm.googleapis.com/err'], 'abonnement expiré supprimé');
r = await W.notifyOwners({ companyId: COMPANY }, { kind: 'x' }, { client: client(), env: {}, store });
assert.equal(r.skipped, true);
r = await W.notifyOwners({ companyId: COMPANY }, { kind: 'x' }, { client: client(), env, store: { find: () => { throw new Error('base'); } } });
assert.equal(r.error, true, 'ne lève jamais');

// --- routes (contrôleur) : droits, clé publique, abonnement, désabonnement
const tok = jwt.sign({ userId: 'owner1' }, process.env.JWT_SECRET);
let me = { isOwner: true, companyId: COMPANY, permissions: {} };
global.fetch = async (url) => {
  if (String(url).includes('/company-members/me')) return { ok: true, json: async () => ({ data: me }) };
  throw new Error(`fetch inattendu ${url}`);
};
const db = [];
const subsModel = {
  updateOne: async (f, u) => { const i = db.findIndex((x) => x.endpoint === f.endpoint); if (i >= 0) db[i] = { ...db[i], ...u.$set }; else db.push({ endpoint: f.endpoint, ...u.$set }); },
  deleteOne: async (f) => { const i = db.findIndex((x) => x.endpoint === f.endpoint && x.userId === f.userId); if (i >= 0) db.splice(i, 1); },
  countDocuments: async (f) => db.filter((x) => x.userId === f.userId && (!f.endpoint || x.endpoint === f.endpoint)).length,
  find: (f) => ({ lean: async () => db.filter((x) => x.userId === f.userId) }),
  deleteMany: async () => {},
  updateMany: async () => {},
};
const ctl = createReachController({ subsModel, pushClient: client() });
async function call(fn, { user = 'owner1', body = {}, query = {} } = {}) {
  clearCompanyCache();
  return new Promise((resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); return this; } };
    fn({ user: { userId: user }, headers: { authorization: `Bearer ${tok}`, 'user-agent': 'test' }, body, query, get: () => 'orch.test' }, res);
  });
}
// sans clés : tout est désactivé proprement
r = await call(ctl.publicKey);
assert.deepEqual([r.body.data.available, r.body.data.publicKey], [false, null]);
assert.match(r.body.data.message, /indisponibles pour le moment/);
r = await call(ctl.subscribe, { body: { subscription: good } });
assert.equal(r.code, 503); assert.match(r.body.message, /indisponibles pour le moment/);
r = await call(ctl.test); assert.equal(r.code, 503);
// avec clés (seule la clé publique est exposée)
Object.assign(process.env, env);
r = await call(ctl.publicKey);
assert.deepEqual([r.body.data.available, r.body.data.publicKey], [true, keys.publicKey]);
assert.ok(!JSON.stringify(r.body).includes(keys.privateKey));
r = await call(ctl.subscribe, { body: { subscription: { ...good, endpoint: 'https://evil.example/x' } } });
assert.equal(r.code, 400);
r = await call(ctl.subscribe, { body: { subscription: good } });
assert.equal(r.code, 201); assert.equal(db.length, 1); assert.equal(db[0].userId, 'owner1'); assert.equal(db[0].role, 'owner');
r = await call(ctl.subscribe, { body: { subscription: good } });
assert.equal(db.length, 1, 'idempotent par point d’arrivée');
r = await call(ctl.status, { query: { endpoint: good.endpoint } });
assert.deepEqual([r.body.data.subscribed, r.body.data.devices, r.body.data.available], [true, 1, true]);
sent.length = 0;
r = await call(ctl.test);
assert.equal(r.code, 200); assert.equal(sent.length, 1);
assert.equal(sent[0].body.kind, 'test');
// l'abonnement d'un autre utilisateur n'est pas supprimé par moi
db.push({ endpoint: 'https://fcm.googleapis.com/other', userId: 'owner2' });
r = await call(ctl.unsubscribe, { body: { endpoint: 'https://fcm.googleapis.com/other' } });
assert.equal(db.length, 2);
r = await call(ctl.unsubscribe, { body: { endpoint: good.endpoint } });
assert.equal(r.code, 200); assert.equal(db.length, 1);
r = await call(ctl.unsubscribe, { body: {} }); assert.equal(r.code, 400);
// droits : titulaire seulement
me = { isOwner: false, companyId: COMPANY, permissions: {} };
for (const fn of [ctl.subscribe, ctl.unsubscribe, ctl.status, ctl.test]) { r = await call(fn, { body: { subscription: good, endpoint: good.endpoint } }); assert.equal(r.code, 403); }
me = { isAgent: true, companyId: COMPANY, permissions: {} };
r = await call(ctl.subscribe, { body: { subscription: good } }); assert.equal(r.code, 403);
me = { isOwner: true, companyId: COMPANY, permissions: {} };
r = await call(ctl.subscribe, { body: { companyId: '64b0000000000000000000c2', subscription: good } }); assert.equal(r.code, 403, 'autre centre');

console.log('webPush OK');
