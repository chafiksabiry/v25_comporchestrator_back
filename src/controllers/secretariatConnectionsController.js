import mongoose from 'mongoose';
import { canManage } from '../services/followUps.js';
import {
  completeConnection, connectionsView, disconnect, isAvailable, messages, readState, returnUrl, startAuthorization,
} from '../services/secretariatConnections.js';
import { isProviderId, SecretariatError } from '../services/secretariatProviders/common.js';

const fail = (res, status, message) => res.status(status).json({ success: false, error: message, message });
const NOT_ALLOWED = 'Seuls le titulaire et les membres autorisés à gérer les appels peuvent connecter ou déconnecter un compte.';
const RETURN_TO = ['tools', 'onboarding'];
const companyOid = (req) => (mongoose.Types.ObjectId.isValid(req.params.companyId) ? new mongoose.Types.ObjectId(req.params.companyId) : null);
const mayWrite = (req) => Boolean(req.companyAccess) && canManage(req.companyAccess);

/** Codes courts renvoyés au portail (?error=…) : aucun détail technique. */
const ERROR_CODES = new Set(['invalid_state', 'invalid_request', 'access_denied', 'unavailable', 'exchange_failed', 'no_refresh_token', 'missing_permissions', 'no_account', 'storage_failed', 'wrong_account', 'too_many_accounts', 'email_in_use']);

export const secretariatConnectionsController = {
  /** Lecture : tout membre rattaché au centre. Jamais de jeton ni de nom de variable. */
  async list(req, res) {
    try {
      const companyId = companyOid(req);
      if (!companyId) return fail(res, 400, 'Identifiant de centre invalide.');
      res.json({ success: true, data: await connectionsView(companyId) });
    } catch (error) {
      console.error('secretariat connections list:', error.message);
      fail(res, 500, 'Lecture des connexions impossible.');
    }
  },

  async start(req, res) {
    try {
      const companyId = companyOid(req);
      if (!companyId) return fail(res, 400, 'Identifiant de centre invalide.');
      if (!mayWrite(req)) return fail(res, 403, NOT_ALLOWED);
      const { provider } = req.params;
      if (!isProviderId(provider)) return fail(res, 400, 'Fournisseur inconnu.');
      const returnTo = req.body?.returnTo === undefined ? 'tools' : req.body.returnTo;
      if (!RETURN_TO.includes(returnTo)) return fail(res, 400, 'Page de retour invalide.');
      if (!isAvailable(provider)) return fail(res, 409, messages.unavailable(provider));
      // `read: true` : demande en plus le scope (optionnel) de lecture de la boîte de réception (e-mails entrants).
      const read = req.body?.read === undefined ? false : req.body.read;
      if (typeof read !== 'boolean') return fail(res, 400, 'Le champ « read » doit être vrai ou faux.');
      if (read && !['google', 'microsoft'].includes(provider)) return fail(res, 400, 'La lecture des e-mails n’est pas disponible pour ce fournisseur.');
      // `write: true` : demande en plus le scope (optionnel, séparé) d'écriture (corbeille / archivage dans la messagerie ; inclut la lecture).
      const write = req.body?.write === undefined ? false : req.body.write;
      if (typeof write !== 'boolean') return fail(res, 400, 'Le champ « write » doit être vrai ou faux.');
      if (write && !['google', 'microsoft'].includes(provider)) return fail(res, 400, 'La gestion de la messagerie n’est pas disponible pour ce fournisseur.');
      const url = startAuthorization({ companyId: String(companyId), userId: req.companyAccess.userId, provider, returnTo, read, write });
      res.json({ success: true, data: { url } });
    } catch (error) {
      if (error instanceof SecretariatError) return fail(res, error.code === 'unavailable' ? 409 : 500, error.message);
      console.error('secretariat connections start:', error.message);
      fail(res, 500, 'Démarrage de la connexion impossible.');
    }
  },

  /**
   * PUBLIC (aucune session) : le navigateur revient du fournisseur. Sans état valide rien n'est lu ni écrit et la réponse est générique.
   * Toujours une redirection 302 vers le portail avec ?connected=<fournisseur> ou ?error=<code court> (jamais de jeton dans l'URL).
   */
  async callback(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const done = (returnTo, params) => {
      const url = returnUrl(returnTo, params);
      // Portail non configuré : page simple, sans détail.
      if (!url) return res.status(200).type('text/plain; charset=utf-8').send(params.connected ? 'Connexion terminée. Vous pouvez fermer cette page.' : 'La connexion n’a pas abouti. Vous pouvez fermer cette page.');
      return res.redirect(302, url);
    };
    const { provider } = req.params;
    const state = isProviderId(provider) ? readState(req.query?.state, provider) : null;
    if (!state) return done('tools', { error: 'invalid_state' });
    try {
      if (req.query?.error !== undefined) return done(state.returnTo, { error: 'access_denied' }); // refus de l'utilisateur chez le fournisseur
      if (!isAvailable(provider)) return done(state.returnTo, { error: 'unavailable' });
      const done_ = await completeConnection({ state, code: typeof req.query?.code === 'string' ? req.query.code : '' });
      return done(state.returnTo, done_?.personal ? { connected: provider, personal: '1', ...(done_.read ? { read: '1' } : {}) } : done_?.accountId ? { connected: provider, shared: '1' } : { connected: provider });
    } catch (error) {
      const fromProvider = ['provider_error', 'provider_refused', 'invalid_link'].includes(error.code);
      const code = error instanceof SecretariatError && ERROR_CODES.has(error.code) ? error.code : fromProvider ? 'exchange_failed' : 'storage_failed';
      console.error(`secretariat oauth callback (${provider}): ${code}`); // jamais le code d'autorisation, l'état ni un jeton
      return done(state.returnTo, { error: code });
    }
  },

  async remove(req, res) {
    try {
      const companyId = companyOid(req);
      if (!companyId) return fail(res, 400, 'Identifiant de centre invalide.');
      if (!mayWrite(req)) return fail(res, 403, NOT_ALLOWED);
      const { provider } = req.params;
      if (!isProviderId(provider)) return fail(res, 400, 'Fournisseur inconnu.');
      await disconnect(companyId, provider);
      res.json({ success: true, data: await connectionsView(companyId) });
    } catch (error) {
      console.error('secretariat connections remove:', error.message);
      fail(res, 500, 'Déconnexion impossible.');
    }
  },
};
