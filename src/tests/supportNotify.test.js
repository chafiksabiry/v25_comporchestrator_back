// Run: node --test src/tests/supportNotify.test.js
// Notification immédiate de l'équipe support (décision du 24/11/2026) : chaque escalade de l'assistant (WhatsApp, chat du site) et
// chaque dossier d'identité passé en revue humaine crée une demande dans l'Inbox admin et prévient support@ par e-mail (envoi Brevo
// du serveur) et par webhook s'il est configuré. Aucun appel réseau réel : e-mail et webhook simulés.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSupportNotifier, buildNotification, emailBlockers, escalationRequest, supportNotifyConfig, SUPPORT_INBOX_URL_DEFAULT } from '../support/notify.js';
import { createIdentityInboxReporter, identityConversationId, isIdentityConversation } from '../support/inboxRequests.js';
import { getWhatsAppConfig } from '../whatsapp/config.js';
import { createWhatsAppModule } from '../whatsapp/index.js';
import { createMemoryStore as createInboxStore } from '../whatsapp/store/memoryStore.js';
import { loadKnowledgeBase } from '../whatsapp/knowledge/index.js';
import { createScriptedClaude } from './whatsappHarness.js';
import { createIdentityService } from '../services/identity/service.js';
import { createMemoryStore as createIdentityStore } from '../services/identity/store.js';
import { getIdentityConfig } from '../services/identity/config.js';
import { DECLARED, TEST_KEY } from './identityFixtures.js';

const quiet = { log() {}, warn() {}, error() {} };
const FULL_ENV = { SUPPORT_EMAIL: 'support@harx.ai', BREVO_API_KEY: 'xkeysib-test', BREVO_SENDER_EMAIL: 'noreply@harx.ai', WHATSAPP_SUPPORT_NOTIFY_WEBHOOK_URL: 'https://hooks.example.test/support' };
const TICKET = { id: 't1', waId: '212600000001', reason: 'payment_dispute', summary: 'Le client conteste un prélèvement.', urgency: 'high', language: 'fr', linkedUserId: 'u1' };

function fakes({ mailFails = false, webhookStatus = 200 } = {}) {
  const mails = [];
  const posts = [];
  return {
    mails, posts,
    mail: async (payload) => { if (mailFails) throw new Error('Brevo : quota'); mails.push(payload); return { messageId: 'm1' }; },
    fetchImpl: async (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); return { ok: webhookStatus < 300, status: webhookStatus }; },
  };
}

test('escalade : e-mail à SUPPORT_EMAIL par Brevo et webhook, tous deux immédiats', async () => {
  const f = fakes();
  const notify = createSupportNotifier({ env: FULL_ENV, mail: f.mail, fetchImpl: f.fetchImpl, logger: quiet });
  const out = await notify(escalationRequest(TICKET));
  assert.deepEqual(out, { email: 'sent', webhook: 'sent', delivered: true });
  assert.equal(f.mails.length, 1);
  assert.deepEqual(f.mails[0].to, [{ email: 'support@harx.ai' }]);
  assert.equal(f.mails[0].sender.email, 'noreply@harx.ai');
  assert.match(f.mails[0].subject, /Nouvelle demande escaladée — WhatsApp \(urgence haute\)/);
  assert.match(f.mails[0].textContent, /Motif : payment_dispute/);
  assert.match(f.mails[0].textContent, /Le client conteste un prélèvement\./);
  assert.match(f.mails[0].textContent, new RegExp(`Traiter la demande : ${SUPPORT_INBOX_URL_DEFAULT}`));
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].url, FULL_ENV.WHATSAPP_SUPPORT_NOTIFY_WEBHOOK_URL);
  assert.match(f.posts[0].body.text, /demande t1/);
});

test('chat du site : canal « Chat du site », jamais de numéro', () => {
  const req = escalationRequest({ ...TICKET, waId: 'web:abc' });
  const { subject, text } = buildNotification(req, supportNotifyConfig(FULL_ENV));
  assert.match(subject, /Chat du site/);
  assert.match(text, /visiteur du site/);
  assert.doesNotMatch(text, /\+web/);
});

test('sans BREVO_API_KEY : e-mail non envoyé, variables manquantes nommées ; le webhook part quand même', async () => {
  const f = fakes();
  const warns = [];
  const env = { ...FULL_ENV, BREVO_API_KEY: '' };
  const notify = createSupportNotifier({ env, mail: f.mail, fetchImpl: f.fetchImpl, logger: { ...quiet, warn: (m) => warns.push(m) } });
  const out = await notify(escalationRequest(TICKET));
  assert.equal(out.email, 'not_configured');
  assert.equal(out.webhook, 'sent');
  assert.equal(out.delivered, true);
  assert.equal(f.mails.length, 0);
  assert.deepEqual(emailBlockers(env), ['BREVO_API_KEY (ou SMTP_HOST, SMTP_USER, SMTP_PASS)']);
  assert.ok(warns.some((w) => /BREVO_API_KEY/.test(w)));
  assert.deepEqual(emailBlockers({}), ['SUPPORT_EMAIL', 'BREVO_API_KEY (ou SMTP_HOST, SMTP_USER, SMTP_PASS)']);
  assert.deepEqual(emailBlockers({ SUPPORT_EMAIL: 'support@harx.ai', SMTP_HOST: 'h', SMTP_USER: 'u@harx.ai', SMTP_PASS: 'p' }), []);
});

test('aucune voie configurée : rien n’est envoyé, delivered = false (l’assistant ne dit pas que l’équipe est prévenue)', async () => {
  const f = fakes();
  const out = await createSupportNotifier({ env: {}, mail: f.mail, fetchImpl: f.fetchImpl, logger: quiet })(escalationRequest(TICKET));
  assert.deepEqual(out, { email: 'not_configured', webhook: 'not_configured', delivered: false });
  assert.equal(f.mails.length + f.posts.length, 0);
});

test('une voie en échec n’empêche pas l’autre', async () => {
  const a = fakes({ mailFails: true });
  assert.deepEqual(await createSupportNotifier({ env: FULL_ENV, mail: a.mail, fetchImpl: a.fetchImpl, logger: quiet })(escalationRequest(TICKET)), { email: 'failed', webhook: 'sent', delivered: true });
  const b = fakes({ webhookStatus: 500 });
  assert.deepEqual(await createSupportNotifier({ env: FULL_ENV, mail: b.mail, fetchImpl: b.fetchImpl, logger: quiet })(escalationRequest(TICKET)), { email: 'sent', webhook: 'failed', delivered: true });
});

function whatsappModule(notifier) {
  const cfg = getWhatsAppConfig({ WHATSAPP_PHONE_NUMBER_ID: 'P', WHATSAPP_ACCESS_TOKEN: 'T', WHATSAPP_VERIFY_TOKEN: 'V', WHATSAPP_APP_SECRET: 'S', WHATSAPP_ADMIN_API_KEY: 'A', ANTHROPIC_API_KEY: 'unused', SUPPORT_EMAIL: 'support@harx.ai' });
  const store = createInboxStore();
  const mod = createWhatsAppModule({ cfg, store, claude: createScriptedClaude(), kb: loadKnowledgeBase(), logger: quiet, getPlans: async () => [], registrationOrigin: () => '', supportNotifier: notifier, mirror: null });
  return { mod, store };
}

test('assistant : escalate_to_human crée le ticket de l’Inbox et prévient l’équipe (e-mail support@)', async () => {
  const f = fakes();
  const notifier = createSupportNotifier({ env: FULL_ENV, mail: f.mail, fetchImpl: f.fetchImpl, logger: quiet });
  const { mod, store } = whatsappModule(notifier);
  await store.getOrCreateConversation('212600000009', { profileName: 'Client' });
  const out = await mod.tools.execute('escalate_to_human', { reason: 'refund', summary: 'Demande de remboursement', urgency: 'normal' }, { waId: '212600000009' });
  assert.equal(out.ticket_created, true);
  assert.equal(out.support_team_notified, true);
  assert.match(out.note, /support@harx\.ai/);
  const tickets = await store.listTickets({});
  assert.equal(tickets.length, 1);
  assert.equal((await store.getConversation('212600000009')).handoff.active, true);
  assert.equal(f.mails.length, 1);
  assert.match(f.mails[0].textContent, new RegExp(`Demande n° ${tickets[0].id}`));
});

test('assistant : aucune voie configurée → ticket créé, support_team_notified = false', async () => {
  const { mod, store } = whatsappModule(createSupportNotifier({ env: {}, logger: quiet }));
  await store.getOrCreateConversation('web:s1', {});
  const out = await mod.tools.execute('escalate_to_human', { reason: 'bug', summary: 'x' }, { waId: 'web:s1' });
  assert.equal(out.ticket_created, true);
  assert.equal(out.support_team_notified, false);
});

// ---------------- Revue humaine d'identité ----------------

function identitySetup() {
  const inboxStore = createInboxStore();
  const sent = [];
  const reporter = createIdentityInboxReporter({ getDesk: () => ({ store: inboxStore }), notify: async (r) => { sent.push(r); return { email: 'sent', webhook: 'not_configured', delivered: true }; }, env: { PUBLIC_API_BASE_URL: 'https://co.test', SUPPORT_INBOX_URL: 'https://admin.test/admin/inbox' }, logger: quiet });
  const store = createIdentityStore();
  const pending = [];
  const inbox = { opened: (...a) => { const p = reporter.opened(...a); pending.push(p); return p; }, decided: (...a) => { const p = reporter.decided(...a); pending.push(p); return p; } };
  const svc = createIdentityService({
    store, inbox, logger: quiet, sharp: null, schedule: () => {},
    config: () => ({ ...getIdentityConfig({ IDENTITY_FILES_ENC_KEY: TEST_KEY, ANTHROPIC_API_KEY: '' }), enabled: true }),
  });
  const flush = async () => { await new Promise((r) => setImmediate(r)); await Promise.all(pending); };
  return { inboxStore, sent, store, svc, flush };
}

test('identité : « demander une vérification par l’équipe » crée une demande Inbox et la notification, une seule fois', async () => {
  const t = identitySetup();
  const v = await t.store.createVerification({ companyId: 'c1', userId: 'u1', status: 'rejected', docType: 'passport', declared: DECLARED, decision: { outcome: 'rejected', reasonCodes: ['PROOF_TOO_OLD'] } });
  assert.deepEqual(await t.svc.requestReview('c1'), { status: 'review' });
  await t.flush();
  const convId = identityConversationId(v._id);
  assert.ok(isIdentityConversation(convId));
  const conv = await t.inboxStore.getConversation(convId);
  assert.equal(conv.handoff.active, true, 'dans « À traiter »');
  assert.equal(conv.messages.length, 1);
  assert.equal(conv.messages[0].role, 'system');
  assert.match(conv.messages[0].text, /demande une vérification par l’équipe/);
  assert.doesNotMatch(conv.messages[0].text, new RegExp(DECLARED.fullName), 'aucun nom de la déclaration');
  const tickets = await t.inboxStore.listTickets({});
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].reason, 'identity_review');
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].kind, 'identity_review');
  assert.equal(t.sent[0].ticketId, tickets[0].id);
  assert.ok(t.sent[0].links.some((l) => /^https:\/\/admin\.test\/admin\/identity\?dossier=.+/.test(l.url)), 'lien vers la page Identité du portail, dossier ouvert');
  assert.ok(t.sent[0].details.includes('Société : c1'));
  // Le même dossier ne crée ni doublon ni seconde notification.
  await createIdentityInboxReporter({ getDesk: () => ({ store: t.inboxStore }), notify: async (r) => { t.sent.push(r); return {}; }, logger: quiet }).opened(await t.store.getVerification(v._id), { trigger: 'HUMAN_REVIEW_REQUESTED' });
  assert.equal((await t.inboxStore.listTickets({})).length, 1);
  assert.equal(t.sent.length, 1);
});

test('identité : la décision de l’équipe ferme la demande (ticket résolu, plus « À traiter »)', async () => {
  const t = identitySetup();
  const v = await t.store.createVerification({ companyId: 'c2', status: 'rejected', docType: 'passport', declared: DECLARED, decision: { outcome: 'rejected', reasonCodes: ['UNREADABLE'] } });
  await t.svc.requestReview('c2');
  await t.flush();
  await t.svc.adminDecide(v._id, 'adm1', { outcome: 'rejected', reasonCode: 'DOCUMENT_SUSPECTED' });
  await t.flush();
  const conv = await t.inboxStore.getConversation(identityConversationId(v._id));
  assert.equal(conv.handoff.active, false);
  assert.equal((await t.inboxStore.listTickets({}))[0].status, 'resolved');
  assert.match(conv.messages.at(-1).text, /Décision de l’équipe : rejected/);
});

test('identité : analyse en échec, analyse interrompue, revue demandée par l’analyse → demande + notification à chaque dossier', async () => {
  const t = identitySetup();
  // Erreur interne pendant l'analyse (fichiers illisibles) : revue humaine.
  const a = await t.store.createVerification({ companyId: 'c3', status: 'processing', docType: 'passport', declared: DECLARED });
  await t.store.createFile({ verificationId: String(a._id), companyId: 'c3', kind: 'passport', mime: 'image/jpeg', data: Buffer.from('pas chiffré') });
  const r = await t.svc.process(String(a._id));
  assert.equal(r.outcome, 'review');
  // Analyse interrompue par un redémarrage.
  const b = await t.store.createVerification({ companyId: 'c4', status: 'processing', docType: 'passport', declared: DECLARED, processingStartedAt: new Date(Date.now() - 3600 * 1000) });
  await t.svc.recoverStale();
  // Analyse terminée avec une décision « revue humaine » (ici : sortie de l'IA inexploitable, aucun fichier).
  const c = await t.store.createVerification({ companyId: 'c6', status: 'processing', docType: 'passport', declared: DECLARED });
  assert.deepEqual(await t.svc.process(String(c._id)), { outcome: 'review', reasonCodes: ['AI_INVALID_OUTPUT'] });
  await t.flush();
  const ids = (await t.inboxStore.listConversations({ channel: 'identity' })).map((x) => x.waId).sort();
  assert.deepEqual(ids, [identityConversationId(a._id), identityConversationId(b._id), identityConversationId(c._id)].sort());
  assert.deepEqual(t.sent.map((s) => s.reason).sort(), ['analyse interrompue (redémarrage du serveur)', 'erreur interne pendant l’analyse', 'l’analyse automatique demande une revue humaine'].sort());
  // Les demandes d'identité ne sont jamais rangées dans « WhatsApp ».
  assert.equal((await t.inboxStore.listConversations({ channel: 'whatsapp' })).length, 0);
});

test('identité : une demande Inbox impossible ne change jamais le parcours du client', async () => {
  const store = createIdentityStore();
  const svc = createIdentityService({ store, logger: quiet, sharp: null, schedule: () => {}, inbox: { opened: async () => { throw new Error('inbox down'); }, decided: async () => { throw new Error('inbox down'); } }, config: () => ({ ...getIdentityConfig({ IDENTITY_FILES_ENC_KEY: TEST_KEY, ANTHROPIC_API_KEY: '' }), enabled: true }) });
  await store.createVerification({ companyId: 'c5', status: 'rejected', docType: 'passport', declared: DECLARED, decision: { outcome: 'rejected', reasonCodes: ['UNREADABLE'] } });
  assert.deepEqual(await svc.requestReview('c5'), { status: 'review' });
  await new Promise((r) => setImmediate(r));
});

test('lien Identité : dans le portail d’administration, jamais la page du serveur', async () => {
  const { adminIdentityUrl } = await import('../support/inboxRequests.js');
  assert.equal(adminIdentityUrl({ SUPPORT_INBOX_URL: 'https://harx26register-recette.netlify.app/admin/inbox' }, 'abc'), 'https://harx26register-recette.netlify.app/admin/identity?dossier=abc');
  assert.equal(adminIdentityUrl({}, ''), 'https://harx.ai/admin/identity');
  assert.equal(adminIdentityUrl({ SUPPORT_INBOX_URL: 'https://harx.ai/autre' }, 'x'), 'https://harx.ai/admin/identity?dossier=x');
});
