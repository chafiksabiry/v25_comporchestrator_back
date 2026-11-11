// Run: JWT_SECRET=test TELNYX_API_KEY=x node src/tests/staffSelfProfile.test.js
// La secrétaire règle SES langues et compétences (PUT /staff/:companyId/me). Base et réseau simulés : aucun appel réel.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import express from 'express';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
try { import.meta.resolve('web-push'); } catch {
  register('data:text/javascript,' + encodeURIComponent("export async function resolve(s,c,n){ if(s==='web-push') return {url:'data:text/javascript,export default {setVapidDetails(){},sendNotification(){}}',shortCircuit:true}; return n(s,c);}"));
}

const { default: StaffRouting } = await import('../models/StaffRouting.js');
const { secretariatToolsRoutes } = await import('../routes/secretariatTools.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');

const C1 = '64b0000000000000000000c1';
const C2 = '64b0000000000000000000c2';
const C3 = '64b0000000000000000000c3';

const clone = (v) => JSON.parse(JSON.stringify(v));
const lean = (v) => ({ lean: async () => v, then(r, j) { return Promise.resolve(v).then(r, j); } });
const matches = (d, f) => Object.entries(f).every(([k, v]) => String(d[k]) === String(v));
let staffStore = []; let seq = 0;
StaffRouting.find = (f) => lean(clone(staffStore.filter((d) => matches(d, f))));
StaffRouting.findOneAndUpdate = (f, upd, opts) => {
  let d = staffStore.find((x) => matches(x, f));
  if (!d) { assert.ok(opts.upsert); d = { _id: String(++seq), companyId: String(f.companyId), userId: f.userId }; staffStore.push(d); }
  Object.assign(d, clone(upd.$set));
  return lean(clone(d));
};

const directory = {
  owner1: { companyId: C1, isOwner: true },
  member1: { companyId: C1, isOwner: false, permissions: { 'calls.view': true } },
  memberNoCalls: { companyId: C1, isOwner: false, permissions: {} },
  agent1: { companyId: C1, isOwner: false, isAgent: true },
  agent2: { companyId: C1, isOwner: false, isAgent: true },
  multi: { companyId: C1, companyIds: [C1, C2], isOwner: false, isAgent: true },
  other1: { companyId: C3, isOwner: true },
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
const quiet = console.error; console.error = () => {};

try {
  const ME = `/staff/${C1}/me`;
  const good = { languages: [' FR ', 'ar', 'fr'], skills: [' Facturation ', 'facturation'] };

  // session obligatoire
  assert.equal((await req('PUT', ME, { body: good })).status, 401);
  // société qui n'est pas la sienne
  assert.equal((await req('PUT', ME, { user: 'other1', body: good })).status, 403);
  assert.equal((await req('PUT', `/staff/${C3}/me`, { user: 'agent1', body: good })).status, 403, 'une secrétaire ne choisit pas une société hors de ses emplois');

  // les autres rôles : 403, rien n'est écrit
  for (const user of ['owner1', 'member1', 'memberNoCalls']) assert.equal((await req('PUT', ME, { user, body: good })).status, 403, user);
  assert.equal(staffStore.length, 0, 'un refus n\'écrit rien');

  // validation identique à celle du responsable
  assert.equal((await req('PUT', ME, { user: 'agent1', body: { languages: ['xx'], skills: [] } })).status, 400);
  assert.equal((await req('PUT', ME, { user: 'agent1', body: { languages: ['fr'] } })).status, 400, 'les deux listes sont obligatoires');
  assert.equal((await req('PUT', ME, { user: 'agent1', body: { languages: ['fr'], skills: ['x'.repeat(25)] } })).status, 400);
  assert.equal((await req('PUT', ME, { user: 'agent1', body: { languages: ['fr'], skills: Array.from({ length: 13 }, (_, i) => `s${i}`) } })).status, 400);
  assert.equal(staffStore.length, 0);

  // la secrétaire modifie SON profil (même réponse que updateStaff)
  let r = await req('PUT', ME, { user: 'agent1', body: good });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { success: true, data: { member: { userId: 'agent1', languages: ['fr', 'ar'], skills: ['facturation'] } } });
  assert.deepEqual(staffStore.map((d) => [d.companyId, d.userId]), [[C1, 'agent1']]);

  // aucun identifiant du corps ni de l'URL n'est pris en compte
  r = await req('PUT', ME, { user: 'agent1', body: { userId: 'agent2', companyId: C2, languages: ['en'], skills: [] } });
  assert.equal(r.status, 200); assert.equal(r.body.data.member.userId, 'agent1');
  assert.equal(staffStore.length, 1); assert.deepEqual(staffStore[0].languages, ['en'], 'remplace (ne fusionne pas)');
  assert.equal(staffStore[0].companyId, C1);
  r = await req('PUT', `${ME}?userId=agent2`, { user: 'agent1', body: { languages: ['es'], skills: [] } });
  assert.equal(r.body.data.member.userId, 'agent1');
  assert.equal((await req('PUT', `/staff/${C1}/agent2`, { user: 'agent1', body: { languages: ['fr'], skills: [] } })).status, 403, 'elle ne modifie pas une autre personne par la route du responsable');
  assert.equal(staffStore.some((d) => d.userId === 'agent2'), false, 'le profil d\'une autre personne n\'est jamais touché');

  // une autre secrétaire n'écrase pas la première
  r = await req('PUT', ME, { user: 'agent2', body: { languages: ['de'], skills: ['litiges'] } });
  assert.equal(r.status, 200);
  assert.deepEqual(staffStore.map((d) => [d.userId, d.languages.join()]).sort(), [['agent1', 'es'], ['agent2', 'de']]);

  // plusieurs emplois : la société demandée doit en faire partie, et seule celle-là est écrite
  r = await req('PUT', `/staff/${C2}/me`, { user: 'multi', body: { languages: ['it'], skills: [] } });
  assert.equal(r.status, 200);
  assert.deepEqual(staffStore.find((d) => d.userId === 'multi'), { _id: staffStore.find((d) => d.userId === 'multi')._id, companyId: C2, userId: 'multi', languages: ['it'], skills: [] });

  // la route du responsable est inchangée
  r = await req('PUT', `/staff/${C1}/agent1`, { user: 'owner1', body: { languages: ['fr'], skills: ['x'] } });
  assert.equal(r.status, 200); assert.deepEqual(r.body.data.member, { userId: 'agent1', languages: ['fr'], skills: ['x'] });
  assert.equal((await req('PUT', `/staff/${C1}/agent1`, { user: 'agent1', body: { languages: ['fr'], skills: [] } })).status, 403, 'la secrétaire n\'utilise pas la route du responsable');
  assert.equal((await req('PUT', `/staff/${C1}/agent1`, { user: 'member1', body: { languages: ['en'], skills: [] } })).status, 200, 'membre autorisé : inchangé');
  assert.equal((await req('PUT', `/staff/${C1}/agent1`, { user: 'memberNoCalls', body: { languages: ['en'], skills: [] } })).status, 403, 'membre sans droit d\'écriture : refus inchangé');
  r = await req('PUT', `/staff/${C1}/me`, { user: 'owner1', body: good });
  assert.equal(r.status, 403, '« me » n\'est pas un identifiant pour le responsable');
  assert.equal(staffStore.some((d) => d.userId === 'me'), false);

  console.log('staffSelfProfile: ok');
} finally {
  console.error = quiet;
  server.close();
}
