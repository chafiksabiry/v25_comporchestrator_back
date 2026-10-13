import jwt from 'jsonwebtoken';

/**
 * Requires a valid JWT (issued by v25_registration_backend). Rejects any
 * request with no token or an invalid/expired one. Money-moving routes
 * (wallet-company, escrow, minutes-company, tokens-company) had no such
 * check at all (cahier de recette PAY-12): an unauthenticated caller could
 * invoke them directly with an arbitrary companyId.
 */
export function authenticate(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Authentication failed' });
  }
}
