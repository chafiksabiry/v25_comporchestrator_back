/**
 * Appel à l'API Claude (SDK officiel, chargé à la demande). `client` est injectable pour les tests.
 * Le paramètre « effort » n'est envoyé que s'il est configuré, pour ne dépendre d'aucune option propre à un modèle.
 * `outputFormat` (facultatif) : sortie structurée (`output_config.format`, schéma JSON strict), utilisée par la vérification
 * d'identité (src/services/identity/extract.js). Sans lui, la requête est identique à celle de l'agent SalesIQ.
 */
export function createClaudeClient({ cfg, client = null }) {
  let sdk = client;
  const getSdk = async () => {
    if (!sdk) {
      if (!cfg.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      sdk = new Anthropic({ apiKey: cfg.anthropicApiKey, maxRetries: 1, timeout: cfg.claudeTimeoutMs });
    }
    return sdk;
  };
  return {
    model: cfg.model,
    async createMessage({ system, messages, tools, outputFormat }) {
      const params = { model: cfg.model, max_tokens: cfg.maxTokens, system, messages, tools };
      if (cfg.effort) params.output_config = { effort: cfg.effort };
      if (outputFormat) params.output_config = { ...(params.output_config || {}), format: outputFormat };
      return (await getSdk()).messages.create(params);
    },
  };
}
