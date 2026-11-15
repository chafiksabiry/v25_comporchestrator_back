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
    const rows = Object.values(lines).filter((l) => Object.entries(q).every(([k, v]) => (k === '_id' ? String(l._id) === String(v) : (v && typeof v === 'object' && Array.isArray(v.$nin) ? !v.$nin.map(String).includes(String(l[k])) : String(l[k] ?? null) === String(v)))));
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
  console.log = () => {}; console.warn = () => {}; console.error = process.env.DBG ? (...a) => process.stderr.write(a.map(String).join(' ') + '\n') : () => {};
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

// ───────── lot 1b : DELETE /:id et POST /terminate suivent la même règle que /release ─────────
async function legacyDelete(user, { id, body = {}, query = {}, params } = {}) {
  const r = mockRes(); const req = reqAs(user, body, query); req.params = params ?? (id ? { id } : {});
  await phoneNumberController.deleteNumber(req, r); return r;
}

test('DELETE /:id et POST /terminate : titulaire seul (responsable et agent : 403 OWNER_ONLY), rien n\'est résilié', async () => {
  addLine(); const l = addLine();
  for (const user of ['member', 'agent']) {
    let r = await legacyDelete(user, { id: l._id, body: { confirm: true } });
    assert.equal(r.statusCode, 403, user); assert.equal(r.body.code, 'OWNER_ONLY');
    r = await legacyDelete(user, { body: { phoneNumber: l.phoneNumber, confirm: true } });
    assert.equal(r.statusCode, 403, user); assert.equal(r.body.code, 'OWNER_ONLY');
  }
  assert.ok(lineOf(l._id)); assert.ok(!names().includes('release'));
});

test('DELETE /:id et POST /terminate : confirm:true OBLIGATOIRE (400 CONFIRMATION_REQUIRED), le centre est celui de la ligne', async () => {
  addLine(); const l = addLine();
  for (const confirm of [undefined, false, 'true', 1]) {
    const r = await legacyDelete('owner', { id: l._id, body: confirm === undefined ? {} : { confirm } });
    assert.equal(r.statusCode, 400, String(confirm)); assert.equal(r.body.code, 'CONFIRMATION_REQUIRED');
  }
  assert.equal((await legacyDelete('owner', { body: { id: l._id } })).body.code, 'CONFIRMATION_REQUIRED');
  assert.ok(lineOf(l._id)); assert.ok(!names().includes('release'));
  // un companyId menteur de l'appelant est sans effet : la ligne du centre C1 reste protégée du titulaire de C2
  const r = await legacyDelete('ownerC2', { id: l._id, body: { companyId: C2, confirm: true } });
  assert.equal(r.statusCode, 403); assert.ok(lineOf(l._id));
  // confirmé par le titulaire : résilié (corps JSON, puis ?confirm=true sans corps)
  let ok = await legacyDelete('owner', { id: l._id, body: { confirm: true } });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body)); assert.deepEqual(calls.find((c) => c[0] === 'release').slice(1), [String(l._id), C1]);
  const l2 = addLine();
  ok = await legacyDelete('owner', { id: l2._id, query: { confirm: 'true' } });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
});

test('DELETE /:id et POST /terminate : la ligne « management » est refusée (409 MANAGEMENT_LINE_NOT_RELEASABLE) tant que le forfait est actif ; ligne inconnue : 404 ; sans id : 400', async () => {
  const included = addLine(); addLine();
  let r = await legacyDelete('owner', { id: included._id, body: { confirm: true } });
  assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'MANAGEMENT_LINE_NOT_RELEASABLE');
  r = await legacyDelete('owner', { body: { phoneNumber: included.phoneNumber, confirm: true } });
  assert.equal(r.body.code, 'MANAGEMENT_LINE_NOT_RELEASABLE');
  assert.ok(lineOf(included._id)); assert.ok(!names().includes('release'));
  r = await legacyDelete('owner', { id: '64e0000000000000000000ff', body: { confirm: true } });
  assert.equal(r.statusCode, 404); assert.equal(r.body.code, 'LINE_NOT_FOUND');
  r = await legacyDelete('owner', { body: { confirm: true } });
  assert.equal(r.statusCode, 400);
});

test('lot 1b : les routes DELETE /:id et POST /terminate sont bien branchées sur deleteNumber', async () => {
  const layers = phoneNumberRoutes.stack.filter((l) => l.route && ((l.route.path === '/:id' && l.route.methods.delete) || (l.route.path === '/terminate' && l.route.methods.post)));
  assert.equal(layers.length, 2);
});

// ───────── lot 3c : GET /phone-numbers/agent-capacity (lecture seule) ─────────
async function capacity(user, companyId = C1) { const r = mockRes(); await phoneNumberController.getAgentCapacity(reqAs(user, {}, companyId === null ? {} : { companyId }), r); return r; }
function withCapacityDb(users, invitations) {
  const origFind = PhoneNumber.find; const origCollection = fakeDb.collection;
  PhoneNumber.find = (q) => ({ lean: async () => Object.values(lines).filter((l) => String(l.companyId) === String(q.companyId)) });
  fakeDb.collection = (name) => ({ ...origCollection(name), find: () => ({ toArray: async () => (name === 'users' ? users : invitations) }) });
  return () => { PhoneNumber.find = origFind; fakeDb.collection = origCollection; };
}

test('agent-capacity : agents, lignes affectées et libres (Full Scope) ; la ligne incluse n\'est ni affectée ni libre', async () => {
  addLine(); // incluse (management)
  const a = addLine({ assignedRole: 'agent', assignedAgentId: AG1 }); const free = addLine();
  const restore = withCapacityDb([{ _id: AG1 }, { _id: AG2 }], [{ userId: '64f000000000000000000099', status: 'pending' }, { status: 'pending' }, { userId: 'x', status: 'declined' }, { userId: 'm', status: 'accepted', kind: 'member' }]);
  try {
    const r = await capacity('owner');
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    const d = r.body.data;
    assert.equal(d.applicable, true);
    assert.deepEqual(d.lines, { total: 3, assigned: 1, free: 1, freeIds: [String(free._id)] });
    assert.equal(d.agents.find((x) => x.agentId === AG1).lineId, String(a._id));
    assert.equal(d.agents.find((x) => x.agentId === AG2).lineId, null);
    assert.equal(d.agents.length, 3); // AG1, AG2, invité en attente ; refusé et responsable exclus
    assert.equal(d.agentsWithoutLine, 3); // AG2 + invité + invitation sans compte
    assert.equal(d.canAddAgentWithoutPurchase, false);
    assert.equal((await capacity('member')).statusCode, 200);
  } finally { restore(); }
  assert.ok(!names().includes('line.save'), 'lecture seule');
});

test('agent-capacity : droits (agent 403, autre centre 403, sans companyId 400) ; offres sans agents : applicable:false', async () => {
  addLine(); addLine();
  const restore = withCapacityDb([], []);
  try {
    assert.equal((await capacity('agent')).statusCode, 403);
    assert.equal((await capacity('ownerC2')).statusCode, 403);
    assert.equal((await capacity('owner', null)).statusCode, 400);
    setup('accueil');
    const r = await capacity('owner');
    assert.equal(r.body.data.applicable, false); assert.equal(r.body.data.offer, 'accueil');
    // lignes libres plus nombreuses que les agents sans ligne : un agent de plus sans achat
    setup('full_scope');
    assert.equal((await capacity('owner')).body.data.canAddAgentWithoutPurchase, true);
  } finally { restore(); }
});

test('agent-capacity : la route GET est branchée', () => {
  assert.ok(phoneNumberRoutes.stack.some((l) => l.route?.path === '/agent-capacity' && l.route.methods.get));
});

// ───────── lot 3a : agent sans ligne (jeton, sortant, agentLineStatus) ─────────
directory[AG1] = { companyId: C1, isOwner: false, isAgent: true }; // l'agent se connecte avec son identifiant
const PAST = '2026-01-01T00:00:00Z'; const FUTURE = '2099-01-01T00:00:00Z';
const gateEnv = (extra = {}) => ({ LINE_ENFORCEMENT_FROM: PAST, ...extra });
const statusOf = (over = {}) => LA.agentLineStatus({ companyId: C1, userId: AG1, limits: { product: 'callcenter', callcenterTier: 'full_scope' }, db: fakeDb, env: gateEnv(), ...over });

test('agentLineStatus : règle inactive sans réglage ; active à partir de D (lu à chaque appel) ; seulement pour les offres à agents', async () => {
  addLine();
  assert.equal((await statusOf({ env: {} })).blocked, false);
  assert.equal((await statusOf({ env: {} })).enforced, false);
  assert.equal((await statusOf({ env: { LINE_ENFORCEMENT_FROM: 'pas une date' } })).blocked, false);
  let st = await statusOf();
  assert.deepEqual([st.applicable, st.enforced, st.blocked, st.line], [true, true, true, null]);
  assert.equal((await statusOf({ env: { LINE_ENFORCEMENT_FROM: FUTURE } })).blocked, false);
  assert.equal((await statusOf({ env: { LINE_ENFORCEMENT_FROM: FUTURE } })).notice, new Date(FUTURE).toISOString());
  assert.equal((await statusOf({ now: Date.parse(FUTURE) + 1, env: { LINE_ENFORCEMENT_FROM: FUTURE } })).blocked, true, 'après D');
  for (const limits of [{ product: 'callcenter', callcenterTier: 'accueil' }, { product: 'callcenter', callcenterTier: 'nomad_solo' }, null, { product: 'taas' }]) {
    assert.equal((await statusOf({ limits })).applicable, false);
    assert.equal((await statusOf({ limits })).blocked, false);
  }
});

test('agentLineStatus : la ligne doit être CELLE de l\'agent, dans CE centre, et exploitable', async () => {
  addLine();
  addLine({ assignedRole: 'agent', assignedAgentId: AG2 });
  assert.equal((await statusOf()).blocked, true, 'la ligne d\'un autre agent ne compte pas');
  addLine({ assignedRole: 'agent', assignedAgentId: AG1, companyId: C2 });
  assert.equal((await statusOf()).blocked, true, 'sa ligne d\'un autre centre ne compte pas');
  const mine = addLine({ assignedRole: 'agent', assignedAgentId: AG1, billingStatus: 'terminated' });
  assert.equal((await statusOf()).blocked, true, 'ligne résiliée');
  mine.billingStatus = 'active';
  const st = await statusOf();
  assert.equal(st.blocked, false); assert.equal(String(st.line._id), String(mine._id));
});

test('agentLineStatus : centre créé après le déploiement = règle immédiate ; centre existant = préavis jusqu\'à D', async () => {
  addLine();
  const env = { LINE_ENFORCEMENT_FROM: FUTURE, LINE_ENFORCEMENT_RULE_STARTS: '2026-06-01T00:00:00Z' };
  assert.equal((await statusOf({ env, subscriptionCreatedAt: new Date('2026-07-01T00:00:00Z') })).blocked, true, 'nouveau centre');
  const old = await statusOf({ env, subscriptionCreatedAt: new Date('2026-03-01T00:00:00Z') });
  assert.equal(old.blocked, false, 'centre existant');
  assert.equal(old.notice, new Date(FUTURE).toISOString());
  assert.equal((await statusOf({ env: { LINE_ENFORCEMENT_RULE_STARTS: '2026-06-01T00:00:00Z' }, subscriptionCreatedAt: new Date('2026-07-01T00:00:00Z') })).blocked, true, 'sans D, le nouveau centre est tout de même soumis');
  assert.equal((await statusOf({ env: { LINE_ENFORCEMENT_RULE_STARTS: '2026-06-01T00:00:00Z' }, subscriptionCreatedAt: new Date('2026-03-01T00:00:00Z') })).blocked, false);
  // date de création lue dans la base partagée (abonnement actif le plus récent du centre)
  const origCollection = fakeDb.collection;
  fakeDb.collection = (name) => (name === 'subscriptions'
    ? { find: () => ({ sort: () => ({ limit: () => ({ next: async () => ({ _id: 's1', createdAt: new Date('2026-08-01T00:00:00Z') }) }) }) }) }
    : origCollection(name));
  try { assert.equal((await statusOf({ env })).blocked, true); } finally { fakeDb.collection = origCollection; }
});


// contrôleur : jeton (sortant et entrant) et webhook sortant
const { signOutboundTicket } = await import('../services/browserOutbound.js');
const { InboundSettings } = { InboundSettings: (await import('../models/InboundSettings.js')).default };
const MinutesCompany = (await import('../models/MinutesCompany.js')).default;
const { VOICE_TOKEN_TTL_S } = await import('../services/voiceTokenService.js');
void VOICE_TOKEN_TTL_S;

function voiceStubs() {
  process.env.TWILIO_OUTBOUND_TWIML_APP_SID = 'AP00000000000000000000000000000000';
  const VST = mongoose.models.VoiceSigningKey;
  VST.findOne = () => ({ lean: async () => ({ sid: 'SK00000000000000000000000000000000', secret: 'secret' }) });
  InboundSettings.findOne = () => ({ select: () => ({ lean: async () => ({}) }) });
  PhoneNumber.find = () => { const c = { sort: () => c, limit: () => c, select: () => c, lean: async () => [{ phoneNumber: '+33612340001' }] }; return c; };
  if (MinutesCompany) MinutesCompany.findOne = () => ({ select: () => ({ lean: async () => ({ minutes: 100 }) }) });
}
const withRule = async (value, fn) => { const prev = process.env.LINE_ENFORCEMENT_FROM; if (value === undefined) delete process.env.LINE_ENFORCEMENT_FROM; else process.env.LINE_ENFORCEMENT_FROM = value; try { return await fn(); } finally { if (prev === undefined) delete process.env.LINE_ENFORCEMENT_FROM; else process.env.LINE_ENFORCEMENT_FROM = prev; } };
async function voiceTokenAs(user, body) { const r = mockRes(); const req = reqAs(user, body); req.get = () => 'orch.test'; await phoneNumberController.voiceToken(req, r); return r; }

test('jeton vocal : un agent SANS ligne est refusé (403 line_not_assigned), sortant comme entrant, une fois la règle active', async () => {
  voiceStubs(); addLine();
  await withRule(PAST, async () => {
    let r = await voiceTokenAs(AG1, { outbound: true, companyId: C1 });
    assert.equal(r.statusCode, 403); assert.equal(r.body.code, 'line_not_assigned'); assert.equal(r.body.error, 'line_not_assigned');
    r = await voiceTokenAs(AG1, {});
    assert.equal(r.statusCode, 403); assert.equal(r.body.code, 'line_not_assigned');
  });
});

test('jeton vocal : l\'agent AVEC sa ligne, le titulaire, et tout le monde tant que la règle est inactive ou en préavis, reçoivent un jeton', async () => {
  voiceStubs(); addLine();
  await withRule(PAST, async () => {
    addLine({ assignedRole: 'agent', assignedAgentId: AG1 });
    for (const body of [{ outbound: true, companyId: C1 }, {}]) { const r = await voiceTokenAs(AG1, body); assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.ok(r.body.data.token); }
    for (const body of [{ outbound: true, companyId: C1 }, {}]) assert.equal((await voiceTokenAs('owner', body)).statusCode, 200, 'le titulaire n\'est pas concerné');
  });
  lines = {}; seq = 0; addLine();
  await withRule(FUTURE, async () => { assert.equal((await voiceTokenAs(AG1, { outbound: true, companyId: C1 })).statusCode, 200, 'préavis'); assert.equal((await voiceTokenAs(AG1, {})).statusCode, 200); });
  await withRule(undefined, async () => { assert.equal((await voiceTokenAs(AG1, { outbound: true, companyId: C1 })).statusCode, 200, 'règle non configurée'); });
});

test('jeton vocal : la règle ne s\'applique pas aux offres sans agents (Accueil, Nomad) ni aux lignes d\'un autre centre', async () => {
  voiceStubs(); addLine();
  await withRule(PAST, async () => {
    setup('accueil'); assert.equal((await voiceTokenAs(AG1, { outbound: true, companyId: C1 })).statusCode, 200);
    setup('nomad'); assert.equal((await voiceTokenAs(AG1, {})).statusCode, 200);
  });
});

async function browserOutbound(user, { to = '+33612345678', secretary = true, companyId = C1 } = {}) {
  const identity = `cc-${user}`;
  const ticket = signOutboundTicket({ secret: process.env.TWILIO_AUTH_TOKEN, companyId, identity, secretary });
  const sent = { body: '' };
  const res = { type() { return this; }, status() { return this; }, send(x) { sent.body = x; return this; } };
  const req = { body: { To: to, From: `client:${identity}`, CompanyId: companyId, Ticket: ticket, CallSid: 'CA1' }, get: () => 'orch.test', headers: {}, query: {} };
  await phoneNumberController.handleBrowserOutbound(req, res);
  return sent.body;
}
const twilioLine = (fields) => addLine({ provider: 'twilio', twilioId: `PN${seq + 1}`, ...fields });

test('webhook sortant : l\'agent appelle depuis SA ligne (jamais celle du centre) ; sans ligne, refus une fois la règle active', async () => {
  voiceStubs();
  const included = twilioLine({ phoneNumber: '+33611110001' });
  PhoneNumber.findOne = ((orig) => (q) => (q?.provider === 'twilio' && q?.twilioId ? (() => { const c = { sort: () => c, lean: async () => included, then: (r) => Promise.resolve(included).then(r) }; return c; })() : orig(q)))(PhoneNumber.findOne);
  await withRule(PAST, async () => {
    let xml = await browserOutbound(AG1);
    assert.match(xml, /No line is assigned to you/); assert.match(xml, /language="en-US"/);
    assert.ok(!xml.includes('+33611110001'), 'pas de repli sur la ligne du centre');
    twilioLine({ phoneNumber: '+33622220002', assignedRole: 'agent', assignedAgentId: AG1 });
    xml = await browserOutbound(AG1);
    assert.ok(xml.includes('+33622220002'), 'SA ligne comme numéro appelant');
    assert.ok(!xml.includes('+33611110001'));
  });
});

test('webhook sortant : en préavis ou règle inactive, repli sur la ligne du centre ; l\'agent qui a sa ligne l\'utilise déjà ; le titulaire garde le comportement actuel', async () => {
  voiceStubs();
  const included = twilioLine({ phoneNumber: '+33611110001' });
  PhoneNumber.findOne = ((orig) => (q) => (q?.provider === 'twilio' && q?.twilioId && !q.assignedAgentId ? (() => { const c = { sort: () => c, lean: async () => included, then: (r) => Promise.resolve(included).then(r) }; return c; })() : orig(q)))(PhoneNumber.findOne);
  await withRule(FUTURE, async () => { assert.ok((await browserOutbound(AG1)).includes('+33611110001'), 'préavis : comportement actuel'); });
  await withRule(undefined, async () => { assert.ok((await browserOutbound(AG1)).includes('+33611110001')); });
  twilioLine({ phoneNumber: '+33622220002', assignedRole: 'agent', assignedAgentId: AG1 });
  await withRule(undefined, async () => { assert.ok((await browserOutbound(AG1)).includes('+33622220002'), 'sa ligne est préférée même avant D'); });
  await withRule(PAST, async () => { assert.ok((await browserOutbound('owner', { secretary: false })).includes('+33611110001'), 'titulaire inchangé'); });
});

test('outboundCheck : même refus line_not_assigned pour un agent sans ligne', async () => {
  voiceStubs(); addLine();
  await withRule(PAST, async () => {
    const r = mockRes(); await phoneNumberController.outboundCheck(reqAs(AG1, { companyId: C1, to: '+33612345678' }), r);
    assert.equal(r.statusCode, 403); assert.equal(r.body.code, 'line_not_assigned');
  });
});

// ───────── lot 3d : data.enforcement (agent-capacity), lineStatus (jeton vocal), messages en anglais ─────────
test('agent-capacity : data.enforcement { from, active } (D lu à chaque appel ; active = règle applicable à CE centre)', async () => {
  addLine(); addLine();
  const restore = withCapacityDb([], []);
  try {
    await withRule(undefined, async () => { assert.deepEqual((await capacity('owner')).body.data.enforcement, { from: null, active: false }); });
    await withRule(FUTURE, async () => { assert.deepEqual((await capacity('owner')).body.data.enforcement, { from: new Date(FUTURE).toISOString(), active: false }); });
    await withRule(PAST, async () => { assert.deepEqual((await capacity('owner')).body.data.enforcement, { from: new Date(PAST).toISOString(), active: true }); });
    // centre créé après le déploiement : active tout de suite, même avant D
    const prev = process.env.LINE_ENFORCEMENT_RULE_STARTS; process.env.LINE_ENFORCEMENT_RULE_STARTS = '2026-06-01T00:00:00Z';
    const origCollection = fakeDb.collection;
    fakeDb.collection = (name) => (name === 'subscriptions' ? { find: () => ({ sort: () => ({ limit: () => ({ next: async () => ({ _id: 's', createdAt: new Date('2026-08-01T00:00:00Z') }) }) }) }) } : origCollection(name));
    try { await withRule(FUTURE, async () => { assert.equal((await capacity('owner')).body.data.enforcement.active, true); }); }
    finally { fakeDb.collection = origCollection; if (prev === undefined) delete process.env.LINE_ENFORCEMENT_RULE_STARTS; else process.env.LINE_ENFORCEMENT_RULE_STARTS = prev; }
    // offres sans agents : D visible, jamais active
    setup('accueil');
    await withRule(PAST, async () => { const d = (await capacity('owner')).body.data; assert.equal(d.applicable, false); assert.deepEqual(d.enforcement, { from: new Date(PAST).toISOString(), active: false }); });
  } finally { restore(); }
});

test('jeton vocal : lineStatus { required, hasLine, notice } pour l\'agent (sortant et entrant) ; absent pour le titulaire ; le refus le porte aussi', async () => {
  voiceStubs(); addLine();
  // préavis, sans ligne : pas encore requis, la date D est annoncée
  await withRule(FUTURE, async () => {
    for (const body of [{ outbound: true, companyId: C1 }, {}]) {
      const r = await voiceTokenAs(AG1, body);
      assert.equal(r.statusCode, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.data.lineStatus, { required: false, hasLine: false, notice: new Date(FUTURE).toISOString() });
    }
    assert.equal((await voiceTokenAs('owner', { outbound: true, companyId: C1 })).body.data.lineStatus, undefined);
    assert.equal((await voiceTokenAs('owner', {})).body.data.lineStatus, undefined);
  });
  // règle active, avec ligne
  addLine({ assignedRole: 'agent', assignedAgentId: AG1 });
  await withRule(PAST, async () => {
    for (const body of [{ outbound: true, companyId: C1 }, {}]) assert.deepEqual((await voiceTokenAs(AG1, body)).body.data.lineStatus, { required: true, hasLine: true, notice: null });
  });
  // règle non configurée : jeton sortant -> statut informatif (jamais requis) ; jeton entrant -> champ absent (aucune recherche supplémentaire)
  await withRule(undefined, async () => {
    assert.deepEqual((await voiceTokenAs(AG1, { outbound: true, companyId: C1 })).body.data.lineStatus, { required: false, hasLine: true, notice: null });
    assert.equal((await voiceTokenAs(AG1, {})).body.data.lineStatus, undefined);
  });
});

test('line_not_assigned : message en ANGLAIS, code stable, lineStatus joint ; TwiML en voix anglaise', async () => {
  voiceStubs(); addLine();
  await withRule(PAST, async () => {
    const r = await voiceTokenAs(AG1, {});
    assert.equal(r.statusCode, 403);
    assert.deepEqual([r.body.code, r.body.error], ['line_not_assigned', 'line_not_assigned']);
    assert.equal(r.body.message, 'No line is assigned to you. Ask the account owner to assign you one.');
    assert.ok(!/[àâçéèêëîïôùûü]/i.test(r.body.message), 'aucun caractère accentué');
    assert.deepEqual(r.body.lineStatus, { required: true, hasLine: false, notice: null });
  });
});

test('buildRefusalTwiml : voix française par défaut (clients actuels inchangés), voix paramétrable', async () => {
  const { buildRefusalTwiml } = await import('../services/voicemailCallback.js');
  assert.match(buildRefusalTwiml('Appel non autorisé.'), /language="fr-FR" voice="Polly.Lea"/);
  assert.match(buildRefusalTwiml('No.', { language: 'en-US', voice: 'Polly.Joanna' }), /language="en-US" voice="Polly.Joanna"/);
});

test('3e-1 libération : échec opérateur / abonnement -> `reason` additif (code du service), code RELEASE_FAILED et message inchangés', async () => {
  addLine(); const l = addLine();
  for (const [code, status, message] of [['LINE_RELEASE_FAILED', 500, 'Échec de la résiliation chez twilio: boom'], ['LINE_SUBSCRIPTION_CANCEL_FAILED', 502, "Échec de la résiliation de l'abonnement de la ligne: stripe down"]]) {
    phoneNumberService.deletePhoneNumber = async () => { throw Object.assign(new Error(message), { status, code }); };
    const r = await release('owner', l._id, true);
    assert.deepEqual([r.statusCode, r.body.code, r.body.error, r.body.message, r.body.reason], [status, 'RELEASE_FAILED', 'RELEASE_FAILED', message, code]);
  }
  phoneNumberService.deletePhoneNumber = async () => { throw Object.assign(new Error('sans code'), { status: 500 }); };
  const r = await release('owner', l._id, true);
  assert.equal(r.body.reason, undefined, 'pas de reason sans code de service');
});
