// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/nomadNumberLifecycle.test.js
// Numéro d'un abonné NOMAD qui résilie (décision D3 précisée du 23/11/2026) :
//  1. résiliation : numéro gardé jusqu'à la fin de la période payée ; 2. fin de période : détaché, remis dans le stock ;
//  3. 30 jours sans réaffectation : résilié chez Twilio (drapeau NOMAD_NUMBER_RELEASE_ENABLED, désactivé par défaut ; dry-run).
//  + réabonnement : l'ancien numéro ne compte plus comme « ligne existante » (première ligne incluse, achat après paiement possible).
// Base, Stripe et Twilio simulés en mémoire : aucun appel réel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

process.env.JWT_SECRET ||= 't';
process.env.TELNYX_API_KEY ||= 'x';
process.env.TWILIO_ACCOUNT_SID ||= 'ACtest';
process.env.TWILIO_AUTH_TOKEN ||= 'x';

const L = await import('../services/nomadNumberLifecycle.js');
const { heldNumbers } = await import('../services/inventoryHolders.js');
const { isLineIncluded, localNumberLimitPayload } = await import('../services/planLimits.js');

const DAY = 24 * 3600 * 1000;
const T0 = Date.UTC(2026, 10, 23, 12);
const CO = '64b000000000000000000001';
const OTHER = '64b000000000000000000002';
const NOMAD = { name: 'Nomad', metadata: { harx_product: 'callcenter', callcenter_tier: 'nomad_solo' } };
const FULL = { name: 'Entreprise', metadata: { harx_product: 'callcenter', callcenter_tier: 'full_scope' } };
const OLD = '+33142000001';
const NEW = '+33142000002';

const sub = (o) => ({ _id: o._id, companyId: CO, planId: NOMAD, createdAt: new Date(T0 - 60 * DAY), updatedAt: new Date(T0), currentPeriodEnd: new Date(T0 + 10 * DAY), ...o });
const line = (o) => ({ _id: o._id, phoneNumber: OLD, companyId: CO, twilioId: 'PN_old', status: 'active', billingStatus: 'n/a', createdAt: new Date(T0 - 50 * DAY), metadata: {}, ...o });

/** Monde simulé (abonnements, lignes, compte Twilio) et dépendances du service branchées dessus. */
function world({ subs = [], lines = [], twilio = {}, excluded = [], trial = [], companies = [CO, OTHER] } = {}) {
  const st = { subs, lines, twilio, removed: [], detached: [], logs: [], warns: [], detachFails: false, twilioDown: false, removeFails: false, companies: new Set(companies) };
  const S = (sid) => st.subs.find((s) => String(s._id) === String(sid));
  const t = (d) => (d ? new Date(d).getTime() : NaN);
  st.deps = {
    subscriptionsOf: async (cid) => st.subs.filter((s) => String(s.companyId) === String(cid)),
    canceledNomadCompanyIds: async () => [...new Set(st.subs.filter((s) => s.status === 'canceled' && L.isNomadSubscription(s)).map((s) => String(s.companyId)))],
    linesOf: async (cid) => st.lines.filter((l) => String(l.companyId) === String(cid)),
    markLine: async (lid, mark) => {
      const l = st.lines.find((x) => String(x._id) === String(lid));
      if (!l || l.metadata?.nomadDetach) return false;
      l.metadata = { ...l.metadata, nomadDetach: mark };
      return true;
    },
    addEntry: async (sid, entry) => {
      const s = S(sid);
      s.numberLifecycle ||= [];
      if (s.numberLifecycle.some((e) => e.phoneNumberId === entry.phoneNumberId)) return false;
      s.numberLifecycle.push({ ...entry });
      return true;
    },
    setEntry: async (sid, pid, statuses, set, extra = {}) => {
      const e = (S(sid)?.numberLifecycle || []).find((x) => x.phoneNumberId === pid && statuses.includes(x.status) && Object.entries(extra).every(([k, v]) => t(x[k]) === t(v)));
      if (!e) return false;
      Object.assign(e, set);
      return true;
    },
    subscriptionsWithEntries: async (statuses) => st.subs.filter((s) => (s.numberLifecycle || []).some((e) => statuses.includes(e.status))),
    dueLines: async (now) => st.lines.filter((l) => l.metadata?.nomadDetach && t(l.metadata.nomadDetach.scheduledAt) <= now),
    recordOfStripe: async (sid) => st.subs.find((s) => s.stripeSubscriptionId === sid) || null,
    subscriptionById: async (sid) => S(sid) || null,
    lineById: async (lid) => st.lines.find((l) => String(l._id) === String(lid)) || null,
    recordsOf: async (e164) => st.lines.filter((l) => l.phoneNumber === e164),
    heldNumbers: (docs) => heldNumbers(docs, { lookup: async (ids) => new Set(ids.map(String).filter((x) => st.companies.has(x))) }),
    detachLine: async (l) => {
      if (st.detachFails) throw new Error('twilio 500');
      st.detached.push(l.phoneNumber);
      st.lines = st.lines.filter((x) => x !== l && String(x._id) !== String(l._id));
    },
    twilioNumber: async (e164) => { if (st.twilioDown) throw new Error('twilio down'); return st.twilio[e164] || null; },
    releaseTwilio: async (sid) => {
      if (st.removeFails) throw new Error('twilio 500');
      st.removed.push(sid);
      for (const k of Object.keys(st.twilio)) if (st.twilio[k].sid === sid) delete st.twilio[k];
    },
    excludedNumbers: () => excluded,
    trialNumbers: () => trial,
    foreignHost: (u) => (String(u).includes('api-autre-env') ? 'api-autre-env' : null),
    log: (...a) => st.logs.push(a.join(' ')),
    warn: (...a) => st.warns.push(a.join(' ')),
  };
  return st;
}

const canceledWorld = (o = {}) => world({
  subs: [sub({ _id: 'S1', status: 'canceled', stripeSubscriptionId: 'sub_1' })],
  lines: [line({ _id: 'L1' })],
  twilio: { [OLD]: { sid: 'PN_old', phoneNumber: OLD, voiceUrl: 'https://api-recette.test/api/inbound' } },
  ...o,
});
const entry = (st, sid = 'S1') => st.subs.find((s) => s._id === sid).numberLifecycle?.[0];

// ───────────── Étape 1 : résiliation, numéro gardé jusqu'à la fin de la période payée ─────────────

test('webhook deleted (résiliation immédiate en cours de période) : rien de détaché, détachement planifié à la fin de la période payée', async () => {
  const st = canceledWorld();
  const periodEnd = Math.floor((T0 + 10 * DAY) / 1000);
  const r = await L.onStripeSubscriptionEnded({ id: 'sub_1', status: 'canceled', items: { data: [{ current_period_end: periodEnd }] } }, { now: T0, deps: st.deps });
  assert.equal(r.scheduled, 1);
  assert.equal(st.lines.length, 1, 'ligne toujours associée au compte');
  assert.equal(new Date(st.lines[0].metadata.nomadDetach.scheduledAt).getTime(), T0 + 10 * DAY);
  assert.deepEqual([entry(st).status, entry(st).phoneNumber], ['scheduled', OLD]);
  // Avant la fin de la période : le passage ne détache rien.
  const d = await L.detachDueNomadNumbers({ now: T0 + 9 * DAY, deps: st.deps });
  assert.equal(d.detached, 0);
  assert.deepEqual(st.detached, []);
});

test('cancel_at_period_end : `updated` encore actif ne planifie rien ; `deleted` à la fin de la période -> détachement à cette date', async () => {
  const st = canceledWorld({ subs: [sub({ _id: 'S1', status: 'active', stripeSubscriptionId: 'sub_1', cancelAtPeriodEnd: true })] });
  const r = await L.onStripeSubscriptionEnded({ id: 'sub_1', status: 'active', cancel_at_period_end: true }, { now: T0, deps: st.deps });
  assert.equal(r.reason, 'not_canceled');
  assert.equal(st.lines[0].metadata.nomadDetach, undefined);
  st.subs[0].status = 'canceled';
  st.subs[0].currentPeriodEnd = new Date(T0 - 1000); // période payée déjà terminée au moment du webhook
  await L.onStripeSubscriptionEnded({ id: 'sub_1', status: 'canceled' }, { now: T0, deps: st.deps });
  assert.equal(new Date(st.lines[0].metadata.nomadDetach.scheduledAt).getTime(), T0, 'jamais avant maintenant');
});

test('planification idempotente : deux webhooks (ou webhook + reprise horaire) -> une seule marque, une seule entrée de journal', async () => {
  const st = canceledWorld();
  await L.scheduleNomadNumberDetach(CO, { now: T0, deps: st.deps });
  const again = await L.scheduleNomadNumberDetach(CO, { now: T0 + DAY, deps: st.deps });
  await L.runNomadNumberLifecycle({ now: T0 + 2 * DAY, env: {}, deps: st.deps });
  assert.equal(again.scheduled, 0);
  assert.equal(st.subs[0].numberLifecycle.length, 1);
  assert.equal(new Date(st.lines[0].metadata.nomadDetach.scheduledAt).getTime(), T0 + 10 * DAY, 'date d’origine conservée');
});

test('arrêt entre la marque et le journal : la reprise recrée l’entrée manquante', async () => {
  const st = canceledWorld();
  st.lines[0].metadata = { nomadDetach: { scheduledAt: new Date(T0 + 10 * DAY), subscriptionId: 'S1' } };
  await L.scheduleNomadNumberDetach(CO, { now: T0, deps: st.deps });
  assert.equal(entry(st).status, 'scheduled');
});

test('pas NOMAD, ou abonnement d’une autre offre en cours, ou abonnement en cours antérieur : rien n’est planifié', async () => {
  const a = canceledWorld({ subs: [sub({ _id: 'S1', status: 'canceled', planId: FULL, stripeSubscriptionId: 'sub_1' })] });
  assert.equal((await L.onStripeSubscriptionEnded({ id: 'sub_1', status: 'canceled' }, { now: T0, deps: a.deps })).reason, 'not_nomad');
  const b = canceledWorld({ subs: [sub({ _id: 'S1', status: 'canceled' }), sub({ _id: 'S2', status: 'active', planId: FULL, createdAt: new Date(T0) })] });
  assert.equal((await L.scheduleNomadNumberDetach(CO, { now: T0, deps: b.deps })).reason, 'live_other_offer');
  const c = canceledWorld({ subs: [sub({ _id: 'S1', status: 'canceled' }), sub({ _id: 'S2', status: 'active', createdAt: new Date(T0 - 90 * DAY) })] });
  assert.equal((await L.scheduleNomadNumberDetach(CO, { now: T0, deps: c.deps })).reason, 'older_live_subscription');
  for (const w of [a, b, c]) assert.equal(w.lines[0].metadata.nomadDetach, undefined);
});

test('webhook : une erreur de lecture ne fait jamais échouer le webhook', async () => {
  const st = canceledWorld();
  st.deps.recordOfStripe = async () => { throw new Error('db down'); };
  assert.equal((await L.onStripeSubscriptionEnded({ id: 'sub_1', status: 'canceled' }, { now: T0, deps: st.deps })).reason, 'error');
});

// ───────────── Étape 2 : fin de période, détaché et remis dans le stock ─────────────

test('fin de période : ligne détachée (remise dans le stock), journal « détaché » ; rejoué : rien de plus', async () => {
  const st = canceledWorld();
  await L.scheduleNomadNumberDetach(CO, { now: T0, deps: st.deps });
  const r = await L.detachDueNomadNumbers({ now: T0 + 10 * DAY, deps: st.deps });
  assert.equal(r.detached, 1);
  assert.deepEqual(st.detached, [OLD]);
  assert.equal(st.lines.length, 0, 'plus rattaché à la société');
  assert.deepEqual([entry(st).status, new Date(entry(st).detachedAt).getTime()], ['detached', T0 + 10 * DAY]);
  assert.deepEqual(st.removed, [], 'aucune résiliation chez Twilio au détachement');
  const again = await L.detachDueNomadNumbers({ now: T0 + 11 * DAY, deps: st.deps });
  assert.equal(again.detached, 0);
  assert.deepEqual(st.detached, [OLD]);
});

test('détachement en échec (Twilio) : ligne gardée, erreur journalisée, réessayé au passage suivant', async () => {
  const st = canceledWorld();
  await L.scheduleNomadNumberDetach(CO, { now: T0, deps: st.deps });
  st.detachFails = true;
  assert.equal((await L.detachDueNomadNumbers({ now: T0 + 10 * DAY, deps: st.deps })).failed, 1);
  assert.equal(st.lines.length, 1);
  assert.equal(entry(st).status, 'scheduled');
  assert.match(entry(st).lastError, /twilio 500/);
  st.detachFails = false;
  assert.equal((await L.detachDueNomadNumbers({ now: T0 + 10 * DAY + 3600e3, deps: st.deps })).detached, 1);
});

test('arrêt entre le retrait de la fiche et le journal : la reprise passe l’entrée à « détaché »', async () => {
  const st = canceledWorld();
  await L.scheduleNomadNumberDetach(CO, { now: T0, deps: st.deps });
  st.lines = []; // fiche déjà retirée
  assert.equal((await L.detachDueNomadNumbers({ now: T0 + 10 * DAY, deps: st.deps })).detached, 1);
  assert.equal(entry(st).status, 'detached');
});

test('dry-run : rien n’est détaché ni écrit, tout est journalisé', async () => {
  const st = canceledWorld();
  await L.scheduleNomadNumberDetach(CO, { now: T0, deps: st.deps });
  const r = await L.detachDueNomadNumbers({ now: T0 + 10 * DAY, dryRun: true, deps: st.deps });
  assert.equal(r.dryRun, 1);
  assert.equal(st.lines.length, 1);
  assert.equal(entry(st).status, 'scheduled');
  assert.ok(st.logs.some((l) => /\[dry-run\].*détaché/.test(l)));
  // La reprise horaire en dry-run ne pose aucune marque.
  const st2 = canceledWorld();
  await L.runNomadNumberLifecycle({ now: T0, env: { NOMAD_NUMBER_LIFECYCLE_DRY_RUN: 'true' }, deps: st2.deps });
  assert.equal(st2.lines[0].metadata.nomadDetach, undefined);
  assert.equal(st2.subs[0].numberLifecycle, undefined);
});

test('abonnement plus « résilié » au moment du détachement (donnée incohérente) : ligne jamais détachée', async () => {
  const st = canceledWorld();
  await L.scheduleNomadNumberDetach(CO, { now: T0, deps: st.deps });
  st.subs[0].status = 'active';
  assert.equal((await L.detachDueNomadNumbers({ now: T0 + 10 * DAY, deps: st.deps })).skipped, 1);
  assert.equal(st.lines.length, 1);
});

// ───────────── Étape 3 : 30 jours sans réaffectation -> résilié chez Twilio ─────────────

async function detachedWorld(o = {}) {
  const st = canceledWorld(o);
  await L.scheduleNomadNumberDetach(CO, { now: T0, deps: st.deps });
  await L.detachDueNomadNumbers({ now: T0 + 10 * DAY, deps: st.deps });
  return st;
}
const D30 = T0 + 40 * DAY;

test('moins de 30 jours dans le stock : rien', async () => {
  const st = await detachedWorld();
  const r = await L.releaseUnclaimedNomadNumbers({ now: D30 - 1000, releaseEnabled: true, deps: st.deps });
  assert.deepEqual(st.removed, []);
  assert.equal(r.released, 0);
});

test('drapeau désactivé (par défaut) : jamais résilié chez Twilio, journalisé, l’entrée reste à reprendre', async () => {
  const st = await detachedWorld();
  assert.equal(L.lifecycleConfig({}).releaseEnabled, false);
  const r = await L.runNomadNumberLifecycle({ now: D30, env: {}, deps: st.deps });
  assert.equal(r.release.disabled, 1);
  assert.deepEqual(st.removed, []);
  assert.equal(entry(st).status, 'detached');
  assert.ok(st.logs.some((l) => /DÉSACTIVÉE/.test(l)));
});

test('drapeau activé + dry-run : journalisé, rien n’est résilié', async () => {
  const st = await detachedWorld();
  const r = await L.runNomadNumberLifecycle({ now: D30, env: { NOMAD_NUMBER_RELEASE_ENABLED: 'true', NOMAD_NUMBER_LIFECYCLE_DRY_RUN: 'true' }, deps: st.deps });
  assert.equal(r.release.dryRun, 1);
  assert.deepEqual(st.removed, []);
  assert.equal(entry(st).status, 'detached');
});

test('drapeau activé, 30 jours sans réaffectation : résilié chez Twilio une seule fois ; rejoué : rien de plus', async () => {
  const st = await detachedWorld();
  const env = { NOMAD_NUMBER_RELEASE_ENABLED: 'true' };
  const r = await L.runNomadNumberLifecycle({ now: D30, env, deps: st.deps });
  assert.equal(r.release.released, 1);
  assert.deepEqual(st.removed, ['PN_old']);
  assert.deepEqual([entry(st).status, new Date(entry(st).releasedAt).getTime()], ['released', D30]);
  await L.runNomadNumberLifecycle({ now: D30 + DAY, env, deps: st.deps });
  assert.deepEqual(st.removed, ['PN_old']);
});

test('réaffecté à un autre client dans les 30 jours : jamais résilié, clos « réaffecté »', async () => {
  const st = await detachedWorld();
  st.lines.push(line({ _id: 'L9', companyId: OTHER, createdAt: new Date(T0 + 20 * DAY) }));
  const r = await L.releaseUnclaimedNomadNumbers({ now: D30, releaseEnabled: true, deps: st.deps });
  assert.equal(r.reassigned, 1);
  assert.deepEqual(st.removed, []);
  assert.equal(entry(st).status, 'reassigned');
});

test('fiche HARX encore présente sans retenir le numéro (ligne libérée) : jamais résilié, en attente', async () => {
  const st = await detachedWorld();
  st.lines.push(line({ _id: 'L9', companyId: OTHER, status: 'released' }));
  const r = await L.releaseUnclaimedNomadNumbers({ now: D30, releaseEnabled: true, deps: st.deps });
  assert.equal(r.waiting, 1);
  assert.deepEqual(st.removed, []);
  assert.equal(entry(st).status, 'detached');
});

test('exclusions : TWILIO_INVENTORY_EXCLUDE, numéro d’essai, webhook de l’essai, autre environnement -> jamais résilié', async () => {
  const cases = [
    { excluded: [OLD] },
    { trial: [OLD] },
    { twilio: { [OLD]: { sid: 'PN_old', phoneNumber: OLD, voiceUrl: 'https://api.test/api/trial-call/voice' } } },
    { twilio: { [OLD]: { sid: 'PN_old', phoneNumber: OLD, voiceUrl: 'https://api-autre-env.test/api/inbound' } } },
  ];
  for (const c of cases) {
    const st = await detachedWorld(c);
    const r = await L.releaseUnclaimedNomadNumbers({ now: D30, releaseEnabled: true, deps: st.deps });
    assert.equal(r.excluded, 1, JSON.stringify(c));
    assert.deepEqual(st.removed, [], JSON.stringify(c));
    assert.equal(entry(st).status, 'excluded');
  }
});

test('plus au compte Twilio : clos « disparu » ; Twilio illisible : rien, réessayé', async () => {
  const st = await detachedWorld({ twilio: {} });
  assert.equal((await L.releaseUnclaimedNomadNumbers({ now: D30, releaseEnabled: true, deps: st.deps })).gone, 1);
  const st2 = await detachedWorld();
  st2.twilioDown = true;
  assert.equal((await L.releaseUnclaimedNomadNumbers({ now: D30, releaseEnabled: true, deps: st2.deps })).failed, 1);
  assert.equal(entry(st2).status, 'detached');
});

test('release en échec chez Twilio : entrée rendue « détachée » avec l’erreur, réessayée ; verrou abandonné repris après 10 min', async () => {
  const st = await detachedWorld();
  st.removeFails = true;
  assert.equal((await L.releaseUnclaimedNomadNumbers({ now: D30, releaseEnabled: true, deps: st.deps })).failed, 1);
  assert.deepEqual([entry(st).status, /twilio 500/.test(entry(st).lastError)], ['detached', true]);
  st.removeFails = false;
  // Verrou laissé par une instance arrêtée en route.
  Object.assign(entry(st), { status: 'releasing', lockAt: new Date(D30) });
  assert.equal((await L.releaseUnclaimedNomadNumbers({ now: D30 + 60e3, releaseEnabled: true, deps: st.deps })).released, 0, 'verrou récent respecté');
  assert.equal((await L.releaseUnclaimedNomadNumbers({ now: D30 + L.RELEASE_LOCK_MS, releaseEnabled: true, deps: st.deps })).released, 1);
  assert.deepEqual(st.removed, ['PN_old']);
});

test('numéro repris par une société entre la vérification et la résiliation : jamais résilié', async () => {
  const st = await detachedWorld();
  let reads = 0;
  const base = st.deps.recordsOf;
  st.deps.recordsOf = async (e164) => (++reads === 2 ? [line({ _id: 'L9', companyId: OTHER })] : base(e164));
  const r = await L.releaseUnclaimedNomadNumbers({ now: D30, releaseEnabled: true, deps: st.deps });
  assert.equal(r.waiting, 1);
  assert.deepEqual(st.removed, []);
  assert.equal(entry(st).status, 'detached');
});

// ───────────── Réabonnement : l'ancien numéro ne compte plus comme « ligne existante » ─────────────

const NOMAD_LIMITS = { product: 'callcenter', callcenterTier: 'nomad_solo', activeLocalNumbers: 1, planName: 'Nomad' };
const countWith = async (st, q) => st.lines.filter((l) => String(l.companyId) === String(q.companyId) && !(q['metadata.nomadDetach'] && l.metadata?.nomadDetach) && !(q._id?.$nin || []).includes(l._id)).length;

test('réabonné AVANT le détachement (ancienne ligne marquée) : 0 ligne comptée -> première ligne incluse, aucun plafond', async () => {
  const st = canceledWorld();
  await L.scheduleNomadNumberDetach(CO, { now: T0, deps: st.deps });
  st.subs.push(sub({ _id: 'S2', status: 'active', createdAt: new Date(T0 + DAY) }));
  // Base (#620) : toutes les lignes comptées -> 1 : ni incluse ni autorisée (l'achat après paiement échouait).
  assert.equal(isLineIncluded(NOMAD_LIMITS, st.lines.length), false);
  assert.ok(localNumberLimitPayload(NOMAD_LIMITS, st.lines.length));
  const n = await countWith(st, await L.countedLinesQuery(CO, { deps: st.deps }));
  assert.equal(n, 0);
  assert.equal(isLineIncluded(NOMAD_LIMITS, n), true);
  assert.equal(localNumberLimitPayload(NOMAD_LIMITS, n), null);
});

test('réabonné, ancienne ligne jamais marquée (webhook perdu, résilié avant ce traitement) : 0 ligne comptée ; aucune marque posée à l’aveugle', async () => {
  const st = canceledWorld({ subs: [sub({ _id: 'S1', status: 'canceled' }), sub({ _id: 'S2', status: 'active', createdAt: new Date(T0) })] });
  const q = await L.countedLinesQuery(CO, { deps: st.deps });
  assert.equal(await countWith(st, q), 0);
  // La reprise horaire ne détache pas une ligne qu'un réabonné utilise peut-être encore.
  await L.runNomadNumberLifecycle({ now: T0, env: {}, deps: st.deps });
  assert.equal(st.lines[0].metadata.nomadDetach, undefined);
});

test('réabonné : la nouvelle ligne achetée planifie le départ de l’ancienne (fin de sa période payée), jamais la nouvelle', async () => {
  const st = canceledWorld({ subs: [sub({ _id: 'S1', status: 'canceled' }), sub({ _id: 'S2', status: 'active', createdAt: new Date(T0) })] });
  st.lines.push(line({ _id: 'L2', phoneNumber: NEW, twilioId: 'PN_new', createdAt: new Date(T0 + 3600e3) }));
  const r = await L.scheduleNomadNumberDetach(CO, { now: T0 + 2 * 3600e3, afterNewLine: true, deps: st.deps });
  assert.equal(r.scheduled, 1);
  assert.ok(st.lines.find((l) => l._id === 'L1').metadata.nomadDetach);
  assert.equal(st.lines.find((l) => l._id === 'L2').metadata.nomadDetach, undefined);
  // La nouvelle ligne est la seule comptée (une ligne : plafond NOMAD atteint pour un 2e achat).
  assert.equal(await countWith(st, await L.countedLinesQuery(CO, { deps: st.deps })), 1);
  // Fin de période de l'ancien abonnement : seule l'ancienne ligne part.
  await L.detachDueNomadNumbers({ now: T0 + 10 * DAY, deps: st.deps });
  assert.deepEqual(st.lines.map((l) => l.phoneNumber), [NEW]);
});

test('réabonné sans nouvelle ligne : afterNewLine ne fait rien (rien à remplacer)', async () => {
  const st = canceledWorld({ subs: [sub({ _id: 'S1', status: 'canceled' }), sub({ _id: 'S2', status: 'active', createdAt: new Date(T0) })] });
  assert.equal((await L.scheduleNomadNumberDetach(CO, { now: T0, afterNewLine: true, deps: st.deps })).reason, 'resubscribed');
});

test('abonné actif jamais résilié : toutes ses lignes comptent (aucun changement)', async () => {
  const st = world({ subs: [sub({ _id: 'S1', status: 'active' })], lines: [line({ _id: 'L1' })] });
  assert.equal(await countWith(st, await L.countedLinesQuery(CO, { deps: st.deps })), 1);
});

// ───────────── Contrôleur : « première ligne incluse » au réabonnement (route réelle, base simulée) ─────────────

test('contrôleur : isFirstLineIncluded d’un réabonné NOMAD = vrai (base : faux, achat après paiement en échec)', async () => {
  const { phoneNumberController } = await import('../controllers/phoneNumberController.js');
  const { PhoneNumber } = await import('../models/PhoneNumber.js');
  const { Subscription } = await import('../models/Subscription.js');
  const CID = '64b0000000000000000000aa';
  const subs = [sub({ _id: new mongoose.Types.ObjectId(), companyId: CID, status: 'canceled' }), sub({ _id: new mongoose.Types.ObjectId(), companyId: CID, status: 'active', createdAt: new Date(Date.now() - DAY) })];
  const oldLine = line({ _id: new mongoose.Types.ObjectId(), companyId: CID, createdAt: new Date(Date.now() - 50 * DAY) });
  const saved = { find: Subscription.find, findOne: Subscription.findOne, pfind: PhoneNumber.find, count: PhoneNumber.countDocuments, rs: Object.getOwnPropertyDescriptor(mongoose.connection, 'readyState') };
  try {
    Subscription.findOne = () => ({ populate: async () => ({ planId: NOMAD }) });
    Subscription.find = () => ({ populate: () => ({ lean: async () => subs }) });
    PhoneNumber.find = () => ({ select: () => ({ lean: async () => [oldLine] }) });
    PhoneNumber.countDocuments = async (q) => [oldLine].filter((l) => !(q._id?.$nin || []).some((x) => String(x) === String(l._id)) && !(q['metadata.nomadDetach'] && l.metadata?.nomadDetach)).length;
    Object.defineProperty(mongoose.connection, 'readyState', { configurable: true, get: () => 1 });
    assert.equal(await phoneNumberController.isFirstLineIncluded(CID), true, 'ancienne ligne non comptée');
    // Sans résiliation NOMAD (abonné actif avec sa ligne) : la ligne compte, rien n'est inclus en plus.
    Subscription.find = () => ({ populate: () => ({ lean: async () => [subs[1]] }) });
    assert.equal(await phoneNumberController.isFirstLineIncluded(CID), false);
  } finally {
    Subscription.find = saved.find; Subscription.findOne = saved.findOne; PhoneNumber.find = saved.pfind; PhoneNumber.countDocuments = saved.count;
    if (saved.rs) Object.defineProperty(mongoose.connection, 'readyState', saved.rs); else delete mongoose.connection.readyState;
  }
});
