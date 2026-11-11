// Run: JWT_SECRET=test node src/tests/integrations.test.js
// Aucun appel réel ni identifiant réel : adaptateurs testés contre un faux serveur HTTP local.
import assert from 'node:assert/strict';
import http from 'node:http';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const KEY_HEX = 'a'.repeat(64);
const C = await import('../integrations/crypto.js');
const K = await import('../integrations/apiKeys.js');
const S = await import('../integrations/webhookSign.js');
const { createRateLimiter } = await import('../integrations/rateLimit.js');
const U = await import('../integrations/urlGuard.js');
const { defaultHttp, CrmError } = await import('../integrations/http.js');
const A = await import('../integrations/adapters/index.js');
const E = await import('../integrations/engine.js');
const Ev = await import('../integrations/events.js');
const { createPublicAuth, createPublicController } = await import('../controllers/publicApiController.js');
const { createCallEndedHandler, CALL_ENDED_SCOPE, verifyCallEndedToken } = await import('../controllers/callEndedController.js');
const { canManageIntegrations } = await import('../controllers/integrationsController.js');
const { oauthStatus, startZohoOAuth } = await import('../integrations/oauth.js');
const { CALLCENTER_TIERS_WITH_INTEGRATIONS } = await import('../services/callcenterTier.js');

// ---------- chiffrement
{
  assert.throws(() => C.loadKey({}), (e) => e.code === 'integrations_disabled', 'sans clé : refus');
  assert.throws(() => C.loadKey({ INTEGRATIONS_ENC_KEY: 'court' }), /32 octets/);
  assert.equal(C.integrationsEnabled({}), false);
  assert.equal(C.integrationsEnabled({ INTEGRATIONS_ENC_KEY: KEY_HEX }), true);
  const key = C.loadKey({ INTEGRATIONS_ENC_KEY: KEY_HEX });
  const secret = { accessToken: 'pat-SECRET-123' };
  const enc = C.encryptJson(secret, { context: 'c1:hubspot', key });
  assert.ok(!enc.includes('SECRET') && !Buffer.from(enc.split('.')[3], 'base64url').toString().includes('SECRET'), 'jamais en clair');
  assert.deepEqual(C.decryptJson(enc, { context: 'c1:hubspot', key }), secret);
  assert.throws(() => C.decryptJson(enc, { context: 'c2:hubspot', key }), 'lié au centre');
  assert.throws(() => C.decryptJson(enc, { context: 'c1:hubspot', key: C.loadKey({ INTEGRATIONS_ENC_KEY: 'b'.repeat(64) }) }), 'autre clé refusée');
  const bad = enc.slice(0, -2) + (enc.endsWith('A') ? 'BB' : 'AA');
  assert.throws(() => C.decryptJson(bad, { context: 'c1:hubspot', key }), 'altération détectée');
  assert.notEqual(enc, C.encryptJson(secret, { context: 'c1:hubspot', key }), 'IV aléatoire');
  assert.throws(() => C.encryptJson(secret, { context: 'x', key: undefined }) || (() => { throw new Error('ok'); })(), 'sans clé en environnement : refuse');
}

// ---------- clés d'API
{
  const { key, hash, prefix } = K.generateApiKey();
  assert.ok(key.startsWith('hx_live_') && key.length > 40);
  assert.equal(hash, K.hashKey(key));
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.ok(!hash.includes(key) && key.startsWith(prefix) && prefix.length < key.length / 2);
  assert.notEqual(K.generateApiKey().key, key);
  assert.equal(K.extractApiKey({ authorization: `Bearer ${key}` }), key);
  assert.equal(K.extractApiKey({ 'x-api-key': key }), key);
  assert.equal(K.extractApiKey({ authorization: 'Bearer abc' }), null);
  assert.equal(K.extractApiKey({}), null);
}

// ---------- signature des webhooks
{
  const body = JSON.stringify({ a: 1 });
  const h = S.signPayload('whsec_x', body, 1000);
  assert.match(h, /^t=1000,v1=[0-9a-f]{64}$/);
  assert.equal(S.verifySignature('whsec_x', body, h, { now: 1100 }), true);
  assert.equal(S.verifySignature('whsec_y', body, h, { now: 1100 }), false, 'mauvais secret');
  assert.equal(S.verifySignature('whsec_x', body + ' ', h, { now: 1100 }), false, 'corps modifié');
  assert.equal(S.verifySignature('whsec_x', body, h, { now: 1000 + 301 }), false, 'rejeu trop tardif');
  assert.equal(S.verifySignature('whsec_x', body, 'n’importe quoi', { now: 1000 }), false);
}

// ---------- limitation de débit
{
  let t = 0;
  const rl = createRateLimiter({ limit: 3, windowMs: 1000, now: () => t });
  assert.ok(rl.check('k').ok && rl.check('k').ok && rl.check('k').ok);
  const blocked = rl.check('k');
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterSeconds >= 1);
  assert.ok(rl.check('autre').ok, 'par clé');
  t = 1001;
  assert.ok(rl.check('k').ok, 'fenêtre glissante');
}

// ---------- adresses de webhook
{
  assert.ok(U.checkWebhookUrl('https://exemple.fr/hook').value);
  for (const bad of ['http://exemple.fr', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://192.168.1.1/x', 'https://169.254.169.254/x', 'https://[::1]/x', 'https://u:p@exemple.fr/', 'pas une url', 'https://serveur.internal/x']) {
    assert.ok(U.checkWebhookUrl(bad).error, bad);
  }
  assert.equal(await U.assertResolvesPublic('https://exemple.fr/x', async () => [{ address: '10.0.0.1' }]), false, 'DNS vers une adresse interne');
  assert.equal(await U.assertResolvesPublic('https://exemple.fr/x', async () => [{ address: '93.184.216.34' }]), true);
}

// ---------- faux serveur HTTP + adaptateurs
const seen = [];
let respond = () => ({ status: 500, body: {} });
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const entry = { method: req.method, url: req.url, headers: req.headers, body: raw };
    try { entry.json = raw && req.headers['content-type']?.includes('json') ? JSON.parse(raw) : null; } catch { entry.json = null; }
    seen.push(entry);
    const r = respond(entry);
    res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers || {}) });
    res.end(r.body === undefined ? '' : JSON.stringify(r.body));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
/** Redirige tout appel vers le faux serveur en gardant le chemin et les en-têtes. */
const fakeHttp = (req) => defaultHttp({ ...req, url: origin + new URL(req.url).pathname + new URL(req.url).search });
const reset = (fn) => { seen.length = 0; respond = fn; };
const CALL = { title: 'Appel sortant HARX', direction: 'outbound', startedAt: '2026-11-02T10:00:00.000Z', durationSeconds: 125, fromNumber: '+33100000000', toNumber: '+33612345678', summary: 'Résumé' };

// HubSpot
{
  const hs = A.createAdapter('hubspot', { accessToken: 'TOKEN_HS' }, { http: fakeHttp });
  reset((r) => (r.url.startsWith('/crm/v3/objects/contacts?limit=1') ? { status: 200, body: { results: [] } } : { status: 500 }));
  assert.deepEqual(await hs.testConnection(), { ok: true });
  assert.equal(seen[0].headers.authorization, 'Bearer TOKEN_HS');

  reset(() => ({ status: 401, body: { message: 'bad token' } }));
  await assert.rejects(hs.testConnection(), (e) => e instanceof CrmError && e.retryable === false && !e.message.includes('TOKEN_HS'));

  // création (recherche vide)
  reset((r) => (r.url === '/crm/v3/objects/contacts/search' ? { status: 200, body: { results: [] } } : { status: 201, body: { id: '501' } }));
  assert.deepEqual(await hs.upsertContact({ firstName: 'Marie', lastName: 'Martin', email: 'm@x.fr', phone: '+33612345678' }), { id: '501', created: true });
  assert.deepEqual(seen[0].json.filterGroups[0].filters[0], { propertyName: 'email', operator: 'EQ', value: 'm@x.fr' });
  assert.equal(seen[1].method, 'POST');
  assert.deepEqual(seen[1].json.properties, { firstname: 'Marie', lastname: 'Martin', email: 'm@x.fr', phone: '+33612345678' });
  // mise à jour
  reset((r) => (r.url === '/crm/v3/objects/contacts/search' ? { status: 200, body: { results: [{ id: '77' }] } } : { status: 200, body: { id: '77' } }));
  assert.deepEqual(await hs.upsertContact({ email: 'm@x.fr' }), { id: '77', created: false });
  assert.equal(seen[1].method, 'PATCH'); assert.equal(seen[1].url, '/crm/v3/objects/contacts/77');
  // recherche par téléphone sans e-mail ; ni l'un ni l'autre : refus
  reset((r) => (r.url.endsWith('/search') ? { status: 200, body: { results: [] } } : { status: 201, body: { id: '9' } }));
  await hs.upsertContact({ phone: '+33600000000' });
  assert.equal(seen[0].json.filterGroups[0].filters[0].propertyName, 'phone');
  await assert.rejects(hs.upsertContact({}), (e) => e.retryable === false);
  // appel
  reset(() => ({ status: 201, body: { id: 'call1' } }));
  assert.deepEqual(await hs.logCall(CALL, { id: '77' }), { id: 'call1' });
  assert.equal(seen[0].url, '/crm/v3/objects/calls');
  assert.equal(seen[0].json.properties.hs_call_direction, 'OUTBOUND');
  assert.equal(seen[0].json.properties.hs_call_duration, '125000');
  assert.equal(seen[0].json.associations[0].to.id, '77');
  // erreurs : 429 et 500 se reprennent, 400 non
  reset(() => ({ status: 429, body: {} }));
  await assert.rejects(hs.logCall(CALL, null), (e) => e.retryable === true);
  reset(() => ({ status: 502, body: {} }));
  await assert.rejects(hs.logCall(CALL, null), (e) => e.retryable === true);
  reset(() => ({ status: 400, body: { message: 'mauvaise propriété' } }));
  await assert.rejects(hs.logCall(CALL, null), (e) => e.retryable === false);
  // liste
  reset(() => ({ status: 200, body: { results: [{ id: '1', properties: { firstname: 'A', lastname: 'B', email: 'a@b.fr', phone: null, mobilephone: '0611' } }], paging: { next: { after: 'CUR' } } } }));
  const page = await hs.listContacts({ limit: 1 });
  assert.deepEqual(page, { contacts: [{ externalId: '1', firstName: 'A', lastName: 'B', email: 'a@b.fr', phone: '0611' }], next: 'CUR' });
  assert.throws(() => A.createAdapter('hubspot', {}, { http: fakeHttp }), CrmError);
}

// Zoho
{
  const creds = { clientId: 'cid', clientSecret: 'SECRET_Z', refreshToken: 'RT_Z', region: 'eu' };
  const z = A.createAdapter('zoho', creds, { http: fakeHttp });
  const zoho = (api) => (r) => (r.url.startsWith('/oauth/v2/token') ? { status: 200, body: { access_token: 'AT_Z' } } : api(r));
  reset(zoho(() => ({ status: 204 })));
  assert.deepEqual(await z.testConnection(), { ok: true });
  assert.equal(seen[0].body.includes('grant_type=refresh_token'), true);
  assert.equal(seen[1].headers.authorization, 'Zoho-oauthtoken AT_Z');
  await z.testConnection();
  assert.equal(seen.filter((s) => s.url.startsWith('/oauth')).length, 1, 'jeton d’accès réutilisé');

  const z2 = A.createAdapter('zoho', creds, { http: fakeHttp });
  reset(zoho(() => ({ status: 200, body: { data: [{ code: 'SUCCESS', action: 'insert', details: { id: 'Z1' } }] } })));
  assert.deepEqual(await z2.upsertContact({ firstName: 'Marie', lastName: 'Martin', email: 'm@x.fr' }), { id: 'Z1', created: true });
  const up = seen.find((s) => s.url.includes('/Contacts/upsert'));
  assert.deepEqual(up.json.duplicate_check_fields, ['Email']);
  assert.equal(up.json.data[0].Last_Name, 'Martin');
  reset(zoho(() => ({ status: 200, body: { data: [{ code: 'INVALID_DATA', message: 'champ invalide' }] } })));
  await assert.rejects(A.createAdapter('zoho', creds, { http: fakeHttp }).upsertContact({ phone: '+33611111111' }), CrmError);
  reset(zoho(() => ({ status: 201, body: { data: [{ code: 'SUCCESS', details: { id: 'CALL1' } }] } })));
  assert.deepEqual(await A.createAdapter('zoho', creds, { http: fakeHttp }).logCall(CALL, { id: 'Z1' }), { id: 'CALL1' });
  const cl = seen.find((s) => s.url === '/crm/v6/Calls');
  assert.equal(cl.json.data[0].Call_Duration, '02:05');
  assert.equal(cl.json.data[0].Call_Type, 'Outbound');
  assert.deepEqual(cl.json.data[0].Who_Id, { id: 'Z1' });
  // jeton refusé
  reset(() => ({ status: 400, body: { error: 'invalid_code' } }));
  await assert.rejects(A.createAdapter('zoho', creds, { http: fakeHttp }).testConnection(), (e) => !e.message.includes('SECRET_Z') && !e.message.includes('RT_Z'));
  reset(zoho(() => ({ status: 200, body: { data: [{ id: 'Z9', First_Name: 'A', Last_Name: 'B', Email: 'a@b.fr', Phone: '01' }], info: { more_records: true } } })));
  assert.deepEqual((await A.createAdapter('zoho', creds, { http: fakeHttp }).listContacts({})).next, '2');
}

// Dynamics
{
  const creds = { orgUrl: 'https://acme.crm4.dynamics.com', tenantId: 'tenant-1', clientId: 'cid', clientSecret: 'SECRET_D' };
  const dyn = () => A.createAdapter('dynamics', creds, { http: fakeHttp });
  const d = (api) => (r) => (r.url.includes('/oauth2/v2.0/token') ? { status: 200, body: { access_token: 'AT_D' } } : api(r));
  assert.throws(() => A.createAdapter('dynamics', { ...creds, orgUrl: 'https://evil.example.com' }, { http: fakeHttp }), /dynamics\.com/);
  reset(d(() => ({ status: 200, body: { UserId: 'u' } })));
  assert.deepEqual(await dyn().testConnection(), { ok: true });
  assert.ok(seen[0].url.startsWith('/tenant-1/oauth2/v2.0/token'));
  assert.ok(seen[0].body.includes('scope=https%3A%2F%2Facme.crm4.dynamics.com%2F.default'));
  assert.equal(seen[1].url, '/api/data/v9.2/WhoAmI');
  assert.equal(seen[1].headers.authorization, 'Bearer AT_D');
  // création, filtre OData échappé
  reset(d((r) => (r.method === 'GET' ? { status: 200, body: { value: [] } } : { status: 201, body: { contactid: 'guid-1' } })));
  assert.deepEqual(await dyn().upsertContact({ lastName: "O'Neil", email: "o'neil@x.fr" }), { id: 'guid-1', created: true });
  assert.ok(decodeURIComponent(seen.find((s) => s.method === 'GET' && s.url.includes('contacts')).url).includes("emailaddress1 eq 'o''neil@x.fr'"));
  // mise à jour
  reset(d((r) => (r.method === 'GET' ? { status: 200, body: { value: [{ contactid: 'guid-2' }] } } : { status: 204 })));
  assert.deepEqual(await dyn().upsertContact({ email: 'a@b.fr' }), { id: 'guid-2', created: false });
  // appel : création puis clôture
  reset(d((r) => (r.method === 'POST' ? { status: 201, body: { activityid: 'act-1' } } : { status: 204 })));
  assert.deepEqual(await dyn().logCall(CALL, { id: 'guid-2' }), { id: 'act-1' });
  const post = seen.find((s) => s.url === '/api/data/v9.2/phonecalls');
  assert.equal(post.json['regardingobjectid_contact_phonecall@odata.bind'], '/contacts(guid-2)');
  assert.equal(post.json.directioncode, true); assert.equal(post.json.actualdurationminutes, 2);
  assert.equal(seen.at(-1).method, 'PATCH'); assert.deepEqual(seen.at(-1).json, { statecode: 1, statuscode: 2 });
  // un curseur vers un autre hôte est refusé
  await assert.rejects(dyn().listContacts({ cursor: 'https://evil.example.com/x' }), CrmError);
  reset(() => ({ status: 401, body: {} }));
  await assert.rejects(dyn().testConnection(), (e) => !e.message.includes('SECRET_D'));
}

// validation de la saisie
{
  assert.ok(A.cleanCredentials('hubspot', { accessToken: '  ' }).error);
  assert.ok(A.cleanCredentials('inconnu', {}).error);
  assert.deepEqual(A.cleanCredentials('hubspot', { accessToken: ' pat ', extra: 'ignoré' }).value, { accessToken: 'pat' });
  assert.ok(A.cleanCredentials('zoho', { clientId: 'a', clientSecret: 'b', refreshToken: 'c', region: 'mars' }).error);
}

// ---------- file d'attente, reprises, webhooks
const memStore = () => {
  const rows = [];
  return {
    rows,
    async insert(j) { if (rows.some((r) => r.kind === j.kind && r.targetId === j.targetId && r.ref === j.ref)) return false; rows.push({ _id: 'j' + rows.length, status: 'pending', attempts: 0, nextAttemptAt: new Date(0), lastError: '', ...j }); return true; },
    async claimDue(now) { return rows.filter((r) => r.status === 'pending' && r.nextAttemptAt <= now); },
    async save() {},
  };
};
{
  const key = C.loadKey({ INTEGRATIONS_ENC_KEY: KEY_HEX });
  const CID = '64b0000000000000000000c1';
  const conn = { _id: 'conn1', provider: 'hubspot', enabled: true, status: 'ok', credentialsEnc: C.encryptJson({ accessToken: 'TOKEN_HS' }, { context: E.connectionContext(CID, 'hubspot'), key }) };
  const secret = 'whsec_test';
  const endpoint = { _id: 'ep1', url: 'https://exemple.fr/hook', enabled: true, events: ['call.completed'], secretEnc: C.encryptJson({ secret }, { context: E.webhookContext(CID), key }) };
  let clock = new Date('2026-11-02T10:00:00Z');
  let plan = true;
  const sent = [];
  let crmDown = false;
  const fakeNet = async (req) => {
    sent.push(req);
    if (req.url.startsWith('https://api.hubapi.com')) {
      if (crmDown) return { status: 503, json: {} };
      if (req.url.endsWith('/search')) return { status: 200, json: { results: [] } };
      if (req.url.endsWith('/contacts')) return { status: 201, json: { id: 'h1' } };
      return { status: 201, json: { id: 'hc1' } };
    }
    return { status: 200, json: {} };
  };
  const mk = (over = {}) => ({ store: memStore(), http: fakeNet, now: () => clock, key, hasIntegrations: async () => plan, loadConnection: async () => conn, listEndpoints: async () => [endpoint], loadEndpoint: async () => endpoint, assertPublic: async () => true, ...over });
  const call = { sid: 'CA1', direction: 'outbound', status: 'completed', duration: 90, from: '+33100000000', to: '+33612345678', startTime: '2026-11-02T09:58:00Z', endTime: '2026-11-02T09:59:30Z', gigId: 'g1', handledByName: 'Agent Un', contact: { firstName: 'Marie', lastName: 'Martin' } };

  // mise en file : CRM + webhook, dédoublonnage, droits du forfait
  let deps = mk();
  assert.equal(await E.enqueueCallEnded({ companyId: CID, call }, deps), 2);
  assert.equal(await E.enqueueCallEnded({ companyId: CID, call }, deps), 0, 'idempotent');
  plan = false; assert.equal(await E.enqueueCallEnded({ companyId: CID, call: { ...call, sid: 'CA2' } }, deps), 0, 'forfait sans groupe H'); plan = true;
  assert.equal(await E.enqueueCallEnded({ companyId: CID, call: { ...call, sid: 'CA3', isTest: true } }, deps), 0, 'appel de test ignoré');
  assert.equal(await E.enqueueCallEnded({ companyId: CID, call: { ...call, sid: 'CA4', status: 'no-answer', duration: 0 } }, deps), 1, 'sans réponse : webhook seulement');
  assert.equal(await E.enqueueCallEnded({ companyId: CID, call }, mk({ hasIntegrations: async () => { throw new Error('panne'); } })), 0, 'ne lève jamais');
  const disabled = mk({ loadConnection: async () => ({ ...conn, enabled: false }), listEndpoints: async () => [] });
  assert.equal(await E.enqueueCallEnded({ companyId: CID, call }, disabled), 0, 'connexion désactivée');

  // traitement
  const r = await E.runDue(deps);
  assert.deepEqual(r, { processed: 3, done: 3 });
  const crmReqs = sent.filter((s) => s.url.startsWith('https://api.hubapi.com'));
  assert.equal(crmReqs.length, 3); // recherche, création du contact, appel
  assert.equal(crmReqs[0].headers.Authorization, 'Bearer TOKEN_HS');
  const hook = sent.find((s) => s.url === 'https://exemple.fr/hook');
  const evt = JSON.parse(hook.body);
  assert.equal(evt.type, 'call.completed'); assert.equal(evt.data.call.id, 'CA1'); assert.equal(evt.data.call.durationSeconds, 90);
  assert.ok(!('recording_url' in evt.data.call));
  assert.equal(S.verifySignature(secret, hook.body, hook.headers['X-Harx-Signature'], { now: Math.floor(clock.getTime() / 1000) }), true, 'signature valide');
  assert.equal(S.verifySignature('autre', hook.body, hook.headers['X-Harx-Signature'], { now: Math.floor(clock.getTime() / 1000) }), false);

  // reprises : CRM en panne -> replanifié avec délai croissant, puis abandon
  sent.length = 0; crmDown = true; plan = true;
  deps = mk();
  await E.enqueueCallEnded({ companyId: CID, call: { ...call, sid: 'CB1' } }, { ...deps, listEndpoints: async () => [] });
  const job = deps.store.rows[0];
  assert.equal(await E.processJob(job, deps), 'pending');
  assert.equal(job.attempts, 1); assert.equal(job.nextAttemptAt.getTime() - clock.getTime(), 60_000);
  assert.match(job.lastError, /erreur du CRM \(503\)/); assert.ok(!job.lastError.includes('TOKEN_HS'));
  assert.equal((await deps.store.claimDue(clock)).length, 0, 'pas avant l’échéance');
  clock = new Date(clock.getTime() + 61_000);
  assert.equal((await deps.store.claimDue(clock)).length, 1);
  await E.processJob(job, deps); assert.equal(job.nextAttemptAt.getTime() - clock.getTime(), 5 * 60_000);
  while (job.status === 'pending') { clock = new Date(clock.getTime() + 13 * 3600_000); await E.processJob(job, deps); }
  assert.equal(job.status, 'dead'); assert.equal(job.attempts, E.MAX_ATTEMPTS);
  // le contact créé n'est pas recréé à chaque reprise
  crmDown = false;
  // erreur non reprenable : abandon immédiat
  deps = mk({ loadConnection: async () => ({ ...conn, enabled: false }) });
  deps.store.rows.push({ _id: 'x', companyId: CID, kind: 'crm_call', targetId: 'conn1', ref: 'CZ', payload: { call: Ev.crmCallInput(call), contact: {} }, status: 'pending', attempts: 0, nextAttemptAt: new Date(0), lastError: '' });
  assert.equal(await E.processJob(deps.store.rows[0], deps), 'dead');
  // webhook : destinataire en 500 -> reprise ; 404 -> abandon ; adresse non publique -> abandon
  for (const [status, expected] of [[500, 'pending'], [404, 'dead']]) {
    const d = mk({ http: async () => ({ status, json: {} }) });
    await E.enqueueCallEnded({ companyId: CID, call: { ...call, sid: 'W' + status } }, { ...d, loadConnection: async () => null });
    assert.equal(await E.processJob(d.store.rows[0], d), expected, `webhook ${status}`);
  }
  const priv = mk({ assertPublic: async () => false });
  await E.enqueueCallEnded({ companyId: CID, call: { ...call, sid: 'WP' } }, { ...priv, loadConnection: async () => null });
  assert.equal(await E.processJob(priv.store.rows[0], priv), 'dead');
  assert.match(priv.store.rows[0].lastError, /non publique/);
  // aucun secret dans les messages d'erreur d'un échec réseau
  assert.equal(E.safeMessage(new Error('connect ECONNREFUSED Bearer TOKEN_HS')), 'Erreur réseau ou inattendue.');
}

// ---------- API publique : clés, débit, forfait, isolation par centre
{
  const { key, hash } = K.generateApiKey();
  const CID = '64b0000000000000000000c1';
  const rows = new Map([[hash, { _id: 'k1', companyId: CID }]]);
  let plan = true;
  const limiter = createRateLimiter({ limit: 2, windowMs: 60000 });
  const auth = createPublicAuth({ findKey: async (h) => rows.get(h) || null, hasPlan: async () => plan, limiter });
  const mkRes = () => { const r = { code: 200, headers: {}, set(k, v) { r.headers[k] = v; return r; }, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
  const run = async (headers) => { const res = mkRes(); let next = false; const req = { headers, query: {} }; await auth(req, res, () => { next = true; }); return { res, next, req }; };
  assert.equal((await run({})).res.code, 401);
  assert.equal((await run({ authorization: 'Bearer hx_live_' + 'z'.repeat(43) })).res.code, 401, 'clé inconnue');
  const ok = await run({ authorization: `Bearer ${key}` });
  assert.ok(ok.next && ok.req.publicCompanyId === CID);
  assert.equal(ok.res.headers['X-RateLimit-Remaining'], '1');
  await run({ authorization: `Bearer ${key}` });
  const limited = await run({ authorization: `Bearer ${key}` });
  assert.equal(limited.res.code, 429); assert.ok(limited.res.headers['Retry-After']);
  rows.delete(hash); // révoquée
  assert.equal((await run({ 'x-api-key': key })).res.code, 401, 'clé révoquée');
  rows.set(hash, { _id: 'k2', companyId: CID }); plan = false;
  assert.equal((await run({ 'x-api-key': key })).res.code, 403, 'forfait sans API');

  // lecture : le centre vient de la clé, jamais de la requête
  const asked = [];
  const ctl = createPublicController({ fetchData: async (path) => { asked.push(path); return path.includes('/calls') ? { data: [{ sid: 'CA1', direction: 'outbound', duration: 12, recording_url: 'http://secret', transcript: 'secret', gigId: 'g1' }], nextCursor: 'a'.repeat(24) } : { data: [{ id: 'l1', firstName: 'A', email: 'a@b.fr', userId: 'secret' }] }; } });
  const res = mkRes();
  await ctl.calls({ publicCompanyId: CID, query: { limit: '500', companyId: 'autre', cursor: 'bad', since: '2026-01-01' } }, res);
  assert.ok(asked[0].startsWith(`/${CID}/calls?`) && asked[0].includes('limit=100') && !asked[0].includes('autre') && !asked[0].includes('cursor') && asked[0].includes('since=2026-01-01'));
  assert.deepEqual(res.body.data[0], { id: 'CA1', direction: 'outbound', status: 'completed', from: null, to: null, started_at: null, ended_at: null, duration_seconds: 12, operation_id: 'g1', agent_name: null });
  assert.equal(res.body.next_cursor, 'a'.repeat(24));
  const res2 = mkRes();
  await ctl.contacts({ publicCompanyId: CID, query: {} }, res2);
  assert.deepEqual(Object.keys(res2.body.data[0]).sort(), ['created_at', 'email', 'first_name', 'id', 'last_name', 'operation_id', 'phone']);
  const down = createPublicController({ fetchData: async () => { throw new Error('boum'); } });
  const res3 = mkRes(); await down.calls({ publicCompanyId: CID, query: {} }, res3); assert.equal(res3.code, 502);
}

// ---------- droits, forfait, jeton de service, OAuth
{
  assert.equal(canManageIntegrations({ role: 'owner', permissions: {} }), true);
  assert.equal(canManageIntegrations({ role: 'agent', permissions: { 'integrations.manage': true } }), false);
  assert.equal(canManageIntegrations({ role: 'member', permissions: {} }), false);
  assert.equal(canManageIntegrations({ role: 'member', permissions: { 'integrations.manage': true } }), true);
  assert.deepEqual(CALLCENTER_TIERS_WITH_INTEGRATIONS, ['full_scope', 'multi_clients']);

  const tok = (scope, exp = 60) => `Bearer ${jwt.sign({ scope }, process.env.JWT_SECRET, { expiresIn: exp })}`;
  assert.equal(verifyCallEndedToken(tok(CALL_ENDED_SCOPE)), true);
  assert.equal(verifyCallEndedToken(tok('voicemail-analyze')), false);
  assert.equal(verifyCallEndedToken('Bearer x'), false);
  assert.equal(verifyCallEndedToken(`Bearer ${jwt.sign({ scope: CALL_ENDED_SCOPE }, 'autre-secret', { expiresIn: 60 })}`), false);
  const mkRes = () => { const r = { code: 200, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
  const queued = []; const h = createCallEndedHandler({ enqueue: async (x) => { queued.push(x); return 2; }, deps: () => ({}), enabled: () => true });
  let res = mkRes(); await h({ headers: {}, body: {} }, res); assert.equal(res.code, 401);
  res = mkRes(); await h({ headers: { authorization: tok(CALL_ENDED_SCOPE) }, body: { companyId: 'x', call: {} } }, res); assert.equal(res.code, 400);
  res = mkRes(); await h({ headers: { authorization: tok(CALL_ENDED_SCOPE) }, body: { companyId: '64b0000000000000000000c1', call: { sid: 'CA1' } } }, res); assert.equal(res.code, 202); assert.equal(queued.length, 1);
  const off = createCallEndedHandler({ enqueue: async () => { throw new Error('ne doit pas être appelé'); }, deps: () => ({}), enabled: () => false });
  res = mkRes(); await off({ headers: { authorization: tok(CALL_ENDED_SCOPE) }, body: { companyId: '64b0000000000000000000c1', call: { sid: 'CA1' } } }, res); assert.equal(res.code, 202); assert.equal(res.body.queued, 0);

  assert.equal(oauthStatus('zoho', {}).available, false);
  assert.deepEqual(oauthStatus('zoho', {}).missing, ['ZOHO_OAUTH_CLIENT_ID', 'ZOHO_OAUTH_CLIENT_SECRET', 'ZOHO_OAUTH_REDIRECT_URI', 'INTEGRATIONS_RETURN_URL']);
  assert.equal(oauthStatus('dynamics', {}).available, false);
  assert.throws(() => startZohoOAuth({ companyId: 'c', userId: 'u', region: 'eu' }, {}), CrmError);
  const env = { ZOHO_OAUTH_CLIENT_ID: 'id', ZOHO_OAUTH_CLIENT_SECRET: 's', ZOHO_OAUTH_REDIRECT_URI: 'https://api.test/cb', INTEGRATIONS_RETURN_URL: 'https://app.test' };
  const url = new URL(startZohoOAuth({ companyId: 'c', userId: 'u', region: 'eu' }, env));
  assert.equal(url.origin, 'https://accounts.zoho.eu'); assert.ok(!url.search.includes('secret') && url.searchParams.get('state'));
}

server.close();
console.log('integrations.test.js : OK');
