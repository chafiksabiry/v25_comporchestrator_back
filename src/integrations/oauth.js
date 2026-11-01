import jwt from 'jsonwebtoken';
import { CrmError } from './http.js';
import { zohoAccountsUrl } from './adapters/zoho.js';

/**
 * OAuth « application HARX » : DÉSACTIVÉ tant que les variables d'environnement manquent (le dirigeant n'a pas encore
 * enregistré d'application chez Zoho). Variables attendues :
 *   ZOHO_OAUTH_CLIENT_ID, ZOHO_OAUTH_CLIENT_SECRET, ZOHO_OAUTH_REDIRECT_URI (= <API>/api/integrations/oauth/zoho/callback),
 *   INTEGRATIONS_RETURN_URL (page « Intégrations » du portail, où le centre est renvoyé).
 * Dynamics 365 : pas d'OAuth HARX (jeton à renouveler non géré) ; le centre utilise l'application Azure de son locataire.
 * Points d'accès Zoho OAuth : À VÉRIFIER (documentation non joignable).
 */
export const OAUTH_ENV = { zoho: ['ZOHO_OAUTH_CLIENT_ID', 'ZOHO_OAUTH_CLIENT_SECRET', 'ZOHO_OAUTH_REDIRECT_URI', 'INTEGRATIONS_RETURN_URL'] };

export function oauthStatus(provider, env = process.env) {
  const needed = OAUTH_ENV[provider];
  if (!needed) return { available: false, missing: [], reason: provider === 'dynamics' ? 'Utilisez l’application Azure de votre organisation.' : '' };
  const missing = needed.filter((k) => !env[k]);
  return { available: missing.length === 0, missing };
}

const REGIONS = ['eu', 'com', 'in', 'com.au', 'jp'];
const stateSecret = () => {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET absent');
  return process.env.JWT_SECRET;
};

export function startZohoOAuth({ companyId, userId, region }, env = process.env) {
  if (!oauthStatus('zoho', env).available) throw new CrmError('OAuth Zoho non configuré.', { retryable: false });
  if (!REGIONS.includes(region)) throw new CrmError('Région inconnue.', { retryable: false });
  const state = jwt.sign({ purpose: 'zoho-oauth', companyId, userId, region }, stateSecret(), { expiresIn: 600 });
  const q = new URLSearchParams({
    scope: 'ZohoCRM.modules.contacts.ALL,ZohoCRM.modules.calls.ALL', client_id: env.ZOHO_OAUTH_CLIENT_ID, response_type: 'code',
    access_type: 'offline', redirect_uri: env.ZOHO_OAUTH_REDIRECT_URI, state, prompt: 'consent',
  });
  return `${zohoAccountsUrl(region)}/oauth/v2/auth?${q}`;
}

/** Échange le code contre un jeton de rafraîchissement. Renvoie { companyId, userId, credentials } prêts à être chiffrés. */
export async function finishZohoOAuth({ code, state }, { http, env = process.env }) {
  if (!oauthStatus('zoho', env).available) throw new CrmError('OAuth Zoho non configuré.', { retryable: false });
  let s;
  try { s = jwt.verify(String(state), stateSecret()); } catch { throw new CrmError('Autorisation expirée, recommencez.', { retryable: false }); }
  if (s.purpose !== 'zoho-oauth') throw new CrmError('Autorisation invalide.', { retryable: false });
  const res = await http({ method: 'POST', url: `${zohoAccountsUrl(s.region)}/oauth/v2/token`, form: { grant_type: 'authorization_code', code: String(code), client_id: env.ZOHO_OAUTH_CLIENT_ID, client_secret: env.ZOHO_OAUTH_CLIENT_SECRET, redirect_uri: env.ZOHO_OAUTH_REDIRECT_URI } });
  if (res.status !== 200 || !res.json?.refresh_token) throw new CrmError('Zoho a refusé l’autorisation.', { status: res.status, retryable: false });
  return { companyId: s.companyId, userId: s.userId, credentials: { clientId: env.ZOHO_OAUTH_CLIENT_ID, clientSecret: env.ZOHO_OAUTH_CLIENT_SECRET, refreshToken: res.json.refresh_token, region: s.region } };
}
