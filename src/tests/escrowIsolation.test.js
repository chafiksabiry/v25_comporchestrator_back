// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/escrowIsolation.test.js
// /api/escrow/* : ISOLATION. Avant ce correctif, `authenticate` (JWT seul) était le seul contrôle : tout utilisateur connecté pouvait lire les
// portefeuilles / transactions / avis de n'importe quelle société, CRÉDITER un portefeuille sans paiement (POST /deposit), retirer, séquestrer,
// libérer, rembourser, annuler une commission, rétracter une vente, lire ou approuver les retraits d'agents d'une autre société, lire le
// portefeuille et les retraits de n'importe quel agent, déclencher le SMS de retrait d'un autre agent, lire les commissions HARX de la plateforme.
// Règles : lecture = propriétaire ou membre de CETTE société ; écriture = propriétaire de CETTE société ; routes agent = l'agent lui-même
// (identité du jeton) ; jamais d'agent sur une route société ; refus = 403 SANS AUCUNE lecture ni écriture (aucun appel base) ;
// service d'inscription indisponible = 503 (jamais ouvert). Base et service d'inscription simulés ; chaque appel de base est compté.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
delete process.env.HARX_ADMIN_USER_IDS;
const { default: WalletCompany } = await import('../models/WalletCompany.js');
const { default: AgentWithdrawal } = await import('../models/AgentWithdrawal.js');
const { default: RepTransaction } = await import('../models/RepTransaction.js');
const { default: HarxCommission } = await import('../models/HarxCommission.js');
const { default: EscrowWallet } = await import('../models/EscrowWallet.js');
const { escrowController: ctl } = await import('../controllers/escrowController.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');

const C1 = '64b0000000000000000000c1'; const C2 = '64b0000000000000000000c2';
const A1 = '64b0000000000000000000b1'; const A2 = '64b0000000000000000000b2';
const ID = '64b0000000000000000000e1';
let who; let registrationDown; let touched; let writes; let n = 0;
const saved = { log: console.log, warn: console.warn, error: console.error };

// Requête chaînable et « thenable » (find().sort().lean()…) qui compte l'appel.
const chain = (result) => { const c = { sort: () => c, limit: () => c, lean: () => c, select: () => c, populate: () => c, skip: () => c, then: (ok, ko) => Promise.resolve(result).then(ok, ko) }; return c; };
beforeEach(() => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  clearCompanyCache(); touched = 0; writes = 0; registrationDown = false; who = { companyId: C1, isOwner: true };
  // Toute lecture ou écriture de n'importe quel modèle passe par ces statiques (héritées de mongoose.Model) : on les compte toutes.
  for (const m of ['find', 'findOne', 'findById', 'countDocuments', 'aggregate', 'distinct', 'exists']) mongoose.Model[m] = function () { touched += 1; return chain(m === 'find' || m === 'aggregate' || m === 'distinct' ? [] : m === 'countDocuments' ? 0 : null); };
  for (const m of ['findOneAndUpdate', 'updateOne', 'updateMany', 'create', 'deleteOne', 'deleteMany', 'insertMany', 'bulkWrite', 'findByIdAndUpdate', 'findOneAndDelete', 'replaceOne']) mongoose.Model[m] = function () { touched += 1; writes += 1; return chain(null); };
  mongoose.Model.prototype.save = async function () { touched += 1; writes += 1; return this; };
  const coll = () => ({ find: () => { touched += 1; return { toArray: async () => [], sort() { return this; }, limit() { return this; }, project() { return this; } }; }, findOne: async () => { touched += 1; return null; }, updateOne: async () => { touched += 1; writes += 1; return {}; }, updateMany: async () => { touched += 1; writes += 1; return {}; }, aggregate: () => { touched += 1; return { toArray: async () => [] }; }, countDocuments: async () => { touched += 1; return 0; }, insertOne: async () => { touched += 1; writes += 1; return {}; } });
  const db = { collection: coll };
  Object.defineProperty(mongoose.connection, 'db', { get: () => db, configurable: true });
  global.fetch = async () => { if (registrationDown) throw new Error('registration down'); return { ok: true, json: async () => ({ success: true, data: who }) }; };
});
after(() => { Object.assign(console, saved); });

// Appelle un contrôleur comme Express : req.user = JWT décodé (userId), jeton présent.
const call = async (name, { params = {}, body = {}, query = {}, userId, token = true } = {}) => {
  let out; const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code || 200, body: b }; return this; } };
  n += 1;
  await ctl[name]({ params, body, query, headers: token ? { authorization: 'Bearer tok' } : {}, user: userId === null ? undefined : { userId: userId || `u${n}` } }, res);
  return out;
};

// ───────── lectures par :companyId : propriétaire ou membre de CETTE société ─────────
const READS = ['getWallet', 'getTransactions', 'getGigsAndReps', 'getCompanyCallsAndTransactions', 'getPendingReviews', 'getAiAgreementRate', 'getAiDelegation', 'getAiAudits', 'getCompanyRepTransactions', 'getAgentWithdrawalsForCompany'];
// ───────── écritures portant companyId (corps ou chemin) : propriétaire de CETTE société ─────────
const OWNER_WRITES = {
  withdraw: { body: { companyId: C1, amount: 5 } },
  lockFunds: { body: { companyId: C1, amount: 5 } },
  releaseFunds: { params: { contractId: ID }, body: { companyId: C1 } },
  refundFunds: { params: { contractId: ID }, body: { companyId: C1 } },
  approveOrRefuseCallTransaction: { params: { callId: ID }, body: { companyId: C1, action: 'approve' } },
  retractSale: { params: { transactionId: ID }, body: { companyId: C1 } },
  awardRepBonus: { body: { companyId: C1, agentId: A1, amount: 5 } },
  setAiDelegation: { params: { companyId: C1 }, body: { enabled: false } },
};
// ───────── objets de la société de l'appelant (aucun companyId dans la requête) : propriétaire ─────────
const OWN_OBJECT = {
  approveOrRefuseAgentWithdrawal: { params: { withdrawalId: ID }, body: { action: 'approve' } },
  cancelCallCommission: { params: { callId: ID }, body: {} },
  respondToAiAudit: { params: { repTransactionId: ID }, body: { confirm: true } },
  approveOrRefuseCallCommission: { params: { repTransactionId: ID }, body: { action: 'approve' } },
};
// ───────── routes agent : l'agent lui-même (identité du jeton) ─────────
const AGENT_SELF = {
  getAgentWallet: { params: { agentId: A1 } },
  getAgentWithdrawals: { params: { agentId: A1 } },
  getAgentTransactions: { params: { agentId: A1 } },
  requestAgentWithdrawalOtp: { body: { agentId: A1 } },
  requestAgentWithdrawal: { body: { agentId: A1, amount: 5, method: 'bank', code: '123456' } },
};

const strangers = [
  ['propriétaire d\'une AUTRE société', { companyId: C2, isOwner: true }],
  ['membre d\'une AUTRE société', { companyId: C2, isOwner: false }],
  ['agent', { companyId: C1, isOwner: false, isAgent: true }],
  ['utilisateur sans société', { companyId: null, isOwner: true }],
];

for (const name of READS) {
  test(`${name} : refuse (403) autre société / agent / sans société, sans aucune lecture ni écriture ; 503 si inscription indisponible`, async () => {
    for (const [label, identity] of strangers) {
      who = identity; clearCompanyCache(); touched = 0;
      const r = await call(name, { params: { companyId: C1 } });
      assert.equal(r.code, 403, `${name} ${label}`); assert.ok(!('data' in r.body), label); assert.equal(touched, 0, `${name} ${label} : aucun appel base`);
    }
    registrationDown = true; clearCompanyCache(); touched = 0;
    const down = await call(name, { params: { companyId: C1 } });
    assert.equal(down.code, 503); assert.equal(touched, 0);
  });
}

for (const [name, req] of Object.entries(OWNER_WRITES)) {
  test(`${name} : propriétaire de CETTE société seulement (autre société / membre / agent / sans société : 403, aucun appel base ; 503 si inscription indisponible)`, async () => {
    for (const [label, identity] of [...strangers, ['membre de la MÊME société', { companyId: C1, isOwner: false }]]) {
      who = identity; clearCompanyCache(); touched = 0; writes = 0;
      const r = await call(name, req);
      assert.equal(r.code, 403, `${name} ${label}`); assert.equal(touched, 0, `${name} ${label} : aucun appel base`); assert.equal(writes, 0);
    }
    registrationDown = true; clearCompanyCache(); touched = 0;
    const down = await call(name, req);
    assert.equal(down.code, 503); assert.equal(touched, 0);
  });
}

for (const [name, req] of Object.entries(OWN_OBJECT)) {
  test(`${name} : membre / agent / sans société refusés (403, aucun appel base) ; 503 si inscription indisponible`, async () => {
    for (const [label, identity] of [['membre de la société', { companyId: C1, isOwner: false }], ['agent', { companyId: C1, isOwner: false, isAgent: true }], ['utilisateur sans société', { companyId: null, isOwner: true }]]) {
      who = identity; clearCompanyCache(); touched = 0; writes = 0;
      const r = await call(name, req);
      assert.equal(r.code, 403, `${name} ${label}`); assert.equal(touched, 0, `${name} ${label}`); assert.equal(writes, 0);
    }
    registrationDown = true; clearCompanyCache(); touched = 0;
    const down = await call(name, req);
    assert.equal(down.code, 503); assert.equal(touched, 0);
  });
}

for (const [name, req] of Object.entries(AGENT_SELF)) {
  test(`${name} : seul l'agent concerné (identité du jeton) ; un autre utilisateur ou un jeton sans identité : refus sans aucun appel base`, async () => {
    const other = await call(name, { ...req, userId: A2 });
    assert.equal(other.code, 403, name); assert.equal(touched, 0); assert.equal(writes, 0);
    const owner = await call(name, { ...req, userId: 'company-owner-1' });
    assert.equal(owner.code, 403, name); assert.equal(touched, 0);
    const anonymous = await call(name, { ...req, userId: null });
    assert.equal(anonymous.code, 401, name); assert.equal(touched, 0);
  });
}

test('POST /deposit : plus aucun crédit sans paiement (410), même pour le propriétaire de sa propre société, sans aucun appel base', async () => {
  const r = await call('deposit', { body: { companyId: C1, amount: 1000000 } });
  assert.equal(r.code, 410); assert.equal(r.body.code, 'deposit_disabled'); assert.equal(touched, 0); assert.equal(writes, 0);
});

test('GET /harx/commissions : commissions de la PLATEFORME, refusées à tout utilisateur hors liste d\'administrateurs (403, aucun appel base)', async () => {
  const r = await call('getHarxCommissions', { userId: 'someone' });
  assert.equal(r.code, 403); assert.equal(touched, 0);
  process.env.HARX_ADMIN_USER_IDS = ' admin-1 , admin-2 ';
  try {
    const refused = await call('getHarxCommissions', { userId: 'someone' });
    assert.equal(refused.code, 403); assert.equal(touched, 0);
    HarxCommission.find = () => { touched += 1; return chain([{ amount: 3 }]); };
    const ok = await call('getHarxCommissions', { userId: 'admin-2' });
    assert.equal(ok.code, 200); assert.equal(ok.body.data.length, 1);
  } finally { delete process.env.HARX_ADMIN_USER_IDS; }
});

// ───────── objets d'une AUTRE société : introuvables (404), jamais modifiés ─────────
test('cancelCallCommission / respondToAiAudit / approveOrRefuseCallCommission : la commission d\'une AUTRE société est introuvable (404) et jamais modifiée ni créditée', async () => {
  const foreign = { _id: ID, companyId: C2, repId: A1, type: 'call_validated', status: 'pending_review', amount: 50, auditFlag: true, sourceId: ID, reviewDeadlineAt: new Date(Date.now() + 86400000), save: async () => { writes += 1; } };
  const scoped = (q) => !q.companyId || String(q.companyId) === String(foreign.companyId);
  RepTransaction.findOne = (q) => { touched += 1; return chain(scoped(q) ? foreign : null); };
  RepTransaction.findById = () => { touched += 1; return chain(foreign); };
  who = { companyId: C1, isOwner: true };
  for (const [name, req] of Object.entries({ cancelCallCommission: OWN_OBJECT.cancelCallCommission, respondToAiAudit: OWN_OBJECT.respondToAiAudit, approveOrRefuseCallCommission: OWN_OBJECT.approveOrRefuseCallCommission })) {
    writes = 0; clearCompanyCache();
    const r = await call(name, req);
    assert.equal(r.code, 404, name); assert.equal(writes, 0, `${name} : aucune écriture`);
    assert.equal(foreign.status, 'pending_review', name);
  }
});

test('approveOrRefuseAgentWithdrawal : le retrait d\'une AUTRE société est introuvable (404), et un retrait déjà traité ne se retraite pas (409)', async () => {
  const rows = [{ _id: ID, companyId: C2, status: 'pending' }, { _id: '64b0000000000000000000e2', companyId: C1, status: 'completed' }];
  AgentWithdrawal.findOneAndUpdate = async (f) => { touched += 1; const w = rows.find((x) => String(x._id) === String(f._id) && String(x.companyId) === String(f.companyId) && x.status === f.status); if (w) { writes += 1; Object.assign(w, { status: 'completed' }); w.save = async () => {}; } return w || null; };
  AgentWithdrawal.findOne = async (f) => { touched += 1; return rows.find((x) => String(x._id) === String(f._id) && String(x.companyId) === String(f.companyId)) || null; };
  who = { companyId: C1, isOwner: true };
  const foreign = await call('approveOrRefuseAgentWithdrawal', { params: { withdrawalId: ID }, body: { action: 'approve' } });
  assert.equal(foreign.code, 404); assert.equal(writes, 0); assert.equal(rows[0].status, 'pending');
  clearCompanyCache();
  const done = await call('approveOrRefuseAgentWithdrawal', { params: { withdrawalId: '64b0000000000000000000e2' }, body: { action: 'refuse' } });
  assert.equal(done.code, 409); assert.equal(writes, 0); assert.equal(rows[1].status, 'completed');
});

test('approveOrRefuseCallTransaction : un appel d\'une AUTRE société est introuvable (404), rien n\'est écrit', async () => {
  const db = { collection: () => ({ findOne: async () => { touched += 1; return { _id: ID, companyId: C2 }; }, updateOne: async () => { writes += 1; return {}; }, insertOne: async () => { writes += 1; return {}; }, find: () => ({ toArray: async () => [] }) }) };
  Object.defineProperty(mongoose.connection, 'db', { get: () => db, configurable: true });
  who = { companyId: C1, isOwner: true };
  const r = await call('approveOrRefuseCallTransaction', { params: { callId: ID }, body: { companyId: C1, action: 'approve' } });
  assert.equal(r.code, 404); assert.equal(writes, 0);
});

// ───────── chemins légitimes (rien de cassé) ─────────
test('le propriétaire et un membre lisent SA société (getTransactions, getPendingReviews) ; l\'agent lit son propre retrait', async () => {
  for (const isOwner of [true, false]) {
    who = { companyId: C1, isOwner }; clearCompanyCache();
    const t = await call('getTransactions', { params: { companyId: C1 } });
    assert.equal(t.code, 200); assert.equal(t.body.success, true);
    const p = await call('getPendingReviews', { params: { companyId: C1 } });
    assert.equal(p.code, 200);
  }
  AgentWithdrawal.find = () => { touched += 1; return chain([{ _id: ID, agentId: A1 }]); };
  const mine = await call('getAgentWithdrawals', { params: { agentId: A1 }, userId: A1 });
  assert.equal(mine.code, 200); assert.equal(mine.body.data.length, 1);
});

test('retrait escrow du propriétaire : décrément ATOMIQUE conditionné au solde (deux retraits simultanés ne dépassent pas le solde)', async () => {
  const wallet = { companyId: C1, balance: 100 };
  WalletCompany.findOne = async () => { touched += 1; return { ...wallet }; };
  WalletCompany.findOneAndUpdate = async (filter, update) => {
    writes += 1;
    if (String(filter.companyId) !== wallet.companyId) return null;
    if (filter.balance?.$gte !== undefined && wallet.balance < filter.balance.$gte) return null;
    wallet.balance = Number((wallet.balance + (update.$inc?.balance || 0)).toFixed(2)); return { ...wallet };
  };
  who = { companyId: C1, isOwner: true };
  const results = await Promise.all([call('withdraw', { body: { companyId: C1, amount: 80 } }), call('withdraw', { body: { companyId: C1, amount: 80 } })]);
  assert.deepEqual(results.map((r) => r.code).sort(), [200, 400]);
  assert.equal(wallet.balance, 20);
  const bad = await call('withdraw', { body: { companyId: C1, amount: 'abc' } });
  assert.equal(bad.code, 400); assert.equal(wallet.balance, 20);
});

test('annulation de commission par le propriétaire : créditée UNE seule fois même si la requête est rejouée ou simultanée', async () => {
  const tx = { _id: ID, companyId: C1, repId: A1, type: 'call_validated', status: 'credited', amount: 50, sourceId: ID, reviewDeadlineAt: new Date(Date.now() + 86400000), meta: {}, save: async () => {} };
  let credits = 0;
  // Comme MongoDB : chaque lecture renvoie un document INDÉPENDANT (deux requêtes simultanées lisent toutes deux « credited »).
  RepTransaction.findOne = (q) => { touched += 1; return chain(String(q.companyId ?? C1) === C1 && q.sourceId === ID ? { ...tx, meta: {}, save: async function () { writes += 1; Object.assign(tx, { status: this.status, companyDecision: this.companyDecision }); } } : null); };
  RepTransaction.findOneAndUpdate = async (f, u) => { writes += 1; if (tx.status === 'reversed' || tx.status === 'refused') return null; Object.assign(tx, u.$set || {}); return tx; };
  WalletCompany.findOneAndUpdate = async (f, u) => { writes += 1; credits += u.$inc.balance; return {}; };
  who = { companyId: C1, isOwner: true };
  const results = await Promise.all([call('cancelCallCommission', { params: { callId: ID } }), call('cancelCallCommission', { params: { callId: ID } })]);
  assert.equal(credits, 50, 'le portefeuille n\'est crédité qu\'une fois');
  assert.equal(results.filter((r) => r.code === 200).length, 1);
  assert.equal(results.filter((r) => r.code === 409).length, 1);
});

test('séquestre : le propriétaire verrouille et libère SES minutes ; le contrat se cherche dans SA société', async () => {
  const contract = { _id: ID, status: 'locked', amount: 5 };
  const wallet = { companyId: C1, minutes: 50, escrow: 5, contracts: { id: (i) => (String(i) === ID ? contract : null) }, save: async () => { writes += 1; } };
  EscrowWallet.findOne = async (q) => { touched += 1; return String(q.companyId) === C1 ? wallet : null; };
  who = { companyId: C1, isOwner: true };
  const ok = await call('releaseFunds', { params: { contractId: ID }, body: { companyId: C1 } });
  assert.equal(ok.code, 200); assert.equal(contract.status, 'released');
  who = { companyId: C2, isOwner: true }; clearCompanyCache();
  const stranger = await call('refundFunds', { params: { contractId: ID }, body: { companyId: C1 } });
  assert.equal(stranger.code, 403);
});

test('retractSale : la vente d\'une AUTRE société est refusée (403) même si la transaction d\'origine n\'a pas de companyId ; aucune écriture', async () => {
  const db = { collection: () => ({ findOne: async () => { touched += 1; return { _id: ID }; }, updateOne: async () => { writes += 1; return {}; }, find: () => ({ toArray: async () => [] }) }) };
  Object.defineProperty(mongoose.connection, 'db', { get: () => db, configurable: true });
  const foreign = { _id: ID, companyId: C2, repId: A1, type: 'transaction', status: 'earned', amount: 50, sourceId: ID, save: async () => { writes += 1; } };
  RepTransaction.findOne = (q) => { touched += 1; return chain(foreign); };
  who = { companyId: C1, isOwner: true };
  const r = await call('retractSale', { params: { transactionId: ID }, body: { companyId: C1 } });
  assert.equal(r.code, 403); assert.equal(writes, 0); assert.equal(foreign.status, 'earned');
});
