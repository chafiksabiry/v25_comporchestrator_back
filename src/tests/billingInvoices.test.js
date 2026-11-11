import assert from 'node:assert/strict';
import { createBillingHandlers } from '../controllers/billingController.js';
import { stripeService, __setStripeClientForTests } from '../services/stripeService.js';

function res() {
  const r = { code: 200, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
const log = [];
const card = (id, customer, last4 = '4242') => ({ id, type: 'card', customer, card: { brand: 'visa', last4, exp_month: 12, exp_year: 2030 } });
let cards;
const stripe = {
  invoices: { list: async (p) => { log.push(['invoices.list', p]); return { has_more: true, data: [
    { id: 'in_1', number: 'N-1', created: 1700000000, amount_paid: 5940, amount_due: 0, currency: 'EUR', status: 'paid', description: null, lines: { data: [{ description: '500 minutes' }] }, hosted_invoice_url: 'h', invoice_pdf: 'p', customer: 'cus_1' },
    { id: 'in_x', created: 1700000000, amount_paid: 1, amount_due: 0, currency: 'eur', status: 'paid', customer: 'cus_OTHER' },
  ] }; } },
  paymentMethods: {
    list: async () => ({ data: cards }),
    retrieve: async (id) => { const c = cards.find((x) => x.id === id) || (id === 'pm_other' ? card('pm_other', 'cus_2') : null); if (!c) { const e = new Error('x'); e.code = 'resource_missing'; throw e; } return c; },
    detach: async (id) => { log.push(['detach', id]); cards = cards.filter((x) => x.id !== id); },
  },
  customers: { retrieve: async () => ({ invoice_settings: { default_payment_method: 'pm_1' } }), update: async (c, p) => { log.push(['cust.update', c, p]); } },
  subscriptions: { retrieve: async () => ({ customer: 'cus_1' }), update: async (s, p) => { log.push(['sub.update', s, p]); } },
  setupIntents: { create: async (p) => { log.push(['si', p]); return { client_secret: 'seti_secret' }; } },
};
const h = (o = {}) => createBillingHandlers({
  getAccess: async () => ({ companyId: 'C1', role: 'owner' }),
  getStripe: () => stripe,
  findSubscriptions: async () => [{ status: 'active', stripeSubscriptionId: 'sub_1', stripeCustomerId: 'cus_1' }],
  ...o,
});
const reset = () => { log.length = 0; cards = [card('pm_1', 'cus_1'), card('pm_2', 'cus_1', '1111')]; };

// factures
reset();
let r = res(); await h().listInvoices({ query: { limit: '5', startingAfter: 'in_0' } }, r);
assert.equal(r.code, 200); assert.equal(r.body.data.hasMore, true); assert.equal(r.body.data.items.length, 1);
assert.deepEqual(r.body.data.items[0], { id: 'in_1', number: 'N-1', createdAt: '2023-11-14T22:13:20.000Z', amountPaid: 59.4, amountDue: 0, currency: 'eur', status: 'paid', description: '500 minutes', hostedUrl: 'h', pdfUrl: 'p' });
assert.deepEqual(log[0][1], { customer: 'cus_1', limit: 5, starting_after: 'in_0' });
r = res(); await h({ findSubscriptions: async () => [] }).listInvoices({ query: {} }, r);
assert.deepEqual(r.body, { success: true, data: { items: [], hasMore: false } });

// accès
r = res(); await h({ getAccess: async () => ({ companyId: 'C1', role: 'agent' }) }).listInvoices({ query: {} }, r);
assert.equal(r.code, 403); assert.equal(r.body.success, false);
r = res(); await h({ getAccess: async () => { throw new Error('non'); } }).listPaymentMethods({ query: {} }, r);
assert.equal(r.code, 503);

// cartes
r = res(); await h().listPaymentMethods({ query: {} }, r);
assert.deepEqual(r.body.data.items.map((c) => [c.id, c.isDefault, c.last4]), [['pm_1', true, '4242'], ['pm_2', false, '1111']]);
reset(); r = res(); await h().createSetupIntent({}, r);
assert.equal(r.body.data.clientSecret, 'seti_secret');
assert.deepEqual(log[0][1], { customer: 'cus_1', usage: 'off_session', payment_method_types: ['card'] });

// défaut
reset(); r = res(); await h().setDefaultPaymentMethod({ params: { id: 'pm_2' } }, r);
assert.equal(r.code, 200);
assert.deepEqual(log.map((l) => l[0]), ['cust.update', 'sub.update']);
reset(); r = res(); await h().setDefaultPaymentMethod({ params: { id: 'pm_other' } }, r);
assert.equal(r.code, 404); assert.equal(log.length, 0);
r = res(); await h().setDefaultPaymentMethod({ params: { id: 'pm_nope' } }, r);
assert.equal(r.code, 404);

// suppression
reset(); r = res(); await h().removePaymentMethod({ params: { id: 'pm_other' } }, r);
assert.equal(r.code, 404); assert.ok(!log.some((l) => l[0] === 'detach'));
reset(); cards = [card('pm_1', 'cus_1')]; r = res(); await h().removePaymentMethod({ params: { id: 'pm_1' } }, r);
assert.equal(r.code, 409); assert.equal(r.body.code, 'last_method');
reset(); r = res(); await h().removePaymentMethod({ params: { id: 'pm_1' } }, r);
assert.equal(r.code, 200); assert.ok(log.some((l) => l[0] === 'detach' && l[1] === 'pm_1'));
assert.ok(log.some((l) => l[0] === 'sub.update' && l[2].default_payment_method === 'pm_2'));
// dernière carte sans abonnement actif : autorisé
reset(); cards = [card('pm_1', 'cus_1')];
r = res(); await h({ findSubscriptions: async () => [{ status: 'canceled', stripeCustomerId: 'cus_1' }] }).removePaymentMethod({ params: { id: 'pm_1' } }, r);
assert.equal(r.code, 200);

// Stripe en erreur
r = res(); await h({ getStripe: () => ({ ...stripe, invoices: { list: async () => { throw new Error('boom'); } } }) }).listInvoices({ query: {} }, r);
assert.equal(r.code, 502);

// achats ponctuels : facture activée, sauf capture manuelle
const sessions = [];
__setStripeClientForTests({ checkout: { sessions: { create: async (p) => { sessions.push(p); return { id: 'cs' }; } } } });
const base = { amountCents: 5940, currency: 'eur', productName: "HARX — 500 minutes d'appel", successUrl: 's', cancelUrl: 'c', clientReferenceId: 'p1', metadata: { purpose: 'minutes_purchase', companyId: 'C1' } };
await stripeService.createOneShotCheckoutSession({ ...base, customerId: 'cus_1' });
assert.equal(sessions[0].invoice_creation.enabled, true);
assert.equal(sessions[0].invoice_creation.invoice_data.description, "HARX — 500 minutes d'appel");
assert.equal(sessions[0].customer, 'cus_1');
await stripeService.createOneShotCheckoutSession({ ...base, captureMethod: 'manual' });
assert.equal(sessions[1].invoice_creation, undefined); assert.equal(sessions[1].customer, undefined);
__setStripeClientForTests(null);
console.log('billingInvoices OK');
