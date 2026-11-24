import { getSupportAgentConfig, supportAgentBlockers } from './config.js';
import { createSupportAgent } from './agent.js';
import { createMongoCaseStore } from './caseStore.js';
import { createAccountReader, createRefResolver } from './accountReader.js';
import { mountSupportAgentRoutes } from './routes.js';
import { createClaudeClient } from '../../salesiq/claudeClient.js';
import { resolveAccess } from '../../whatsapp/identity.js';
import { getSupportGmailConfig, supportGmailBlockers } from '../gmail/config.js';
import { createGmailClient } from '../gmail/client.js';
import { createGmailPoller, createMongoThreadStore } from '../gmail/poller.js';
import { defaultHttp } from '../../integrations/http.js';
import { senderEmail } from '../../services/emailService.js';

/**
 * Assemble l'agent support (et, s'il est activé, la relève de support@harx.ai) autour de l'Inbox existante.
 * Toutes les dépendances sont substituables (tests). Sans SUPPORT_AGENT_ENABLED, l'agent ne fait rien : les routes d'administration
 * répondent quand même (état « désactivé »), et l'Inbox reste exactement celle d'avant.
 */
export function createSupportDesk({ store, kb, whatsapp, notify, waCfg, overrides = {}, logger = console }) {
  const cfg = overrides.agentCfg || getSupportAgentConfig();
  const gmailCfg = overrides.gmailCfg || getSupportGmailConfig();
  const cases = overrides.cases || createMongoCaseStore();
  const http = overrides.http || defaultHttp;

  let gmail = null;
  if (gmailCfg.enabled) {
    const missing = supportGmailBlockers(gmailCfg);
    if (missing.length) logger.warn?.(`[support-gmail] activé mais incomplet : ${missing.join(', ')}`);
    else gmail = overrides.gmail || createGmailClient({ cfg: gmailCfg, http });
  }
  // Relève créée après l'agent (elle lui confie chaque e-mail) ; l'agent l'utilise pour répondre dans le fil : référence tardive.
  let poller = null;

  const claude = overrides.claude !== undefined ? overrides.claude
    : (cfg.anthropicApiKey ? createClaudeClient({ cfg: { anthropicApiKey: cfg.anthropicApiKey, model: cfg.model, effort: cfg.effort, maxTokens: cfg.maxTokens, claudeTimeoutMs: cfg.claudeTimeoutMs } }) : null);
  const accountReader = overrides.accountReader || createAccountReader({ logger });
  const resolveRef = overrides.resolveRef || createRefResolver({ length: cfg.accountRefLength });
  const resolveCompany = overrides.resolveCompany || (async (conv, { accountRef }) => {
    // 1) Compte lié par code à usage unique (WhatsApp) : identité PROUVÉE, société relue auprès du service d'inscription.
    if (conv.linkedUserId) {
      const origin = (process.env.REGISTRATION_BACKEND_URL || '').replace(/\/+$/, '').replace(/\/api$/, '');
      const access = await resolveAccess(conv.linkedUserId, { registrationOrigin: origin, secret: waCfg?.jwtSecret || process.env.JWT_SECRET, fetchImpl: overrides.fetchImpl });
      return { companyId: access.companyId, verified: Boolean(access.companyId) };
    }
    // 2) Référence courte citée : diagnostic interne seulement (identité NON prouvée).
    if (accountRef) return { companyId: await resolveRef(accountRef), verified: false };
    return { companyId: null, verified: false };
  });
  const senders = overrides.senders || {
    whatsapp: async (conv, text) => { await whatsapp.sendText(conv.waId, text); },
    web: async () => {}, // le navigateur relit l'historique de la conversation
    ...(gmail ? { email: (conv, text) => poller.reply(conv, text) } : {}),
  };
  const agent = createSupportAgent({
    cfg, store, cases, claude, kb, accountReader, resolveCompany, senders, notify, logger,
    contacts: { supportNumber: waCfg?.supportNumber || '', customerEmail: gmail ? (conv) => poller.customerEmail(conv) : null },
  });
  if (gmail) poller = createGmailPoller({ cfg: gmailCfg, gmail, store, threads: overrides.threads || createMongoThreadStore(), agent: cfg.enabled ? agent : null, notifierSender: senderEmail(), logger });

  if (cfg.enabled) {
    const missing = supportAgentBlockers(cfg);
    logger.log?.(`[support-agent] actif (mode ${cfg.mode}, modèle ${cfg.model})${missing.length ? ` mais incomplet : ${missing.join(', ')} (toute demande sera escaladée)` : ''}`);
  }
  const escalationDelayMs = overrides.escalationDelayMs ?? Math.max(0, Number(process.env.SUPPORT_AGENT_ESCALATION_DELAY_MS ?? 15000) || 0);
  /** Escalade de l'assistant : l'agent passe après la réponse de l'assistant au client (délai court), sans jamais la bloquer. */
  const onEscalation = (ticket) => {
    if (!cfg.enabled) return;
    const t = setTimeout(() => { void agent.onEscalation(ticket); }, escalationDelayMs);
    if (t.unref) t.unref();
  };

  return {
    cfg, gmailCfg, agent, cases, onEscalation, gmail: poller,
    replyEmail: poller ? (conv, text) => poller.reply(conv, text) : null,
    mount: (router, admin) => mountSupportAgentRoutes(router, admin, { agent, cases, store, cfg, gmailCfg, logger }),
  };
}

/** Passages périodiques (index.js) : agent toutes les SUPPORT_AGENT_SWEEP_MINUTES, relève Gmail toutes les SUPPORT_GMAIL_POLL_MINUTES. */
export function startSupportDeskJobs(desk, { isReady = () => true, logger = console } = {}) {
  const timers = [];
  if (desk?.cfg?.enabled) {
    timers.push(setInterval(() => { if (isReady()) desk.agent.sweep().catch((e) => logger.warn?.(`[support-agent] passage : ${e?.message || e}`)); }, desk.cfg.sweepMinutes * 60 * 1000));
  }
  if (desk?.gmail) {
    timers.push(setInterval(() => { if (isReady()) desk.gmail.poll().catch((e) => logger.warn?.(`[support-gmail] relève : ${e?.message || e}`)); }, desk.gmailCfg.pollMinutes * 60 * 1000));
  }
  for (const t of timers) t.unref?.();
  return () => timers.forEach(clearInterval);
}
