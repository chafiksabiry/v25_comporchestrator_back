import test from 'node:test';
import assert from 'node:assert/strict';
import { takeLine, releaseCall, takeFirstFreeLine, isLeaseLive, busyView, hasFreeLine, LINE_CALL_TTL_MS } from '../services/lineCalls.js';

// Faux modèle : mêmes sémantiques que la mise à jour conditionnelle d'UN document côté MongoDB ($or, $exists, $lte, chemin pointé, $set, $unset).
function fakeModel(ids) {
  const docs = new Map(ids.map((id) => [id, { _id: id }]));
  const get = (d, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), d);
  const cmp = (v, cond) => {
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('$exists' in cond) return (v !== undefined) === cond.$exists;
      if ('$lte' in cond) return v !== undefined && v !== null && new Date(v).getTime() <= new Date(cond.$lte).getTime();
    }
    if (cond === null) return v === null || v === undefined;
    return v === cond;
  };
  const match = (d, f) => Object.entries(f).every(([k, c]) => (k === '$or' ? c.some((sub) => match(d, sub)) : cmp(get(d, k), c)));
  return {
    docs,
    updateOne: async (f, u) => { const d = [...docs.values()].find((x) => match(x, f)); if (!d) return { matchedCount: 0, modifiedCount: 0 }; Object.assign(d, u.$set || {}); return { matchedCount: 1, modifiedCount: 1 }; },
    updateMany: async (f, u) => { let n = 0; for (const d of docs.values()) if (match(d, f)) { for (const k of Object.keys(u.$unset || {})) delete d[k]; n += 1; } return { matchedCount: n, modifiedCount: n }; },
    findOne: (f) => ({ lean: async () => [...docs.values()].find((x) => match(x, f)) || null }),
  };
}
const NOW = Date.UTC(2026, 10, 15, 10, 0, 0);

test('prise : une ligne libre est prise, une ligne tenue refuse un autre appel (entrant comme sortant)', async () => {
  const M = fakeModel(['L1']);
  assert.deepEqual(await takeLine({ lineId: 'L1', callSid: 'CA1', direction: 'inbound', now: NOW, Model: M }), { ok: true });
  assert.deepEqual(await takeLine({ lineId: 'L1', callSid: 'CA2', direction: 'outbound', now: NOW + 1000, Model: M }), { ok: false, reason: 'busy' });
  assert.deepEqual(await takeLine({ lineId: 'L1', callSid: 'CA3', direction: 'inbound', now: NOW + 1000, Model: M }), { ok: false, reason: 'busy' });
  assert.equal(M.docs.get('L1').activeCall.callSid, 'CA1');
});

test('concurrence : N prises parallèles sur K lignes libres ⇒ exactement K réussissent, aucune ligne n\'a deux appels', async () => {
  const lineIds = ['L1', 'L2', 'L3'];
  const M = fakeModel(lineIds);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => takeFirstFreeLine({ lineIds, callSid: `CA${i}`, direction: i % 2 ? 'inbound' : 'outbound', now: NOW, Model: M })));
  assert.equal(results.filter((r) => r.ok).length, 3);
  assert.equal(new Set(results.filter((r) => r.ok).map((r) => r.lineId)).size, 3);
  assert.equal(new Set(lineIds.map((id) => M.docs.get(id).activeCall.callSid)).size, 3);
  // même ligne visée par tous : un seul gagnant
  const M2 = fakeModel(['X']);
  const same = await Promise.all(Array.from({ length: 20 }, (_, i) => takeLine({ lineId: 'X', callSid: `S${i}`, direction: 'inbound', now: NOW, Model: M2 })));
  assert.equal(same.filter((r) => r.ok).length, 1);
});

test('libération idempotente par callSid ; relivraison du même webhook (même callSid) ne double pas la prise', async () => {
  const M = fakeModel(['L1']);
  await takeLine({ lineId: 'L1', callSid: 'CA1', direction: 'inbound', now: NOW, Model: M });
  assert.deepEqual(await takeLine({ lineId: 'L1', callSid: 'CA1', direction: 'inbound', now: NOW + 5, Model: M }), { ok: true });
  assert.equal((await releaseCall('CA9', { Model: M })).released, 0, 'autre appel : sans effet');
  assert.equal(M.docs.get('L1').activeCall.callSid, 'CA1');
  assert.equal((await releaseCall('CA1', { Model: M })).released, 1);
  assert.equal((await releaseCall('CA1', { Model: M })).released, 0, 'deuxième libération : sans effet');
  assert.equal((await releaseCall('', { Model: M })).released, 0);
  assert.deepEqual(await takeLine({ lineId: 'L1', callSid: 'CA2', direction: 'outbound', now: NOW + 10, Model: M }), { ok: true });
});

test('expiration de sécurité : un bail oublié expire après 2 h (purge à la prise), pas avant', async () => {
  assert.equal(LINE_CALL_TTL_MS, 2 * 60 * 60 * 1000);
  const M = fakeModel(['L1']);
  await takeLine({ lineId: 'L1', callSid: 'CA1', direction: 'inbound', now: NOW, Model: M });
  assert.equal((await takeLine({ lineId: 'L1', callSid: 'CA2', direction: 'inbound', now: NOW + LINE_CALL_TTL_MS - 1, Model: M })).ok, false);
  assert.equal((await takeLine({ lineId: 'L1', callSid: 'CA2', direction: 'inbound', now: NOW + LINE_CALL_TTL_MS, Model: M })).ok, true);
  assert.equal(M.docs.get('L1').activeCall.callSid, 'CA2');
});

test('constat de bail périmé à la prise : appel terminé côté opérateur ⇒ libéré puis pris ; vérification en échec ⇒ reste occupée', async () => {
  const M = fakeModel(['L1']);
  await takeLine({ lineId: 'L1', callSid: 'CA1', direction: 'inbound', now: NOW, Model: M });
  let asked = null;
  const stale = await takeLine({ lineId: 'L1', callSid: 'CA2', direction: 'outbound', now: NOW + 60_000, Model: M, isStale: async (lease) => { asked = lease.callSid; return true; } });
  assert.deepEqual([stale.ok, asked, M.docs.get('L1').activeCall.callSid], [true, 'CA1', 'CA2']);
  const notStale = await takeLine({ lineId: 'L1', callSid: 'CA3', direction: 'inbound', now: NOW + 70_000, Model: M, isStale: async () => false });
  assert.equal(notStale.ok, false);
  const broken = await takeLine({ lineId: 'L1', callSid: 'CA3', direction: 'inbound', now: NOW + 70_000, Model: M, isStale: async () => { throw new Error('twilio down'); } });
  assert.deepEqual(broken, { ok: false, reason: 'busy' });
  assert.equal(M.docs.get('L1').activeCall.callSid, 'CA2');
});

test('sans callSid : aucune prise ; lecture : busyView / hasFreeLine', async () => {
  const M = fakeModel(['L1']);
  assert.deepEqual(await takeLine({ lineId: 'L1', callSid: '', direction: 'inbound', Model: M }), { ok: false, reason: 'no_call_sid' });
  const free = { _id: 'a' }; const busy = { _id: 'b', activeCall: { callSid: 'C', startedAt: new Date(NOW), expiresAt: new Date(NOW + 1000) } };
  assert.deepEqual(busyView(free, NOW), { busy: false, activeCallStartedAt: null });
  assert.deepEqual(busyView(busy, NOW), { busy: true, activeCallStartedAt: new Date(NOW).toISOString() });
  assert.equal(isLeaseLive(busy, NOW + 1000), false);
  assert.equal(hasFreeLine([busy], NOW), false);
  assert.equal(hasFreeLine([busy, free], NOW), true);
});
