import mongoose from 'mongoose';

/**
 * Compte désactivé ou supprimé (v25_registration_backend : champ `users.disabled`, journal `account_deletions`) : refus immédiat, même
 * avec un jeton déjà émis (maquette A2 : « connexion bloquée tout de suite, sessions ouvertes fermées »). Même règle que le service
 * d'inscription (même base) ; cache court par compte pour rester bon marché.
 *
 * Règles :
 *  - compte actif (cas normal) : rien ne change, le jeton passe ;
 *  - base non connectée, ou lecture en échec : le jeton passe (jamais de panne de connexion pour tous les comptes actifs) ;
 *  - un compte introuvable n'est refusé QUE s'il figure au journal des suppressions (un jeton d'un autre service n'est jamais bloqué).
 */
export const ACCOUNT_GATE_TTL_MS = 5 * 1000;
export const ACCOUNT_DELETIONS_COLLECTION = 'account_deletions';

const cache = new Map();
let lookupOverride = null;

/** Tests : remplace la lecture en base (`async (userId) => 'active' | 'disabled' | 'deleted'`) ; `null` rétablit la lecture réelle. */
export function setAccountGateLookup(fn) {
  lookupOverride = fn;
  cache.clear();
}

/** Oublie l'état mis en cache d'un compte (désactivation, réactivation, suppression : effet immédiat sur ce serveur). */
export function forgetAccountState(userId) {
  if (userId == null) cache.clear();
  else cache.delete(String(userId));
}

async function readState(userId) {
  if (!mongoose.Types.ObjectId.isValid(String(userId))) return 'active';
  const _id = new mongoose.Types.ObjectId(String(userId));
  const db = mongoose.connection.db;
  const user = await db.collection('users').findOne({ _id }, { projection: { disabled: 1 } });
  if (user) return user.disabled === true ? 'disabled' : 'active';
  const deleted = await db.collection(ACCOUNT_DELETIONS_COLLECTION).findOne({ userId: String(userId) }, { projection: { _id: 1 } });
  return deleted ? 'deleted' : 'active';
}

/**
 * État du compte : `'active' | 'disabled' | 'deleted'`. Renvoie la valeur directement (cache, base non connectée) ou une promesse.
 * Une promesse ne rejette jamais (échec de lecture = 'active').
 */
export function accountState(userId, now = Date.now()) {
  if (!userId) return 'active';
  const key = String(userId);
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.state;
  const lookup = lookupOverride || (mongoose.connection.readyState === 1 ? readState : null);
  if (!lookup) return 'active';
  return Promise.resolve()
    .then(() => lookup(key))
    .then((state) => {
      const s = state === 'disabled' || state === 'deleted' ? state : 'active';
      cache.set(key, { state: s, expires: Date.now() + ACCOUNT_GATE_TTL_MS });
      return s;
    })
    .catch((err) => {
      console.warn('[auth] lecture de l’état du compte impossible, jeton accepté :', err?.message || err);
      return 'active';
    });
}

/** Réponse de refus d'un compte désactivé (403) ou supprimé (401). */
export function refuseAccount(res, state) {
  if (state === 'disabled') {
    return res.status(403).json({ error: 'Account disabled', message: 'Account disabled', code: 'ACCOUNT_DISABLED' });
  }
  return res.status(401).json({ error: 'Account deleted', message: 'Account deleted', code: 'ACCOUNT_DELETED' });
}

/**
 * Comptes à ne jamais désactiver, supprimer ni résilier (compte de démonstration fourni à Apple, NON-REGRESSION.md du 23/11/2026).
 * PROTECTED_ACCOUNT_EMAILS (liste séparée par des virgules) s'ajoute à la liste par défaut.
 */
export const DEFAULT_PROTECTED_ACCOUNT_EMAILS = ['chafik.sabiry4apple@harx.ai'];

export function protectedAccountEmails(env = process.env) {
  const extra = String(env.PROTECTED_ACCOUNT_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return new Set([...DEFAULT_PROTECTED_ACCOUNT_EMAILS, ...extra]);
}

export function isProtectedAccount(email, env = process.env) {
  return protectedAccountEmails(env).has(String(email || '').trim().toLowerCase());
}

/** Laisse passer (`proceed()`) un compte actif, refuse un compte désactivé ou supprimé ; synchrone quand l'état est déjà connu. */
export function gateAccount(userId, res, next, proceed) {
  const state = accountState(userId);
  if (state && typeof state.then === 'function') {
    return state.then((s) => (s === 'active' ? proceed() : refuseAccount(res, s))).catch((err) => next(err));
  }
  return state === 'active' ? proceed() : refuseAccount(res, state);
}
