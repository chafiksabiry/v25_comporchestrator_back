/**
 * Configuration de l'agent support IA (spécification validée le 24/11/2026 : /home/user/support/SPEC-AGENT-SUPPORT.md).
 * Lue à l'appel (jamais à l'import) pour que les tests puissent changer l'environnement.
 *
 * - SUPPORT_AGENT_ENABLED : interrupteur général, DÉSACTIVÉ par défaut (rien ne se passe tant qu'il n'est pas posé à 1/true).
 * - SUPPORT_AGENT_MODE : `draft` (défaut : l'agent prépare, le fondateur envoie depuis l'Inbox) | `autonomous` (envoi direct).
 * - SUPPORT_AGENT_MODEL : identifiant du modèle Claude ; par défaut le même que l'assistant WhatsApp existant
 *   (WHATSAPP_CLAUDE_MODEL, sinon claude-opus-5-5). Même clé ANTHROPIC_API_KEY.
 */
const bool = (v, d = false) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v).trim()));
const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const email = (v, d = '') => {
  const s = String(v || '').trim();
  return EMAIL_RE.test(s) ? s : d;
};

export const AGENT_MODES = ['draft', 'autonomous'];

export function getSupportAgentConfig(env = process.env) {
  const mode = String(env.SUPPORT_AGENT_MODE || 'draft').trim().toLowerCase();
  return {
    enabled: bool(env.SUPPORT_AGENT_ENABLED, false),
    mode: AGENT_MODES.includes(mode) ? mode : 'draft',
    // --- Claude (client existant src/salesiq/claudeClient.js, sortie JSON structurée) ---
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    model: String(env.SUPPORT_AGENT_MODEL || env.WHATSAPP_CLAUDE_MODEL || 'claude-opus-5-5').trim(),
    effort: env.SUPPORT_AGENT_EFFORT || env.WHATSAPP_CLAUDE_EFFORT || 'low',
    maxTokens: int(env.SUPPORT_AGENT_MAX_TOKENS, 3000),
    claudeTimeoutMs: int(env.SUPPORT_AGENT_TIMEOUT_MS, 60_000),
    // --- Cadence ---
    sweepMinutes: int(env.SUPPORT_AGENT_SWEEP_MINUTES, 15),
    closeAfterHours: int(env.SUPPORT_AGENT_CLOSE_AFTER_HOURS, 72),
    // --- Incident touchant plusieurs clients : même code d'erreur >= N fois (clients distincts) en M minutes ---
    incidentThreshold: int(env.SUPPORT_AGENT_INCIDENT_THRESHOLD, 3),
    incidentWindowMinutes: int(env.SUPPORT_AGENT_INCIDENT_WINDOW_MINUTES, 60),
    // --- Escalade ---
    supportEmail: email(env.SUPPORT_EMAIL),
    legalEmail: email(env.SUPPORT_LEGAL_EMAIL, 'legal@harx.ai'),
    /** Référence courte du compte (« Référence du compte : XXXXXXXX ») : 8 derniers caractères de l'identifiant de société. */
    accountRefLength: int(env.SUPPORT_ACCOUNT_REF_LENGTH, 8),
  };
}

/** Variables manquantes pour que l'agent puisse travailler (vide = prêt). */
export function supportAgentBlockers(cfg = getSupportAgentConfig()) {
  const missing = [];
  if (!cfg.anthropicApiKey) missing.push('ANTHROPIC_API_KEY');
  return missing;
}
