// Run: JWT_SECRET=test node src/tests/secretariat.test.js
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
for (const k of ['BREVO_API_KEY', 'BREVO_SENDER_EMAIL', 'BREVO_FROM_EMAIL', 'SMTP_FROM_EMAIL']) delete process.env[k];
// Les e-mails ne partent que de la messagerie connectée du centre (réseau SIMULÉ : aucun appel réel).
process.env.INTEGRATIONS_ENC_KEY = 'ab'.repeat(32);

const I = await import('../services/ics.js');
const V = await import('../services/visio.js');
const E = await import('../services/emailService.js');
const F = await import('../services/followUps.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');
const { default: FollowUpItem } = await import('../models/FollowUpItem.js');
const { default: EmailLog } = await import('../models/EmailLog.js');
const { default: SecretariatTools } = await import('../models/SecretariatTools.js');
const { default: SecretariatConnection } = await import('../models/SecretariatConnection.js');
const S = await import('../services/secretariatConnections.js');
const { encryptJson, loadKey } = await import('../integrations/crypto.js');
const { emailController: mail } = await import('../controllers/emailController.js');
const { followUpController: fu } = await import('../controllers/followUpController.js');

// ---------- ICS (RFC 5545)
const base = { id: '64b0000000000000000000a1', title: 'Rendez-vous avec Mme Durand', dueAt: '2026-11-03T09:00:00Z', durationMinutes: 45, status: 'todo', sequence: 0, updatedAt: '2026-11-02T10:00:00Z' };
assert.equal(I.escapeText('a,b;c\\d\ne'), 'a\\,b\;c\\\\d\\ne', 'échappement , ; \\ et retour à la ligne');
assert.equal(I.escapeText('x\r\ny'), 'x\\ny');
const long = 'é'.repeat(100);
const folded = I.foldLine(`SUMMARY:${long}`);
for (const l of folded.split('\r\n')) assert.ok(Buffer.byteLength(l, 'utf8') <= 75, 'ligne repliée à 75 octets');
assert.equal(folded.split('\r\n').map((l, i) => (i ? l.slice(1) : l)).join(''), `SUMMARY:${long}`, 'le repli ne perd ni ne coupe aucun caractère');
assert.ok(!folded.includes('�'));
assert.equal(I.foldLine('SHORT:x'), 'SHORT:x');

let ics = I.buildAppointmentIcs(base);
assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n') && ics.endsWith('END:VCALENDAR\r\n'));
assert.ok(!/[^\r]\n/.test(ics), 'toutes les fins de ligne sont CRLF');
assert.match(ics, /UID:64b0000000000000000000a1@harx\.ai\r\n/);
assert.ok(!/TZID|VTIMEZONE|RRULE/.test(ics), 'aucun fuseau nommé : horaires en UTC');
assert.match(ics, /DTSTART:20261103T090000Z\r\n/, 'novembre : 10:00 à Paris (heure d’hiver) = 09:00 UTC');
assert.match(ics, /DTEND:20261103T094500Z\r\n/);
assert.match(ics, /DTSTAMP:20261102T100000Z\r\n/);
assert.match(ics, /STATUS:CONFIRMED/);
assert.equal(I.buildAppointmentIcs(base), ics, 'sortie déterministe, UID stable');
assert.match(I.buildAppointmentIcs({ ...base, dueAt: '2026-07-14T08:00:00Z' }), /DTSTART:20260714T080000Z/, 'été : 10:00 à Paris = 08:00 UTC');
// rendez-vous 10:30 heure locale : même fichier quel que soit le fuseau, seuls les instants comptent
const at = (iso, tz) => ({ ...base, dueAt: iso, durationMinutes: 60, timeZone: tz });
const startEnd = (x) => [x.match(/DTSTART:(\S+)\r\n/)[1], x.match(/DTEND:(\S+)\r\n/)[1]];
assert.deepEqual(startEnd(I.buildAppointmentIcs(at('2026-11-03T09:30:00Z', 'Europe/Paris'))), ['20261103T093000Z', '20261103T103000Z'], 'Paris hiver 10:30 = 09:30 UTC');
assert.deepEqual(startEnd(I.buildAppointmentIcs(at('2026-07-14T08:30:00Z', 'Europe/Paris'))), ['20260714T083000Z', '20260714T093000Z'], 'Paris été 10:30 = 08:30 UTC');
assert.deepEqual(startEnd(I.buildAppointmentIcs(at('2026-11-03T15:30:00Z', 'America/New_York'))), ['20261103T153000Z', '20261103T163000Z'], 'New York hiver (UTC-5) 10:30 = 15:30 UTC');
assert.deepEqual(startEnd(I.buildAppointmentIcs(at('2026-07-14T14:30:00Z', 'America/New_York'))), ['20260714T143000Z', '20260714T153000Z'], 'New York été (UTC-4) 10:30 = 14:30 UTC');
assert.deepEqual(startEnd(I.buildAppointmentIcs(at('2026-11-03T01:30:00Z', 'Asia/Tokyo'))), ['20261103T013000Z', '20261103T023000Z'], 'Tokyo (UTC+9) 10:30 = 01:30 UTC');
assert.ok(!/TZID|VTIMEZONE/.test(I.buildAppointmentIcs(at('2026-11-03T01:30:00Z', 'Asia/Tokyo'))));
// rétrocompatibilité : un élément sans timeZone donne exactement le même fichier qu'avec timeZone null
assert.equal(I.buildAppointmentIcs({ ...base, timeZone: null }), I.buildAppointmentIcs(base));
// bascule d'heure d'été : 25 octobre 2026, 00:30 UTC = 02:30 CEST ; la fin traverse le changement d'heure
assert.match(I.buildAppointmentIcs({ ...base, dueAt: '2026-10-25T00:30:00Z', durationMinutes: 120 }), /DTSTART:20261025T003000Z[\s\S]*DTEND:20261025T023000Z/, 'deux heures réelles à travers la bascule (instants UTC)');
assert.equal(I.icsFilename(base), 'rendez-vous-20261103-1000.ics', 'sans fuseau : Paris, comme avant');
assert.equal(I.icsFilename({ ...base, timeZone: 'Asia/Tokyo' }), 'rendez-vous-20261103-1800.ics', 'nom de fichier à l’heure du fuseau du rendez-vous');
const rich = I.buildAppointmentIcs({ ...base, title: 'Point; budget, Q4', contactName: 'Mme Durand', note: 'ligne 1\nligne 2', videoUrl: 'https://meet.jit.si/HARX-abcDEF123456', sequence: 3, status: 'canceled', assignee: { name: 'Marie' } });
assert.match(rich, /SUMMARY:Point\; budget\\, Q4\r\n/);
assert.match(rich, /URL:https:\/\/meet\.jit\.si\/HARX-abcDEF123456\r\n/);
assert.match(rich, /SEQUENCE:3\r\n/);
assert.match(rich, /STATUS:CANCELLED/);
assert.ok(!rich.includes('VALARM'), 'pas de rappel pour un rendez-vous annulé');
assert.ok(rich.replace(/\r\n /g, '').includes('Visio : https://meet.jit.si/HARX-abcDEF123456\\n'), 'visio dans la description');
assert.throws(() => I.buildAppointmentIcs({ ...base, dueAt: null }), /sans date/);
const withPlace = I.buildAppointmentIcs({ ...base, location: '12 rue de la Paix, Paris', videoUrl: 'https://meet.jit.si/HARX-abcDEF123456' });
assert.match(withPlace, /LOCATION:12 rue de la Paix\\, Paris\r\n/, 'le lieu prime sur le lien de visio');
assert.ok(withPlace.replace(/\r\n /g, '').includes('Lieu : 12 rue de la Paix'), 'lieu dans la description');
assert.match(withPlace, /URL:https:\/\/meet\.jit\.si/, 'le lien de visio reste dans URL');
// aucune injection de ligne depuis un titre malveillant
const evil = I.buildAppointmentIcs({ ...base, title: 'x\r\nATTENDEE:mailto:pirate@x.fr' });
assert.ok(!/\r\nATTENDEE:/.test(evil), 'un retour à la ligne dans le titre ne crée pas de propriété');

// ---------- visio Jitsi
const url = V.newVisioUrl();
assert.match(url, /^https:\/\/meet\.jit\.si\/HARX-[A-Za-z0-9]{12}$/);
assert.ok(V.isVisioUrl(url));
assert.equal(new Set(Array.from({ length: 500 }, () => V.newVisioUrl())).size, 500, 'salles toutes différentes');
assert.ok(!V.isVisioUrl('https://meet.jit.si/HARX-short') && !V.isVisioUrl('https://evil.test/HARX-abcDEF123456') && !V.isVisioUrl('http://meet.jit.si/HARX-abcDEF123456'));
// octets >= 248 écartés (équiprobabilité) : une source qui n'en donne que au début doit quand même aboutir
let calls = 0;
const stub = (n) => { calls += 1; return calls === 1 ? Buffer.alloc(n, 255) : Buffer.alloc(n, 3); };
assert.equal(V.newVisioUrl(stub), 'https://meet.jit.si/HARX-DDDDDDDDDDDD');

// ---------- validation d'e-mail
for (const ok of ['a@b.fr', 'prenom.nom+tag@sous.domaine.com', 'x_y@ex-ample.co']) assert.ok(E.isValidEmail(ok), ok);
for (const no of ['', 'a@b', 'a@@b.fr', 'a b@c.fr', 'a@b.fr\r\nBcc: x@y.fr', '.a@b.fr', 'a..b@c.fr', '<a@b.fr>', 'a@-b.fr', 'a@b.fr,c@d.fr', 'x'.repeat(250) + '@b.fr']) assert.equal(E.isValidEmail(no), false, JSON.stringify(no));
assert.deepEqual(E.parseRecipients(' A@B.fr ; a@b.fr, c@d.fr ').value, ['a@b.fr', 'c@d.fr'], 'minuscules, dédoublonné');
assert.match(E.parseRecipients('').error, /au moins/);
assert.match(E.parseRecipients('ok@x.fr, pasmail').error, /invalide : pasmail/);
assert.match(E.parseRecipients(Array.from({ length: 6 }, (_, i) => `u${i}@x.fr`)).error, /Cinq/);
const send = (o = {}) => E.validateSend({ to: 'a@b.fr', subject: 'Objet', body: 'Bonjour', ...o });
assert.deepEqual(send().value.to, ['a@b.fr']);
assert.match(send({ subject: 'a\nBcc: x@y.fr' }).error, /une seule ligne/);
assert.match(send({ subject: ' ' }).error, /objet/);
assert.match(send({ body: 'x'.repeat(5001) }).error, /5000/);
assert.match(send({ template: 'inconnu' }).error, /Modèle/);
for (const t of ['callback_confirmation', 'appointment_confirmation', 'appointment_cancellation', 'free']) assert.equal(send({ template: t }).value?.template, t, `modèle ${t} accepté (ceux proposés par l’application)`);
assert.match(send({ followUpId: 'zz' }).error, /invalide/);
assert.match(send({ attachIcs: true }).error, /rendez-vous/);
assert.equal(send({ followUpId: '64b0000000000000000000a1', attachIcs: true }).value.attachIcs, true);
assert.equal(E.cleanDisplayName('Centre "Acme" <x@y>\r\nBcc: z'), 'Centre Acme x y Bcc: z');
assert.equal(E.cleanDisplayName('', 'HARX'), 'HARX');

// ---------- charge utile : expéditeur au nom du centre, réponse = utilisateur, HTML échappé
const payload = E.buildPayload({ senderEmail: 'noreply@harx.ai', centerName: 'Centre Acme', replyTo: { email: 'chef@acme.fr', name: 'Chef' }, to: ['c@d.fr'], subject: 'S', text: 'Bonjour <b>x</b>\nVisio : https://meet.jit.si/HARX-abcDEF123456.', icsContent: ics });
assert.deepEqual(payload.sender, { name: 'Centre Acme', email: 'noreply@harx.ai' });
assert.deepEqual(payload.replyTo, { email: 'chef@acme.fr', name: 'Chef' });
assert.ok(payload.htmlContent.includes('&lt;b&gt;x&lt;/b&gt;') && !payload.htmlContent.includes('<b>x'), 'HTML échappé');
assert.ok(payload.htmlContent.includes('<a href="https://meet.jit.si/HARX-abcDEF123456">'), 'lien cliquable sans le point final');
assert.equal(payload.attachment[0].name, 'rendez-vous.ics');
assert.equal(Buffer.from(payload.attachment[0].content, 'base64').toString('utf8'), ics);
assert.equal(E.buildPayload({ senderEmail: 'a@b.fr', centerName: 'X', replyTo: { email: 'r@x.fr', name: '' }, to: ['c@d.fr'], subject: 'S', text: 't' }).attachment, undefined);

// ---------- limitation de débit par centre
const lim = E.limits({});
assert.deepEqual(lim, { perHour: 30, perDay: 200 });
assert.deepEqual(E.limits({ EMAIL_MAX_PER_HOUR: '5', EMAIL_MAX_PER_DAY: 'x' }), { perHour: 5, perDay: 200 });
assert.equal(E.checkRate({ hour: 29, day: 29 }, lim).ok, true);
assert.match(E.checkRate({ hour: 30, day: 30 }, lim).message, /par heure/);
assert.match(E.checkRate({ hour: 3, day: 200 }, lim).message, /par jour/);

// ---------- éléments de suivi : visio, durée, adresse
const NOW = Date.parse('2026-11-02T10:00:00Z');
const OWNER = { userId: 'owner1', role: 'owner', permissions: {} };
const c = F.validateCreate({ model: 'appointment', contactName: 'Mme Durand', dueAt: '2026-11-03T09:00:00Z', videoLink: true, contactEmail: ' Mme@Durand.FR ' }, OWNER, NOW).value;
assert.equal(c.videoLink, true); assert.equal(c.contactEmail, 'mme@durand.fr');
assert.equal(F.validateCreate({ model: 'transfer', assigneeId: 'u2', videoLink: true }, OWNER, NOW).value.videoLink, false, 'pas de visio hors rendez-vous');
assert.match(F.validateCreate({ model: 'appointment', contactName: 'A', dueAt: '2026-11-03T09:00:00Z', contactEmail: 'pasmail' }, OWNER, NOW).error, /e-mail/);
const appt = { model: 'appointment', status: 'todo' };
assert.equal(F.validatePatch({ durationMinutes: 60 }, appt, NOW).value.durationMinutes, 60);
assert.match(F.validatePatch({ durationMinutes: 2 }, appt, NOW).error, /durée/);
assert.match(F.validatePatch({ durationMinutes: 30 }, { model: 'transfer' }, NOW).error, /rendez-vous/);
assert.equal(F.validatePatch({ videoLink: true }, appt, NOW).value.videoLink, true);
assert.match(F.validatePatch({ videoLink: 'oui' }, appt, NOW).error, /invalide/);
assert.equal(F.validatePatch({ dueAt: '2026-11-04T09:00:00Z' }, appt, NOW).value.dueAt.toISOString(), '2026-11-04T09:00:00.000Z', 'déplacer');
assert.match(F.validatePatch({ dueAt: '2026-11-01T09:00:00Z' }, appt, NOW).error, /futur/);
assert.equal(F.validatePatch({ contactEmail: '' }, appt, NOW).value.contactEmail, '');
assert.ok(!F.allowedPatchFields({ role: 'agent' }).includes('videoLink'));
assert.ok(F.allowedPatchFields({ role: 'owner' }).includes('durationMinutes'));
assert.deepEqual(F.parseListFilters({ model: 'appointment', from: '2026-11-02T00:00:00Z', to: '2026-11-09T00:00:00Z' }).value.dueAt.$lt, new Date('2026-11-09T00:00:00Z'));
assert.match(F.parseListFilters({ model: 'x' }).error, /inconnu/);
assert.match(F.parseListFilters({ from: 'hier' }).error, /Période/);
assert.deepEqual(F.parseListFilters({}).value, {});

// ---------- contrôleurs (base et services externes simulés)
const COMPANY = '64b0000000000000000000c1';
const APPT = '64b0000000000000000000a1';
const tok = jwt.sign({ userId: 'owner1' }, process.env.JWT_SECRET);
let me = { isOwner: true, companyId: COMPANY, permissions: {} };
global.fetch = async (u) => {
  u = String(u);
  if (u.includes('/company-members/me')) return { ok: true, json: async () => ({ data: me }) };
  if (u.includes('/api/users/')) return { ok: true, json: async () => ({ data: { fullName: 'Chef de centre', email: 'Chef@Acme.fr' } }) };
  if (u.includes('/api/company-members?')) return { ok: true, json: async () => ({ data: [{ userId: 'owner1', fullName: 'Chef', isOwner: true }] }) };
  if (u.includes('/call-center/agents')) return { ok: true, json: async () => ({ data: [] }) };
  throw new Error(`fetch inattendu ${u}`);
};
// Réglages « Outils » du centre : aucun réglage enregistré ici (comportement historique) ; voir secretariatTools.test.js pour le reste.
let toolsDoc = null; // réglages du centre simulés (null = jamais enregistrés)
SecretariatTools.findOne = () => ({ select() { return this; }, lean: async () => toolsDoc });
const logs = [];
EmailLog.create = async (d) => { const r = { _id: `l${logs.length + 1}`, createdAt: new Date(), ...d }; logs.push(r); return r; };
EmailLog.countDocuments = async (f) => logs.filter((l) => String(l.companyId) === String(f.companyId) && l.createdAt >= f.createdAt.$gte).length;
EmailLog.find = (f) => ({ sort() { return this; }, limit() { return this; }, lean: async () => logs.filter((l) => (!f.sentById || l.sentById === f.sentById) && (!f.followUpId || String(l.followUpId) === String(f.followUpId))).reverse() });
const apptDoc = { _id: APPT, model: 'appointment', title: 'Rendez-vous avec Mme Durand', contactName: 'Mme Durand', dueAt: new Date('2026-11-03T09:00:00Z'), durationMinutes: 30, status: 'todo', assigneeId: 'owner1', assigneeName: 'Chef', videoUrl: 'https://meet.jit.si/HARX-abcDEF123456', sequence: 2, createdAt: new Date('2026-11-01T10:00:00Z'), updatedAt: new Date('2026-11-02T10:00:00Z'), transfers: [] };
apptDoc.toObject = () => ({ ...apptDoc });
apptDoc.save = async () => apptDoc;
FollowUpItem.findOne = async (f) => (String(f._id) === APPT && String(f.companyId) === COMPANY ? apptDoc : null);

async function call(fn, { user = 'owner1', body = {}, params = {}, query = {} } = {}) {
  clearCompanyCache();
  return new Promise((resolve) => {
    const headers = {};
    const res = {
      code: 200, headers, status(x) { this.code = x; return this; },
      setHeader(k, v) { headers[k] = v; },
      json(b) { resolve({ code: this.code, body: b, headers }); return this; },
      send(b) { resolve({ code: this.code, text: b, headers }); return this; },
    };
    fn({ user: { userId: user }, headers: { authorization: `Bearer ${tok}` }, body, params, query, method: 'POST', originalUrl: '/x' }, res);
  });
}

// ---------- messagerie connectée : les e-mails ne partent JAMAIS de HARX (Brevo n'est plus jamais appelé)
const brevo = [];
E.setMailTransport(async (p) => { brevo.push(p); return { messageId: 'sim' }; });
const conns = [];
const chain = (v) => ({ select() { return this; }, lean: async () => (v ? JSON.parse(JSON.stringify(v)) : null), then(res, rej) { return this.lean().then(res, rej); } });
const matches = (d, f) => Object.entries(f).every(([k, x]) => (x && typeof x === 'object' && '$in' in x ? x.$in.includes(d[k]) : String(d[k]) === String(x)));
SecretariatConnection.find = (f) => ({ select() { return this; }, lean: async () => JSON.parse(JSON.stringify(conns.filter((d) => matches(d, f)))) });
SecretariatConnection.findOne = (f) => chain(conns.find((d) => matches(d, f)));
SecretariatConnection.updateOne = async () => ({});
const connect = (provider, over = {}) => {
  const i = conns.findIndex((c) => c.provider === provider); if (i >= 0) conns.splice(i, 1);
  conns.push({ companyId: COMPANY, provider, accountEmail: provider === 'google' ? 'centre@gmail.test' : 'centre@contoso.test', status: 'connected',
    credentialsEnc: encryptJson({ accessToken: 'ACCESS_SECRET', refreshToken: 'REFRESH_SECRET', expiresAt: Date.now() + 3600_000 }, { context: `secretariat:${COMPANY}:${provider}`, key: loadKey() }), ...over });
};
let providerStatus = 200;
const net = [];
S.setConnectionsHttp(async (rq) => {
  net.push(rq);
  if (/gmail\.googleapis\.com.*messages\/send/.test(rq.url)) return { status: providerStatus, json: providerStatus === 200 ? { id: 'm1' } : null, headers: {} };
  if (/graph\.microsoft\.com.*\/me\/sendMail/.test(rq.url)) return { status: providerStatus === 200 ? 202 : providerStatus, json: null, headers: {} };
  return { status: 599, json: null, headers: {} };
});
const gmailSent = () => net.filter((x) => /messages\/send/.test(x.url));
const mimeOf = (x) => Buffer.from(x.body.raw, 'base64url').toString('utf8');
const blocks = (mime) => [...mime.matchAll(/\r\n\r\n([A-Za-z0-9+/=\r\n]+?)(?=\r\n--|\r\n$)/g)].map((m) => Buffer.from(m[1].replace(/\r\n/g, ''), 'base64').toString('utf8'));
const sentCount = () => gmailSent().length;
const msg = { companyId: COMPANY, to: 'client@exemple.fr', subject: 'Votre rendez-vous', body: 'Bonjour', template: 'appointment_confirmation', followUpId: APPT, attachIcs: true, centerName: 'Centre Acme' };

// aucune messagerie connectée : 409 mailbox_not_connected, aucun envoi, rien journalisé
let r = await call(mail.send, { body: msg });
assert.equal(r.code, 409); assert.equal(r.body.success, false); assert.equal(r.body.code, 'mailbox_not_connected'); assert.equal(r.body.error, 'mailbox_not_connected');
assert.equal(r.body.message, 'Connectez votre messagerie (Gmail ou Outlook) dans Paramétrage > Outils pour envoyer des e-mails.');
assert.equal(net.length, 0, 'aucun appel réseau'); assert.equal(logs.length, 0, 'rien n’est journalisé'); assert.equal(brevo.length, 0);
r = await call(mail.config);
assert.deepEqual([r.body.data.configured, r.body.data.provider, r.body.data.account], [false, null, null]);
// Brevo configuré ne change rien : la plateforme n'envoie jamais ces e-mails
process.env.BREVO_API_KEY = 'cle-de-test'; process.env.BREVO_SENDER_EMAIL = 'noreply@harx.ai';
r = await call(mail.send, { body: msg }); assert.equal(r.code, 409); assert.equal(r.body.code, 'mailbox_not_connected');
assert.equal((await call(mail.config)).body.data.configured, false, '`configured` ne dépend plus de Brevo');

// une seule messagerie connectée (réglages vides) : elle sert
connect('google');
r = await call(mail.config);
assert.deepEqual([r.body.data.configured, r.body.data.provider, r.body.data.account], [true, 'google', 'centre@gmail.test']);
assert.equal(r.body.data.remainingThisHour, 30); assert.equal(r.body.data.limits.perDay, 200);
r = await call(mail.send, { body: { ...msg, to: 'pasunmail' } });
assert.equal(r.code, 400); assert.equal(sentCount(), 0);
r = await call(mail.send, { body: { ...msg, followUpId: '64b0000000000000000000ff' } });
assert.equal(r.code, 404, 'élément d’origine inconnu');
r = await call(mail.send, { body: msg });
assert.equal(r.code, 201, JSON.stringify(r.body));
assert.equal(sentCount(), 1); assert.equal(brevo.length, 0, 'plus aucun appel Brevo');
const m1 = mimeOf(gmailSent()[0]);
assert.match(m1, /\r\nFrom: "Centre Acme" <centre@gmail\.test>\r\n/, 'From = compte connecté');
assert.match(m1, /\r\nReply-To: "Centre Acme" <centre@gmail\.test>\r\n/, 'Reply-To = la boîte connectée elle-même');
assert.equal(gmailSent()[0].headers.Authorization, 'Bearer ACCESS_SECRET');
assert.match(blocks(m1).join('\n'), /UID:64b0000000000000000000a1@harx\.ai/);
assert.match(blocks(m1).join('\n'), /SEQUENCE:2/);
const entry = logs[0];
assert.deepEqual([entry.status, entry.sentById, entry.sentByName, entry.to, entry.subject, entry.template, String(entry.followUpId), entry.withIcs], ['sent', 'owner1', 'Chef de centre', ['client@exemple.fr'], 'Votre rendez-vous', 'appointment_confirmation', APPT, true]);
assert.ok(!JSON.stringify(entry).includes('Bonjour'), 'le contenu du message n’est pas journalisé');
r = await call(mail.list, { query: { followUpId: APPT } });
assert.equal(r.body.data.items.length, 1); assert.equal(r.body.data.items[0].followUpId, APPT);
assert.equal(r.body.data.items[0].body, undefined);

// deux messageries connectées : le choix des réglages décide ; sans choix, refus (ambigu)
connect('microsoft');
const small = { ...msg, attachIcs: false, followUpId: undefined };
r = await call(mail.send, { body: small }); assert.equal(r.code, 409); assert.equal(r.body.code, 'mailbox_not_connected', 'deux messageries sans choix : on ne devine pas');
r = await call(mail.config); assert.deepEqual([r.body.data.configured, r.body.data.provider, r.body.data.account], [false, null, null]);
toolsDoc = { companyId: COMPANY, email: { provider: 'microsoft', fromName: 'IGNORÉ', replyTo: 'ignore@exemple.fr', signature: 'Cordialement' } };
const g0 = sentCount();
r = await call(mail.send, { body: small }); assert.equal(r.code, 201, JSON.stringify(r.body));
const graph = net.filter((x) => /me\/sendMail/.test(x.url)); assert.equal(graph.length, 1, 'envoyé par Outlook'); assert.equal(sentCount(), g0, 'pas par Gmail');
assert.deepEqual(graph[0].body.message.replyTo, [{ emailAddress: { address: 'centre@contoso.test', name: 'Centre Acme' } }], 'Reply-To = boîte connectée ; email.replyTo ignoré');
assert.ok(!('from' in graph[0].body.message)); assert.ok(!JSON.stringify(graph[0].body).includes('IGNORÉ') && !JSON.stringify(graph[0].body).includes('ignore@exemple.fr'));
assert.ok(graph[0].body.message.body.content.includes('Cordialement'), 'la signature des réglages est ajoutée');
r = await call(mail.config); assert.deepEqual([r.body.data.configured, r.body.data.provider, r.body.data.account], [true, 'microsoft', 'centre@contoso.test']);
toolsDoc = { companyId: COMPANY, email: { provider: 'google' } };
r = await call(mail.send, { body: small }); assert.equal(r.code, 201); assert.equal(sentCount(), g0 + 1, 'choix des réglages : Gmail');
// choix d'une messagerie qui n'est plus active, une seule autre active : elle sert
conns.splice(conns.findIndex((c) => c.provider === 'google'), 1);
r = await call(mail.send, { body: small }); assert.equal(r.code, 201); assert.equal(net.filter((x) => /me\/sendMail/.test(x.url)).length, 2, 'unique messagerie active');

// connexion à refaire : 409 mailbox_needs_reauth, aucun envoi
const before2 = net.length;
conns.splice(0, conns.length); connect('google', { status: 'needs_reauth' });
toolsDoc = { companyId: COMPANY, email: { provider: 'google' } };
r = await call(mail.send, { body: small });
assert.equal(r.code, 409); assert.equal(r.body.success, false); assert.equal(r.body.code, 'mailbox_needs_reauth'); assert.equal(r.body.error, 'mailbox_needs_reauth');
assert.match(r.body.message, /Google a expiré ou a été révoquée|expiré|révoquée/); assert.match(r.body.message, /Reconnectez-la dans Paramétrage > Outils/);
assert.equal(net.length, before2, 'aucun appel réseau'); assert.equal((await call(mail.config)).body.data.configured, false);
conns.splice(0, conns.length); toolsDoc = null;
connect('google'); // retour à l'état de base pour la suite

// pièce jointe refusée pour un élément qui n'est pas un rendez-vous
const keep = apptDoc.model; apptDoc.model = 'transfer';
r = await call(mail.send, { body: msg });
assert.equal(r.code, 422); apptDoc.model = keep;

// refus du fournisseur : 502, journalisé en échec, sans détail technique, sans repli sur la plateforme
providerStatus = 403;
r = await call(mail.send, { body: { ...msg, attachIcs: false } });
assert.equal(r.code, 502); assert.ok(!/Brevo|SECRET/.test(JSON.stringify(r.body)));
assert.equal(logs.at(-1).status, 'failed'); assert.equal(brevo.length, 0, 'aucun repli sur Brevo');
providerStatus = 200;

// limitation de débit par centre
const already = logs.filter((l) => String(l.companyId) === COMPANY).length;
process.env.EMAIL_MAX_PER_HOUR = String(already + 1);
r = await call(mail.send, { body: { ...msg, attachIcs: false } });
assert.equal(r.code, 201, 'dernier envoi de l’heure accepté');
r = await call(mail.send, { body: { ...msg, attachIcs: false } });
assert.equal(r.code, 429); assert.equal(r.body.error, 'email_rate_limited'); assert.match(r.body.message, new RegExp(`${already + 1} e-mails par heure`));
logs.push({ _id: 'autre', companyId: '64b0000000000000000000d9', createdAt: new Date(), status: 'sent' });
delete process.env.EMAIL_MAX_PER_HOUR;

// droits : un agent n'envoie pas depuis la boîte de la société et ne lit que son propre journal ; un membre sans droit d'appels non plus ; un membre avec, oui
me = { isOwner: false, isAgent: true, companyId: COMPANY, permissions: {} };
const before = sentCount();
r = await call(mail.send, { user: 'agent1', body: msg });
assert.equal(r.code, 403); assert.equal(sentCount(), before);
r = await call(mail.list, { user: 'agent1' });
assert.equal(r.code, 200); assert.deepEqual(r.body.data.items, [], 'une secrétaire ne lit que ses propres envois (aucun ici)');
me = { isOwner: false, isAgent: false, companyId: COMPANY, permissions: { 'calls.view': false } };
r = await call(mail.send, { user: 'm1', body: msg });
assert.equal(r.code, 403);
me = { isOwner: false, isAgent: false, companyId: COMPANY, permissions: { 'calls.view': true } };
r = await call(mail.send, { user: 'm1', body: { ...msg, attachIcs: false } });
assert.equal(r.code, 201, 'un membre avec le droit d’appels peut envoyer');
me = { isOwner: true, companyId: COMPANY, permissions: {} };
r = await call(mail.send, { body: { ...msg, companyId: '64b0000000000000000000d2' } });
assert.equal(r.code, 403, 'autre centre refusé');

assert.equal(brevo.length, 0, 'aucun e-mail du secrétariat n’est jamais parti par la plateforme (Brevo)');

// export .ics : en-têtes, contenu, droits
r = await call(fu.ics, { params: { id: APPT } });
assert.equal(r.code, 200); assert.match(r.headers['Content-Type'], /text\/calendar/); assert.match(r.headers['Content-Disposition'], /rendez-vous-20261103-1000\.ics/);
assert.match(r.text, /BEGIN:VEVENT[\s\S]*END:VEVENT/);
r = await call(fu.ics, { params: { id: '64b0000000000000000000ff' } });
assert.equal(r.code, 404);
me = { isOwner: false, isAgent: true, companyId: COMPANY, permissions: {} };
r = await call(fu.ics, { user: 'agent1', params: { id: APPT } });
assert.equal(r.code, 404, 'un agent ne télécharge pas le rendez-vous d’un autre');
me = { isOwner: true, companyId: COMPANY, permissions: {} };
apptDoc.model = 'transfer';
r = await call(fu.ics, { params: { id: APPT } });
assert.equal(r.code, 422); apptDoc.model = keep;

// création avec visio, déplacement, annulation (la révision monte à chaque changement)
const store = [];
FollowUpItem.create = async (doc) => { const d = { _id: `64b00000000000000000${String(store.length + 1).padStart(4, '0')}`, status: 'todo', sequence: 0, createdAt: new Date(), updatedAt: new Date(), transfers: [], ...doc, save: async () => d, toObject() { const { save, toObject, ...rest } = d; return rest; } }; store.push(d); return d; };
FollowUpItem.exists = async () => false;
const apptBody = { companyId: COMPANY, model: 'appointment', contactName: 'Mme Durand', contactEmail: 'mme@durand.fr', dueAt: new Date(Date.now() + 5 * 86400000).toISOString() };
conns.length = 0;
// HARX ne fournit aucune visio : sans compte Meet / Teams / Zoom connecté, 409 visio_not_connected et rien n'est enregistré
r = await call(fu.create, { body: { ...apptBody, videoLink: true } });
assert.equal(r.code, 409, JSON.stringify(r.body));
assert.deepEqual(r.body, { success: false, code: 'visio_not_connected', error: 'visio_not_connected', message: 'Connectez Google Meet, Microsoft Teams ou Zoom dans Paramétrage > Outils pour créer un lien de visio.' });
assert.equal(store.length, 0, 'aucun rendez-vous enregistré sans visio connectée');
r = await call(fu.create, { body: { ...apptBody, videoLink: false } });
assert.equal(r.code, 201, JSON.stringify(r.body));
assert.equal(r.body.data.videoUrl, '', 'aucun lien Jitsi créé'); assert.equal(r.body.data.contactEmail, 'mme@durand.fr');
const created = store[0];
FollowUpItem.findOne = async (f) => (String(f._id) === String(created._id) ? created : null);
r = await call(fu.patch, { params: { id: created._id }, body: { dueAt: new Date(Date.now() + 6 * 86400000).toISOString(), durationMinutes: 60 } });
assert.equal(r.code, 200); assert.equal(r.body.data.sequence, 1, 'déplacer fait monter la révision'); assert.equal(r.body.data.durationMinutes, 60);
r = await call(fu.patch, { params: { id: created._id }, body: { videoLink: true } });
assert.equal(r.code, 409); assert.equal(r.body.code, 'visio_not_connected'); assert.equal(created.videoUrl, '', 'PATCH : aucun lien Jitsi créé');
// un rendez-vous DÉJÀ enregistré avec un ancien lien Jitsi le garde tel quel
const room = 'https://meet.jit.si/HARX-abcDEF123456';
created.videoUrl = room;
r = await call(fu.patch, { params: { id: created._id }, body: { videoLink: true } });
assert.equal(r.code, 200); assert.equal(created.videoUrl, room, 'l’ancien lien existant est conservé');
r = await call(fu.patch, { params: { id: created._id }, body: { videoLink: false } });
assert.equal(r.body.data.videoUrl, '');
r = await call(fu.patch, { params: { id: created._id }, body: { status: 'canceled' } });
assert.equal(r.body.data.status, 'canceled'); assert.equal(r.body.data.sequence, 4);
assert.match(I.buildAppointmentIcs(r.body.data) , /STATUS:CANCELLED/);

// signature : ajoutée une fois, jamais en double si le message se termine déjà par elle
{
  const { appendSignature } = await import('../services/emailService.js');
  assert.equal(appendSignature('Bonjour', 'Chafik SABIRY\nDIGITAL ASSURANCE'), 'Bonjour\n\nChafik SABIRY\nDIGITAL ASSURANCE');
  const withSig = 'Bonjour,\n\ntest\n\nCordialement,\nChafik SABIRY\nDIGITAL ASSURANCE';
  assert.equal(appendSignature(withSig, 'Chafik SABIRY\nDIGITAL ASSURANCE'), withSig, 'déjà signé : rien n’est ajouté');
  assert.equal(appendSignature(withSig, '  chafik  sabiry digital assurance '), withSig, 'sans tenir compte de la casse ni des espaces');
  assert.equal(appendSignature('Bonjour', ''), 'Bonjour');
  assert.equal(appendSignature('Bonjour', undefined), 'Bonjour');
  assert.equal(appendSignature('Bonjour DIGITAL ASSURANCE merci', 'DIGITAL ASSURANCE'), 'Bonjour DIGITAL ASSURANCE merci\n\nDIGITAL ASSURANCE', 'une simple mention au milieu ne compte pas');
}
// « Annulation de rendez-vous » envoyée par e-mail : le rendez-vous lié est annulé (et retiré de l'agenda connecté) ; jamais un autre élément
{
  const { cancelAppointmentAfterEmail } = await import('../controllers/followUpController.js');
  let saves = 0;
  const appt = { _id: APPT, model: 'appointment', status: 'todo', sequence: 2, companyId: COMPANY, title: 'RDV', dueAt: new Date('2026-11-03T09:00:00Z'), save: async () => { saves += 1; } };
  await cancelAppointmentAfterEmail(appt, { userId: 'owner1' });
  assert.equal(appt.status, 'canceled'); assert.equal(appt.sequence, 3); assert.equal(appt.closedById, 'owner1'); assert.ok(appt.closedAt instanceof Date); assert.ok(saves >= 1);
  const after = saves; await cancelAppointmentAfterEmail(appt, { userId: 'owner1' });
  assert.equal(appt.sequence, 3, 'déjà annulé : rien ne change'); assert.equal(saves, after);
  const other = { _id: APPT, model: 'voicemail_callback', status: 'todo', save: async () => { saves += 1; } };
  await cancelAppointmentAfterEmail(other, { userId: 'owner1' }); assert.equal(other.status, 'todo', 'seul un rendez-vous est annulé');
  await cancelAppointmentAfterEmail(null, { userId: 'owner1' });
}
console.log('secretariat: ok');
