// Run: JWT_SECRET=test node src/tests/reach.test.js
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
// Valeurs factices : le contrôleur téléphonie construit ses clients à l'import (aucun appel réseau n'est fait).
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'KEY_test';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'test';
for (const k of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']) delete process.env[k];
const R = await import('../services/reach.js');
const { buildInboundTwiml, buildNoAnswerTwiml, buildMobileDialTwiml } = await import('../services/inboundFlow.js');
const { createReachController } = await import('../controllers/reachController.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');
const { markAvailable, clearPresence } = await import('../services/voicePresenceService.js');
const { default: ReachSettings } = await import('../models/ReachSettings.js');
const { default: InboundCall } = await import('../models/InboundCall.js');
const { default: InboundSettings } = await import('../models/InboundSettings.js');
const { PhoneNumber } = await import('../models/PhoneNumber.js');
const { phoneNumberController: pc } = await import('../controllers/phoneNumberController.js');

// --- numéro E.164
assert.equal(R.normalizeE164('+33 6 12 34 56 78'), '+33612345678');
assert.equal(R.normalizeE164('0033612345678'), '+33612345678');
assert.equal(R.normalizeE164('+1 (415) 555-0100'), '+14155550100');
for (const bad of ['0612345678', '+0123456789', '+33', '12345', 'abc', '', null, undefined, 612345678, '+33612345678901234']) assert.equal(R.normalizeE164(bad), null, String(bad));

// --- validation
const okIn = (b, c) => { const r = R.validateReachInput(b, c); assert.equal(r.ok, true, JSON.stringify(r.errors)); return r.value; };
const badIn = (b, c) => assert.equal(R.validateReachInput(b, c).ok, false, JSON.stringify(b));
assert.deepEqual(okIn({ forwardEnabled: true, mobileNumber: '+33 6 12 34 56 78', mobileRingSeconds: 20 }), { forwardEnabled: true, mobileNumber: '+33612345678', mobileRingSeconds: 20 });
badIn({ forwardEnabled: true }, {}); // activer sans numéro
okIn({ forwardEnabled: true }, { mobileNumber: '+33612345678' });
badIn({ mobileNumber: '0612345678' });
for (const n of [9, 61, 20.5, '20', null]) badIn({ mobileRingSeconds: n });
badIn({ forwardEnabled: 'oui' });
okIn({ mobileNumber: '' }, { forwardEnabled: false });
badIn({ mobileNumber: '' }, { forwardEnabled: true, mobileNumber: '+33612345678' }); // vider le numéro en gardant le renvoi actif

assert.deepEqual(R.toPublicReach(null), { forwardEnabled: false, mobileNumber: '', mobileRingSeconds: 25, mobileVerified: false, updatedAt: null });

// --- décision navigateur / mobile / répondeur
const reachOn = { forwardEnabled: true, mobileNumber: '+33612345678', mobileRingSeconds: 20 };
const LINE = '+33900000001';
assert.equal(R.decideInboundRoute({ identities: ['cc-u1'], reach: null, linePhone: LINE }).first, 'browser');
assert.equal(R.decideInboundRoute({ identities: ['cc-u1'], reach: null, linePhone: LINE }).mobileNext, false);
let d = R.decideInboundRoute({ identities: ['cc-u1'], reach: reachOn, linePhone: LINE });
assert.deepEqual([d.first, d.mobileNext], ['browser', true]);
d = R.decideInboundRoute({ identities: [], reach: reachOn, linePhone: LINE });
assert.deepEqual([d.first, d.mobile], ['mobile', { number: '+33612345678', ringSeconds: 20 }]);
assert.equal(R.decideInboundRoute({ identities: [], reach: null, linePhone: LINE }).first, 'voicemail');
assert.equal(R.decideInboundRoute({ identities: [], reach: { ...reachOn, forwardEnabled: false }, linePhone: LINE }).first, 'voicemail');
assert.equal(R.decideInboundRoute({ identities: [], reach: { forwardEnabled: true, mobileNumber: '' }, linePhone: LINE }).first, 'voicemail', 'renvoi actif sans numéro : répondeur');
assert.equal(R.decideInboundRoute({ identities: [], reach: { ...reachOn, mobileNumber: LINE }, linePhone: LINE }).first, 'voicemail', 'jamais vers la ligne elle-même (boucle)');
assert.equal(R.mobileTarget({ ...reachOn, mobileRingSeconds: 500 }).ringSeconds, 60);
// après la sonnerie du navigateur
const mob = R.mobileTarget(reachOn);
assert.equal(R.shouldRingMobileAfter({ leg: 'browser', dialStatus: 'no-answer', mobile: mob }), true);
assert.equal(R.shouldRingMobileAfter({ leg: 'browser', dialStatus: 'busy', mobile: mob }), true);
assert.equal(R.shouldRingMobileAfter({ leg: 'browser', dialStatus: 'completed', mobile: mob }), false, 'décroché');
assert.equal(R.shouldRingMobileAfter({ leg: 'browser', dialStatus: 'canceled', mobile: mob }), false, 'appelant parti');
assert.equal(R.shouldRingMobileAfter({ leg: 'mobile', dialStatus: 'no-answer', mobile: mob }), false, 'jamais deux fois');
assert.equal(R.shouldRingMobileAfter({ leg: 'browser', dialStatus: 'no-answer', mobile: null }), false);

// --- TwiML (chaînes XML, aucun appel réel)
const base = 'https://orch.test';
const resultUrl = `${base}/api/phone-numbers/webhooks/twilio/inbound-dial-result`;
const common = { baseUrl: base, companyId: '64b0000000000000000000c1', from: '+33611111111', resultUrl, linePhone: LINE };
const mobileDial = `<Dial timeout="20" answerOnBridge="true" action="${resultUrl}?leg=mobile" method="POST" callerId="${LINE}"><Number>+33612345678</Number></Dial>`;
assert.equal(buildMobileDialTwiml({ number: '+33612345678', ringSeconds: 20, callerId: LINE, resultUrl }), mobileDial);
assert.equal(buildInboundTwiml({ ...common, settings: null, identities: [], mobile: mob }), mobileDial, 'aucun navigateur : le mobile sonne, pas de répondeur');
// avec navigateur : inchangé (le mobile suit via le résultat de la sonnerie)
assert.equal(buildInboundTwiml({ ...common, settings: null, identities: ['cc-u1'], mobile: null }), `<Dial timeout="30" answerOnBridge="true" action="${resultUrl}" method="POST" callerId="+33611111111"><Client>cc-u1</Client></Dial>`);
// sans renvoi : répondeur comme avant
assert.ok(buildInboundTwiml({ ...common, settings: null, identities: [], mobile: null }).includes('<Record '));
// navigateur sans réponse -> mobile, puis répondeur
assert.equal(buildNoAnswerTwiml({ baseUrl: base, companyId: common.companyId, dialStatus: 'no-answer', mobile: mob, linePhone: LINE, resultUrl }), mobileDial.replace('timeout="20"', 'timeout="20"'));
assert.ok(buildNoAnswerTwiml({ baseUrl: base, companyId: common.companyId, dialStatus: 'no-answer', mobile: null, linePhone: LINE, resultUrl }).includes('<Record '), 'mobile sans réponse : répondeur');
assert.equal(buildNoAnswerTwiml({ baseUrl: base, companyId: common.companyId, dialStatus: 'completed', mobile: mob, linePhone: LINE, resultUrl }), '<Hangup/>');
assert.equal(buildNoAnswerTwiml({ baseUrl: base, companyId: common.companyId, dialStatus: 'canceled', mobile: mob, linePhone: LINE, resultUrl }), '<Hangup/>');
// injection XML dans le numéro
assert.ok(!buildMobileDialTwiml({ number: '</Number><Hangup/>', callerId: LINE, resultUrl }).includes('</Number><Hangup/>'));

// --- parcours complet du webhook (base simulée, aucun appel réel)
const COMPANY = '64b0000000000000000000c1';
const calls = new Map();
let reachDoc = null;
PhoneNumber.findOne = async (f) => (f.phoneNumber === LINE ? { companyId: COMPANY, gigId: null, phoneNumber: LINE } : null);
ReachSettings.findOne = () => ({ lean: async () => reachDoc });
InboundSettings.findOne = () => ({ select: () => ({ lean: async () => null }) });
InboundCall.updateOne = async (f, u) => { if (u.$setOnInsert && !calls.has(f.callSid)) calls.set(f.callSid, { save: async () => {}, ...u.$setOnInsert }); return {}; };
InboundCall.findOne = async (f) => calls.get(f.callSid) || null;
const hit = (fn, body, query = {}) => new Promise((resolve) => {
  const res = { type() { return this; }, status() { return this; }, send: resolve };
  fn.call(pc, { body, query, get: () => 'orch.test' }, res);
});
const inbound = (sid) => hit(pc.handleTwilioInboundCall, { To: LINE, From: '+33611111111', CallSid: sid });
const dialResult = (sid, status, leg, dur) => hit(pc.handleTwilioInboundDialResult, { CallSid: sid, DialCallStatus: status, DialCallDuration: dur }, leg ? { leg } : {});
const sleep = () => new Promise((r) => setTimeout(r, 5));

clearPresence();
// 1. personne, pas de renvoi : répondeur
let xml = await inbound('CA1');
assert.ok(xml.includes('<Record ') && !xml.includes('<Dial'));
assert.equal(calls.get('CA1').status, 'no_agent');
assert.equal(calls.get('CA1').route, 'voicemail');
// 2. personne, renvoi actif : mobile direct, appel consigné « ringing / mobile »
reachDoc = { forwardEnabled: true, mobileNumber: '+33612345678', mobileRingSeconds: 20 };
xml = await inbound('CA2');
assert.ok(xml.includes('<Number>+33612345678</Number>') && xml.includes(`callerId="${LINE}"`) && !xml.includes('<Client>'));
assert.deepEqual([calls.get('CA2').status, calls.get('CA2').route, calls.get('CA2').mobileTried], ['ringing', 'mobile', true]);
// 2a. le mobile décroche
xml = await dialResult('CA2', 'completed', 'mobile', '42');
assert.ok(xml.includes('<Hangup/>'));
assert.deepEqual([calls.get('CA2').status, calls.get('CA2').answeredOn, calls.get('CA2').talkSeconds], ['answered', 'mobile', 42]);
// 2b. le mobile ne répond pas : répondeur
xml = await inbound('CA3');
xml = await dialResult('CA3', 'no-answer', 'mobile');
assert.ok(xml.includes('<Record ') && !xml.includes('<Dial'));
assert.equal(calls.get('CA3').status, 'missed');
// 3. navigateur présent : il sonne d'abord ; personne ne décroche -> mobile ; puis répondeur
markAvailable({ userId: 'owner1', companyId: COMPANY });
xml = await inbound('CA4');
assert.ok(xml.includes('<Client>cc-owner1</Client>') && !xml.includes('<Number>'));
assert.equal(calls.get('CA4').route, 'browser');
xml = await dialResult('CA4', 'no-answer', null);
assert.ok(xml.includes('<Number>+33612345678</Number>') && xml.includes('leg=mobile'));
assert.deepEqual([calls.get('CA4').status, calls.get('CA4').mobileTried, calls.get('CA4').route], ['ringing', true, 'mobile'], "l'appel n'est pas clos tant que le mobile sonne");
xml = await dialResult('CA4', 'no-answer', 'mobile');
assert.ok(xml.includes('<Record '));
assert.equal(calls.get('CA4').status, 'missed');
// 3b. navigateur décroche : pas de mobile
xml = await inbound('CA5');
xml = await dialResult('CA5', 'completed', null, '30');
assert.ok(xml.includes('<Hangup/>'));
assert.deepEqual([calls.get('CA5').status, calls.get('CA5').answeredOn], ['answered', 'browser']);
// 3c. navigateur présent, renvoi désactivé : répondeur après la sonnerie (comportement d'avant)
reachDoc = { ...reachDoc, forwardEnabled: false };
await inbound('CA6');
xml = await dialResult('CA6', 'no-answer', null);
assert.ok(xml.includes('<Record '));
clearPresence();

// --- droits du contrôleur (base et service d'inscription simulés)
const tok = jwt.sign({ userId: 'owner1' }, process.env.JWT_SECRET);
let me = { isOwner: true, companyId: COMPANY, permissions: {} };
global.fetch = async (url) => {
  if (String(url).includes('/company-members/me')) return { ok: true, json: async () => ({ data: me }) };
  throw new Error(`fetch inattendu ${url}`);
};
let saved = null;
const settingsModel = {
  findOne: () => ({ lean: async () => saved }),
  findOneAndUpdate: (f, u) => ({ lean: async () => { saved = { ...(saved || {}), ...u.$set }; return saved; } }),
};
let webhooks = 0;
const ctl = createReachController({ settingsModel, ensureWebhook: async () => { webhooks += 1; } });
async function call(fn, { user = 'owner1', body = {}, query = {} } = {}) {
  clearCompanyCache();
  return new Promise((resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); return this; } };
    fn({ user: { userId: user }, headers: { authorization: `Bearer ${tok}` }, body, query, get: () => 'orch.test' }, res);
  });
}
let r = await call(ctl.getSettings);
assert.equal(r.code, 200); assert.equal(r.body.data.forwardEnabled, false); assert.equal(r.body.data.mobileVerified, false); assert.equal(r.body.data.pushAvailable, false);
r = await call(ctl.putSettings, { body: { forwardEnabled: true, mobileNumber: '0612345678' } });
assert.equal(r.code, 400); assert.match(r.body.message, /international/);
r = await call(ctl.putSettings, { body: { forwardEnabled: true, mobileNumber: '+33 6 12 34 56 78', mobileRingSeconds: 30 } });
assert.equal(r.code, 200); assert.equal(r.body.data.mobileNumber, '+33612345678'); assert.equal(saved.updatedBy, 'owner1');
await sleep(); assert.equal(webhooks, 1, 'la ligne est branchée au serveur quand le renvoi est activé');
markAvailable({ userId: 'owner1', companyId: COMPANY });
r = await call(ctl.getSettings); assert.equal(r.body.data.browserPresent, true);
clearPresence();
// un autre centre est refusé ; un membre et un agent aussi
r = await call(ctl.getSettings, { query: { companyId: '64b0000000000000000000c2' } }); assert.equal(r.code, 403);
me = { isOwner: false, companyId: COMPANY, permissions: {} };
r = await call(ctl.putSettings, { body: { forwardEnabled: false } }); assert.equal(r.code, 403); assert.match(r.body.message, /titulaire/);
me = { isAgent: true, companyId: COMPANY, permissions: {} };
r = await call(ctl.getSettings); assert.equal(r.code, 403);
me = { isOwner: true, companyId: null, permissions: {} };
r = await call(ctl.getSettings); assert.equal(r.code, 403);

console.log('reach OK');
