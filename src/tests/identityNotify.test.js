// Run: JWT_SECRET=t node --test src/tests/identityNotify.test.js
// Signal temps réel « statut d'identité changé » : émis à la fin de l'analyse automatique et à chaque décision de l'équipe HARX,
// pour la seule société concernée, sans contenu personnel. La page ouverte du portail relit alors GET /status (sans rechargement).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';

const { createIdentityService } = await import('../services/identity/service.js');
const { createMemoryStore } = await import('../services/identity/store.js');
const { getIdentityConfig } = await import('../services/identity/config.js');
const { createClaudeClient } = await import('../salesiq/claudeClient.js');
const { IDENTITY_DOCUMENT_SCHEMA } = await import('../services/identity/schemas.js');
const { identityStatusEvent, IDENTITY_STATUS_EVENT, notifyIdentityChanged } = await import('../services/identity/notify.js');
const { broadcastUpdate } = await import('../websocket/escrowUpdates.js');
const { DECLARED, fakeJpeg, fakePdf, idExtraction, proofExtraction, TEST_KEY } = await import('./identityFixtures.js');

const A = '64b0000000000000000000a1';
const B = '64b0000000000000000000b2';
const flush = () => new Promise((r) => setImmediate(r));

let store; let queue; let sent; let declared; let svc;
const cfg = () => ({ ...getIdentityConfig({ IDENTITY_FILES_ENC_KEY: TEST_KEY, ANTHROPIC_API_KEY: '' }), enabled: true });
const sdk = {
  messages: {
    async create(params) {
      const d = params.output_config.format.schema === IDENTITY_DOCUMENT_SCHEMA ? idExtraction() : proofExtraction();
      return { id: 'msg', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(d) }], usage: { input_tokens: 10, output_tokens: 10 } };
    },
  },
};
const clock = new Date('2026-11-22T10:00:00Z');

beforeEach(() => {
  store = createMemoryStore({ now: () => clock }); queue = []; sent = []; declared = { ...DECLARED };
  svc = createIdentityService({
    store, config: cfg, now: () => clock, sharp: null, logger: { log() {}, error() {}, warn() {} },
    claudeClient: createClaudeClient({ cfg: { ...cfg(), anthropicApiKey: 'unused' }, client: sdk }),
    loadDeclaration: async () => ({ ...declared }), schedule: (fn) => queue.push(fn),
    inbox: { opened: async () => {}, decided: async () => {} },
    notify: async (companyId, status) => { sent.push({ companyId, status }); },
  });
});

async function submitAndAnalyse(companyId = A) {
  await svc.upload(companyId, 'u1', { kind: 'passport', docType: 'passport', buffer: fakeJpeg() });
  await svc.upload(companyId, 'u1', { kind: 'address_proof', docType: 'passport', buffer: fakePdf() });
  await svc.submit({}, companyId, 'u1');
  while (queue.length) await queue.shift()();
  await flush();
}

test('analyse automatique finie (validé) : un signal pour la société, avec le statut', async () => {
  await submitAndAnalyse();
  assert.deepEqual(sent, [{ companyId: A, status: 'approved' }]);
});

test('revue humaine puis validation par l’équipe : signal « review » puis « approved », société seule', async () => {
  declared = { ...DECLARED, fullName: 'Paul Martin' };
  await submitAndAnalyse();
  assert.deepEqual(sent, [{ companyId: A, status: 'review' }]);
  const id = (await svc.adminList('review'))[0].id;
  await svc.adminDecide(id, 'adm1', { outcome: 'approved', residence: 'FR' });
  await flush();
  assert.deepEqual(sent.at(-1), { companyId: A, status: 'approved' });
  assert.equal(sent.every((e) => e.companyId === A), true);
});

test('refus par l’équipe : signal « rejected » ; décision invalide : aucun signal', async () => {
  declared = { ...DECLARED, fullName: 'Paul Martin' };
  await submitAndAnalyse();
  const id = (await svc.adminList('review'))[0].id;
  const before = sent.length;
  await assert.rejects(svc.adminDecide(id, 'adm1', { outcome: 'rejected', reasonCode: 'NOPE' }));
  await flush();
  assert.equal(sent.length, before);
  await svc.adminDecide(id, 'adm1', { outcome: 'rejected', reasonCode: 'NAME_MISMATCH' });
  await flush();
  assert.deepEqual(sent.at(-1), { companyId: A, status: 'rejected' });
});

test('signal en échec : jamais bloquant pour la décision', async () => {
  declared = { ...DECLARED, fullName: 'Paul Martin' };
  svc = createIdentityService({
    store, config: cfg, now: () => clock, sharp: null, logger: { log() {}, error() {}, warn() {} },
    claudeClient: createClaudeClient({ cfg: { ...cfg(), anthropicApiKey: 'unused' }, client: sdk }),
    loadDeclaration: async () => ({ ...declared }), schedule: (fn) => queue.push(fn),
    inbox: { opened: async () => {}, decided: async () => {} },
    notify: async () => { throw new Error('canal fermé'); },
  });
  await submitAndAnalyse();
  const id = (await svc.adminList('review'))[0].id;
  const r = await svc.adminDecide(id, 'adm1', { outcome: 'approved', residence: 'FR' });
  assert.equal(r.status, 'approved');
});

test('évènement sans contenu personnel, diffusé aux seules connexions de la société', () => {
  const ev = identityStatusEvent(A, 'approved');
  assert.deepEqual(ev, { type: IDENTITY_STATUS_EVENT, companyId: A, status: 'approved' });
  const got = { a: [], b: [], agent: [] };
  const client = (access, box) => ({ readyState: 1, escrowAccess: access, send: (m) => box.push(JSON.parse(m)) });
  const clients = new Set([
    client({ userId: 'u1', companyId: A, role: 'owner' }, got.a),
    client({ userId: 'u2', companyId: B, role: 'owner' }, got.b),
    client({ userId: 'u3', companyId: A, role: 'agent', agentIds: ['r1'] }, got.agent),
  ]);
  assert.equal(broadcastUpdate(ev, clients), 1);
  assert.deepEqual(got.a, [ev]);
  assert.deepEqual(got.b, []);
  assert.deepEqual(got.agent, []);
});

test('notifyIdentityChanged : sans société, rien n’est envoyé', async () => {
  assert.equal(await notifyIdentityChanged('', 'approved'), 0);
});
