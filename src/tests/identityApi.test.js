// Run: JWT_SECRET=t node --test src/tests/identityApi.test.js
// API de la vérification d'identité avec une IA SIMULÉE (faux SDK : aucun appel réel, aucune clé), base en mémoire et service
// d'inscription simulé. Spécimens fictifs uniquement. Couvre : drapeau, accès, isolation entre sociétés, `submit` qui ignore le
// corps, purge des images à la décision, limites de tentatives, revue humaine, admin (JWT admin seul, journal d'accès).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';

const { createIdentityRoutes, createIdentityAdminRoutes } = await import('../routes/identityVerification.js');
const { createIdentityService } = await import('../services/identity/service.js');
const { createMemoryStore } = await import('../services/identity/store.js');
const { getIdentityConfig } = await import('../services/identity/config.js');
const { createClaudeClient } = await import('../salesiq/claudeClient.js');
const { IDENTITY_DOCUMENT_SCHEMA } = await import('../services/identity/schemas.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');
const { createRateLimiter } = await import('../integrations/rateLimit.js');
const { DECLARED, fakeJpeg, fakePdf, idExtraction, proofExtraction, TEST_KEY } = await import('./identityFixtures.js');

const A = '64b0000000000000000000a1';
const B = '64b0000000000000000000b2';
const people = { ownerA: { companyId: A, isOwner: true }, ownerB: { companyId: B, isOwner: true }, memberA: { companyId: A, isOwner: false }, agentA: { companyId: A, isAgent: true } };
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => {
  const s = String(u);
  if (s.startsWith('http://127.0.0.1')) return realFetch(u, init);
  const url = new URL(s);
  if (url.pathname === '/api/company-members/me') return { ok: true, json: async () => ({ success: true, data: people[url.searchParams.get('userId')] || {} }) };
  throw new Error(`fetch inattendu ${s}`);
};

let enabled; let clock; let store; let sdk; let idData; let proofData; let declared; let queue; let server; let base;
const cfg = () => ({ ...getIdentityConfig({ IDENTITY_FILES_ENC_KEY: TEST_KEY, ANTHROPIC_API_KEY: '' }), enabled });
function fakeSdk() {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params) {
        calls.push(params);
        const isId = params.output_config.format.schema === IDENTITY_DOCUMENT_SCHEMA;
        const d = isId ? idData : proofData;
        if (d === 'refusal') return { stop_reason: 'refusal', content: [], usage: {} };
        if (d === 'api_error') throw Object.assign(new Error('invalid x-api-key'), { status: 401 });
        return { id: `msg_${calls.length}`, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(d) }], usage: { input_tokens: 4000, output_tokens: 300 } };
      },
    },
  };
}

before(async () => {
  const app = express();
  const service = () => createIdentityService({
    store, config: cfg, now: () => clock, sharp: null, logger: { log() {}, error() {} },
    claudeClient: createClaudeClient({ cfg: { ...cfg(), anthropicApiKey: 'unused' }, client: sdk }),
    loadDeclaration: async () => ({ ...declared }),
    schedule: (fn) => queue.push(fn),
  });
  let svc;
  app.use((req, res, next) => { svc = service(); req.svc = svc; next(); });
  const lazy = { status: (...a) => svc.status(...a), upload: (...a) => svc.upload(...a), removeFile: (...a) => svc.removeFile(...a), submit: (...a) => svc.submit(...a), requestReview: (...a) => svc.requestReview(...a), verifiedCountriesFor: (...a) => svc.verifiedCountriesFor(...a), adminList: (...a) => svc.adminList(...a), adminDetail: (...a) => svc.adminDetail(...a), adminFile: (...a) => svc.adminFile(...a), adminDecide: (...a) => svc.adminDecide(...a) };
  app.use('/api/identity-verification', createIdentityRoutes({ service: lazy, config: cfg, loadDeclaration: async () => ({ ...declared }), limiter: createRateLimiter({ limit: 100000 }) }));
  // Second montage avec la limite par IP réelle réduite à 2, pour vérifier le 429.
  app.use('/limited/identity-verification', createIdentityRoutes({ service: lazy, config: cfg, loadDeclaration: async () => ({ ...declared }), limiter: createRateLimiter({ limit: 2, windowMs: 60_000 }) }));
  app.use('/admin/identity', createIdentityAdminRoutes({ service: lazy, config: cfg }));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); globalThis.fetch = realFetch; });
beforeEach(() => {
  clearCompanyCache();
  enabled = true; clock = new Date('2026-11-22T10:00:00Z'); store = createMemoryStore(); sdk = fakeSdk(); queue = [];
  idData = idExtraction(); proofData = proofExtraction(); declared = { ...DECLARED };
});

const token = (userId, extra = {}) => jwt.sign({ userId, ...extra }, process.env.JWT_SECRET);
async function call(method, path, { user = 'ownerA', body, form, auth } = {}) {
  const headers = {};
  if (auth !== null) headers.Authorization = `Bearer ${auth || token(user)}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await realFetch(`${base}${path}`, { method, headers, body: payload });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}
async function uploadFile(kind, buf, { user = 'ownerA', docType = 'passport', mime = 'image/jpeg' } = {}) {
  const form = new FormData();
  form.append('kind', kind); form.append('docType', docType);
  form.append('file', new Blob([buf], { type: mime }), 'specimen');
  return call('POST', '/api/identity-verification/files', { user, form });
}
const runQueue = async () => { while (queue.length) await queue.shift()(); };
async function fullSubmit(user = 'ownerA', { jpeg = fakeJpeg(), body } = {}) {
  assert.equal((await uploadFile('passport', jpeg, { user })).status, 201);
  assert.equal((await uploadFile('address_proof', fakePdf(), { user, mime: 'application/pdf' })).status, 201);
  const r = await call('POST', '/api/identity-verification/submit', { user, body });
  await runQueue();
  return r;
}
const status = async (user = 'ownerA') => (await call('GET', '/api/identity-verification/status', { user })).body;

test('drapeau désactivé : /status { enabled: false }, rien d’autre n’est servi', async () => {
  enabled = false;
  assert.deepEqual((await call('GET', '/api/identity-verification/status')).body, { enabled: false });
  assert.equal((await uploadFile('passport', fakeJpeg())).status, 404);
  assert.equal((await call('POST', '/api/identity-verification/submit', { body: {} })).status, 404);
  assert.equal((await call('GET', '/admin/identity')).status, 404);
});

test('accès : sans jeton 401, membre ou agent 403 (titulaire seulement)', async () => {
  assert.equal((await call('GET', '/api/identity-verification/status', { auth: null })).status, 401);
  assert.equal((await call('GET', '/api/identity-verification/status', { user: 'memberA' })).status, 403);
  assert.equal((await uploadFile('passport', fakeJpeg(), { user: 'agentA' })).status, 403);
});

test('parcours validé : pays vérifiés enregistrés côté serveur, images supprimées, corps de submit ignoré', async () => {
  const r = await fullSubmit('ownerA', { body: { companyId: B, residence: 'US', nationality: 'US', fullName: 'Paul Martin', status: 'approved' } });
  assert.equal(r.status, 202);
  assert.equal(r.body.status, 'processing');
  const s = await status();
  assert.equal(s.status, 'approved');
  assert.deepEqual(s.allowedCountries.sort(), ['FR', 'MA']);
  assert.equal(s.imagesDeleted, true);
  assert.equal(store._files.size, 0);
  const v = [...store._verifications.values()][0];
  assert.equal(v.companyId, A);
  assert.equal(v.declared.residence, 'FR');
  // Aucun numéro de document en clair, aucune ligne MRZ conservée.
  assert.equal(JSON.stringify(v).includes('L898902C3'), false);
  assert.equal(JSON.stringify(v).includes('<<'), false);
  assert.match(v.fingerprints.document, /^[0-9a-f]{64}$/);
  assert.equal(sdk.calls.length, 2);
  assert.equal((await status('ownerB')).status, 'none');
});

test('isolation : une autre société ne peut ni retirer ni voir le fichier', async () => {
  const up = await uploadFile('passport', fakeJpeg());
  assert.equal((await call('DELETE', `/api/identity-verification/files/${up.body.fileId}`, { user: 'ownerB' })).status, 404);
  assert.equal((await status('ownerB')).draft, null);
  assert.equal((await status()).draft.files.length, 1);
  assert.equal((await call('DELETE', `/api/identity-verification/files/${up.body.fileId}`)).status, 200);
});

test('fichiers refusés : HEIC, HTML déguisé ; type réel lu dans les octets', async () => {
  assert.equal((await uploadFile('passport', Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic0000', 'latin1')]))).body.code, 'FILE_HEIC');
  assert.equal((await uploadFile('passport', Buffer.from('<html>specimen</html>.......'), { mime: 'image/jpeg' })).body.code, 'FILE_TYPE_NOT_ALLOWED');
});

test('PDF : passeport en PDF accepté ; PDF à mot de passe refusé ; PDF chiffré sans mot de passe d’ouverture lu par l’IA en images ; admin voit chaque page', async () => {
  const pass = await uploadFile('passport', fakePdf({ color: [0, 0, 1] }), { mime: 'application/pdf' });
  assert.equal(pass.status, 201);
  assert.equal(pass.body.mime, 'image/jpeg');
  const locked = await uploadFile('address_proof', fakePdf({ encrypt: { userPassword: 'secret-specimen' } }), { mime: 'application/pdf' });
  assert.equal(locked.status, 400);
  assert.equal(locked.body.code, 'PDF_PASSWORD_REQUIRED');
  const proof = await uploadFile('address_proof', fakePdf({ pages: 2, encrypt: { userPassword: '' }, js: true }), { mime: 'application/pdf' });
  assert.equal(proof.status, 201);
  // Aucun octet du PDF d'origine n'est stocké : seulement des JPEG (chiffrés).
  assert.equal([...store._files.values()].every((f) => f.mime === 'image/jpeg'), true);
  declared = { ...DECLARED, fullName: 'Paul Martin' };
  const sub = await call('POST', '/api/identity-verification/submit', { body: {} });
  assert.equal(sub.status, 202, JSON.stringify(sub.body));
  await runQueue();
  assert.equal((await status()).status, 'review');
  assert.equal(sdk.calls.length, 2);
  const blocks = sdk.calls.map((c) => c.messages[0].content.filter((b) => b.type !== 'text'));
  for (const list of blocks) for (const b of list) { assert.equal(b.type, 'image'); assert.equal(b.source.media_type, 'image/jpeg'); }
  assert.deepEqual(blocks.map((l) => l.length).sort(), [1, 2], 'pièce : 1 image ; justificatif : 2 images (une par page)');
  const adminTok = token('adm1', { typeUser: 'admin', email: 'admin@harx.test' });
  const id = (await call('GET', '/admin/identity/verifications?status=review', { auth: adminTok })).body.verifications[0].id;
  const detail = await call('GET', `/admin/identity/verifications/${id}`, { auth: adminTok });
  const proofFile = detail.body.files.find((f) => f.kind === 'address_proof');
  assert.equal(proofFile.meta.pages, 2);
  const p0 = await call('GET', `/admin/identity/verifications/${id}/files/${proofFile.fileId}?page=0`, { auth: adminTok });
  const p1 = await call('GET', `/admin/identity/verifications/${id}/files/${proofFile.fileId}?page=1`, { auth: adminTok });
  assert.equal(sniff(p0.body), 'jpeg');
  assert.equal(sniff(p1.body), 'jpeg');
  assert.equal(p0.body.length + p1.body.length, proofFile.size);
});

test('envoi incomplet : FILES_MISSING ; déclaration incomplète : DECLARATION_INCOMPLETE', async () => {
  await uploadFile('passport', fakeJpeg());
  const r = await call('POST', '/api/identity-verification/submit', { body: {} });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body.missing, ['address_proof']);
  await uploadFile('address_proof', fakePdf(), { mime: 'application/pdf' });
  declared = { ...DECLARED, nationality: '' };
  assert.equal((await call('POST', '/api/identity-verification/submit', { body: {} })).body.code, 'DECLARATION_INCOMPLETE');
});

test('refus PROOF_TOO_OLD : motif et faits, images gardées 24 h, essais restants, demande de revue humaine', async () => {
  proofData = proofExtraction({ issue_date: '2026-05-12' });
  await fullSubmit();
  const s = await status();
  assert.equal(s.status, 'rejected');
  assert.deepEqual(s.reasons, ['PROOF_TOO_OLD']);
  assert.equal(s.facts.proofDate, '2026-05-12');
  assert.equal(s.attemptsLeftToday, 2);
  assert.equal(s.canReanalyze, true);
  const files = [...store._files.values()];
  assert.ok(files.every((f) => f.expiresAt.getTime() === clock.getTime() + 24 * 3600 * 1000));
  const rr = await call('POST', '/api/identity-verification/review-request', { body: {} });
  assert.equal(rr.body.status, 'review');
  const after = await status();
  assert.equal(after.status, 'review');
  assert.equal(after.reviewRequested, true);
  assert.equal(after.reviewEtaHours, 24);
});

test('correction de la déclaration après refus : nouvelle analyse sans renvoyer les documents', async () => {
  declared = { ...DECLARED, nationality: 'FR' };
  await fullSubmit();
  assert.deepEqual((await status()).reasons, ['COUNTRY_MISMATCH_NATIONALITY']);
  declared = { ...DECLARED };
  const r = await call('POST', '/api/identity-verification/submit', { body: {} });
  assert.equal(r.status, 202);
  await runQueue();
  assert.equal((await status()).status, 'approved');
});

test('nom différent : revue humaine, jamais refus ; images gardées pour la revue', async () => {
  declared = { ...DECLARED, fullName: 'Paul Martin' };
  await fullSubmit();
  const s = await status();
  assert.equal(s.status, 'review');
  assert.ok(s.reasons.includes('NAME_MISMATCH'));
  assert.equal(store._files.size, 2);
  assert.deepEqual(s.allowedCountries, []);
});

test('refus du modèle -> revue humaine (jamais validé)', async () => {
  idData = 'refusal';
  await fullSubmit();
  const s = await status();
  assert.equal(s.status, 'review');
  assert.ok(s.reasons.includes('AI_REFUSED'));
});

test('injection de consignes signalée par le lecteur -> revue', async () => {
  idData = idExtraction({ fields: { observations: ['instructions_in_document'] } });
  await fullSubmit();
  assert.ok((await status()).reasons.includes('PROMPT_INJECTION_SUSPECTED'));
});

test('même pièce sur un autre compte -> revue DOCUMENT_REUSED', async () => {
  await fullSubmit('ownerA');
  await fullSubmit('ownerB', { jpeg: fakeJpeg({ marker: 7 }) });
  const s = await status('ownerB');
  assert.equal(s.status, 'review');
  assert.ok(s.reasons.includes('DOCUMENT_REUSED'));
});

test('limites : 3 analyses par 24 h, puis revue obligatoire sans appel à l’IA ; 1er « illisible » non décompté', async () => {
  proofData = proofExtraction({ legibility: 'poor' });
  await fullSubmit();
  assert.equal((await status()).attemptsLeftToday, 3, '1er illisible non décompté');
  proofData = proofExtraction({ issue_date: '2026-05-12' });
  for (let i = 0; i < 3; i += 1) await fullSubmit();
  assert.equal((await status()).attemptsLeftToday, 0);
  const before = sdk.calls.length;
  await fullSubmit();
  const s = await status();
  assert.equal(s.status, 'review');
  assert.deepEqual(s.reasons, ['ATTEMPT_LIMIT']);
  assert.equal(sdk.calls.length, before);
  // Le lendemain : de nouveau 3 analyses (6 au total au plus).
  clock = new Date(clock.getTime() + 25 * 3600 * 1000);
  assert.equal((await status()).attemptsLeftToday, 3);
  assert.equal((await status()).attemptsLeftTotal, 3);
});

test('admin : JWT admin seul (jeton abonné refusé), liste, détail sans numéro, image journalisée, décision bornée, purge', async () => {
  declared = { ...DECLARED, fullName: 'Paul Martin' };
  await fullSubmit();
  const adminTok = token('adm1', { typeUser: 'admin', email: 'admin@harx.test' });
  assert.equal((await call('GET', '/admin/identity/verifications', { auth: null })).status, 401);
  assert.equal((await call('GET', '/admin/identity/verifications', { user: 'ownerA' })).status, 401);
  const page = await call('GET', '/admin/identity', { auth: null });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.body.toString().includes('Paul'), false, 'page sans donnée');
  const list = await call('GET', '/admin/identity/verifications?status=review', { auth: adminTok });
  assert.equal(list.body.verifications.length, 1);
  const id = list.body.verifications[0].id;
  const detail = await call('GET', `/admin/identity/verifications/${id}`, { auth: adminTok });
  assert.equal(JSON.stringify(detail.body).includes('L898902C3'), false);
  assert.equal(detail.body.files.length, 2);
  const img = await call('GET', `/admin/identity/verifications/${id}/files/${detail.body.files[0].fileId}`, { auth: adminTok });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('cache-control'), 'no-store');
  assert.equal(sniff(img.body), 'jpeg');
  assert.equal((await call('POST', `/admin/identity/verifications/${id}/decision`, { auth: adminTok, body: { outcome: 'rejected' } })).body.code, 'REASON_REQUIRED');
  // Pays hors déclaration ignorés : seuls résidence / nationalité déclarées peuvent être validées.
  const bad = await call('POST', `/admin/identity/verifications/${id}/decision`, { auth: adminTok, body: { outcome: 'approved', residence: 'US', nationality: 'US' } });
  assert.equal(bad.body.code, 'COUNTRIES_REQUIRED');
  const ok = await call('POST', `/admin/identity/verifications/${id}/decision`, { auth: adminTok, body: { outcome: 'approved', residence: 'FR', nationality: 'MA', note: 'Nom d’usage vérifié' } });
  assert.deepEqual(ok.body.verifiedCountries, { residence: 'FR', nationality: 'MA' });
  assert.equal(store._files.size, 0);
  const v = store._verifications.get(id);
  assert.deepEqual(v.accessLog.map((l) => l.action), ['view_file', 'decision:approved']);
  assert.equal(v.decision.by, 'admin:adm1');
  const s = await status();
  assert.equal(s.status, 'approved');
  assert.equal(s.decidedBy, 'team');
});

test('limite par adresse IP sur les envois : 429 au-delà', async () => {
  const codes = [];
  for (let i = 0; i < 3; i += 1) codes.push((await call('POST', '/limited/identity-verification/submit', { body: {} })).status);
  assert.equal(codes[2], 429);
});

test('limites : un essai en échec technique de notre côté (IA indisponible, erreur interne, 0 jeton) n’est jamais compté', async () => {
  idData = 'api_error';
  for (let i = 0; i < 4; i += 1) await fullSubmit();
  let s = await status();
  assert.equal(s.status, 'review');
  assert.ok(s.reasons.includes('AI_UNAVAILABLE'));
  assert.equal(s.attemptsLeftToday, 3, 'clé invalide : non compté');
  assert.equal(s.attemptsLeftTotal, 6);
  // Dossiers déjà enregistrés avant la correction (marqués « comptés ») : recalculés à la lecture, sans toucher à la base.
  const legacy = (over) => store.createVerification({ companyId: A, status: 'review', aiCounted: true, aiAt: clock, ...over });
  await legacy({ decision: { outcome: 'review', reasonCodes: ['PROCESSING_ERROR'] } });
  await legacy({ decision: { outcome: 'review', reasonCodes: ['AI_UNAVAILABLE'] }, ai: [{ doc: 'identity', error: 'api_error', input: 0, output: 0 }, { doc: 'proof', error: 'api_error', input: 0, output: 0 }] });
  await legacy({ decision: { outcome: 'review', reasonCodes: ['NO_MRZ'] }, ai: [{ doc: 'identity', error: null, input: 0, output: 0 }, { doc: 'proof', error: null, input: 0, output: 0 }] });
  await legacy({ decision: { outcome: 'review', reasonCodes: ['AI_INVALID_OUTPUT'] }, ai: [{ doc: 'identity', error: 'timeout', input: 0, output: 0 }, { doc: 'proof', error: null, input: 3000, output: 200 }] });
  s = await status();
  assert.equal(s.attemptsLeftToday, 3);
  // Un vrai essai lu par l'IA compte, qu'il finisse en refus ou en revue.
  idData = idExtraction();
  proofData = proofExtraction({ issue_date: '2026-05-12' });
  await fullSubmit();
  assert.equal((await status()).status, 'rejected');
  assert.equal((await status()).attemptsLeftToday, 2, 'refus : compté');
  proofData = proofExtraction();
  declared = { ...DECLARED, fullName: 'Paul Martin' };
  await fullSubmit();
  s = await status();
  assert.equal(s.status, 'review');
  assert.equal(s.attemptsLeftToday, 1, 'revue après lecture : comptée');
  // Refus du modèle (jetons consommés, document en cause) : compté.
  idData = 'refusal';
  await fullSubmit();
  assert.equal((await status()).attemptsLeftToday, 0);
});

test('limites réglables : IDENTITY_MAX_AI_ATTEMPTS_PER_DAY et IDENTITY_MAX_AI_ATTEMPTS_TOTAL (défauts 3 et 6)', async () => {
  const d = getIdentityConfig({});
  assert.equal(d.maxAiAttemptsPerDay, 3);
  assert.equal(d.maxAiAttemptsTotal, 6);
  const e = getIdentityConfig({ IDENTITY_MAX_AI_ATTEMPTS_PER_DAY: '5', IDENTITY_MAX_AI_ATTEMPTS_TOTAL: '12' });
  assert.equal(e.maxAiAttemptsPerDay, 5);
  assert.equal(e.maxAiAttemptsTotal, 12);
  assert.equal(getIdentityConfig({ IDENTITY_MAX_AI_ATTEMPTS_PER_DAY: 'abc' }).maxAiAttemptsPerDay, 3);
  // Le service lit la variable : 1 essai par jour.
  const svc = createIdentityService({
    store, now: () => clock, sharp: null, logger: { log() {}, error() {} },
    config: () => ({ ...getIdentityConfig({ IDENTITY_FILES_ENC_KEY: TEST_KEY, IDENTITY_MAX_AI_ATTEMPTS_PER_DAY: '1' }), enabled: true }),
    claudeClient: createClaudeClient({ cfg: { ...cfg(), anthropicApiKey: 'unused' }, client: sdk }),
    loadDeclaration: async () => ({ ...declared }), schedule: (fn) => queue.push(fn),
  });
  assert.equal((await svc.status(A)).attemptsLeftToday, 1);
  proofData = proofExtraction({ issue_date: '2026-05-12' });
  await fullSubmit();
  assert.equal((await status()).attemptsLeftToday, 2, 'défaut 3 ailleurs');
  assert.equal((await svc.status(A)).attemptsLeftToday, 0);
  // Au-delà : revue obligatoire sans appel à l'IA.
  const calls = sdk.calls.length;
  await uploadFile('passport', fakeJpeg()); await uploadFile('address_proof', fakePdf(), { mime: 'application/pdf' });
  assert.deepEqual(await svc.submit({}, A, null), { status: 'review' });
  assert.equal(sdk.calls.length, calls);
});

test('23/11 résidence OU nationalité : passeport sans MRZ -> validé pour la résidence ; l’équipe ajoute la nationalité plus tard', async () => {
  idData = idExtraction({ fields: { mrz_lines: [] } });
  await fullSubmit();
  let s = await status();
  assert.equal(s.status, 'approved');
  assert.deepEqual(s.allowedCountries, ['FR']);
  assert.deepEqual(s.verifiedCountries, { residence: 'FR', nationality: null });
  assert.deepEqual(s.pendingCountries, ['nationality']);
  assert.ok(s.checks.some((c) => c.code === 'NATIONALITY' && c.result === 'review'));
  // Images gardées pour l'équipe (30 jours au plus après l'envoi).
  assert.equal(store._files.size, 2);
  const svcRef = createIdentityService({ store, config: cfg, now: () => clock, logger: { log() {}, error() {} } });
  assert.deepEqual(await svcRef.verifiedCountriesFor(A), { verified: true, countries: ['FR'], declared: { ...DECLARED }, residence: 'FR', nationality: null });
  const adminTok = token('adm1', { typeUser: 'admin' });
  assert.equal((await call('GET', '/admin/identity/verifications?status=review', { auth: adminTok })).body.verifications.length, 0);
  const pend = await call('GET', '/admin/identity/verifications?status=pending', { auth: adminTok });
  assert.equal(pend.body.verifications.length, 1);
  assert.deepEqual(pend.body.verifications[0].pendingCountries, ['nationality']);
  const id = pend.body.verifications[0].id;
  // Pays hors déclaration ignoré ; la résidence déjà validée n'est jamais retirée.
  assert.equal((await call('POST', `/admin/identity/verifications/${id}/decision`, { auth: adminTok, body: { outcome: 'approved', nationality: 'US' } })).body.code, 'COUNTRIES_REQUIRED');
  const ok = await call('POST', `/admin/identity/verifications/${id}/decision`, { auth: adminTok, body: { outcome: 'approved', nationality: 'MA', residence: null } });
  assert.deepEqual(ok.body.verifiedCountries, { residence: 'FR', nationality: 'MA' });
  s = await status();
  assert.deepEqual(s.allowedCountries.sort(), ['FR', 'MA']);
  assert.deepEqual(s.pendingCountries, []);
  assert.equal(store._files.size, 0);
  assert.deepEqual((await svcRef.verifiedCountriesFor(A)).countries.sort(), ['FR', 'MA']);
  assert.equal((await call('POST', `/admin/identity/verifications/${id}/decision`, { auth: adminTok, body: { outcome: 'approved', nationality: 'MA' } })).status, 409);
});

test('23/11 l’équipe refuse le pays en attente : le pays déjà validé reste ouvert', async () => {
  idData = idExtraction({ fields: { mrz_lines: [] } });
  await fullSubmit();
  const adminTok = token('adm1', { typeUser: 'admin' });
  const id = (await call('GET', '/admin/identity/verifications?status=pending', { auth: adminTok })).body.verifications[0].id;
  const r = await call('POST', `/admin/identity/verifications/${id}/decision`, { auth: adminTok, body: { outcome: 'rejected', reasonCode: 'DOCUMENT_SUSPECTED' } });
  assert.deepEqual(r.body.verifiedCountries, { residence: 'FR', nationality: null });
  const s = await status();
  assert.equal(s.status, 'approved');
  assert.deepEqual(s.allowedCountries, ['FR']);
  assert.deepEqual(s.pendingCountries, []);
  assert.equal(store._files.size, 0);
});

const sniff = (buf) => (buf[0] === 0xff && buf[1] === 0xd8 ? 'jpeg' : 'other');
