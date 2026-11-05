import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import SecretariatConnection from '../models/SecretariatConnection.js';
import { config } from '../config/env.js';
import { decryptJson, encryptJson, integrationsEnabled, loadKey } from '../integrations/crypto.js';
import { defaultHttp } from '../integrations/http.js';
import { oauthStatus } from '../integrations/oauth.js';
import { call, isProviderId, PROVIDER_IDS, PROVIDER_LABEL, SecretariatError } from './secretariatProviders/common.js';
import { PROVIDERS } from './secretariatProviders/index.js';
import { isValidTenant, tenantOf } from './secretariatProviders/microsoft.js';

/**
 * Connexions du secrétariat à Google, Microsoft 365 et Zoom (OAuth « application HARX »).
 * DÉSACTIVÉ tant que les variables manquent (comme integrations/oauth.js pour Zoho) :
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI ;
 *   MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_TENANT_ID (défaut « common »), MICROSOFT_REDIRECT_URI ;
 *   ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET, ZOOM_REDIRECT_URI ; INTEGRATIONS_ENC_KEY (chiffrement des jetons).
 * URI de redirection par défaut : `<PUBLIC_API_BASE_URL>/secretariat/oauth/<fournisseur>/callback` (PUBLIC_API_BASE_URL contient déjà /api).
 * Page de retour du portail : SECRETARIAT_RETURN_URL, à défaut FRONTEND_BASE_URL (+ /telephony/app/tools ou /telephony/onboarding).
 * Les jetons ne sont jamais écrits en clair, ni journalisés, ni renvoyés ; l'état OAuth est un JWT de 10 minutes (JWT_SECRET).
 */
export const RETURN_PATHS = { tools: '/telephony/app/tools', onboarding: '/telephony/onboarding' };
export const STATE_PURPOSE = 'secretariat-oauth';
const STATE_TTL_SECONDS = 600;
const REFRESH_MARGIN_MS = 60_000;

let httpImpl = defaultHttp;
/** Remplace le client HTTP (tests, simulation). Sans argument, rétablit le vrai client. */
export function setConnectionsHttp(fn) { httpImpl = typeof fn === 'function' ? fn : defaultHttp; }

const oid = (id) => new mongoose.Types.ObjectId(String(id));
const context = (companyId, provider) => `secretariat:${companyId}:${provider}`;
const trim = (v) => String(v ?? '').trim();
const isHttpUrl = (v) => { try { return ['http:', 'https:'].includes(new URL(v).protocol); } catch { return false; } };

export const messages = {
  notConnected: (p) => `${PROVIDER_LABEL[p]} n’est pas connecté. Connectez-le dans Paramétrage > Outils.`,
  needsReauth: (p) => `La connexion ${PROVIDER_LABEL[p]} a expiré ou a été révoquée. Reconnectez-la dans Paramétrage > Outils.`,
  unavailable: (p) => `La connexion ${PROVIDER_LABEL[p]} n’est pas encore configurée côté HARX.`,
};

/** Configuration d'un fournisseur, ou null s'il n'est PAS disponible (variables absentes/invalides ou clé de chiffrement invalide). */
export function providerConfig(provider, env = process.env) {
  if (!isProviderId(provider)) return null;
  if (!oauthStatus(`secretariat:${provider}`, env).available || !integrationsEnabled(env)) return null;
  const prefix = provider.toUpperCase();
  const clientId = trim(env[`${prefix}_CLIENT_ID`]);
  const clientSecret = trim(env[`${prefix}_CLIENT_SECRET`]);
  if (!clientId || !clientSecret) return null;
  const apiBase = trim(env.PUBLIC_API_BASE_URL || env.API_BASE_URL || config.publicApiBaseUrl).replace(/\/+$/, '');
  const redirectUri = trim(env[`${prefix}_REDIRECT_URI`]) || `${apiBase}/secretariat/oauth/${provider}/callback`;
  if (!isHttpUrl(redirectUri)) return null;
  if (provider === 'microsoft' && !isValidTenant(tenantOf(env))) return null;
  return { provider, clientId, clientSecret, redirectUri, env };
}
export const isAvailable = (provider, env = process.env) => providerConfig(provider, env) !== null;

/** Base du portail pour les redirections de retour, ou '' si non configurée. */
export function returnBase(env = process.env) {
  const raw = trim(env.SECRETARIAT_RETURN_URL || env.FRONTEND_BASE_URL).replace(/\/+$/, '');
  return isHttpUrl(raw) ? raw : '';
}
/** URL de retour (?connected=… ou ?error=…), ou null sans base configurée. Aucun détail technique, aucun jeton. */
export function returnUrl(returnTo, params, env = process.env) {
  const base = returnBase(env);
  if (!base) return null;
  const q = new URLSearchParams(params).toString();
  return `${base}${RETURN_PATHS[returnTo] || RETURN_PATHS.tools}${q ? `?${q}` : ''}`;
}

const stateSecret = () => {
  if (!process.env.JWT_SECRET) throw new SecretariatError('unavailable', 'Connexion indisponible.');
  return process.env.JWT_SECRET;
};

/** Adresse d'autorisation du fournisseur, avec un état signé (10 min) lié au centre, à l'utilisateur, au fournisseur et à la page de retour. */
export function startAuthorization({ companyId, userId, provider, returnTo }, env = process.env) {
  const cfg = providerConfig(provider, env);
  if (!cfg) throw new SecretariatError('unavailable', messages.unavailable(provider));
  const state = jwt.sign({ purpose: STATE_PURPOSE, companyId: String(companyId), userId: String(userId), provider, returnTo }, stateSecret(), { expiresIn: STATE_TTL_SECONDS, algorithm: 'HS256' });
  const P = PROVIDERS[provider];
  const q = new URLSearchParams({
    client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: 'code', state,
    ...(P.noScopeParam ? {} : { scope: P.scopes.join(' ') }), ...P.authorizeExtra(env),
  });
  return `${P.authorizeUrl(env)}?${q}`;
}

/** Lit un état OAuth : charge utile valide, ou null (expiré, falsifié, autre fournisseur, forme inattendue). */
export function readState(state, provider) {
  try {
    const s = jwt.verify(String(state), stateSecret(), { algorithms: ['HS256'] });
    if (s.purpose !== STATE_PURPOSE || s.provider !== provider || !isProviderId(provider)) return null;
    if (!/^[0-9a-fA-F]{24}$/.test(String(s.companyId)) || typeof s.userId !== 'string' || !s.userId || !RETURN_PATHS[s.returnTo]) return null;
    return { companyId: String(s.companyId), userId: s.userId, provider, returnTo: s.returnTo };
  } catch {
    return null;
  }
}

const parseToken = (json) => ({
  accessToken: String(json.access_token),
  refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : '',
  expiresAt: Date.now() + Math.max(60, Number(json.expires_in) || 3600) * 1000,
  scopes: String(json.scope || '').split(/[\s,]+/).filter(Boolean),
});

async function postToken(P, cfg, form, http) {
  const auth = P.clientAuth(cfg);
  return call(http, { method: 'POST', url: P.tokenUrl(cfg.env), headers: auth.headers, form: { ...auth.form, ...form } });
}

/**
 * Callback : échange le code (l'état doit déjà être validé par `readState`), lit l'e-mail du compte et enregistre les jetons CHIFFRÉS
 * (remplace une connexion existante). Les erreurs portent un code court (exchange_failed, no_refresh_token, missing_permissions, no_account…).
 */
export async function completeConnection({ state, code }, { http = httpImpl, env = process.env } = {}) {
  const { companyId, userId, provider } = state;
  const cfg = providerConfig(provider, env);
  if (!cfg) throw new SecretariatError('unavailable', messages.unavailable(provider));
  if (typeof code !== 'string' || !code || code.length > 2048) throw new SecretariatError('invalid_request', 'Réponse du fournisseur invalide.');
  const P = PROVIDERS[provider];
  const res = await postToken(P, cfg, { grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri }, http);
  if (res.status !== 200 || !res.json?.access_token) throw new SecretariatError('exchange_failed', 'Le fournisseur a refusé l’autorisation.', { status: res.status });
  const token = parseToken(res.json);
  if (!token.refreshToken) throw new SecretariatError('no_refresh_token', 'Le fournisseur n’a pas accordé d’accès durable.');
  if (P.requiredScopes.length && token.scopes.length && P.requiredScopes.some((s) => !token.scopes.includes(s))) {
    throw new SecretariatError('missing_permissions', 'Toutes les autorisations demandées n’ont pas été accordées.');
  }
  const accountEmail = trim(await P.accountEmail({ http, accessToken: token.accessToken }));
  if (!/^[^\s@]+@[^\s@]+$/.test(accountEmail) || accountEmail.length > 254) throw new SecretariatError('no_account', 'Le compte connecté n’a pas d’adresse e-mail lisible.');
  const credentialsEnc = encryptJson({ accessToken: token.accessToken, refreshToken: token.refreshToken, expiresAt: token.expiresAt }, { context: context(companyId, provider), key: loadKey(env) });
  await SecretariatConnection.findOneAndUpdate(
    { companyId: oid(companyId), provider },
    { $set: { accountEmail, credentialsEnc, scopes: token.scopes.length ? token.scopes : P.scopes, status: 'connected', connectedAt: new Date(), connectedBy: userId } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return { companyId, provider, accountEmail };
}

const markReauth = (companyId, provider) => SecretariatConnection.updateOne({ companyId: oid(companyId), provider }, { $set: { status: 'needs_reauth' } }).catch(() => {});
const inFlight = new Map();

/**
 * Jeton d'accès valide (marge de 60 s). Rafraîchit au plus UNE fois par appel ; si le fournisseur refuse (révoqué) la connexion passe
 * en `needs_reauth` et l'erreur le dit en français. Une panne temporaire du fournisseur ne change pas l'état. Jamais de boucle.
 */
export function getAccessToken(companyId, provider, { force = false, http = httpImpl, env = process.env } = {}) {
  const key = `${companyId}:${provider}`;
  if (inFlight.has(key) && !force) return inFlight.get(key);
  const run = (async () => {
    const conn = await SecretariatConnection.findOne({ companyId: oid(companyId), provider }).select('+credentialsEnc');
    if (!conn) throw new SecretariatError('not_connected', messages.notConnected(provider));
    if (conn.status === 'needs_reauth') throw new SecretariatError('needs_reauth', messages.needsReauth(provider));
    let key32;
    try { key32 = loadKey(env); } catch { throw new SecretariatError('unavailable', messages.unavailable(provider)); }
    let creds;
    try { creds = decryptJson(conn.credentialsEnc, { context: context(companyId, provider), key: key32 }); } catch {
      await markReauth(companyId, provider);
      throw new SecretariatError('needs_reauth', messages.needsReauth(provider));
    }
    if (!force && creds.accessToken && Number(creds.expiresAt) - Date.now() > REFRESH_MARGIN_MS) return creds.accessToken;

    const cfg = providerConfig(provider, env);
    if (!cfg) throw new SecretariatError('unavailable', messages.unavailable(provider));
    const res = await postToken(PROVIDERS[provider], cfg, { grant_type: 'refresh_token', refresh_token: creds.refreshToken, ...PROVIDERS[provider].refreshExtra(env) }, http);
    if (res.status === 200 && res.json?.access_token) {
      const t = parseToken(res.json);
      const next = { accessToken: t.accessToken, refreshToken: t.refreshToken || creds.refreshToken, expiresAt: t.expiresAt }; // certains fournisseurs renouvellent le jeton de rafraîchissement
      await SecretariatConnection.updateOne({ companyId: oid(companyId), provider }, { $set: { credentialsEnc: encryptJson(next, { context: context(companyId, provider), key: key32 }) } });
      return next.accessToken;
    }
    if ((res.status === 400 || res.status === 401) && res.json?.error !== 'invalid_client') {
      await markReauth(companyId, provider);
      throw new SecretariatError('needs_reauth', messages.needsReauth(provider), { status: res.status });
    }
    throw new SecretariatError('provider_error', `${PROVIDER_LABEL[provider]} est momentanément indisponible. Réessayez dans un instant.`, { status: res.status });
  })();
  inFlight.set(key, run);
  const done = () => { if (inFlight.get(key) === run) inFlight.delete(key); };
  run.then(done, done);
  return run;
}

/**
 * Exécute `fn(accessToken)`. Un 401 du fournisseur (jeton annulé avant son échéance) provoque UN rafraîchissement forcé puis UN second
 * essai ; un nouveau 401 passe la connexion en `needs_reauth`. @template T @param {(token: string, http: Function) => Promise<T>} fn @returns {Promise<T>}
 */
export async function withConnection(companyId, provider, fn, { http = httpImpl, env = process.env } = {}) {
  const opts = { http, env };
  let token = await getAccessToken(companyId, provider, opts);
  try {
    return await fn(token, http);
  } catch (error) {
    if (!(error instanceof SecretariatError) || error.status !== 401) throw error;
  }
  token = await getAccessToken(companyId, provider, { ...opts, force: true });
  try {
    return await fn(token, http);
  } catch (error) {
    if (error instanceof SecretariatError && error.status === 401) {
      await markReauth(companyId, provider);
      throw new SecretariatError('needs_reauth', messages.needsReauth(provider));
    }
    throw error;
  }
}

/** Adresse du compte connecté (utile à l'expéditeur Gmail). Lève `not_connected` / `needs_reauth` si la connexion n'est pas active. */
export async function connectedAccount(companyId, provider) {
  const row = await SecretariatConnection.findOne({ companyId: oid(companyId), provider }).select('accountEmail status').lean();
  if (!row) throw new SecretariatError('not_connected', messages.notConnected(provider));
  if (row.status !== 'connected') throw new SecretariatError('needs_reauth', messages.needsReauth(provider));
  return row.accountEmail;
}

/** Fournisseurs actuellement connectés (jamais `needs_reauth`) : sert à valider les réglages. */
export async function connectedProviders(companyId) {
  const rows = await SecretariatConnection.find({ companyId: oid(companyId), status: 'connected' }).select('provider').lean();
  return new Set(rows.map((r) => r.provider));
}

/** Réponse de GET /connections : jamais de jeton ni de nom de variable. */
export async function connectionsView(companyId, env = process.env) {
  const rows = await SecretariatConnection.find({ companyId: oid(companyId) }).select('provider accountEmail status connectedAt').lean();
  const out = {};
  for (const p of PROVIDER_IDS) {
    const row = rows.find((r) => r.provider === p);
    out[p] = {
      available: isAvailable(p, env),
      connected: row?.status === 'connected',
      needsReauth: row?.status === 'needs_reauth',
      account: row?.accountEmail || null,
      connectedAt: row?.connectedAt ? new Date(row.connectedAt).toISOString() : null,
    };
  }
  return out;
}

/** Révoque chez le fournisseur au mieux (un échec est toléré) puis supprime les jetons. */
export async function disconnect(companyId, provider, { http = httpImpl, env = process.env } = {}) {
  const conn = await SecretariatConnection.findOne({ companyId: oid(companyId), provider }).select('+credentialsEnc');
  if (!conn) return false;
  try {
    const cfg = providerConfig(provider, env);
    const P = PROVIDERS[provider];
    const credentials = decryptJson(conn.credentialsEnc, { context: context(companyId, provider), key: loadKey(env) });
    await P.revoke({ http, credentials, auth: cfg ? P.clientAuth(cfg) : { form: {}, headers: {} } });
  } catch {
    // Révocation au mieux : les jetons sont supprimés dans tous les cas.
  }
  await SecretariatConnection.deleteOne({ companyId: oid(companyId), provider });
  return true;
}
