// Run: JWT_SECRET=test TELNYX_API_KEY=x node src/tests/callQueues.test.js
// Files d'attente (langues, compétences, menu vocal, stratégies, replis). Base et réseau simulés : aucun appel réel.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import express from 'express';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // faux identifiants : aucun appel réseau
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
// Le paquet web-push n'est pas toujours installé là où les tests tournent : un module vide le remplace (jamais utilisé ici).
try { import.meta.resolve('web-push'); } catch {
  register('data:text/javascript,' + encodeURIComponent("export async function resolve(s,c,n){ if(s==='web-push') return {url:'data:text/javascript,export default {setVapidDetails(){},sendNotification(){}}',shortCircuit:true}; return n(s,c);}"));
}

const L = await import('../services/routingLanguages.js');
const Q = await import('../services/callQueues.js');
const R = await import('../services/queueRouting.js');
const F = await import('../services/inboundFlow.js');
const { default: CallQueue } = await import('../models/CallQueue.js');
const { default: StaffRouting } = await import('../models/StaffRouting.js');
const { default: InboundCall } = await import('../models/InboundCall.js');
const { default: InboundSettings } = await import('../models/InboundSettings.js');
const { default: ReachSettings } = await import('../models/ReachSettings.js');
const { PhoneNumber } = await import('../models/PhoneNumber.js');
const { Subscription } = await import('../models/Subscription.js');
const { secretariatToolsRoutes } = await import('../routes/secretariatTools.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');
const { markAvailable, clearPresence } = await import('../services/voicePresenceService.js');
const { phoneNumberController: pc } = await import('../controllers/phoneNumberController.js');

const C1 = '64b0000000000000000000c1';
const C2 = '64b0000000000000000000c2';
const LINE = '+33900000001';
const CALLER = '+33612345678';
const BASE = 'https://orch.test';
const WEBHOOK = `${BASE}/api/phone-numbers/webhooks/twilio`;
const RESULT = `${WEBHOOK}/inbound-dial-result`;

// ---------------------------------------------------------------- langues : liste fermée
assert.equal(L.ROUTING_LANGUAGES.length, 20, 'une vingtaine de langues');
for (const l of L.ROUTING_LANGUAGES) {
  assert.match(l.code, /^[a-z]{2}$/); assert.ok(l.nameFr && l.nameNative && l.nameEn, l.code);
}
assert.equal(new Set(L.ROUTING_LANGUAGE_CODES).size, 20);
for (const code of ['fr', 'en', 'ar', 'es']) assert.ok(L.isRoutingLanguage(code), code);
assert.equal(L.normalizeLanguageCode(' AR '), 'ar');
for (const bad of ['xx', 'fra', 'fr-FR', '', 42, null, undefined]) assert.equal(L.normalizeLanguageCode(bad), null, String(bad));
assert.equal(L.languageInfo('ar').nameFr, 'arabe'); assert.equal(L.languageInfo('ar').nameNative, 'العربية');
assert.deepEqual(L.menuVoice('fr'), { voice: 'Polly.Lea-Generative', language: 'fr-FR' });
assert.deepEqual(L.menuVoice('en'), { voice: 'Polly.Joanna-Generative', language: 'en-US' });
assert.deepEqual(L.menuVoice('ar'), { voice: 'Polly.Zeina', language: 'arb' });
for (const [c, v] of [['es', 'Polly.Lucia-Generative'], ['de', 'Polly.Vicki-Generative'], ['it', 'Polly.Bianca-Generative'], ['pt', 'Polly.Ines-Neural'], ['nl', 'Polly.Lotte']]) assert.equal(L.menuVoice(c).voice, v, c);
assert.deepEqual(L.menuVoice('he'), L.menuVoice('en'), 'langue sans voix : repli sur l\'anglais');
assert.deepEqual(L.menuVoice('zz'), L.menuVoice('en'));
assert.equal(L.defaultMenuPhrase('fr', '1'), 'Pour le français, tapez 1.');
assert.equal(L.defaultMenuPhrase('en', '2'), 'For English, press 2.');
assert.equal(L.defaultMenuPhrase('he', '3'), 'For Hebrew, press 3.', 'langue sans voix : phrase anglaise');
for (const l of L.ROUTING_LANGUAGES) assert.ok(L.defaultMenuPhrase(l.code, '4').includes('4'), l.code);

// ---------------------------------------------------------------- normalisation / validation (pur)
assert.deepEqual(Q.normalizeLanguages([' FR ', 'en', 'fr']), { value: ['fr', 'en'] });
assert.match(Q.normalizeLanguages(['fr', 'xx']).error, /Langue inconnue/);
assert.match(Q.normalizeLanguages('fr').error, /liste/);
assert.deepEqual(Q.normalizeSkills(['  Facturation ', 'FACTURATION', 'support  technique', '  ']), { value: ['facturation', 'support technique'] });
assert.match(Q.normalizeSkills(['x'.repeat(25)]).error, /24/);
assert.equal(Q.normalizeSkills(['x'.repeat(24)]).value.length, 1);
assert.match(Q.normalizeSkills(Array.from({ length: 13 }, (_, i) => `s${i}`)).error, /12/);
assert.equal(Q.normalizeSkills(Array.from({ length: 12 }, (_, i) => `s${i}`)).value.length, 12);
assert.match(Q.normalizeSkills([5]).error, /texte/);
assert.match(Q.normalizeSkills(['a\u0000b']).error, /non autorisés/);

const okQ = (raw) => { const r = Q.validateQueue(raw); assert.equal(r.error, undefined, JSON.stringify([raw, r])); return r.value; };
const koQ = (raw, re) => { const r = Q.validateQueue(raw); assert.match(r.error || '', re, JSON.stringify(raw)); };
assert.deepEqual(okQ({ name: '  Accueil   FR ' }), { id: null, name: 'Accueil FR', direction: 'inbound', strategy: 'simultaneous', languages: [], skills: [], isDefault: false, menuKey: null, prompt: '', promptLanguage: '' });
assert.equal(okQ({ name: 'A', menuKey: 3 }).menuKey, '3', 'une touche numérique est acceptée');
assert.equal(okQ({ name: 'A', menuKey: '' }).menuKey, null);
koQ({}, /nom est obligatoire/); koQ({ name: '   ' }, /nom est obligatoire/); koQ({ name: 'x'.repeat(61) }, /60/); koQ(null, /invalides/);
assert.equal(okQ({ name: 'x'.repeat(60) }).name.length, 60);
koQ({ name: 'A', direction: 'both' }, /sens/); koQ({ name: 'A', strategy: 'random' }, /répartition/);
koQ({ name: 'A', languages: ['klingon'] }, /Langue inconnue/); koQ({ name: 'A', menuKey: '0' }, /1 à 9/); koQ({ name: 'A', menuKey: '10' }, /1 à 9/);
koQ({ name: 'A', prompt: 'x'.repeat(161) }, /160/); assert.equal(okQ({ name: 'A', prompt: 'x'.repeat(160) }).prompt.length, 160);
koQ({ name: 'A', promptLanguage: 'zz' }, /langue du texte/); koQ({ name: 'A', isDefault: 'oui' }, /vrai ou faux/);
koQ({ name: 'S', direction: 'outbound', menuKey: '1' }, /sortante/); koQ({ name: 'S', direction: 'outbound', isDefault: true }, /sortante/);

const setOk = (list) => { const r = Q.validateQueueSet(list); assert.equal(r.error, undefined, JSON.stringify(r)); return r.queues; };
const setKo = (list, re) => { const r = Q.validateQueueSet(list); assert.match(r.error || '', re, JSON.stringify(list)); };
setOk([]);
setOk([{ name: 'A', menuKey: '1', isDefault: true }, { name: 'B', menuKey: '2' }, { name: 'S', direction: 'outbound' }]);
setKo('x', /invalide/);
setKo([{ name: 'A', menuKey: '1' }, { name: 'B', menuKey: '1' }], /touche 1/);
setKo([{ name: 'A', isDefault: true }, { name: 'B', isDefault: true }], /Une seule file entrante/);
setKo(Array.from({ length: 10 }, (_, i) => ({ name: `F${i}`, menuKey: String((i % 9) + 1) })), /Au plus 9 files entrantes/);
setOk(Array.from({ length: 9 }, (_, i) => ({ name: `F${i}`, menuKey: String(i + 1) })));
setOk([{ name: 'A', menuKey: '1' }, { name: 'S', direction: 'outbound' }, { name: 'S2', direction: 'outbound' }]); // sortantes : pas de touche, pas de plafond de 9
setKo([{ name: 'A', id: C1.replace('c1', 'd1') }, { name: 'B', id: C1.replace('c1', 'd1') }], /deux fois/);

// ---------------------------------------------------------------- éligibilité et stratégies (pur)
const profiles = new Map([
  ['cc-alice', { languages: ['fr'], skills: [] }],
  ['cc-bob', { languages: ['en'], skills: [] }],
  ['cc-chloe', { languages: ['fr', 'en'], skills: ['facturation'] }],
  ['cc-dina', { languages: ['ar', 'fr'], skills: ['litiges'] }],
]);
const online4 = ['cc-alice', 'cc-bob', 'cc-chloe', 'cc-dina', 'cc-ghost'];
const q = (over) => ({ _id: 'q1', name: 'F', direction: 'inbound', strategy: 'simultaneous', languages: [], skills: [], ...over });
assert.deepEqual(Q.eligibleIdentities(q({}), online4, profiles), online4, 'file sans langue ni compétence : tout le monde, même sans profil');
assert.deepEqual(Q.eligibleIdentities(q({ languages: ['fr'] }), online4, profiles), ['cc-alice', 'cc-chloe', 'cc-dina'], 'sans profil : non éligible');
assert.deepEqual(Q.eligibleIdentities(q({ languages: ['fr', 'en'] }), online4, profiles), ['cc-chloe'], 'TOUTES les langues');
assert.deepEqual(Q.eligibleIdentities(q({ languages: ['fr'], skills: ['facturation'] }), online4, profiles), ['cc-chloe'], 'langues ET compétences');
assert.deepEqual(Q.eligibleIdentities(q({ skills: ['facturation', 'litiges'] }), online4, profiles), [], 'TOUTES les compétences');
assert.deepEqual(Q.eligibleIdentities(q({ languages: ['ar'] }), ['cc-alice'], profiles), []);
assert.equal(Q.covers(undefined, q({ languages: ['fr'] })), false); assert.equal(Q.covers(undefined, q({})), true);

const ids3 = ['cc-c', 'cc-a', 'cc-b'];
assert.deepEqual(Q.attemptsFor(q({}), ids3, { ringSeconds: 40 }), [{ ids: ids3, t: 40, seq: false }], 'simultanée : un seul groupe');
assert.deepEqual(Q.attemptsFor(q({}), [], {}), []);
const idle = Q.attemptsFor(q({ strategy: 'longest_idle' }), ids3, { lastEnd: new Map([['cc-a', 3000], ['cc-b', 1000]]) });
assert.deepEqual(idle.map((a) => a.ids[0]), ['cc-c', 'cc-b', 'cc-a'], 'jamais vu d\'abord, puis la plus anciennement libre');
assert.ok(idle.every((a) => a.t === 15 && a.seq));
assert.deepEqual(Q.attemptsFor(q({ strategy: 'longest_idle' }), ['cc-y', 'cc-x'], {}).map((a) => a.ids[0]), ['cc-x', 'cc-y'], 'sans information : ordre stable');
const rr = (cursor) => Q.attemptsFor(q({ strategy: 'round_robin' }), ids3, { cursor }).map((a) => a.ids[0]);
assert.deepEqual(rr(0), ['cc-a', 'cc-b', 'cc-c']); assert.deepEqual(rr(1), ['cc-b', 'cc-c', 'cc-a']); assert.deepEqual(rr(5), ['cc-c', 'cc-a', 'cc-b']); assert.deepEqual(rr(3), rr(0));

const defQ = q({ _id: 'qd', name: 'Défaut', isDefault: true, languages: ['fr'] });
const arQ = q({ _id: 'qa', name: 'Arabe', languages: ['ar'] });
assert.deepEqual(Q.buildPlan({ queue: arQ, defaultQueue: defQ, online: ['cc-alice', 'cc-dina'], profiles }).map((a) => a.ids), [['cc-dina', 'cc-alice'].filter((x) => x === 'cc-dina')].concat([['cc-alice']]), 'file puis éligibles de la file par défaut non encore appelés');
assert.deepEqual(Q.buildPlan({ queue: arQ, defaultQueue: defQ, online: ['cc-alice'], profiles }).map((a) => a.ids), [['cc-alice']], 'personne sur la file : la file par défaut');
assert.deepEqual(Q.buildPlan({ queue: arQ, defaultQueue: defQ, online: ['cc-bob'], profiles }), [], 'personne nulle part : plan vide (mobile puis répondeur)');
assert.deepEqual(Q.buildPlan({ queue: defQ, defaultQueue: defQ, online: ['cc-alice'], profiles }).length, 1, 'la file par défaut ne se rappelle pas elle-même');
const many = Array.from({ length: 8 }, (_, i) => `cc-u${i}`);
assert.equal(Q.buildPlan({ queue: q({ strategy: 'longest_idle' }), online: many, profiles: new Map() }).length, Q.MAX_ATTEMPTS, 'plafond de 5 tentatives');

// ---------------------------------------------------------------- menu vocal : TwiML
const mq = (key, over) => ({ _id: `m${key}`, name: `File ${key}`, direction: 'inbound', menuKey: String(key), languages: [], skills: [], prompt: '', promptLanguage: '', ...over });
const menu = R.buildMenuBody({ queues: [mq(2, { languages: ['en'] }), mq(1, { languages: ['fr'] }), mq(3, { languages: ['ar'], prompt: 'للعربية اضغط ثلاثة' }), mq(4, { languages: ['he'] }), mq(5, { name: 'Compta', prompt: 'Pour la comptabilité, tapez 5.', promptLanguage: 'fr', languages: ['en'] }), mq(6, { name: 'Ventes' })], baseUrl: BASE, attempt: 1 });
assert.ok(menu.startsWith(`<Gather numDigits="1" timeout="6" action="${WEBHOOK}/inbound-menu?a=1" method="POST">`));
assert.ok(menu.endsWith(`</Gather><Redirect method="POST">${WEBHOOK}/inbound-menu?a=1</Redirect>`), 'sans touche : rappel du même webhook');
const says = [...menu.matchAll(/<Say language="([^"]+)" voice="([^"]+)">([^<]*)<\/Say>/g)].map((m) => m.slice(1));
assert.deepEqual(says, [
  ['fr-FR', 'Polly.Lea-Generative', 'Pour le français, tapez 1.'],
  ['en-US', 'Polly.Joanna-Generative', 'For English, press 2.'],
  ['arb', 'Polly.Zeina', 'للعربية اضغط ثلاثة'],
  ['en-US', 'Polly.Joanna-Generative', 'For Hebrew, press 4.'],
  ['fr-FR', 'Polly.Lea-Generative', 'Pour la comptabilité, tapez 5.'],
  ['fr-FR', 'Polly.Lea-Generative', 'Pour Ventes, tapez 6.'],
], 'ordre par touche, phrase dans SA langue, texte personnalisé prioritaire, repli anglais, file sans langue : français');
assert.ok(R.buildMenuBody({ queues: [mq(1), mq(2)], baseUrl: BASE, attempt: 2 }).includes('inbound-menu?a=2'));
assert.ok(R.buildMenuBody({ queues: [mq(1, { name: 'A & <B>' })], baseUrl: BASE }).includes('Pour A &amp; &lt;B&gt;, tapez 1.'), 'échappement XML');
assert.equal(R.menuLine(mq(1, { languages: ['en', 'fr'] })).text, 'For English, press 1.', 'première langue de la file');
assert.equal(R.menuLine(mq(1, { languages: ['en'], promptLanguage: 'es' })).text, 'Para español, pulse 1.', 'langue du texte explicite');

// choix de la file par touche (pur)
const inb = Q.inboundQueues([mq(2, { createdAt: 2 }), mq(1, { createdAt: 1, isDefault: true }), { ...mq(9), direction: 'outbound' }]);
assert.equal(inb.length, 2); assert.equal(Q.chooseMenuQueue(inb, '2')._id, 'm2'); assert.equal(Q.chooseMenuQueue(inb, '7'), null); assert.equal(Q.chooseMenuQueue(inb, ''), null); assert.equal(Q.chooseMenuQueue(inb, '*'), null);
assert.equal(Q.defaultQueueOf(inb)._id, 'm1'); assert.equal(Q.defaultQueueOf([mq(3, { createdAt: 1 }), mq(4, { createdAt: 2 })])._id, 'm3', 'sans défaut : la première');
assert.equal(Q.needsMenu(inb), true); assert.equal(Q.needsMenu([mq(1)]), false); assert.equal(Q.needsMenu([mq(1), { ...mq(2), menuKey: null }]), false);

// ---------------------------------------------------------------- plan signé
const plan2 = [{ ids: ['cc-a'], t: 15, seq: true }, { ids: ['cc-b'], t: 15, seq: true }];
const tok = R.signPlan(plan2, 1, C1);
assert.deepEqual(R.readPlan(tok), { plan: plan2, next: 1, companyId: C1 });
assert.throws(() => R.readPlan(`${tok}x`)); assert.throws(() => R.readPlan('')); assert.throws(() => R.readPlan(undefined));
assert.throws(() => R.readPlan(jwt.sign({ p: plan2, n: 1 }, process.env.JWT_SECRET)), 'un jeton sans la bonne audience est refusé (ex. une session)');
assert.throws(() => R.readPlan(jwt.sign({ p: [{ i: ['evil'], t: 15 }], n: 1, c: C1 }, process.env.JWT_SECRET, { audience: 'inbound-queue-plan' })), 'forme invalide même signée');
assert.throws(() => R.readPlan(jwt.sign({ p: plan2.map((a) => ({ i: a.ids, t: 15 })), n: 1, c: C1 }, 'autre-secret', { audience: 'inbound-queue-plan' })), 'mauvaise signature');

// ---------------------------------------------------------------- faux modèles
const clone = (v) => JSON.parse(JSON.stringify(v));
const lean = (v) => ({ lean: async () => v, select() { return this; }, sort() { return this; }, limit() { return this; }, then(r, j) { return Promise.resolve(v).then(r, j); } });
const matches = (d, f) => Object.entries(f).every(([k, v]) => (v && typeof v === 'object' && v.$in ? v.$in.map(String).includes(String(d[k])) : String(d[k]) === String(v)));
let seq = 0; const nextId = () => (0xb0000 + ++seq).toString(16).padStart(24, '0');
let queueStore = []; let staffStore = [];
let failQueueFind = false;
CallQueue.find = (f) => { if (failQueueFind) throw new Error('base indisponible (simulé)'); return lean(clone(queueStore.filter((d) => matches(d, f)))); };
CallQueue.create = async (doc) => { const d = { _id: nextId(), createdAt: new Date(Date.now() + seq), rrCursor: 0, ...clone(doc) }; queueStore.push(d); return { toObject: () => clone(d) }; };
CallQueue.findOneAndUpdate = (f, upd, opts = {}) => {
  const d = queueStore.find((x) => matches(x, f)); if (!d) return lean(null);
  const before = clone(d);
  Object.assign(d, clone(upd.$set || {}));
  for (const [k, n] of Object.entries(upd.$inc || {})) d[k] = (d[k] || 0) + n;
  return lean(opts.new === false ? before : clone(d));
};
CallQueue.deleteOne = async (f) => { const i = queueStore.findIndex((x) => matches(x, f)); if (i >= 0) queueStore.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; };
CallQueue.bulkWrite = async (ops) => {
  for (const op of ops) {
    if (op.deleteMany) queueStore = queueStore.filter((d) => !matches(d, op.deleteMany.filter));
    else if (op.updateOne) Object.assign(queueStore.find((d) => matches(d, op.updateOne.filter)), clone(op.updateOne.update.$set));
    else if (op.insertOne) queueStore.push({ createdAt: new Date(Date.now() + ++seq), ...clone(op.insertOne.document) });
  }
};
StaffRouting.find = (f) => lean(clone(staffStore.filter((d) => matches(d, f))));
StaffRouting.findOneAndUpdate = (f, upd, opts) => {
  let d = staffStore.find((x) => matches(x, f));
  if (!d) { assert.ok(opts.upsert); d = { _id: nextId(), companyId: String(f.companyId), userId: f.userId }; staffStore.push(d); }
  Object.assign(d, clone(upd.$set));
  return lean(clone(d));
};
let calls = [];
InboundCall.find = (f) => lean(clone(calls.filter((c) => matches(c, { companyId: f.companyId, status: f.status, answeredBy: f.answeredBy }))).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)));
InboundCall.updateOne = async (f, upd) => {
  let c = calls.find((x) => x.callSid === f.callSid);
  if (!c && upd.$setOnInsert) { c = { ...clone(upd.$setOnInsert), updatedAt: new Date().toISOString() }; calls.push(c); } else if (c && upd.$set) Object.assign(c, clone(upd.$set));
  return { acknowledged: true };
};
InboundCall.findOne = async () => null;
let settingsDoc = null; let reachDoc = null; let soloPlan = false;
InboundSettings.findOne = () => lean(settingsDoc);
ReachSettings.findOne = () => lean(reachDoc);
PhoneNumber.findOne = async (f) => (f.phoneNumber === LINE ? { companyId: C1, phoneNumber: LINE, gigId: null } : null);
Subscription.findOne = () => ({ populate: async () => (soloPlan ? { planId: { name: 'Nomad Solo', metadata: { harx_product: 'callcenter', callcenter_tier: 'nomad_solo' } } } : null) });

const seed = (list) => {
  queueStore = list.map((d, i) => ({ _id: nextId(), companyId: C1, direction: 'inbound', strategy: 'simultaneous', languages: [], skills: [], isDefault: false, menuKey: null, prompt: '', promptLanguage: '', rrCursor: 0, createdAt: new Date(1700000000000 + i * 1000), ...d }));
  return queueStore;
};
const staff = (userId, languages = [], skills = []) => staffStore.push({ _id: nextId(), companyId: C1, userId, languages, skills });
const present = (...users) => { clearPresence(); for (const u of users) markAvailable({ userId: u, companyId: C1 }); };

// ---------------------------------------------------------------- appel de bout en bout (contrôleur, modèles simulés)
const logged = [];
const realLog = console.log.bind(console);
for (const k of ['log', 'error', 'warn']) { const orig = console[k]; console[k] = (...a) => { logged.push(`${k}: ${a.join(' ')}`); if (process.env.VERBOSE) orig(...a); }; }
const wrap = (b) => `<?xml version="1.0" encoding="UTF-8"?><Response>${b}</Response>`;
const call = async (method, { body = {}, query = {} } = {}) => {
  let out = null;
  const res = { type() { return this; }, status() { return this; }, send(x) { out = x; return this; } };
  await pc[method]({ body, query, get: () => 'orch.test' }, res);
  return out;
};
const inbound = (extra = {}) => call('handleTwilioInboundCall', { body: { To: LINE, From: CALLER, CallSid: `CA${Math.random().toString(16).slice(2)}`, ...extra } });
const dialOf = (ids, action = RESULT, t = 30) => `<Dial timeout="${t}" answerOnBridge="true" action="${action}" method="POST" callerId="${CALLER}">${ids.map((i) => `<Client>${i}</Client>`).join('')}</Dial>`;
const nextActionOf = (twiml) => { const m = /action="([^"]*inbound-queue-next\?s=[^"]+)"/.exec(twiml); return m ? m[1].replace(/&amp;/g, '&') : null; };
const tokenOf = (url) => new URL(url).searchParams.get('s');
const clientsOf = (twiml) => [...twiml.matchAll(/<Client>([^<]+)<\/Client>/g)].map((m) => m[1]);
const next = (url, status) => call('handleTwilioInboundQueueNext', { body: { DialCallStatus: status, From: CALLER, CallSid: 'CAnext' }, query: { s: tokenOf(url) } });
const menuPost = (digits, a = 1) => call('handleTwilioInboundMenu', { body: { To: LINE, From: CALLER, CallSid: 'CAmenu', ...(digits !== undefined ? { Digits: digits } : {}) }, query: { a: String(a) } });

// ABSENCE DE RÉGRESSION : aucune file -> TwiML strictement identique à l'existant
queueStore = []; staffStore = []; calls = [];
present('alice', 'bob');
assert.equal(await inbound(), wrap(dialOf(['cc-alice', 'cc-bob'])), 'sans file : toutes les identités présentes, timeout 30, action standard');
settingsDoc = { ringTimeoutSeconds: 45, greetingText: 'Bonjour', voice: 'nova' }; present('alice');
const legacyWithSettings = F.buildInboundTwiml({ settings: settingsDoc, baseUrl: BASE, companyId: C1, identities: ['cc-alice'], from: CALLER, resultUrl: RESULT, linePhone: LINE });
assert.equal(await inbound(), wrap(legacyWithSettings), 'sans file, avec accueil et délai paramétrés');
assert.ok(legacyWithSettings.startsWith('<Say language="fr-FR" voice="Polly.Lea-Generative">Bonjour</Say><Dial timeout="45"'));
present();
assert.equal(await inbound(), wrap(F.buildInboundTwiml({ settings: settingsDoc, baseUrl: BASE, companyId: C1, identities: [], from: CALLER, resultUrl: RESULT, linePhone: LINE })), 'sans file ni conseiller : répondeur');
reachDoc = { forwardEnabled: true, mobileNumber: '+33611223344', mobileRingSeconds: 25 };
assert.ok((await inbound()).includes('<Number>+33611223344</Number>'), 'sans file ni conseiller : mobile');
reachDoc = null; settingsDoc = null;
// file(s) seulement sortantes : comme sans file
seed([{ name: 'Sortante', direction: 'outbound' }]); present('alice', 'bob');
assert.equal(await inbound(), wrap(dialOf(['cc-alice', 'cc-bob'])), 'files sortantes seulement : aucun effet de routage');
// Nomad Solo : les files sont ignorées
seed([{ name: 'FR', languages: ['fr'], menuKey: '1' }, { name: 'EN', languages: ['en'], menuKey: '2' }]); soloPlan = true;
assert.equal(await inbound(), wrap(dialOf(['cc-alice', 'cc-bob'])), 'Nomad Solo : files ignorées, comportement inchangé');
present();
assert.ok((await inbound()).includes(F.SOLO_VOICEMAIL_PROMPT.replace("'", '&apos;')), 'Nomad Solo : répondeur à la première personne inchangé');
soloPlan = false; present('alice', 'bob');
// exception interne -> TwiML existant
failQueueFind = true;
assert.equal(await inbound(), wrap(dialOf(['cc-alice', 'cc-bob'])), 'erreur dans la logique de file : repli sur la sonnerie existante');
assert.ok(logged.some((l) => l.includes("Files d'attente : repli sur le comportement actuel")));
assert.equal(await menuPost('1'), wrap(dialOf(['cc-alice', 'cc-bob'])), 'erreur au retour du menu : sonnerie existante, sans accueil');
failQueueFind = false;
const savedSecret = process.env.JWT_SECRET;
seed([{ name: 'Seq', strategy: 'longest_idle' }]); present('alice', 'bob');
delete process.env.JWT_SECRET; // la signature du plan échoue -> repli
assert.equal(await inbound(), wrap(dialOf(['cc-alice', 'cc-bob'])), 'plan impossible à signer : repli sur la sonnerie existante');
process.env.JWT_SECRET = savedSecret;

// une seule file : pas de menu, appels dirigés vers elle (éligibles seulement)
staffStore = []; staff('alice', ['fr']); staff('bob', ['en']); staff('chloe', ['fr', 'en'], ['facturation']); staff('dina', ['ar', 'fr'], ['litiges']);
seed([{ name: 'Français', languages: ['fr'] }]); present('alice', 'bob', 'chloe');
let t = await inbound();
assert.equal(t, wrap(dialOf(['cc-alice', 'cc-chloe'])), 'une file simultanée : mêmes formes que l\'existant, seulement les éligibles');
assert.ok(!t.includes('<Gather'), 'une seule file : pas de menu');
seed([{ name: 'Tous' }]); assert.equal(await inbound(), wrap(dialOf(['cc-alice', 'cc-bob', 'cc-chloe'])), 'une file sans langue ni compétence : tout le monde, TwiML identique à l\'existant');
seed([{ name: 'Arabe', languages: ['ar'] }]); present('alice');
t = await inbound();
assert.ok(clientsOf(t).includes('cc-alice'), 'personne d\'éligible mais un conseiller présent : il sonne quand même (le bouton « prendre les appels » est activé)');
// Journal : un appel qui va au répondeur sans sonnerie est inscrit même si l'appelant ne laisse pas de message.
process.env.DASH_CALLS_API_URL = 'https://dash-calls.test';
const fetchBeforeJournal = globalThis.fetch; const journaled = [];
globalThis.fetch = async (url, init) => { journaled.push({ url: String(url), body: JSON.parse(init.body) }); return { ok: true }; };
present(); t = await inbound();
assert.ok(!t.includes('<Client>') && t.includes('<Record'), 'personne de présent : répondeur');
await new Promise((r) => setTimeout(r, 20));
assert.equal(journaled.length, 1, 'appel au répondeur sans sonnerie : une ligne au journal');
assert.ok(journaled[0].url.endsWith('/api/calls/center-call') && journaled[0].body.unanswered === true && journaled[0].body.outcome === 'voicemail' && journaled[0].body.direction === 'inbound', 'ligne « non décroché / répondeur » du journal');
present('alice'); journaled.length = 0; await inbound(); await new Promise((r) => setTimeout(r, 20));
assert.equal(journaled.length, 0, 'une sonnerie en cours n\'est pas inscrite comme manquée (le résultat de la sonnerie le fera)');
globalThis.fetch = fetchBeforeJournal; present();
reachDoc = { forwardEnabled: true, mobileNumber: '+33611223344', mobileRingSeconds: 25 };
t = await inbound(); assert.ok(t.includes('<Number>+33611223344</Number>') && !t.includes('<Client>'), 'personne de présent : mobile du titulaire'); reachDoc = null;

// plusieurs files avec touche : accueil + menu vocal
seed([
  { name: 'Français', languages: ['fr'], menuKey: '1', isDefault: true },
  { name: 'English', languages: ['en'], menuKey: '2' },
  { name: 'Arabe', languages: ['ar'], menuKey: '3' },
]);
present('alice', 'bob', 'chloe');
settingsDoc = { greetingText: 'Bienvenue', voice: 'nova' };
t = await inbound();
assert.ok(t.startsWith(wrap('').replace('</Response>', '') + '<Say language="fr-FR" voice="Polly.Lea-Generative">Bienvenue</Say><Gather numDigits="1" timeout="6" action="https://orch.test/api/phone-numbers/webhooks/twilio/inbound-menu?a=1" method="POST">'), 'accueil puis menu');
assert.ok(t.includes('Pour le français, tapez 1.') && t.includes('For English, press 2.') && t.includes('arb'));
assert.ok(!t.includes('<Client>'), 'le menu précède toute sonnerie');
settingsDoc = null;
// touche choisie : sonnerie de la file, sans accueil
t = await menuPost('2');
assert.equal(clientsOf(t).join(), 'cc-bob,cc-chloe', 'touche 2 : file anglaise (sonnerie simultanée)');
assert.ok(!t.includes('<Gather') && t.includes('timeout="30"'));
t = await next(nextActionOf(t), 'no-answer');
assert.equal(clientsOf(t).join(), 'cc-alice', 'personne ne répond sur la file anglaise : les éligibles de la file par défaut non encore appelés');
assert.equal(await menuPost('1'), wrap(dialOf(['cc-alice', 'cc-chloe'])), 'touche 1 : file française');
// touche inconnue / aucune touche : on rejoue une fois, puis la file par défaut
t = await menuPost('7', 1); assert.ok(t.includes('inbound-menu?a=2') && t.includes('<Gather'), 'touche inconnue : menu rejoué');
t = await menuPost(undefined, 1); assert.ok(t.includes('inbound-menu?a=2') && t.includes('<Gather'), 'aucune touche : menu rejoué');
assert.equal(await menuPost('7', 2), wrap(dialOf(['cc-alice', 'cc-chloe'])), 'touche inconnue au 2e passage : file par défaut');
assert.equal(await menuPost(undefined, 2), wrap(dialOf(['cc-alice', 'cc-chloe'])), 'aucune touche au 2e passage : file par défaut');
// sans file par défaut : la première
queueStore.forEach((d) => { d.isDefault = false; });
assert.equal(await menuPost('#', 2), wrap(dialOf(['cc-alice', 'cc-chloe'])), 'sans file par défaut : la première file');
queueStore[0].isDefault = true;
// repli : la file choisie n'a personne -> la file par défaut ; sinon mobile ; sinon répondeur
present('alice', 'bob', 'chloe');
t = await menuPost('3');
assert.equal(t, wrap(dialOf(['cc-alice', 'cc-chloe'])), 'file arabe sans éligible : file par défaut (action standard : le mobile puis le répondeur suivent)');
present('dina');
t = await menuPost('3'); assert.equal(clientsOf(t).join(), 'cc-dina', 'éligible arabe : sonne');
assert.ok(nextActionOf(t) !== null || t.includes(RESULT));
present('bob');
t = await menuPost('3'); assert.equal(clientsOf(t).join(), 'cc-bob', 'ni arabe ni défaut mais un conseiller présent : il sonne quand même (au lieu du répondeur)');
present();
t = await menuPost('3'); assert.ok(t.includes('<Record'), 'personne de présent : répondeur');
reachDoc = { forwardEnabled: true, mobileNumber: '+33611223344', mobileRingSeconds: 25 };
t = await menuPost('3'); assert.ok(t.includes('<Number>+33611223344</Number>'), 'personne de présent : mobile du titulaire'); reachDoc = null;
// après la file arabe qui ne répond pas, la file par défaut sonne ensuite (plan signé), puis retour au traitement standard
present('dina', 'alice');
t = await menuPost('3'); let url = nextActionOf(t);
assert.equal(clientsOf(t).join(), 'cc-dina'); assert.ok(url, 'plusieurs tentatives : suite via inbound-queue-next');
t = await next(url, 'no-answer'); assert.equal(clientsOf(t).join(), 'cc-alice', 'repli sur la file par défaut quand personne ne répond');
t = await next(nextActionOf(t), 'no-answer'); assert.ok(t.includes('<Record'), 'plan épuisé : traitement standard (répondeur)');

// stratégie séquentielle « longest_idle »
seed([{ name: 'Tour', strategy: 'longest_idle', languages: ['fr'] }]); present('alice', 'chloe', 'dina');
calls = [
  { callSid: 'old1', companyId: C1, status: 'answered', answeredBy: 'cc-alice', updatedAt: '2026-01-01T10:00:00.000Z' },
  { callSid: 'old2', companyId: C1, status: 'answered', answeredBy: 'cc-alice', updatedAt: '2026-01-01T12:00:00.000Z' },
  { callSid: 'old3', companyId: C1, status: 'answered', answeredBy: 'cc-chloe', updatedAt: '2026-01-01T11:00:00.000Z' },
];
t = await inbound();
assert.equal(clientsOf(t).join(), 'cc-dina', 'jamais vue : libre depuis le plus longtemps');
assert.ok(t.includes('<Dial timeout="15" answerOnBridge="true"'), 'sonnerie de 15 s, une personne à la fois');
url = nextActionOf(t); assert.ok(url);
t = await next(url, 'busy'); assert.equal(clientsOf(t).join(), 'cc-chloe', 'puis la suivante (chloe libre depuis 11h, alice depuis 12h)');
t = await next(nextActionOf(t), 'no-answer'); assert.equal(clientsOf(t).join(), 'cc-alice');
const lastUrl = nextActionOf(t);
// décroché : la personne est enregistrée (alimente « libre depuis le plus longtemps »), puis traitement standard
calls.push({ callSid: 'CAnext', companyId: C1, status: 'ringing', answeredBy: '' });
t = await next(lastUrl, 'completed');
assert.equal(t, wrap('<Hangup/>'), 'décroché : le traitement standard raccroche');
assert.equal(calls.find((c) => c.callSid === 'CAnext').answeredBy, 'cc-alice', 'identité de la secrétaire qui a décroché');
// une tentative décrochée en cours de route
t = await inbound(); url = nextActionOf(t);
calls.find((c) => c.callSid === 'CAnext').answeredBy = '';
t = await next(url, 'completed'); assert.equal(t, wrap('<Hangup/>'));
assert.equal(calls.find((c) => c.callSid === 'CAnext').answeredBy, 'cc-dina');
// appelant parti
t = await next(url, 'canceled'); assert.equal(t, wrap('<Hangup/>'));
// plan altéré, expiré ou absent : traitement standard, jamais de sonnerie improvisée
for (const bad of [`${url}x`, 'https://x/y?s=abc']) { t = await next(bad, 'no-answer'); assert.ok(!t.includes('<Client>'), 'jeton invalide'); assert.ok(t.includes('<Record')); }
t = await call('handleTwilioInboundQueueNext', { body: { DialCallStatus: 'no-answer' }, query: {} }); assert.ok(t.includes('<Record') && !t.includes('<Client>'), 'sans jeton');
const forged = jwt.sign({ p: [{ i: ['cc-victime'], t: 15, s: true }, { i: ['cc-autre'], t: 15, s: true }], n: 1, c: C2 }, 'pas-le-bon-secret', { audience: 'inbound-queue-plan' });
t = await next(`https://x/y?s=${forged}`, 'no-answer'); assert.ok(!t.includes('cc-autre'), 'plan forgé refusé');
const expired = jwt.sign({ p: [{ i: ['cc-a'], t: 15, s: true }, { i: ['cc-b'], t: 15, s: true }], n: 1, c: C1 }, process.env.JWT_SECRET, { audience: 'inbound-queue-plan', expiresIn: -10 });
t = await next(`https://x/y?s=${expired}`, 'no-answer'); assert.ok(!t.includes('<Client>'), 'plan expiré refusé');

// plafond de 5 tentatives
for (let i = 0; i < 7; i += 1) staff(`u${i}`, ['fr']);
seed([{ name: 'Tour', strategy: 'longest_idle', languages: ['fr'] }]); present('alice', 'chloe', 'dina', 'u0', 'u1', 'u2', 'u3');
t = await inbound(); let steps = 1;
while (nextActionOf(t)) { const n = await next(nextActionOf(t), 'no-answer'); if (!n.includes('<Client>')) { t = n; break; } t = n; steps += 1; }
assert.equal(steps, 5, 'au plus 5 tentatives'); assert.ok(t.includes('<Record'), 'puis repli');

// stratégie « round_robin » : le curseur tourne, de façon persistante
seed([{ name: 'RR', strategy: 'round_robin' }]); staffStore = []; present('alice', 'bob', 'chloe');
const first = [];
for (let i = 0; i < 4; i += 1) first.push(clientsOf(await inbound())[0]);
assert.deepEqual(first, ['cc-alice', 'cc-bob', 'cc-chloe', 'cc-alice'], 'une secrétaire à la fois, en tournant');
assert.equal(queueStore[0].rrCursor, 4, 'curseur mis à jour (incrément atomique)');
present('dina'); const before = queueStore[0].rrCursor; await inbound(); present('alice');
assert.ok(queueStore[0].rrCursor >= before);
seed([{ name: 'RR', strategy: 'round_robin', languages: ['ar'] }]); present('alice');
await inbound(); assert.equal(queueStore[0].rrCursor, 0, 'personne d\'éligible : le curseur n\'avance pas');
// sonnerie simultanée avec un seul éligible : identique à l'existant ; round_robin à un seul éligible : passe par le plan signé (enregistrement de la décrochée)
seed([{ name: 'RR', strategy: 'round_robin' }]); present('alice');
assert.ok(nextActionOf(await inbound()), 'une personne à la fois même si une seule');

// notification : plus personne à appeler -> repli existant, appel consigné
calls = []; present(); seed([{ name: 'Seule', languages: ['ar'] }]);
const sid = 'CAlog'; t = await inbound({ CallSid: sid });
assert.ok(t.includes('<Record')); assert.equal(calls.find((c) => c.callSid === sid).status, 'no_agent', 'appel consigné comme sans conseiller');

// ---------------------------------------------------------------- API : droits, validation, remplacement atomique, aperçu
const directory = {
  owner1: { companyId: C1, isOwner: true },
  member1: { companyId: C1, isOwner: false, permissions: { 'calls.view': true } },
  memberNoCalls: { companyId: C1, isOwner: false, permissions: {} },
  agent1: { companyId: C1, isOwner: false, isAgent: true },
  other1: { companyId: C2, isOwner: true },
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => {
  const s = String(u);
  if (s.startsWith('https://registration.test/api/company-members/me')) return { ok: true, json: async () => ({ success: true, data: directory[new URL(s).searchParams.get('userId')] || {} }) };
  if (s.startsWith('http://127.0.0.1')) return realFetch(u, init);
  throw new Error(`fetch inattendu ${s}`);
};
const app = express();
app.use(express.json());
app.use('/api/secretariat', secretariatToolsRoutes);
const server = app.listen(0);
const api = `http://127.0.0.1:${server.address().port}/api/secretariat`;
const sign = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: 60 });
const req = async (method, path, { user, body } = {}) => {
  clearCompanyCache();
  const res = await realFetch(`${api}${path}`, { method, headers: { ...(user ? { Authorization: `Bearer ${sign(user)}` } : {}), 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* texte */ }
  return { status: res.status, body: json };
};

try {
  queueStore = []; staffStore = []; present();
  const QID = '64b0000000000000000000ff';
  // 401 : session obligatoire
  for (const [m, p, b] of [['GET', `/queues/${C1}`], ['POST', `/queues/${C1}`, { name: 'A' }], ['PUT', `/queues/${C1}`, { queues: [] }], ['PUT', `/queues/${C1}/${QID}`, { name: 'A' }], ['DELETE', `/queues/${C1}/${QID}`],
    ['GET', `/staff/${C1}`], ['PUT', `/staff/${C1}/alice`, { languages: [], skills: [] }], ['GET', `/routing-preview/${C1}`]]) {
    assert.equal((await req(m, p, { body: b })).status, 401, `${m} ${p}`);
  }
  // 403 : autre centre
  for (const [m, p, b] of [['GET', `/queues/${C1}`], ['POST', `/queues/${C1}`, { name: 'A' }], ['PUT', `/queues/${C1}`, { queues: [] }], ['PUT', `/queues/${C1}/${QID}`, { name: 'A' }], ['DELETE', `/queues/${C1}/${QID}`],
    ['GET', `/staff/${C1}`], ['PUT', `/staff/${C1}/alice`, { languages: [], skills: [] }], ['GET', `/routing-preview/${C1}`]]) {
    assert.equal((await req(m, p, { user: 'other1', body: b })).status, 403, `autre centre ${m} ${p}`);
  }
  // lecture : tout membre rattaché ; écriture refusée à un agent ou à un membre sans le droit
  for (const user of ['owner1', 'member1', 'memberNoCalls', 'agent1']) {
    const r = await req('GET', `/queues/${C1}`, { user });
    assert.deepEqual(r.body, { success: true, data: { queues: [] } }, user);
    assert.equal((await req('GET', `/staff/${C1}`, { user })).body.data.members.length, 0);
    assert.equal((await req('GET', `/routing-preview/${C1}`, { user })).status, 200);
  }
  for (const user of ['agent1', 'memberNoCalls']) {
    for (const [m, p, b] of [['POST', `/queues/${C1}`, { name: 'A' }], ['PUT', `/queues/${C1}`, { queues: [{ name: 'A' }] }], ['PUT', `/queues/${C1}/${QID}`, { name: 'A' }], ['DELETE', `/queues/${C1}/${QID}`], ['PUT', `/staff/${C1}/alice`, { languages: [], skills: [] }]]) {
      assert.equal((await req(m, p, { user, body: b })).status, 403, `${user} ${m} ${p}`);
    }
  }
  assert.equal(queueStore.length, 0); assert.equal(staffStore.length, 0, 'un refus n\'écrit rien');

  // création : normalisation + vue exacte
  let r = await req('POST', `/queues/${C1}`, { user: 'owner1', body: { name: '  Accueil  français ', direction: 'inbound', strategy: 'round_robin', languages: [' FR ', 'en', 'fr'], skills: [' Facturation ', 'facturation'], isDefault: true, menuKey: '1', prompt: ' Bienvenue ', promptLanguage: 'fr' } });
  assert.equal(r.status, 201);
  const created = r.body.data.queue;
  assert.deepEqual(Object.keys(created).sort(), ['direction', 'id', 'isDefault', 'languages', 'menuKey', 'name', 'prompt', 'promptLanguage', 'skills', 'strategy']);
  assert.deepEqual({ ...created, id: 'x' }, { id: 'x', name: 'Accueil français', direction: 'inbound', strategy: 'round_robin', languages: ['fr', 'en'], skills: ['facturation'], isDefault: true, menuKey: '1', prompt: 'Bienvenue', promptLanguage: 'fr' });
  assert.match(created.id, /^[a-f0-9]{24}$/);
  assert.deepEqual(r.body.data.queues.map((x) => x.id), [created.id]);
  // erreurs de validation : 400 { success:false, error, message } en français, rien d'écrit
  const bads = [
    [{}, /nom est obligatoire/], [{ name: '' }, /nom est obligatoire/], [{ name: 'B', menuKey: '1' }, /touche 1/], [{ name: 'B', isDefault: true }, /Une seule file entrante/],
    [{ name: 'B', languages: ['klingon'] }, /Langue inconnue/], [{ name: 'B', skills: ['x'.repeat(25)] }, /24/], [{ name: 'B', menuKey: '0' }, /1 à 9/], [{ name: 'B', prompt: 'x'.repeat(161) }, /160/],
  ];
  for (const [body, re] of bads) {
    r = await req('POST', `/queues/${C1}`, { user: 'owner1', body });
    assert.equal(r.status, 400, JSON.stringify(body)); assert.equal(r.body.success, false); assert.match(r.body.error, re); assert.equal(r.body.message, r.body.error);
  }
  assert.equal(queueStore.length, 1, 'les créations invalides n\'écrivent rien');
  r = await req('POST', `/queues/${C1}`, { user: 'member1', body: { name: 'English', languages: ['en'], menuKey: '2' } });
  assert.equal(r.status, 201); const english = r.body.data.queue;
  // mise à jour
  r = await req('PUT', `/queues/${C1}/${english.id}`, { user: 'owner1', body: { name: 'Anglais', strategy: 'longest_idle', skills: ['VIP'] } });
  assert.equal(r.status, 200); assert.deepEqual(r.body.data.queue, { ...english, name: 'Anglais', strategy: 'longest_idle', skills: ['vip'] });
  assert.equal((await req('PUT', `/queues/${C1}/${english.id}`, { user: 'owner1', body: { menuKey: '1' } })).status, 400, 'touche déjà prise');
  assert.equal((await req('PUT', `/queues/${C1}/${english.id}`, { user: 'owner1', body: { languages: ['zz'] } })).status, 400);
  assert.equal((await req('PUT', `/queues/${C1}/${QID}`, { user: 'owner1', body: { name: 'X' } })).status, 404);
  assert.equal((await req('PUT', `/queues/${C1}/pas-un-id`, { user: 'owner1', body: { name: 'X' } })).status, 404);
  assert.equal(queueStore.find((d) => d._id === english.id).name, 'Anglais');
  // lecture
  r = await req('GET', `/queues/${C1}`, { user: 'agent1' });
  assert.deepEqual(r.body.data.queues.map((x) => x.name), ['Accueil français', 'Anglais']);
  assert.deepEqual((await req('GET', `/queues/${C2}`, { user: 'other1' })).body.data.queues, [], 'un autre centre ne voit rien');
  // suppression
  assert.equal((await req('DELETE', `/queues/${C1}/${QID}`, { user: 'owner1' })).status, 404);
  r = await req('DELETE', `/queues/${C1}/${english.id}`, { user: 'owner1' });
  assert.equal(r.status, 200); assert.deepEqual(r.body.data.queues.map((x) => x.name), ['Accueil français']);

  // remplacement atomique de tout l'ensemble
  queueStore[0].rrCursor = 7;
  const snapshot = JSON.stringify(queueStore);
  for (const [body, re] of [
    [{ queues: [{ name: 'A', menuKey: '1' }, { name: 'B', menuKey: '1' }] }, /touche 1/],
    [{ queues: [{ name: 'A', isDefault: true }, { name: 'B', isDefault: true }] }, /Une seule file entrante/],
    [{ queues: [{ name: 'A', languages: ['xx'] }] }, /Langue inconnue/],
    [{ queues: [{ name: 'OK' }, { name: '' }] }, /nom est obligatoire/],
    [{ queues: Array.from({ length: 10 }, (_, i) => ({ name: `F${i}` })) }, /Au plus 9 files entrantes/],
    [{ queues: 'x' }, /invalide/], [{}, /invalide/],
  ]) {
    r = await req('PUT', `/queues/${C1}`, { user: 'owner1', body });
    assert.equal(r.status, 400, JSON.stringify(body)); assert.match(r.body.error, re);
    assert.equal(JSON.stringify(queueStore), snapshot, 'un remplacement invalide ne modifie RIEN (tout ou rien)');
  }
  r = await req('PUT', `/queues/${C1}`, { user: 'owner1', body: { queues: [
    { id: created.id, name: 'Accueil FR', languages: ['fr'], isDefault: true, menuKey: '2' },
    { name: 'Espagnol', languages: ['es'], menuKey: '1' },
    { name: 'Sortante', direction: 'outbound' },
  ] } });
  assert.equal(r.status, 200); assert.deepEqual(r.body.data.queues.map((x) => [x.name, x.menuKey]), [['Accueil FR', '2'], ['Espagnol', '1'], ['Sortante', null]]);
  assert.equal(r.body.data.queues[0].id, created.id, 'la file conservée garde son identifiant');
  assert.equal(queueStore.find((d) => d._id === created.id).rrCursor, 7, 'et son curseur de tour de rôle');
  assert.ok(queueStore.every((d) => String(d.companyId) === C1));
  assert.equal(queueStore.length, 3);
  r = await req('PUT', `/queues/${C1}`, { user: 'member1', body: { queues: [{ id: QID, name: 'Inconnue' }] } });
  assert.equal(r.status, 200); assert.equal(queueStore.length, 1); assert.notEqual(queueStore[0]._id, QID, 'un id inconnu ne force pas l\'identifiant');
  r = await req('PUT', `/queues/${C1}`, { user: 'owner1', body: { queues: [] } });
  assert.equal(r.status, 200); assert.deepEqual(r.body, { success: true, data: { queues: [] } }); assert.equal(queueStore.length, 0, 'supprimer toutes les files');

  // compétences des secrétaires
  assert.equal((await req('PUT', `/staff/${C1}/alice`, { user: 'owner1', body: { languages: ['xx'], skills: [] } })).status, 400);
  assert.equal((await req('PUT', `/staff/${C1}/alice`, { user: 'owner1', body: { languages: ['fr'] } })).status, 400, 'les deux listes sont obligatoires');
  assert.equal((await req('PUT', `/staff/${C1}/a%20b`, { user: 'owner1', body: { languages: [], skills: [] } })).status, 400);
  assert.equal((await req('PUT', `/staff/${C1}/alice`, { user: 'owner1', body: { languages: ['fr'], skills: ['x'.repeat(25)] } })).status, 400);
  assert.equal(staffStore.length, 0);
  r = await req('PUT', `/staff/${C1}/alice`, { user: 'owner1', body: { languages: [' FR ', 'ar', 'fr'], skills: [' Facturation ', 'facturation'] } });
  assert.equal(r.status, 200); assert.deepEqual(r.body.data.member, { userId: 'alice', languages: ['fr', 'ar'], skills: ['facturation'] });
  r = await req('PUT', `/staff/${C1}/alice`, { user: 'member1', body: { languages: ['en'], skills: [] } });
  assert.deepEqual(r.body.data.member, { userId: 'alice', languages: ['en'], skills: [] }, 'remplace (ne fusionne pas)');
  assert.equal(staffStore.length, 1, 'un seul document par personne');
  await req('PUT', `/staff/${C1}/bob`, { user: 'owner1', body: { languages: ['en'], skills: [] } });
  assert.deepEqual((await req('GET', `/staff/${C1}`, { user: 'agent1' })).body, { success: true, data: { members: [{ userId: 'alice', languages: ['en'], skills: [] }, { userId: 'bob', languages: ['en'], skills: [] }] } });
  assert.deepEqual((await req('GET', `/staff/${C2}`, { user: 'other1' })).body.data.members, []);

  // aperçu du routage avec avertissements
  staffStore = []; present('alice', 'bob');
  await req('PUT', `/staff/${C1}/alice`, { user: 'owner1', body: { languages: ['fr'], skills: [] } });
  await req('PUT', `/staff/${C1}/bob`, { user: 'owner1', body: { languages: ['en'], skills: [] } });
  await req('PUT', `/staff/${C1}/chloe`, { user: 'owner1', body: { languages: ['fr', 'en'], skills: ['facturation'] } });
  r = await req('PUT', `/queues/${C1}`, { user: 'owner1', body: { queues: [
    { name: 'Français', languages: ['fr'], menuKey: '1' }, { name: 'Arabe', languages: ['ar'], menuKey: '2' }, { name: 'Facturation', skills: ['facturation'], menuKey: '3' },
    { name: 'Libre', menuKey: '4' }, { name: 'Sortante', direction: 'outbound' },
  ] } });
  r = await req('GET', `/routing-preview/${C1}`, { user: 'member1' });
  assert.equal(r.status, 200);
  const pv = r.body.data.queues;
  assert.deepEqual(pv.map((x) => x.name), ['Français', 'Arabe', 'Facturation', 'Libre'], 'files entrantes seulement');
  assert.deepEqual(Object.keys(pv[0]).sort(), ['eligibleOnline', 'eligibleTotal', 'id', 'name', 'warning']);
  assert.deepEqual(pv.map((x) => [x.eligibleOnline, x.eligibleTotal]), [[1, 2], [0, 0], [0, 1], [2, 3]]);
  assert.equal(pv[0].warning, null);
  assert.equal(pv[1].warning, "Aucune secrétaire n'a la langue arabe : les appels de cette file iront à la file par défaut « Français ».", 'sans file par défaut déclarée, la première file en tient lieu (comme à l\'appel)');
  const spec = Q.previewQueues({ queues: [{ _id: 'f', name: 'Français', languages: ['fr'], isDefault: true, createdAt: 1 }, { _id: 'a', name: 'Arabe', languages: ['ar'], createdAt: 2 }], online: [], staff: [{ identity: 'cc-alice', languages: ['fr'], skills: [] }] });
  assert.equal(spec[1].warning, "Aucune secrétaire n'a la langue arabe : les appels de cette file iront au mobile puis au répondeur.", 'la file par défaut n\'a personne en ligne');
  assert.equal(pv[2].warning, "Aucune secrétaire compatible n'est en ligne pour le moment : les appels de cette file iront à la file par défaut « Français ».");
  assert.equal(pv[3].warning, null);
  // la file par défaut change la destination annoncée
  const arab = (await req('GET', `/queues/${C1}`, { user: 'owner1' })).body.data.queues;
  await req('PUT', `/queues/${C1}/${arab[0].id}`, { user: 'owner1', body: { isDefault: true } });
  assert.equal((await req('GET', `/routing-preview/${C1}`, { user: 'owner1' })).body.data.queues[1].warning, "Aucune secrétaire n'a la langue arabe : les appels de cette file iront à la file par défaut « Français ».");
  await req('PUT', `/queues/${C1}/${arab[3].id}`, { user: 'owner1', body: { isDefault: true } }).then((x) => assert.equal(x.status, 400, 'une seule file par défaut'));
  assert.deepEqual((await req('GET', `/routing-preview/${C2}`, { user: 'other1' })).body.data.queues, []);
  // plusieurs manques
  const pw = Q.previewQueues({ queues: [{ _id: 'a', name: 'Rare', languages: ['ar', 'he'], skills: [], createdAt: 1 }, { _id: 'b', name: 'Experts', languages: [], skills: ['x', 'y'], createdAt: 2 }, { _id: 'c', name: 'Mix', languages: ['fr'], skills: ['facturation'], createdAt: 3 }, { _id: 'd', name: 'Vide', createdAt: 4 }], online: [], staff: [{ identity: 'cc-a', languages: ['fr'], skills: [] }, { identity: 'cc-b', languages: [], skills: ['facturation'] }] });
  assert.match(pw[0].warning, /^Aucune secrétaire n'a les langues arabe, hébreu : /);
  assert.match(pw[1].warning, /^Aucune secrétaire n'a les compétences « x », « y » : /);
  assert.match(pw[2].warning, /^Aucune secrétaire n'a à la fois toutes les langues et toutes les compétences de cette file : /);
  assert.match(pw[3].warning, /^Aucune secrétaire compatible n'est en ligne pour le moment : /, 'file libre, des profils connus mais personne en ligne');
  assert.match(Q.previewQueues({ queues: [{ _id: 'd', name: 'Vide', createdAt: 4 }], online: [], staff: [] })[0].warning, /^Aucune secrétaire n'est enregistrée ni en ligne pour cette file : /);

  realLog('callQueues: ok');
} finally {
  server.close();
}
