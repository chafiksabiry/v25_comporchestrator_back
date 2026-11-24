// Run: node --test src/tests/nomadAppLinkSms.test.js
// « M'envoyer le lien par SMS » (app HARX Nomad) : mobile du compte seulement, 1 envoi par minute, 3 par jour, numéro masqué,
// expéditeur des codes d'inscription, échec rendu. Aucun SMS ni accès réseau : envoi, magasin et horloge simulés.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { createNomadAppLinkController, appLinkSmsConfig } = await import('../controllers/nomadAppLinkController.js');
const { appLinkSmsBody, maskPhone, mobileOf } = await import('../services/nomadAppLink/appLinkSms.js');

const AC = `AC${'0'.repeat(32)}`;
const ENV = { TWILIO_ACCOUNT_SID: AC, TWILIO_AUTH_TOKEN: 'x', TWILIO_PHONE_NUMBER: '+33757000000' };
const USER = '64b000000000000000000001';

function memoryStore(users) {
  const n = new Map();
  return {
    n,
    async bump(key, limit) { const v = n.get(key) || 0; if (v >= limit) return false; n.set(key, v + 1); return true; },
    async unbump(key) { n.set(key, Math.max(0, (n.get(key) || 0) - 1)); },
    async findUser(id) { return users[id] || null; },
  };
}
function setup({ users = { [USER]: { phone: '+33612345608', isVerified: true } }, env = ENV, sendSms } = {}) {
  let t = Date.UTC(2026, 10, 23, 10, 0, 0);
  const sent = [];
  const store = memoryStore(users);
  const c = createNomadAppLinkController({ store, env, now: () => t, sendSms: sendSms || (async (cfg, msg) => { sent.push({ cfg, msg }); return { sid: 'SM1' }; }) });
  const call = async (body = { lang: 'fr' }, user = { userId: USER }) => {
    let status = 200; let json;
    const res = { status(s) { status = s; return this; }, json(j) { json = j; return this; } };
    await c.send({ user, body }, res);
    return { status, json };
  };
  return { call, sent, store, tick: (ms) => { t += ms; } };
}

test('envoi au mobile du compte, numéro masqué, texte traduit avec harx.ai/app, expéditeur des codes d’inscription', async () => {
  const s = setup();
  const r = await s.call({ lang: 'es', to: '+33700000000' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, to: '+33 6 •• •• •• 08' });
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].msg.to, '+33612345608', 'jamais le numéro de la requête');
  assert.equal(s.sent[0].msg.body, 'HARX Nomad: descargue la app en este teléfono: https://harx.ai/app');
  assert.equal(s.sent[0].cfg.smsFrom, '+33757000000');
  assert.equal(appLinkSmsConfig({ ...ENV, TRIAL_CALL_SMS_FROM: 'HARX' }).smsFrom, 'HARX');
});

test('1 envoi par minute, 3 par jour ; un refus ne consomme rien', async () => {
  const s = setup();
  assert.equal((await s.call()).status, 200);
  const again = await s.call();
  assert.equal(again.status, 429);
  assert.equal(again.json.code, 'rate_minute');
  assert.ok(again.json.retryAfter > 0 && again.json.retryAfter <= 60);
  s.tick(61_000); assert.equal((await s.call()).status, 200);
  s.tick(61_000); assert.equal((await s.call()).status, 200);
  s.tick(61_000);
  const day = await s.call();
  assert.equal(day.status, 429);
  assert.equal(day.json.code, 'rate_day');
  assert.equal(s.sent.length, 3);
  s.tick(86_400_000); assert.equal((await s.call()).status, 200, 'le lendemain : de nouveau possible');
});

test('sans session : 401 ; sans mobile vérifié (absent, fixe, compte non vérifié) : 409, aucun envoi', async () => {
  assert.equal((await setup().call({}, {})).status, 401);
  for (const u of [null, { isVerified: true }, { phone: '+33142000001', isVerified: true }, { phone: '+33612345608', isVerified: false }, { phone: 'n’importe quoi', isVerified: true }]) {
    const s = setup({ users: u ? { [USER]: u } : {} });
    const r = await s.call();
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'no_verified_mobile');
    assert.equal(s.sent.length, 0);
  }
});

test('Twilio non configuré : 503 ; échec d’envoi : 502 et compteurs rendus ; simulation : aucun envoi', async () => {
  assert.equal((await setup({ env: {} }).call()).json.code, 'sms_unavailable');
  const s = setup({ sendSms: async () => { throw new Error('twilio'); } });
  const r = await s.call();
  assert.equal(r.status, 502);
  assert.equal(r.json.code, 'sms_failed');
  assert.ok([...s.store.n.values()].every((v) => v === 0), 'aucun envoi décompté');
  const dry = setup({ env: { NOMAD_APP_LINK_SMS_DRY_RUN: 'true' }, sendSms: async () => { throw new Error('ne doit pas être appelé'); } });
  assert.deepEqual((await dry.call()).json, { ok: true, to: '+33 6 •• •• •• 08', simulated: true });
});

test('textes, masque et mobile', () => {
  for (const l of ['fr', 'en', 'es', 'ar']) assert.match(appLinkSmsBody(l), /https:\/\/harx\.ai\/app$/);
  assert.equal(appLinkSmsBody('de'), appLinkSmsBody('en'));
  assert.match(maskPhone('+447700900123'), /^\+44 7[•\s]+23$/);
  assert.equal(mobileOf('+33612345608'), '+33612345608');
  assert.equal(mobileOf('+33142000001'), null);
});

test('route montée, protégée par la session', () => {
  const route = fs.readFileSync(new URL('../routes/nomadAppLink.js', import.meta.url), 'utf8');
  assert.match(route, /router\.post\('\/link-sms', authenticate, c\.send\)/);
  assert.match(fs.readFileSync(new URL('../../index.js', import.meta.url), 'utf8'), /app\.use\('\/api\/nomad-app', nomadAppLinkRoutes\)/);
});

test('limites par compte : un autre compte n’est pas bloqué ; le numéro de la requête est ignoré', async () => {
  const OTHER = '64b000000000000000000002';
  const s = setup({ users: { [USER]: { phone: '+33612345608', isVerified: true }, [OTHER]: { phone: '+33698765401', isVerified: true } } });
  assert.equal((await s.call()).status, 200);
  assert.equal((await s.call()).json.code, 'rate_minute');
  const other = await s.call({ lang: 'fr', phone: '+33700000000' }, { userId: OTHER });
  assert.equal(other.status, 200);
  assert.equal(s.sent[1].msg.to, '+33698765401');
});
