// Cycle de vie du numéro d'un abonné NOMAD qui résilie (décision D3 du 23/11) : un passage à la demande, identique à la tâche horaire.
// Usage (environnement du service, ex. `railway run`) :
//   node src/scripts/nomadNumberLifecycle.js --dry-run   -> journalise ce qui serait détaché / résilié, ne modifie RIEN
//   node src/scripts/nomadNumberLifecycle.js             -> passage réel (la résiliation chez Twilio exige NOMAD_NUMBER_RELEASE_ENABLED=true)
import 'dotenv/config';
import mongoose from 'mongoose';
import { runNomadNumberLifecycle } from '../services/nomadNumberLifecycle.js';

const dryRun = process.argv.includes('--dry-run') ? true : undefined;
await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
try {
  const summary = await runNomadNumberLifecycle({ dryRun });
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await mongoose.disconnect();
}
