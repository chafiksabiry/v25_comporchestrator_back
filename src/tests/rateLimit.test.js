// Run: node --test src/tests/rateLimit.test.js
// Limiteur en mémoire (integrations/rateLimit.js) : fenêtre glissante, mémoire bornée, purge espacée.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../integrations/rateLimit.js';

test('fenêtre glissante : refus au-delà de la limite, Retry-After, puis de nouveau accepté', () => {
  let t = 0;
  const rl = createRateLimiter({ limit: 2, windowMs: 1000, now: () => t });
  assert.equal(rl.check('a').ok, true);
  assert.equal(rl.check('a').ok, true);
  const no = rl.check('a');
  assert.equal(no.ok, false);
  assert.equal(no.retryAfterSeconds, 1);
  t = 1001;
  assert.equal(rl.check('a').ok, true);
});

test('table plafonnée : au plus maxKeys clés, la plus ancienne laisse sa place', () => {
  let t = 0;
  const rl = createRateLimiter({ limit: 5, windowMs: 60_000, now: () => t, maxKeys: 3, sweepEveryMs: 60_000 });
  for (const k of ['a', 'b', 'c']) { t += 1; rl.check(k); }
  assert.equal(rl.size(), 3);
  t += 1;
  assert.equal(rl.check('d').ok, true);
  assert.equal(rl.size(), 3, 'jamais plus de maxKeys clés');
  // « a » (la plus ancienne) a été retirée : elle repart de zéro ; « b », « c », « d » restent suivies.
  for (let i = 0; i < 5; i++) rl.check('d');
  assert.equal(rl.check('d').ok, false);
});

test('purge des clés expirées au plus une fois par intervalle, pas à chaque requête', () => {
  let t = 0;
  const rl = createRateLimiter({ limit: 5, windowMs: 100, now: () => t, maxKeys: 1000, sweepEveryMs: 1000 });
  for (let i = 0; i < 50; i++) rl.check(`k${i}`);
  t = 500; // clés expirées, mais intervalle de purge pas encore écoulé
  rl.check('x');
  assert.equal(rl.size(), 51, 'aucune purge avant l’intervalle');
  t = 1001;
  rl.check('y');
  assert.equal(rl.size(), 1, 'purge faite à l’intervalle : seules les clés actives restent');
});

test('valeurs par défaut : 10 000 clés au plus', () => {
  let t = 0;
  const rl = createRateLimiter({ limit: 1, windowMs: 3_600_000, now: () => t });
  for (let i = 0; i < 10_050; i++) { t += 1; rl.check(`ip${i}`); }
  assert.equal(rl.size(), 10_000);
});
