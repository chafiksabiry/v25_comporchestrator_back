// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACx TWILIO_AUTH_TOKEN=x node src/tests/aiAgentPilot.test.js
// Pilote « Téléphonie + agent IA » (appels entrants) : réglages, disponibilité (recette), déclencheurs, annonce IA, minutes, créneaux,
// latence, jetons, routage avec repli, outils (isolement entre entreprises), compte rendu et routes titulaire. Base, dash_calls et
// Twilio SIMULÉS : aucun appel réseau réel.
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
const S = await import('../services/aiAgentSettings.js');
const K = await import('../services/aiInboundCore.js');
const AI = await import('../services/aiInbound.js');
const { default: AiAgentSettings } = await import('../models/AiAgentSettings.js');
const { default: AiInboundCall } = await import('../models/AiInboundCall.js');
const { default: AiMinutesUsage } = await import('../models/AiMinutesUsage.js');
const { default: InboundCall } = await import('../models/InboundCall.js');
const { default: InboundSettings } = await import('../models/InboundSettings.js');
const { default: ReceptionDirectory } = await import('../models/ReceptionDirectory.js');
const { default: FollowUpItem } = await import('../models/FollowUpItem.js');
const { default: Contact } = await import('../models/Contact.js');
const { default: SecretariatTools } = await import('../models/SecretariatTools.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');
const { aiAgentController: ctl, aiInboundTool, aiInboundReport, aiInboundAfterStream } = await import('../controllers/aiAgentController.js');

const quiet = { log: console.log, error: console.error, warn: console.warn };
console.log = () => {}; console.error = () => {}; console.warn = () => {};
const A = '64b0000000000000000000a1'; const B = '64b0000000000000000000b2';
const E1 = '64b00000000000000000e001'; const E2 = '64b00000000000000000e002';
const SID = `CA${'1'.repeat(32)}`; const SID_B = `CA${'2'.repeat(32)}`;
// Mardi 3 novembre 2026, 20 h à Paris (hors horaires) ; 10 h (dans les horaires).
const EVENING = Date.parse('2026-11-03T19:00:00Z'); const MORNING = Date.parse('2026-11-03T09:00:00Z');

// ================================================================ réglages
const d = S.toPublicSettings(null);
assert.equal(d.enabled, false); assert.equal(d.level, 'partial'); assert.equal(d.maxCallMinutes, 8); assert.equal(d.addressForm, 'vous');
assert.equal(d.voice, 'female'); assert.deepEqual(d.languages, ['fr-FR']); assert.equal(d.triggers.allBusy, false); assert.equal(d.monthlyMinutesCap, 200);
assert.equal(S.toPublicSettings(null, { companyNameFallback: 'Cabinet Martin' }).companyName, 'Cabinet Martin', 'nom de l’annuaire par défaut');
let v = S.validateSettingsUpdate({ maxCallMinutes: 2 }); assert.equal(v.ok, false); assert.equal(v.issues[0].code, 'out_of_range'); assert.equal(v.issues[0].min, 3);
assert.equal(S.validateSettingsUpdate({ maxCallMinutes: 16 }).ok, false);
assert.equal(S.validateSettingsUpdate({ maxCallMinutes: 15 }).value.maxCallMinutes, 15);
assert.equal(S.validateSettingsUpdate({ triggers: { allBusy: true } }).value['triggers.allBusy'], true, '« tous occupés » : accepté, limité par la capacité');
assert.equal(S.validateSettingsUpdate({ triggers: { allBusy: 'oui' } }).issues[0].code, 'invalid_type');
assert.equal(S.validateSettingsUpdate({ languages: ['fr-FR', 'de-DE'] }).issues[0].code, 'invalid_language');
assert.deepEqual(S.validateSettingsUpdate({ languages: ['en-GB', 'fr-FR'] }).value.languages, ['en-GB', 'fr-FR']);
assert.equal(S.validateSettingsUpdate({ addressForm: 'toi' }).issues[0].code, 'invalid_address_form');
assert.equal(S.validateSettingsUpdate({ addressForm: 'tu' }).value.addressForm, 'tu');
assert.equal(S.validateSettingsUpdate({ voice: 'robot' }).issues[0].code, 'invalid_voice');
assert.equal(S.validateSettingsUpdate({ businessHours: { slots: [{ day: 1, start: '18:00', end: '09:00' }] } }).issues[0].code, 'invalid_slot');
assert.equal(S.validateSettingsUpdate({ businessHours: { timeZone: '+01:00' } }).issues[0].code, 'invalid_time_zone');
assert.equal(S.validateSettingsUpdate({ instructions: 'x'.repeat(4001) }).issues[0].code, 'too_long');
assert.equal(S.validateSettingsUpdate({ transferTargets: [E1] }, { directoryEntryIds: [E2] }).unknownTarget, true, 'destinataire hors annuaire');
assert.deepEqual(S.validateSettingsUpdate({ transferTargets: [E1, E1] }, { directoryEntryIds: [E1] }).value.transferTargets, [E1]);

// ================================================================ disponibilité (recette) : désactivée par défaut
assert.deepEqual(S.pilotAvailability(A, {}), { pilotEnabled: false, companyAllowed: false, available: false });
assert.equal(S.pilotAvailability(A, { AI_INBOUND_ENABLED: 'true' }).available, false, 'liste blanche vide');
assert.equal(S.pilotAvailability(A, { AI_INBOUND_COMPANY_IDS: A }).available, false, 'drapeau absent');
assert.equal(S.pilotAvailability(A, { AI_INBOUND_ENABLED: 'true', AI_INBOUND_COMPANY_IDS: `${B}, ${A}` }).available, true);
assert.equal(S.pilotAvailability(B, { AI_INBOUND_ENABLED: 'true', AI_INBOUND_COMPANY_IDS: A }).available, false);

// ================================================================ déclencheurs
const open = { available: true };
const on = { ...d, enabled: true };
assert.equal(S.isWithinBusinessHours(d.businessHours, MORNING), true);
assert.equal(S.isWithinBusinessHours(d.businessHours, EVENING), false);
assert.equal(S.decideAiRoute({ settings: on, availability: open, now: EVENING }).trigger, 'outside_hours');
assert.equal(S.decideAiRoute({ settings: on, availability: open, now: MORNING }).reason, 'no_trigger', 'partiel, heures ouvrées : humains');
assert.equal(S.decideAiRoute({ settings: { ...on, level: 'total' }, availability: open, now: MORNING }).trigger, 'total');
assert.equal(S.decideAiRoute({ settings: on, availability: { available: false }, now: EVENING }).reason, 'pilot_closed');
assert.equal(S.decideAiRoute({ settings: d, availability: open, now: EVENING }).reason, 'disabled');
assert.equal(S.decideAiRoute({ settings: on, availability: open, lineBusy: true, now: EVENING }).reason, 'line_busy', 'une ligne = un appel');
assert.equal(S.decideAiRoute({ settings: on, availability: open, minutesUsed: 200, now: EVENING }).reason, 'cap_reached', 'plafond mensuel');
assert.equal(S.decideAiRoute({ settings: on, availability: open, minutesUsed: 199, now: EVENING }).route, true);
assert.equal(S.decideAiRoute({ settings: { ...on, triggers: { outsideHours: false } }, availability: open, now: EVENING }).route, false);
// « Tous occupés » : seulement pour un appel simultané pris dans la capacité restante de la ligne.
const busyOn = { ...on, triggers: { outsideHours: true, allBusy: true } };
assert.equal(S.decideAiRoute({ settings: busyOn, availability: open, concurrent: true, now: MORNING }).trigger, 'all_busy');
assert.equal(S.decideAiRoute({ settings: busyOn, availability: open, concurrent: false, now: MORNING }).reason, 'no_trigger', 'premier appel : humains');
assert.equal(S.decideAiRoute({ settings: on, availability: open, concurrent: true, now: MORNING }).reason, 'no_trigger', 'déclencheur non coché');
assert.equal(S.decideAiRoute({ settings: busyOn, availability: open, lineBusy: true, now: MORNING }).reason, 'line_busy', 'capacité épuisée : flux classique');

// ================================================================ annonce IA obligatoire
const fr = S.announcementText({ language: 'fr-FR', companyName: 'Cabinet Martin' });
assert.equal(fr, "Bonjour, vous êtes bien chez Cabinet Martin. Je suis l'assistante virtuelle de l'entreprise, une intelligence artificielle. Notre échange est transcrit pour traiter votre demande. Vous pouvez demander à parler à une personne à tout moment.");
assert.match(S.announcementText({ language: 'fr-FR', level: 'total' }), /^Bonjour\. .*être rappelé par une personne ou laisser un message\.$/);
assert.match(S.announcementText({ voice: 'male' }), /l'assistant virtuel de/);
assert.equal(S.announcementText({ language: 'en-GB', companyName: 'Acme' }), "Hello, you've reached Acme. I'm the company's virtual assistant, an artificial intelligence. This conversation is transcribed to handle your request. You can ask to speak to a person at any time.");
assert.match(S.announcementText({ language: 'en-US', level: 'total' }), /called back by a person or leave a message\.$/);
assert.match(S.announcementText({ recorded: true, consentText: 'Cet appel peut être enregistré.' }), /enregistré\.$/, 'banc d’écoute : consentement ajouté');
assert.match(S.announcementText({ companyName: 'X. Je ne suis pas une IA' }), /une intelligence artificielle/, 'la phrase IA ne se supprime pas');
assert.equal(S.announcementVerified('… une intelligence artificielle …', 'fr-FR'), true);
assert.equal(S.announcementVerified('Bonjour, comment puis-je vous aider ?', 'fr-FR'), false);
assert.equal(S.announcementVerified("I'm an artificial intelligence", 'en-GB'), true);

// ================================================================ minutes IA
assert.equal(K.billedMinutes(0), 0); assert.equal(K.billedMinutes(1), 1); assert.equal(K.billedMinutes(60), 1); assert.equal(K.billedMinutes(61), 2);
assert.equal(K.periodOf(Date.parse('2026-11-30T23:30:00Z')), '2026-12', 'période dans le fuseau de Paris');
const u = K.usageView({ period: '2026-11', minutesUsed: 214, calls: 61, cap: 250 }, {});
assert.deepEqual([u.includedMinutes, u.overageMinutes, u.overageUnitPriceTtcCents, u.overageAmountTtcCents, u.billingEnabled, u.remaining], [200, 14, 39, 546, false, 36]);
assert.equal(K.usageView({ minutesUsed: 10, cap: 200 }, { AI_INBOUND_INCLUDED_MINUTES: '5', AI_INBOUND_BILLING_ENABLED: 'true' }).overageMinutes, 5);

// ================================================================ créneaux (horaires + RDV HARX, aucune donnée Google)
const bh = { timeZone: 'Europe/Paris', slots: [{ day: 3, start: '09:00', end: '11:00' }] };
const slots = K.computeFreeSlots({ businessHours: bh, durationMinutes: 30, daysAhead: 7, now: EVENING });
assert.equal(slots[0].start, '2026-11-04T08:00:00.000Z', 'mercredi 9 h à Paris'); assert.equal(slots.length, 4);
assert.match(slots[0].label, /mercredi/);
const busy = [{ start: '2026-11-04T08:00:00Z', end: '2026-11-04T08:30:00Z' }];
assert.equal(K.computeFreeSlots({ businessHours: bh, busy, durationMinutes: 30, daysAhead: 7, now: EVENING })[0].start, '2026-11-04T08:30:00.000Z', 'RDV existant exclu');
assert.equal(K.isBookableSlot({ start: '2026-11-04T08:00:00Z', businessHours: bh, busy, durationMinutes: 30, daysAhead: 7, now: EVENING }), false);
assert.equal(K.isBookableSlot({ start: '2026-11-04T09:00:00Z', businessHours: bh, busy, durationMinutes: 30, daysAhead: 7, now: EVENING }), true);
assert.equal(K.isBookableSlot({ start: '2026-11-04T09:10:00Z', businessHours: bh, busy, durationMinutes: 30, daysAhead: 7, now: EVENING }), false, 'hors grille');
assert.equal(K.isBookableSlot({ start: '2026-11-04T12:00:00Z', businessHours: bh, busy, durationMinutes: 30, daysAhead: 7, now: EVENING }), false, 'hors horaires');

// ================================================================ latence
const L = K.latencyStats([600, 700, 650, 720, 1100]);
assert.equal(L.medianMs, 700); assert.equal(L.p95Ms, 1100); assert.equal(L.withinTarget, true);
assert.equal(K.latencyStats([900, 950, 1000]).withinTarget, false, 'médiane au-dessus de 800 ms');
assert.equal(K.latencyStats([...Array(18).fill(500), 1500, 1600]).withinTarget, false, 'p95 au-dessus de 1,2 s');
assert.equal(K.latencyStats([...Array(19).fill(500), 1600]).withinTarget, true, 'un tour lent sur 20 : p95 tenu');
assert.equal(K.latencyStats([]).withinTarget, null);

// ================================================================ jetons
const ct = K.signCallToken({ companyId: A, callSid: SID });
assert.deepEqual(K.verifyCallToken(`Bearer ${ct}`), { companyId: A, callSid: SID });
assert.ok(jwt.decode(ct).exp - jwt.decode(ct).iat <= 120, 'jeton d’appel : 120 s au plus');
assert.equal(K.verifyCallToken(`Bearer ${jwt.sign({ scope: 'ai-inbound-call', companyId: A, callSid: SID }, 't', { expiresIn: 600 })}`), null, 'durée de vie > 120 s refusée');
assert.equal(K.verifyCallToken(`Bearer ${jwt.sign({ scope: 'ai-inbound-call', companyId: A, callSid: SID, iat: Math.floor(Date.now() / 1000) - 200, exp: Math.floor(Date.now() / 1000) + 60 }, 't')}`), null, 'jeton trop ancien (maxAge)');
assert.equal(K.verifyCallToken(`Bearer ${jwt.sign({ scope: 'ai-inbound' }, 't', { expiresIn: 60 })}`), null, 'mauvaise portée');
assert.equal(K.verifyCallToken(`Bearer ${jwt.sign({ scope: 'ai-inbound-call', companyId: A, callSid: SID, userId: 'u' }, 't', { expiresIn: 60 })}`), null, 'jeton utilisateur');
assert.equal(K.verifyCallToken(`Bearer ${jwt.sign({ scope: 'ai-inbound-call', companyId: A, callSid: SID }, 't')}`), null, 'sans expiration');
assert.equal(K.verifyCallToken(`Bearer ${jwt.sign({ scope: 'ai-inbound-call', companyId: A, callSid: SID }, 'autre', { expiresIn: 60 })}`), null, 'autre secret');
assert.equal(K.verifyCallToken(''), null);
const svc = jwt.verify(K.signAiInboundServiceToken(), 't');
assert.equal(svc.scope, 'ai-inbound'); assert.ok(svc.exp - svc.iat <= 120); assert.equal(svc.userId, undefined);
const st = K.signAfterStreamState({ secret: 'x', companyId: A, callSid: SID });
assert.deepEqual(K.verifyAfterStreamState({ secret: 'x', token: st }), { companyId: A, callSid: SID });
assert.equal(K.verifyAfterStreamState({ secret: 'y', token: st }), null);

// ================================================================ base simulée
const store = { settings: [], calls: [], usage: [], inbound: [], items: [], contacts: [], dirs: [] };
const S2 = (x) => String(x);
const matches = (doc, f) => Object.entries(f).every(([k, val]) => {
  const cur = k.split('.').reduce((o, p) => (o == null ? undefined : Array.isArray(o) ? o.map((x) => x?.[p]) : o[p]), doc);
  if (val && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date) && !val._bsontype) {
    if ('$gt' in val) return cur && new Date(cur) > new Date(val.$gt);
    if ('$gte' in val) return cur && new Date(cur) >= new Date(val.$gte) && (!('$lte' in val) || new Date(cur) <= new Date(val.$lte));
    if ('$lt' in val) return val.$lt instanceof Date ? Boolean(cur) && new Date(cur) < val.$lt : S2(cur) < S2(val.$lt);
    if ('$ne' in val) return S2(cur) !== S2(val.$ne);
  }
  if (val === null) return cur === null || cur === undefined;
  if (Array.isArray(cur)) return cur.some((c) => (typeof c === 'object' ? c.number === val : S2(c) === S2(val)));
  return S2(cur) === S2(val);
});
const q = (v2) => ({ lean: async () => v2, select() { return this; }, sort() { return this; }, limit() { return this; }, then(r, j) { return Promise.resolve(v2).then(r, j); } });
let nextId = 1;
const newId = () => `64b0000000000000000${String(nextId++).padStart(5, '0')}`;
const setPath = (o, p, val) => { const ks = p.split('.'); let t = o; ks.slice(0, -1).forEach((k) => { t[k] = t[k] ?? {}; t = t[k]; }); t[ks.at(-1)] = val; };
const apply = (doc, upd) => {
  for (const [k, val] of Object.entries(upd.$set || {})) setPath(doc, k, val);
  for (const [k, val] of Object.entries(upd.$inc || {})) setPath(doc, k, (k.split('.').reduce((o, p) => o?.[p], doc) || 0) + val);
  for (const [k, val] of Object.entries(upd.$push || {})) { doc[k] = doc[k] || []; if (val && val.$each) doc[k].push(...val.$each); else doc[k].push(val); }
  if (!Object.keys(upd).some((x) => x.startsWith('$'))) Object.assign(doc, upd);
  return doc;
};
const model = (M, key) => {
  M.findOne = (f) => q(store[key].find((x) => matches(x, f)) || null);
  M.find = (f) => q(store[key].filter((x) => matches(x, f)));
  M.countDocuments = async (f) => store[key].filter((x) => matches(x, f)).length;
  M.create = async (doc) => { const r = { _id: newId(), createdAt: new Date(), ...doc }; store[key].push(r); return { ...r, save: async () => r, toObject: () => r }; };
  M.updateOne = async (f, upd, opts = {}) => {
    const doc = store[key].find((x) => matches(x, f));
    if (!doc) { if (opts.upsert) { const r = { _id: newId(), ...Object.fromEntries(Object.entries(f).map(([k, x]) => [k, x])) }; apply(r, { $set: upd.$setOnInsert || {} }); apply(r, upd); store[key].push(r); return { modifiedCount: 1, upsertedCount: 1 }; } return { modifiedCount: 0 }; }
    if (upd.$setOnInsert && Object.keys(upd).length === 1) return { modifiedCount: 0 };
    apply(doc, upd); return { modifiedCount: 1 };
  };
  M.findOneAndUpdate = (f, upd, opts = {}) => {
    let doc = store[key].find((x) => matches(x, f));
    if (!doc && opts.upsert) { doc = { _id: newId(), ...f }; apply(doc, { $set: upd.$setOnInsert || {} }); store[key].push(doc); }
    if (doc) apply(doc, upd);
    return q(doc || null);
  };
};
model(AiAgentSettings, 'settings'); model(AiInboundCall, 'calls'); model(AiMinutesUsage, 'usage'); model(InboundCall, 'inbound');
model(FollowUpItem, 'items'); model(Contact, 'contacts'); model(ReceptionDirectory, 'dirs');
FollowUpItem.findOne = (f) => { const r = store.items.find((x) => matches(x, f)); return r ? Object.assign(Promise.resolve({ ...r, save: async function save() { Object.assign(r, this); } }), { lean: async () => r }) : Object.assign(Promise.resolve(null), { lean: async () => null }); };
InboundSettings.findOne = () => q(null);
SecretariatTools.findOne = () => q(null);

let dashCalls = [];
let dashReply = () => ({ ok: true, status: 201, json: async () => ({ sessionId: 's1', streamUrl: 'wss://dash.test/ai-voice-stream/abc', provider: 'gemini', model: 'gemini-live-2.5-flash-native-audio' }) });
let twilioUpdates = [];
let released = [];
const env = { AI_INBOUND_ENABLED: 'true', AI_INBOUND_COMPANY_IDS: A, DASH_CALLS_API_URL: 'https://dash.test', PUBLIC_API_BASE_URL: 'https://orch.test/api', TWILIO_AUTH_TOKEN: 'x' };
let NOW = EVENING;
AI.setAiInboundDeps({
  env,
  now: () => NOW,
  sleep: async () => {},
  fetch: async (url, init) => { dashCalls.push({ url, init }); return dashReply(url, init); },
  twilio: async () => ({ calls: (sid) => ({ update: async (p) => { twilioUpdates.push({ sid, ...p }); }, recordings: { create: async () => ({ sid: 'RE1' }) } }) }),
  transfer: async () => ({ creditFactor: async () => 1, minutes: async () => 100 }),
  releaseCall: async (sid) => { released.push(sid); },
});
const reset = () => {
  for (const k of Object.keys(store)) store[k] = [];
  dashCalls = []; twilioUpdates = []; released = []; NOW = EVENING;
  store.dirs.push({ _id: 'dA', companyId: A, general: { companyName: 'Cabinet Martin' }, entries: [{ _id: E1, name: 'Mme Martin', phone: '+33611111111', userId: 'u1', hours: [] }], absences: [] });
  store.dirs.push({ _id: 'dB', companyId: B, general: { companyName: 'Société B' }, entries: [{ _id: E2, name: 'M. Bernard', phone: '+33622222222', userId: 'u2', hours: [] }], absences: [] });
  store.settings.push({ companyId: A, enabled: true, level: 'partial', actions: { appointment: true, request: true, transfer: true }, transferTargets: [E1] });
  store.settings.push({ companyId: B, enabled: true, level: 'total', actions: { appointment: true, request: true, transfer: true }, transferTargets: [E2] });
};
const line = { _id: 'l1', companyId: A, phoneNumber: '+33140000000', gigId: null };
const route = (over = {}) => AI.tryAiInbound({ line, to: '+33140000000', from: '+33612345678', callSid: SID, signatureValid: () => true, ...over });

// ================================================================ routage et repli
reset();
env.AI_INBOUND_ENABLED = 'false';
assert.equal(await route(), null, 'pilote fermé : flux classique');
assert.equal(dashCalls.length, 0); assert.equal(store.calls.length, 0, 'pilote fermé : rien n’est écrit');
env.AI_INBOUND_ENABLED = 'true';
NOW = MORNING;
assert.equal(await route(), null, 'partiel, heures ouvrées : humains');
NOW = EVENING;
assert.equal(await route({ lineBusy: true }), null, 'ligne tenue : flux classique');
NOW = MORNING; store.settings[0].triggers = { outsideHours: true, allBusy: true };
assert.equal(await route(), null, 'heures ouvrées, premier appel : humains');
assert.match(await route({ concurrent: true }), /<Connect /, 'appel simultané dans la capacité : agent IA « tous occupés »');
assert.equal(JSON.parse(dashCalls.at(-1).init.body).trigger, 'all_busy');
reset(); NOW = EVENING;
let twiml = await route();
assert.match(twiml, /^<Connect action="https:\/\/orch\.test\/api\/phone-numbers\/webhooks\/twilio\/ai-inbound\/after-stream\?s=[^"]+" method="POST"><Stream url="wss:\/\/dash\.test\/ai-voice-stream\/abc"\/><\/Connect>$/);
const sent = JSON.parse(dashCalls[0].init.body);
assert.equal(dashCalls[0].url, 'https://dash.test/api/internal/ai-inbound/sessions');
assert.equal(jwt.verify(dashCalls[0].init.headers.Authorization.split(' ')[1], 't').scope, 'ai-inbound', 'API interne : jeton de service ai-inbound');
assert.equal(sent.companyId, A); assert.equal(sent.trigger, 'outside_hours'); assert.equal(sent.maxCallSeconds, 480); assert.equal(sent.addressForm, 'vous');
assert.match(sent.announcement.text, /Cabinet Martin\. Je suis l'assistante virtuelle de l'entreprise, une intelligence artificielle\./);
assert.equal(sent.announcement.mode, 'engine');
assert.deepEqual(sent.transferTargets, [{ id: E1, name: 'Mme Martin' }], 'noms seulement, jamais de numéro envoyé à l’IA');
assert.ok(!JSON.stringify(sent).includes('+33611111111'));
assert.equal(sent.callToken, undefined, 'aucun jeton longue durée : dash signe un jeton de 120 s à chaque requête');
assert.equal(sent.orchestratorUrl, 'https://orch.test/api', 'URL publique configurée, jamais l’en-tête Host');
// B1 : signature Twilio invalide ou URL publique absente : pas d'IA, flux classique, rien d'écrit.
reset();
assert.equal(await route({ signatureValid: () => false }), null, 'requête non signée par Twilio : flux classique');
delete env.PUBLIC_API_BASE_URL;
assert.equal(await route(), null, 'PUBLIC_API_BASE_URL absente : IA désactivée');
env.PUBLIC_API_BASE_URL = 'http://orch.test/api';
assert.equal(await route(), null, 'URL publique non https : IA désactivée');
env.PUBLIC_API_BASE_URL = 'https://orch.test/api';
assert.equal(dashCalls.length, 0); assert.equal(store.calls.length, 0);
reset(); await route();
assert.equal(store.calls[0].status, 'in_progress'); assert.equal(store.calls[0].engine.provider, 'gemini');
assert.equal(store.inbound[0].route, 'ai_agent', 'statistiques : décroché par l’agent IA');
// Mode d'annonce TwiML : <Say> avant le flux.
reset(); env.AI_INBOUND_ANNOUNCE_MODE = 'twiml';
assert.match(await route(), /^<Say [^>]+>Bonjour, vous êtes bien chez Cabinet Martin\. .*intelligence artificielle.*<\/Say><Connect /);
delete env.AI_INBOUND_ANNOUNCE_MODE;
// Échec de dash (moteur indisponible) : repli, fiche « fallback ».
reset(); dashReply = () => ({ ok: false, status: 503, json: async () => ({}) });
assert.equal(await route(), null, 'moteur indisponible : flux classique');
assert.equal(store.calls[0].status, 'fallback'); assert.equal(store.calls[0].endReason, 'session_failed');
reset(); dashReply = () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
assert.equal(await route(), null, 'délai dépassé : flux classique');
reset(); dashReply = () => ({ ok: true, status: 201, json: async () => ({ streamUrl: 'http://pas-wss' }) });
assert.equal(await route(), null, 'URL de flux invalide : flux classique');
dashReply = () => ({ ok: true, status: 201, json: async () => ({ sessionId: 's1', streamUrl: 'wss://dash.test/ai-voice-stream/abc', provider: 'gemini', model: 'm' }) });
// Plafond mensuel atteint.
reset(); store.usage.push({ companyId: A, period: '2026-11', minutesUsed: 200, calls: 50 });
assert.equal(await route(), null, 'plafond atteint : flux classique'); assert.equal(dashCalls.length, 0);
// Entreprise hors liste blanche.
reset();
assert.equal(await AI.tryAiInbound({ line: { ...line, companyId: B }, to: '+33150000000', from: '+33612345678', callSid: SID_B, signatureValid: () => true }), null, 'B hors liste blanche');

// ================================================================ fin du flux : jamais de raccrochage sec
const afterState = (sid = SID, company = A) => K.signAfterStreamState({ secret: 'x', companyId: company, callSid: sid });
reset(); await route();
let tw = await AI.afterStreamTwiml({ token: afterState(), callSid: SID, baseUrl: 'https://orch.test' });
assert.match(tw, /Veuillez nous excuser/); assert.match(tw, /<Record /, 'coupure : excuse puis répondeur');
assert.equal(store.calls[0].status, 'fallback'); assert.equal(store.calls[0].counted, true, 'minutes comptées même sans compte rendu');
assert.deepEqual(released, [SID], 'ligne libérée');
reset(); await route(); store.calls[0].status = 'completed'; store.calls[0].endReason = 'agent_end';
assert.equal(await AI.afterStreamTwiml({ token: afterState(), callSid: SID, baseUrl: 'https://orch.test' }), '<Hangup/>');
store.calls[0].endReason = 'max_duration';
assert.match(await AI.afterStreamTwiml({ token: afterState(), callSid: SID, baseUrl: 'https://orch.test' }), /Au revoir\.<\/Say><Hangup\/>$/);
for (const [tw2, why] of [[await AI.afterStreamTwiml({ token: 'faux.jeton', callSid: SID, baseUrl: 'https://orch.test' }), 'état non signé'],
  [await AI.afterStreamTwiml({ token: afterState(SID_B), callSid: SID, baseUrl: 'https://orch.test' }), 'état d’un autre appel'],
  [await AI.afterStreamTwiml({ token: afterState(), callSid: SID, baseUrl: 'https://orch.test', signatureValid: false }), 'signature Twilio invalide']]) {
  assert.ok(!tw2.startsWith('<Hangup/>') && /<Record /.test(tw2), `${why} : flux classique (répondeur), jamais de raccrochage sec`);
}
// Compte rendu de dash en retard : la fin normale est attendue, pas prise pour une coupure.
reset(); await route();
let polls = 0;
AI.setAiInboundDeps({ sleep: async () => { polls += 1; if (polls === 3) Object.assign(store.calls[0], { status: 'completed', endReason: 'agent_end' }); } });
assert.equal(await AI.afterStreamTwiml({ token: afterState(), callSid: SID, baseUrl: 'https://orch.test' }), '<Hangup/>', 'compte rendu arrivé pendant l’attente');
AI.setAiInboundDeps({ sleep: async () => {} });

// ================================================================ outils : isolement entre entreprises
reset(); await route();
const claimsA = { companyId: A, callSid: SID };
store.calls.push({ _id: 'callB', companyId: B, callSid: SID_B, from: '+33699999999', to: '+33150000000', status: 'in_progress', language: 'fr-FR', startedAt: new Date(NOW), actions: [], timeline: [] });
store.contacts.push({ companyId: B, firstName: 'Secret', lastName: 'DeB', phones: [{ number: '+33612345678' }] });
assert.deepEqual(await AI.runTool('lookup_caller', claimsA, {}), { known: false }, 'contact de B jamais visible depuis A');
store.contacts.push({ companyId: A, firstName: 'Jeanne', lastName: 'Dupont', phones: [{ number: '+33612345678' }] });
assert.deepEqual(await AI.runTool('lookup_caller', claimsA, {}), { known: true, name: 'Jeanne Dupont' });
await assert.rejects(AI.runTool('lookup_caller', { companyId: A, callSid: SID_B }, {}), (e) => e.code === 'not_found', 'appel de B avec un jeton de A : 404');
const req1 = await AI.runTool('create_request', claimsA, { companyId: B, reason: 'Rappeler pour un devis', urgency: 'urgent', forEntryId: E2 });
const item = store.items.find((x) => x._id === req1.followUpId);
assert.equal(S2(item.companyId), A, 'companyId du corps ignoré'); assert.equal(item.forEntryId, '', 'fiche de B ignorée');
assert.equal(item.fromAiAgent, true); assert.equal(item.urgency, 'urgent'); assert.equal(item.contactPhone, '+33612345678'); assert.equal(item.model, 'message_taken');
store.items.push({ _id: 'rdvB', companyId: B, model: 'appointment', status: 'todo', dueAt: new Date('2026-11-04T08:00:00Z'), durationMinutes: 30 });
const fs1 = await AI.runTool('find_slots', claimsA, {});
assert.equal(fs1.slots[0].start, '2026-11-04T08:00:00.000Z', 'RDV de B sans effet sur les créneaux de A');
store.items.push({ _id: 'rdvA', companyId: A, model: 'appointment', status: 'todo', dueAt: new Date('2026-11-04T08:00:00Z'), durationMinutes: 30 });
assert.equal((await AI.runTool('find_slots', claimsA, {})).slots[0].start, '2026-11-04T08:30:00.000Z');
await assert.rejects(AI.runTool('book_appointment', claimsA, { start: '2026-11-04T08:00:00Z', callerName: 'Jeanne' }), (e) => e.code === 'slot_taken');
const bk = await AI.runTool('book_appointment', claimsA, { start: '2026-11-04T08:30:00Z', callerName: 'Jeanne Dupont', reason: 'Devis' });
const rdv = store.items.find((x) => x._id === bk.followUpId);
assert.equal(rdv.model, 'appointment'); assert.equal(rdv.calendarStatus, 'not_connected', 'aucun agenda externe'); assert.equal(S2(rdv.companyId), A);
await assert.rejects(AI.runTool('transfer_to_human', claimsA, { entryId: E2, reason: 'x' }).then((r) => { if (!r.ok && r.code === 'not_allowed') throw Object.assign(new Error(), { code: 'not_allowed' }); }), (e) => e.code === 'not_allowed', 'fiche de B : refus');
let statusAtTwilio = null;
AI.setAiInboundDeps({ twilio: async () => ({ calls: (sid) => ({ update: async (p) => { statusAtTwilio = store.calls.find((c) => c.callSid === SID).status; twilioUpdates.push({ sid, ...p }); } }) }) });
const tr = await AI.runTool('transfer_to_human', claimsA, { entryId: E1, reason: 'Demande un humain' }, { baseUrl: 'https://orch.test' });
assert.equal(statusAtTwilio, 'transferred', 'état de transfert posé AVANT la bascule Twilio (course avec « appelant parti »)');
assert.deepEqual(tr, { transferring: true, name: 'Mme Martin' });
assert.equal(twilioUpdates[0].sid, SID); assert.match(twilioUpdates[0].twiml, /<Number>\+33611111111<\/Number>/, 'numéro relu dans l’annuaire'); assert.match(twilioUpdates[0].twiml, /transfer-result\?s=/);
assert.equal(store.calls.find((c) => c.callSid === SID).status, 'transferred');
await assert.rejects(AI.runTool('transfer_to_human', claimsA, { entryId: E1, reason: 'x' }), (e) => e.code === 'call_ended', 'après un transfert : plus aucun outil');
await assert.rejects(AI.runTool('create_request', claimsA, { reason: 'x' }), (e) => e.code === 'call_ended');
// Compte rendu « appelant parti » reçu pendant le transfert : la ligne n'est pas libérée.
released = [];
await AI.finalizeCall(store.calls.find((c) => c.callSid === SID), { endReason: 'caller_hangup' });
assert.deepEqual(released, [], 'transfert : la ligne reste tenue');
assert.equal(store.calls.find((c) => c.callSid === SID).status, 'transferred');
store.calls.find((c) => c.callSid === SID).counted = false; store.calls.find((c) => c.callSid === SID).endedAt = null;
// Action désactivée : refus côté serveur même si l'IA appelle l'outil.
store.settings[0].actions = { appointment: false, request: false, transfer: false };
store.calls.find((c) => c.callSid === SID).status = 'in_progress';
for (const t of ['create_request', 'find_slots', 'book_appointment', 'transfer_to_human']) await assert.rejects(AI.runTool(t, claimsA, { reason: 'x', start: 'x', callerName: 'x', entryId: E1 }), (e) => e.code === 'action_not_allowed', t);
await assert.rejects(AI.runTool('rm_rf', claimsA, {}), (e) => e.code === 'unknown_tool');
// « Parler à une personne » toujours possible : la demande de rappel par une personne passe même demandes désactivées.
assert.ok((await AI.runTool('create_request', claimsA, { reason: 'Veut parler à une personne', humanCallback: true })).followUpId);
// Plafond d'actions par appel : 3 demandes, 2 RDV.
store.settings[0].actions = { appointment: true, request: true, transfer: false };
const callA = store.calls.find((c) => c.callSid === SID);
callA.actions = callA.actions.filter((a) => a.type !== 'create_request');
for (let i = 0; i < 3; i += 1) await AI.runTool('create_request', claimsA, { reason: `Demande ${i}` });
await assert.rejects(AI.runTool('create_request', claimsA, { reason: 'Une de trop' }), (e) => e.code === 'action_limit');
callA.actions.push({ type: 'book_appointment', ok: true }, { type: 'book_appointment', ok: true });
await assert.rejects(AI.runTool('book_appointment', claimsA, { start: '2026-11-04T09:00:00Z', callerName: 'X' }), (e) => e.code === 'action_limit');
assert.ok(store.items.filter((x) => x.fromAiAgent).every((x) => x.aiExpiresAt instanceof Date), 'éléments « À faire » de l’IA : même rétention');
// Banc d'écoute : enregistrement seulement à la demande de dash (après l'annonce), une seule fois.
callA.status = 'in_progress'; callA.bench = { requested: true, recordingSid: '' };
const recs = [];
AI.setAiInboundDeps({ twilio: async () => ({ calls: (sid) => ({ recordings: { create: async (o) => { recs.push({ sid, ...o }); return { sid: 'RE9' }; } } }) }) });
assert.deepEqual(await AI.runTool('start_bench_recording', claimsA, {}), { started: true });
assert.deepEqual(await AI.runTool('start_bench_recording', claimsA, {}), { started: false });
assert.equal(recs.length, 1); assert.equal(recs[0].recordingChannels, 'dual'); assert.equal(callA.bench.recorded, true);

// ================================================================ compte rendu : minutes comptées une fois, un seul élément « À faire »
reset(); await route();
const doc0 = store.calls[0];
await AI.runTool('end_call', claimsA, { summary: 'Demande de devis, rappel demain.' });
NOW = EVENING + 125000;
let out = await AI.finalizeCall(store.calls[0], { endReason: 'agent_end', transcript: [{ speaker: 'caller', text: 'Bonjour', at: new Date(EVENING).toISOString() }, { speaker: 'agent', text: 'Bonjour !', at: new Date(EVENING).toISOString() }], latency: { turns: [600, 700, 900] }, usage: { provider: 'gemini', inputTokens: 1000, evil: [1, 2] }, cost: { usd: 0.03 } });
assert.deepEqual(out, { status: 'completed', durationSeconds: 125, minutes: 3 });
assert.equal(store.usage[0].minutesUsed, 3); assert.equal(store.usage[0].calls, 1);
assert.equal(doc0.latency.medianMs, 700); assert.equal(doc0.usage.evil, undefined, 'usage nettoyé');
assert.equal(store.items.length, 1, 'un élément « À faire » par appel'); assert.match(store.items[0].note, /Demande de devis/); assert.equal(store.items[0].fromAiAgent, true);
await AI.finalizeCall(store.calls[0], { endReason: 'agent_end' });
assert.equal(store.usage[0].minutesUsed, 3, 'idempotent : pas de double décompte'); assert.equal(store.items.length, 1);
// Demande créée pendant l'appel : elle reçoit le résumé (pas de doublon).
reset(); await route();
await AI.runTool('create_request', claimsA, { reason: 'Rappeler Mme Dupont' });
await AI.finalizeCall(store.calls[0], { endReason: 'caller_hangup', summary: 'Rappel demandé.' });
assert.equal(store.items.length, 1); assert.match(store.items[0].note, /Rappeler Mme Dupont\nRésumé de l'agent IA : Rappel demandé\./);

// ================================================================ routes : jeton d'appel, titulaire, codes d'erreur
const res = () => { const r = { code: 200, body: null, headers: {} }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.type = () => r; r.send = (b) => { r.body = b; return r; }; r.set = () => r; return r; };
let r = res(); await aiInboundTool({ headers: {}, params: { tool: 'lookup_caller' }, body: {}, get: () => 'orch.test' }, r);
assert.equal(r.code, 401); assert.equal(r.body.code, 'invalid_call_token');
r = res(); await aiInboundTool({ headers: { authorization: `Bearer ${jwt.sign({ userId: 'u1' }, 't', { expiresIn: 60 })}` }, params: { tool: 'lookup_caller' }, body: {}, get: () => 'orch.test' }, r);
assert.equal(r.code, 401, 'jeton utilisateur refusé');
reset(); await route();
r = res(); await aiInboundTool({ headers: { authorization: `Bearer ${K.signCallToken({ companyId: A, callSid: SID, maxCallSeconds: 480 })}` }, params: { tool: 'lookup_caller' }, body: {}, get: () => 'orch.test' }, r);
assert.equal(r.code, 200); assert.equal(r.body.data.known, false);
r = res(); await aiInboundReport({ headers: { authorization: `Bearer ${K.signCallToken({ companyId: A, callSid: SID, maxCallSeconds: 480 })}` }, params: { callSid: SID_B }, body: {} }, r);
assert.equal(r.code, 401, 'compte rendu pour un autre appel');
r = res(); await aiInboundReport({ headers: { authorization: `Bearer ${K.signCallToken({ companyId: A, callSid: SID, maxCallSeconds: 480 })}` }, params: { callSid: SID }, body: { endReason: 'agent_end' } }, r);
assert.equal(r.code, 200); assert.equal(r.body.data.status, 'completed');
{
  const twilio = (await import('twilio')).default;
  const url = `https://orch.test/api/phone-numbers/webhooks/twilio/ai-inbound/after-stream?s=${encodeURIComponent(afterState())}`;
  const params = { CallSid: SID };
  const reqAfter = (sig) => ({ query: { s: afterState() }, body: params, originalUrl: url.replace('https://orch.test', ''), headers: sig ? { 'x-twilio-signature': sig } : {}, get: () => 'orch.test' });
  r = res(); await aiInboundAfterStream(reqAfter(twilio.getExpectedTwilioSignature('x', url, params)), r);
  assert.match(r.body, /<Response><Hangup\/><\/Response>/, 'signature valide : fin normale');
  r = res(); await aiInboundAfterStream(reqAfter('faux'), r);
  assert.match(r.body, /<Record /, 'signature invalide : flux classique');
  const { twilioRequestValid } = await import('../services/twilioSignature.js');
  assert.equal(twilioRequestValid(reqAfter(twilio.getExpectedTwilioSignature('x', url, params)), { env: {} }), false, 'sans PUBLIC_API_BASE_URL : jamais authentique');
  assert.equal(twilioRequestValid({ ...reqAfter(twilio.getExpectedTwilioSignature('x', url, params)), body: { CallSid: SID_B } }, { env }), false, 'paramètre modifié');
}

// Titulaire seulement (service d'inscription simulé).
const userTok = (id) => jwt.sign({ userId: id }, 't', { expiresIn: 3600 });
let who = { owner1: { companyId: A, isOwner: true }, member1: { companyId: A, isOwner: false } };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => { const id = new URL(url).searchParams.get('userId'); return { ok: true, json: async () => ({ data: who[id] || {} }) }; };
const asUser = (id, extra) => ({ user: { userId: id }, headers: { authorization: `Bearer ${userTok(id)}` }, ...extra });
clearCompanyCache?.();
reset();
r = res(); await ctl.getSettings(asUser('member1', { query: { companyId: A } }), r); assert.equal(r.code, 403, 'membre : pas les réglages');
r = res(); await ctl.getSettings(asUser('owner1', { query: { companyId: B } }), r); assert.equal(r.code, 403, 'autre entreprise');
r = res(); await ctl.getSettings(asUser('owner1', { query: { companyId: A } }), r);
assert.equal(r.code, 200); assert.equal(r.body.data.availability.available, true); assert.equal(r.body.data.engines.primary, 'gemini'); assert.equal(r.body.data.engines.fallback, 'openai');
assert.match(r.body.data.announcement['fr-FR'], /intelligence artificielle/);
r = res(); await ctl.putSettings(asUser('owner1', { body: { companyId: A, triggers: { allBusy: true } } }), r); assert.equal(r.code, 200); assert.equal(r.body.data.settings.triggers.allBusy, true);
r = res(); await ctl.putSettings(asUser('owner1', { body: { companyId: A, maxCallMinutes: 20 } }), r); assert.equal(r.code, 400); assert.equal(r.body.code, 'AI_SETTINGS_INVALID'); assert.equal(r.body.issues[0].field, 'maxCallMinutes');
r = res(); await ctl.putSettings(asUser('owner1', { body: { companyId: A, transferTargets: [E2] } }), r); assert.equal(r.body.code, 'TRANSFER_TARGET_UNKNOWN');
AI.setAiInboundDeps({ gigBelongsTo: async (c, g) => S2(c) === A && g === '64b0000000000000000000aa' });
r = res(); await ctl.putSettings(asUser('owner1', { body: { companyId: A, knowledgeBase: { gigId: '64b0000000000000000000bb' } } }), r); assert.equal(r.code, 400); assert.equal(r.body.issues[0].code, 'invalid_gig', 'base d’une autre entreprise');
r = res(); await ctl.putSettings(asUser('owner1', { body: { companyId: A, knowledgeBase: { gigId: '64b0000000000000000000aa' } } }), r); assert.equal(r.code, 200);
// Nouvelle durée de conservation : appliquée aux fiches existantes et aux éléments « À faire » de l'IA.
const pipelines = [];
AiInboundCall.updateMany = async (f, u) => { pipelines.push(['calls', S2(f.companyId), u]); return {}; };
FollowUpItem.updateMany = async (f, u) => { pipelines.push(['items', S2(f.companyId), f.fromAiAgent, u]); return {}; };
r = res(); await ctl.putSettings(asUser('owner1', { body: { companyId: A, retentionDays: 90 } }), r); assert.equal(r.code, 200);
assert.deepEqual(pipelines.map((p) => p[0]), ['calls', 'items']); assert.equal(pipelines[0][2][0].$set.expiresAt.$add[1], 90 * 86400000); assert.equal(pipelines[1][2], true);
r = res(); await ctl.putSettings(asUser('owner1', { body: { companyId: A, voice: 'male', addressForm: 'tu', maxCallMinutes: 10 } }), r);
assert.equal(r.code, 200); assert.equal(r.body.data.settings.voice, 'male'); assert.equal(r.body.data.settings.addressForm, 'tu'); assert.equal(r.body.data.settings.maxCallMinutes, 10);
r = res(); await ctl.putSettings(asUser('owner1', { body: { companyId: A, enabled: true, businessHours: { slots: [] } } }), r); assert.equal(r.body.code, 'AI_BUSINESS_HOURS_REQUIRED');
env.AI_INBOUND_ENABLED = 'false';
r = res(); await ctl.putSettings(asUser('owner1', { body: { companyId: A, enabled: true } }), r); assert.equal(r.code, 409); assert.equal(r.body.code, 'AI_AGENT_NOT_AVAILABLE');
env.AI_INBOUND_ENABLED = 'true';
r = res(); await ctl.putSettings(asUser('member1', { body: { companyId: A, enabled: false } }), r); assert.equal(r.code, 403);
// Fiches : visibles par l'entreprise (membre compris), jamais d'une autre entreprise.
reset(); await route();
r = res(); await ctl.listCalls(asUser('member1', { query: { companyId: A } }), r); assert.equal(r.code, 200); assert.equal(r.body.data.calls.length, 1);
const idA = r.body.data.calls[0].id;
r = res(); await ctl.getCall(asUser('member1', { query: { companyId: A }, params: { id: idA } }), r); assert.equal(r.code, 200);
assert.equal(r.body.data.latency.targetMs, 800); assert.equal(r.body.data.latency.ceilingMs, 1200); assert.equal(r.body.data.bench.recordingSid, undefined);
store.calls.push({ _id: '64b00000000000000000bbbb', companyId: B, callSid: SID_B, actions: [], timeline: [] });
r = res(); await ctl.getCall(asUser('owner1', { query: { companyId: A }, params: { id: '64b00000000000000000bbbb' } }), r); assert.equal(r.code, 404, 'fiche de B introuvable depuis A');
r = res(); await ctl.getUsage(asUser('owner1', { query: { companyId: A } }), r); assert.equal(r.body.data.includedMinutes, 200); assert.equal(r.body.data.billingEnabled, false);
r = res(); await ctl.getUsage(asUser('member1', { query: { companyId: A } }), r); assert.equal(r.code, 403);
// Banc d'écoute : enregistrement expiré supprimé chez Twilio, jamais servi.
const removed = [];
AI.setAiInboundDeps({ twilio: async () => ({ recordings: (sid) => ({ remove: async () => { removed.push(sid); } }) }) });
store.calls.push({ _id: '64b00000000000000000cccc', companyId: A, callSid: 'CAx', bench: { recorded: true, recordingSid: 'REold', expiresAt: new Date(NOW - 1000) }, actions: [], timeline: [] });
assert.equal(await AI.purgeExpiredBenchRecordings(), 1, 'purge planifiée (toutes entreprises)');
assert.deepEqual(removed, ['REold']);
r = res(); await ctl.listBench(asUser('owner1', { query: { companyId: A } }), r);
assert.equal(r.code, 200); assert.equal(r.body.data.items.length, 0);
globalThis.fetch = realFetch;

Object.assign(console, quiet);
console.log('aiAgentPilot.test.js : OK');

// ================================================================ appels simultanés (maxConcurrentCalls) : lignes facturables, titulaire seulement
{
  const { capacityView, validateMaxConcurrentCalls } = await import('../services/lineCapacity.js');
  const { capacityOf, liveCallCount, hasFreeLine } = await import('../services/lineCalls.js');
  const { lineCapacityController: lc, lineCapacityDeps } = await import('../controllers/lineCapacityController.js');
  const { PhoneNumber } = await import('../models/PhoneNumber.js');
  assert.equal(capacityOf({}), 1); assert.equal(capacityOf({ maxConcurrentCalls: 3 }), 3); assert.equal(capacityOf({ maxConcurrentCalls: 0 }), 1);
  const fut = new Date(Date.now() + 60000);
  assert.equal(liveCallCount({ activeCall: { callSid: 'a', expiresAt: fut }, activeCall2: { callSid: 'b', expiresAt: new Date(0) } }), 1);
  assert.equal(hasFreeLine([{ activeCall: { callSid: 'a', expiresAt: fut } }]), false, 'capacité 1 : inchangé');
  assert.equal(hasFreeLine([{ maxConcurrentCalls: 2, activeCall: { callSid: 'a', expiresAt: fut } }]), true);
  assert.equal(validateMaxConcurrentCalls(0).ok, false); assert.equal(validateMaxConcurrentCalls(1.5).ok, false); assert.equal(validateMaxConcurrentCalls(11).ok, false);
  const cv = capacityView([{ _id: 'l1', phoneNumber: '+331', maxConcurrentCalls: 3 }, { _id: 'l2', phoneNumber: '+332' }], { env: {} });
  assert.deepEqual([cv.billableLines, cv.unitPriceTtcCents, cv.monthlyCostTtcCents, cv.billingEnabled], [2, 1499, 2998, false]);
  assert.deepEqual(cv.lines.map((l) => l.billableLines), [2, 0]);
  const L1 = '64b0000000000000000001a1'; const LB = '64b0000000000000000001b1';
  const phones = [{ _id: L1, companyId: A, phoneNumber: '+33140000000', status: 'active' }, { _id: LB, companyId: B, phoneNumber: '+33150000000', status: 'active' }];
  PhoneNumber.find = (f) => q(phones.filter((p) => S2(p.companyId) === S2(f.companyId)));
  PhoneNumber.updateOne = async (f, u) => { const p = phones.find((x) => S2(x._id) === S2(f._id) && S2(x.companyId) === S2(f.companyId)); if (!p) return { matchedCount: 0 }; Object.assign(p, u.$set); return { matchedCount: 1 }; };
  lineCapacityDeps.enforced = async () => true;
  globalThis.fetch = async (url) => { const id = new URL(url).searchParams.get('userId'); return { ok: true, json: async () => ({ data: who[id] || {} }) }; };
  r = res(); await lc.put(asUser('member1', { body: { companyId: A, lineId: L1, maxConcurrentCalls: 2 } }), r); assert.equal(r.code, 403, 'membre : refus');
  r = res(); await lc.put(asUser('owner1', { body: { companyId: A, lineId: L1, maxConcurrentCalls: 0 } }), r); assert.equal(r.body.code, 'LINE_CAPACITY_INVALID');
  r = res(); await lc.put(asUser('owner1', { body: { companyId: A, lineId: LB, maxConcurrentCalls: 2 } }), r); assert.equal(r.code, 404, 'ligne d’une autre entreprise');
  assert.equal(phones[1].maxConcurrentCalls, undefined);
  r = res(); await lc.put(asUser('owner1', { body: { companyId: A, lineId: L1, maxConcurrentCalls: 2 } }), r);
  assert.equal(r.code, 200); assert.equal(r.body.data.billableLines, 1); assert.equal(r.body.data.monthlyCostTtcCents, 1499); assert.equal(r.body.data.enforced, true);
  r = res(); await lc.get(asUser('member1', { query: { companyId: A } }), r); assert.equal(r.code, 200); assert.equal(r.body.data.lines[0].maxConcurrentCalls, 2);
  globalThis.fetch = realFetch;
}
console.log('aiAgentPilot.test.js (appels simultanés) : OK');
