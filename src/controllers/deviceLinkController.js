import crypto from 'node:crypto';
import DeviceLink from '../models/DeviceLink.js';
import { createRateLimiter } from '../integrations/rateLimit.js';

// Alphabet sans caractères ambigus : ni 0/O, ni 1/I/L (31 symboles).
export const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;
export const TTL_MS = 5 * 60 * 1000;
export const MAX_ACTIVE_PER_USER = 5;
export const REDEEM_LIMIT_PER_MINUTE = 10;

export function generateCode(randomInt = crypto.randomInt) {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) out += ALPHABET[randomInt(0, ALPHABET.length)];
  return out;
}

/** Insensible à la casse ; espaces et tirets ignorés. */
export function normalizeCode(raw) {
  if (typeof raw !== 'string' || raw.length > 64) return '';
  return raw.replace(/[\s-]+/g, '').toUpperCase();
}

export const hashCode = (normalized) => crypto.createHash('sha256').update(normalized).digest('hex');

/**
 * IP du client. Derrière le proxy de la plateforme, `req.ip` est celle du proxy : on prend l'entrée la plus à droite de
 * X-Forwarded-For (ajoutée par notre proxy, non falsifiable par le client), sinon l'adresse de la socket.
 */
export function clientIp(req) {
  const xff = req.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',').pop().trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

const INVALID = { code: 'INVALID_LINK', message: 'Code invalide ou expiré.' };

export function createDeviceLinkController({
  model = DeviceLink,
  now = () => Date.now(),
  randomInt = crypto.randomInt,
  limiter = createRateLimiter({ limit: REDEEM_LIMIT_PER_MINUTE, windowMs: 60_000, now }),
} = {}) {
  return {
    async create(req, res) {
      try {
        const userId = req.user && (req.user.userId || req.user.id);
        const token = req.headers.authorization?.split(' ')[1];
        if (!userId || !token) return res.status(401).json({ error: 'Authentication required' });
        const companyId = req.user.companyId ? String(req.user.companyId) : null;
        const expiresAt = new Date(now() + TTL_MS);

        let code;
        for (let attempt = 0; ; attempt += 1) {
          code = generateCode(randomInt);
          try {
            await model.create({ codeHash: hashCode(code), userId: String(userId), companyId, bearerToken: token, expiresAt });
            break;
          } catch (e) {
            if (e?.code === 11000 && attempt < 4) continue; // collision de hash : improbable, on retire
            throw e;
          }
        }

        // Au plus 5 codes actifs par utilisateur : les plus anciens sont invalidés.
        const active = await model
          .find({ userId: String(userId), expiresAt: { $gt: new Date(now()) } })
          .sort({ createdAt: -1 })
          .select('_id')
          .lean();
        const stale = active.slice(MAX_ACTIVE_PER_USER).map((d) => d._id);
        if (stale.length) await model.deleteMany({ _id: { $in: stale } });

        // Diagnostic : jamais le code ni le jeton, seulement 4 caractères de l'empreinte et l'échéance.
        console.log(`[device-link] created h=${hashCode(code).slice(0, 4)} expiresAt=${expiresAt.toISOString()}`);
        return res.status(201).json({ code, expiresAt: expiresAt.toISOString() });
      } catch (e) {
        console.error('[device-link] create failed:', e?.name);
        return res.status(500).json({ error: 'Impossible de générer le code.' });
      }
    },

    async redeem(req, res) {
      try {
        const rate = limiter.check(clientIp(req));
        if (!rate.ok) {
          res.set('Retry-After', String(rate.retryAfterSeconds));
          return res.status(429).json({ code: 'RATE_LIMITED', message: 'Trop de tentatives. Réessayez dans une minute.' });
        }
        const normalized = normalizeCode(req.body?.code);
        if (!normalized) return res.status(400).json(INVALID);
        // Suppression atomique : un code ne peut être échangé qu'une fois, même en concurrence.
        const doc = await model.findOneAndDelete({ codeHash: hashCode(normalized), expiresAt: { $gt: new Date(now()) } }).lean();
        if (!doc) {
          // Diagnostic : le code existe-t-il (expiré) ou est-il inconnu (déjà échangé, jamais créé, autre base) ?
          let reason = 'unknown';
          try {
            const h = hashCode(normalized);
            const any = typeof model.findOne === 'function' ? await model.findOne({ codeHash: h }).select('expiresAt').lean() : null;
            if (any) reason = 'expired';
            console.log(`[device-link] redeem miss h=${h.slice(0, 4)} reason=${reason} len=${normalized.length}`);
          } catch { /* le diagnostic ne doit jamais gêner la réponse */ }
          return res.status(400).json(INVALID);
        }
        console.log(`[device-link] redeem ok h=${hashCode(normalized).slice(0, 4)}`);
        return res.json({ token: doc.bearerToken, userId: doc.userId, companyId: doc.companyId ?? null });
      } catch (e) {
        console.error('[device-link] redeem failed:', e?.name);
        return res.status(500).json({ code: 'SERVER_ERROR', message: 'Erreur serveur.' });
      }
    },
  };
}
