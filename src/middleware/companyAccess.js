import mongoose from 'mongoose';

function sameId(a, b) {
  return String(a || '') !== '' && String(a) === String(b || '');
}

/**
 * A login token proves who the caller is. Money routes also name a company.
 * Allow the owner, an invited teammate, or call-center staff of that company.
 */
export async function userCanAccessCompany(user, companyId) {
  const userId = user?.userId || user?.id;
  if (!userId || !mongoose.Types.ObjectId.isValid(userId)) return false;
  if (!companyId || !mongoose.Types.ObjectId.isValid(companyId)) return false;
  if (sameId(user.employerCompanyId, companyId)) return true;

  const db = mongoose.connection?.db;
  if (!db) return false;

  const companyObjectId = new mongoose.Types.ObjectId(companyId);
  const userObjectId = new mongoose.Types.ObjectId(userId);

  const company = await db.collection('companies').findOne(
    { _id: companyObjectId },
    { projection: { userId: 1 } }
  );
  if (company && sameId(company.userId, userId)) return true;

  const membership = await db.collection('companymemberships').findOne({
    $or: [
      { companyId: companyObjectId, userId: userObjectId },
      { companyId: String(companyId), userId: String(userId) },
    ],
  });
  if (membership) return true;

  const account = await db.collection('users').findOne(
    { _id: userObjectId },
    { projection: { employerCompanyId: 1 } }
  );
  return Boolean(account && sameId(account.employerCompanyId, companyId));
}

export async function requireCompanyAccess(req, res, next) {
  try {
    const companyId = req.params.companyId || req.body?.companyId || req.query?.companyId;
    if (!companyId) {
      return res.status(400).json({ error: 'companyId is required' });
    }
    const allowed = await userCanAccessCompany(req.user, companyId);
    if (!allowed) {
      return res.status(403).json({ error: 'You do not have access to this company' });
    }
    return next();
  } catch {
    return res.status(403).json({ error: 'You do not have access to this company' });
  }
}
