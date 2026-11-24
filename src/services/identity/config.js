/**
 * Configuration de la vérification d'identité Nomad Solo. Lue à l'appel (pas à l'import) pour que les tests changent l'environnement.
 * Toutes les valeurs sensibles viennent de variables d'environnement ; aucune n'a de valeur par défaut « secrète ».
 *
 * Drapeau : IDENTITY_VERIFICATION_ENABLED (désactivé par défaut = comportement actuel, aucune garde nouvelle).
 */
import crypto from 'node:crypto';

const bool = (v, d = false) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));
const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

export function getIdentityConfig(env = process.env) {
  return {
    enabled: bool(env.IDENTITY_VERIFICATION_ENABLED, false),
    // --- Claude (même clé que les autres usages ; modèle dédié, défaut validé par le fondateur le 22/11) ---
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    model: env.IDENTITY_CLAUDE_MODEL || 'claude-sonnet-5-5',
    effort: env.IDENTITY_CLAUDE_EFFORT || 'low',
    maxTokens: int(env.IDENTITY_CLAUDE_MAX_TOKENS, 4000),
    claudeTimeoutMs: int(env.IDENTITY_CLAUDE_TIMEOUT_MS, 90_000),
    // --- Chiffrement des images (clé dédiée, D10) ---
    filesKeyRaw: String(env.IDENTITY_FILES_ENC_KEY || '').trim(),
    // --- Règles (réglages validés) ---
    minAge: int(env.IDENTITY_MIN_AGE, 18),
    proofMaxMonths: 3,
    reviewEtaHours: 24,
    // --- Limites (spec §9.3) ---
    // Réglables (mêmes valeurs par défaut). Un essai en échec technique de notre côté n'est jamais compté (service.js).
    maxAiAttemptsPerDay: Math.max(0, int(env.IDENTITY_MAX_AI_ATTEMPTS_PER_DAY, 3)),
    maxAiAttemptsTotal: Math.max(0, int(env.IDENTITY_MAX_AI_ATTEMPTS_TOTAL, 6)),
    maxFileBytes: 10 * 1024 * 1024,
    maxPdfPages: 3,
    /** Rendu d'un PDF en images : délai maximal et taille maximale d'une image interne (pixels), contre les PDF piégés. */
    pdfRenderTimeoutMs: int(env.IDENTITY_PDF_RENDER_TIMEOUT_MS, 20_000),
    pdfMaxImagePixels: 50_000_000,
    minImageLongSide: 1000,
    normalizeLongSide: 2000,
    /** Agrandissement de la zone d'une pièce d'identité scannée sur une page PDF (grand côté, px ; maximum lu par l'IA : 2576). */
    zoomLongSide: 2576,
    /** Durée de vie maximale d'une image, quoi qu'il arrive (index TTL). */
    fileTtlMs: 30 * 24 * 60 * 60 * 1000,
    /** Après un refus, les images restent 24 h pour permettre une correction de la déclaration sans renvoi. */
    keepAfterRejectMs: 24 * 60 * 60 * 1000,
    /** Une analyse « processing » plus vieille que ça (redémarrage du serveur) part en revue humaine. */
    staleProcessingMs: 10 * 60 * 1000,
  };
}

export class IdentityDisabledError extends Error {
  constructor(message) {
    super(message);
    this.code = 'IDENTITY_FILES_KEY_MISSING';
  }
}

/** Clé AES-256 (32 octets, 64 caractères hexadécimaux ou base64). Sans clé valide, aucun fichier n'est accepté (jamais en clair). */
export function loadFilesKey(cfg = getIdentityConfig()) {
  const raw = cfg.filesKeyRaw;
  if (!raw) throw new IdentityDisabledError('IDENTITY_FILES_ENC_KEY absente : la vérification des documents est indisponible.');
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new IdentityDisabledError('IDENTITY_FILES_ENC_KEY doit faire 32 octets.');
  return key;
}

/** Sous-clés dérivées (HKDF) : une pour le chiffrement des fichiers, une pour les empreintes HMAC. Une seule variable à gérer. */
export function deriveKeys(master) {
  const derive = (info) => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), Buffer.from(info), 32));
  return { enc: derive('harx-identity-files-v1'), hmac: derive('harx-identity-fingerprint-v1') };
}
