import mongoose from 'mongoose';
import { PhoneNumber } from '../models/PhoneNumber.js';

/**
 * Affectation des lignes aux agents (offres Call Centre).
 *  - Full Scope / Multi-clients : la ligne incluse (la plus ancienne du centre) = « management » (titulaire) ; CHAQUE agent a sa propre ligne
 *    payante, jamais partagée ; une ligne sans agent est « libre » (role 'agent', assignedAgentId null) et réaffectable.
 *  - Accueil : lignes « shared » (une secrétaire à la fois ; une ligne en plus = des appels simultanés) : jamais affectées à une personne.
 *  - Nomad : un seul agent, aucune affectation. Autres offres (TaaS, sans forfait) : aucun changement, aucun rôle.
 * Les règles sont appliquées ICI (serveur), jamais par le navigateur. Les lignes historiques (sans champ) ont un rôle déduit à la lecture.
 */
export const LINE_ROLES = ['management', 'agent', 'shared'];

export class AssignmentError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code, message) => new AssignmentError(status, code, message);

/** Nature de l'offre pour les lignes : 'agents' (Full Scope, Multi-clients), 'accueil', 'nomad', ou 'other' (TaaS, sans forfait, palier inconnu). */
export function offerKind(limits) {
  if (limits?.product !== 'callcenter') return 'other';
  if (limits.callcenterTier === 'accueil') return 'accueil';
  if (limits.callcenterTier === 'nomad_solo') return 'nomad';
  if (limits.callcenterTier === 'full_scope' || limits.callcenterTier === 'multi_clients') return 'agents';
  return 'other';
}

/** Rôle réel d'une ligne : celui qui est enregistré, sinon déduit de l'offre (rétrocompatibilité des lignes sans champ). null = sans objet. */
export function effectiveRole(line, kind, oldestId) {
  if (line?.assignedRole) return line.assignedRole;
  if (kind === 'accueil') return 'shared';
  if (kind === 'nomad') return 'management';
  if (kind === 'agents') return oldestId && String(line?._id) === String(oldestId) ? 'management' : 'agent';
  return null;
}

/** Vue d'affectation d'une ligne (ajoutée à la liste des lignes des responsables). */
export function assignmentFields(line, kind, oldestId) {
  const role = effectiveRole(line, kind, oldestId);
  if (!role) return {};
  return { assignedRole: role, assignedAgentId: line.assignedAgentId ?? null, assignedAt: line.assignedAt ?? null };
}

/** Identifiant de la plus ancienne ligne d'un centre (la ligne incluse des offres à agents) à partir de ses lignes. */
export const oldestOf = (rows) => [...rows].sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0))[0]?._id ?? null;

async function oldestLineId(companyId) {
  const doc = await PhoneNumber.findOne({ companyId }).sort({ createdAt: 1 }).select('_id').lean();
  return doc ? doc._id : null;
}

const locks = new Map();
/** Sérialise les opérations d'un même centre (comme withLock de seats.js) : deux affectations rapprochées ne se marchent pas dessus. */
export function withCenterLock(key, fn) {
  const previous = locks.get(String(key)) || Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  locks.set(String(key), tail);
  tail.then(() => { if (locks.get(String(key)) === tail) locks.delete(String(key)); });
  return run;
}

const oid = (v) => (mongoose.isValidObjectId(String(v)) ? new mongoose.Types.ObjectId(String(v)) : String(v));

/**
 * L'agent fait-il partie du centre ? Même source que le décompte des sièges (base partagée avec le service d'inscription) : compte `rep`
 * employé par le centre, ou invitation d'agent acceptée. Jamais une valeur envoyée par le navigateur.
 */
export async function isAgentOfCompany(db, companyId, agentId) {
  if (!db || !agentId) return false;
  const company = oid(companyId);
  const user = oid(agentId);
  const employed = await db.collection('users').findOne({ _id: user, employerCompanyId: company, typeUser: 'rep' });
  if (employed) return true;
  const invitation = await db.collection('agentinvitations').findOne({ companyId: company, userId: { $in: [user, String(agentId)] }, status: 'accepted', kind: { $ne: 'member' } });
  return Boolean(invitation);
}

const cleanId = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Refus si l'offre ne permet pas d'affecter une ligne à une personne (Nomad, Accueil, autres). */
function assertAssignable(kind) {
  if (kind === 'accueil') throw fail(409, 'SHARED_LINE_NOT_ASSIGNABLE', 'Les lignes de l’offre Accueil sont partagées : elles ne s’affectent pas à une personne.');
  if (kind === 'nomad') throw fail(403, 'LINE_ASSIGNMENT_NOT_AVAILABLE', 'L’offre Nomad Solo n’a qu’un agent : aucune affectation de ligne.');
  if (kind !== 'agents') throw fail(403, 'LINE_ASSIGNMENT_NOT_AVAILABLE', 'L’affectation des lignes n’est pas disponible pour cette offre.');
}

const UNASSIGNABLE_BILLING = ['pending', 'release_failed', 'terminated'];

async function loadLine(companyId, lineId) {
  if (!mongoose.isValidObjectId(String(lineId))) throw fail(404, 'LINE_NOT_FOUND', 'Ligne introuvable.');
  const line = await PhoneNumber.findOne({ _id: lineId, companyId });
  if (!line || String(line.companyId) !== String(companyId)) throw fail(404, 'LINE_NOT_FOUND', 'Ligne introuvable.');
  return line;
}

/**
 * Vérifie qu'un agent peut recevoir une ligne : offre à agents, agent du centre, pas déjà titulaire d'une autre ligne.
 * @param {{companyId: string, agentId: string, limits: object, db: object, exceptLineId?: any}} p
 */
export async function assertAgentCanHaveLine({ companyId, agentId, limits, db, exceptLineId = null }) {
  assertAssignable(offerKind(limits));
  const agent = cleanId(agentId);
  if (!agent) throw fail(400, 'AGENT_REQUIRED', 'Indiquez l’agent.');
  if (!(await isAgentOfCompany(db, companyId, agent))) throw fail(403, 'AGENT_NOT_IN_COMPANY', 'Cet agent ne fait pas partie de ce centre.');
  const other = await PhoneNumber.findOne({ companyId, assignedAgentId: agent });
  if (other && String(other._id) !== String(exceptLineId)) throw fail(409, 'AGENT_ALREADY_HAS_LINE', 'Cet agent a déjà une ligne : une ligne par agent.');
  return agent;
}

/** À appeler SOUS VERROU de centre. Affecte une ligne libre à un agent (idempotent pour le même agent). */
export async function assignAgent({ companyId, lineId, agentId, limits, db }) {
  const kind = offerKind(limits);
  assertAssignable(kind);
  const line = await loadLine(companyId, lineId);
  if (UNASSIGNABLE_BILLING.includes(String(line.billingStatus))) throw fail(409, 'LINE_NOT_ASSIGNABLE_STATE', 'Cette ligne n’est pas affectable pour le moment.');
  if (effectiveRole(line, kind, await oldestLineId(companyId)) === 'management') throw fail(409, 'MANAGEMENT_LINE_NOT_ASSIGNABLE', 'La ligne incluse du titulaire ne s’affecte pas à un agent.');
  const agent = await assertAgentCanHaveLine({ companyId, agentId, limits, db, exceptLineId: line._id });
  if (line.assignedAgentId === agent) return line; // déjà à cet agent : rien à faire
  if (line.assignedAgentId) throw fail(409, 'LINE_ALREADY_ASSIGNED', 'Cette ligne est déjà affectée à un autre agent : libérez-la d’abord.');
  line.assignedRole = 'agent';
  line.assignedAgentId = agent;
  line.assignedAt = new Date();
  try {
    await line.save();
  } catch (err) {
    if (err?.code === 11000) throw fail(409, 'AGENT_ALREADY_HAS_LINE', 'Cet agent a déjà une ligne : une ligne par agent.');
    throw err;
  }
  return line;
}

/**
 * Libération explicite : la ligne « management » (ligne incluse du titulaire) ne se libère PAS tant que le forfait est actif (`limits` non nul :
 * abonnement actif, en essai ou en impayé). Sans forfait actif, elle peut être libérée. Les autres lignes (agent, shared, offres sans agents) : toujours libérables.
 * À appeler SOUS VERROU de centre, avant toute résiliation. Lève LINE_NOT_FOUND (404) ou MANAGEMENT_LINE_NOT_RELEASABLE (409).
 */
export async function assertReleasable({ companyId, lineId, limits }) {
  const line = await loadLine(companyId, lineId);
  if (limits && effectiveRole(line, offerKind(limits), await oldestLineId(companyId)) === 'management') {
    throw fail(409, 'MANAGEMENT_LINE_NOT_RELEASABLE', 'La ligne incluse ne se libère pas tant que votre forfait est actif.');
  }
  return line;
}

/** À appeler SOUS VERROU de centre. Retire l'agent : la ligne RESTE au centre, facturée, libre, réaffectable. Idempotent. */
export async function unassignAgent({ companyId, lineId, limits }) {
  const kind = offerKind(limits);
  assertAssignable(kind);
  const line = await loadLine(companyId, lineId);
  if (effectiveRole(line, kind, await oldestLineId(companyId)) === 'management') throw fail(409, 'MANAGEMENT_LINE_NOT_ASSIGNABLE', 'La ligne incluse du titulaire n’est affectée à aucun agent.');
  if (!line.assignedAgentId) return line; // déjà libre
  line.assignedRole = 'agent';
  line.assignedAgentId = null;
  line.assignedAt = null;
  await line.save();
  return line;
}

/**
 * Rôle d'une ligne qui va être ACHETÉE, et affectation éventuelle (`assignedAgentId` optionnel). null = aucune donnée d'affectation à écrire
 * (offre sans modèle d'agents : comportement inchangé). À appeler avant la commande du numéro, sous verrou de centre si un agent est demandé.
 * @returns {Promise<null | {assignedRole: string, assignedAgentId: string|null, assignedAt: Date|null}>}
 */
export async function resolvePurchaseAssignment({ companyId, limits, existingCount, assignedAgentId, db }) {
  const kind = offerKind(limits);
  const wanted = cleanId(assignedAgentId);
  if (assignedAgentId !== undefined && assignedAgentId !== null && assignedAgentId !== '' && !wanted) throw fail(400, 'AGENT_INVALID', 'Agent invalide.');
  if (kind === 'other') {
    if (wanted) throw fail(403, 'LINE_ASSIGNMENT_NOT_AVAILABLE', 'L’affectation des lignes n’est pas disponible pour cette offre.');
    return null;
  }
  if (kind === 'accueil') {
    if (wanted) assertAssignable(kind);
    return { assignedRole: 'shared', assignedAgentId: null, assignedAt: null };
  }
  if (kind === 'nomad') {
    if (wanted) assertAssignable(kind);
    return { assignedRole: 'management', assignedAgentId: null, assignedAt: null };
  }
  // Full Scope / Multi-clients : la première ligne (incluse) est celle du titulaire ; les suivantes sont des lignes d'agent, libres ou affectées.
  if (Number(existingCount) === 0) {
    if (wanted) throw fail(409, 'MANAGEMENT_LINE_NOT_ASSIGNABLE', 'La ligne incluse du titulaire ne s’affecte pas à un agent.');
    return { assignedRole: 'management', assignedAgentId: null, assignedAt: null };
  }
  if (!wanted) return { assignedRole: 'agent', assignedAgentId: null, assignedAt: null };
  const agent = await assertAgentCanHaveLine({ companyId, agentId: wanted, limits, db });
  return { assignedRole: 'agent', assignedAgentId: agent, assignedAt: new Date() };
}
