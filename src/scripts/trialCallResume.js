// Pause et reprise MANUELLES de l'appel d'essai, sans redéploiement (état en base, lu à chaque requête).
// Usage (environnement du service, ex. `railway run`) :
//   node src/scripts/trialCallResume.js            reprend l'essai après une pause (automatique ou manuelle)
//   node src/scripts/trialCallResume.js --pause    met l'essai en pause immédiatement (le bouton d'essai disparaît, le paiement reste)
//   node src/scripts/trialCallResume.js --status   affiche l'état sans rien changer
import 'dotenv/config';
import mongoose from 'mongoose';
import { mongoTrialStore } from '../services/trialCall/store.js';

const pause = process.argv.includes('--pause');
const statusOnly = process.argv.includes('--status');
await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
const before = await mongoTrialStore.getState();
console.log(`État actuel : ${before.paused ? `EN PAUSE depuis ${before.pausedAt?.toISOString?.() || '?'} (${before.reason || 'motif inconnu'})` : 'actif'}`);
if (pause) {
  await mongoTrialStore.pause('manual');
  console.log('Essai mis en pause (manuel).');
} else if (!statusOnly && before.paused) {
  await mongoTrialStore.resume();
  console.log('Essai repris.');
}
await mongoose.disconnect();
