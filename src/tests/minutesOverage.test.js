// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/minutesOverage.test.js
// Minutes d'appel hors forfait de l'offre Multi-clients : configuration lue des métadonnées du produit Stripe, classification
// nationale / internationale, appel traversant le solde, idempotence, plafond, facturation (invoice items), comportement inchangé
// sans métadonnées et pour les autres forfaits. Aucune base, aucun Stripe, aucun Twilio réels : magasin en mémoire et client Stripe simulé.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';

const O = await import('../services/minutesOverage.js');
const { stripeService } = await import('../services/stripeService.js');
const { maxSecondsForBalance, decideOutboundCall } = await import('../services/browserOutbound.js');

const MC = { harx_product: 'callcenter', callcenter_tier: 'multi_clients', overage_national_cents: '15', overage_international_cents: '63' };
const CTX = {
  config: { nationalCents: 15, internationalCents: 63, capCents: null },
  periodKey: 'sub_1:2026-11-01T00:00:00.000Z',
  periodStart: new Date('2026-11-01T00:00:00Z'),
  periodEnd: new Date('2026-12-01T00:00:00Z'),
};
const NOW = new Date('2026-11-20T10:00:00Z');

/** Magasin en mémoire : mêmes garanties que l'implémentation Mongo (écriture conditionnelle atomique par appel). */
class MemStore {
  constructor(minutes = 0) { this.w = { minutes, consumedSeconds: 0, chargedCallSids: [], overageCalls: [] }; this.failNextApply = 0; }
  async read() { return structuredClone(this.w); }
  async applyCall(_companyId, key, { expectMinutes, debitMinutes, seconds, entry }) {
    if (this.failNextApply > 0) { this.failNextApply -= 1; this.w.minutes -= 1; return false; } // un débit concurrent a changé le solde
    if (this.w.chargedCallSids.includes(key) || this.w.minutes !== expectMinutes) return false;
    this.w.minutes -= debitMinutes; this.w.consumedSeconds += seconds; this.w.chargedCallSids.push(key);
    if (entry) this.w.overageCalls.push(structuredClone(entry));
    return true;
  }
  async markBilled(_companyId, sids, info) {
    for (const e of this.w.overageCalls) if (sids.includes(e.callSid)) { e.invoiceItemId = info.invoiceItemId; e.billedAt = info.at; }
  }
}
const call = (sid, seconds, over = {}) => ({ sid, duration: seconds, direction: 'outbound', to: '+33612345678', startTime: new Date('2026-11-10T10:00:00Z'), ...over });

// --- 1. Configuration : métadonnées du produit Stripe uniquement -------------------------------------------------------
test('métadonnées : tarifs lus du produit Stripe (centimes), plafond optionnel, clés tolérantes', () => {
  assert.deepEqual(O.overageConfigFromMetadata(MC), { nationalCents: 15, internationalCents: 63, capCents: null });
  assert.deepEqual(O.overageConfigFromMetadata({ ...MC, overage_cap_cents: '5000' }), { nationalCents: 15, internationalCents: 63, capCents: 5000 });
  const { overage_national_cents: _drop, ...noNational } = MC;
  assert.equal(O.overageConfigFromMetadata({ ...noNational, ' Overage_National_Cents ': '20' }).nationalCents, 20);
  assert.equal(O.overageConfigFromMetadata({ ...MC, callcenter_tier: 'multi_pays' }).internationalCents, 63, 'ancien alias du palier accepté');
  // valeurs autres que celles de la décision du propriétaire : rien n'est écrit en dur
  assert.deepEqual(O.overageConfigFromMetadata({ ...MC, overage_national_cents: '7', overage_international_cents: '99' }), { nationalCents: 7, internationalCents: 99, capCents: null });
});

test('métadonnées absentes, incomplètes ou autre palier : aucun dépassement (comportement actuel)', () => {
  const { overage_national_cents, overage_international_cents, ...bare } = MC;
  assert.equal(O.overageConfigFromMetadata(bare), null);
  assert.equal(O.overageConfigFromMetadata({ ...bare, overage_national_cents }), null, 'un seul tarif : pas de dépassement');
  assert.equal(O.overageConfigFromMetadata({ ...bare, overage_international_cents }), null);
  assert.equal(O.overageConfigFromMetadata({ ...MC, overage_national_cents: 'abc' }), null);
  assert.equal(O.overageConfigFromMetadata(null), null);
  for (const tier of ['nomad_solo', 'accueil', 'full_scope']) assert.equal(O.overageConfigFromMetadata({ ...MC, callcenter_tier: tier }), null, `${tier} inchangé même si les clés existent`);
  assert.equal(O.overageConfigFromMetadata({ ...MC, harx_product: 'taas' }), null, 'forfait non Call Centre');
  assert.equal(O.overageConfigFromMetadata({ ...MC, callcenter_tier: undefined }), null);
});

test('extractStripeProductLimits expose les tarifs sans toucher aux autres champs', () => {
  const lim = stripeService.extractStripeProductLimits({ metadata: { ...MC, 'COMMUNICATION MINUTES Included': '30', overage_cap_cents: '2500' } });
  assert.equal(lim.communicationMinutes, 30);
  assert.equal(lim.overageNationalCents, 15); assert.equal(lim.overageInternationalCents, 63); assert.equal(lim.overageCapCents, 2500);
  const none = stripeService.extractStripeProductLimits({ metadata: { 'COMMUNICATION MINUTES Included': '30' } });
  assert.deepEqual(none, { communicationMinutes: 30 });
});

// --- 2. Classification -------------------------------------------------------------------------------------------------
test('classification sortant : pays de destination = pays de l\'entreprise => national, sinon international', () => {
  assert.deepEqual(O.classifyCall({ direction: 'outbound', to: '+33612345678' }, '+33'), { klass: 'national', basis: 'destination' });
  assert.equal(O.classifyCall({ direction: 'outbound', to: '+442071234567' }, '+33').klass, 'international');
  assert.equal(O.classifyCall({ direction: 'outbound', to: '+212612345678' }, '+33').klass, 'international');
  assert.equal(O.classifyCall({ direction: 'outbound', to: '+442071234567' }, '+44').klass, 'national');
  assert.equal(O.classifyCall({ direction: 'outbound', to: '0033612345678' }, '+33').klass, 'national', 'numéro 00 normalisé');
});

test('classification entrant : selon la provenance si connue, sinon national', () => {
  assert.deepEqual(O.classifyCall({ direction: 'inbound', from: '+33612345678', to: '+33411112222' }, '+33'), { klass: 'national', basis: 'origin' });
  assert.deepEqual(O.classifyCall({ direction: 'inbound', from: '+14155550123', to: '+33411112222' }, '+33'), { klass: 'international', basis: 'origin' });
  assert.deepEqual(O.classifyCall({ direction: 'inbound', from: 'anonymous', to: '+33411112222' }, '+33'), { klass: 'national', basis: 'default' });
  assert.deepEqual(O.classifyCall({ direction: 'inbound', to: '+33411112222' }, '+33'), { klass: 'national', basis: 'default' });
});

test('classification : pays de l\'entreprise inconnu => préfixe par défaut de la politique sortante (+33) ; destination illisible sortante => national par défaut', () => {
  assert.equal(O.classifyCall({ direction: 'outbound', to: '+33612345678' }, '').klass, 'national');
  assert.equal(O.classifyCall({ direction: 'outbound', to: '+442071234567' }, '').klass, 'international');
  assert.deepEqual(O.classifyCall({ direction: 'outbound', to: '' }, '+33'), { klass: 'national', basis: 'default' });
  assert.deepEqual(O.classifyCall({ to: '+442071234567' }, '+33'), { klass: 'international', basis: 'destination' }, 'sans direction : sortant par défaut, comme la collection calls');
});

// --- 3. Répartition forfait / dépassement ------------------------------------------------------------------------------
test('répartition : minutes entières du solde dans le forfait, le reste en dépassement', () => {
  assert.deepEqual(O.splitIncludedMinutes(30, 10), { included: 10, overage: 0 });
  assert.deepEqual(O.splitIncludedMinutes(2, 5), { included: 2, overage: 3 });
  assert.deepEqual(O.splitIncludedMinutes(0, 5), { included: 0, overage: 5 });
  assert.deepEqual(O.splitIncludedMinutes(-4, 5), { included: 0, overage: 5 });
  assert.deepEqual(O.splitIncludedMinutes(2.5, 3), { included: 2, overage: 1 });
  assert.deepEqual(O.splitIncludedMinutes(5, 5), { included: 5, overage: 0 });
});

test('appel traversant le solde : partie dans le forfait, partie en dépassement (arrondi à la minute supérieure)', async () => {
  const store = new MemStore(2);
  const r = await O.settleCalls({ companyId: 'C1', calls: [call('CA1', 130, { to: '+442071234567' })], ctx: CTX, companyCountry: '+33', store, now: NOW });
  assert.deepEqual(r.charged, ['CA1']);
  assert.equal(store.w.minutes, 0, 'le solde tombe à zéro et ne devient jamais négatif');
  assert.equal(store.w.consumedSeconds, 130);
  assert.equal(store.w.overageCalls.length, 1);
  const e = store.w.overageCalls[0];
  assert.deepEqual({ callSid: e.callSid, klass: e.klass, callMinutes: e.callMinutes, includedMinutes: e.includedMinutes, overageMinutes: e.overageMinutes, unitCents: e.unitCents, periodKey: e.periodKey }, { callSid: 'CA1', klass: 'international', callMinutes: 3, includedMinutes: 2, overageMinutes: 1, unitCents: 63, periodKey: CTX.periodKey });
});

test('appel entièrement dans le forfait : aucun enregistrement de dépassement ; appels suivants entièrement en dépassement', async () => {
  const store = new MemStore(5);
  await O.settleCalls({ companyId: 'C1', calls: [call('A', 240), call('B', 180, { startTime: new Date('2026-11-11T10:00:00Z') }), call('C', 61, { startTime: new Date('2026-11-12T10:00:00Z') })], ctx: CTX, companyCountry: '+33', store, now: NOW });
  assert.equal(store.w.minutes, 0);
  assert.deepEqual(store.w.overageCalls.map((e) => [e.callSid, e.includedMinutes, e.overageMinutes]), [['B', 1, 2], ['C', 0, 2]]);
});

test('les appels sont traités dans l\'ordre chronologique, quel que soit l\'ordre de lecture', async () => {
  const store = new MemStore(3);
  await O.settleCalls({ companyId: 'C1', calls: [call('LATE', 120, { startTime: new Date('2026-11-12T10:00:00Z') }), call('EARLY', 120, { startTime: new Date('2026-11-10T10:00:00Z') })], ctx: CTX, companyCountry: '+33', store, now: NOW });
  assert.deepEqual(store.w.overageCalls.map((e) => [e.callSid, e.includedMinutes, e.overageMinutes]), [['LATE', 1, 1]]);
});

test('entrant au-delà du solde : jamais refusé, compté (provenance si connue)', async () => {
  const store = new MemStore(0);
  await O.settleCalls({ companyId: 'C1', calls: [call('IN1', 60, { direction: 'inbound', from: '+14155550123', to: '+33411112222' }), call('IN2', 60, { direction: 'inbound', from: 'anonymous', to: '+33411112222', startTime: new Date('2026-11-11T10:00:00Z') })], ctx: CTX, companyCountry: '+33', store, now: NOW });
  assert.deepEqual(store.w.overageCalls.map((e) => [e.callSid, e.klass, e.basis, e.unitCents]), [['IN1', 'international', 'origin', 63], ['IN2', 'national', 'default', 15]]);
});

test('idempotence : un appel déjà compté ne l\'est pas deux fois (ni débit, ni dépassement)', async () => {
  const store = new MemStore(2);
  const calls = [call('CA1', 300)];
  await O.settleCalls({ companyId: 'C1', calls, ctx: CTX, companyCountry: '+33', store, now: NOW });
  const after = structuredClone(store.w);
  const again = await O.settleCalls({ companyId: 'C1', calls, ctx: CTX, companyCountry: '+33', store, now: NOW });
  assert.deepEqual(again.charged, []);
  assert.deepEqual(store.w, after);
  assert.equal(store.w.overageCalls.length, 1);
});

test('débit concurrent : la répartition est recalculée sur le solde relu (nouvelle tentative), sans double comptage', async () => {
  const store = new MemStore(10);
  store.failNextApply = 1; // un autre débit passe entre la lecture et l'écriture : solde 9
  await O.settleCalls({ companyId: 'C1', calls: [call('CA1', 12 * 60)], ctx: CTX, companyCountry: '+33', store, now: NOW });
  assert.equal(store.w.minutes, 0);
  assert.deepEqual(store.w.overageCalls.map((e) => [e.includedMinutes, e.overageMinutes]), [[9, 3]]);
  assert.equal(store.w.chargedCallSids.filter((s) => s === 'CA1').length, 1);
});

test('appel sans durée ou de test : ignoré', async () => {
  const store = new MemStore(0);
  const r = await O.settleCalls({ companyId: 'C1', calls: [call('Z', 0), { sid: '', duration: 60 }], ctx: CTX, companyCountry: '+33', store, now: NOW });
  assert.deepEqual(r.charged, []); assert.equal(store.w.overageCalls.length, 0);
});

// --- 4. Tarification, plafond, durée maximale d'un appel --------------------------------------------------------------
const entry = (sid, klass, minutes, unit, over = {}) => ({ callSid: sid, klass, overageMinutes: minutes, unitCents: unit, capCents: null, periodKey: CTX.periodKey, periodEnd: CTX.periodEnd, at: new Date('2026-11-10T10:00:00Z'), ...over });

test('récapitulatif de période : minutes et montant par classe, montants issus des tarifs enregistrés', () => {
  const s = O.summarizePeriod([entry('a', 'national', 10, 15), entry('b', 'international', 2, 63), entry('c', 'national', 4, 15), entry('x', 'national', 99, 15, { periodKey: 'autre' })], CTX.periodKey);
  assert.deepEqual(s.national, { minutes: 14, cents: 210 });
  assert.deepEqual(s.international, { minutes: 2, cents: 126 });
  assert.equal(s.totalCents, 336); assert.equal(s.capReached, false); assert.equal(s.capCents, null);
});

test('plafond : montant limité au plafond de la période, atteint => capReached', () => {
  const capped = (sid, k, m, u, at) => entry(sid, k, m, u, { capCents: 200, at: new Date(at) });
  const s = O.summarizePeriod([capped('a', 'national', 10, 15, '2026-11-10T10:00:00Z'), capped('b', 'international', 3, 63, '2026-11-11T10:00:00Z')], CTX.periodKey);
  assert.equal(s.totalCents, 200, '150 + min(189, 50)');
  assert.deepEqual(s.national, { minutes: 10, cents: 150 }); assert.deepEqual(s.international, { minutes: 3, cents: 50 });
  assert.equal(s.capReached, true);
  assert.equal(O.summarizePeriod([capped('a', 'national', 10, 15, '2026-11-10T10:00:00Z')], CTX.periodKey).capReached, false);
});

test('durée maximale d\'un appel sortant : solde + minutes de dépassement autorisées par le plafond', () => {
  const free = (minutes, klass, usedCents = 0, cfg = CTX.config) => O.outboundMaxSeconds({ minutes, config: cfg, klass, usedCents });
  assert.equal(free(30, 'national'), 14400, 'sans plafond : jusqu\'au maximum de Twilio');
  assert.equal(free(0, 'international'), 14400, 'solde nul : l\'appel n\'est plus refusé');
  assert.equal(free(0.4, 'national'), 14400);
  const cap = { ...CTX.config, capCents: 1000 };
  assert.equal(free(2, 'national', 0, cap), 2 * 60 + Math.floor(1000 / 15) * 60);
  assert.equal(free(0, 'international', 900, cap), 60 * Math.floor(100 / 63), '1 minute de dépassement restante');
  assert.equal(free(0, 'international', 960, cap), 0, 'plafond atteint, solde nul : sortant bloqué');
  assert.equal(free(3, 'international', 1000, cap), 180, 'plafond atteint : seul le solde reste utilisable');
  assert.equal(free(0, 'national', 995, cap), 0);
});

test('autres forfaits et métadonnées absentes : la durée maximale reste celle du solde (inchangé)', () => {
  assert.equal(O.outboundMaxSeconds({ minutes: 0, config: null, klass: 'national', usedCents: 0 }), 0);
  assert.equal(O.outboundMaxSeconds({ minutes: 5, config: null, klass: 'national', usedCents: 0 }), maxSecondsForBalance(5));
  assert.equal(O.outboundMaxSeconds({ minutes: 0.5, config: null, klass: 'national', usedCents: 0 }), 0);
});

test('decideOutboundCall : durée imposée (allowedSeconds) prioritaire ; sans elle, comportement identique à avant', () => {
  const line = { phoneNumber: '+33411112222' };
  const base = { to: '+33612345678', line, subscribed: true, minutes: 0 };
  assert.equal(decideOutboundCall(base).ok, false);
  assert.equal(decideOutboundCall(base).key, 'insufficient_minutes');
  const withOverage = decideOutboundCall({ ...base, allowedSeconds: 7200 });
  assert.equal(withOverage.ok, true); assert.equal(withOverage.maxSeconds, 7200);
  assert.match(withOverage.twiml, /timeLimit="7200"/);
  assert.equal(decideOutboundCall({ ...base, minutes: 3 }).maxSeconds, 180);
  assert.equal(decideOutboundCall({ ...base, minutes: 3, allowedSeconds: 0 }).key, 'insufficient_minutes', 'plafond atteint : refus');
});

// --- 5. Facturation ----------------------------------------------------------------------------------------------------
function fakeStripe({ failCreate = false } = {}) {
  const items = [];
  return {
    items,
    invoiceItems: {
      create: async (params, opts) => {
        if (failCreate) throw new Error('card_declined');
        const dup = items.find((i) => i.opts?.idempotencyKey && i.opts.idempotencyKey === opts?.idempotencyKey);
        if (dup) return dup.item;
        const item = { id: `ii_${items.length + 1}`, ...params };
        items.push({ item, params, opts });
        return item;
      },
      list: async () => ({ data: items.map((i) => i.item), has_more: false }),
    },
  };
}
const closedStore = () => {
  const store = new MemStore(0);
  store.w.overageCalls.push(
    entry('a', 'national', 10, 15), entry('b', 'international', 2, 63), entry('c', 'national', 4, 15),
    entry('open', 'national', 5, 15, { periodKey: 'sub_1:2026-12-01T00:00:00.000Z', periodEnd: new Date('2027-01-01T00:00:00Z') })
  );
  return store;
};
const billArgs = (store, stripe, over = {}) => ({ companyId: 'C1', store, stripe, customerId: 'cus_1', currency: 'eur', now: new Date('2026-12-01T00:30:00Z'), ...over });

test('facturation : une ligne par classe pour la période close, montants calculés des tarifs enregistrés', async () => {
  const store = closedStore(); const stripe = fakeStripe();
  const r = await O.billClosedPeriods(billArgs(store, stripe));
  assert.equal(r.created.length, 2);
  const byClass = Object.fromEntries(stripe.items.map((i) => [i.params.metadata.overage_class, i.params]));
  assert.equal(byClass.national.amount, 210); assert.equal(byClass.international.amount, 126);
  assert.equal(byClass.national.customer, 'cus_1'); assert.equal(byClass.national.currency, 'eur');
  assert.match(byClass.national.description, /nationales/i); assert.match(byClass.international.description, /internationales/i);
  assert.match(byClass.national.description, /14 min/);
  assert.equal(byClass.national.metadata.company_id, 'C1');
  assert.ok(stripe.items.every((i) => i.opts.idempotencyKey && i.opts.idempotencyKey.includes('C1') && i.opts.idempotencyKey.includes(CTX.periodKey)));
  assert.ok(stripe.items.every((i) => i.opts.idempotencyKey === i.params.metadata.overage_key));
  assert.ok(store.w.overageCalls.filter((e) => e.periodKey === CTX.periodKey).every((e) => e.invoiceItemId), 'lignes marquées facturées');
  assert.ok(!store.w.overageCalls.find((e) => e.callSid === 'open').invoiceItemId, 'période encore ouverte : intacte');
});

test('facturation idempotente : la tâche lancée deux fois ne facture pas deux fois', async () => {
  const store = closedStore(); const stripe = fakeStripe();
  await O.billClosedPeriods(billArgs(store, stripe));
  const second = await O.billClosedPeriods(billArgs(store, stripe));
  assert.equal(second.created.length, 0);
  assert.equal(stripe.items.length, 2);
});

test('facturation : plantage entre la création Stripe et le marquage => la reprise ne recrée pas la ligne', async () => {
  const store = closedStore(); const stripe = fakeStripe();
  const realMark = store.markBilled.bind(store); store.markBilled = async () => { throw new Error('mongo down'); };
  await O.billClosedPeriods(billArgs(store, stripe));
  assert.equal(stripe.items.length, 2);
  store.markBilled = realMark;
  // même après 24 h (clé d'idempotence Stripe expirée) : la ligne existante est retrouvée par sa métadonnée
  for (const i of stripe.items) i.opts = { idempotencyKey: `expired-${i.opts.idempotencyKey}` };
  const again = await O.billClosedPeriods(billArgs(store, stripe));
  assert.equal(stripe.items.length, 2, 'aucune ligne en double');
  assert.equal(again.created.length, 0);
  assert.ok(store.w.overageCalls.filter((e) => e.periodKey === CTX.periodKey).every((e) => e.invoiceItemId));
});

test('facturation : appels tardifs de la même période => nouvelle ligne distincte, sans re-facturer les premiers', async () => {
  const store = closedStore(); const stripe = fakeStripe();
  await O.billClosedPeriods(billArgs(store, stripe));
  store.w.overageCalls.push(entry('late', 'national', 3, 15, { at: new Date('2026-11-30T23:59:00Z') }));
  const r = await O.billClosedPeriods(billArgs(store, stripe));
  assert.equal(r.created.length, 1);
  assert.equal(stripe.items.at(-1).params.amount, 45);
  assert.equal(new Set(stripe.items.map((i) => i.opts.idempotencyKey)).size, 3);
});

test('facturation : échec Stripe journalisé, aucune exception, rien de marqué, repris à la passe suivante', async () => {
  const store = closedStore();
  const warns = []; const warn = console.warn; console.warn = (...a) => warns.push(a.join(' '));
  let r;
  try { r = await O.billClosedPeriods(billArgs(store, fakeStripe({ failCreate: true }))); } finally { console.warn = warn; }
  assert.equal(r.created.length, 0); assert.equal(r.failed.length, 2);
  assert.ok(warns.some((w) => /card_declined/.test(w)));
  assert.ok(store.w.overageCalls.every((e) => !e.invoiceItemId));
  const stripe = fakeStripe();
  const retry = await O.billClosedPeriods(billArgs(store, stripe));
  assert.equal(retry.created.length, 2);
});

test('facturation : plafond de la période appliqué au montant facturé (national puis international)', async () => {
  const store = new MemStore(0);
  store.w.overageCalls.push(entry('a', 'national', 10, 15, { capCents: 200 }), entry('b', 'international', 3, 63, { capCents: 200, at: new Date('2026-11-11T10:00:00Z') }));
  const stripe = fakeStripe();
  await O.billClosedPeriods(billArgs(store, stripe));
  const amounts = Object.fromEntries(stripe.items.map((i) => [i.params.metadata.overage_class, i.params.amount]));
  assert.deepEqual(amounts, { national: 150, international: 50 });
});

test('facturation : sans client Stripe de l\'entreprise ou sans Stripe configuré, rien n\'est créé ni marqué', async () => {
  const store = closedStore(); const stripe = fakeStripe();
  assert.equal((await O.billClosedPeriods(billArgs(store, stripe, { customerId: null }))).created.length, 0);
  assert.equal((await O.billClosedPeriods(billArgs(store, null))).created.length, 0);
  assert.equal(stripe.items.length, 0);
  assert.ok(store.w.overageCalls.every((e) => !e.invoiceItemId));
});

test('facturation : montant nul (plafond 0) => aucune ligne', async () => {
  const store = new MemStore(0);
  store.w.overageCalls.push(entry('a', 'national', 10, 15, { capCents: 0 }));
  const stripe = fakeStripe();
  await O.billClosedPeriods(billArgs(store, stripe));
  assert.equal(stripe.items.length, 0);
});

test('facturation attachée à une facture brouillon (invoice.created) : champ invoice, même clé de dédoublonnage', async () => {
  const store = closedStore(); const stripe = fakeStripe();
  await O.billClosedPeriods(billArgs(store, stripe, { invoiceId: 'in_draft1' }));
  assert.ok(stripe.items.every((i) => i.params.invoice === 'in_draft1'));
});

test('facturation : libellé exact — tarif unique, tarifs mixtes (changement en cours de période), plafond appliqué', async () => {
  const run = async (entries) => { const store = new MemStore(0); store.w.overageCalls.push(...entries); const stripe = fakeStripe(); await O.billClosedPeriods(billArgs(store, stripe)); return stripe.items.map((i) => i.params.description); };
  assert.match((await run([entry('a', 'national', 10, 15)]))[0], /10 min × 0,15 €/);
  const mixed = (await run([entry('a', 'national', 10, 15), entry('b', 'national', 2, 20, { at: new Date('2026-11-12T10:00:00Z') })]))[0];
  assert.match(mixed, /12 min$/); assert.doesNotMatch(mixed, /×|plafond/);
  assert.match((await run([entry('a', 'national', 10, 15, { capCents: 100 })]))[0], /plafond de dépassement appliqué/);
});
