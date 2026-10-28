// Run: node src/tests/inboundSettings.test.js
import assert from 'node:assert/strict';
import { audioVersion, isMp3, toPublicSettings, validateSettingsInput } from '../services/inboundSettings.js';

// Valeurs par défaut sans document
assert.deepEqual(toPublicSettings(null), {
  greetingText: '', voicemailText: '', voice: 'nova', ringTimeoutSeconds: 30, voicemailEnabled: true,
  greetingValidated: false, voicemailValidated: false, greetingAudioVersion: null, voicemailAudioVersion: null, validatedAt: null,
});

// Validation
const bad = (body) => assert.equal(validateSettingsInput(body).ok, false, JSON.stringify(body));
const good = (body) => assert.equal(validateSettingsInput(body).ok, true, JSON.stringify(body));
for (const n of [4, 121, 5.5, '30', null, NaN]) bad({ ringTimeoutSeconds: n });
for (const n of [5, 30, 120]) good({ ringTimeoutSeconds: n });
bad({ voice: 'alloy' });
for (const v of ['nova', 'shimmer', 'coral', 'onyx', 'echo', 'ash']) good({ voice: v });
bad({ greetingText: 'x'.repeat(601) });
good({ greetingText: 'x'.repeat(600) });
bad({ voicemailText: 12 });
bad({ voicemailEnabled: 'true' });
const r = validateSettingsInput({ voice: 'zzz', ringTimeoutSeconds: 1 });
assert.equal(r.errors.length, 2);
assert.match(r.errors[0], /Voix inconnue/);
assert.deepEqual(validateSettingsInput({ greetingText: '  Bonjour  ' }).value, { greetingText: 'Bonjour' });

// greetingValidated / voicemailValidated
const doc = {
  greetingText: 'Bonjour', voicemailText: 'Message', voice: 'nova',
  greetingAudio: { version: 'v1', text: 'Bonjour', voice: 'nova' },
  voicemailAudio: { version: 'v2', text: 'Ancien', voice: 'nova' },
};
let p = toPublicSettings(doc);
assert.equal(p.greetingValidated, true);
assert.equal(p.voicemailValidated, false, 'texte différent du snapshot');
assert.equal(p.greetingAudioVersion, 'v1');
assert.equal(p.voicemailAudioVersion, 'v2');
assert.equal(toPublicSettings({ ...doc, voice: 'onyx' }).greetingValidated, false, 'voix changée');
assert.equal(toPublicSettings({ ...doc, greetingText: '' }).greetingValidated, false);
assert.ok(!('data' in p) && !JSON.stringify(p).includes('data'));

// Signature MP3
const pad = (head) => Buffer.concat([Buffer.from(head), Buffer.alloc(2000)]);
assert.equal(isMp3(pad([0x49, 0x44, 0x33, 3, 0])), true, 'ID3');
assert.equal(isMp3(pad([0xff, 0xfb, 0x90])), true, 'trame MPEG');
assert.equal(isMp3(pad([0xff, 0xe3])), true);
assert.equal(isMp3(pad([0x52, 0x49, 0x46, 0x46])), false, 'WAV');
assert.equal(isMp3(pad([0xff, 0x10])), false);
assert.equal(isMp3(Buffer.from([0x49, 0x44, 0x33, 3, 0])), false, 'trop petit');
assert.equal(isMp3(Buffer.concat([Buffer.from([0xff, 0xfb]), Buffer.alloc(1022)])), false, '1 ko pile : pas > 1 ko');
assert.equal(isMp3(undefined), false);
assert.equal(isMp3({}), false);

// Version
assert.match(audioVersion(Buffer.from('a')), /^[0-9a-f]{12}$/);
assert.notEqual(audioVersion(Buffer.from('a')), audioVersion(Buffer.from('b')));
console.log('inboundSettings OK');
