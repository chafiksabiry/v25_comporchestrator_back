import { trialConfig, trialEnabled, missingForActivation } from './config.js';
import { ANOMALY_INTERVAL_MS, runAnomalyCheck } from './anomaly.js';

/**
 * Tâches de fond de l'appel d'essai, démarrées SEULEMENT si l'essai est actif au démarrage (drapeau + configuration complète) :
 * balayeur des appels (toutes les 15 s, coupure à 60 s) et détection d'anomalie (toutes les 5 min). Essai désactivé : rien ne tourne.
 */
export function startTrialCallJobs({ controller, store, isReady = () => true, env = process.env, log = console }) {
  const cfg = trialConfig(env);
  if (!trialEnabled(cfg)) {
    if (cfg.flag) log.warn(`[trial-call] TRIAL_CALL_ENABLED=true mais configuration incomplète (${missingForActivation(cfg).join(', ')}) : essai désactivé.`);
    return { started: false, stop() {} };
  }
  log.log(`[trial-call] essai actif pour : ${Object.keys(cfg.numbers).filter((c) => cfg.countries.includes(c)).join(', ')}`);
  const sweeper = setInterval(() => { if (isReady()) controller.sweep().catch((e) => log.error('[trial-call] balayeur :', e?.message || e)); }, 15_000);
  const anomaly = setInterval(() => { if (isReady()) runAnomalyCheck({ store, cfg: trialConfig(env) }).catch((e) => log.error('[trial-call] anomalie :', e?.message || e)); }, ANOMALY_INTERVAL_MS);
  return { started: true, stop() { clearInterval(sweeper); clearInterval(anomaly); } };
}
