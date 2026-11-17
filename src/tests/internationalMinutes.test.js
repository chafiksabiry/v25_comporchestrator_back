// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/internationalMinutes.test.js
// Pack de minutes internationales : zone domestique (pays de l'entreprise + UE si l'entreprise est dans l'UE), packs lus des métadonnées
// Stripe, second solde séparé (crédit idempotent, débit idempotent), choix du solde d'un appel sortant, offres non concernées inchangées.
// Aucune base, aucun Stripe réels : magasin en mémoire et client Stripe simulé.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';

const EU = await import('../services/euCountries.js');
const Z = await import('../services/callZone.js');
const P = await import('../services/internationalPacks.js');
const M = await import('../services/internationalMinutes.js');
const { decideOutboundCall, spokenRefusal, SPOKEN_REFUSALS } = await import('../services/browserOutbound.js');
const { maxSecondsForBalance } = await import('../services/browserOutbound.js');

// --- 1. Zone domestique -------------------------------------------------------------------------------------------------
test('liste UE : 27 pays (codes ISO), Royaume-Uni, Suisse, Norvège, États-Unis absents', () => {
  assert.equal(EU.EU_COUNTRY_CODES.length, 27);
  assert.equal(new Set(EU.EU_COUNTRY_CODES).size, 27);
  for (const iso of ['FR', 'DE', 'ES', 'IT', 'NL', 'BE', 'PT', 'IE', 'PL', 'SE', 'DK', 'FI', 'AT', 'GR', 'CZ', 'SK', 'SI', 'HR', 'HU', 'RO', 'BG', 'CY', 'MT', 'LU', 'LV', 'LT', 'EE']) assert.ok(EU.isEuCountry(iso), iso);
  for (const iso of ['GB', 'UK', 'CH', 'NO', 'US', 'IS', 'LI', 'MA', 'TR', 'UA', 'CA']) assert.equal(EU.isEuCountry(iso), false, iso);
  assert.ok(EU.EU_COUNTRY_CODES.every((c) => /^[A-Z]{2}$/.test(c)));
  assert.equal(EU.isEuCountry('fr'), true, 'casse tolérée');
  assert.equal(EU.isEuCountry(''), false);
});

const FR = '+33612345678'; const DE = '+4915112345678'; const GB = '+442071234567'; const US = '+14155550123'; const NO = '+4791234567'; const CH = '+41791234567'; const MA = '+212612345678';

test('classification : France→France et France→Allemagne = domestique ; France→Royaume-Uni et États-Unis→France = international', () => {
  assert.equal(Z.classifyZone({ to: FR, companyCountry: '+33' }).zone, 'domestic');
  assert.equal(Z.classifyZone({ to: DE, companyCountry: '+33' }).zone, 'domestic');
  assert.equal(Z.classifyZone({ to: GB, companyCountry: '+33' }).zone, 'international');
  assert.equal(Z.classifyZone({ to: FR, companyCountry: '+1' }).zone, 'international');
  assert.equal(Z.classifyZone({ to: US, companyCountry: '+1' }).zone, 'domestic');
});

test('classification : hors UE (Suisse, Norvège, Maroc) = international ; entreprise hors UE appelant l\'UE = international', () => {
  for (const to of [NO, CH, MA, GB, US]) assert.equal(Z.classifyZone({ to, companyCountry: '+33' }).zone, 'international', to);
  assert.equal(Z.classifyZone({ to: FR, companyCountry: '+44' }).zone, 'international', 'Royaume-Uni → France');
  assert.equal(Z.classifyZone({ to: DE, companyCountry: '+41' }).zone, 'international', 'Suisse → Allemagne');
  assert.equal(Z.classifyZone({ to: DE, companyCountry: '+49' }).zone, 'domestic');
  assert.equal(Z.classifyZone({ to: FR, companyCountry: '+49' }).zone, 'domestic', 'Allemagne → France : UE');
  assert.equal(Z.classifyZone({ to: GB, companyCountry: '+44' }).zone, 'domestic', 'même pays, hors UE');
  assert.equal(Z.classifyZone({ to: NO, companyCountry: '+47' }).zone, 'domestic');
});

test('classification : indicateur euZone, pays de l\'entreprise INCONNU => zone inconnue (jamais supposée UE), destination illisible => domestique', () => {
  assert.equal(Z.classifyZone({ to: FR, companyCountry: '+33' }).euZone, true);
  assert.equal(Z.classifyZone({ to: FR, companyCountry: '+44' }).euZone, false);
  assert.deepEqual(Z.classifyZone({ to: GB, companyCountry: '' }), { zone: 'unknown', euZone: null });
  assert.deepEqual(Z.classifyZone({ to: DE }), { zone: 'unknown', euZone: null });
  assert.equal(Z.classifyZone({ to: '', companyCountry: '+33' }).zone, 'domestic');
  assert.equal(Z.classifyZone({ to: '0033612345678', companyCountry: '+33' }).zone, 'domestic');
});

// --- 2. Packs lus de Stripe ---------------------------------------------------------------------------------------------
const price = (over = {}, product = {}) => ({
  id: 'price_p1', active: true, type: 'one_time', currency: 'eur', unit_amount: 1234,
  product: { id: 'prod_p1', active: true, name: 'Pack Intl', metadata: { pack_type: 'international_minutes', international_minutes: '60' }, ...product },
  ...over,
});

test('pack : contenu et prix lus du produit / prix Stripe (aucune valeur dans le code)', () => {
  assert.deepEqual(P.packFromPrice(price()), { id: 'price_p1', productId: 'prod_p1', label: 'Pack Intl', minutes: 60, amountCents: 1234, currency: 'eur', currencyOptions: {} });
  const other = P.packFromPrice(price({ unit_amount: 777 }, { metadata: { PACK_TYPE: ' International_Minutes ', 'International Minutes': '250' } }));
  assert.equal(other.minutes, 250); assert.equal(other.amountCents, 777);
  assert.equal(P.packFromPrice(price({}, { metadata: { pack_type: 'international_minutes', minutes: '10' } })).minutes, 10, 'clé `minutes` acceptée');
});

test('pack : refus des produits qui ne sont pas des packs valides', () => {
  assert.equal(P.packFromPrice(price({}, { metadata: { pack_type: 'tokens', international_minutes: '60' } })), null);
  assert.equal(P.packFromPrice(price({}, { metadata: { international_minutes: '60' } })), null, 'sans pack_type');
  assert.equal(P.packFromPrice(price({}, { metadata: { pack_type: 'international_minutes' } })), null, 'sans minutes');
  assert.equal(P.packFromPrice(price({}, { metadata: { pack_type: 'international_minutes', international_minutes: '0' } })), null);
  assert.equal(P.packFromPrice(price({}, { metadata: { pack_type: 'international_minutes', international_minutes: 'abc' } })), null);
  assert.equal(P.packFromPrice(price({ active: false })), null);
  assert.equal(P.packFromPrice(price({}, { active: false })), null);
  assert.equal(P.packFromPrice(price({ type: 'recurring' })), null);
  assert.equal(P.packFromPrice(price({ unit_amount: 0 })), null);
  assert.equal(P.packFromPrice(price({ unit_amount: null })), null);
  assert.equal(P.packFromPrice(price({ product: 'prod_unexpanded' })), null);
  assert.equal(P.packFromPrice(null), null);
});

test('montant d\'un pack : devise demandée si Stripe la propose (currency_options), sinon devise du prix', () => {
  const pack = P.packFromPrice(price({ currency_options: { gbp: { unit_amount: 999 }, usd: { unit_amount: 1400 } } }));
  assert.deepEqual(P.packAmountFor(pack, 'GBP'), { amountCents: 999, currency: 'GBP' });
  assert.deepEqual(P.packAmountFor(pack, 'eur'), { amountCents: 1234, currency: 'EUR' });
  assert.deepEqual(P.packAmountFor(P.packFromPrice(price()), 'USD'), { amountCents: 1234, currency: 'EUR' });
});

test('catalogue : seuls les packs valides, triés ; aucun pack configuré => liste vide ; erreur Stripe => liste vide sans exception', async () => {
  const pages = [
    { data: [price(), price({ id: 'price_x' }, { metadata: { pack_type: 'tokens', minutes: '5' } }), price({ id: 'price_big', unit_amount: 5000 }, { metadata: { pack_type: 'international_minutes', international_minutes: '300' } })], has_more: true },
    { data: [price({ id: 'price_dead', active: false }), price({ id: 'price_small', unit_amount: 500 }, { metadata: { pack_type: 'international_minutes', international_minutes: '20' } })], has_more: false },
  ];
  const asked = [];
  const stripe = { prices: { list: async (p) => { asked.push(p); return pages[asked.length - 1]; } } };
  const list = await P.listInternationalPacks({ stripe, cache: false });
  assert.deepEqual(list.map((p) => [p.id, p.minutes]), [['price_small', 20], ['price_p1', 60], ['price_big', 300]]);
  assert.deepEqual([asked[0].type, asked[0].active, asked[0].expand], ['one_time', true, ['data.product']]);
  assert.equal(asked[1].starting_after, pages[0].data.at(-1).id);
  assert.deepEqual(await P.listInternationalPacks({ stripe: { prices: { list: async () => ({ data: [price({}, { metadata: {} })], has_more: false }) } }, cache: false }), []);
  const warn = console.warn; console.warn = () => {};
  try { assert.deepEqual(await P.listInternationalPacks({ stripe: { prices: { list: async () => { throw new Error('stripe down'); } } }, cache: false }), []); } finally { console.warn = warn; }
  assert.deepEqual(await P.listInternationalPacks({ stripe: null, cache: false }), []);
});

test('un pack se retrouve par son identifiant de prix (relu de Stripe, jamais du client)', async () => {
  const stripe = { prices: { retrieve: async (id, opts) => { assert.deepEqual(opts, { expand: ['product'] }); if (id === 'price_p1') return price(); throw Object.assign(new Error('missing'), { code: 'resource_missing' }); } } };
  assert.equal((await P.getInternationalPack('price_p1', { stripe })).minutes, 60);
  assert.equal(await P.getInternationalPack('price_nope', { stripe }), null);
  assert.equal(await P.getInternationalPack('', { stripe }), null);
  assert.equal(await P.getInternationalPack('price_p1', { stripe: null }), null);
});

// --- 3. Second solde séparé ---------------------------------------------------------------------------------------------
class MemStore {
  constructor(minutes = 0) { this.w = { minutes, purchasedMinutes: 0, consumedSeconds: 0, chargedCallSids: [], credits: [] }; }
  async read() { return structuredClone(this.w); }
  async ensure() {}
  async debit(_c, key, { minutes, seconds }) {
    if (this.w.chargedCallSids.includes(key)) return false;
    this.w.minutes -= minutes; this.w.consumedSeconds += seconds; this.w.chargedCallSids.push(key); return true;
  }
  async credit(_c, { minutes, grantKey, at }) {
    if (this.w.credits.some((c) => c.grantKey === grantKey)) return false;
    this.w.minutes += minutes; this.w.purchasedMinutes += minutes; this.w.credits.push({ at, minutes, grantKey, kind: 'pack' }); return true;
  }
}

test('crédit d\'un pack : solde international seulement, idempotent par paiement', async () => {
  const store = new MemStore(0);
  assert.equal(await M.creditInternationalPack({ companyId: 'C1', minutes: 60, paymentId: 'pay1', store }), true);
  assert.equal(await M.creditInternationalPack({ companyId: 'C1', minutes: 60, paymentId: 'pay1', store }), false, 'même paiement : pas de second crédit');
  assert.equal(store.w.minutes, 60); assert.equal(store.w.purchasedMinutes, 60);
  await M.creditInternationalPack({ companyId: 'C1', minutes: 20, paymentId: 'pay2', store });
  assert.equal(store.w.minutes, 80);
  await assert.rejects(M.creditInternationalPack({ companyId: 'C1', minutes: 0, paymentId: 'p3', store }));
  await assert.rejects(M.creditInternationalPack({ companyId: 'C1', minutes: 10, paymentId: '', store }));
});

const LIMITS_ON = { internationalPack: true };
const call = (sid, seconds, over = {}) => ({ sid, duration: seconds, direction: 'outbound', to: GB, startTime: new Date('2026-11-10T10:00:00Z'), ...over });

test('débit : appel sortant international débité du solde international seul, idempotent ; les autres appels laissés au solde normal', async () => {
  const store = new MemStore(10);
  const calls = [call('INT1', 130), call('DOM1', 60, { to: FR }), call('DOM2', 60, { to: DE }), call('IN1', 60, { direction: 'inbound', from: GB, to: FR }), call('INT2', 61, { to: US })];
  const handled = await M.settleInternationalCalls({ companyId: 'C1', calls, limits: LIMITS_ON, store, country: async () => '+33' });
  assert.deepEqual([...handled].sort(), ['INT1', 'INT2']);
  assert.equal(store.w.minutes, 10 - 3 - 2); assert.equal(store.w.consumedSeconds, 191);
  const again = await M.settleInternationalCalls({ companyId: 'C1', calls, limits: LIMITS_ON, store, country: async () => '+33' });
  assert.deepEqual([...again].sort(), ['INT1', 'INT2'], 'toujours écartés du solde normal');
  assert.equal(store.w.minutes, 5, 'aucun second débit');
});

test('débit : offre non concernée => aucun appel pris en charge (tout reste au solde normal, comme avant)', async () => {
  const store = new MemStore(10);
  for (const limits of [null, {}, { internationalPack: false }, { overage: { nationalCents: 15 } }]) {
    assert.equal((await M.settleInternationalCalls({ companyId: 'C1', calls: [call('INT1', 130)], limits, store, country: async () => '+33' })).size, 0);
  }
  assert.equal(store.w.minutes, 10);
});

test('débit : appel sans durée ou sans destination lisible ignoré', async () => {
  const store = new MemStore(10);
  const h = await M.settleInternationalCalls({ companyId: 'C1', calls: [call('Z', 0), call('N', 60, { to: undefined }), { duration: 60, to: GB }], limits: LIMITS_ON, store, country: async () => '+33' });
  assert.equal(h.size, 0); assert.equal(store.w.minutes, 10);
});

// --- 4. Solde utilisé par un appel sortant ------------------------------------------------------------------------------
test('appel sortant : international => solde international (jamais le solde normal) ; domestique => solde normal inchangé', async () => {
  const store = new MemStore(7);
  const run = (to, nationalMinutes, limits = LIMITS_ON, country = '+33') => M.resolveOutboundBalance({ companyId: 'C1', limits, to, nationalMinutes, store, country: async () => country });
  assert.deepEqual(await run(GB, 500), { kind: 'international', minutes: 7, zone: 'international', euZone: true });
  assert.equal((await run(GB, 0)).minutes, 7, 'solde normal nul : sans effet sur un appel international');
  assert.deepEqual(await run(DE, 3), { kind: 'national', minutes: 3, zone: 'domestic', euZone: true });
  assert.deepEqual(await run(FR, 0), { kind: 'national', minutes: 0, zone: 'domestic', euZone: true });
  assert.equal((await run(FR, 5, LIMITS_ON, '+44')).kind, 'international', 'entreprise britannique appelant la France');
  // offre non concernée : jamais d'accès au solde international
  for (const limits of [null, {}, { internationalPack: false }]) assert.deepEqual(await run(GB, 4, limits), { kind: 'national', minutes: 4, zone: null, euZone: null });
});

test('appel sortant international sans pack : solde nul => durée 0 ; durée = minutes entières du solde international', async () => {
  const empty = new MemStore(0); const some = new MemStore(2.7);
  const b0 = await M.resolveOutboundBalance({ companyId: 'C1', limits: LIMITS_ON, to: GB, nationalMinutes: 999, store: empty, country: async () => '+33' });
  assert.equal(maxSecondsForBalance(b0.minutes), 0);
  const b1 = await M.resolveOutboundBalance({ companyId: 'C1', limits: LIMITS_ON, to: GB, nationalMinutes: 0, store: some, country: async () => '+33' });
  assert.equal(maxSecondsForBalance(b1.minutes), 120);
  const none = { read: async () => null };
  assert.equal((await M.resolveOutboundBalance({ companyId: 'C1', limits: LIMITS_ON, to: GB, nationalMinutes: 5, store: none, country: async () => '+33' })).minutes, 0, 'aucun portefeuille : solde 0');
});

test('lecture du solde international en échec : repli sur le comportement actuel (jamais de blocage ni de débit erroné)', async () => {
  const warn = console.warn; console.warn = () => {};
  try {
    const r = await M.resolveOutboundBalance({ companyId: 'C1', limits: LIMITS_ON, to: GB, nationalMinutes: 4, store: { read: async () => { throw new Error('mongo down'); } }, country: async () => '+33' });
    assert.deepEqual(r, { kind: 'national', minutes: 4, zone: null, euZone: null });
  } finally { console.warn = warn; }
});

test('decideOutboundCall : refus international = clé et message dédiés ; solde normal inchangé', () => {
  const line = { phoneNumber: '+33411112222' }; const base = { to: GB, line, subscribed: true };
  const refused = decideOutboundCall({ ...base, minutes: 0, balanceKind: 'international' });
  assert.equal(refused.ok, false); assert.equal(refused.key, 'international_pack_required');
  assert.equal(decideOutboundCall({ ...base, minutes: 0 }).key, 'insufficient_minutes');
  assert.equal(decideOutboundCall({ ...base, minutes: 0, balanceKind: 'national' }).key, 'insufficient_minutes');
  const ok = decideOutboundCall({ ...base, minutes: 3, balanceKind: 'international' });
  assert.equal(ok.ok, true); assert.equal(ok.maxSeconds, 180);
  assert.equal(decideOutboundCall({ ...base, minutes: 3 }).maxSeconds, 180);
});

test('refus parlés et messages : pack de minutes internationales requis (en / fr / es)', () => {
  for (const lang of ['en', 'fr', 'es']) assert.ok(SPOKEN_REFUSALS[lang].international_pack_required, lang);
  assert.match(SPOKEN_REFUSALS.en.international_pack_required, /international minutes pack/i);
  assert.match(String(spokenRefusal('international_pack_required', 'fr')), /pack de minutes internationales/i);
  const eu = M.internationalPackRefusal({ euZone: true }); const non = M.internationalPackRefusal({ euZone: false });
  assert.equal(M.INTERNATIONAL_PACK_CODE, 'INTERNATIONAL_PACK_REQUIRED');
  assert.match(eu.message, /international minutes pack is required/i); assert.match(eu.message, /EU/);
  assert.doesNotMatch(non.message, /\bEU\b/);
  assert.match(eu.messageFr, /pack de minutes internationales/i);
});

test('vue des deux soldes : séparés, jamais mélangés', () => {
  const v = M.buildBalancesOverview({ limits: LIMITS_ON, national: { minutes: 12, planMinutesIncluded: 30 }, international: { minutes: 45, purchasedMinutes: 100, consumedSeconds: 600 }, companyCountry: '+33', packs: [{ id: 'price_p1', minutes: 60, amountCents: 1234, currency: 'eur', label: 'Pack Intl' }] });
  assert.deepEqual(v.national, { minutes: 12, includedMinutes: 30 });
  assert.deepEqual(v.international, { applies: true, packsAvailable: true, minutes: 45, purchasedMinutes: 100, consumedSeconds: 600 });
  assert.deepEqual(v.zone, { companyCountry: '+33', euZone: true });
  assert.equal(v.packs.length, 1);
  const off = M.buildBalancesOverview({ limits: {}, national: { minutes: 12, planMinutesIncluded: 30 }, international: { minutes: 0, purchasedMinutes: 0, consumedSeconds: 0 }, companyCountry: '+33', packs: [] });
  assert.equal(off.international.applies, false);
  assert.equal(off.national.minutes, 12);
});

// --- Revue : DOM-TOM, pays inconnu, rejeu, reprise sur erreur ----------------------------------------------------------
test('DOM-TOM (régions de l\'UE) : +262, +590, +594, +596 domestiques pour une entreprise française, et pour toute entreprise de l\'UE', () => {
  for (const to of ['+262692123456', '+590690123456', '+594694123456', '+596696123456']) {
    assert.equal(Z.classifyZone({ to, companyCountry: '+33' }).zone, 'domestic', `FR → ${to}`);
    assert.equal(Z.classifyZone({ to, companyCountry: '+49' }).zone, 'domestic', `DE → ${to}`);
    assert.equal(Z.classifyZone({ to, companyCountry: '+44' }).zone, 'international', `GB → ${to}`);
    assert.equal(Z.classifyZone({ to, companyCountry: '+1' }).zone, 'international', `US → ${to}`);
  }
  // une entreprise dont la ligne est un numéro DOM-TOM est française (UE)
  for (const home of ['+262', '+590', '+594', '+596']) {
    assert.deepEqual(Z.classifyZone({ to: FR, companyCountry: home }), { zone: 'domestic', euZone: true }, home);
    assert.equal(Z.classifyZone({ to: DE, companyCountry: home }).zone, 'domestic');
    assert.equal(Z.classifyZone({ to: GB, companyCountry: home }).zone, 'international');
  }
  // collectivités d'outre-mer hors UE : internationales
  for (const to of ['+687123456', '+689123456', '+681123456'].map((n) => n.padEnd(12, '0'))) assert.equal(Z.classifyZone({ to, companyCountry: '+33' }).zone, 'international', to);
});

test('+1 : États-Unis et Canada domestiques entre eux (un seul indicatif), limite connue', () => {
  assert.equal(Z.classifyZone({ to: '+14165550123', companyCountry: '+1' }).zone, 'domestic');
  assert.equal(Z.classifyZone({ to: '+14155550123', companyCountry: '+1' }).zone, 'domestic');
});

test('pays de l\'entreprise inconnu : solde normal (comportement historique), rien pris en charge, avertissement', async () => {
  const warns = []; const warn = console.warn; console.warn = (...a) => warns.push(a.join(' '));
  try {
    const store = new MemStore(5);
    const b = await M.resolveOutboundBalance({ companyId: 'C1', limits: { internationalPack: true }, to: GB, nationalMinutes: 4, store, country: async () => '' });
    assert.deepEqual(b, { kind: 'national', minutes: 4, zone: 'unknown', euZone: null });
    assert.ok(warns.some((w) => /pays de l'entreprise inconnu/.test(w)));
    const h = await M.settleInternationalCalls({ companyId: 'C1', calls: [{ sid: 'X', duration: 60, direction: 'outbound', to: GB }], limits: { internationalPack: true }, store, country: async () => '' });
    assert.equal(h.size, 0); assert.equal(store.w.minutes, 5);
  } finally { console.warn = warn; }
});

test('rejeu : un appel international déjà traité n\'est pas redébité ni réécrit à chaque lecture (filtre sur le second solde)', async () => {
  const store = new MemStore(10); let debits = 0; const real = store.debit.bind(store); store.debit = async (...a) => { debits += 1; return real(...a); };
  const calls = [{ sid: 'I1', duration: 60, direction: 'outbound', to: GB }];
  const args = { companyId: 'C1', calls, limits: { internationalPack: true }, store, country: async () => '+33' };
  await M.settleInternationalCalls(args); await M.settleInternationalCalls(args); await M.settleInternationalCalls(args);
  assert.equal(debits, 1); assert.equal(store.w.minutes, 9);
  assert.deepEqual([...(await M.settleInternationalCalls(args))], ['I1'], 'toujours écarté du solde normal');
});

test('reprise sur erreur : les appels de type international sont repérés pour être différés, les autres débités normalement', async () => {
  const calls = [{ sid: 'I', duration: 60, direction: 'outbound', to: GB }, { sid: 'D', duration: 60, direction: 'outbound', to: DE }, { sid: 'N', duration: 60, direction: 'inbound', from: GB, to: FR }, { sid: 'U', duration: 60, direction: 'outbound' }];
  assert.deepEqual([...(await M.deferInternationalCalls({ companyId: 'C1', calls, country: async () => '+33' }))], ['I']);
  assert.deepEqual([...(await M.deferInternationalCalls({ companyId: 'C1', calls, country: async () => '' }))], [], 'pays inconnu : rien différé');
});

test('vue des soldes : packsAvailable distingue « aucun pack » (false) d\'une erreur de lecture (null)', () => {
  const base = { limits: LIMITS_ON, national: { minutes: 1 }, international: {}, companyCountry: '+33' };
  assert.equal(M.buildBalancesOverview({ ...base, packs: [{ id: 'p' }], packsError: false }).international.packsAvailable, true);
  assert.equal(M.buildBalancesOverview({ ...base, packs: [], packsError: false }).international.packsAvailable, false);
  assert.equal(M.buildBalancesOverview({ ...base, packs: [], packsError: true }).international.packsAvailable, null);
  assert.equal(M.buildBalancesOverview({ ...base, limits: {}, packs: [], packsError: false }).international.packsAvailable, null, 'offre non concernée : sans objet');
});

test('catalogue : erreur de lecture distinguée de « aucun pack »', async () => {
  const warn = console.warn; console.warn = () => {};
  try {
    assert.deepEqual(await P.listInternationalPacksChecked({ stripe: { prices: { list: async () => ({ data: [], has_more: false }) } }, cache: false }), { packs: [], error: false });
    const r = await P.listInternationalPacksChecked({ stripe: { prices: { list: async () => { throw new Error('stripe down'); } } }, cache: false });
    assert.equal(r.error, true); assert.deepEqual(r.packs, []);
    assert.deepEqual(await P.listInternationalPacksChecked({ stripe: null, cache: false }), { packs: [], error: true });
  } finally { console.warn = warn; }
});

test('message de refus : renvoie vers l\'achat et le support', () => {
  const r = M.internationalPackRefusal({ euZone: true });
  assert.match(r.message, /support/i); assert.match(r.messageFr, /support/i);
});
