import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import CompanyNotification from '../models/CompanyNotification.js';

const KINDS = new Set(['enrollment_request', 'enrollment_accepted', 'enrollment_rejected', 'wallet', 'tokens', 'minutes', 'phone', 'subscription', 'info']);

/** Server-to-server callers (matching…) prove themselves with a short-lived JWT signed with the shared secret. */
export const INGEST_SCOPE = 'company-notify';

export function verifyIngestToken(authorizationHeader) {
  const token = String(authorizationHeader || '').split(' ')[1];
  if (!token) return false;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded?.scope === INGEST_SCOPE;
  } catch {
    return false;
  }
}

/**
 * Creates the notification once per (companyId, key). Never throws: a notification must not break the
 * business flow that triggers it.
 */
export async function notifyCompany({ companyId, key, kind = 'info', title, message = '', gigId = null, actionPath = null }) {
  try {
    if (!companyId || !mongoose.Types.ObjectId.isValid(String(companyId)) || !key || !title) return null;
    return await CompanyNotification.findOneAndUpdate(
      { companyId, key: String(key) },
      {
        $setOnInsert: {
          companyId,
          key: String(key),
          kind: KINDS.has(kind) ? kind : 'info',
          title: String(title).slice(0, 200),
          message: String(message).slice(0, 600),
          gigId: gigId ? String(gigId) : null,
          actionPath: actionPath ? String(actionPath).slice(0, 200) : null,
          read: false,
        },
      },
      { upsert: true, new: true }
    ).lean();
  } catch (error) {
    console.error('[companyNotification] failed:', error.message);
    return null;
  }
}

export const toPublic = (row) => ({
  id: String(row._id),
  kind: row.kind,
  title: row.title,
  message: row.message,
  gigId: row.gigId || null,
  actionPath: row.actionPath || null,
  read: Boolean(row.read),
  createdAt: row.createdAt,
});
