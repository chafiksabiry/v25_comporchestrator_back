/**
 * Configuration du HARX WhatsApp AI Assistant.
 * Toutes les valeurs sensibles viennent de variables d'environnement (jamais du code).
 * Lue à l'appel (et non à l'import) pour que les tests puissent changer process.env.
 */
const bool = (v, d = false) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));
const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

export function getWhatsAppConfig(env = process.env) {
  return {
    enabled: bool(env.WHATSAPP_ENABLED, true),
    /** Numéro de support affiché sur le site (E.164 sans « + »). */
    supportNumber: String(env.WHATSAPP_SUPPORT_NUMBER || '212711311388').replace(/\D/g, ''),
    // --- WhatsApp Cloud API (Meta) ---
    graphVersion: env.WHATSAPP_GRAPH_VERSION || 'v21.0',
    graphBaseUrl: (env.WHATSAPP_GRAPH_BASE_URL || 'https://graph.facebook.com').replace(/\/+$/, ''),
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    accessToken: env.WHATSAPP_ACCESS_TOKEN || '',
    /** Jeton choisi par nous, saisi dans la console Meta lors de l'abonnement au webhook (GET hub.verify_token). */
    verifyToken: env.WHATSAPP_VERIFY_TOKEN || '',
    /** « App Secret » de l'application Meta : sert à vérifier X-Hub-Signature-256. */
    appSecret: env.WHATSAPP_APP_SECRET || '',
    /** Autorise les webhooks non signés (développement local UNIQUEMENT). */
    allowUnsignedWebhooks: bool(env.WHATSAPP_ALLOW_UNSIGNED_WEBHOOKS, false),
    // --- Claude ---
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    model: env.WHATSAPP_CLAUDE_MODEL || 'claude-opus-5-5',
    effort: env.WHATSAPP_CLAUDE_EFFORT || 'low',
    maxTokens: int(env.WHATSAPP_CLAUDE_MAX_TOKENS, 4000),
    maxToolRounds: int(env.WHATSAPP_MAX_TOOL_ROUNDS, 6),
    /** Repli serveur en cas de refus de sécurité (beta) : désactivé par défaut tant que non validé sur votre compte. */
    refusalFallback: bool(env.WHATSAPP_CLAUDE_REFUSAL_FALLBACK, false),
    /**
     * Mode « Claude répond » : le service ne génère aucune réponse (aucun appel à l'API Anthropic) et journalise chaque
     * message reçu (`[whatsapp-inbox]`, texte compris) pour qu'un opérateur (ou une session Claude Code) y réponde.
     * Désactivé par défaut. Le texte des messages apparaît dans les logs : à n'activer qu'en connaissance de cause (RGPD).
     */
    humanMode: bool(env.WHATSAPP_HUMAN_MODE, false),
    // --- Conversations ---
    historyWindow: int(env.WHATSAPP_HISTORY_WINDOW, 24),
    maxInboundChars: int(env.WHATSAPP_MAX_INBOUND_CHARS, 2000),
    rateLimitPerMinute: int(env.WHATSAPP_RATE_LIMIT_PER_MINUTE, 10),
    rateLimitPerDay: int(env.WHATSAPP_RATE_LIMIT_PER_DAY, 200),
    /** Durée de validité d'un code de liaison de compte (minutes). */
    linkTtlMinutes: int(env.WHATSAPP_LINK_TTL_MINUTES, 30),
    // --- Escalade ---
    supportEmail: env.SUPPORT_EMAIL || '',
    notifyWebhookUrl: env.WHATSAPP_SUPPORT_NOTIFY_WEBHOOK_URL || '',
    /** Clé d'API des routes d'administration (liste des tickets, réponse humaine). Vide = routes désactivées. */
    adminKey: env.WHATSAPP_ADMIN_API_KEY || '',
    // --- Services HARX appelés au nom de l'utilisateur lié ---
    jwtSecret: env.JWT_SECRET || '',
  };
}

/** Variables manquantes pour un fonctionnement complet (utile au démarrage et au /status). */
export function missingConfig(cfg = getWhatsAppConfig()) {
  const missing = [];
  if (!cfg.phoneNumberId) missing.push('WHATSAPP_PHONE_NUMBER_ID');
  if (!cfg.accessToken) missing.push('WHATSAPP_ACCESS_TOKEN');
  if (!cfg.verifyToken) missing.push('WHATSAPP_VERIFY_TOKEN');
  if (!cfg.appSecret && !cfg.allowUnsignedWebhooks) missing.push('WHATSAPP_APP_SECRET');
  if (!cfg.anthropicApiKey) missing.push('ANTHROPIC_API_KEY');
  if (!cfg.jwtSecret) missing.push('JWT_SECRET');
  return missing;
}
