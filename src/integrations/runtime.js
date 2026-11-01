import mongoose from 'mongoose';
import IntegrationJob from '../models/IntegrationJob.js';
import IntegrationConnection from '../models/IntegrationConnection.js';
import WebhookEndpoint from '../models/WebhookEndpoint.js';
import { loadCompanyPlanLimits } from '../services/planLimits.js';
import { CALLCENTER_TIERS_WITH_INTEGRATIONS } from '../services/callcenterTier.js';
import { defaultHttp } from './http.js';
import { integrationsEnabled, loadKey } from './crypto.js';
import { runDue } from './engine.js';

/** Branchements réels (Mongo, abonnement, HTTP). Les tests utilisent des doubles à la place. */
export async function companyHasIntegrations(companyId) {
  const limits = await loadCompanyPlanLimits(companyId);
  return !!limits && limits.product === 'callcenter' && CALLCENTER_TIERS_WITH_INTEGRATIONS.includes(limits.callcenterTier);
}

const LEASE_MS = 5 * 60_000;
export const mongoJobStore = {
  async insert(j) {
    try {
      await IntegrationJob.create({ ...j, companyId: new mongoose.Types.ObjectId(String(j.companyId)) });
      return true;
    } catch (e) {
      if (e?.code === 11000) return false; // déjà en file pour cet appel
      throw e;
    }
  },
  async claimDue(now, limit) {
    const out = [];
    for (let i = 0; i < limit; i += 1) {
      // Réservation atomique : une autre instance ne reprend pas la tâche pendant qu'on la traite.
      const j = await IntegrationJob.findOneAndUpdate({ status: 'pending', nextAttemptAt: { $lte: now } }, { $set: { nextAttemptAt: new Date(now.getTime() + LEASE_MS) } }, { new: true });
      if (!j) break;
      out.push(j);
    }
    return out;
  },
  async save(j) {
    j.markModified?.('payload');
    await j.save();
  },
};

export const realDeps = () => ({
  store: mongoJobStore,
  http: defaultHttp,
  now: () => new Date(),
  key: loadKey(),
  hasIntegrations: companyHasIntegrations,
  loadConnection: (companyId) => IntegrationConnection.findOne({ companyId }),
  listEndpoints: (companyId) => WebhookEndpoint.find({ companyId, enabled: true }),
  loadEndpoint: (id) => (mongoose.Types.ObjectId.isValid(id) ? WebhookEndpoint.findById(id) : null),
});

let timer = null;
/** Démarre la reprise périodique des tâches. Sans clé de chiffrement, rien ne démarre. */
export function startIntegrationsWorker({ intervalMs = 30_000 } = {}) {
  if (timer) return false;
  if (!integrationsEnabled()) {
    console.warn('[integrations] INTEGRATIONS_ENC_KEY absente ou invalide : intégrations désactivées.');
    return false;
  }
  timer = setInterval(() => {
    runDue(realDeps()).catch((e) => console.error('[integrations] reprise:', e.message));
  }, intervalMs);
  timer.unref?.();
  return true;
}
