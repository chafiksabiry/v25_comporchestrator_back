// Run: node --test src/tests/inboundWebhook.test.js
// Incident du 19/11 : +33423490607, pris dans l'inventaire Twilio par un client de PRODUCTION, gardait la voice_url de la RECETTE
// (même compte Twilio, bases séparées) : ses appels entrants partaient vers la recette.
//  - une seule source pour l'URL d'appel entrant (inboundWebhookUrls), posée à l'achat neuf, à la prise dans l'inventaire et par les
//    4 réécritures (test entrant, présence, réglages d'accueil, renvoi) ;
//  - garde-fou entre environnements ; resynchronisation au démarrage (INBOUND_WEBHOOK_RESYNC=1).
// Twilio et Mongo sont SIMULÉS : aucun appel réel.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.TELNYX_API_KEY ||= 'x';
process.env.TWILIO_ACCOUNT_SID ||= 'ACtest';
process.env.TWILIO_AUTH_TOKEN ||= 'x';
delete process.env.PUBLIC_API_BASE_URL;
delete process.env.RAILWAY_PUBLIC_DOMAIN;
delete process.env.INBOUND_WEBHOOK_RESYNC;

const W = await import('../services/inboundWebhook.js');
const { phoneNumberService } = await import('../services/phoneNumberService.js');
const { phoneNumberController } = await import('../controllers/phoneNumberController.js');
const { PhoneNumber } = await import('../models/PhoneNumber.js');

const PROD = 'v25comporchestratorback-production.up.railway.app';
const RECETTE = 'v25comporchestratorback-recette.up.railway.app';
const PATH = '/api/phone-numbers/webhooks/twilio/inbound-call';
const url = (host) => `https://${host}${PATH}`;
const COMPANY = '64b0000000000000000000a1';
const asEnv = (host) => { if (host) process.env.RAILWAY_PUBLIC_DOMAIN = host; else delete process.env.RAILWAY_PUBLIC_DOMAIN; };

let calls; let owned; let lines;
const names = () => calls.map((c) => c[0]);
const updates = () => calls.filter((c) => c[0] === 'twilio.update');

function twilioNumber(phoneNumber, extra = {}) {
  const n = { sid: `PN${phoneNumber.slice(-6)}`, phoneNumber, friendlyName: phoneNumber, capabilities: { voice: true }, voiceUrl: 'https://demo.twilio.com/welcome/voice/', voiceMethod: 'POST', ...extra };
  owned[n.sid] = n;
  return n;
}
function fakeTwilio() {
  const api = (sid) => ({
    fetch: async () => { calls.push(['twilio.fetch', sid]); if (!owned[sid]) throw Object.assign(new Error('not found'), { status: 404 }); return { ...owned[sid] }; },
    update: async (u) => { calls.push(['twilio.update', sid, u]); Object.assign(owned[sid], u); return { ...owned[sid] }; },
    remove: async () => { calls.push(['twilio.remove', sid]); delete owned[sid]; },
  });
  api.list = async (o = {}) => Object.values(owned).filter((n) => !o.phoneNumber || n.phoneNumber === o.phoneNumber);
  api.create = async (o) => { calls.push(['twilio.create', o]); return twilioNumber(o.phoneNumber, { sid: 'PNnew001', voiceUrl: o.voiceUrl || '', voiceMethod: o.voiceMethod }); };
  return { incomingPhoneNumbers: api };
}
const mockRes = () => ({ statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });

beforeEach(() => {
  calls = []; owned = {}; lines = {};
  asEnv(null);
  delete process.env.PUBLIC_API_BASE_URL;
  delete process.env.INBOUND_WEBHOOK_RESYNC;
  console.log = () => {}; console.warn = () => {};
  phoneNumberService.twilioClient = fakeTwilio();
  // Base de CET environnement : documents PhoneNumber simulés.
  phoneNumberService.unassignedAmong = async (list) => list.filter((n) => !Object.values(lines).some((l) => l.phoneNumber === n.phoneNumber));
  PhoneNumber.prototype.save = async function save() { lines[String(this._id)] = this; return this; };
  // Résultat attendable ET .lean() (takeOverStaleHolder, #162, lit la fiche avec .lean()).
  PhoneNumber.findOne = (q = {}) => { const found = Object.values(lines).find((l) => (!q._id || String(l._id) === String(q._id)) && (!q.phoneNumber || l.phoneNumber === q.phoneNumber)) || null; return Object.assign(Promise.resolve(found), { lean: async () => found }); };
  PhoneNumber.updateOne = async (q, u) => { calls.push(['db.updateOne', String(q._id), u.$set]); const l = lines[String(q._id)]; if (l) for (const [k, v] of Object.entries(u.$set || {})) if (k === 'metadata.inboundWebhook') { l.metadata = { ...(l.metadata || {}), inboundWebhook: v }; } return { modifiedCount: 1 }; };
  PhoneNumber.deleteOne = async (q) => { delete lines[String(q._id)]; return { deletedCount: 1 }; };
  PhoneNumber.find = (q = {}) => {
    calls.push(['db.find', q]);
    const rows = Object.values(lines).filter((l) => (!q.status || l.status === q.status) && (!q.companyId || String(l.companyId) === String(q.companyId))
      && l.twilioId && (!q['metadata.inboundWebhook'] || l.metadata?.inboundWebhook !== q['metadata.inboundWebhook'].$ne));
    const out = Promise.resolve(rows);
    out.select = () => ({ lean: async () => rows.map((r) => ({ _id: r._id, phoneNumber: r.phoneNumber, twilioId: r.twilioId })) });
    return out;
  };
});

const storeLine = (fields) => { const l = new PhoneNumber({ provider: 'twilio', status: 'active', companyId: COMPANY, ...fields }); lines[String(l._id)] = l; return l; };

// ───────────── Source unique de l'URL ─────────────

test('source unique : RAILWAY_PUBLIC_DOMAIN, puis PUBLIC_API_BASE_URL, puis hôte de la requête', () => {
  const req = { get: (h) => (h === 'host' ? 'from-request.example' : '') };
  assert.equal(W.inboundWebhookUrls({ env: {} }), null, 'aucune source : rien');
  assert.deepEqual(W.inboundWebhookUrls({ env: {}, req }), { voiceUrl: url('from-request.example'), voiceMethod: 'POST' });
  assert.equal(W.inboundWebhookUrls({ env: { PUBLIC_API_BASE_URL: `https://${PROD}/api` }, req }).voiceUrl, url(PROD));
  assert.equal(W.inboundWebhookUrls({ env: { RAILWAY_PUBLIC_DOMAIN: RECETTE, PUBLIC_API_BASE_URL: 'https://autre.example/api' }, req }).voiceUrl, url(RECETTE));
  assert.equal(W.originMismatch({ RAILWAY_PUBLIC_DOMAIN: RECETTE, PUBLIC_API_BASE_URL: `https://${PROD}/api` }), `PUBLIC_API_BASE_URL (${PROD}) ≠ RAILWAY_PUBLIC_DOMAIN (${RECETTE})`);
  assert.equal(W.originMismatch({ RAILWAY_PUBLIC_DOMAIN: PROD, PUBLIC_API_BASE_URL: `https://${PROD}/api` }), '');
  assert.equal(W.maskNumber('+33423490607'), '••••••••0607');
});

test('garde-fou : règle exacte', () => {
  const rec = { env: { RAILWAY_PUBLIC_DOMAIN: RECETTE } };
  const prod = { env: { RAILWAY_PUBLIC_DOMAIN: PROD } };
  assert.equal(W.foreignHarxHost(url(RECETTE), prod), RECETTE);
  assert.equal(W.foreignHarxHost(url(PROD), rec), PROD);
  assert.equal(W.foreignHarxHost(url(PROD), prod), '', 'son propre hôte');
  assert.equal(W.foreignHarxHost('https://demo.twilio.com/welcome/voice/', prod), '', 'hôte hors HARX');
  assert.equal(W.foreignHarxHost('', prod), '');
  assert.equal(W.ownedByProduction(url(PROD), rec), true);
  assert.equal(W.ownedByProduction(url(RECETTE), prod), false, 'la production reprend ses numéros mal branchés');
});

// ───────────── Achat neuf et prise dans l'inventaire ─────────────

test('achat neuf : create reçoit voiceUrl de CET environnement, enregistrée dans metadata.inboundWebhook', async () => {
  asEnv(PROD);
  const line = await phoneNumberService.purchaseTwilioNumber('+33199999901', 'https://ignored.example', undefined, COMPANY, {});
  const create = calls.find((c) => c[0] === 'twilio.create');
  assert.equal(create[1].voiceUrl, url(PROD));
  assert.equal(create[1].voiceMethod, 'POST');
  assert.equal(line.metadata.inboundWebhook, url(PROD));
});

test('achat neuf : webhookUrls fourni par le contrôleur (hôte de la requête faute de variable)', async () => {
  const urls = W.inboundWebhookUrls({ req: { get: () => RECETTE } });
  await phoneNumberService.purchaseTwilioNumber('+33199999902', null, undefined, COMPANY, { webhookUrls: urls });
  assert.equal(calls.find((c) => c[0] === 'twilio.create')[1].voiceUrl, url(RECETTE));
});

test('prise dans l\'inventaire : update juste après la prise, ancien réglage gardé pour la remise en stock', async () => {
  asEnv(PROD);
  const n = twilioNumber('+33423490607', { voiceUrl: 'https://demo.twilio.com/welcome/voice/' });
  const line = await phoneNumberService.purchaseTwilioNumber(n.phoneNumber, null, undefined, COMPANY, {});
  assert.ok(!names().includes('twilio.create'), 'pas de rachat');
  assert.deepEqual(updates().map((c) => [c[1], c[2]]), [[n.sid, { voiceUrl: url(PROD), voiceMethod: 'POST' }]]);
  assert.equal(owned[n.sid].voiceUrl, url(PROD));
  assert.equal(line.metadata.inventory.voiceUrl, 'https://demo.twilio.com/welcome/voice/');
  assert.equal(line.metadata.inboundWebhook, url(PROD));
});

test('returnToInventory après une prise : voice_url « stock » rétablie, aucun remove()', async () => {
  asEnv(PROD);
  const n = twilioNumber('+33423490608', { voiceUrl: 'https://stock.example/voice' });
  const line = await phoneNumberService.purchaseTwilioNumber(n.phoneNumber, null, undefined, COMPANY, {});
  assert.equal(owned[n.sid].voiceUrl, url(PROD));
  const out = await phoneNumberService.returnToInventory({ id: line._id, companyId: COMPANY });
  assert.equal(out.returnedToInventory, true);
  assert.equal(owned[n.sid].voiceUrl, 'https://stock.example/voice');
  assert.ok(!names().includes('twilio.remove'));
  assert.deepEqual(Object.keys(lines), []);
});

test('garde-fou (production) : un numéro de l\'inventaire branché sur la RECETTE n\'est ni proposé ni pris', async () => {
  asEnv(PROD);
  const n = twilioNumber('+33162044030', { voiceUrl: url(RECETTE) });
  assert.deepEqual(await phoneNumberService.listClaimableInventory({ countryCode: 'FR' }), []);
  assert.equal((await phoneNumberService.findClaimableInventoryNumber(n.phoneNumber)).claimable, false);
  await assert.rejects(() => phoneNumberService.purchaseTwilioNumber(n.phoneNumber, null, undefined, COMPANY, {}), /n’est pas disponible|Twilio Purchase Failed/);
  assert.ok(!names().includes('twilio.update') && !names().includes('twilio.create'));
  assert.equal(owned[n.sid].voiceUrl, url(RECETTE));
});

test('garde-fou (recette) : un numéro de l\'inventaire branché sur la PRODUCTION n\'est ni proposé ni pris', async () => {
  asEnv(RECETTE);
  const n = twilioNumber('+33162044031', { voiceUrl: url(PROD) });
  const own = twilioNumber('+33162044032', { voiceUrl: url(RECETTE) });
  assert.deepEqual((await phoneNumberService.listClaimableInventory({ countryCode: 'FR' })).map((x) => x.phoneNumber), [own.phoneNumber]);
  await assert.rejects(() => phoneNumberService.purchaseTwilioNumber(n.phoneNumber, null, undefined, COMPANY, {}));
  assert.equal(owned[n.sid].voiceUrl, url(PROD));
});

// ───────────── Réécritures ─────────────

test('startInboundTest en recette sur un numéro branché sur la production : refus 409 clair, rien réécrit', async () => {
  asEnv(RECETTE);
  const n = twilioNumber('+33423490609', { voiceUrl: url(PROD) });
  storeLine({ phoneNumber: n.phoneNumber, twilioId: n.sid });
  const res = mockRes();
  await phoneNumberController.startInboundTest({ body: { phoneNumber: n.phoneNumber, companyId: COMPANY }, get: () => RECETTE }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'NUMBER_OWNED_BY_PRODUCTION');
  assert.match(res.body.message, /production/);
  assert.equal(updates().length, 0);
  assert.equal(owned[n.sid].voiceUrl, url(PROD));
});

test('startInboundTest en production : numéro mal branché sur la recette rebranché sur la production (source unique, pas l\'hôte reçu)', async () => {
  asEnv(PROD);
  const n = twilioNumber('+33423490610', { voiceUrl: url(RECETTE) });
  const line = storeLine({ phoneNumber: n.phoneNumber, twilioId: n.sid });
  const res = mockRes();
  await phoneNumberController.startInboundTest({ body: { phoneNumber: n.phoneNumber, companyId: COMPANY }, get: () => 'proxy-interne:8080' }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(owned[n.sid].voiceUrl, url(PROD));
  assert.equal(lines[String(line._id)].metadata.inboundWebhook, url(PROD));
});

test('voicePresence -> ensureInboundWebhook avec inboundWebhookUrls ; recette ne touche pas un numéro de la production', async () => {
  asEnv(RECETTE);
  const mine = twilioNumber('+33423490611', { voiceUrl: '' });
  const prodLine = twilioNumber('+33423490612', { voiceUrl: url(PROD) });
  storeLine({ phoneNumber: mine.phoneNumber, twilioId: mine.sid });
  storeLine({ phoneNumber: prodLine.phoneNumber, twilioId: prodLine.sid });
  let seen;
  const original = phoneNumberController.ensureInboundWebhook;
  phoneNumberController.ensureInboundWebhook = async function spy(companyId, urls) { seen = urls; return original.call(this, companyId, urls); };
  try {
    const res = mockRes();
    await phoneNumberController.voicePresence({ user: { userId: 'u1' }, body: { companyId: COMPANY, available: true }, get: () => 'autre-hote' }, res);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(seen, { voiceUrl: url(RECETTE), voiceMethod: 'POST' });
  } finally { phoneNumberController.ensureInboundWebhook = original; }
  assert.equal(owned[mine.sid].voiceUrl, url(RECETTE));
  assert.equal(owned[prodLine.sid].voiceUrl, url(PROD), 'jamais rebranché depuis la recette');
});

test('les 4 réécritures passent par inboundWebhookUrls, plus aucune voice_url construite depuis req.get(host)', () => {
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  const ctl = read('../controllers/phoneNumberController.js');
  const settings = read('../controllers/inboundSettingsController.js');
  const reach = read('../routes/reach.js');
  for (const src of [ctl, settings, reach]) assert.ok(!/req\.get\('host'\)\}\/api\/phone-numbers\/webhooks\/twilio\/inbound-call/.test(src));
  assert.match(ctl.slice(ctl.indexOf('async startInboundTest('), ctl.indexOf('async getInboundTestStatus(')), /inboundWebhookUrls\(\{ req \}\)/);
  assert.match(ctl.slice(ctl.indexOf('async voicePresence('), ctl.indexOf('async ensureInboundWebhook(')), /ensureInboundWebhook\(companyId, inboundWebhookUrls\(\{ req \}\)\)/);
  assert.match(settings, /ensureInboundWebhook\(companyId, inboundWebhookUrls\(\{ req \}\)\)/);
  assert.match(reach, /ensureInboundWebhook\(companyId, inboundWebhookUrls\(\{ req \}\)\)/);
});

// ───────────── Resynchronisation au démarrage ─────────────

test('resync : sans INBOUND_WEBHOOK_RESYNC=1, rien (aucune lecture de base ni appel Twilio)', async () => {
  asEnv(PROD);
  const n = twilioNumber('+33423490613', { voiceUrl: url(RECETTE) });
  storeLine({ phoneNumber: n.phoneNumber, twilioId: n.sid });
  for (const v of [undefined, '0', 'true']) {
    const env = { RAILWAY_PUBLIC_DOMAIN: PROD, ...(v ? { INBOUND_WEBHOOK_RESYNC: v } : {}) };
    const out = await W.resyncInboundWebhooks({ env, PhoneNumber, twilioClient: phoneNumberService.twilioClient, log: { log() {}, warn() {} } });
    assert.equal(out.enabled, false);
  }
  assert.deepEqual(calls, []);
});

test('resync (production) : réaligne les lignes de la base, ne touche jamais un numéro absent de la base', async () => {
  const logs = [];
  const log = { log: (m) => logs.push(m), warn: (m) => logs.push(m) };
  const bad = twilioNumber('+33423490607', { voiceUrl: url(RECETTE) });
  const good = twilioNumber('+33423490614', { voiceUrl: url(PROD) });
  const stranger = twilioNumber('+33162044099', { voiceUrl: url(RECETTE) }); // pas dans la base de la production
  const inactive = twilioNumber('+33162044098', { voiceUrl: url(RECETTE) });
  storeLine({ phoneNumber: bad.phoneNumber, twilioId: bad.sid });
  storeLine({ phoneNumber: good.phoneNumber, twilioId: good.sid });
  storeLine({ phoneNumber: inactive.phoneNumber, twilioId: inactive.sid, status: 'released' });
  const out = await W.resyncInboundWebhooks({ env: { RAILWAY_PUBLIC_DOMAIN: PROD, INBOUND_WEBHOOK_RESYNC: '1' }, PhoneNumber, twilioClient: phoneNumberService.twilioClient, log });
  assert.deepEqual({ changed: out.changed, skipped: out.skipped, refused: out.refused, failed: out.failed }, { changed: 1, skipped: 1, refused: 0, failed: 0 });
  assert.equal(owned[bad.sid].voiceUrl, url(PROD));
  assert.equal(owned[stranger.sid].voiceUrl, url(RECETTE), 'absent de la base : intact');
  assert.equal(owned[inactive.sid].voiceUrl, url(RECETTE), 'ligne non active : intacte');
  assert.ok(!calls.some((c) => c[1] === stranger.sid || c[1] === inactive.sid));
  assert.deepEqual(updates().map((c) => c[1]), [bad.sid]);
  const line = logs.find((m) => m.includes('0607'));
  assert.equal(line, `[inbound-resync] ••••••••0607 : ${RECETTE} → ${PROD}`);
  assert.ok(!logs.some((m) => m.includes('+33423490607')), 'numéro masqué');
});

test('resync (recette) : un numéro de sa base branché sur la production est laissé tel quel ; configuration incohérente = annulée', async () => {
  const log = { log() {}, warn() {} };
  const p = twilioNumber('+33423490615', { voiceUrl: url(PROD) });
  const r = twilioNumber('+33423490616', { voiceUrl: '' });
  storeLine({ phoneNumber: p.phoneNumber, twilioId: p.sid });
  storeLine({ phoneNumber: r.phoneNumber, twilioId: r.sid });
  const out = await W.resyncInboundWebhooks({ env: { RAILWAY_PUBLIC_DOMAIN: RECETTE, INBOUND_WEBHOOK_RESYNC: '1' }, PhoneNumber, twilioClient: phoneNumberService.twilioClient, log });
  assert.equal(out.refused, 1);
  assert.equal(out.changed, 1);
  assert.equal(owned[p.sid].voiceUrl, url(PROD));
  assert.equal(owned[r.sid].voiceUrl, url(RECETTE));
  calls = [];
  const aborted = await W.resyncInboundWebhooks({ env: { RAILWAY_PUBLIC_DOMAIN: RECETTE, PUBLIC_API_BASE_URL: `https://${PROD}/api`, INBOUND_WEBHOOK_RESYNC: '1' }, PhoneNumber, twilioClient: phoneNumberService.twilioClient, log });
  assert.equal(aborted.changed, 0);
  assert.deepEqual(calls, [], 'rien lu ni écrit');
});
