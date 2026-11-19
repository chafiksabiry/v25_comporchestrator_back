import jwt from 'jsonwebtoken';

/**
 * Requires a valid JWT issued by the registration service.
 * Money routes take companyId from the URL or body, so a missing check
 * lets any caller act on any company. Server-to-server routes stay outside
 * this middleware because the other services have no user token to send.
 */
export function authenticate(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      console.error(`[auth] 401 on ${req.method} ${req.originalUrl}: no Authorization header`);
      return res.status(401).json({ error: 'Authentication required' });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    console.error(`[auth] 401 on ${req.method} ${req.originalUrl}: ${error.name} - ${error.message}`);
    return res.status(401).json({ error: 'Authentication failed' });
  }
}
