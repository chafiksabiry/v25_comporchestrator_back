/**
 * Routes de la vérification d'identité Nomad Solo (spec §3.2).
 *  - abonné : /api/identity-verification/*  (JWT ; titulaire de SA société uniquement, société jamais lue dans la requête) ;
 *  - admin HARX : /admin/identity/*  (JWT admin du tableau de bord, `typeUser === 'admin'` ; décision D11 : aucune clé partagée).
 * Désactivé par défaut (IDENTITY_VERIFICATION_ENABLED) : /status répond { enabled: false } et rien d'autre n'est servi.
 */
import express from 'express';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import { authenticate } from '../middleware/auth.js';
import { guardCompanyAccess } from '../middleware/companyGuard.js';
import { ScopeError } from '../middleware/companyScope.js';
import { createRateLimiter } from '../integrations/rateLimit.js';
import { clientIp } from '../integrations/clientIp.js';
import { getIdentityConfig, IdentityDisabledError } from '../services/identity/config.js';
import { FileRejected } from '../services/identity/files.js';
import { IdentityError, identityService as defaultService } from '../services/identity/service.js';
import { loadDeclaration as defaultLoadDeclaration } from '../services/identity/declaration.js';
import { ADMIN_IDENTITY_HTML } from '../services/identity/adminPage.js';

const NO_STORE = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };

function sendError(res, e, logger = console) {
  if (e instanceof IdentityError) return res.status(e.status).json({ error: e.code, code: e.code, ...e.extra });
  if (e instanceof FileRejected) return res.status(e.code === 'FILE_TOO_LARGE' ? 413 : 400).json({ error: e.code, code: e.code });
  if (e instanceof IdentityDisabledError) return res.status(503).json({ error: 'IDENTITY_UNAVAILABLE', code: 'IDENTITY_UNAVAILABLE' });
  if (e instanceof ScopeError) return res.status(e.status).json({ error: e.code, code: e.code });
  if (e?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'FILE_TOO_LARGE', code: 'FILE_TOO_LARGE' });
  logger.error?.('[identity] erreur :', e?.message);
  return res.status(500).json({ error: 'IDENTITY_ERROR', code: 'IDENTITY_ERROR' });
}

/**
 * @param {object} [deps] injectables pour les tests : service, config, limiteur, chargement de la déclaration
 */
export function createIdentityRoutes({ service = null, config = getIdentityConfig, limiter = createRateLimiter({ limit: 40, windowMs: 10 * 60_000 }), loadDeclaration = defaultLoadDeclaration } = {}) {
  const router = express.Router();
  const svc = async () => service || defaultService();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 4 } });

  router.use((req, res, next) => { res.set(NO_STORE); next(); });

  /** Titulaire de sa propre société (Nomad Solo : une seule personne). */
  const owner = async (req, res, next) => {
    const access = await guardCompanyAccess(req, res, undefined, { ownCompany: true, ownerOnly: true });
    if (!access) return undefined;
    req.identityCompanyId = String(access.companyId);
    return next();
  };
  const enabled = (req, res, next) => (config().enabled ? next() : res.status(404).json({ error: 'IDENTITY_VERIFICATION_DISABLED', code: 'IDENTITY_VERIFICATION_DISABLED' }));
  const limited = (req, res, next) => {
    const r = limiter.check(`identity:${clientIp(req)}`);
    if (!r.ok) { res.set('Retry-After', String(r.retryAfterSeconds)); return res.status(429).json({ error: 'TOO_MANY_REQUESTS', code: 'TOO_MANY_REQUESTS' }); }
    return next();
  };

  router.get('/status', authenticate, async (req, res) => {
    if (!config().enabled) return res.json({ enabled: false });
    const access = await guardCompanyAccess(req, res, undefined, { ownCompany: true, ownerOnly: true });
    if (!access) return undefined;
    try {
      const s = await svc();
      // Déclaration relue seulement s'il existe une vérification validée (détection d'un changement de pays).
      const v = await s.verifiedCountriesFor(access.companyId);
      let declared = null;
      if (v.verified) { try { declared = await loadDeclaration(req, access.companyId); } catch { declared = null; } }
      return res.json(await s.status(access.companyId, { declared }));
    } catch (e) { return sendError(res, e); }
  });

  router.post('/files', authenticate, enabled, limited, owner, (req, res, next) => upload.single('file')(req, res, (err) => (err ? sendError(res, err) : next())), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'FILE_REQUIRED', code: 'FILE_REQUIRED' });
      const out = await (await svc()).upload(req.identityCompanyId, req.user?.userId || req.user?.id, { kind: String(req.body?.kind || ''), docType: String(req.body?.docType || ''), offer: req.body?.offer === 'traveler' ? 'traveler' : null, buffer: req.file.buffer });
      return res.status(201).json(out);
    } catch (e) { return sendError(res, e); }
  });

  router.delete('/files/:fileId', authenticate, enabled, owner, async (req, res) => {
    try { return res.json(await (await svc()).removeFile(req.identityCompanyId, req.params.fileId)); } catch (e) { return sendError(res, e); }
  });

  // Aucun champ métier lu dans le corps : la déclaration est relue côté serveur.
  router.post('/submit', authenticate, enabled, limited, owner, async (req, res) => {
    try { return res.status(202).json(await (await svc()).submit(req, req.identityCompanyId, req.user?.userId || req.user?.id)); } catch (e) { return sendError(res, e); }
  });

  router.post('/review-request', authenticate, enabled, owner, async (req, res) => {
    try { return res.json(await (await svc()).requestReview(req.identityCompanyId)); } catch (e) { return sendError(res, e); }
  });

  return router;
}

/** Admin HARX : JWT du tableau de bord avec `typeUser === 'admin'` (D11). Aucune clé partagée pour des pièces d'identité. */
export function adminFromToken(req) {
  const token = req.get?.('authorization')?.split(' ')[1] || req.headers?.authorization?.split(' ')[1];
  if (!token || !process.env.JWT_SECRET) return null;
  try {
    const d = jwt.verify(token, process.env.JWT_SECRET);
    if (d?.typeUser !== 'admin') return null;
    return String(d.userId || d.id || d.sub || d.email || 'admin');
  } catch { return null; }
}

export function createIdentityAdminRoutes({ service = null, config = getIdentityConfig } = {}) {
  const router = express.Router();
  const svc = async () => service || defaultService();
  const admin = (req, res, next) => {
    if (!config().enabled) return res.status(404).json({ error: 'Not found' });
    const id = adminFromToken(req);
    if (!id) return res.status(401).json({ error: 'Unauthorized' });
    req.identityAdmin = id;
    return next();
  };
  router.use((req, res, next) => { res.set(NO_STORE); next(); });

  // Page statique, sans aucune donnée : le jeton admin est saisi dans le navigateur et envoyé en en-tête aux routes ci-dessous.
  router.get('/', (req, res) => {
    if (!config().enabled) return res.status(404).json({ error: 'Not found' });
    res.set({ 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
    return res.type('html').send(ADMIN_IDENTITY_HTML);
  });
  router.get('/verifications', admin, async (req, res) => {
    try { return res.json({ verifications: await (await svc()).adminList(String(req.query.status || 'review')) }); } catch (e) { return sendError(res, e); }
  });
  router.get('/verifications/:id', admin, async (req, res) => {
    try { return res.json(await (await svc()).adminDetail(req.params.id)); } catch (e) { return sendError(res, e); }
  });
  router.get('/verifications/:id/files/:fileId', admin, async (req, res) => {
    try {
      const f = await (await svc()).adminFile(req.params.id, req.params.fileId, req.identityAdmin, req.query.page);
      res.set({ 'Content-Type': f.mime, 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff' });
      return res.send(f.data);
    } catch (e) { return sendError(res, e); }
  });
  router.post('/verifications/:id/decision', admin, express.json({ limit: '10kb' }), async (req, res) => {
    try { return res.json(await (await svc()).adminDecide(req.params.id, req.identityAdmin, req.body || {})); } catch (e) { return sendError(res, e); }
  });
  return router;
}

export const identityVerificationRoutes = createIdentityRoutes();
export const identityAdminRoutes = createIdentityAdminRoutes();
