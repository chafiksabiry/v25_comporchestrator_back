// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/tokensCompanyIsolation.test.js
// tokens-company : lecture = propriétaire ou membre de CETTE société ; écriture (fournisseurs IA) = propriétaire ; achat de jetons sans paiement
// supprimé ; charge-usage (service à service) reste ouvert par défaut (aucun appelant n'envoie d'identité) mais refuse un JWT d'une autre société
// et peut être verrouillé (clé de service ou JWT de la société) par TOKENS_CHARGE_USAGE_ENFORCE_AUTH. Base et inscription simulées.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
const { default: TokensCompany } = await import('../models/TokensCompany.js');
const { default: TokensUsageLedger } = await import('../models/TokensUsageLedger.js');
const { default: CompanyPayment } = await import('../models/CompanyPayment.js');
const { default: CompanyNotification } = await import('../models/CompanyNotification.js');
const { Subscription } = await import('../models/Subscription.js');
const { tokensCompanyController: ctl } = await import('../controllers/tokensCompanyController.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');

const C1 = '64b0000000000000000000c1'; const C2 = '64b0000000000000000000c2';
let who; let registrationDown; let touched; let wallet; let n = 0;
const saved = { log: console.log, warn: console.warn, error: console.error };
beforeEach(() => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  delete process.env.TOKENS_CHARGE_USAGE_ENFORCE_AUTH; delete process.env.TOKENS_SERVICE_KEY;
  clearCompanyCache(); touched = 0; registrationDown = false; who = { companyId: C1, isOwner: true };
  wallet = { companyId: C1, tokens: 1000, purchasedTokens: 0, consumedTokens: 0, chargedUsageIds: [], aiProviders: { openai: true, anthropic: true, gemini: true }, save: async function () { touched += 1; } };
  const touch = () => { touched += 1; };
  TokensCompany.findOne = async (q) => { touch(); return String(q.companyId) === wallet.companyId ? wallet : null; };
  TokensCompany.create = async (d) => { touch(); wallet = { ...wallet, ...d, save: wallet.save }; return wallet; };
  TokensCompany.findOneAndUpdate = async (filter, update) => {
    touch();
    if (String(filter.companyId) !== wallet.companyId || wallet.chargedUsageIds.includes(filter.chargedUsageIds?.$ne === undefined ? '' : filter.chargedUsageIds.$ne) && filter.chargedUsageIds.$ne !== undefined) return null;
    if (wallet.tokens < (filter.tokens?.$gte ?? 0)) return null;
    wallet.tokens += update.$inc.tokens; wallet.consumedTokens += update.$inc.consumedTokens; wallet.chargedUsageIds.push(update.$addToSet.chargedUsageIds); return wallet;
  };
  TokensUsageLedger.find = () => { touch(); const c = { sort: () => c, limit: () => c, lean: async () => [] }; return c; };
  TokensUsageLedger.aggregate = async () => { touch(); return []; };
  TokensUsageLedger.create = async () => { touch(); return {}; };
  CompanyPayment.find = () => { touch(); const c = { sort: () => c, limit: () => c, lean: async () => [] }; return c; };
  CompanyPayment.findOne = () => { touch(); const c = { sort: () => c, select: () => c, lean: async () => null }; return c; };
  CompanyNotification.findOneAndUpdate = async () => null; CompanyNotification.findOne = async () => null;
  Subscription.findOne = async () => null;
  global.fetch = async () => { if (registrationDown) throw new Error('registration down'); return { ok: true, json: async () => ({ success: true, data: who }) }; };
});
after(() => { Object.assign(console, saved); delete process.env.TOKENS_CHARGE_USAGE_ENFORCE_AUTH; delete process.env.TOKENS_SERVICE_KEY; });

const token = jwt.sign({ userId: 'u-tok' }, process.env.JWT_SECRET, { expiresIn: '5m' });
const call = async (method, { params = {}, body = {}, query = {}, auth = true, headers = {} } = {}) => {
  let out; const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code || 200, body: b }; return this; } };
  n += 1;
  const h = { ...(auth ? { authorization: 'Bearer tok' } : {}), ...headers };
  await ctl[method]({ params, body, query, headers: h, user: auth ? { userId: `u${n}` } : undefined }, res);
  return out;
};
const READS = ['getTokens', 'checkBalance', 'getUsage', 'getUsageByGig', 'getPurchases'];

test('lecture : propriétaire ET membre de la société', async () => {
  for (const name of READS) for (const identity of [{ companyId: C1, isOwner: true }, { companyId: C1, isOwner: false }]) {
    who = identity; clearCompanyCache();
    assert.ok([200].includes((await call(name, { params: { companyId: C1 } })).code), `${name} ${JSON.stringify(identity)}`);
  }
});

test('ISOLATION : autre société, agent, sans société => 403 sans AUCUNE lecture ni écriture (lectures, fournisseurs IA, achat)', async () => {
  for (const identity of [{ companyId: C2, isOwner: true }, { companyId: C2, isOwner: false }, { companyId: C1, isOwner: false, isAgent: true }, { companyId: null, isOwner: true }]) {
    for (const name of [...READS, 'updateAiProviders']) {
      who = identity; clearCompanyCache(); touched = 0;
      const r = await call(name, { params: { companyId: C1 }, body: { openai: false } });
      assert.equal(r.code, 403, `${name} ${JSON.stringify(identity)}`); assert.equal(touched, 0, `${name} : aucune lecture ni écriture`);
    }
  }
  assert.equal(wallet.aiProviders.openai, true);
});

test('fournisseurs IA : propriétaire seul — un membre est refusé, le propriétaire modifie', async () => {
  who = { companyId: C1, isOwner: false };
  assert.equal((await call('updateAiProviders', { params: { companyId: C1 }, body: { openai: false } })).code, 403); assert.equal(wallet.aiProviders.openai, true);
  who = { companyId: C1, isOwner: true }; clearCompanyCache();
  const r = await call('updateAiProviders', { params: { companyId: C1 }, body: { openai: false } });
  assert.equal(r.code, 200); assert.equal(wallet.aiProviders.openai, false);
});

test('service d\'inscription indisponible : 503 jamais ouvert ; sans jeton : 401', async () => {
  registrationDown = true;
  for (const name of [...READS, 'updateAiProviders']) { clearCompanyCache(); touched = 0; assert.equal((await call(name, { params: { companyId: C1 } })).code, 503, name); assert.equal(touched, 0); }
  registrationDown = false; clearCompanyCache();
  assert.equal((await call('getTokens', { params: { companyId: C1 }, auth: false })).code, 401);
});

test('ACHAT de jetons sans paiement supprimé : 410, solde intact (l\'achat réel passe par le paiement)', async () => {
  for (const identity of [{ companyId: C1, isOwner: true }, { companyId: C2, isOwner: true }]) {
    who = identity; clearCompanyCache(); touched = 0;
    const r = await call('buyTokens', { body: { companyId: C1, amount: 99999999 } });
    assert.equal(r.code, 410); assert.equal(touched, 0);
  }
  assert.equal(wallet.tokens, 1000);
});

// --- charge-usage : service à service ------------------------------------------------------------------------------------------
const charge = (over = {}, opts = {}) => call('chargeUsage', { auth: false, body: { companyId: C1, usageId: `U${++n}`, tokensUsed: 10, ...over }, ...opts });

test('charge-usage, comportement actuel conservé par défaut : sans identité, la charge passe (front et dash_calls n\'envoient aucune identité)', async () => {
  const r = await charge();
  assert.equal(r.code, 200); assert.equal(r.body.charged, true); assert.equal(wallet.tokens, 990);
  const again = await call('chargeUsage', { auth: false, body: { companyId: C1, usageId: 'SAME', tokensUsed: 10 } });
  const dup = await call('chargeUsage', { auth: false, body: { companyId: C1, usageId: 'SAME', tokensUsed: 10 } });
  assert.equal(again.body.charged, true); assert.equal(dup.body.charged, false); assert.equal(wallet.tokens, 980, 'idempotent par usageId');
});

test('charge-usage : un JWT valide d\'une AUTRE société est refusé (403), même par défaut ; un JWT de la société passe', async () => {
  who = { companyId: C2, isOwner: true };
  const bad = await call('chargeUsage', { auth: true, headers: { authorization: `Bearer ${token}` }, body: { companyId: C1, usageId: 'X1', tokensUsed: 10 } });
  assert.equal(bad.code, 403); assert.equal(wallet.tokens, 1000);
  who = { companyId: C1, isOwner: false }; clearCompanyCache();
  const ok = await call('chargeUsage', { auth: true, headers: { authorization: `Bearer ${token}` }, body: { companyId: C1, usageId: 'X2', tokensUsed: 10 } });
  assert.equal(ok.code, 200); assert.equal(wallet.tokens, 990);
});

test('charge-usage verrouillé (TOKENS_CHARGE_USAGE_ENFORCE_AUTH) : refusé sans identité, accepté avec la clé de service ou le JWT de la société', async () => {
  process.env.TOKENS_CHARGE_USAGE_ENFORCE_AUTH = 'true'; process.env.TOKENS_SERVICE_KEY = 'secret-service-key';
  assert.equal((await charge()).code, 401); assert.equal(wallet.tokens, 1000);
  assert.equal((await charge({}, { headers: { 'x-service-key': 'wrong' } })).code, 401);
  assert.equal((await charge({}, { headers: { 'x-service-key': 'secret-service-key' } })).code, 200); assert.equal(wallet.tokens, 990);
  who = { companyId: C1, isOwner: true }; clearCompanyCache();
  assert.equal((await call('chargeUsage', { auth: true, headers: { authorization: `Bearer ${token}` }, body: { companyId: C1, usageId: 'X3', tokensUsed: 10 } })).code, 200);
  // une clé de service vide ou absente de l'environnement n'ouvre jamais la porte
  delete process.env.TOKENS_SERVICE_KEY;
  assert.equal((await charge({}, { headers: { 'x-service-key': '' } })).code, 401);
  assert.equal((await charge({}, { headers: { 'x-service-key': 'undefined' } })).code, 401);
});

test('charge-usage verrouillé : service d\'inscription indisponible avec JWT => 503, jamais ouvert', async () => {
  process.env.TOKENS_CHARGE_USAGE_ENFORCE_AUTH = 'true'; registrationDown = true;
  const r = await call('chargeUsage', { auth: true, headers: { authorization: `Bearer ${token}` }, body: { companyId: C1, usageId: 'X4', tokensUsed: 10 } });
  assert.equal(r.code, 503); assert.equal(wallet.tokens, 1000);
});

test('charge-usage : validations existantes inchangées (400 sans usageId, 0 jeton ignoré)', async () => {
  assert.equal((await call('chargeUsage', { auth: false, body: { companyId: C1 } })).code, 400);
  const r = await charge({ tokensUsed: 0 });
  assert.equal(r.code, 200); assert.equal(r.body.charged, false);
});
