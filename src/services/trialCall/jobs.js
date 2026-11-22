import { trialConfig, trialEnabled, missingForActivation } from './config.js';
import { ANOMALY_INTERVAL_MS, runAnomalyCheck } from './anomaly.js';

/**
 * Tâches de fond de l'appel d'essai, démarrées SEULEMENT si l'essai est actif au démarrage (drapeau + configuration complète) :
 * balayeur des appels (toutes les 15 s, coupure à 60 s) et détection d'anomalie (toutes les 5 min). Essai désactivé : rien ne tourne.
 */
/**
 * Collections et index (TTL 12 mois, 24 h, 30 j ; compteurs et verrous) : créés seulement si l'essai ou la mesure est activé.
 * Drapeaux OFF : aucune collection ni aucun index `trial_*` n'est créé.
 */
export async function ensureTrialIndexes({ trial, events }) {
  const M = await import('../../models/TrialCall.js');
  const models = [...(events || trial ? [M.TrialEvent] : []), ...(trial ? [M.TrialCall, M.TrialOtp, M.TrialLookup, M.TrialState, M.TrialCounter, M.TrialLock] : [])];
  await Promise.all(models.map((m) => m.createIndexes()));
  return models.length;
}

export function startTrialCallJobs({ controller, store, isReady = () => true, env = process.env, log = console, ensureIndexes = ensureTrialIndexes }) {
  const cfg = trialConfig(env);
  if (cfg.eventsFlag || trialEnabled(cfg)) {
    ensureIndexes({ trial: trialEnabled(cfg), events: cfg.eventsFlag }).catch((e) => log.error('[trial-call] index :', e?.message || e));
  }
  if (!trialEnabled(cfg)) {
    if (cfg.flag) log.warn(`[trial-call] TRIAL_CALL_ENABLED=true mais configuration incomplète (${missingForActivation(cfg).join(', ')}) : essai désactivé.`);
    return { started: false, stop() {} };
  }
  log.log(`[trial-call] essai actif pour : ${Object.keys(cfg.numbers).filter((c) => cfg.countries.includes(c)).join(', ')}`);
  const sweeper = setInterval(() => { if (isReady()) controller.sweep().catch((e) => log.error('[trial-call] balayeur :', e?.message || e)); }, 15_000);
  const anomaly = setInterval(() => { if (isReady()) runAnomalyCheck({ store, cfg: trialConfig(env) }).catch((e) => log.error('[trial-call] anomalie :', e?.message || e)); }, ANOMALY_INTERVAL_MS);
  return { started: true, stop() { clearInterval(sweeper); clearInterval(anomaly); } };
}
