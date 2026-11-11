import mongoose from 'mongoose';
import { PhoneNumber } from '../models/PhoneNumber.js';
import { callerAccess, scopeToCompany } from '../middleware/companyScope.js';

/**
 * Liste des lignes (GET /api/phone-numbers) : toujours limitée côté serveur à la société de l'appelant.
 *  - personne (titulaire, responsable, secrétaire) : sa société, ou la société de son choix (`?companyId=`) si elle fait partie de
 *    ses emplois ; une autre société donne 403 ;
 *  - appel de service à service (jeton signé avec le secret commun, `service`, sans `userId`) : la société demandée
 *    (`?companyId=`), et si le jeton porte lui-même une société, uniquement celle-là ; jamais « toutes les sociétés ».
 * Une secrétaire ne reçoit que numéro, statut et libellé (ni facturation, ni opérateur) ; les responsables reçoivent aussi l'état
 * de facturation de la ligne, jamais les identifiants de l'opérateur ni les références de paiement.
 */
const labelOf = (line) => {
  const label = line?.metadata?.label ?? line?.metadata?.friendlyName ?? line?.label;
  return typeof label === 'string' && label.trim() ? label.trim().slice(0, 80) : null;
};

/** Champs d'une secrétaire : ce qu'il faut pour choisir le numéro appelant, rien d'autre. */
export function agentLineView(line) {
  return {
    id: line._id, _id: line._id, phoneNumber: line.phoneNumber, status: line.status, label: labelOf(line),
    companyId: line.companyId, gigId: line.gigId ?? null,
  };
}

/** Champs d'un responsable : lignes et facturation, sans identifiants de l'opérateur ni de paiement. */
export function managerLineView(line) {
  return {
    ...agentLineView(line),
    provider: line.provider, orderStatus: line.orderStatus, features: line.features,
    createdAt: line.createdAt, updatedAt: line.updatedAt,
    price: line.price, currency: line.currency, isTrial: Boolean(line.isTrial), trialExpiresAt: line.trialExpiresAt || null,
    billingStatus: line.billingStatus, paymentFailedAt: line.paymentFailedAt || null, suspendedAt: line.suspendedAt || null, terminatesAt: line.terminatesAt || null,
    metadata: line.metadata?.inboundTest ? { inboundTest: line.metadata.inboundTest } : {},
  };
}

export function scopeForListing(req, access) {
  const u = req.user || {};
  const asked = req.query?.companyId;
  if (!u.userId && !u.id && u.service) {
    const wanted = String(asked || u.companyId || '');
    if (u.companyId && wanted !== String(u.companyId)) { const e = new Error('Forbidden: not your company'); e.status = 403; throw e; }
    return { companyId: wanted, role: 'service' };
  }
  const scoped = scopeToCompany(access, asked);
  return { companyId: scoped.companyId, role: scoped.role };
}

/**
 * @param {object} req requête authentifiée
 * @param {{access?: Function, find?: Function}} [deps] injectables pour les tests
 */
export async function listLinesFor(req, { access = callerAccess, find = (companyId) => PhoneNumber.find({ companyId }).sort({ createdAt: -1 }).lean() } = {}) {
  const u = req.user || {};
  const isService = !u.userId && !u.id && u.service;
  const { companyId, role } = scopeForListing(req, isService ? null : await access(req));
  // Sans société identifiée (compte sans entreprise, identifiant invalide) : aucune ligne, jamais celles des autres.
  if (!companyId || !mongoose.Types.ObjectId.isValid(companyId)) {
    if (role === 'service') { const e = new Error('companyId is required'); e.status = 400; throw e; }
    return [];
  }
  const rows = (await find(companyId)).filter((l) => String(l.companyId) === String(companyId));
  return rows.map(role === 'agent' ? agentLineView : managerLineView);
}
