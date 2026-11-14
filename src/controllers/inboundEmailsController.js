import mongoose from 'mongoose';
import { canManage } from '../services/followUps.js';
import { archiveManyInbound, deleteInbound, deleteManyInbound, inboundView, loadMine, markHandled, mineReadEnabled, mineScope, readInboundBody, refreshInbound, stopMineReading } from '../services/inboundEmails.js';
import { scopeToCompany } from '../middleware/companyScope.js';
import { loadUserName } from '../services/followUpDirectory.js';
import SecretariatSharedAccount from '../models/SecretariatSharedAccount.js';
import { isAvailable, messages, startAuthorization } from '../services/secretariatConnections.js';
import { loadTools, mergedTools } from '../services/secretariatTools.js';
import { GOOGLE_MAILBOX_ACCESS_REFUSED, SecretariatError } from '../services/secretariatProviders/common.js';

const NOT_ALLOWED = 'Seuls le titulaire, les membres autorisés à gérer les appels et, si l’entreprise l’a autorisé, les secrétaires peuvent consulter les e-mails entrants.';
const fail = (res, status, code, message) => res.status(status).json({ success: false, code, error: message, message });
const companyOid = (req) => (mongoose.Types.ObjectId.isValid(req.params.companyId) ? new mongoose.Types.ObjectId(req.params.companyId) : null);
/** Titulaire ou membre autorisé (jamais un agent, jamais un appel de service sans personne). */
const mayManage = (req) => Boolean(req.companyAccess) && canManage(req.companyAccess);
/**
 * Accès aux e-mails entrants : gestionnaire, OU secrétaire (rôle agent, entreprise du JWT déjà vérifiée par requireCompanyParam)
 * quand l'entreprise a activé la lecture ET l'a ouverte aux secrétaires.
 */
async function mayRead(req, companyId) {
  if (mayManage(req)) return true;
  if (req.companyAccess?.role !== 'agent') return false;
  const { inbound } = mergedTools(await loadTools(companyId));
  return inbound.enabled === true && inbound.secretaries === true;
}

/** 409 : inbound_disabled | no_mailbox | read_scope_missing | read_unavailable (messagerie Google) | write_scope_missing | needs_reauth ; 502 provider_error ; jamais le détail du fournisseur, ni un contenu de message. */
function sendError(res, error, what) {
  if (error instanceof SecretariatError) {
    if (['inbound_disabled', 'no_mailbox', 'read_scope_missing', 'read_unavailable', 'write_scope_missing', 'needs_reauth'].includes(error.code)) return fail(res, 409, error.code, error.message);
    if (['not_connected', 'unavailable'].includes(error.code)) return fail(res, 409, 'no_mailbox', 'Aucune messagerie n’est connectée. Connectez-la dans Paramétrage > Outils.');
    if (error.code === 'provider_refused') return fail(res, 409, 'read_scope_missing', 'Le fournisseur a refusé la lecture : l’autorisation de lecture est absente ou révoquée.');
    if (error.code === 'invalid_request') return fail(res, 400, 'invalid_request', error.message);
    if (error.code === 'not_found') return fail(res, 404, 'not_found', error.message);
    return fail(res, 502, 'provider_error', 'La messagerie est momentanément indisponible. Réessayez dans un instant.');
  }
  console.error(`secretariat inbound ${what}:`, error.message); // jamais d'adresse, d'objet ni de contenu
  return fail(res, 500, 'server_error', 'Opération impossible.');
}

const guard = (handler, what) => async (req, res) => {
  try {
    const companyId = companyOid(req);
    if (!companyId) return fail(res, 400, 'invalid_request', 'Identifiant de centre invalide.');
    if (!(await mayRead(req, String(companyId)))) return fail(res, 403, 'forbidden', NOT_ALLOWED);
    return await handler(String(companyId), req, res);
  } catch (error) {
    return sendError(res, error, what);
  }
};

export const inboundEmailsController = {
  /** Léger, pour tout membre : { allowed } seulement (jamais de 403 pour un agent non autorisé). */
  async access(req, res) {
    try {
      const companyId = companyOid(req);
      if (!companyId) return fail(res, 400, 'invalid_request', 'Identifiant de centre invalide.');
      const { inbound } = mergedTools(await loadTools(String(companyId)));
      const allowed = inbound.enabled === true && (await mayRead(req, String(companyId)));
      res.json({ success: true, data: { allowed } });
    } catch (error) {
      return sendError(res, error, 'access');
    }
  },
  list: guard(async (companyId, req, res) => {
    const { view } = req.query;
    if (view !== undefined && typeof view !== 'string') throw new SecretariatError('invalid_request', 'Vue invalide : « active » ou « archived ».');
    res.json({ success: true, data: await inboundView(companyId, view) });
  }, 'list'),
  refresh: guard(async (companyId, req, res) => res.json({ success: true, data: await refreshInbound(companyId) }), 'refresh'),
  body: guard(async (companyId, req, res) => {
    const data = await readInboundBody(companyId, req.params.id);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data });
  }, 'body'),
  update: guard(async (companyId, req, res) => res.json({ success: true, data: await markHandled(companyId, req.params.id, req.body) }), 'update'),
  /** Suppression dans l'application ; avec `inbound.mailboxActions` + scope d'écriture : mise à la corbeille chez le fournisseur d'abord. Re-suppression : 404. */
  remove: guard(async (companyId, req, res) => res.json({ success: true, data: await deleteInbound(companyId, req.params.id) }), 'remove'),
  deleteMany: guard(async (companyId, req, res) => res.json({ success: true, data: await deleteManyInbound(companyId, req.body) }), 'deleteMany'),
  archiveMany: guard(async (companyId, req, res) => res.json({ success: true, data: await archiveManyInbound(companyId, req.body) }), 'archiveMany'),
};

// ---------- Messagerie PERSONNELLE de la secrétaire (portée « mine ») : SA boîte, visible d'elle seule.
const MINE_NOT_FOUND = 'Messagerie introuvable.';
const OID = /^[0-9a-fA-F]{24}$/;

/**
 * Identité de la secrétaire : TOUJOURS la session (JWT + rattachement vérifié par requireCompanyParam), jamais le corps de requête. Seul le rôle secrétaire (`agent`)
 * a une messagerie personnelle : titulaire, responsable, appel de service ou autre société → null, donc « introuvable » (on ne confirme rien).
 */
function mineIdentity(req) {
  try {
    const a = req.companyAccess ? scopeToCompany(req.companyAccess, req.params.companyId) : null;
    if (!a || a.role !== 'agent' || !a.userId || String(a.companyId) !== String(req.params.companyId) || !OID.test(String(req.params.companyId))) return null;
    return { companyId: String(a.companyId), userId: String(a.userId) };
  } catch { return null; }
}

/** Erreurs personnelles : mêmes codes que l'entreprise, messages sans renvoi vers « Paramétrage > Outils » (la secrétaire passe par son profil). */
function sendMineError(res, error, what) {
  if (error instanceof SecretariatError) {
    if (error.code === 'not_found' || error.code === 'not_connected') return fail(res, 404, 'not_found', error.message === MINE_NOT_FOUND || error.code === 'not_connected' ? MINE_NOT_FOUND : error.message);
    if (error.code === 'provider_refused') return fail(res, 409, 'read_scope_missing', 'Le fournisseur a refusé la lecture : l’autorisation de lecture est absente ou révoquée. Activez-la de nouveau depuis votre profil.');
    if (error.code === 'unavailable') return fail(res, 409, 'unavailable', error.message);
    if (error.code === 'no_mailbox') return fail(res, 409, 'no_mailbox', 'La messagerie a changé : actualisez la page.');
  }
  return sendError(res, error, what);
}

const mineGuard = (handler, what) => async (req, res) => {
  try {
    const me = mineIdentity(req);
    const accountId = String(req.params.accountId || '');
    if (!me || !OID.test(accountId)) return fail(res, 404, 'not_found', MINE_NOT_FOUND);
    const scope = mineScope(me.companyId, me.userId, accountId);
    await loadMine(scope); // propriétaire vérifié AVANT tout : autre personne / autre compte / autre société = introuvable
    return await handler(scope, req, res);
  } catch (error) {
    return sendMineError(res, error, `mine ${what}`);
  }
};

export const mineInboundController = {
  /** État de lecture de SES messageries (jamais celles d'une autre) : { accounts: [{ id, provider, email, status, readEnabled, canRead, lastSyncAt }] }. */
  async state(req, res) {
    try {
      const me = mineIdentity(req);
      if (!me) return fail(res, 404, 'not_found', MINE_NOT_FOUND);
      const rows = await SecretariatSharedAccount.find({ companyId: new mongoose.Types.ObjectId(me.companyId), personalUserId: me.userId }).select('provider accountEmail status scopes inbound').sort({ provider: 1 }).lean();
      res.json({ success: true, data: { accounts: rows.map((d) => ({
        id: String(d._id), provider: d.provider, email: d.accountEmail, status: d.status === 'needs_reauth' ? 'needs_reauth' : 'connected', needsReauth: d.status === 'needs_reauth',
        readEnabled: d.provider !== 'google' && d.inbound?.readEnabled === true, canRead: d.status !== 'needs_reauth' && mineReadEnabled(d),
        lastSyncAt: d.inbound?.lastSyncAt ? new Date(d.inbound.lastSyncAt).toISOString() : null,
      })) } });
    } catch (error) { sendMineError(res, error, 'mine state'); }
  },
  /** Démarre le consentement de LECTURE (gmail.readonly / Mail.Read, aucun scope d'écriture) pour CE compte : l'adresse doit rester la même (wrong_account au retour sinon). */
  enable: mineGuard(async (scope, req, res) => {
    const acc = await loadMine(scope);
    if (acc.provider === 'google') return fail(res, 409, 'read_unavailable', GOOGLE_MAILBOX_ACCESS_REFUSED); // aucun consentement de lecture Gmail ne démarre jamais
    if (!isAvailable(acc.provider)) return fail(res, 409, 'unavailable', messages.unavailable(acc.provider));
    const ownerName = String((await loadUserName(scope.userId)) || '').replace(/[\u0000-\u001F\u007F<>"\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    const url = startAuthorization({ companyId: scope.companyId, userId: scope.userId, provider: acc.provider, returnTo: 'profile', read: true, shared: { personal: true, ownerName, read: true } });
    res.json({ success: true, data: { url } });
  }, 'enable'),
  /** Arrête la lecture, purge immédiatement les métadonnées stockées de cette messagerie. */
  stop: mineGuard(async (scope, req, res) => res.json({ success: true, data: await stopMineReading(scope) }), 'stop'),
  list: mineGuard(async (scope, req, res) => {
    const { view } = req.query;
    if (view !== undefined && typeof view !== 'string') throw new SecretariatError('invalid_request', 'Vue invalide : « active » ou « archived ».');
    res.json({ success: true, data: await inboundView(scope, view) });
  }, 'list'),
  refresh: mineGuard(async (scope, req, res) => res.json({ success: true, data: await refreshInbound(scope) }), 'refresh'),
  body: mineGuard(async (scope, req, res) => {
    const data = await readInboundBody(scope, req.params.id);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data });
  }, 'body'),
  update: mineGuard(async (scope, req, res) => res.json({ success: true, data: await markHandled(scope, req.params.id, req.body) }), 'update'),
  remove: mineGuard(async (scope, req, res) => res.json({ success: true, data: await deleteInbound(scope, req.params.id) }), 'remove'),
  deleteMany: mineGuard(async (scope, req, res) => res.json({ success: true, data: await deleteManyInbound(scope, req.body) }), 'deleteMany'),
  archiveMany: mineGuard(async (scope, req, res) => res.json({ success: true, data: await archiveManyInbound(scope, req.body) }), 'archiveMany'),
};
