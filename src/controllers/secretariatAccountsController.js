import mongoose from 'mongoose';
import { scopeToCompany } from '../middleware/companyScope.js';
import { loadUserName } from '../services/followUpDirectory.js';
import { canManage, canUse } from '../services/followUps.js';
import { isAvailable, messages, PERSONAL_RETURN_TO, startAuthorization } from '../services/secretariatConnections.js';
import { SecretariatError } from '../services/secretariatProviders/common.js';
import {
  createAccountEvent, isManager, listAccountEvents, listAccounts, managerView, parseRange, removeAccount, removePersonalAccount, requireAccount, updateAccount,
  validateAccountInput, validateEventInput,
} from '../services/secretariatSharedAccounts.js';
import SecretariatSharedAccount from '../models/SecretariatSharedAccount.js';

/**
 * Comptes connectés partagés avec les secrétaires (boîte et agenda d'un patron / collègue). Le contrôle d'accès est ici et dans
 * services/secretariatSharedAccounts.js : titulaire et responsables gèrent ; une secrétaire n'agit que sur les comptes autorisés.
 */
const fail = (res, status, message, code) => res.status(status).json({ success: false, error: code || message, message, ...(code ? { code } : {}) });
const NOT_ALLOWED = 'Seuls le titulaire et les membres autorisés à gérer les appels peuvent gérer les comptes partagés.';
const MAILBOX_PROVIDERS = ['google', 'microsoft'];
const NOT_SECRETARY = 'Seule une secrétaire peut connecter sa messagerie professionnelle ici.';
const HTTP = new Set([400, 403, 404, 409, 429, 502, 503]);

/** Droits de l'appelant pour cette société (une secrétaire employée par plusieurs sociétés agit sur celle de l'URL). Répond et renvoie null en cas de refus. */
function access(req, res, { manage = false } = {}) {
  let a;
  try { a = scopeToCompany(req.companyAccess, req.params.companyId); } catch { fail(res, 403, 'Ce n’est pas votre entreprise.'); return null; }
  if (!a || String(a.companyId) !== String(req.params.companyId)) { fail(res, 403, 'Ce n’est pas votre entreprise.'); return null; }
  if (manage ? !canManage(a) : !canUse(a)) { fail(res, 403, manage ? NOT_ALLOWED : 'Accès refusé.'); return null; }
  return a;
}

/** Erreur métier -> réponse JSON (message français sûr, code court). */
function answer(res, error, what) {
  if (error instanceof SecretariatError) {
    const status = HTTP.has(error.status) ? error.status : error.code === 'unavailable' ? 503 : 502;
    const body = { success: false, error: error.code, code: error.code, message: error.message, ...(error.conflicts ? { conflicts: error.conflicts } : {}) };
    return res.status(status).json(body);
  }
  console.error(`secretariat accounts ${what}:`, error.message);
  return fail(res, 500, 'Opération impossible.');
}

export const secretariatAccountsController = {
  /** Titulaire / responsable : tous les comptes et leurs droits. Secrétaire : seulement les comptes autorisés, sans réglage. */
  async list(req, res) {
    try {
      const a = access(req, res);
      if (!a) return;
      res.json({ success: true, data: { accounts: await listAccounts(a.companyId, a), canManage: isManager(a) } });
    } catch (error) { answer(res, error, 'list'); }
  },

  /** Démarre le consentement (flux OAuth existant, mêmes périmètres) pour un NOUVEAU compte partagé. */
  async start(req, res) {
    try {
      const a = access(req, res, { manage: true });
      if (!a) return;
      const { provider } = req.params;
      if (!MAILBOX_PROVIDERS.includes(provider)) return fail(res, 400, 'Fournisseur inconnu : choisissez Google ou Microsoft 365.');
      const v = validateAccountInput(req.body);
      if (v.error) return fail(res, 400, v.error);
      if (!isAvailable(provider)) return fail(res, 409, messages.unavailable(provider));
      const url = startAuthorization({ companyId: a.companyId, userId: a.userId, provider, returnTo: 'tools', shared: { label: v.value.label, ownerName: v.value.ownerName, send: v.value.send, calendar: v.value.calendar } });
      res.json({ success: true, data: { url } });
    } catch (error) { answer(res, error, 'start'); }
  },

  /** Nouveau consentement pour un compte `needs_reauth` (mêmes libellé et droits ; l'adresse doit être la même). */
  async reconnect(req, res) {
    try {
      const a = access(req, res, { manage: true });
      if (!a) return;
      const id = req.params.accountId;
      const d = mongoose.Types.ObjectId.isValid(id) && /^[0-9a-fA-F]{24}$/.test(id)
        ? await SecretariatSharedAccount.findOne({ _id: id, companyId: a.companyId, personalUserId: null }).select('provider label ownerName permissions').lean() : null;
      if (!d) return fail(res, 404, 'Compte introuvable.', 'account_not_found');
      if (!isAvailable(d.provider)) return fail(res, 409, messages.unavailable(d.provider));
      const url = startAuthorization({ companyId: a.companyId, userId: a.userId, provider: d.provider, returnTo: 'tools', shared: { label: d.label, ownerName: d.ownerName || '', send: d.permissions?.send === true, calendar: d.permissions?.calendar === true, accountId: String(d._id) } });
      res.json({ success: true, data: { url } });
    } catch (error) { answer(res, error, 'reconnect'); }
  },

  /**
   * La secrétaire démarre le consentement pour SA messagerie professionnelle (mêmes périmètres OAuth « envoi / agenda » que les comptes
   * partagés, aucune lecture de boîte). L'identité vient de la session (jamais du corps) ; retour sur son profil.
   */
  async startMine(req, res) {
    try {
      const a = access(req, res);
      if (!a) return;
      if (a.role !== 'agent') return fail(res, 403, NOT_SECRETARY);
      const { provider } = req.params;
      if (!MAILBOX_PROVIDERS.includes(provider)) return fail(res, 400, 'Fournisseur inconnu : choisissez Google ou Microsoft 365.');
      const returnTo = req.body?.returnTo === undefined ? 'profile' : req.body.returnTo;
      if (!PERSONAL_RETURN_TO.includes(returnTo)) return fail(res, 400, 'Page de retour invalide.');
      if (!isAvailable(provider)) return fail(res, 409, messages.unavailable(provider));
      const ownerName = String((await loadUserName(a.userId)) || '').replace(/[\u0000-\u001F\u007F<>"\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
      // Reconnexion d'une messagerie dont la lecture est activée : on redemande aussi le scope de lecture (sinon le nouveau jeton la perdrait).
      const prev = await SecretariatSharedAccount.findOne({ companyId: a.companyId, provider, personalUserId: String(a.userId) }).select('inbound').lean();
      // Google : jamais de lecture (même si un ancien consentement subsiste) : la reconnexion se fait sans lecture et sans erreur.
      const read = provider !== 'google' && prev?.inbound?.readEnabled === true;
      const url = startAuthorization({ companyId: a.companyId, userId: a.userId, provider, returnTo, read, shared: { personal: true, ownerName, ...(read ? { read: true } : {}) } });
      res.json({ success: true, data: { url } });
    } catch (error) { answer(res, error, 'startMine'); }
  },

  /** La secrétaire déconnecte SA messagerie (propriété vérifiée ; tout autre compte = introuvable). */
  async removeMine(req, res) {
    try {
      const a = access(req, res);
      if (!a) return;
      if (a.role !== 'agent') return fail(res, 403, NOT_SECRETARY);
      if (!(await removePersonalAccount(a.companyId, a.userId, req.params.accountId))) return fail(res, 404, 'Compte introuvable.', 'account_not_found');
      res.json({ success: true, data: { accounts: await listAccounts(a.companyId, a) } });
    } catch (error) { answer(res, error, 'removeMine'); }
  },

  async update(req, res) {
    try {
      const a = access(req, res, { manage: true });
      if (!a) return;
      const v = validateAccountInput(req.body, { partial: true });
      if (v.error) return fail(res, 400, v.error);
      const d = await updateAccount(a.companyId, req.params.accountId, v.value);
      if (!d) return fail(res, 404, 'Compte introuvable.', 'account_not_found');
      res.json({ success: true, data: managerView(d) });
    } catch (error) { answer(res, error, 'update'); }
  },

  async remove(req, res) {
    try {
      const a = access(req, res, { manage: true });
      if (!a) return;
      if (!(await removeAccount(a.companyId, req.params.accountId))) return fail(res, 404, 'Compte introuvable.', 'account_not_found');
      res.json({ success: true, data: { accounts: await listAccounts(a.companyId, a) } });
    } catch (error) { answer(res, error, 'remove'); }
  },

  /** Événements d'un agenda autorisé, en lecture seule. */
  async events(req, res) {
    try {
      const a = access(req, res);
      if (!a) return;
      const range = parseRange(req.query.from, req.query.to);
      if (range.error) return fail(res, 400, range.error);
      const account = await requireAccount(a.companyId, a, req.params.accountId, 'calendar');
      res.json({ success: true, data: { account: { id: String(account._id), label: account.label, ownerName: account.ownerName || '' }, events: await listAccountEvents(a.companyId, account, range) } });
    } catch (error) { answer(res, error, 'events'); }
  },

  /** Rendez-vous dans l'agenda d'un compte autorisé, avec contrôle de conflit (409 `calendar_conflict` sauf `ignoreConflicts`). */
  async createEvent(req, res) {
    try {
      const a = access(req, res);
      if (!a) return;
      const v = validateEventInput(req.body);
      if (v.error) return fail(res, 400, v.error);
      const account = await requireAccount(a.companyId, a, req.params.accountId, 'calendar');
      const authorName = await loadUserName(a.userId);
      const event = await createAccountEvent(a.companyId, account, v.value, { authorName, companyName: String(req.body?.centerName || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80) });
      res.status(201).json({ success: true, data: event });
    } catch (error) { answer(res, error, 'createEvent'); }
  },
};
