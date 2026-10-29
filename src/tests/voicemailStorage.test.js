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

// Cloudinary : signature SHA-1 des paramètres triés + secret, dépôt privé, relecture signée
const { signCloudinary, uploadToCloudinary, downloadFromCloudinary, cloudinaryEnabled } = await import('../services/voicemailStorage.js');
assert.equal(signCloudinary({ timestamp: 1, public_id: 'x', type: 'private', folder: '' }, 'sec'), (await import('node:crypto')).createHash('sha1').update('public_id=x&timestamp=1&type=privatesec').digest('hex'));
assert.equal(cloudinaryEnabled(), false);
process.env.CLOUDINARY_CLOUD_NAME = 'demo'; process.env.CLOUDINARY_API_KEY = 'k'; process.env.CLOUDINARY_API_SECRET = 's';
assert.equal(cloudinaryEnabled(), true);
calls.length = 0;
globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), body: init.body }); return new Response(JSON.stringify({ public_id: 'harx/callcentre/voicemails/abc' }), { status: 200 }); };
assert.equal(await uploadToCloudinary('abc', Buffer.from([1, 2, 3])), 'harx/callcentre/voicemails/abc');
assert.equal(calls[0].url, 'https://api.cloudinary.com/v1_1/demo/video/upload');
assert.equal(calls[0].body.get('type'), 'private');
assert.equal(calls[0].body.get('api_key'), 'k');
assert.ok(calls[0].body.get('signature'));
globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'bad' } }), { status: 401 });
await assert.rejects(() => uploadToCloudinary('abc', Buffer.from([1])), /status 401 bad/);
calls.length = 0;
globalThis.fetch = async (url) => { calls.push(String(url)); return new Response(Buffer.from([9, 9]), { status: 200 }); };
assert.equal((await downloadFromCloudinary('harx/callcentre/voicemails/abc')).length, 2);
assert.match(calls[0], /^https:\/\/api\.cloudinary\.com\/v1_1\/demo\/video\/download\?.*type=private.*signature=/);
console.log('voicemailStorage OK');
