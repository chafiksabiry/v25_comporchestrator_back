// Run: JWT_SECRET=test node src/tests/secretariatTools.test.js
// Outils du secrétariat : identité d'e-mail, visio (jitsi / lien permanent), flux agenda .ics privé. Base et réseau simulés.
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
process.env.BREVO_API_KEY = 'cle-de-test';
process.env.BREVO_SENDER_EMAIL = 'noreply@harx.ai';

const V = await import('../services/visio.js');
const T = await import('../services/secretariatTools.js');
const E = await import('../services/emailService.js');
const { default: SecretariatTools } = await import('../models/SecretariatTools.js');
const { default: FollowUpItem } = await import('../models/FollowUpItem.js');
const { default: EmailLog } = await import('../models/EmailLog.js');
const { secretariatToolsRoutes } = await import('../routes/secretariatTools.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');
const { emailController: mail } = await import('../controllers/emailController.js');
const { followUpController: fu } = await import('../controllers/followUpController.js');

// ---------- lien de visio permanent : validation stricte
for (const ok of ['https://meet.google.com/abc-defg-hij', 'https://us02web.zoom.us/j/123456789?pwd=AbC123', 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0']) {
  assert.deepEqual(V.validateCustomVisioUrl(` ${ok} `), { value: ok }, ok);
}
for (const no of ['', '   ', 'http://meet.google.com/abc', 'ftp://x.fr/a', 'javascript:alert(1)', 'https://', 'https://localhost/x', 'https://127.0.0.1/x', 'https://[::1]/x',
  'https://user:pw@zoom.us/j/1', 'https://zoom.us:8443/j/1', 'https://zoom.us/j/1 2', 'https://zoom.us/j/1\r\nX: y', 'https://zoom.us/<script>', 'https://intranet/x', `https://zoom.us/${'a'.repeat(300)}`, 'https://zoom.us/é', 42, null]) {
  assert.ok(V.validateCustomVisioUrl(no).error, JSON.stringify(no));
}
// seul le lien enregistré pour CETTE entreprise est accepté
const jitsi = V.newVisioUrl();
const mine = 'https://meet.google.com/abc-defg-hij';
assert.ok(V.isVisioUrl(jitsi) && V.isVisioUrl(jitsi, mine));
assert.equal(V.isVisioUrl(mine), false, 'sans lien enregistré, aucun lien libre');
assert.ok(V.isVisioUrl(mine, mine));
assert.equal(V.isVisioUrl('https://meet.google.com/zzz-zzzz-zzz', mine), false, 'le lien d’une autre entreprise est refusé');
assert.equal(V.isVisioUrl('', ''), false);

// ---------- validation des réglages
const ok = (b, cur) => { const r = T.validateToolsPatch(b, cur); assert.equal(r.error, undefined, JSON.stringify([b, r])); return r.set; };
const ko = (b, re, cur) => { const r = T.validateToolsPatch(b, cur); assert.match(r.error || '', re, JSON.stringify(b)); };
assert.deepEqual(ok({ email: { fromName: '  Centre   Acme ', replyTo: ' Contact@Acme.FR ', signature: 'Cordialement\r\nL’équipe' } }),
  { 'email.fromName': 'Centre Acme', 'email.replyTo': 'contact@acme.fr', 'email.signature': 'Cordialement\nL’équipe' });
assert.deepEqual(ok({ email: { replyTo: '' } }), { 'email.replyTo': '' }, 'vider est permis');
ko({}, /Rien à modifier/); ko(null, /Rien à modifier/); ko({ email: 'x' }, /invalides/); ko({ visio: [] }, /invalides/);
ko({ email: { replyTo: 'pasmail' } }, /adresse e-mail valide/);
ko({ email: { replyTo: 'a@b.fr\r\nBcc: x@y.fr' } }, /adresse e-mail valide/);
ko({ email: { fromName: 'x'.repeat(81) } }, /80/);
ko({ email: { fromName: 'Acme <x@y.fr>' } }, /caractères/);
assert.ok(!/[\r\n]/.test(ok({ email: { fromName: 'Acme\r\nBcc: x' } })['email.fromName']), 'aucun retour à la ligne dans le nom');
ko({ email: { signature: 'x'.repeat(501) } }, /500/);
ko({ email: { signature: 'a\u0000b' } }, /non autorisés/);
ko({ email: { fromName: 5 } }, /texte/);
assert.deepEqual(ok({ visio: { provider: 'jitsi' } }), { 'visio.provider': 'jitsi', 'visio.customUrl': '', 'visio.chosen': true });
assert.deepEqual(ok({ visio: { provider: 'custom', customUrl: mine } }), { 'visio.provider': 'custom', 'visio.customUrl': mine, 'visio.chosen': true });
ko({ visio: { provider: 'custom' } }, /Indiquez le lien/);
ko({ visio: { provider: 'zoom' } }, /inconnu/);
ko({ visio: { provider: 'custom', customUrl: 'http://x.fr/a' } }, /https/);
assert.equal(ok({ visio: { provider: 'custom' } }, { visio: { provider: 'jitsi', customUrl: mine } })['visio.customUrl'], mine, 'fusion avec l’existant');
ko({ visio: { customUrl: '' } }, /Indiquez le lien/, { visio: { provider: 'custom', customUrl: mine } });

// ---------- jeton du flux
const tk = T.newFeedToken();
assert.match(tk, /^[A-Za-z0-9_-]{43}$/, '32 octets en base64url');
assert.equal(Buffer.from(tk, 'base64url').length, 32);
assert.notEqual(tk, T.newFeedToken());
assert.ok(T.feedTokenMatches(T.hashFeedToken(tk), tk));
assert.equal(T.feedTokenMatches(T.hashFeedToken(tk), T.newFeedToken()), false);
assert.equal(T.feedTokenMatches(tk, tk), false, 'le jeton en clair n’est pas une empreinte');
assert.equal(T.feedTokenMatches(null, tk), false);
assert.equal(T.feedTokenMatches(T.hashFeedToken('court'), 'court'), false);
assert.equal(T.feedUrlFor('abc', 'https://api.test/api/'), 'https://api.test/api/secretariat/agenda/abc.ics');

// ---------- faux modèles
const C1 = '64b0000000000000000000c1';
const C2 = '64b0000000000000000000c2';
const toolsDocs = [];
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
const chain = (v) => ({ select() { return this; }, lean: async () => (v ? JSON.parse(JSON.stringify(v)) : null), then(r, j) { return this.lean().then(r, j); } });
SecretariatTools.findOne = (f) => chain(toolsDocs.find((d) => Object.entries(f).every(([k, x]) => String(getPath(d, k)) === String(x))));
SecretariatTools.findOneAndUpdate = (f, upd, opts) => {
  let d = toolsDocs.find((x) => String(x.companyId) === String(f.companyId));
  if (!d) { assert.ok(opts.upsert); d = { companyId: String(f.companyId) }; toolsDocs.push(d); }
  for (const [path, val] of Object.entries(upd.$set)) {
    const keys = path.split('.'); const last = keys.pop();
    const holder = keys.reduce((a, k) => (a[k] = a[k] || {}), d);
    holder[last] = val;
  }
  return chain(d);
};
const apptRow = (over = {}) => ({
  _id: '64b0000000000000000000a1', companyId: C1, model: 'appointment', title: 'Rendez-vous Mme Durand', dueAt: new Date(Date.now() + 86400000), durationMinutes: 45, status: 'todo',
  videoUrl: 'https://meet.jit.si/HARX-abcDEF123456', sequence: 1, contactEmail: 'secret.client@exemple.fr', contactPhone: '+33612345678', contactName: 'Mme Durand', note: 'note privée', createdAt: new Date(), updatedAt: new Date(), ...over,
});
let followRows = [];
let lastFollowQuery = null;
FollowUpItem.find = (f) => {
  lastFollowQuery = f;
  let sel = null;
  const c = { sort() { return c; }, limit() { return c; }, select(s) { sel = s.split(' '); return c; },
    lean: async () => followRows.filter((r) => String(r.companyId) === String(f.companyId)).map((r) => (sel ? Object.fromEntries(['_id', ...sel].map((k) => [k, r[k]])) : r)) };
  return c;
};

// ---------- faux service d'inscription + serveur Express
const directory = {
  owner1: { companyId: C1, isOwner: true },
  member1: { companyId: C1, isOwner: false, permissions: { 'calls.view': true } },
  memberNoCalls: { companyId: C1, isOwner: false, permissions: {} },
  agent1: { companyId: C1, isOwner: false, isAgent: true },
  other1: { companyId: C2, isOwner: true },
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('https://registration.test/api/company-members/me')) return { ok: true, json: async () => ({ success: true, data: directory[new URL(u).searchParams.get('userId')] || {} }) };
  if (u.includes('/api/users/')) return { ok: true, json: async () => ({ data: { fullName: 'Chef de centre', email: 'Chef@Acme.fr' } }) };
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, init);
  throw new Error(`fetch inattendu ${u}`);
};
const logged = [];
for (const k of ['log', 'error', 'warn']) { const orig = console[k]; console[k] = (...a) => { logged.push(a.join(' ')); if (k !== 'error' && k !== 'warn') orig(...a); }; }

const app = express();
app.use(express.json());
app.use('/api/secretariat', secretariatToolsRoutes);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/secretariat`;
const sign = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: 60 });
const req = async (method, path, { user, body } = {}) => {
  clearCompanyCache();
  const res = await realFetch(`${base}${path}`, { method, headers: { ...(user ? { Authorization: `Bearer ${sign(user)}` } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* texte */ }
  return { status: res.status, body: json, text, headers: res.headers };
};

try {
  // accès : session obligatoire, centre de l'appelant seulement
  assert.equal((await req('GET', `/tools/${C1}`)).status, 401);
  assert.equal((await req('PUT', `/tools/${C1}`, { body: { email: { fromName: 'X' } } })).status, 401);
  assert.equal((await req('POST', `/tools/${C1}/agenda-feed`)).status, 401);
  assert.equal((await req('GET', `/tools/${C1}`, { user: 'other1' })).status, 403);
  assert.equal((await req('PUT', `/tools/${C1}`, { user: 'other1', body: { email: { fromName: 'X' } } })).status, 403);
  assert.equal((await req('POST', `/tools/${C1}/agenda-feed`, { user: 'other1' })).status, 403);
  assert.equal(toolsDocs.length, 0, 'rien n’est écrit par un refus');
  assert.equal((await req('GET', '/tools/pas-un-id', { user: 'owner1' })).status, 403);

  // lecture : défauts, pour tout membre rattaché
  const defaults = { success: true, data: { email: { fromName: '', replyTo: '', signature: '' }, visio: { provider: 'jitsi', customUrl: '' }, agenda: { feedUrl: null }, configured: { email: false, visio: false, agenda: false } } };
  for (const user of ['owner1', 'member1', 'memberNoCalls', 'agent1']) assert.deepEqual((await req('GET', `/tools/${C1}`, { user })).body, defaults, user);

  // écriture : titulaire / responsable seulement
  for (const user of ['agent1', 'memberNoCalls']) {
    assert.equal((await req('PUT', `/tools/${C1}`, { user, body: { email: { fromName: 'X' } } })).status, 403, user);
    assert.equal((await req('POST', `/tools/${C1}/agenda-feed`, { user })).status, 403, user);
  }
  assert.equal(toolsDocs.length, 0);
  let r = await req('PUT', `/tools/${C1}`, { user: 'owner1', body: { email: { fromName: 'x'.repeat(81) } } });
  assert.equal(r.status, 400); assert.equal(r.body.success, false); assert.match(r.body.error, /80/);
  assert.equal((await req('PUT', `/tools/${C1}`, { user: 'owner1', body: {} })).status, 400);
  assert.equal((await req('PUT', `/tools/${C1}`, { user: 'owner1', body: { visio: { provider: 'custom', customUrl: 'http://x.fr' } } })).status, 400);
  assert.equal(toolsDocs.length, 0, 'une valeur invalide n’écrit rien');

  r = await req('PUT', `/tools/${C1}`, { user: 'owner1', body: { email: { fromName: 'Centre Acme', replyTo: 'Contact@Acme.fr', signature: 'Cordialement,\nL’équipe Acme' } } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.email, { fromName: 'Centre Acme', replyTo: 'contact@acme.fr', signature: 'Cordialement,\nL’équipe Acme' });
  assert.deepEqual(r.body.data.configured, { email: true, visio: false, agenda: false });
  r = await req('PUT', `/tools/${C1}`, { user: 'member1', body: { visio: { provider: 'custom', customUrl: mine } } });
  assert.equal(r.status, 200, 'membre avec le droit d’appels : écriture permise');
  assert.deepEqual(r.body.data.visio, { provider: 'custom', customUrl: mine });
  assert.equal(r.body.data.email.fromName, 'Centre Acme', 'mise à jour partielle : l’e-mail est conservé');
  assert.deepEqual(r.body.data.configured, { email: true, visio: true, agenda: false });
  assert.equal((await req('GET', `/tools/${C1}`, { user: 'agent1' })).body.data.visio.customUrl, mine);
  assert.deepEqual((await req('GET', `/tools/${C2}`, { user: 'other1' })).body, defaults, 'un autre centre ne voit pas ces réglages');

  // flux agenda : création, jeton non relisible, régénération
  r = await req('POST', `/tools/${C1}/agenda-feed`, { user: 'owner1' });
  assert.equal(r.status, 201);
  const url1 = r.body.data.agenda.feedUrl;
  const m = url1.match(/^https:\/\/.+\/api\/secretariat\/agenda\/([A-Za-z0-9_-]{43})\.ics$/);
  assert.ok(m, url1);
  const token1 = m[1];
  assert.equal(r.body.data.configured.agenda, true);
  assert.ok(!JSON.stringify(toolsDocs).includes(token1), 'le jeton n’est pas stocké en clair');
  assert.equal(toolsDocs[0].agendaFeed.tokenHash, T.hashFeedToken(token1));
  assert.equal((await req('GET', `/tools/${C1}`, { user: 'owner1' })).body.data.agenda.feedUrl, null, 'jamais relisible');
  assert.equal((await req('GET', `/tools/${C1}`, { user: 'owner1' })).body.data.configured.agenda, true);
  assert.ok(!(await req('PUT', `/tools/${C1}`, { user: 'owner1', body: { email: { signature: 'ok' } } })).text.includes(token1));

  // flux public : sans session
  followRows = [
    apptRow(),
    apptRow({ _id: '64b0000000000000000000a2', title: 'Annulé', status: 'canceled', videoUrl: mine }),
    apptRow({ _id: '64b0000000000000000000a3', title: 'Lien étranger', videoUrl: 'https://evil.example/phish' }),
    apptRow({ _id: '64b0000000000000000000a4', title: 'Autre centre', companyId: C2 }),
  ];
  let f = await req('GET', `/agenda/${token1}.ics`);
  assert.equal(f.status, 200);
  assert.match(f.headers.get('content-type'), /text\/calendar/);
  assert.match(f.headers.get('cache-control'), /no-store/);
  assert.ok(f.text.startsWith('BEGIN:VCALENDAR\r\n') && f.text.endsWith('END:VCALENDAR\r\n'));
  const flat = f.text.replace(/\r\n /g, '');
  assert.equal((flat.match(/BEGIN:VEVENT/g) || []).length, 3, 'les rendez-vous du centre seulement');
  assert.ok(flat.includes('SUMMARY:Rendez-vous Mme Durand') && flat.includes('DTSTART;TZID=Europe/Paris:'));
  assert.ok(flat.includes('URL:https://meet.jit.si/HARX-abcDEF123456'), 'visio jitsi');
  assert.ok(flat.includes(`URL:${mine}`), 'lien permanent enregistré par ce centre');
  assert.ok(!flat.includes('evil.example'), 'un lien qui n’est pas celui du centre n’est pas diffusé');
  assert.ok(!flat.includes('Autre centre'));
  assert.ok(/STATUS:CANCELLED/.test(flat));
  for (const secret of ['secret.client', '+33612345678', 'note privée', 'ATTENDEE', 'mailto:']) assert.ok(!flat.includes(secret), `donnée personnelle absente : ${secret}`);
  assert.ok(/DTEND;TZID=Europe\/Paris:/.test(flat));
  assert.ok(!('contactEmail' in lastFollowQuery) && lastFollowQuery.model === 'appointment');

  // jeton inconnu / mal formé : même 404 générique
  const other = T.newFeedToken();
  const nf = [await req('GET', `/agenda/${other}.ics`), await req('GET', '/agenda/court.ics'), await req('GET', `/agenda/${token1.slice(0, 42)}.ics`), await req('GET', `/agenda/${'A'.repeat(43)}.ics`), await req('GET', `/agenda/${token1}`)];
  for (const x of nf) assert.equal(x.status, 404);
  assert.deepEqual([...new Set(nf.slice(0, 4).map((x) => x.text))], ['Not found'], 'même corps pour tous les cas');

  // régénérer : l'ancien lien meurt, le nouveau vit
  r = await req('POST', `/tools/${C1}/agenda-feed`, { user: 'owner1' });
  const token2 = r.body.data.agenda.feedUrl.match(/agenda\/([^.]+)\.ics$/)[1];
  assert.notEqual(token2, token1);
  assert.equal((await req('GET', `/agenda/${token1}.ics`)).status, 404, 'ancien jeton révoqué');
  assert.equal((await req('GET', `/agenda/${token2}.ics`)).status, 200);
  // le lien permanent a changé : l'ancien n'est plus diffusé
  await req('PUT', `/tools/${C1}`, { user: 'owner1', body: { visio: { provider: 'jitsi' } } });
  assert.ok(!(await req('GET', `/agenda/${token2}.ics`)).text.replace(/\r\n /g, '').includes('meet.google.com'), 'visio repassée sur jitsi : le lien permanent n’est plus accepté');
  // le jeton ne figure dans aucun journal
  assert.ok(!logged.join('\n').includes(token1) && !logged.join('\n').includes(token2), 'jeton jamais journalisé');

  // ---------- e-mails : identité du centre
  const APPT = '64b0000000000000000000a1';
  const tok = sign('owner1');
  const call = (fn, body) => new Promise((resolve) => {
    clearCompanyCache();
    const res = { code: 200, status(x) { this.code = x; return this; }, setHeader() {}, json(b) { resolve({ code: this.code, body: b }); return this; }, send(b) { resolve({ code: this.code, text: b }); return this; } };
    fn({ user: { userId: 'owner1' }, headers: { authorization: `Bearer ${tok}` }, body, params: {}, query: {}, method: 'POST', originalUrl: '/x' }, res);
  });
  const logs = [];
  EmailLog.create = async (d) => { const x = { _id: `l${logs.length + 1}`, createdAt: new Date(), ...d }; logs.push(x); return x; };
  EmailLog.countDocuments = async () => 0;
  const sent = [];
  E.setMailTransport(async (p) => { sent.push(p); return {}; });
  const msg = { companyId: C1, to: 'client@exemple.fr', subject: 'Votre rendez-vous', body: 'Bonjour', template: 'free', centerName: 'Nom du formulaire' };

  // identité renseignée : nom, Reply-To et signature du centre ; expéditeur technique inchangé
  await req('PUT', `/tools/${C1}`, { user: 'owner1', body: { email: { fromName: 'Centre Acme', replyTo: 'contact@acme.fr', signature: 'Cordialement,\nL’équipe Acme' } } });
  let e = await call(mail.send, msg);
  assert.equal(e.code, 201, JSON.stringify(e.body));
  assert.deepEqual(sent[0].sender, { name: 'Centre Acme', email: 'noreply@harx.ai' }, 'nom du centre, adresse technique de la plateforme');
  assert.deepEqual(sent[0].replyTo, { email: 'contact@acme.fr', name: 'Centre Acme' });
  assert.match(sent[0].textContent, /^Bonjour\n\nCordialement,\nL’équipe Acme\n\nMessage envoyé via HARX pour le compte de Centre Acme/);
  assert.ok(sent[0].htmlContent.includes('L’équipe Acme') || sent[0].htmlContent.includes('L&#39;équipe') || sent[0].htmlContent.includes('Cordialement'));
  assert.ok(!JSON.stringify(logs).includes('Cordialement'), 'ni message ni signature dans le journal');

  // identité vide : comportement historique (nom du formulaire, réponse = utilisateur connecté)
  toolsDocs.length = 0;
  e = await call(mail.send, msg);
  assert.equal(e.code, 201);
  assert.deepEqual(sent[1].sender, { name: 'Nom du formulaire', email: 'noreply@harx.ai' });
  assert.deepEqual(sent[1].replyTo, { email: 'chef@acme.fr', name: 'Chef de centre' });
  assert.ok(!sent[1].textContent.includes('Cordialement'));
  // identité partielle : seulement la signature
  toolsDocs.push({ companyId: C1, email: { signature: 'Bien à vous' } });
  await call(mail.send, msg);
  assert.equal(sent[2].sender.name, 'Nom du formulaire'); assert.equal(sent[2].replyTo.email, 'chef@acme.fr'); assert.match(sent[2].textContent, /Bonjour\n\nBien à vous\n\n/);
  // un autre centre n'hérite pas de l'identité de celui-ci
  toolsDocs.length = 0; toolsDocs.push({ companyId: C2, email: { fromName: 'Autre', replyTo: 'x@autre.fr', signature: 'Autre sig' } });
  await call(mail.send, msg);
  assert.equal(sent[3].sender.name, 'Nom du formulaire'); assert.ok(!sent[3].textContent.includes('Autre sig'));
  toolsDocs.length = 0;

  // ---------- visio d'un rendez-vous : jitsi par défaut, lien permanent si choisi
  const store = [];
  FollowUpItem.create = async (doc) => { const d = { _id: `64b00000000000000000${String(store.length + 1).padStart(4, '0')}`, status: 'todo', sequence: 0, createdAt: new Date(), updatedAt: new Date(), transfers: [], ...doc, save: async () => d, toObject() { const { save, toObject, ...rest } = d; return rest; } }; store.push(d); return d; };
  FollowUpItem.exists = async () => false;
  const when = () => new Date(Date.now() + 5 * 86400000).toISOString();
  const create = (extra = {}) => call(fu.create, { companyId: C1, model: 'appointment', contactName: 'Mme Durand', dueAt: when(), videoLink: true, ...extra });
  let c = await create();
  assert.equal(c.code, 201, JSON.stringify(c.body));
  assert.ok(V.isVisioUrl(c.body.data.videoUrl), 'sans réglage : salle Jitsi');
  toolsDocs.push({ companyId: C1, visio: { provider: 'custom', customUrl: mine } });
  c = await create();
  assert.equal(c.body.data.videoUrl, mine, 'lien permanent du centre');
  c = await create({ videoLink: false });
  assert.equal(c.body.data.videoUrl, '', 'pas de visio demandée : aucun lien');
  // PATCH : ajout du lien sur un rendez-vous sans visio, puis suppression
  const item = store[2];
  FollowUpItem.findOne = async (f) => (String(f._id) === String(item._id) ? item : null);
  const patch = (body) => new Promise((resolve) => {
    clearCompanyCache();
    const res = { code: 200, status(x) { this.code = x; return this; }, json(b) { resolve({ code: this.code, body: b }); return this; } };
    fu.patch({ user: { userId: 'owner1' }, headers: { authorization: `Bearer ${tok}` }, body, params: { id: item._id }, query: {}, method: 'PATCH', originalUrl: '/x' }, res);
  });
  let p = await patch({ videoLink: true });
  assert.equal(p.body.data.videoUrl, mine);
  p = await patch({ videoLink: false });
  assert.equal(p.body.data.videoUrl, '', 'la suppression du lien fonctionne aussi avec le lien permanent');
  // le client ne peut pas imposer son propre lien
  p = await patch({ videoUrl: 'https://evil.example/x' });
  assert.equal(p.code, 400); assert.equal(item.videoUrl, '');
  toolsDocs.length = 0;

  console.log('secretariatTools: ok');
} finally {
  server.close();
}
