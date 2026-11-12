import { getWhatsAppConfig, missingConfig } from './config.js';
import { loadKnowledgeBase } from './knowledge/index.js';
import { createWhatsAppClient } from './whatsappClient.js';
import { createClaudeClient } from './claudeClient.js';
import { createToolRunner, defaultGetPlans, defaultLoadAccountOverview } from './tools.js';
import { createAgent } from './agent.js';
import { createWhatsAppRouter } from './routes.js';
import { createMongoStore } from './store/mongoStore.js';

/**
 * Assemble le module WhatsApp AI Assistant. Toutes les dépendances sont substituables (tests) ;
 * en production, seuls les réglages d'environnement comptent.
 *
 * @returns {{ router: import('express').Router, agent: object, cfg: object, kb: object, store: object }}
 */
export function createWhatsAppModule(overrides = {}) {
  const cfg = overrides.cfg || getWhatsAppConfig();
  const logger = overrides.logger || console;
  const store = overrides.store || createMongoStore();
  const kb = overrides.kb || loadKnowledgeBase();
  const whatsapp = overrides.whatsapp || createWhatsAppClient({ config: cfg, logger });
  const claude = overrides.claude || createClaudeClient({ config: cfg });

  const notifySupport = overrides.notifySupport || (cfg.notifyWebhookUrl
    ? async (ticket) => {
        const res = await fetch(cfg.notifyWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `[HARX WhatsApp support] ticket ${ticket.id} (${ticket.urgency}) from +${ticket.waId}: ${ticket.reason}\n${ticket.summary}` }),
        });
        if (!res.ok) throw new Error(`notify webhook ${res.status}`);
      }
    : null);

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

  const missing = missingConfig(cfg);
  if (cfg.enabled && missing.length) logger.warn(`[whatsapp] module mounted but incomplete: missing ${missing.join(', ')}`);
  logger.log?.(`[whatsapp] AI assistant ready (model ${cfg.model}, ${kb.size} knowledge chunks, store ${store.kind})`);
  return { router, agent, cfg, kb, store, tools };
}

export { getWhatsAppConfig, missingConfig };
