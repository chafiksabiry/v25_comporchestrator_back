// Reprise MANUELLE de l'appel d'essai après une pause automatique (détection d'anomalie).
// Usage (environnement du service, ex. `railway run`) : node src/scripts/trialCallResume.js [--status]
import 'dotenv/config';
import mongoose from 'mongoose';
import { mongoTrialStore } from '../services/trialCall/store.js';

const statusOnly = process.argv.includes('--status');
await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
const before = await mongoTrialStore.getState();
console.log(`État actuel : ${before.paused ? `EN PAUSE depuis ${before.pausedAt?.toISOString?.() || '?'} (${before.reason || 'motif inconnu'})` : 'actif'}`);
if (!statusOnly && before.paused) {
  await mongoTrialStore.resume();
  console.log('Essai repris.');
}
await mongoose.disconnect();
