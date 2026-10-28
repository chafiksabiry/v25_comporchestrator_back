import assert from 'node:assert/strict';
import { computeInboundStats } from '../services/inboundStats.js';

const now = Date.parse('2026-10-28T12:00:00Z');
const at = (s) => new Date(now - s * 1000).toISOString();
const rows = [
  { status: 'answered', waitSeconds: 8, startedAt: at(600) },
  { status: 'answered', waitSeconds: 32, startedAt: at(500) },
  { status: 'abandoned', waitSeconds: 15, startedAt: at(400) },
  { status: 'no_agent', waitSeconds: 0, startedAt: at(300) },
  { status: 'ringing', waitSeconds: null, startedAt: at(30) }, // en cours : pas encore compté
  { status: 'ringing', waitSeconds: null, startedAt: at(900) }, // périmé : abandonné
];
const s = computeInboundStats(rows, { slaSeconds: 20, now });
assert.equal(s.offered, 5);
assert.equal(s.answered, 2);
assert.equal(s.service_level, 20); // 1 appel décroché en 20 s ou moins sur 5
assert.equal(s.abandon_rate, 60);
assert.equal(s.avg_wait, 20);
assert.equal(s.max_wait, 32);
assert.deepEqual(computeInboundStats([], { now }), { offered: 0, answered: 0, service_level: null, abandon_rate: null, avg_wait: null, max_wait: null });

// Un message laissé sur le répondeur (status 'voicemail') n'est pas un appel décroché : compté comme les appels
// 'missed' / 'no_agent' (offerts, non décrochés => abandon, hors niveau de service). Aucune règle nouvelle.
const withVm = [
  { status: 'answered', waitSeconds: 5, startedAt: at(100) },
  { status: 'voicemail', waitSeconds: 30, startedAt: at(90) },
  { status: 'missed', waitSeconds: 30, startedAt: at(80) },
];
const v = computeInboundStats(withVm, { slaSeconds: 20, now });
assert.equal(v.offered, 3);
assert.equal(v.answered, 1);
assert.equal(v.abandon_rate, 66.7);
assert.equal(v.service_level, 33.3);
assert.deepEqual(computeInboundStats(withVm.map((r) => (r.status === 'voicemail' ? { ...r, status: 'missed' } : r)), { slaSeconds: 20, now }), v);
console.log('inboundStats OK');
