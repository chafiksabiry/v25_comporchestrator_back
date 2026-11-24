import { getWhatsAppConfig, missingConfig } from './config.js';
import { loadKnowledgeBase } from './knowledge/index.js';
import { createWhatsAppClient } from './whatsappClient.js';
import { createClaudeClient } from './claudeClient.js';
import { createToolRunner, defaultGetPlans, defaultLoadAccountOverview } from './tools.js';
import { createAgent } from './agent.js';
import { createWhatsAppRouter } from './routes.js';
import { createMongoStore } from './store/mongoStore.js';
import { createWebChatRouter } from './webChat.js';
import { createInboxBus, withInboxEvents } from './events.js';
import { createWebMirror } from './webMirror.js';
import { sharedSupportNotifier, escalationRequest } from '../support/notify.js';

/**
 * Assemble le module WhatsApp AI Assistant. Toutes les dépendances sont substituables (tests) ;
 * en production, seuls les réglages d'environnement comptent.
 *
 * @returns {{ router: import('express').Router, agent: object, cfg: object, kb: object, store: object }}
 */
export function createWhatsAppModule(overrides = {}) {
  const cfg = overrides.cfg || getWhatsAppConfig();
  const logger = overrides.logger || console;
  // Le store est enveloppé pour signaler à l'Inbox (WebSocket /support-inbox) tout nouveau message, transfert, ticket ou suppression.
  const events = overrides.events || createInboxBus();
  const store = withInboxEvents(overrides.store || createMongoStore(), events);
  const kb = overrides.kb || loadKnowledgeBase();
  const whatsapp = overrides.whatsapp || createWhatsAppClient({ config: cfg, logger });
  const claude = overrides.claude || createClaudeClient({ config: cfg });

  // Chaque escalade prévient l'équipe tout de suite : e-mail à SUPPORT_EMAIL (envoi Brevo du serveur) et webhook
  // WHATSAPP_SUPPORT_NOTIFY_WEBHOOK_URL s'il est défini (src/support/notify.js). « Prévenue » = au moins une voie a abouti.
  const notifier = overrides.supportNotifier || sharedSupportNotifier();
  const notifySupport = overrides.notifySupport || (async (ticket) => {
    const out = await notifier(escalationRequest(ticket));
    if (!out.delivered) throw new Error(`support not notified (email ${out.email}, webhook ${out.webhook})`);
  });

  const tools = overrides.tools || createToolRunner({
    kb, store, cfg,
    getPlans: overrides.getPlans || defaultGetPlans,
    loadAccountOverview: overrides.loadAccountOverview || defaultLoadAccountOverview,
    registrationOrigin: overrides.registrationOrigin || (() => (process.env.REGISTRATION_BACKEND_URL || '').replace(/\/+$/, '').replace(/\/api$/, '')),
    fetchImpl: overrides.fetchImpl,
    notifySupport,
  });
  const agent = createAgent({ store, claude, whatsapp, kb, tools, cfg, logger });
  const router = createWhatsAppRouter({ agent, store, whatsapp, kb, cfg, logger, auth: overrides.auth });
  // Chat sur le site (sans redirection vers l'application WhatsApp) : même agent, transport sans réseau.
  const mirror = overrides.mirror !== undefined ? overrides.mirror : createWebMirror({ whatsapp, cfg, logger });
  const webChat = createWebChatRouter({ store, claude, kb, tools, cfg, logger, mirror });
  router.use('/web-chat', webChat.router);

  const missing = missingConfig(cfg);
  if (cfg.enabled && missing.length) logger.warn(`[whatsapp] module mounted but incomplete: missing ${missing.join(', ')}`);
  logger.log?.(`[whatsapp] AI assistant ready (model ${cfg.model}, ${kb.size} knowledge chunks, store ${store.kind})`);
  return { router, agent, webAgent: webChat.agent, cfg, kb, store, tools, events, notifier };
}

export { getWhatsAppConfig, missingConfig };
