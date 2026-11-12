import Anthropic from '@anthropic-ai/sdk';
import { getWhatsAppConfig } from './config.js';

/**
 * Appel à l'API Claude (SDK officiel). Les paramètres suivent le modèle par défaut claude-opus-5-5 :
 * réflexion adaptative (non désactivable sur ce modèle), effort réglable, aucun paramètre d'échantillonnage.
 * `client` est injectable pour les tests.
 */
export function createClaudeClient({ config = getWhatsAppConfig(), client = null } = {}) {
  let sdk = client;
  const getSdk = () => {
    if (!sdk) {
      if (!config.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
      sdk = new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 2, timeout: 60_000 });
    }
    return sdk;
  };

  return {
    model: config.model,
    /**
     * @param {{system: Array, messages: Array, tools: Array}} p
     * @returns {Promise<import('@anthropic-ai/sdk').Anthropic.Message>}
     */
    async createMessage({ system, messages, tools }) {
      const params = {
        model: config.model,
        max_tokens: config.maxTokens,
        system,
        messages,
        tools,
        output_config: { effort: config.effort },
      };
      const api = getSdk();
      if (config.refusalFallback) {
        return api.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
      }
      return api.messages.create(params);
    },
  };
}
