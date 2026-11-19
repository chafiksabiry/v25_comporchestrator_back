// Run: node --test src/tests/twimlApps.test.js
// P0.5 : la recette et la production partagent le même compte Twilio. Les applications TwiML des appels sortants du navigateur
// (« Mon poste ») et du rappel depuis la messagerie vocale étaient communes (même friendlyName) : l'environnement qui émettait le
// dernier jeton réécrivait leur VoiceUrl, et les appels de l'autre partaient vers la mauvaise API. Une application par environnement,
// jamais celle de l'autre. Twilio est SIMULÉ : aucun appel réel.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import mongoose from 'mongoose';

process.env.TELNYX_API_KEY ||= 'x';
process.env.TWILIO_ACCOUNT_SID ||= 'ACtest';
process.env.TWILIO_AUTH_TOKEN ||= 'x';
delete process.env.PUBLIC_API_BASE_URL;
delete process.env.RAILWAY_PUBLIC_DOMAIN;
delete process.env.TWILIO_OUTBOUND_TWIML_APP_SID;
delete process.env.TWILIO_CALLBACK_TWIML_APP_SID;

const T = await import('../services/twimlApps.js');
const { ensureOutboundApp, OUTBOUND_WEBHOOK_PATH } = await import('../services/browserOutbound.js');
const { ensureCallbackApp, CALLBACK_WEBHOOK_PATH } = await import('../services/voicemailCallback.js');
const { createVoiceToken } = await import('../services/voiceTokenService.js');

const PROD = 'v25comporchestratorback-production.up.railway.app';
const RECETTE = 'v25comporchestratorback-recette.up.railway.app';
const envOf = (host) => ({ RAILWAY_PUBLIC_DOMAIN: host });

let apps; let calls; let seq;
/** Compte Twilio simulé, PARTAGÉ par les deux environnements (comme en vrai). */
function fakeTwilio() {
  const applications = (sid) => ({
    update: async (p) => { calls.push(['update', sid, p]); if (!apps[sid]) throw new Error('404'); Object.assign(apps[sid], p); return { ...apps[sid] }; },
    fetch: async () => { calls.push(['fetch', sid]); return { ...apps[sid] }; },
    remove: async () => { calls.push(['remove', sid]); delete apps[sid]; return true; },
  });
  applications.list = async (q = {}) => {
    calls.push(['list', q]);
    await new Promise((r) => setImmediate(r));
    // Filtre volontairement LARGE (préfixe) : le code doit revérifier le nom exact.
    return Object.values(apps).filter((a) => !q.friendlyName || a.friendlyName.startsWith(q.friendlyName.split(' (')[0])).map((a) => ({ ...a }));
  };
  applications.create = async (p) => {
    calls.push(['create', p]);
    const sid = `AP${String(++seq).padStart(32, '0')}`;
    apps[sid] = { sid, voiceMethod: 'POST', dateCreated: new Date(2026, 10, seq).toISOString(), ...p };
    return { ...apps[sid] };
  };
  return { applications };
}
const seed = (friendlyName, voiceUrl, sid) => { apps[sid] = { sid, friendlyName, voiceUrl, voiceMethod: 'POST', dateCreated: '2026-01-01T00:00:00Z' }; return sid; };
const writes = () => calls.filter((c) => c[0] === 'create' || c[0] === 'update' || c[0] === 'remove');

beforeEach(() => { apps = {}; calls = []; seq = 0; T.resetTwimlAppCache(); });

test('libellé d\'environnement et nom : production, recette ; RAILWAY_PUBLIC_DOMAIN prime sur l\'hôte de la requête', () => {
  assert.equal(T.environmentLabel({ env: envOf(PROD) }), 'production');
  assert.equal(T.environmentLabel({ env: envOf(RECETTE) }), 'recette');
  assert.equal(T.environmentLabel({ env: envOf(RECETTE), req: { get: () => PROD } }), 'recette', 'le domaine Railway de l\'environnement gagne');
  assert.equal(T.environmentLabel({ env: {}, req: { get: () => 'orch.test' } }), 'orch.test', 'hors Railway : hôte de la requête');
  assert.equal(T.environmentLabel({ env: {} }), '');
  assert.equal(T.envAppName('harx-callcentre-outbound', 'recette'), 'harx-callcentre-outbound (recette)');
});

test('recette : crée SA propre application, pointée sur la recette ; ne touche ni la production ni l\'ancienne commune', async () => {
  const client = fakeTwilio();
  const prodSid = seed('harx-callcentre-outbound (production)', `https://${PROD}${OUTBOUND_WEBHOOK_PATH}`, 'APprod');
  const legacySid = seed('harx-callcentre-outbound', `https://${PROD}${OUTBOUND_WEBHOOK_PATH}`, 'APlegacy');
  const before = JSON.stringify({ prod: apps[prodSid], legacy: apps[legacySid] });

  const sid = await ensureOutboundApp(client, { env: envOf(RECETTE) });
  assert.notEqual(sid, prodSid); assert.notEqual(sid, legacySid);
  assert.equal(apps[sid].friendlyName, 'harx-callcentre-outbound (recette)');
  assert.equal(apps[sid].voiceUrl, `https://${RECETTE}${OUTBOUND_WEBHOOK_PATH}`);
  assert.equal(JSON.stringify({ prod: apps[prodSid], legacy: apps[legacySid] }), before, 'production et ancienne application intactes');
  assert.ok(writes().every((c) => c[0] === 'create'), 'aucune mise à jour d\'une application existante');
});

test('production : crée SA propre application ; jamais celle de la recette, même pointée ailleurs', async () => {
  const client = fakeTwilio();
  const recSid = seed('harx-callcentre-callback (recette)', `https://${RECETTE}${CALLBACK_WEBHOOK_PATH}`, 'APrec');
  const sid = await ensureCallbackApp(client, { env: envOf(PROD) });
  assert.notEqual(sid, recSid);
  assert.equal(apps[sid].friendlyName, 'harx-callcentre-callback (production)');
  assert.equal(apps[sid].voiceUrl, `https://${PROD}${CALLBACK_WEBHOOK_PATH}`);
  assert.equal(apps[recSid].voiceUrl, `https://${RECETTE}${CALLBACK_WEBHOOK_PATH}`);
  assert.ok(!writes().some((c) => c[1] === recSid), 'aucune écriture sur l\'application de la recette');
});

test('les deux environnements en alternance sur le même compte : chacun garde la sienne, aucune réécriture croisée', async () => {
  const client = fakeTwilio();
  for (let i = 0; i < 3; i += 1) {
    for (const host of [RECETTE, PROD]) {
      T.resetTwimlAppCache(); // redémarrage de l'environnement
      await ensureOutboundApp(client, { env: envOf(host) });
      await ensureCallbackApp(client, { env: envOf(host) });
    }
  }
  const list = Object.values(apps).map((a) => [a.friendlyName, a.voiceUrl]).sort();
  assert.deepEqual(list, [
    ['harx-callcentre-callback (production)', `https://${PROD}${CALLBACK_WEBHOOK_PATH}`],
    ['harx-callcentre-callback (recette)', `https://${RECETTE}${CALLBACK_WEBHOOK_PATH}`],
    ['harx-callcentre-outbound (production)', `https://${PROD}${OUTBOUND_WEBHOOK_PATH}`],
    ['harx-callcentre-outbound (recette)', `https://${RECETTE}${OUTBOUND_WEBHOOK_PATH}`],
  ]);
  assert.equal(writes().length, 4, '4 créations, aucune mise à jour');
  assert.ok(writes().every((c) => c[0] === 'create'));
});

test('idempotence : appels répétés, redémarrage et demandes simultanées => une seule application, aucune écriture inutile', async () => {
  const client = fakeTwilio();
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => ensureOutboundApp(client, { env: envOf(RECETTE) })));
  assert.equal(a, b); assert.equal(b, c);
  assert.equal(calls.filter((x) => x[0] === 'create').length, 1, 'demandes simultanées : une seule création');
  assert.equal(await ensureOutboundApp(client, { env: envOf(RECETTE) }), a);
  T.resetTwimlAppCache();
  calls = [];
  assert.equal(await ensureOutboundApp(client, { env: envOf(RECETTE) }), a, 'après redémarrage : retrouvée par son nom');
  assert.deepEqual(writes(), [], 'déjà bonne : ni création ni mise à jour');
  assert.equal(Object.keys(apps).length, 1);
});

test('dérive : SA propre application pointée ailleurs est réalignée (elle seule) ; un échec n\'est pas mis en cache', async () => {
  const client = fakeTwilio();
  const mine = seed('harx-callcentre-outbound (recette)', 'https://old.example/x', 'APmine');
  const prod = seed('harx-callcentre-outbound (production)', 'https://old.example/x', 'APprod');
  assert.equal(await ensureOutboundApp(client, { env: envOf(RECETTE) }), mine);
  assert.deepEqual(writes(), [['update', mine, { voiceUrl: `https://${RECETTE}${OUTBOUND_WEBHOOK_PATH}`, voiceMethod: 'POST' }]]);
  assert.equal(apps[prod].voiceUrl, 'https://old.example/x', 'la production n\'est pas réalignée par la recette');

  T.resetTwimlAppCache();
  const broken = { applications: Object.assign(() => ({}), { list: async () => { throw new Error('twilio down'); } }) };
  await assert.rejects(ensureCallbackApp(broken, { env: envOf(RECETTE) }), /twilio down/);
  assert.ok(await ensureCallbackApp(client, { env: envOf(RECETTE) }), 'nouvel essai après l\'échec');
});

test('SID imposé par variable d\'environnement : utilisé tel quel, AUCUN appel ni mise à jour chez Twilio', async () => {
  const client = fakeTwilio();
  seed('harx-callcentre-outbound (production)', `https://${PROD}${OUTBOUND_WEBHOOK_PATH}`, 'APpinned');
  assert.equal(await ensureOutboundApp(client, { env: { ...envOf(RECETTE), TWILIO_OUTBOUND_TWIML_APP_SID: 'APpinned' } }), 'APpinned');
  assert.equal(await ensureCallbackApp(client, { env: { ...envOf(RECETTE), TWILIO_CALLBACK_TWIML_APP_SID: 'APpinnedcb' } }), 'APpinnedcb');
  assert.deepEqual(calls, []);
  assert.equal(apps.APpinned.voiceUrl, `https://${PROD}${OUTBOUND_WEBHOOK_PATH}`);
});

test('sans URL publique connue : refus explicite, rien n\'est créé', async () => {
  const client = fakeTwilio();
  await assert.rejects(ensureOutboundApp(client, { env: {} }), /URL publique/);
  assert.deepEqual(calls, []);
});

test('jeton du navigateur : porte l\'application de SON environnement', async () => {
  mongoose.models.VoiceSigningKey.findOne = () => ({ lean: async () => ({ sid: 'SK00000000000000000000000000000000', secret: 'secret' }) });
  const client = fakeTwilio();
  const decode = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
  const recSid = await ensureOutboundApp(client, { env: envOf(RECETTE) });
  const prodSid = await ensureOutboundApp(client, { env: envOf(PROD) });
  const tok = await createVoiceToken({ client, accountSid: 'ACtest', identity: 'cc-u1', outgoingApplicationSid: recSid });
  assert.equal(decode(tok).grants.voice.outgoing.application_sid, recSid);
  assert.notEqual(recSid, prodSid);
});

test('contrôleurs : les deux jetons passent la requête au service (plus d\'URL construite depuis l\'hôte de la requête)', () => {
  const pc = fs.readFileSync(new URL('../controllers/phoneNumberController.js', import.meta.url), 'utf8');
  const vc = fs.readFileSync(new URL('../controllers/voicemailController.js', import.meta.url), 'utf8');
  assert.match(pc, /ensureOutboundApp\(client, \{ req \}\)/);
  assert.match(vc, /ensureCallbackApp\(client, \{ req \}\)/);
  for (const src of [pc, vc]) assert.doesNotMatch(src, /applications\.(create|list)|applications\([^)]*\)\.update/, 'aucune écriture d\'application TwiML hors du service');
});
