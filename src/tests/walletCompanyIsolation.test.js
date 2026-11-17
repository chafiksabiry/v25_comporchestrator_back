// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/walletCompanyIsolation.test.js
// wallet-company : lecture = propriétaire ou membre de CETTE société ; retrait et approbation de retrait d'agent = propriétaire de CETTE société ;
// dépôt sans paiement supprimé. Autre société / agent / sans société : 403 sans aucune lecture ni écriture ; service d'inscription indisponible : 503.
// Base et service d'inscription simulés (portefeuille en mémoire avec écritures conditionnelles).
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
const { default: WalletCompany } = await import('../models/WalletCompany.js');
const { default: WalletCompanyEntry } = await import('../models/WalletCompanyEntry.js');
const { default: AgentWithdrawal } = await import('../models/AgentWithdrawal.js');
const { default: EscrowTransaction } = await import('../models/EscrowTransaction.js');
const { walletCompanyController: ctl } = await import('../controllers/walletCompanyController.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');

const C1 = '64b0000000000000000000c1'; const C2 = '64b0000000000000000000c2'; const W1 = '64b0000000000000000000a1'; const W2 = '64b0000000000000000000a2';
let who; let registrationDown; let touched; let wallet; let withdrawals; let entries; let n = 0;
const saved = { log: console.log, warn: console.warn, error: console.error };
const clone = (v) => structuredClone(v);
beforeEach(() => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  clearCompanyCache(); touched = 0; registrationDown = false; who = { companyId: C1, isOwner: true };
  wallet = { companyId: C1, balance: 100 }; entries = [];
  withdrawals = [{ _id: W1, companyId: C1, agentId: '64b0000000000000000000b1', amount: 50, status: 'pending', description: 'x', toObject() { return clone({ ...this, toObject: undefined }); } },
    { _id: W2, companyId: C2, agentId: '64b0000000000000000000b2', amount: 70, status: 'pending', description: 'y', toObject() { return clone({ ...this, toObject: undefined }); } }];
  const touch = () => { touched += 1; };
  WalletCompany.findOne = async (q) => { touch(); return String(q.companyId) === wallet.companyId ? { ...wallet, save: async function () { wallet.balance = this.balance; } } : null; };
  // retrait atomique : la condition de solde et la décrémentation sont une seule opération
  WalletCompany.findOneAndUpdate = async (filter, update) => {
    touch();
    if (String(filter.companyId) !== wallet.companyId) return null;
    if (filter.balance?.$gte !== undefined && wallet.balance < filter.balance.$gte) return null;
    wallet.balance = Number((wallet.balance + (update.$inc?.balance || 0)).toFixed(2));
    return { ...wallet };
  };
  WalletCompanyEntry.create = async (d) => { touch(); entries.push(d); return d; };
  WalletCompanyEntry.find = () => { touch(); const c = { sort: () => c, limit: () => c, lean: async () => clone(entries) }; return c; };
  EscrowTransaction.find = () => { touch(); const c = { sort: () => c, limit: () => c, lean: async () => [] }; return c; };
  AgentWithdrawal.find = (q) => { touch(); const rows = withdrawals.filter((w) => String(w.companyId) === String(q.companyId) && w.status === q.status); const c = { sort: async () => rows }; return c; };
  AgentWithdrawal.findOne = async (q) => { touch(); return withdrawals.find((w) => String(w._id) === String(q._id) && String(w.companyId) === String(q.companyId)) || null; };
  AgentWithdrawal.findOneAndUpdate = async (filter, update) => {
    touch();
    const w = withdrawals.find((x) => String(x._id) === String(filter._id) && String(x.companyId) === String(filter.companyId) && x.status === filter.status);
    if (!w) return null;
    Object.assign(w, update.$set || {}); w.save = async () => {}; return w;
  };
  global.fetch = async () => { if (registrationDown) throw new Error('registration down'); return { ok: true, json: async () => ({ success: true, data: who }) }; };
  const db = { collection: () => ({ findOne: async () => ({ personalInfo: { name: 'Agent', email: 'a@x.test' } }) }) };
  Object.defineProperty(mongoose.connection, 'db', { get: () => db, configurable: true });
});
after(() => { Object.assign(console, saved); });

const call = async (method, { params = {}, body = {}, query = {}, token = true } = {}) => {
  let out; const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code || 200, body: b }; return this; } };
  n += 1;
  await ctl[method]({ params, body, query, headers: token ? { authorization: 'Bearer tok' } : {}, user: { userId: `u${n}` } }, res);
  return out;
};
const READS = [['getWallet', () => ({ params: { companyId: C1 } })], ['getEntries', () => ({ params: { companyId: C1 } })], ['getAgentWithdrawals', () => ({ params: { companyId: C1 } })]];
const WRITES = [['withdraw', () => ({ body: { companyId: C1, amount: 10 } })], ['approveOrRefuseAgentWithdrawal', () => ({ params: { withdrawalId: W1 }, body: { action: 'approve' } })]];

test('lecture : propriétaire ET membre de la société lisent', async () => {
  for (const [name, args] of READS) {
    for (const identity of [{ companyId: C1, isOwner: true }, { companyId: C1, isOwner: false }]) {
      who = identity; clearCompanyCache();
      assert.equal((await call(name, args())).code, 200, `${name} ${JSON.stringify(identity)}`);
    }
  }
});

test('ISOLATION : autre société, agent, sans société => 403 sans AUCUNE lecture ni écriture (toutes les routes)', async () => {
  for (const identity of [{ companyId: C2, isOwner: true }, { companyId: C2, isOwner: false }, { companyId: C1, isOwner: false, isAgent: true }, { companyId: null, isOwner: true }]) {
    for (const [name, args] of [...READS, ...WRITES]) {
      who = identity; clearCompanyCache(); touched = 0;
      const r = await call(name, args());
      // Propriétaire d'une AUTRE société sur l'approbation : le retrait est cherché dans SA société, introuvable (404) et jamais modifié.
      const otherOwnerApprove = name === 'approveOrRefuseAgentWithdrawal' && identity.companyId === C2 && identity.isOwner;
      if (otherOwnerApprove) { assert.equal(r.code, 404, name); continue; }
      assert.equal(r.code, 403, `${name} ${JSON.stringify(identity)}`); assert.equal(touched, 0, `${name} : aucune lecture ni écriture`);
    }
  }
  assert.equal(wallet.balance, 100); assert.equal(withdrawals[0].status, 'pending'); assert.equal(entries.length, 0);
});

test('retrait et approbation : propriétaire seul — un MEMBRE de la société est refusé', async () => {
  who = { companyId: C1, isOwner: false };
  for (const [name, args] of WRITES) { clearCompanyCache(); touched = 0; assert.equal((await call(name, args())).code, 403, name); assert.equal(touched, 0); }
  assert.equal(wallet.balance, 100); assert.equal(withdrawals[0].status, 'pending');
});

test('service d\'inscription indisponible : 503 jamais ouvert ; sans jeton : 401', async () => {
  registrationDown = true;
  for (const [name, args] of [...READS, ...WRITES]) { clearCompanyCache(); touched = 0; assert.equal((await call(name, args())).code, 503, name); assert.equal(touched, 0); }
  registrationDown = false;
  assert.equal((await call('getWallet', { params: { companyId: C1 }, token: false })).code, 401);
});

test('DÉPÔT sans paiement supprimé : 410, portefeuille et registre intacts (le dépôt réel passe par le paiement)', async () => {
  for (const identity of [{ companyId: C1, isOwner: true }, { companyId: C2, isOwner: true }]) {
    who = identity; clearCompanyCache(); touched = 0;
    const r = await call('deposit', { body: { companyId: C1, amount: 1000000 } });
    assert.equal(r.code, 410); assert.equal(touched, 0);
  }
  assert.equal(wallet.balance, 100); assert.equal(entries.length, 0);
});

test('retrait : le propriétaire retire de SA société, montant validé, solde jamais négatif', async () => {
  let r = await call('withdraw', { body: { companyId: C1, amount: 30 } });
  assert.equal(r.code, 200); assert.equal(wallet.balance, 70); assert.equal(entries.length, 1); assert.equal(entries[0].amount, 30);
  assert.equal((await call('withdraw', { body: { companyId: C1, amount: 71 } })).code, 400, 'solde insuffisant'); assert.equal(wallet.balance, 70);
  for (const amount of [0, -5, 'abc', NaN, Infinity, null, undefined, '1e999', {}]) {
    assert.equal((await call('withdraw', { body: { companyId: C1, amount } })).code, 400, String(amount));
  }
  assert.equal(wallet.balance, 70);
  // companyId du corps d'une autre société : refusé même pour un propriétaire
  assert.equal((await call('withdraw', { body: { companyId: C2, amount: 1 } })).code, 403);
});

test('CONCURRENCE : deux retraits simultanés qui dépassent le solde ne passent pas tous les deux', async () => {
  const results = await Promise.all([call('withdraw', { body: { companyId: C1, amount: 80 } }), call('withdraw', { body: { companyId: C1, amount: 80 } })]);
  assert.deepEqual(results.map((r) => r.code).sort(), [200, 400]);
  assert.equal(wallet.balance, 20);
});

test('approbation : seul un retrait EN ATTENTE de la société de l\'appelant, une seule fois, action valide', async () => {
  // retrait d'une autre société : refusé, inchangé
  let r = await call('approveOrRefuseAgentWithdrawal', { params: { withdrawalId: W2 }, body: { action: 'approve' } });
  assert.ok([403, 404].includes(r.code)); assert.equal(withdrawals[1].status, 'pending');
  // action invalide : refusée (avant : toute valeur inconnue valait « refus »)
  for (const action of [undefined, 'APPROVE ', 'delete', 1]) assert.equal((await call('approveOrRefuseAgentWithdrawal', { params: { withdrawalId: W1 }, body: { action } })).code, 400, String(action));
  assert.equal(withdrawals[0].status, 'pending');
  r = await call('approveOrRefuseAgentWithdrawal', { params: { withdrawalId: W1 }, body: { action: 'approve' } });
  assert.equal(r.code, 200); assert.equal(withdrawals[0].status, 'completed'); assert.match(withdrawals[0].description, /Approuvé/);
  // déjà traité : ni nouvelle approbation ni retournement en refus (qui rendrait l'argent à l'agent)
  for (const action of ['approve', 'refuse']) assert.equal((await call('approveOrRefuseAgentWithdrawal', { params: { withdrawalId: W1 }, body: { action } })).code, 409);
  assert.equal(withdrawals[0].status, 'completed');
});

test('approbation d\'un retrait sans société enregistrée : refusée (propriété invérifiable)', async () => {
  withdrawals.push({ _id: '64b0000000000000000000a3', companyId: undefined, agentId: '64b0000000000000000000b3', amount: 5, status: 'pending', toObject() { return {}; } });
  const r = await call('approveOrRefuseAgentWithdrawal', { params: { withdrawalId: '64b0000000000000000000a3' }, body: { action: 'approve' } });
  assert.ok([403, 404].includes(r.code)); assert.equal(withdrawals[2].status, 'pending');
});

test('refus d\'un retrait de la société : statut « failed » une seule fois', async () => {
  const r = await call('approveOrRefuseAgentWithdrawal', { params: { withdrawalId: W1 }, body: { action: 'refuse' } });
  assert.equal(r.code, 200); assert.equal(withdrawals[0].status, 'failed'); assert.match(withdrawals[0].description, /Refusé/);
});

test('identifiants invalides : 400 sans lecture', async () => {
  assert.equal((await call('getWallet', { params: { companyId: '' } })).code, 400);
  assert.equal((await call('approveOrRefuseAgentWithdrawal', { params: { withdrawalId: 'not-an-id' }, body: { action: 'approve' } })).code, 400);
});
