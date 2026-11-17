/**
 * Configuration de l'agent de support SalesIQ (HARX Support Chat Agent).
 * Toutes les valeurs sensibles viennent de variables d'environnement, jamais du code.
 * Lue à l'appel (et non à l'import) pour que les tests puissent changer l'environnement.
 */
const bool = (v, d = false) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));
const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

export const MODES = ['off', 'shadow', 'live'];

export function getSalesIqConfig(env = process.env) {
  const mode = String(env.SALESIQ_MODE || 'off').toLowerCase();
  return {
    /** off : le webhook transfère tout aux opérateurs ; shadow : brouillon en note interne, rien d'envoyé ; live : le bot répond. */
    mode: MODES.includes(mode) ? mode : 'off',
    screenname: env.SALESIQ_SCREENNAME || 'harxtechnologiesinc',
    operatorId: env.SALESIQ_OPERATOR_ID || '848837000000002002',
    // --- Authentification du webhook ---
    /** Secret partagé, à ajouter à l'URL du webhook : ?key=... */
    webhookKey: env.SALESIQ_WEBHOOK_KEY || '',
    /** Clé publique RSA (PEM) affichée par SalesIQ quand « Secure your webhook » est activé (en-tête x-siqsignature). */
    webhookPublicKey: String(env.SALESIQ_WEBHOOK_PUBLIC_KEY || '').replace(/\\n/g, '\n'),
    /** Accepte les webhooks non authentifiés (développement local UNIQUEMENT). */
    allowUnsigned: bool(env.SALESIQ_ALLOW_UNSIGNED, false),
    // --- Claude ---
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    model: env.SALESIQ_CLAUDE_MODEL || 'claude-sonnet-5-5',
    /** Vide = paramètre non envoyé. À régler (low / medium) après test sur le modèle choisi. */
    effort: env.SALESIQ_CLAUDE_EFFORT || '',
    maxTokens: int(env.SALESIQ_CLAUDE_MAX_TOKENS, 700),
    maxToolRounds: int(env.SALESIQ_MAX_TOOL_ROUNDS, 6),
    /** Rubriques de la base de connaissances accessibles aux visiteurs (identifiants, séparés par des virgules). Vide = valeurs par défaut. */
    kbTopics: String(env.SALESIQ_KB_TOPICS || '').split(',').map((x) => x.trim()).filter(Boolean),
    claudeTimeoutMs: int(env.SALESIQ_CLAUDE_TIMEOUT_MS, 45_000),
    /** Délai pendant lequel on attend Claude avant de répondre « pending » (SalesIQ coupe le webhook à 5 s). */
    syncBudgetMs: int(env.SALESIQ_SYNC_BUDGET_MS, 3500),
    // --- Zoho (un seul client OAuth « Self Client » avec jeton de rafraîchissement) ---
    zoho: {
      clientId: env.ZOHO_CLIENT_ID || '',
      clientSecret: env.ZOHO_CLIENT_SECRET || '',
      refreshToken: env.ZOHO_REFRESH_TOKEN || '',
      accountsUrl: (env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com').replace(/\/+$/, ''),
      salesiqUrl: (env.ZOHO_SALESIQ_API_URL || 'https://salesiq.zoho.com').replace(/\/+$/, ''),
      crmUrl: (env.ZOHO_CRM_API_URL || 'https://www.zohoapis.com').replace(/\/+$/, ''),
      crmPipeline: env.ZOHO_CRM_PIPELINE || 'Reps Pipeline',
    },
    // --- Conversations ---
    historyTurns: int(env.SALESIQ_HISTORY_TURNS, 12),
    historyTtlMs: int(env.SALESIQ_HISTORY_TTL_MINUTES, 45) * 60_000,
    maxInboundChars: int(env.SALESIQ_MAX_INBOUND_CHARS, 1500),
    rateLimitPerMinute: int(env.SALESIQ_RATE_LIMIT_PER_MINUTE, 8),
    rateLimitPerDay: int(env.SALESIQ_RATE_LIMIT_PER_DAY, 100),
    /** Journalise le texte des messages (RGPD : désactivé par défaut). */
    logMessageText: bool(env.SALESIQ_LOG_MESSAGE_TEXT, false),
    /** Journalise la STRUCTURE (noms de champs, jamais les valeurs) des webhooks reçus : utile au premier branchement. */
    logPayloadShape: bool(env.SALESIQ_LOG_PAYLOAD_SHAPE, false),
  };
}

/** Variables manquantes pour un fonctionnement complet selon le mode. */
export function missingConfig(cfg = getSalesIqConfig()) {
  const missing = [];
  if (!cfg.webhookKey && !cfg.webhookPublicKey && !cfg.allowUnsigned) missing.push('SALESIQ_WEBHOOK_KEY ou SALESIQ_WEBHOOK_PUBLIC_KEY');
  if (cfg.mode === 'off') return missing;
  if (!cfg.zoho.clientId) missing.push('ZOHO_CLIENT_ID');
  if (!cfg.zoho.clientSecret) missing.push('ZOHO_CLIENT_SECRET');
  if (!cfg.zoho.refreshToken) missing.push('ZOHO_REFRESH_TOKEN');
  if (!cfg.anthropicApiKey) missing.push('ANTHROPIC_API_KEY');
  return missing;
}
