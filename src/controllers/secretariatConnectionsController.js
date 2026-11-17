import mongoose from 'mongoose';
import SecretariatConnection from '../models/SecretariatConnection.js';
import { canManage, canUse } from '../services/followUps.js';
import {
  completeConnection, connectionsView, disconnect, isAvailable, messages, readState, returnUrl, beginAuthorization, browserBindingEnabled, exchangeAuthorization, finishAuthorization, stashAuthorization,
} from '../services/secretariatConnections.js';
import { GOOGLE_MAILBOX_ACCESS_REFUSED, isProviderId, SecretariatError } from '../services/secretariatProviders/common.js';
import { isMailProvider, isOwnerless, mayTakeOver, ownerOf, ownsRow } from '../services/mailOwnership.js';
import { ownerHasLeft } from '../services/mailOwnerMembership.js';

const fail = (res, status, message) => res.status(status).json({ success: false, error: message, message });
const NOT_ALLOWED = 'Seuls le titulaire et les membres autorisés à gérer les appels peuvent connecter ou déconnecter un compte. Une boîte mail n’est gérée que par la personne qui l’a connectée.';
const RETURN_TO = ['tools', 'onboarding'];
const companyOid = (req) => (mongoose.Types.ObjectId.isValid(req.params.companyId) ? new mongoose.Types.ObjectId(req.params.companyId) : null);
const mayWrite = (req) => Boolean(req.companyAccess) && canManage(req.companyAccess);
/** Qui regarde : l'identité de la session ; seul le titulaire de la société (rôle `owner`) peut voir qu'une connexion orpheline existe. */
const bearer = (req) => req.headers?.authorization?.split(' ')[1];
const viewerOf = (req) => ({ userId: req.companyAccess?.userId || '', titulaire: req.companyAccess?.role === 'owner', ownerGone: (ownerId) => ownerHasLeft(req.params.companyId, ownerId, bearer(req)) });

/** Codes courts renvoyés au portail (?error=…) : aucun détail technique. */
const ERROR_CODES = new Set(['invalid_state', 'invalid_request', 'access_denied', 'unavailable', 'exchange_failed', 'no_refresh_token', 'missing_permissions', 'no_account', 'storage_failed', 'wrong_account', 'too_many_accounts', 'email_in_use', 'not_owner']);

export const secretariatConnectionsController = {
  /**
   * Lecture : tout membre rattaché au centre ; une boîte Google / Microsoft n'y apparaît « connectée » (avec son adresse) que pour la personne qui l'a connectée.
   * Jamais de jeton ni de nom de variable.
   */
  async list(req, res) {
    try {
      const companyId = companyOid(req);
      if (!companyId) return fail(res, 400, 'Identifiant de centre invalide.');
      res.json({ success: true, data: await connectionsView(companyId, viewerOf(req)) });
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
      // Boîte Google / Microsoft : on ne démarre pas la connexion par-dessus celle d'une autre personne (ni adresse ni identité révélées).
      if (isMailProvider(provider)) {
        const existing = await SecretariatConnection.findOne({ companyId, provider }).select('connectedBy ownerless').lean();
        if (!mayTakeOver(existing, req.companyAccess.userId)) return res.status(409).json({ success: false, code: 'connection_owned', error: 'connection_owned', message: messages.ownedByOther(provider) });
      }
      // `read: true` : demande en plus le scope (optionnel) de lecture de la boîte de réception (e-mails entrants).
      const read = req.body?.read === undefined ? false : req.body.read;
      if (typeof read !== 'boolean') return fail(res, 400, 'Le champ « read » doit être vrai ou faux.');
      if (read && provider === 'google') return fail(res, 400, GOOGLE_MAILBOX_ACCESS_REFUSED); // refus inconditionnel : Google ne demande plus jamais la lecture
      if (read && provider !== 'microsoft') return fail(res, 400, 'La lecture des e-mails n’est pas disponible pour ce fournisseur.');
      // `write: true` : demande en plus le scope (optionnel, séparé) d'écriture (corbeille / archivage dans la messagerie ; inclut la lecture).
      const write = req.body?.write === undefined ? false : req.body.write;
      if (typeof write !== 'boolean') return fail(res, 400, 'Le champ « write » doit être vrai ou faux.');
      if (write && provider === 'google') return fail(res, 400, GOOGLE_MAILBOX_ACCESS_REFUSED); // idem pour l'écriture (corbeille / archivage)
      if (write && provider !== 'microsoft') return fail(res, 400, 'La gestion de la messagerie n’est pas disponible pour ce fournisseur.');
      const url = beginAuthorization({ companyId: String(companyId), userId: req.companyAccess.userId, provider, returnTo, read, write });
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
      const code = typeof req.query?.code === 'string' ? req.query.code : '';
      // Autorisation démarrée par une route authentifiée : on échange le code, on met les jetons (chiffrés) en attente et on renvoie vers le portail avec un identifiant à usage unique.
      // RIEN n'est enregistré ici : seul l'utilisateur authentifié qui a démarré peut finaliser (POST …/complete). Le navigateur qui revient peut être celui d'un tiers.
      if (state.pend === true && browserBindingEnabled()) {
        const pendingId = await stashAuthorization({ state, ...(await exchangeAuthorization({ state, code })) });
        return done(state.returnTo, { pending: pendingId, provider });
      }
      const done_ = await completeConnection({ state, code });
      return done(state.returnTo, done_?.personal ? { connected: provider, personal: '1', ...(done_.read ? { read: '1' } : {}) } : done_?.accountId ? { connected: provider, shared: '1' } : { connected: provider });
    } catch (error) {
      const fromProvider = ['provider_error', 'provider_refused', 'invalid_link'].includes(error.code);
      const code = error instanceof SecretariatError && ERROR_CODES.has(error.code) ? error.code : fromProvider ? 'exchange_failed' : 'storage_failed';
      console.error(`secretariat oauth callback (${provider}): ${code}`); // jamais le code d'autorisation, l'état ni un jeton
      return done(state.returnTo, { error: code });
    }
  },

  /**
   * Finalisation AUTHENTIFIÉE d'une autorisation en attente (voir secretariatConnections.js). Le portail l'appelle au retour OAuth avec `?pending=` et le Bearer de l'utilisateur.
   * 200 { success, data: { connected, personal?, shared?, read? } } ; erreurs { success:false, code, error, message } : invalid_request 400 · wrong_user 403 · not_owner 403 ·
   * pending_not_found 404 · email_in_use / wrong_account / too_many_accounts 409 · storage_failed 500. L'attente est consommée dans tous les cas.
   */
  async complete(req, res) {
    const refuse = (status, code, message) => res.status(status).json({ success: false, code, error: code, message });
    try {
      const companyId = companyOid(req);
      if (!companyId) return fail(res, 400, 'Identifiant de centre invalide.');
      const { provider } = req.params;
      if (!isProviderId(provider)) return fail(res, 400, 'Fournisseur inconnu.');
      const pendingId = req.body?.pendingId;
      if (typeof pendingId !== 'string') return refuse(400, 'invalid_request', 'Identifiant d’autorisation invalide.');
      const data = await finishAuthorization({ pendingId, userId: req.companyAccess?.userId, companyId: String(companyId), provider, mayStore: (st) => (st.shared?.personal ? canUse(req.companyAccess) : canManage(req.companyAccess)) });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ success: true, data: { connected: data.provider, ...(data.personal ? { personal: true, ...(data.read ? { read: true } : {}) } : {}), ...(data.shared ? { shared: true } : {}) } });
    } catch (error) {
      if (error instanceof SecretariatError) {
        const status = { invalid_request: 400, forbidden: 403, wrong_user: 403, not_owner: 403, pending_not_found: 404, email_in_use: 409, wrong_account: 409, too_many_accounts: 409, unavailable: 409 }[error.code] || 500;
        return refuse(status, ERROR_CODES.has(error.code) || ['wrong_user', 'pending_not_found', 'forbidden'].includes(error.code) ? error.code : 'storage_failed', status === 500 ? 'Finalisation impossible.' : error.message);
      }
      console.error('secretariat connections complete: storage_failed');
      return refuse(500, 'storage_failed', 'Finalisation impossible.');
    }
  },

  async remove(req, res) {
    try {
      const companyId = companyOid(req);
      if (!companyId) return fail(res, 400, 'Identifiant de centre invalide.');
      if (!mayWrite(req)) return fail(res, 403, NOT_ALLOWED);
      const { provider } = req.params;
      if (!isProviderId(provider)) return fail(res, 400, 'Fournisseur inconnu.');
      // Le titulaire retire aussi la connexion d'un propriétaire qui a quitté la société (annuaire lu avec son jeton) ; jamais l'adresse ni les jetons.
      const titulaire = req.companyAccess.role === 'owner';
      let ownerGone = false;
      if (titulaire && isMailProvider(provider)) {
        const row = await SecretariatConnection.findOne({ companyId, provider }).select('connectedBy ownerless').lean();
        if (row && !isOwnerless(row) && !ownsRow(row, req.companyAccess.userId)) ownerGone = await ownerHasLeft(String(companyId), ownerOf(row), bearer(req));
      }
      await disconnect(companyId, provider, { userId: req.companyAccess.userId, titulaire, ownerGone });
      res.json({ success: true, data: await connectionsView(companyId, viewerOf(req)) });
    } catch (error) {
      if (error instanceof SecretariatError && error.code === 'not_owner') return res.status(403).json({ success: false, code: 'not_owner', error: 'not_owner', message: error.message });
      console.error('secretariat connections remove:', error.message);
      fail(res, 500, 'Déconnexion impossible.');
    }
  },
};
