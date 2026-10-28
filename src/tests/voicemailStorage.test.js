// Run: TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=tok node src/tests/voicemailStorage.test.js
import assert from 'node:assert/strict';

process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'tok';
const { downloadFromTwilio, deleteTwilioRecording } = await import('../services/voicemailStorage.js');

const URL_OK = 'https://api.twilio.com/2010-04-01/Accounts/ACtest/Recordings/RE' + 'a'.repeat(32);
const calls = [];
const stub = (respond) => { globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), method: init.method || 'GET', auth: init.headers?.Authorization }); return respond(); }; };

// Téléchargement : .mp3, identifiants Twilio, uniquement chez Twilio
stub(() => new Response(Buffer.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3]), { status: 200 }));
const audio = await downloadFromTwilio(URL_OK);
assert.equal(audio.length, 7);
assert.equal(calls[0].url, `${URL_OK}.mp3`);
assert.match(calls[0].auth, /^Basic /);
await assert.rejects(() => downloadFromTwilio('https://evil.example/rec'), /invalid recording url/);
assert.equal(calls.length, 1, 'aucune requête vers un hôte non Twilio');
stub(() => new Response('', { status: 404 }));
await assert.rejects(() => downloadFromTwilio(URL_OK), /status 404/);
stub(() => new Response(Buffer.alloc(0), { status: 200 }));
await assert.rejects(() => downloadFromTwilio(URL_OK), /empty recording/);

// Suppression de l'original chez Twilio : plus de frais de stockage ; un enregistrement déjà absent n'est pas une erreur
calls.length = 0;
stub(() => new Response(null, { status: 204 }));
await deleteTwilioRecording(URL_OK);
assert.deepEqual([calls[0].method, calls[0].url], ['DELETE', `${URL_OK}.json`]);
stub(() => new Response('', { status: 404 }));
await deleteTwilioRecording(URL_OK);
stub(() => new Response('', { status: 500 }));
await assert.rejects(() => deleteTwilioRecording(URL_OK), /status 500/);
await assert.rejects(() => deleteTwilioRecording('https://evil.example/rec'), /invalid recording url/);
console.log('voicemailStorage OK');
