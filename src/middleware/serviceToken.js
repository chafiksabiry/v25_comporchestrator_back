import jwt from 'jsonwebtoken';
import { authenticate } from './auth.js';

/**
 * Jetons de service (appels serveur à serveur, aucun jeton utilisateur à présenter) : même modèle que /api/internal/call-ended et
 * /api/internal/company-notifications — JWT HS256 signé avec le secret partagé JWT_SECRET, portant une `scope` connue et une expiration
 * (`exp`) obligatoire, sans `userId`. Un jeton utilisateur (sans `scope`) n'est jamais accepté comme jeton de service, et inversement.
 */

/** Le service des appels déclenche le rapprochement d'une société (après une analyse IA, un refus automatique…). */
export const ESCROW_RECONCILE_SCOPE = 'escrow-reconcile';
/** Le service des appels pousse un évènement temps réel « analyse terminée / analyse bloquée ». */
export const CALL_ANALYSIS_NOTIFY_SCOPE = 'call-analysis-notify';

/** @returns {object|null} le jeton décodé si c'est un jeton de service valide d'une des portées données, sinon null. */
export function verifyServiceToken(authorizationHeader, scopes, secret = process.env.JWT_SECRET) {
  const token = String(authorizationHeader || '').split(' ')[1];
  if (!token || !secret) return null;
  try {
    const d = jwt.verify(token, secret, { algorithms: ['HS256'] });
    if (!d || typeof d.exp !== 'number' || d.userId || d.id) return null;
    return [].concat(scopes).includes(d.scope) ? d : null;
  } catch {
    return null;
  }
}

/**
 * Accepte SOIT un jeton de service de la portée donnée (`req.serviceCaller` = jeton décodé), SOIT un jeton utilisateur valide
 * (`authenticate` : `req.user`) — le contrôleur vérifie alors l'appartenance à la société (guardCompanyAccess). Sans jeton : 401.
 */
export function userOrService(scopes) {
  return (req, res, next) => {
    const service = verifyServiceToken(req.headers.authorization, scopes);
    if (service) {
      req.serviceCaller = service;
      return next();
    }
    return authenticate(req, res, next);
  };
}
