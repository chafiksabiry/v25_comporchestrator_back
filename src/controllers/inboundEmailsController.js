import mongoose from 'mongoose';
import { canManage } from '../services/followUps.js';
import { archiveManyInbound, deleteInbound, deleteManyInbound, inboundView, markHandled, readInboundBody, refreshInbound } from '../services/inboundEmails.js';
import { loadTools, mergedTools } from '../services/secretariatTools.js';
import { SecretariatError } from '../services/secretariatProviders/common.js';

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

/** 409 : inbound_disabled | no_mailbox | read_scope_missing | write_scope_missing | needs_reauth ; 502 provider_error ; jamais le détail du fournisseur, ni un contenu de message. */
function sendError(res, error, what) {
  if (error instanceof SecretariatError) {
    if (['inbound_disabled', 'no_mailbox', 'read_scope_missing', 'write_scope_missing', 'needs_reauth'].includes(error.code)) return fail(res, 409, error.code, error.message);
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
