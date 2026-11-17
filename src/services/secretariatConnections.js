import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import SecretariatConnection from '../models/SecretariatConnection.js';
import SecretariatSharedAccount from '../models/SecretariatSharedAccount.js';
import SecretariatTools from '../models/SecretariatTools.js';
import { config } from '../config/env.js';
import { decryptJson, encryptJson, integrationsEnabled, loadKey } from '../integrations/crypto.js';
import { defaultHttp } from '../integrations/http.js';
import { oauthStatus } from '../integrations/oauth.js';
import { call, GOOGLE_MAILBOX_ACCESS_REFUSED, hasReadScope, hasWriteScope, isProviderId, PROVIDER_IDS, PROVIDER_LABEL, SecretariatError } from './secretariatProviders/common.js';
import { purgeInboundEmails, purgePersonalInbox } from './inboundEmailStore.js';
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
export const RETURN_PATHS = { tools: '/telephony/app/tools', onboarding: '/telephony/onboarding', profile: '/telephony/app/profile' };
/** Pages de retour autorisées pour la connexion de la messagerie PERSONNELLE d'une secrétaire (liste blanche côté serveur). */
export const PERSONAL_RETURN_TO = ['profile'];
export const STATE_PURPOSE = 'secretariat-oauth';
const STATE_TTL_SECONDS = 600;
const REFRESH_MARGIN_MS = 60_000;

let httpImpl = defaultHttp;
/** Remplace le client HTTP (tests, simulation). Sans argument, rétablit le vrai client. */
export function setConnectionsHttp(fn) { httpImpl = typeof fn === 'function' ? fn : defaultHttp; }

const oid = (id) => new mongoose.Types.ObjectId(String(id));
const context = (companyId, provider) => `secretariat:${companyId}:${provider}`;
/** Contexte authentifié des jetons d'un compte PARTAGÉ : lié à la société et au compte (un blob ne peut pas être recopié sur un autre). */
const sharedContext = (companyId, accountId) => `secretariat-shared:${companyId}:${accountId}`;
/** Où vivent les jetons : la connexion de la société (par fournisseur) ou un compte partagé (par identifiant). */
const slot = (companyId, provider, accountId) => (accountId
  ? { Model: SecretariatSharedAccount, filter: { _id: oid(accountId), companyId: oid(companyId) }, ctx: sharedContext(companyId, accountId) }
  : { Model: SecretariatConnection, filter: { companyId: oid(companyId), provider }, ctx: context(companyId, provider) });
/** Message de reconnexion d'un compte partagé OU personnel (`conn` = document du compte). */
export const sharedReauthMessage = (conn) => (conn?.personalUserId ? messages.personalNeedsReauth() : messages.sharedNeedsReauth(conn?.label));
const trim = (v) => String(v ?? '').trim();
const isHttpUrl = (v) => { try { return ['http:', 'https:'].includes(new URL(v).protocol); } catch { return false; } };

export const messages = {
  notConnected: (p) => `${PROVIDER_LABEL[p]} n’est pas connecté. Connectez-le dans Paramétrage > Outils.`,
  needsReauth: (p) => `La connexion ${PROVIDER_LABEL[p]} a expiré ou a été révoquée. Reconnectez-la dans Paramétrage > Outils.`,
  unavailable: (p) => `La connexion ${PROVIDER_LABEL[p]} n’est pas encore configurée côté HARX.`,
  /** Compte partagé à reconnecter par le titulaire (la secrétaire ne le peut pas). Jamais de repli sur un autre compte. */
  /** Messagerie personnelle d'une secrétaire à reconnecter par elle-même. */
  personalNeedsReauth: () => 'La connexion de votre messagerie professionnelle a expiré ou a été révoquée : reconnectez-la depuis votre profil. Aucun autre compte n’est utilisé à sa place.',
  sharedNeedsReauth: (label) => `La connexion du compte « ${label || 'partagé'} » a expiré ou a été révoquée : le titulaire doit la reconnecter dans Paramétrage > Outils. Aucun autre compte n’est utilisé à sa place.`,
};

/** Comptes partagés : libellé, nom du propriétaire et droits des secrétaires, portés par l'état OAuth signé. */
export const SHARED_LABEL_MAX = 80;
/** Libellé fixe de la messagerie personnelle d'une secrétaire. */
export const PERSONAL_LABEL = 'Ma messagerie';

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
export function startAuthorization({ companyId, userId, provider, returnTo, shared, read = false, write = false }, env = process.env) {
  const cfg = providerConfig(provider, env);
  if (!cfg) throw new SecretariatError('unavailable', messages.unavailable(provider));
  // GOOGLE : refus inconditionnel de la lecture et de l'écriture de la boîte (aucun scope restreint n'est jamais demandé), quel que soit l'appelant.
  if (provider === 'google' && (read || write)) throw new SecretariatError('invalid_request', GOOGLE_MAILBOX_ACCESS_REFUSED);
  // `read` : demande EN PLUS le scope (optionnel) de lecture de la boîte de réception (e-mails entrants). Les scopes obtenus sont lus au callback.
  if (read && !PROVIDERS[provider].readScope) throw new SecretariatError('invalid_request', 'La lecture des e-mails n’est pas disponible pour ce fournisseur.');
  if (write && !PROVIDERS[provider].writeScope) throw new SecretariatError('invalid_request', 'La gestion de la messagerie n’est pas disponible pour ce fournisseur.');
  const state = jwt.sign({ purpose: STATE_PURPOSE, companyId: String(companyId), userId: String(userId), provider, returnTo, ...(shared ? { shared } : {}) }, stateSecret(), { expiresIn: STATE_TTL_SECONDS, algorithm: 'HS256' });
  const P = PROVIDERS[provider];
  const q = new URLSearchParams({
    client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: 'code', state,
    ...(P.noScopeParam ? {} : { scope: [...P.scopes, ...(read ? [P.readScope] : []), ...(write ? [P.writeScope] : [])].join(' ') }), ...P.authorizeExtra(env),
  });
  return `${P.authorizeUrl(env)}?${q}`;
}

/** Lit un état OAuth : charge utile valide, ou null (expiré, falsifié, autre fournisseur, forme inattendue). */
export function readState(state, provider) {
  try {
    const s = jwt.verify(String(state), stateSecret(), { algorithms: ['HS256'] });
    if (s.purpose !== STATE_PURPOSE || s.provider !== provider || !isProviderId(provider)) return null;
    if (!/^[0-9a-fA-F]{24}$/.test(String(s.companyId)) || typeof s.userId !== 'string' || !s.userId || !RETURN_PATHS[s.returnTo]) return null;
    const base = { companyId: String(s.companyId), userId: s.userId, provider, returnTo: s.returnTo };
    if (s.shared === undefined) return base;
    // Compte partagé : seuls Google et Microsoft ; libellé et droits revalidés (jamais de confiance aveugle dans la charge utile).
    const sh = s.shared;
    if (!['google', 'microsoft'].includes(provider) || !sh || typeof sh !== 'object') return null;
    // Messagerie PERSONNELLE de la secrétaire : droits fixes (envoi + agenda), propriétaire = l'utilisateur de l'état (jamais un autre).
    if (sh.personal !== undefined && sh.personal !== true) return null;
    // `read` (consentement de LECTURE de sa boîte de réception) n'existe que pour la messagerie personnelle ; jamais d'écriture.
    if (sh.read !== undefined && (sh.read !== true || sh.personal !== true)) return null;
    if (sh.read !== undefined && provider === 'google') return null; // Google : jamais de consentement de lecture
    if (sh.personal === true) {
      if (sh.accountId !== undefined) return null;
      return { ...base, shared: { label: PERSONAL_LABEL, ownerName: trim(sh.ownerName).slice(0, SHARED_LABEL_MAX), send: true, calendar: true, personal: true, ...(sh.read === true ? { read: true } : {}) } };
    }
    const label = trim(sh.label); const ownerName = trim(sh.ownerName);
    if (!label || label.length > SHARED_LABEL_MAX || ownerName.length > SHARED_LABEL_MAX) return null;
    if (sh.accountId !== undefined && !/^[0-9a-fA-F]{24}$/.test(String(sh.accountId))) return null;
    return { ...base, shared: { label, ownerName, send: sh.send === true, calendar: sh.calendar === true, ...(sh.accountId ? { accountId: String(sh.accountId) } : {}) } };
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
  const secrets = { accessToken: token.accessToken, refreshToken: token.refreshToken, expiresAt: token.expiresAt };
  // Consentement de lecture de la messagerie personnelle : le scope de lecture doit avoir été réellement accordé (sinon rien n'est enregistré, le compte existant est intact).
  if (state.shared?.read === true && !hasReadScope(provider, token.scopes)) throw new SecretariatError('missing_permissions', 'Toutes les autorisations demandées n’ont pas été accordées.');
  if (state.shared) return storeSharedAccount({ state, accountEmail, secrets, scopes: token.scopes.length ? token.scopes : P.scopes, env });
  const credentialsEnc = encryptJson(secrets, { context: context(companyId, provider), key: loadKey(env) });
  await SecretariatConnection.findOneAndUpdate(
    { companyId: oid(companyId), provider },
    { $set: { accountEmail, credentialsEnc, scopes: token.scopes.length ? token.scopes : P.scopes, status: 'connected', connectedAt: new Date(), connectedBy: userId } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  await adoptAsEmailProvider(companyId, provider);
  await adoptAgendaAndVisio(companyId, provider);
  return { companyId, provider, accountEmail };
}

/** Nombre maximum de comptes partagés par société (garde-fou). */
export const MAX_SHARED_ACCOUNTS = 20;

/**
 * Enregistre (ou met à jour) un compte PARTAGÉ après le consentement. Reconnexion d'un compte existant (`shared.accountId`) : les jetons sont
 * remplacés, le libellé et les droits conservés/mis à jour, et l'adresse doit être la même (sinon refus : on ne change pas de boîte en cours de route).
 * Même adresse déjà partagée : mise à jour de ce compte (pas de doublon). Les réglages de la société ne sont PAS modifiés.
 */
async function storeSharedAccount({ state, accountEmail, secrets, scopes, env }) {
  const { companyId, userId, provider, shared } = state;
  const email = accountEmail.toLowerCase();
  let doc = null;
  const taken = () => new SecretariatError('email_in_use', 'Cette adresse est déjà connectée dans cette société (compte partagé ou messagerie d’une autre personne). Utilisez une autre adresse.');
  if (shared.personal) {
    // Messagerie personnelle : une seule par fournisseur et par secrétaire (reconnexion = mise à jour, même adresse obligatoire).
    doc = await SecretariatSharedAccount.findOne({ companyId: oid(companyId), provider, personalUserId: String(userId) }).select('accountEmail inbound').lean();
    if (shared.read && !doc) throw new SecretariatError('invalid_request', 'Connectez d’abord votre messagerie avant d’activer la lecture.');
    if (doc && String(doc.accountEmail).toLowerCase() !== email) throw new SecretariatError('wrong_account', 'Ce n’est pas la même adresse que celle déjà connectée : déconnectez d’abord votre messagerie, puis reconnectez-la.');
    if (!doc && (await SecretariatSharedAccount.findOne({ companyId: oid(companyId), provider, accountEmail: email }).select('_id').lean())) throw taken();
  } else if (shared.accountId) {
    doc = await SecretariatSharedAccount.findOne({ _id: oid(shared.accountId), companyId: oid(companyId), provider, personalUserId: null }).select('accountEmail').lean();
    if (!doc) throw new SecretariatError('invalid_request', 'Compte introuvable.');
    if (String(doc.accountEmail).toLowerCase() !== email) throw new SecretariatError('wrong_account', 'Ce n’est pas le même compte que celui à reconnecter.');
  } else {
    doc = await SecretariatSharedAccount.findOne({ companyId: oid(companyId), provider, accountEmail: email }).select('accountEmail personalUserId').lean();
    if (doc?.personalUserId) throw taken(); // jamais d'écrasement de la messagerie d'une secrétaire
    if (!doc && (await SecretariatSharedAccount.countDocuments({ companyId: oid(companyId), personalUserId: null })) >= MAX_SHARED_ACCOUNTS) throw new SecretariatError('too_many_accounts', 'Nombre maximum de comptes partagés atteint.');
  }
  const accountId = doc ? String(doc._id) : String(new mongoose.Types.ObjectId());
  // Lecture de la boîte (messagerie personnelle seulement) : activée par le consentement de lecture ; une reconnexion simple la conserve seulement si le nouveau jeton a encore le scope.
  let readEnabled = false;
  if (shared.personal) {
    const was = doc?.inbound?.readEnabled === true;
    readEnabled = shared.read === true || (was && hasReadScope(provider, scopes));
    if (was && !readEnabled) await purgePersonalInbox(companyId, userId, accountId); // perte du scope de lecture : plus rien n'est conservé
  }
  const credentialsEnc = encryptJson(secrets, { context: sharedContext(companyId, accountId), key: loadKey(env) });
  await SecretariatSharedAccount.findOneAndUpdate(
    { _id: oid(accountId), companyId: oid(companyId) },
    { $set: { provider, label: shared.label, ownerName: shared.ownerName, accountEmail: email, credentialsEnc, scopes, status: 'connected', connectedAt: new Date(), connectedBy: userId, ...(shared.personal ? { personalUserId: String(userId), 'inbound.readEnabled': readEnabled } : {}), 'permissions.send': shared.send, 'permissions.calendar': shared.calendar } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return { companyId, provider, accountEmail: email, accountId, ...(shared.personal ? { personal: true, ...(shared.read ? { read: true } : {}) } : {}) };
}

/** Messageries pouvant envoyer les e-mails du secrétariat (les e-mails ne partent JAMAIS de HARX : seulement de la boîte connectée du centre). */
export const MAILBOX_PROVIDERS = ['google', 'microsoft'];

/**
 * Cohérence des réglages à la connexion d'une messagerie : si aucun choix n'est fait (`email.provider` = 'platform', valeur conservée
 * pour compatibilité avec le sens « aucune messagerie choisie », ou réglages absents), la messagerie qui vient d'être connectée est choisie.
 * Un choix déjà fait n'est jamais écrasé. agenda.provider et visio.provider ne sont pas modifiés. Au mieux : la connexion reste valide en cas d'échec.
 */
async function adoptAsEmailProvider(companyId, provider) {
  if (!MAILBOX_PROVIDERS.includes(provider)) return;
  try {
    const doc = await SecretariatTools.findOne({ companyId: oid(companyId) }).select('email.provider').lean();
    const current = doc?.email?.provider || 'platform';
    if (current === 'platform') await SecretariatTools.updateOne({ companyId: oid(companyId) }, { $set: { 'email.provider': provider } }, { upsert: true });
  } catch (error) {
    console.error('secretariat connexion : bascule du réglage e-mail impossible:', error.message);
  }
}

/** Réglage de visio correspondant à chaque compte connecté, et inversement. */
const VISIO_OF = { google: 'google_meet', microsoft: 'teams', zoom: 'zoom' };
const AGENDA_OF = { google: 'google', microsoft: 'microsoft' };
/** 'jitsi' / 'custom' / absent = aucune visio choisie. */
const hasVisioChoice = (v) => Object.values(VISIO_OF).includes(v);

/**
 * Cohérence des réglages à la connexion : agenda (Google, Microsoft ; jamais Zoom) choisi si aucun ('none') ; visio (Meet, Teams, Zoom)
 * choisie si aucune ('jitsi' / 'custom' / absent). Un choix déjà fait n'est jamais écrasé. Au mieux : la connexion reste valide en cas d'échec.
 */
async function adoptAgendaAndVisio(companyId, provider) {
  try {
    const doc = await SecretariatTools.findOne({ companyId: oid(companyId) }).select('agenda.provider visio.provider').lean();
    const set = {};
    if (AGENDA_OF[provider] && (doc?.agenda?.provider || 'none') === 'none') set['agenda.provider'] = AGENDA_OF[provider];
    if (VISIO_OF[provider] && !hasVisioChoice(doc?.visio?.provider)) { set['visio.provider'] = VISIO_OF[provider]; set['visio.chosen'] = true; }
    if (Object.keys(set).length) await SecretariatTools.updateOne({ companyId: oid(companyId) }, { $set: set }, { upsert: true });
  } catch (error) {
    console.error('secretariat connexion : bascule des réglages agenda / visio impossible:', error.message);
  }
}

/** À la déconnexion : l'agenda qui pointait sur ce compte repasse à 'none', la visio à 'jitsi' (= aucune). Les autres choix sont laissés tels quels. */
async function releaseAgendaAndVisio(companyId, provider) {
  try {
    if (AGENDA_OF[provider]) await SecretariatTools.updateOne({ companyId: oid(companyId), 'agenda.provider': AGENDA_OF[provider] }, { $set: { 'agenda.provider': 'none' } });
    if (VISIO_OF[provider]) await SecretariatTools.updateOne({ companyId: oid(companyId), 'visio.provider': VISIO_OF[provider] }, { $set: { 'visio.provider': 'jitsi' } });
  } catch (error) {
    console.error('secretariat déconnexion : remise des réglages agenda / visio impossible:', error.message);
  }
}

/** À la déconnexion du fournisseur choisi pour les e-mails : retour à 'platform' (= aucune messagerie choisie). */
async function releaseEmailProvider(companyId, provider) {
  if (!MAILBOX_PROVIDERS.includes(provider)) return;
  try {
    await SecretariatTools.updateOne({ companyId: oid(companyId), 'email.provider': provider }, { $set: { 'email.provider': 'platform' } });
  } catch (error) {
    console.error('secretariat déconnexion : remise du réglage e-mail impossible:', error.message);
  }
}

/**
 * Messagerie d'envoi des e-mails du secrétariat. `preferred` = `email.provider` des réglages.
 * 1) le fournisseur choisi (google / microsoft) si sa connexion est active ; 2) sinon l'unique messagerie active ;
 * 3) sinon une erreur : `needs_reauth` si une connexion est à refaire, `not_connected` sinon.
 * @returns {Promise<{provider: 'google'|'microsoft', account: string} | {error: 'not_connected'|'needs_reauth', provider: string|null}>}
 */
export async function resolveMailbox(companyId, preferred) {
  const rows = await SecretariatConnection.find({ companyId: oid(companyId), provider: { $in: MAILBOX_PROVIDERS } }).select('provider accountEmail status').lean();
  const active = rows.filter((r) => r.status === 'connected');
  const pick = (r) => ({ provider: r.provider, account: r.accountEmail });
  const chosen = active.find((r) => r.provider === preferred);
  if (chosen) return pick(chosen);
  // Le choix explicite est à reconnecter : on le dit, on n'envoie JAMAIS depuis une autre boîte à sa place.
  if (rows.some((r) => r.provider === preferred && r.status === 'needs_reauth')) return { error: 'needs_reauth', provider: preferred };
  if (active.length === 1) return pick(active[0]);
  const stale = rows.find((r) => r.status === 'needs_reauth' && r.provider === preferred) || rows.find((r) => r.status === 'needs_reauth');
  return stale ? { error: 'needs_reauth', provider: stale.provider } : { error: 'not_connected', provider: null };
}

/**
 * Compte de visio à utiliser pour créer un lien. `preferred` = `visio.provider` des réglages ('jitsi' / 'custom' = aucun choix).
 * 1) le fournisseur choisi (google_meet / teams / zoom) si sa connexion est active ; 2) sinon l'UNIQUE visio possible (une seule connexion active) ;
 * 3) sinon une erreur : `needs_reauth` si le choix explicite (ou à défaut une connexion) est à refaire, `not_connected` sinon (on ne devine pas).
 * @returns {Promise<{provider: 'google_meet'|'teams'|'zoom', account: string} | {error: 'not_connected'|'needs_reauth', account: string|null}>}
 */
export async function resolveVisio(companyId, preferred) {
  const rows = await SecretariatConnection.find({ companyId: oid(companyId), provider: { $in: Object.keys(VISIO_OF) } }).select('provider status').lean();
  const active = rows.filter((r) => r.status === 'connected');
  const chosen = active.find((r) => VISIO_OF[r.provider] === preferred);
  if (chosen) return { provider: preferred, account: chosen.provider };
  const stalePreferred = rows.find((r) => VISIO_OF[r.provider] === preferred && r.status === 'needs_reauth');
  if (stalePreferred) return { error: 'needs_reauth', account: stalePreferred.provider };
  if (active.length === 1) return { provider: VISIO_OF[active[0].provider], account: active[0].provider };
  const stale = rows.find((r) => r.status === 'needs_reauth');
  return stale && active.length === 0 ? { error: 'needs_reauth', account: stale.provider } : { error: 'not_connected', account: null };
}

const markReauth = (companyId, provider, accountId) => { const t = slot(companyId, provider, accountId); return t.Model.updateOne(t.filter, { $set: { status: 'needs_reauth' } }).catch(() => {}); };
const inFlight = new Map();

/**
 * Jeton d'accès valide (marge de 60 s). Rafraîchit au plus UNE fois par appel ; si le fournisseur refuse (révoqué) la connexion passe
 * en `needs_reauth` et l'erreur le dit en français. Une panne temporaire du fournisseur ne change pas l'état. Jamais de boucle.
 */
export function getAccessToken(companyId, provider, { force = false, http = httpImpl, env = process.env, accountId = null } = {}) {
  const key = `${companyId}:${provider}:${accountId || ''}`;
  const where = slot(companyId, provider, accountId);
  const reauth = (conn) => new SecretariatError('needs_reauth', accountId ? sharedReauthMessage(conn) : messages.needsReauth(provider), { status: null });
  if (inFlight.has(key) && !force) return inFlight.get(key);
  const run = (async () => {
    const conn = await where.Model.findOne(where.filter).select('+credentialsEnc');
    if (!conn) throw new SecretariatError('not_connected', accountId ? 'Ce compte n’est plus connecté.' : messages.notConnected(provider));
    if (conn.status === 'needs_reauth') throw reauth(conn);
    let key32;
    try { key32 = loadKey(env); } catch { throw new SecretariatError('unavailable', messages.unavailable(provider)); }
    let creds;
    try { creds = decryptJson(conn.credentialsEnc, { context: where.ctx, key: key32 }); } catch {
      await markReauth(companyId, provider, accountId);
      throw reauth(conn);
    }
    if (!force && creds.accessToken && Number(creds.expiresAt) - Date.now() > REFRESH_MARGIN_MS) return creds.accessToken;

    const cfg = providerConfig(provider, env);
    if (!cfg) throw new SecretariatError('unavailable', messages.unavailable(provider));
    const res = await postToken(PROVIDERS[provider], cfg, { grant_type: 'refresh_token', refresh_token: creds.refreshToken, ...PROVIDERS[provider].refreshExtra(env, conn.scopes || []) }, http);
    if (res.status === 200 && res.json?.access_token) {
      const t = parseToken(res.json);
      const next = { accessToken: t.accessToken, refreshToken: t.refreshToken || creds.refreshToken, expiresAt: t.expiresAt }; // certains fournisseurs renouvellent le jeton de rafraîchissement
      await where.Model.updateOne(where.filter, { $set: { credentialsEnc: encryptJson(next, { context: where.ctx, key: key32 }) } });
      return next.accessToken;
    }
    if ((res.status === 400 || res.status === 401) && res.json?.error !== 'invalid_client') {
      await markReauth(companyId, provider, accountId);
      throw new SecretariatError('needs_reauth', accountId ? sharedReauthMessage(conn) : messages.needsReauth(provider), { status: res.status });
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
export async function withConnection(companyId, provider, fn, { http = httpImpl, env = process.env, accountId = null } = {}) {
  const opts = { http, env, accountId };
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
      await markReauth(companyId, provider, accountId);
      let row = null;
      if (accountId) row = await SecretariatSharedAccount.findOne({ _id: oid(accountId), companyId: oid(companyId) }).select('label personalUserId').lean().catch(() => null);
      throw new SecretariatError('needs_reauth', accountId ? sharedReauthMessage(row) : messages.needsReauth(provider));
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
  const rows = await SecretariatConnection.find({ companyId: oid(companyId) }).select('provider accountEmail status connectedAt scopes').lean();
  const out = {};
  for (const p of PROVIDER_IDS) {
    const row = rows.find((r) => r.provider === p);
    out[p] = {
      available: isAvailable(p, env),
      connected: row?.status === 'connected',
      needsReauth: row?.status === 'needs_reauth',
      /** Le scope (optionnel) de lecture de la boîte de réception est-il accordé ? (e-mails entrants) */
      canRead: row?.status === 'connected' && hasReadScope(p, row.scopes),
      /** Le scope (optionnel, séparé) d'écriture est-il accordé ? (corbeille / archivage répercutés dans la messagerie) */
      canModify: row?.status === 'connected' && hasWriteScope(p, row.scopes),
      account: row?.accountEmail || null,
      connectedAt: row?.connectedAt ? new Date(row.connectedAt).toISOString() : null,
    };
  }
  return out;
}

/** Révoque chez le fournisseur au mieux (un échec est toléré) puis supprime les jetons. */
export async function disconnect(companyId, provider, { http = httpImpl, env = process.env } = {}) {
  // Les e-mails entrants stockés sont purgés AVANT la suppression des jetons : en cas d'échec rien n'est perdu et la déconnexion peut être rejouée.
  if (MAILBOX_PROVIDERS.includes(provider)) await purgeInboundEmails(companyId);
  const conn = await SecretariatConnection.findOne({ companyId: oid(companyId), provider }).select('+credentialsEnc');
  if (!conn) { await releaseEmailProvider(companyId, provider); await releaseAgendaAndVisio(companyId, provider); return false; }
  try {
    const cfg = providerConfig(provider, env);
    const P = PROVIDERS[provider];
    const credentials = decryptJson(conn.credentialsEnc, { context: context(companyId, provider), key: loadKey(env) });
    await P.revoke({ http, credentials, auth: cfg ? P.clientAuth(cfg) : { form: {}, headers: {} } });
  } catch {
    // Révocation au mieux : les jetons sont supprimés dans tous les cas.
  }
  await SecretariatConnection.deleteOne({ companyId: oid(companyId), provider });
  await releaseEmailProvider(companyId, provider);
  await releaseAgendaAndVisio(companyId, provider);
  return true;
}

/**
 * Révoque au mieux, chez le fournisseur, le jeton d'une connexion d'entreprise (`kind: 'connection'`) ou d'un compte partagé / personnel
 * (`kind: 'shared'`) SANS le supprimer. Lève en cas d'échec (l'appelant décide). Sert à la migration « Google sans lecture ».
 */
export async function revokeStoredGrant(kind, doc, { http = httpImpl, env = process.env } = {}) {
  const provider = doc.provider;
  const cfg = providerConfig(provider, env);
  const P = PROVIDERS[provider];
  const ctx = kind === 'shared' ? sharedContext(doc.companyId, doc._id) : context(doc.companyId, provider);
  const Model = kind === 'shared' ? SecretariatSharedAccount : SecretariatConnection;
  const full = await Model.findOne({ _id: doc._id }).select('+credentialsEnc');
  if (!full?.credentialsEnc) throw new Error('credentials missing');
  const credentials = decryptJson(full.credentialsEnc, { context: ctx, key: loadKey(env) });
  await P.revoke({ http, credentials, auth: cfg ? P.clientAuth(cfg) : { form: {}, headers: {} } });
}

/** Supprime un compte PARTAGÉ : révocation chez le fournisseur au mieux, puis suppression des jetons. Les réglages de la société ne bougent pas. */
export async function disconnectSharedAccount(companyId, accountId, { http = httpImpl, env = process.env, owner } = {}) {
  const where = slot(companyId, null, accountId);
  // `owner` : null = compte PARTAGÉ uniquement (jamais une messagerie personnelle) ; chaîne = messagerie personnelle de CET utilisateur seulement.
  if (owner !== undefined) where.filter = { ...where.filter, personalUserId: owner === null ? null : String(owner) };
  const conn = await SecretariatSharedAccount.findOne(where.filter).select('+credentialsEnc');
  if (!conn) return false;
  // Messagerie personnelle : ses e-mails stockés sont purgés AVANT la suppression des jetons (échec = rien n'est perdu, la déconnexion peut être rejouée).
  if (conn.personalUserId) await purgePersonalInbox(companyId, conn.personalUserId, conn._id);
  try {
    const cfg = providerConfig(conn.provider, env);
    const P = PROVIDERS[conn.provider];
    const credentials = decryptJson(conn.credentialsEnc, { context: where.ctx, key: loadKey(env) });
    await P.revoke({ http, credentials, auth: cfg ? P.clientAuth(cfg) : { form: {}, headers: {} } });
  } catch {
    // Révocation au mieux : les jetons sont supprimés dans tous les cas.
  }
  await SecretariatSharedAccount.deleteOne(where.filter);
  return true;
}
