import { getSalesIqConfig, missingConfig } from './config.js';
import { loadKnowledge } from './knowledge.js';
import { createZohoClient } from './zohoClient.js';
import { createClaudeClient } from './claudeClient.js';
import { createToolRunner } from './tools.js';
import { createVisitorKb, DEFAULT_KB_TOPICS } from './kb.js';
import { createAgent } from './agent.js';
import { createSalesIqRouter } from './routes.js';

/**
 * Assemble l'agent de support SalesIQ (webhook Zobot -> Claude -> réponse en temps réel).
 * Toutes les dépendances sont substituables (tests) ; en production seuls les réglages d'environnement comptent.
 * Mode par défaut : « off » (le webhook transfère tout aux opérateurs). Voir docs/SALESIQ_SUPPORT_AGENT.md.
 */
export function createSalesIqModule(overrides = {}) {
  const cfg = overrides.cfg || getSalesIqConfig();
  const logger = overrides.logger || console;
  const knowledge = overrides.knowledge || loadKnowledge();
  const zoho = overrides.zoho || createZohoClient({ cfg, logger });
  const claude = overrides.claude || createClaudeClient({ cfg });
  const kb = overrides.kb || createVisitorKb({ topics: cfg.kbTopics.length ? cfg.kbTopics : DEFAULT_KB_TOPICS });
  const tools = overrides.tools || createToolRunner({ zoho, kb, logger });
  const agent = createAgent({ cfg, claude, zoho, tools, knowledge, kb, logger });
  const router = createSalesIqRouter({ agent, cfg, logger });
  const missing = missingConfig(cfg);
  logger.log?.(`[salesiq] support agent ready (mode ${cfg.mode}, model ${cfg.model}, ${kb.size} knowledge chunks)${missing.length ? `, missing config: ${missing.join(', ')}` : ''}`);
  return { router, agent, cfg, zoho };
}

export { getSalesIqConfig, missingConfig };
