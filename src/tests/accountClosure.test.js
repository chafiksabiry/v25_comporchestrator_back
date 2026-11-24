// Run: node --test src/tests/accountClosure.test.js
// Suppression du compte (maquettes A3, B4), arrêt / reprise de l'abonnement en fin de période (B1, B2, B2b), blocage d'un compte
// désactivé ou supprimé même avec un jeton déjà émis. Base, Stripe et Twilio simulés : aucun appel réel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET ||= 't';
process.env.TELNYX_API_KEY ||= 'x';
process.env.TWILIO_ACCOUNT_SID ||= 'ACtest';
process.env.TWILIO_AUTH_TOKEN ||= 'x';

const { purgeAccount, createAccountPurgeHandler, ACCOUNT_PURGE_SCOPE, CANCEL_REASON_ACCOUNT_DELETED, COMPANY_COLLECTIONS, USER_COLLECTIONS } = await import('../services/accountClosure.js');
const { createSubscriptionStopHandlers } = await import('../controllers/subscriptionStopController.js');
const { verifyServiceToken } = await import('../middleware/serviceToken.js');
const { authenticate } = await import('../middleware/auth.js');
const gate = await import('../services/accountGate.js');
const { stripeService } = await import('../services/stripeService.js');
const { phoneNumberService } = await import('../services/phoneNumberService.js');
const { subscriptionRoutes } = await import('../routes/subscription.js');
const { internalRoutes } = await import('../routes/internal.js');

const USER = '64b0000000000000000000a1';
const CO = '64b0000000000000000000c1';
const NUM = '+33142000007';
const AT = new Date('2026-11-24T10:42:00Z');

function res() {
  const r = { code: 200, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

/** Environnement simulé de la suppression : journal ordonné de chaque étape. */
function env(over = {}) {
  const steps = [];
  const deleted = [];
  const deps = {
    userEmail: async () => 'marie.dupont@exemple.fr',
    liveSubscriptions: async () => [{ _id: 'S1', companyId: CO, provider: 'stripe', stripeSubscriptionId: 'sub_offer', status: 'active' }],
    markVoluntary: async (s, at) => { steps.push(['voluntary', s.stripeSubscriptionId, at]); },
    stripeCancel: async (sid) => { steps.push(['stripeCancel', sid]); return { id: sid, status: 'canceled' }; },
    markCanceled: async (s) => { steps.push(['canceled', s.stripeSubscriptionId]); },
    linesOf: async () => [{ _id: 'L1', phoneNumber: NUM, companyId: CO, twilioId: 'PN1' }],
    returnLine: async (l) => { steps.push(['returnToInventory', l.phoneNumber]); return { returnedToInventory: true }; },
    latestSubscriptionId: async () => 'S1',
    addLifecycleEntry: async (sid, e) => { steps.push(['lifecycle', sid, e]); },
    voicemailsOf: async () => [{ _id: 'V1', cloudinaryPublicId: 'harx/vm/V1', audioStored: true }],
    eraseVoicemailMedia: async (vm) => { steps.push(['eraseMedia', vm._id]); },
    deleteVoicemails: async (ids) => { steps.push(['deleteVoicemails', ids]); return ids.length; },
    deleteMany: async (name, filter) => { deleted.push([name, filter]); return 1; },
    deleteCalls: async () => { steps.push(['deleteCalls']); return 3; },
    now: () => AT,
    log: () => {},
    warn: () => {},
    ...over,
  };
  return { deps, steps, deleted };
}

// ---------- Suppression : Stripe, numéro, données ----------

test('suppression : abonnement résilié tout de suite et marqué VOLONTAIRE avant l’appel Stripe, puis numéro remis en stock, puis données effacées', async () => {
  const { deps, steps, deleted } = env();
  const out = await purgeAccount({ userId: USER, companyIds: [CO] }, deps);
  const order = steps.map((s) => s[0]);
  assert.ok(order.indexOf('voluntary') < order.indexOf('stripeCancel'), 'marque volontaire posée AVANT la résiliation Stripe');
  assert.ok(order.indexOf('stripeCancel') < order.indexOf('returnToInventory'));
  assert.ok(order.indexOf('returnToInventory') < order.indexOf('deleteVoicemails'));
  assert.deepEqual(out.subscriptionsCanceled, ['sub_offer']);
  assert.deepEqual(out.numbersReturned, [NUM]);
  // Journal D3 : numéro « détaché » à la date de suppression (résiliation chez Twilio après 30 jours sans réaffectation, règle existante).
  const entry = steps.find((s) => s[0] === 'lifecycle');
  assert.equal(entry[1], 'S1');
  assert.equal(entry[2].status, 'detached');
  assert.equal(entry[2].phoneNumber, NUM);
  assert.equal(entry[2].note, CANCEL_REASON_ACCOUNT_DELETED);
  // Données effacées : chaque collection de la société et du compte, le journal d'appels, les messages du répondeur.
  const names = deleted.map((d) => d[0]);
  for (const n of ['Contact', 'IdentityVerification', 'IdentityDocumentFile', 'MinutesCompany', 'TokensCompany', 'Note', 'InboundCall']) assert.ok(names.includes(n), n);
  for (const n of USER_COLLECTIONS) assert.ok(names.includes(n), n);
  assert.equal(names.filter((n) => COMPANY_COLLECTIONS.includes(n)).length >= COMPANY_COLLECTIONS.length, true);
  assert.ok(order.includes('deleteCalls'));
  assert.ok(order.includes('eraseMedia'));
  // Traces comptables gardées : jamais effacées ici.
  for (const n of ['Subscription', 'CompanyPayment', 'TokensUsageLedger', 'WalletCompanyEntry']) assert.equal(names.includes(n), false, n);
  // Filtre : ObjectId ET texte (les collections n'ont pas toutes le même type de companyId).
  const contactFilter = deleted.find((d) => d[0] === 'Contact')[1];
  assert.equal(contactFilter.companyId.$in.length, 2);
});

test('suppression : appel Stripe réel = résiliation immédiate, sans prorata ni facture finale, motif « account_deleted »', async () => {
  const calls = [];
  const saved = { isConfigured: stripeService.isConfigured, getSharedClient: stripeService.getSharedClient };
  stripeService.isConfigured = () => true;
  stripeService.getSharedClient = () => ({ subscriptions: { cancel: async (id, params) => { calls.push([id, params]); return { id, status: 'canceled' }; } } });
  try {
    const { deps } = env();
    delete deps.stripeCancel;
    await purgeAccount({ userId: USER, companyIds: [CO] }, deps);
  } finally {
    Object.assign(stripeService, saved);
  }
  assert.deepEqual(calls, [['sub_offer', { prorate: false, invoice_now: false, cancellation_details: { comment: 'account_deleted' } }]]);
});

test('suppression : le numéro passe par phoneNumberService.returnToInventory (remise en stock, aucune résiliation Twilio)', async () => {
  const seen = [];
  const original = phoneNumberService.returnToInventory;
  phoneNumberService.returnToInventory = async (args) => { seen.push(args); return { returnedToInventory: true }; };
  try {
    const { deps } = env();
    delete deps.returnLine;
    const out = await purgeAccount({ userId: USER, companyIds: [CO] }, deps);
    assert.deepEqual(out.numbersReturned, [NUM]);
  } finally {
    phoneNumberService.returnToInventory = original;
  }
  assert.deepEqual(seen, [{ id: 'L1', companyId: CO }]);
});

test('suppression : abonnement déjà résilié chez Stripe = succès (on peut recommencer)', async () => {
  const { deps } = env({ stripeCancel: async () => { const e = new Error('No such subscription'); e.code = 'resource_missing'; throw e; } });
  const out = await purgeAccount({ userId: USER, companyIds: [CO] }, deps);
  assert.deepEqual(out.subscriptionsCanceled, ['sub_offer']);
});

test('suppression : Stripe en échec => ni numéro libéré ni donnée effacée', async () => {
  const { deps, steps, deleted } = env({ stripeCancel: async () => { throw new Error('stripe down'); } });
  await assert.rejects(() => purgeAccount({ userId: USER, companyIds: [CO] }, deps), (e) => e.code === 'STRIPE_CANCEL_FAILED' && e.status === 502);
  assert.equal(steps.some((s) => s[0] === 'returnToInventory'), false);
  assert.equal(deleted.length, 0);
});

test('suppression : remise en stock en échec => aucune donnée effacée', async () => {
  const { deps, deleted } = env({ returnLine: async () => { const e = new Error('twilio'); e.code = 'LINE_RELEASE_FAILED'; throw e; } });
  await assert.rejects(() => purgeAccount({ userId: USER, companyIds: [CO] }, deps), (e) => e.code === 'LINE_RELEASE_FAILED');
  assert.equal(deleted.length, 0);
});

test('suppression : audio du répondeur introuvable à la source => la copie HARX est quand même effacée', async () => {
  const { deps, steps } = env({ eraseVoicemailMedia: async () => { throw new Error('cloudinary 500'); } });
  await purgeAccount({ userId: USER, companyIds: [CO] }, deps);
  assert.ok(steps.some((s) => s[0] === 'deleteVoicemails'));
});

test('suppression : compte protégé (démonstration Apple) refusé, entrée invalide refusée, abonnement PayPal non traité', async () => {
  const apple = env({ userEmail: async () => 'chafik.sabiry4apple@harx.ai' });
  await assert.rejects(() => purgeAccount({ userId: USER, companyIds: [CO] }, apple.deps), (e) => e.code === 'PROTECTED_ACCOUNT' && e.status === 403);
  assert.equal(apple.steps.length, 0);
  await assert.rejects(() => purgeAccount({ userId: 'x', companyIds: [] }, env().deps), (e) => e.code === 'INVALID_USER');
  await assert.rejects(() => purgeAccount({ userId: USER, companyIds: ['nope'] }, env().deps), (e) => e.code === 'INVALID_COMPANY');
  const paypal = env({ liveSubscriptions: async () => [{ _id: 'S2', provider: 'paypal', providerRef: 'I-1', status: 'active' }] });
  await assert.rejects(() => purgeAccount({ userId: USER, companyIds: [CO] }, paypal.deps), (e) => e.code === 'SUBSCRIPTION_NOT_STRIPE');
});

test('suppression sans société (compte jamais allé au bout) : seules les données du compte sont effacées', async () => {
  const { deps, steps, deleted } = env();
  const out = await purgeAccount({ userId: USER, companyIds: [] }, deps);
  assert.deepEqual(out.subscriptionsCanceled, []);
  assert.equal(steps.length, 0);
  assert.deepEqual(deleted.map((d) => d[0]), USER_COLLECTIONS);
});

test('route interne : jeton de service `account-purge` exigé ; jeton utilisateur ou autre portée refusés', async () => {
  let purged = null;
  const handler = createAccountPurgeHandler({ verify: (h) => verifyServiceToken(h, [ACCOUNT_PURGE_SCOPE]), purge: async (a) => { purged = a; return { subscriptionsCanceled: [], numbersReturned: [], deleted: {} }; } });
  const sign = (p, o = { expiresIn: 60 }) => `Bearer ${jwt.sign(p, process.env.JWT_SECRET, o)}`;
  let r = res(); await handler({ headers: { authorization: sign({ userId: USER, typeUser: 'admin' }) }, body: { userId: USER } }, r);
  assert.equal(r.code, 401);
  r = res(); await handler({ headers: { authorization: sign({ scope: 'call-ended' }) }, body: { userId: USER } }, r);
  assert.equal(r.code, 401);
  r = res(); await handler({ headers: { authorization: sign({ scope: ACCOUNT_PURGE_SCOPE }, {}) }, body: { userId: USER } }, r);
  assert.equal(r.code, 401, 'jeton sans expiration refusé');
  r = res(); await handler({ headers: { authorization: sign({ scope: ACCOUNT_PURGE_SCOPE }) }, body: { userId: USER, companyIds: [CO] } }, r);
  assert.equal(r.code, 200);
  assert.deepEqual(purged, { userId: USER, companyIds: [CO] });
  assert.ok(internalRoutes.stack.some((l) => l.route?.path === '/accounts/purge' && l.route.methods.post));
});

// ---------- Arrêt en fin de période / reprise ----------

function stopEnv(over = {}) {
  const updates = [];
  const saved = [];
  const sub = { _id: 'S1', status: 'active', stripeSubscriptionId: 'sub_offer', cancelAtPeriodEnd: false, currentPeriodEnd: new Date('2026-12-14T00:00:00Z'), ...over.sub };
  const h = createSubscriptionStopHandlers({
    getAccess: over.getAccess || (async () => ({ companyId: CO, role: 'owner' })),
    findSubscription: async () => (over.noSub ? null : sub),
    getStripe: () => ({ subscriptions: { update: async (id, p) => { updates.push([id, p]); return { id, status: 'active', cancel_at_period_end: p.cancel_at_period_end, current_period_end: Date.parse('2026-12-14T00:00:00Z') / 1000 }; } } }),
    saveFields: async (s, f) => { saved.push(f); },
  });
  return { h, updates, saved, sub };
}
const req = (email = 'marie.dupont@exemple.fr') => ({ user: { userId: USER, email }, body: {} });

test('arrêter : cancel_at_period_end=true chez Stripe, rien n’est coupé avant la fin de la période payée ; date de fin renvoyée', async () => {
  const { h, updates, saved } = stopEnv();
  const r = res(); await h.cancelAtPeriodEnd(req(), r);
  assert.equal(r.code, 200);
  assert.deepEqual(updates, [['sub_offer', { cancel_at_period_end: true }]]);
  assert.equal(saved[0].cancelAtPeriodEnd, true);
  assert.equal(saved[0].status, 'active', 'l’abonnement reste actif jusqu’à la fin');
  assert.deepEqual(r.body.data, { status: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: '2026-12-14T00:00:00.000Z' });
});

test('reprendre : cancel_at_period_end=false ; déjà dans l’état voulu : aucun appel Stripe', async () => {
  const { h, updates } = stopEnv({ sub: { cancelAtPeriodEnd: true } });
  let r = res(); await h.resume(req(), r);
  assert.equal(r.code, 200);
  assert.deepEqual(updates, [['sub_offer', { cancel_at_period_end: false }]]);
  assert.equal(r.body.data.cancelAtPeriodEnd, false);
  const idem = stopEnv({ sub: { cancelAtPeriodEnd: true } });
  r = res(); await idem.h.cancelAtPeriodEnd(req(), r);
  assert.equal(r.code, 200);
  assert.equal(idem.updates.length, 0);
});

test('arrêter / reprendre : titulaire seulement, abonnement en cours seulement, compte de démonstration Apple jamais résilié', async () => {
  let e = stopEnv({ getAccess: async () => ({ companyId: CO, role: 'agent' }) });
  let r = res(); await e.h.cancelAtPeriodEnd(req(), r);
  assert.equal(r.code, 403);
  e = stopEnv({ noSub: true });
  r = res(); await e.h.cancelAtPeriodEnd(req(), r);
  assert.equal(r.code, 404);
  e = stopEnv({ sub: { status: 'past_due' } });
  r = res(); await e.h.cancelAtPeriodEnd(req(), r);
  assert.equal(r.code, 409);
  e = stopEnv();
  r = res(); await e.h.cancelAtPeriodEnd(req('chafik.sabiry4apple@harx.ai'), r);
  assert.equal(r.code, 403);
  assert.equal(r.body.code, 'PROTECTED_ACCOUNT');
  assert.equal(e.updates.length, 0);
  e = stopEnv({ sub: { cancelAtPeriodEnd: true } });
  r = res(); await e.h.getStopState(req(), r);
  assert.deepEqual(r.body.data, { status: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: '2026-12-14T00:00:00.000Z' });
});

test('routes : GET /stop, POST /cancel et POST /resume derrière authenticate', () => {
  for (const [path, method] of [['/stop', 'get'], ['/cancel', 'post'], ['/resume', 'post']]) {
    const layer = subscriptionRoutes.stack.find((l) => l.route?.path === path && l.route.methods[method]);
    assert.ok(layer, path);
    assert.equal(layer.route.stack[0].handle, authenticate, path);
  }
});

// ---------- Compte désactivé : jeton déjà émis refusé ----------

test('authenticate : jeton déjà émis d’un compte désactivé => 403 ACCOUNT_DISABLED ; supprimé => 401 ; actif => inchangé', async () => {
  const states = { [USER]: 'active' };
  gate.setAccountGateLookup(async (id) => states[id] ?? 'active');
  const token = `Bearer ${jwt.sign({ userId: USER, email: 'a@b.fr' }, process.env.JWT_SECRET)}`;
  const run = async () => { const r = res(); let ok = false; await authenticate({ headers: { authorization: token }, method: 'GET', originalUrl: '/x' }, r, () => { ok = true; }); return { r, ok }; };
  let out = await run();
  assert.equal(out.ok, true);
  states[USER] = 'disabled'; gate.forgetAccountState(USER);
  out = await run();
  assert.equal(out.ok, false);
  assert.equal(out.r.code, 403);
  assert.equal(out.r.body.code, 'ACCOUNT_DISABLED');
  states[USER] = 'deleted'; gate.forgetAccountState(USER);
  out = await run();
  assert.equal(out.r.code, 401);
  assert.equal(out.r.body.code, 'ACCOUNT_DELETED');
  // Lecture en échec : jamais de panne pour les comptes actifs.
  gate.setAccountGateLookup(async () => { throw new Error('db down'); });
  out = await run();
  assert.equal(out.ok, true);
  gate.setAccountGateLookup(null);
  // Sans base connectée : synchrone, accepté (tests existants inchangés).
  let sync = false;
  authenticate({ headers: { authorization: token }, method: 'GET', originalUrl: '/x' }, res(), () => { sync = true; });
  assert.equal(sync, true);
});
