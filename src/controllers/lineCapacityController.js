import mongoose from 'mongoose';
import { PhoneNumber } from '../models/PhoneNumber.js';
import { guardCompanyAccess } from '../middleware/companyGuard.js';
import { capacityView, validateMaxConcurrentCalls } from '../services/lineCapacity.js';
import { lineCallsEnforced } from '../services/lineCalls.js';
import { loadCompanyPlanLimits } from '../services/planLimits.js';

/**
 * Appels simultanés par ligne (`maxConcurrentCalls`) : lecture pour l'entreprise (titulaire ou membre), modification par le TITULAIRE seulement.
 * Contrat : etude-secretaire-ia/contrat-pilote.md, section 2.7.
 */
const fail = (res, status, code, message, extra = {}) => res.status(status).json({ success: false, error: code, code, message, ...extra });
const validId = (v) => typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v) && mongoose.Types.ObjectId.isValid(v);

export const lineCapacityDeps = {
  enforced: async (companyId) => {
    try { return await lineCallsEnforced({ companyId, limits: await loadCompanyPlanLimits(companyId), db: mongoose.connection.db }); } catch { return false; }
  },
};

async function view(companyId) {
  const lines = await PhoneNumber.find({ companyId, status: 'active' }).sort({ createdAt: 1 }).lean();
  return capacityView(lines, { enforced: await lineCapacityDeps.enforced(companyId) });
}

export const lineCapacityController = {
  async get(req, res) {
    const companyId = req.query?.companyId;
    if (!validId(companyId)) return fail(res, 400, 'INVALID_COMPANY', 'companyId invalide.');
    if (!(await guardCompanyAccess(req, res, companyId))) return;
    try { res.json({ success: true, data: await view(companyId) }); } catch (e) { console.error('line-capacity get:', e.message); fail(res, 500, 'LINE_CAPACITY_READ_FAILED', 'Lecture impossible.'); }
  },

  async put(req, res) {
    const { companyId, lineId, maxConcurrentCalls } = req.body || {};
    if (!validId(companyId)) return fail(res, 400, 'INVALID_COMPANY', 'companyId invalide.');
    if (!(await guardCompanyAccess(req, res, companyId, { ownerOnly: true }))) return;
    const checked = validateMaxConcurrentCalls(maxConcurrentCalls);
    if (!checked.ok) return fail(res, 400, 'LINE_CAPACITY_INVALID', checked.issue.message, { issues: [checked.issue] });
    if (!validId(lineId)) return fail(res, 404, 'LINE_NOT_FOUND', 'Ligne introuvable.');
    try {
      // La ligne doit appartenir à CETTE entreprise : jamais la ligne d'une autre.
      const r = await PhoneNumber.updateOne({ _id: lineId, companyId }, { $set: { maxConcurrentCalls: checked.value } });
      if (!(r?.matchedCount ?? r?.n)) return fail(res, 404, 'LINE_NOT_FOUND', 'Ligne introuvable.');
      res.json({ success: true, data: await view(companyId) });
    } catch (e) { console.error('line-capacity put:', e.message); fail(res, 500, 'LINE_CAPACITY_SAVE_FAILED', 'Enregistrement impossible.'); }
  },
};
