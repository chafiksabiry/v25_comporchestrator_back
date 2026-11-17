import mongoose from 'mongoose';
import { PhoneNumber } from '../models/PhoneNumber.js';
import { callerAccess, ScopeError } from './companyScope.js';
import { agentIdsOfUser } from './agentGuard.js';
import { userOrService } from './serviceToken.js';

/**
 * Contrôle d'accès des deux routes du copilote REP, autrefois ouvertes à tous :
 *   GET  /phone-numbers/gig/:gigId/check            (lecture des lignes d'une opération)
 *   POST /phone-numbers/:phoneNumber/configure-voice (MODIFIE la configuration voix de la ligne chez l'opérateur et en base)
 * Accès accordé à :
 *  - un jeton de service HS256 de portée `rep-copilot` (appel serveur à serveur, voir middleware/serviceToken.js) ;
 *  - un utilisateur (titulaire ou membre, pas agent) de la société propriétaire de l'opération (`gigs.companyId`) / de la ligne
 *    (`PhoneNumber.companyId`), société résolue par le service d'inscription (callerAccess), jamais par la requête ;
 *  - un REP / agent seulement s'il est rattaché : inscrit (`status: 'enrolled'`) à l'opération (`gigs.agents[]`), ou, pour une ligne,
 *    inscrit à l'opération de la ligne ou titulaire de la ligne (`PhoneNumber.assignedAgentId`).
 * Refus AVANT toute écriture ou tout appel à l'opérateur : 401 sans jeton valide, 404 opération / ligne inconnue, 403 sinon,
 * 503 si le service d'inscription est indisponible (jamais d'accès ouvert par défaut). COMPANY_SCOPE_MODE=log ne s'applique PAS ici.
 */

export const REP_COPILOT_SCOPE = 'rep-copilot';

const idForms = (id) => {
  const s = String(id);
  return mongoose.Types.ObjectId.isValid(s) && /^[0-9a-f]{24}$/i.test(s) ? [s, new mongoose.Types.ObjectId(s)] : [s];
};

/** Accès par défaut à la base ; remplaçable dans les tests. */
export const defaultDeps = {
  findGig: async (gigId) =>
    mongoose.connection.db.collection('gigs').findOne({ _id: { $in: idForms(gigId) } }, { projection: { companyId: 1, agents: 1 } }),
  findLine: async (phoneNumber) => PhoneNumber.findOne({ phoneNumber }).select('companyId gigId assignedAgentId').lean(),
  agentIdsOfUser,
  callerAccess,
};

const deny = (res, status, error, code) => res.status(status).json({ error, code });

/** Identifiants « agent » de l'appelant : ses fiches `agents` et l'identifiant de son compte. */
async function myAgentIds(req, deps) {
  const userId = req.user && (req.user.userId || req.user.id);
  if (!userId) return new Set();
  let ids;
  try {
    ids = await deps.agentIdsOfUser(userId);
  } catch {
    ids = new Set();
  }
  return new Set([String(userId), ...[...(ids || [])].map(String)]);
}

const enrolledIn = (gig, mine) =>
  Boolean(gig) && Array.isArray(gig.agents) && gig.agents.some((a) => a && a.status === 'enrolled' && a.agentId != null && mine.has(String(a.agentId)));

/** Titulaire ou membre (pas agent) de la société `companyId`. Lève ScopeError (401/503) si l'appelant n'est pas identifiable. */
async function isCompanyUser(req, companyId, deps) {
  if (!companyId) return false;
  const access = await deps.callerAccess(req);
  if (!access || access.role === 'agent') return false;
  const mine = new Set([access.companyId, ...(access.companyIds || [])].filter(Boolean).map(String));
  return mine.has(String(companyId));
}

/**
 * @param {'gig'|'line'} kind
 * @param {object} deps accès base / service d'inscription (tests)
 */
export function copilotAccess(kind, deps = defaultDeps) {
  return async (req, res, next) => {
    if (req.serviceCaller) return next(); // jeton de service `rep-copilot` déjà vérifié par userOrService
    if (!req.user || !(req.user.userId || req.user.id)) return deny(res, 401, 'Authentication required', 'AUTH_REQUIRED');
    try {
      let companyId;
      let allowedAsAgent = false;
      if (kind === 'gig') {
        const gigId = req.params?.gigId;
        if (!gigId) return deny(res, 400, 'gigId is required', 'GIG_ID_REQUIRED');
        const gig = await deps.findGig(gigId).catch(() => null);
        if (!gig) return deny(res, 404, 'Gig not found', 'GIG_NOT_FOUND');
        companyId = gig.companyId;
        allowedAsAgent = enrolledIn(gig, await myAgentIds(req, deps));
      } else {
        const phoneNumber = req.params?.phoneNumber;
        if (!phoneNumber) return deny(res, 400, 'phoneNumber is required', 'PHONE_NUMBER_REQUIRED');
        const line = await deps.findLine(phoneNumber);
        if (!line) return deny(res, 404, 'Phone number not found', 'PHONE_NUMBER_NOT_FOUND');
        if (!line.companyId) return deny(res, 403, 'This line is not attached to a company', 'LINE_NOT_ATTACHED_TO_COMPANY');
        companyId = line.companyId;
        const mine = await myAgentIds(req, deps);
        if (line.assignedAgentId && mine.has(String(line.assignedAgentId))) allowedAsAgent = true;
        else if (line.gigId) allowedAsAgent = enrolledIn(await deps.findGig(line.gigId).catch(() => null), mine);
      }
      if (allowedAsAgent) return next();
      if (await isCompanyUser(req, companyId, deps)) return next();
      return deny(res, 403, 'Forbidden', 'forbidden');
    } catch (error) {
      if (error instanceof ScopeError || error?.status) return deny(res, error.status, error.message, error.code);
      console.error('[copilotScope] unexpected error', error);
      return deny(res, 500, 'Access check failed', 'ACCESS_CHECK_FAILED');
    }
  };
}

/** Chaîne de middlewares d'une route du copilote : jeton (service `rep-copilot` ou utilisateur), puis contrôle de rattachement. */
export const copilotGuard = (kind, deps = defaultDeps) => [userOrService([REP_COPILOT_SCOPE]), copilotAccess(kind, deps)];
