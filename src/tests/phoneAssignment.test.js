// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/phoneAssignment.test.js
// Lot 1 « agents et lignes » : affectation des lignes aux agents (titulaire seul, une ligne par agent, ligne libre réaffectable, libération
// explicite avec confirmation), rôles par offre, rétrocompatibilité des lignes sans champ, achat avec agent. Base, Stripe et opérateurs SIMULÉS.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';

const { phoneNumberController } = await import('../controllers/phoneNumberController.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');
const { stripeService } = await import('../services/stripeService.js');
const { paypalService } = await import('../services/paypalService.js');
const { phoneNumberService } = await import('../services/phoneNumberService.js');
const { listLinesFor } = await import('../services/phoneNumberList.js');
const LA = await import('../services/lineAssignment.js');
const { PhoneNumber } = await import('../models/PhoneNumber.js');
const { Subscription } = await import('../models/Subscription.js');
const PhoneNumberPayment = (await import('../models/PhoneNumberPayment.js')).default;
const { phoneNumberRoutes } = await import('../routes/phoneNumber.js');

const C1 = '64b0000000000000000000a1';
const C2 = '64b0000000000000000000a2';
const AG1 = '64b0000000000000000000b1';
const AG2 = '64b0000000000000000000b2';
const AG_OUT = '64b0000000000000000000b9'; // agent d'un autre centre
const DAY = 24 * 60 * 60 * 1000;

// utilisateurs : rôle auprès du centre C1 (service d'inscription simulé)
const directory = {
  owner: { companyId: C1, isOwner: true },
  member: { companyId: C1, isOwner: false },
  agent: { companyId: C1, isOwner: false, isAgent: true },
  ownerC2: { companyId: C2, isOwner: true },
};

let country; let planMetadata; let lines; let payments; let calls; let fakeDb; let existingCount;

const mockRes = () => ({ statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
const reqAs = (user, body = {}, query = {}) => ({ body, query, headers: { authorization: 'Bearer tok' }, user: { userId: user } });

const OFFERS = {
  full_scope: { harx_product: 'callcenter', callcenter_tier: 'full_scope', phone_line_price_cents: '1999' },
  multi_clients: { harx_product: 'callcenter', callcenter_tier: 'multi_clients', phone_line_price_cents: '2499' },
  accueil: { harx_product: 'callcenter', callcenter_tier: 'accueil', phone_line_price_cents: '1499' },
  nomad: { harx_product: 'callcenter', callcenter_tier: 'nomad_solo' },
  taas: { stripe_plan: 'taas' },
};

let seq;
function addLine(fields = {}) {
  seq += 1;
  const id = `64d${String(seq).padStart(21, '0')}`;
  const doc = {
    _id: id, companyId: C1, phoneNumber: `+3361234000${seq}`, provider: 'twilio', status: 'active', billingStatus: 'active',
    createdAt: new Date(Date.UTC(2026, 0, seq)), assignedAgentId: null,
    ...fields,
    async save() {
      // garde-fou en base : un agent n'a qu'une ligne par centre (index unique partiel)
      if (this.assignedAgentId && Object.values(lines).some((l) => l !== this && String(l.companyId) === String(this.companyId) && l.assignedAgentId === this.assignedAgentId)) {
        throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      }
      calls.push(['line.save', this._id]);
      return this;
    },
  };
  lines[id] = doc;
  return doc;
}
const lineOf = (id) => lines[id];
const setup = (offer) => { planMetadata = OFFERS[offer]; };

beforeEach(() => {
  clearCompanyCache();
  country = 'FR'; planMetadata = OFFERS.full_scope; lines = {}; payments = {}; calls = []; seq = 0; existingCount = null;

  global.fetch = async (url) => {
    const u = new URL(String(url));
    const d = directory[u.searchParams.get('userId')] || {};
    return { ok: true, json: async () => ({ success: true, data: { ...d, company: { profile: { country } } } }) };
  };

  // base partagée avec le service d'inscription : agents du centre C1
  fakeDb = {
    collection: (name) => ({
      findOne: async (q) => {
        if (name === 'users') return String(q._id) === AG1 || String(q._id) === AG2 ? { _id: q._id, employerCompanyId: String(q.employerCompanyId) === C1 ? q.employerCompanyId : null, typeUser: 'rep' } : null;
        return null;
      },
    }),
  };
  fakeDb.collection = (name) => ({
    findOne: async (q) => {
      if (name === 'users' && [AG1, AG2].includes(String(q._id)) && String(q.employerCompanyId) === C1 && q.typeUser === 'rep') return { _id: q._id };
      return null;
    },
  });
  Object.defineProperty(mongoose.connection, 'db', { get: () => fakeDb, configurable: true });

  Subscription.findOne = (q) => {
    if (q?.provider === 'stripe') return { sort: () => ({ lean: async () => ({ stripeCustomerId: 'cus_1' }) }) };
    return { populate: async () => (planMetadata ? { planId: { name: 'Offre', metadata: planMetadata } } : null) };
  };
  PhoneNumber.findOne = (q) => {
    const rows = Object.values(lines).filter((l) => Object.entries(q).every(([k, v]) => (k === '_id' ? String(l._id) === String(v) : String(l[k] ?? null) === String(v))));
    let out = rows;
    const c = { sort: (s) => { const [[k, dir]] = Object.entries(s); out = [...out].sort((a, b) => (new Date(a[k]) - new Date(b[k])) * dir); return c; }, select: () => c, lean: async () => out[0] || null, then: (r, j) => Promise.resolve(out[0] || null).then(r, j) };
    return c;
  };
  PhoneNumber.countDocuments = async () => (existingCount ?? Object.keys(lines).length);
  PhoneNumberPayment.findById = async (id) => payments[id] || null;
  PhoneNumberPayment.create = async (doc) => { const p = { ...doc, _id: '64e0000000000000000000e1', async save() { return this; } }; payments[p._id] = p; calls.push(['payment.create', { ...doc }]); return p; };
  PhoneNumberPayment.findByIdAndDelete = async () => {};
  PhoneNumberPayment.findOneAndUpdate = async (q, u) => { const p = payments[q._id]; if (!p) return null; if (u?.$set?.purchaseClaimedAt) { if (p.purchaseClaimedAt) return null; p.purchaseClaimedAt = u.$set.purchaseClaimedAt; } return p; };

  stripeService.isConfigured = () => true;
  stripeService.hasUsablePaymentMethod = async () => true;
  stripeService.createOneShotCheckoutSession = async (o) => { calls.push(['stripe.checkout', o]); return { id: 'cs_new', url: 'https://stripe.test/pay' }; };
  stripeService.cancelCheckoutAuthorization = async (ref) => { calls.push(['stripe.releaseAuth', ref]); };
  stripeService.refundCheckoutSession = async (ref) => { calls.push(['stripe.refund', ref]); };
  paypalService.isConfigured = () => true;
  phoneNumberService.assertTelnyxCanOrderNumber = async () => {};
  phoneNumberService.findClaimableInventoryNumber = async () => null;
  phoneNumberService.isRegulatoryBundleRequired = async () => false;
  phoneNumberService.deletePhoneNumber = async ({ id, companyId }) => { calls.push(['release', id, companyId]); delete lines[id]; return { message: 'terminated' }; };
  phoneNumberService.purchaseTwilioNumber = async (num, base, gig, company, options) => {
    calls.push(['number.purchase', num, options]);
    return addLine({ phoneNumber: num, companyId: company, ...(options.assignedRole ? { assignedRole: options.assignedRole, assignedAgentId: options.assignedAgentId || null, assignedAt: options.assignedAt || null } : {}) });
  };
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
});

const names = () => calls.map((c) => c[0]);
const assignReq = (user, id, agentId, companyId = C1) => reqAs(user, { companyId, id, agentId });
async function assign(user, id, agentId, companyId = C1) { const r = mockRes(); await phoneNumberController.assignLineToAgent(assignReq(user, id, agentId, companyId), r); return r; }
async function unassign(user, id, companyId = C1) { const r = mockRes(); await phoneNumberController.unassignLineAgent(reqAs(user, { companyId, id }), r); return r; }
async function release(user, id, confirm, companyId = C1) { const r = mockRes(); await phoneNumberController.releaseLineExplicit(reqAs(user, { companyId, id, ...(confirm === undefined ? {} : { confirm }) }), r); return r; }

// ───────── 1. affectation ─────────
test('affecter une ligne libre à un agent du centre (Full Scope) : rôle agent, agent et date enregistrés', async () => {
  addLine(); // ligne incluse (management, la plus ancienne)
  const free = addLine();
  const r = await assign('owner', free._id, AG1);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.data.assignedRole, r.body.data.assignedAgentId], ['agent', AG1]);
  assert.ok(r.body.data.assignedAt);
  assert.equal(lineOf(free._id).assignedAgentId, AG1);
  // idempotent pour le même agent
  assert.equal((await assign('owner', free._id, AG1)).statusCode, 200);
});

test('une ligne par agent : un agent déjà titulaire d\'une ligne n\'en reçoit pas une seconde', async () => {
  addLine();
  const a = addLine(); const b = addLine();
  assert.equal((await assign('owner', a._id, AG1)).statusCode, 200);
  const r = await assign('owner', b._id, AG1);
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.code, 'AGENT_ALREADY_HAS_LINE');
  assert.equal(lineOf(b._id).assignedAgentId, null);
});

test('une ligne par agent : deux affectations simultanées du même agent -> une seule réussit (verrou de centre)', async () => {
  addLine();
  const a = addLine(); const b = addLine();
  const [r1, r2] = await Promise.all([assign('owner', a._id, AG1), assign('owner', b._id, AG1)]);
  assert.deepEqual([r1.statusCode, r2.statusCode].sort(), [200, 409]);
  assert.equal(Object.values(lines).filter((l) => l.assignedAgentId === AG1).length, 1);
});

test('garde-fou en base : index unique partiel (companyId, assignedAgentId), et la violation est traduite en 409', async () => {
  const idx = PhoneNumber.schema.indexes().find(([f]) => f.assignedAgentId === 1 && f.companyId === 1);
  assert.ok(idx, 'index présent');
  assert.equal(idx[1].unique, true);
  assert.deepEqual(idx[1].partialFilterExpression, { assignedAgentId: { $type: 'string' } });
  // course entre deux instances : la base refuse la seconde écriture -> 409, pas 500
  addLine();
  const a = addLine(); const b = addLine({ assignedRole: 'agent', assignedAgentId: AG2 });
  const origFindOne = PhoneNumber.findOne;
  let hidden = false;
  PhoneNumber.findOne = (q) => (q?.assignedAgentId && !hidden ? (hidden = true, { then: (r) => Promise.resolve(null).then(r) }) : origFindOne(q));
  lineOf(a._id).assignedAgentId = null;
  b.assignedAgentId = AG1; // l'autre instance vient de l'affecter
  const r = await assign('owner', a._id, AG1);
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.code, 'AGENT_ALREADY_HAS_LINE');
});

// ───────── 2. droits et centre ─────────
test('titulaire seul : un responsable ou un agent reçoit 403 sur affectation, retrait et libération', async () => {
  addLine(); const l = addLine();
  for (const user of ['member', 'agent']) {
    const a = await assign(user, l._id, AG1); assert.equal(a.statusCode, 403, user); assert.equal(a.body.code, 'OWNER_ONLY');
    assert.equal((await unassign(user, l._id)).statusCode, 403, user);
    assert.equal((await release(user, l._id, true)).statusCode, 403, user);
  }
  assert.ok(lineOf(l._id) && lineOf(l._id).assignedAgentId === null, 'rien n\'a changé');
  assert.ok(!names().includes('release'));
});

test('le titulaire d\'un AUTRE centre ne touche pas ce centre (403) ; une ligne d\'un autre centre est introuvable (404)', async () => {
  addLine(); const l = addLine();
  const r = await assign('ownerC2', l._id, AG1, C1);
  assert.equal(r.statusCode, 403);
  const foreign = addLine({ companyId: C2 });
  const r2 = await assign('owner', foreign._id, AG1, C1);
  assert.equal(r2.statusCode, 404);
  assert.equal(r2.body.code, 'LINE_NOT_FOUND');
});

test('un agent hors du centre est refusé (403 AGENT_NOT_IN_COMPANY) ; un identifiant inconnu aussi ; agentId manquant -> 400', async () => {
  addLine(); const l = addLine();
  let r = await assign('owner', l._id, AG_OUT); assert.equal(r.statusCode, 403); assert.equal(r.body.code, 'AGENT_NOT_IN_COMPANY');
  r = await assign('owner', l._id, 'inconnu'); assert.equal(r.statusCode, 403);
  r = await assign('owner', l._id, undefined); assert.equal(r.statusCode, 400); assert.equal(r.body.code, 'AGENT_REQUIRED');
  assert.equal(lineOf(l._id).assignedAgentId, null);
});

test('routes : assign-agent, unassign-agent et release sont gardées par le contrôle d\'entreprise (authenticate + scope + handler)', () => {
  for (const path of ['/assign-agent', '/unassign-agent', '/release']) {
    const layer = phoneNumberRoutes.stack.find((l) => l.route?.path === path && l.route.methods.post);
    assert.ok(layer, path);
    assert.equal(layer.route.stack.length, 3, `${path} : authenticate, requireCompany, handler`);
  }
});

// ───────── 3. libre / réaffectation / libération ─────────
test('retrait d\'un agent : la ligne RESTE au centre (facturée, non supprimée), libre ; réaffectable à un autre agent', async () => {
  addLine(); const l = addLine({ stripeSubscriptionId: 'sub_1', billingModel: 'monthly', price: 19.99 });
  await assign('owner', l._id, AG1);
  const r = await unassign('owner', l._id);
  assert.equal(r.statusCode, 200);
  assert.deepEqual([r.body.data.assignedRole, r.body.data.assignedAgentId, r.body.data.assignedAt], ['agent', null, null]);
  assert.ok(lineOf(l._id), 'la ligne existe toujours');
  assert.ok(!names().includes('release') && !names().includes('stripe.refund'), 'aucune libération ni remboursement');
  assert.equal(lineOf(l._id).stripeSubscriptionId, 'sub_1', 'abonnement intact');
  assert.equal(lineOf(l._id).billingStatus, 'active');
  assert.equal((await unassign('owner', l._id)).statusCode, 200, 'idempotent');
  const again = await assign('owner', l._id, AG2);
  assert.equal(again.statusCode, 200);
  assert.equal(lineOf(l._id).assignedAgentId, AG2);
  // l'ancien agent est libre de recevoir une autre ligne
  const other = addLine();
  assert.equal((await assign('owner', other._id, AG1)).statusCode, 200);
});

test('affecter une ligne déjà occupée par un autre agent : refus 409 (il faut la libérer d\'abord)', async () => {
  addLine(); const l = addLine();
  await assign('owner', l._id, AG1);
  const r = await assign('owner', l._id, AG2);
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.code, 'LINE_ALREADY_ASSIGNED');
  assert.equal(lineOf(l._id).assignedAgentId, AG1);
});

test('libération : confirm:true OBLIGATOIRE (absent, faux, « true » ou 1 refusés), puis résiliation par le chemin existant (opérateur + abonnement)', async () => {
  addLine(); const l = addLine({ billingModel: 'monthly', stripeSubscriptionId: 'sub_1' });
  for (const bad of [undefined, false, 'true', 1, null]) {
    const r = await release('owner', l._id, bad);
    assert.equal(r.statusCode, 400, String(bad));
    assert.equal(r.body.code, 'CONFIRMATION_REQUIRED');
  }
  assert.ok(!names().includes('release') && lineOf(l._id), 'rien n\'est résilié sans confirmation');
  const r = await release('owner', l._id, true);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(calls.find((c) => c[0] === 'release').slice(1), [l._id, C1]);
  assert.ok(!lineOf(l._id));
  // ligne d'un autre centre : introuvable, rien d'appelé
  calls = [];
  const foreign = addLine({ companyId: C2 });
  phoneNumberService.deletePhoneNumber = async ({ id, companyId }) => { calls.push(['release', id, companyId]); throw Object.assign(new Error('Phone number not found'), { status: 404 }); };
  const r2 = await release('owner', foreign._id, true);
  assert.equal(r2.statusCode, 404);
});

// ───────── 4. rôles par offre ─────────
test('la ligne incluse (management) ne s\'affecte ni ne se libère de son agent : refus 409', async () => {
  const included = addLine(); addLine();
  for (const fn of [() => assign('owner', included._id, AG1), () => unassign('owner', included._id)]) {
    const r = await fn(); assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'MANAGEMENT_LINE_NOT_ASSIGNABLE');
  }
  addLine({ assignedRole: 'management' }); // rôle enregistré
  const explicit = Object.values(lines).at(-1);
  assert.equal((await assign('owner', explicit._id, AG1)).body.code, 'MANAGEMENT_LINE_NOT_ASSIGNABLE');
});

test('Accueil : lignes « shared », jamais affectées à une personne (409) ; Nomad et autres offres : refus (403)', async () => {
  addLine(); const l = addLine();
  setup('accueil');
  let r = await assign('owner', l._id, AG1); assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'SHARED_LINE_NOT_ASSIGNABLE');
  setup('nomad');
  r = await assign('owner', l._id, AG1); assert.equal(r.statusCode, 403); assert.equal(r.body.code, 'LINE_ASSIGNMENT_NOT_AVAILABLE');
  setup('taas');
  r = await assign('owner', l._id, AG1); assert.equal(r.statusCode, 403);
  planMetadata = null;
  r = await assign('owner', l._id, AG1); assert.equal(r.statusCode, 403, 'sans forfait');
  assert.equal(lineOf(l._id).assignedAgentId, null);
});

test('Multi-clients fonctionne comme Full Scope', async () => {
  setup('multi_clients');
  addLine(); const l = addLine();
  assert.equal((await assign('owner', l._id, AG2)).statusCode, 200);
});

test('une ligne en cours d\'achat ou de libération n\'est pas affectable', async () => {
  addLine();
  for (const billingStatus of ['pending', 'release_failed', 'terminated']) {
    const l = addLine({ billingStatus });
    const r = await assign('owner', l._id, AG1);
    assert.equal(r.statusCode, 409, billingStatus);
    assert.equal(r.body.code, 'LINE_NOT_ASSIGNABLE_STATE');
  }
});

// ───────── 5. liste enrichie et rétrocompatibilité ─────────
const listAs = (user, limitsMeta) => listLinesFor({ user: { userId: user }, headers: { authorization: 'Bearer tok' }, query: { companyId: C1 } }, {
  find: async () => Object.values(lines).sort((a, b) => b.createdAt - a.createdAt).map((l) => ({ ...l, save: undefined })),
  limits: async () => (limitsMeta === null ? null : (await import('../services/planLimits.js')).loadCompanyPlanLimits(C1)),
});

test('rétrocompatibilité (lignes SANS champ) : Full Scope / Multi-clients -> la plus ancienne = management, les autres = agents libres', async () => {
  const a = addLine(); const b = addLine(); const c = addLine();
  const rows = await listAs('owner');
  const byId = Object.fromEntries(rows.map((r) => [String(r._id), r]));
  assert.deepEqual([byId[a._id].assignedRole, byId[b._id].assignedRole, byId[c._id].assignedRole], ['management', 'agent', 'agent']);
  assert.ok(rows.every((r) => r.assignedAgentId === null && r.assignedAt === null));
  assert.ok(Object.values(lines).every((l) => l.assignedRole === undefined), 'aucune écriture en base : migration passive');
});

test('rétrocompatibilité : Accueil -> « shared » ; Nomad -> management ; TaaS / sans forfait -> aucun champ ajouté', async () => {
  addLine(); addLine();
  setup('accueil');
  assert.ok((await listAs('owner')).every((r) => r.assignedRole === 'shared'));
  setup('nomad');
  assert.ok((await listAs('owner')).every((r) => r.assignedRole === 'management'));
  setup('taas');
  const taas = await listAs('owner');
  assert.ok(taas.every((r) => !('assignedRole' in r) && !('assignedAgentId' in r)), 'vue inchangée');
  const none = await listAs('owner', null);
  assert.ok(none.every((r) => !('assignedRole' in r)));
});

test('liste : un rôle enregistré l\'emporte ; l\'agent affecté et la date sont exposés aux responsables ; la vue d\'une secrétaire n\'est PAS modifiée', async () => {
  addLine(); const l = addLine({ assignedRole: 'agent', assignedAgentId: AG1, assignedAt: new Date('2026-02-01') });
  const rows = await listAs('owner');
  const mine = rows.find((r) => String(r._id) === l._id);
  assert.deepEqual([mine.assignedRole, mine.assignedAgentId], ['agent', AG1]);
  const agentRows = await listAs('agent');
  assert.ok(agentRows.every((r) => !('assignedRole' in r) && !('assignedAgentId' in r)), 'secrétaire : mêmes champs qu\'avant');
});

test('liste : une panne de lecture du forfait ne casse pas la liste (lignes sans rôle déduit)', async () => {
  addLine();
  const rows = await listLinesFor({ user: { userId: 'owner' }, headers: { authorization: 'Bearer tok' }, query: { companyId: C1 } }, { find: async () => Object.values(lines), limits: async () => { throw new Error('mongo down'); } });
  assert.equal(rows.length, 1);
  assert.ok(!('assignedRole' in rows[0]));
});

// ───────── 6. achat avec agent ─────────
const paidPayment = (extra = {}) => { const p = { _id: '64e0000000000000000000e2', companyId: C1, phoneNumber: '+33612345678', provider: 'stripe', providerRef: 'cs_1', amount: 1999, currency: 'EUR', status: 'succeeded', async save() { return this; }, ...extra }; payments[p._id] = p; return p; };
const buy = (user, extra = {}) => reqAs(user, { phoneNumber: '+33612345678', companyId: C1, paymentId: '64e0000000000000000000e2', ...extra });
const optionsOfPurchase = () => calls.find((c) => c[0] === 'number.purchase')?.[2];

test('achat d\'une ligne supplémentaire avec assignedAgentId : la ligne naît affectée à l\'agent', async () => {
  addLine(); paidPayment();
  const res = mockRes();
  await phoneNumberController.purchaseTwilioNumber(buy('owner', { assignedAgentId: AG1 }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const o = optionsOfPurchase();
  assert.deepEqual([o.assignedRole, o.assignedAgentId], ['agent', AG1]);
  assert.ok(o.assignedAt);
});

test('achat sans assignedAgentId : ligne d\'agent LIBRE (Full Scope), « shared » (Accueil), aucune donnée (TaaS)', async () => {
  for (const [offer, expected] of [['full_scope', ['agent', null]], ['accueil', ['shared', null]], ['taas', [undefined, undefined]]]) {
    calls = []; lines = {}; payments = {}; seq = 0; setup(offer);
    addLine(); paidPayment();
    const res = mockRes();
    await phoneNumberController.purchaseTwilioNumber(buy('owner'), res);
    assert.equal(res.statusCode, 200, `${offer} ${JSON.stringify(res.body)}`);
    const o = optionsOfPurchase();
    assert.deepEqual([o.assignedRole, o.assignedAgentId], expected, offer);
    if (offer === 'taas') assert.ok(!('assignedRole' in o), 'offre sans modèle d\'agents : options inchangées');
  }
});

test('première ligne (incluse) : rôle management sans paiement ; avec un agent demandé -> refus', async () => {
  const res = mockRes();
  await phoneNumberController.purchaseTwilioNumber(reqAs('owner', { phoneNumber: '+33612345678', companyId: C1 }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(optionsOfPurchase().assignedRole, 'management');
  calls = []; lines = {}; seq = 0;
  const r2 = mockRes();
  await phoneNumberController.purchaseTwilioNumber(reqAs('owner', { phoneNumber: '+33612345678', companyId: C1, assignedAgentId: AG1 }), r2);
  assert.equal(r2.statusCode, 409);
  assert.equal(r2.body.code, 'MANAGEMENT_LINE_NOT_ASSIGNABLE');
  assert.ok(!names().includes('number.purchase'));
});

test('achat avec un agent refusé (déjà une ligne / hors centre / Accueil / pas titulaire) : AUCUN numéro commandé, paiement libéré ou remboursé', async () => {
  addLine(); addLine({ assignedRole: 'agent', assignedAgentId: AG1 });
  const cases = [
    ['owner', AG1, 'AGENT_ALREADY_HAS_LINE', 409],
    ['owner', AG_OUT, 'AGENT_NOT_IN_COMPANY', 403],
    ['member', AG2, 'OWNER_ONLY', 403],
    ['agent', AG2, 'OWNER_ONLY', 403],
  ];
  for (const [user, agent, code, status] of cases) {
    calls = [];
    paidPayment({ status: 'authorized' });
    const res = mockRes();
    await phoneNumberController.purchaseTwilioNumber(buy(user, { assignedAgentId: agent }), res);
    assert.equal(res.statusCode, status, `${user}/${agent}`);
    assert.equal(res.body.code, code);
    assert.ok(!names().includes('number.purchase'), 'aucun numéro commandé');
    assert.ok(names().includes('stripe.releaseAuth'), 'autorisation libérée');
    assert.equal(res.body.released, true);
  }
  setup('accueil');
  calls = []; paidPayment({ status: 'succeeded' });
  const acc = mockRes();
  await phoneNumberController.purchaseTwilioNumber(buy('owner', { assignedAgentId: AG2 }), acc);
  assert.equal(acc.body.code, 'SHARED_LINE_NOT_ASSIGNABLE');
  assert.ok(names().includes('stripe.refund'), 'paiement déjà encaissé : remboursé');
  assert.ok(!names().includes('number.purchase'));
});

test('achat : deux achats simultanés pour le même agent -> un seul numéro commandé, l\'autre refusé avant commande', async () => {
  addLine();
  paidPayment({ _id: '64e0000000000000000000e3', phoneNumber: '+33600000001', status: 'authorized' });
  paidPayment({ _id: '64e0000000000000000000e4', phoneNumber: '+33600000002', status: 'authorized' });
  stripeService.captureCheckoutSession = async () => {};
  const mk = (pid, num) => reqAs('owner', { phoneNumber: num, companyId: C1, paymentId: pid, assignedAgentId: AG1 });
  const [a, b] = [mockRes(), mockRes()];
  await Promise.all([
    phoneNumberController.purchaseTwilioNumber(mk('64e0000000000000000000e3', '+33600000001'), a),
    phoneNumberController.purchaseTwilioNumber(mk('64e0000000000000000000e4', '+33600000002'), b),
  ]);
  assert.equal(calls.filter((c) => c[0] === 'number.purchase').length, 1, 'un seul numéro commandé');
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
  assert.equal(Object.values(lines).filter((l) => l.assignedAgentId === AG1).length, 1);
});

test('checkout/init avec assignedAgentId : validé AVANT tout paiement, puis mémorisé sur le paiement', async () => {
  addLine();
  const body = (agent) => ({ phoneNumber: '+33612345678', companyId: C1, provider: 'stripe', assignedAgentId: agent });
  let res = mockRes();
  await phoneNumberController.initLineCheckout(reqAs('owner', body(AG_OUT)), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'AGENT_NOT_IN_COMPANY');
  assert.ok(!names().includes('payment.create') && !names().includes('stripe.checkout'), 'aucun paiement créé');
  res = mockRes();
  await phoneNumberController.initLineCheckout(reqAs('member', body(AG1)), res);
  assert.equal(res.statusCode, 403);
  assert.ok(!names().includes('payment.create'));
  res = mockRes();
  await phoneNumberController.initLineCheckout(reqAs('owner', body(AG1)), res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(calls.find((c) => c[0] === 'payment.create')[1].assignedAgentId, AG1);
  // sans agent : comportement inchangé, rien mémorisé
  calls = [];
  res = mockRes();
  await phoneNumberController.initLineCheckout(reqAs('owner', { phoneNumber: '+33612345678', companyId: C1, provider: 'stripe' }), res);
  assert.equal(res.statusCode, 201);
  assert.ok(!('assignedAgentId' in calls.find((c) => c[0] === 'payment.create')[1]));
});

test('récupération d\'un paiement orphelin : ligne créée avec son rôle ; agent mémorisé devenu invalide -> ligne créée LIBRE, jamais d\'échec', async () => {
  addLine();
  paidPayment({ assignedAgentId: AG_OUT });
  const res = mockRes();
  await phoneNumberController.recoverLinePayment(reqAs('owner', { paymentId: '64e0000000000000000000e2' }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const o = optionsOfPurchase();
  assert.deepEqual([o.assignedRole, o.assignedAgentId], ['agent', null]);
});

test('unité : offerKind, effectiveRole et oldestOf', () => {
  assert.equal(LA.offerKind({ product: 'callcenter', callcenterTier: 'full_scope' }), 'agents');
  assert.equal(LA.offerKind({ product: 'callcenter', callcenterTier: 'multi_clients' }), 'agents');
  assert.equal(LA.offerKind({ product: 'callcenter', callcenterTier: 'accueil' }), 'accueil');
  assert.equal(LA.offerKind({ product: 'callcenter', callcenterTier: 'nomad_solo' }), 'nomad');
  assert.equal(LA.offerKind({ product: 'callcenter', callcenterTier: null }), 'other');
  assert.equal(LA.offerKind(null), 'other');
  assert.equal(LA.effectiveRole({ _id: 'x', assignedRole: 'shared' }, 'agents', 'x'), 'shared');
  assert.equal(LA.oldestOf([{ _id: 2, createdAt: '2026-02-01' }, { _id: 1, createdAt: '2026-01-01' }]), 1);
});

// ───────── relecture adversariale du diff ─────────
test('achat finalisé par un responsable d\'un paiement initié par le titulaire avec un agent : l\'affectation validée à l\'init est conservée', async () => {
  addLine();
  paidPayment({ assignedAgentId: AG1 });
  const res = mockRes();
  await phoneNumberController.purchaseTwilioNumber(buy('member'), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual([optionsOfPurchase().assignedRole, optionsOfPurchase().assignedAgentId], ['agent', AG1]);
});

test('libération : une erreur d\'identification (service d\'inscription indisponible) répond avec son propre statut, pas « échec de libération »', async () => {
  addLine(); const l = addLine();
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  clearCompanyCache();
  const r = await release('owner', l._id, true);
  assert.equal(r.statusCode, 503);
  assert.notEqual(r.body.code, 'RELEASE_FAILED');
  assert.ok(!names().includes('release'));
});

test('entrées hostiles : identifiants non textuels ou opérateurs Mongo refusés sans erreur 500', async () => {
  addLine(); const l = addLine();
  for (const agentId of [{ $ne: null }, ['x'], 42]) {
    const r = await assign('owner', l._id, agentId);
    assert.ok([400, 403].includes(r.statusCode), JSON.stringify(agentId));
  }
  for (const id of [{ $ne: null }, ['x'], 42, 'pas-un-id']) {
    const r = await assign('owner', id, AG1);
    assert.equal(r.statusCode, 404, JSON.stringify(id));
  }
  const bad = mockRes();
  await phoneNumberController.assignLineToAgent(reqAs('owner', { companyId: { $ne: null }, id: l._id, agentId: AG1 }), bad);
  assert.equal(bad.statusCode, 400);
  assert.equal(lineOf(l._id).assignedAgentId, null);
});

// ───────── décision CTO : la ligne management ne se libère pas tant que le forfait est actif ─────────
test('/release refuse la ligne « management » (la plus ancienne, ou au rôle enregistré) tant que le forfait est actif : 409 MANAGEMENT_LINE_NOT_RELEASABLE', async () => {
  const included = addLine(); const agentLine = addLine();
  let r = await release('owner', included._id, true);
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.code, 'MANAGEMENT_LINE_NOT_RELEASABLE');
  assert.ok(!names().includes('release') && lineOf(included._id), 'rien n\'est résilié');
  const explicit = addLine({ assignedRole: 'management' });
  assert.equal((await release('owner', explicit._id, true)).body.code, 'MANAGEMENT_LINE_NOT_RELEASABLE');
  // Nomad : sa ligne unique est la ligne incluse
  setup('nomad');
  assert.equal((await release('owner', included._id, true)).body.code, 'MANAGEMENT_LINE_NOT_RELEASABLE');
  // les autres lignes restent libérables
  setup('full_scope');
  r = await release('owner', agentLine._id, true);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.ok(names().includes('release'));
});

test('/release : la confirmation reste vérifiée avant le refus, et sans forfait actif la ligne incluse est libérable', async () => {
  const included = addLine(); addLine();
  assert.equal((await release('owner', included._id, undefined)).body.code, 'CONFIRMATION_REQUIRED');
  planMetadata = null; // plus de forfait actif
  const r = await release('owner', included._id, true);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.ok(names().includes('release'));
});

test('/release : les offres sans modèle d\'agents (TaaS) et les lignes Accueil « shared » restent libérables ; un autre centre : 404', async () => {
  const a = addLine(); addLine();
  setup('taas');
  assert.equal((await release('owner', a._id, true)).statusCode, 200);
  setup('accueil');
  const shared = addLine();
  assert.equal((await release('owner', shared._id, true)).statusCode, 200);
  const foreign = addLine({ companyId: C2 });
  assert.equal((await release('owner', foreign._id, true)).statusCode, 404);
});
