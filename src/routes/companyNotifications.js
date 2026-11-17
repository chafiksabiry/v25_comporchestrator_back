import express from 'express';
import mongoose from 'mongoose';
import CompanyNotification from '../models/CompanyNotification.js';
import { authenticate } from '../middleware/auth.js';
import { toPublic } from '../services/companyNotificationService.js';
import { guardCompanyAccess } from '../middleware/companyGuard.js';

const router = express.Router();
const validCompany = (req, res, next) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.companyId)) return res.status(400).json({ error: 'Invalid companyId' });
  next();
};

// Company dashboard : JWT + appartenance à CETTE société (propriétaire ou membre : lecture et « lu » ; propriétaire seul : suppression). Refus 403 sans
// aucune lecture ni écriture, service d'inscription indisponible 503 (jamais ouvert).
router.get('/:companyId', authenticate, validCompany, async (req, res) => {
  if (!(await guardCompanyAccess(req, res, req.params.companyId))) return;
  try {
    const limit = Math.min(200, Math.max(1, Math.round(Number(req.query.limit || 50))));
    const rows = await CompanyNotification.find({ companyId: req.params.companyId }).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ success: true, data: rows.map(toPublic) });
  } catch (error) {
    console.error('Error listing company notifications:', error);
    res.status(500).json({ error: 'Failed to list notifications' });
  }
});

router.put('/:companyId/read-all', authenticate, validCompany, async (req, res) => {
  if (!(await guardCompanyAccess(req, res, req.params.companyId))) return;
  try {
    await CompanyNotification.updateMany({ companyId: req.params.companyId, read: false }, { $set: { read: true } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to mark notifications as read' });
  }
});

router.put('/:companyId/:id/read', authenticate, validCompany, async (req, res) => {
  if (!(await guardCompanyAccess(req, res, req.params.companyId))) return;
  try {
    const read = req.body?.read !== false;
    const row = await CompanyNotification.findOneAndUpdate(
      { _id: req.params.id, companyId: req.params.companyId },
      { $set: { read } },
      { new: true }
    ).lean();
    if (!row) return res.status(404).json({ error: 'Notification not found' });
    res.json({ success: true, data: toPublic(row) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update notification' });
  }
});

router.delete('/:companyId/:id', authenticate, validCompany, async (req, res) => {
  if (!(await guardCompanyAccess(req, res, req.params.companyId, { ownerOnly: true }))) return;
  try {
    await CompanyNotification.deleteOne({ _id: req.params.id, companyId: req.params.companyId });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete notification' });
  }
});

router.delete('/:companyId', authenticate, validCompany, async (req, res) => {
  if (!(await guardCompanyAccess(req, res, req.params.companyId, { ownerOnly: true }))) return;
  try {
    await CompanyNotification.deleteMany({ companyId: req.params.companyId });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to clear notifications' });
  }
});

export const companyNotificationRoutes = router;
