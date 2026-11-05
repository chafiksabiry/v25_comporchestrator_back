// Run: JWT_SECRET=t TELNYX_API_KEY=x node src/tests/phoneNumberIsolation.test.js
// Une société ne voit jamais les lignes d'une autre (GET /api/phone-numbers), et une secrétaire ne reçoit que numéro, statut, libellé.
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
const { listLinesFor } = await import('../services/phoneNumberList.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');

const A = '64b0000000000000000000a1';
const B = '64b0000000000000000000b2';
const C = '64b0000000000000000000c3';
const lines = [
  { _id: 'l1', phoneNumber: '+33900000001', companyId: A, status: 'active', provider: 'twilio', twilioId: 'PN_secret_A', price: 5, currency: 'EUR', billingStatus: 'active', stripeSubscriptionId: 'sub_A', metadata: { label: 'Accueil', inboundTest: { testedAt: 'x' }, hidden: 1 } },
  { _id: 'l2', phoneNumber: '+33900000002', companyId: B, status: 'active', provider: 'twilio', twilioId: 'PN_secret_B', price: 9, billingStatus: 'active' },
  { _id: 'l3', phoneNumber: '+33900000003', companyId: C, status: 'active', provider: 'twilio' },
];
// La base simulée respecte le filtre demandé ; un mauvais find (qui renverrait tout) est rattrapé par le filtre de sécurité.
const find = async (companyId) => lines.filter((l) => String(l.companyId) === String(companyId));
const leakyFind = async () => lines;

// Registration backend simulé : qui appartient à quelle société
const people = {
  ownerA: { companyId: A, isOwner: true },
  agentA: { companyId: A, isAgent: true },
  ownerB: { companyId: B, isOwner: true },
  multi: { companyId: A, companyIds: [A, C], isAgent: true },
  nobody: {},
};
const asUser = (name) => {
  clearCompanyCache();
  global.fetch = async () => ({ ok: true, json: async () => ({ success: true, data: people[name] }) });
  const token = jwt.sign({ userId: name }, process.env.JWT_SECRET, { expiresIn: '5m' });
  return { headers: { authorization: `Bearer ${token}` }, user: { userId: name }, query: {} };
};
const phones = (rows) => rows.map((r) => r.phoneNumber).sort();

// 1. chaque société ne voit que ses lignes, y compris si la base renvoie tout
for (const fn of [find, leakyFind]) {
  assert.deepEqual(phones(await listLinesFor(asUser('ownerA'), { find: fn })), ['+33900000001']);
  assert.deepEqual(phones(await listLinesFor(asUser('ownerB'), { find: fn })), ['+33900000002']);
}
// 2. une personne sans société ne voit rien
assert.deepEqual(await listLinesFor(asUser('nobody'), { find }), []);

// 3. ?companyId= d'une autre société : refusé (403), jamais ses lignes
for (const [who, other] of [['ownerA', B], ['agentA', B], ['nobody', A]]) {
  const req = asUser(who); req.query = { companyId: other };
  await assert.rejects(() => listLinesFor(req, { find }), (e) => e.status === 403, `${who} -> ${other}`);
}
// 4. un agent employé par plusieurs sociétés choisit parmi les siennes, pas une autre
let req = asUser('multi'); req.query = { companyId: C };
assert.deepEqual(phones(await listLinesFor(req, { find })), ['+33900000003']);
req = asUser('multi'); req.query = { companyId: B };
await assert.rejects(() => listLinesFor(req, { find }), (e) => e.status === 403);

// 5. champs : le responsable voit la facturation mais jamais les identifiants de l'opérateur ni de paiement
const [mine] = await listLinesFor(asUser('ownerA'), { find });
assert.equal(mine.price, 5); assert.equal(mine.billingStatus, 'active'); assert.equal(mine.provider, 'twilio');
for (const secret of ['twilioId', 'telnyxId', 'stripeSubscriptionId', 'paymentRef', 'orderId', 'webhookUrl', 'connectionId']) assert.equal(secret in mine, false, secret);
assert.deepEqual(mine.metadata, { inboundTest: { testedAt: 'x' } });
// 6. la secrétaire ne reçoit que numéro, statut, libellé (+ identifiants de ligne et de société)
const [seen] = await listLinesFor(asUser('agentA'), { find });
assert.deepEqual(Object.keys(seen).sort(), ['_id', 'companyId', 'gigId', 'id', 'label', 'phoneNumber', 'status']);
assert.equal(seen.label, 'Accueil');
for (const f of ['price', 'currency', 'billingStatus', 'provider', 'twilioId', 'metadata', 'isTrial']) assert.equal(f in seen, false, f);

// 7. appel de service à service signé : la société demandée seulement, jamais « toutes »
const service = (claims, query = {}) => ({ headers: {}, user: { service: 'dash_calls', ...claims }, query });
assert.deepEqual(phones(await listLinesFor(service({}, { companyId: B }), { find })), ['+33900000002']);
assert.deepEqual(phones(await listLinesFor(service({ companyId: A }), { find })), ['+33900000001']);
await assert.rejects(() => listLinesFor(service({ companyId: A }, { companyId: B }), { find }), (e) => e.status === 403, 'jeton lié à A, demande B');
await assert.rejects(() => listLinesFor(service({}), { find }), (e) => e.status === 400, 'service sans société');

console.log('phoneNumberIsolation: OK');
