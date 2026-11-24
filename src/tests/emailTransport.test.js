import test from 'node:test';
import assert from 'node:assert/strict';
import { platformTransport, brevoPayloadToSmtp, isEmailConfigured } from '../services/emailService.js';

const SMTP = { SMTP_HOST: 'smtp.example', SMTP_USER: 'u@harx.ai', SMTP_PASS: 'x' };
const BREVO = { BREVO_API_KEY: 'k', BREVO_SENDER_EMAIL: 'no-reply@harx.ai' };
const payload = { sender: { email: 'no-reply@harx.ai', name: 'HARX support' }, to: [{ email: 'support@harx.ai' }], cc: [{ email: 'a@b.co' }], subject: 'S', textContent: 'T' };

test('Brevo en échec → SMTP (comme le service d’inscription)', async () => {
  const calls = [];
  const r = await platformTransport(payload, { env: { ...BREVO, ...SMTP }, brevo: async () => { calls.push('brevo'); throw new Error('Brevo : API Key is not enabled'); }, smtp: async () => { calls.push('smtp'); return { messageId: 'm' }; } });
  assert.deepEqual(calls, ['brevo', 'smtp']); assert.equal(r.messageId, 'm');
});
test('Brevo qui marche → pas de SMTP', async () => {
  const calls = [];
  await platformTransport(payload, { env: { ...BREVO, ...SMTP }, brevo: async () => { calls.push('brevo'); return {}; }, smtp: async () => { calls.push('smtp'); } });
  assert.deepEqual(calls, ['brevo']);
});
test('SMTP seul configuré → SMTP', async () => {
  const calls = [];
  await platformTransport(payload, { env: SMTP, brevo: async () => calls.push('brevo'), smtp: async () => calls.push('smtp') });
  assert.deepEqual(calls, ['smtp']); assert.equal(isEmailConfigured(SMTP), true);
});
test('Brevo en échec sans SMTP → erreur Brevo remonte', async () => {
  await assert.rejects(platformTransport(payload, { env: BREVO, brevo: async () => { throw new Error('Brevo : X'); }, smtp: async () => {} }), /Brevo : X/);
});
test('rien de configuré → erreur, pas d’envoi', async () => {
  assert.equal(isEmailConfigured({}), false);
  await assert.rejects(platformTransport(payload, { env: {} }), /ni BREVO_API_KEY ni SMTP/);
});
test('conversion : expéditeur SMTP_FROM_EMAIL ou SMTP_USER, destinataires, copie, texte', () => {
  const m = brevoPayloadToSmtp(payload, SMTP);
  assert.equal(m.from, '"HARX support" <u@harx.ai>');
  assert.deepEqual(m.to, ['support@harx.ai']); assert.deepEqual(m.cc, ['a@b.co']);
  assert.equal(m.subject, 'S'); assert.equal(m.text, 'T'); assert.equal(m.replyTo, 'u@harx.ai');
  assert.equal(brevoPayloadToSmtp(payload, { ...SMTP, SMTP_FROM_EMAIL: 'f@harx.ai' }).from, '"HARX support" <f@harx.ai>');
});
