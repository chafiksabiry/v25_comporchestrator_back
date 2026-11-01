import mongoose from 'mongoose';
import ReachSettings from '../models/ReachSettings.js';
import PushSubscription from '../models/PushSubscription.js';
import { callerAccess, ScopeError } from '../middleware/companyScope.js';
import { toPublicReach, validateReachInput } from '../services/reach.js';
import { isAvailable } from '../services/voicePresenceService.js';
import { notifyOwners, pushAvailable, PUSH_UNAVAILABLE_MESSAGE, validateSubscription, vapidConfig } from '../services/webPush.js';

const fail = (res, status, message) => res.status(status).json({ success: false, error: message, message });
const NOT_OWNER = 'Réservé au titulaire du centre.';

/** Titulaire authentifié de son centre ; répond lui-même et renvoie null en cas de refus. */
async function ownerContext(req, res) {
  let access;
  try {
    access = await callerAccess(req);
  } catch (e) {
    if (e instanceof ScopeError) { fail(res, e.status, e.message); return null; }
    throw e;
  }
  if (!access.companyId) { fail(res, 403, 'Aucun centre rattaché à votre compte.'); return null; }
  if (access.role !== 'owner') { fail(res, 403, NOT_OWNER); return null; }
  const asked = req.query?.companyId ?? req.body?.companyId;
  if (asked && String(asked) !== access.companyId) { fail(res, 403, 'Ce centre n’est pas le vôtre.'); return null; }
  if (!mongoose.Types.ObjectId.isValid(access.companyId)) { fail(res, 400, 'Centre invalide.'); return null; }
  return access;
}

export function createReachController({ settingsModel = ReachSettings, subsModel = PushSubscription, pushClient, ensureWebhook = async () => {} } = {}) {
  return {
    async getSettings(req, res) {
      try {
        const access = await ownerContext(req, res);
        if (!access) return;
        const doc = await settingsModel.findOne({ companyId: access.companyId }).lean();
        res.json({
          success: true,
          data: {
            ...toPublicReach(doc),
            browserPresent: isAvailable(access.userId),
            pushAvailable: pushAvailable(),
          },
        });
      } catch (error) {
        console.error('Error in reach getSettings:', error.message);
        fail(res, 500, 'Réglages de joignabilité indisponibles.');
      }
    },

    async putSettings(req, res) {
      try {
        const access = await ownerContext(req, res);
        if (!access) return;
        const current = await settingsModel.findOne({ companyId: access.companyId }).lean();
        const { ok, errors, value } = validateReachInput(req.body || {}, current || {});
        if (!ok) return res.status(400).json({ success: false, error: 'Bad Request', message: errors.join(' '), errors });
        const doc = await settingsModel.findOneAndUpdate(
          { companyId: access.companyId },
          { $set: { ...value, updatedBy: access.userId }, $setOnInsert: { companyId: access.companyId } },
          { upsert: true, new: true }
        ).lean();
        // La ligne doit envoyer ses appels entrants au serveur même si personne n'a encore ouvert l'application.
        if (value.forwardEnabled) {
          Promise.resolve(ensureWebhook(access.companyId, req)).catch((e) => console.error('ensureInboundWebhook:', e.message));
        }
        res.json({ success: true, data: { ...toPublicReach(doc), browserPresent: isAvailable(access.userId), pushAvailable: pushAvailable() } });
      } catch (error) {
        console.error('Error in reach putSettings:', error.message);
        fail(res, 500, 'Réglages non enregistrés.');
      }
    },

    /** Clé publique VAPID (publique par nature) ; `available: false` si le serveur n'est pas configuré. */
    async publicKey(req, res) {
      const vapid = vapidConfig();
      if (!vapid) return res.json({ success: true, data: { available: false, publicKey: null, message: PUSH_UNAVAILABLE_MESSAGE } });
      res.json({ success: true, data: { available: true, publicKey: vapid.publicKey } });
    },

    async subscribe(req, res) {
      try {
        const access = await ownerContext(req, res);
        if (!access) return;
        if (!pushAvailable()) return fail(res, 503, PUSH_UNAVAILABLE_MESSAGE);
        const v = validateSubscription(req.body?.subscription);
        if (!v.ok) return res.status(400).json({ success: false, error: 'Bad Request', message: v.errors.join(' '), errors: v.errors });
        // Un même navigateur ne garde qu'un abonnement : s'il change de compte, il passe au nouveau.
        await subsModel.updateOne(
          { endpoint: v.value.endpoint },
          { $set: { userId: access.userId, companyId: access.companyId, role: 'owner', keys: v.value.keys, userAgent: String(req.headers['user-agent'] || '').slice(0, 200) } },
          { upsert: true }
        );
        res.status(201).json({ success: true, data: { subscribed: true } });
      } catch (error) {
        console.error('Error in reach subscribe:', error.message);
        fail(res, 500, 'Abonnement aux notifications non enregistré.');
      }
    },

    async unsubscribe(req, res) {
      try {
        const access = await ownerContext(req, res);
        if (!access) return;
        const endpoint = String(req.body?.endpoint || '');
        if (!endpoint) return fail(res, 400, 'Point d’arrivée manquant.');
        await subsModel.deleteOne({ endpoint, userId: access.userId });
        res.json({ success: true, data: { subscribed: false } });
      } catch (error) {
        console.error('Error in reach unsubscribe:', error.message);
        fail(res, 500, 'Désabonnement impossible.');
      }
    },

    /** Ce navigateur est-il abonné (pour cet utilisateur) ? */
    async status(req, res) {
      try {
        const access = await ownerContext(req, res);
        if (!access) return;
        const endpoint = String(req.query?.endpoint || '');
        const count = await subsModel.countDocuments({ userId: access.userId });
        const here = endpoint ? (await subsModel.countDocuments({ userId: access.userId, endpoint })) > 0 : false;
        res.json({ success: true, data: { subscribed: here, devices: count, available: pushAvailable() } });
      } catch (error) {
        console.error('Error in reach status:', error.message);
        fail(res, 500, 'État des notifications indisponible.');
      }
    },

    /** Notification de test vers les appareils de l'utilisateur. */
    async test(req, res) {
      try {
        const access = await ownerContext(req, res);
        if (!access) return;
        if (!pushAvailable()) return fail(res, 503, PUSH_UNAVAILABLE_MESSAGE);
        const r = await notifyOwners({ userId: access.userId }, { kind: 'test', title: 'Notifications activées', body: 'Vous serez prévenu des appels et des messages. Touchez pour ouvrir l’application.', tag: 'test', url: '/app/calls' }, { client: pushClient, store: subsModel });
        res.json({ success: true, data: { sent: r.sent, failed: r.failed } });
      } catch (error) {
        console.error('Error in reach test:', error.message);
        fail(res, 500, 'Notification de test non envoyée.');
      }
    },
  };
}
