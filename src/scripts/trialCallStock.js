// LECTURE SEULE : liste les numéros du stock (inventaire Twilio non attribué, vendable) d'un pays, pour choisir le numéro d'essai,
// et vérifie que les numéros déjà déclarés dans TRIAL_CALL_NUMBERS sont bien exclus de la vente. N'attribue, n'achète, ne modifie rien.
// Usage (environnement du service, ex. `railway run`) : node src/scripts/trialCallStock.js FR
import 'dotenv/config';
import mongoose from 'mongoose';
import { phoneNumberService } from '../services/phoneNumberService.js';
import { parseTrialNumbers } from '../services/trialCall/config.js';

const cc = String(process.argv[2] || 'FR').toUpperCase();
await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
const free = await phoneNumberService.listClaimableInventory({ countryCode: cc, limit: 50 });
console.log(`Stock vendable (${cc}) : ${free.length} numéro(s)`);
for (const n of free) console.log(`  ${n.phoneNumber}`);
const declared = parseTrialNumbers(process.env.TRIAL_CALL_NUMBERS);
for (const [country, number] of Object.entries(declared)) {
  const sold = free.some((n) => n.phoneNumber === number) || phoneNumberService.isInventoryCandidate({ phoneNumber: number });
  console.log(`Numéro d'essai ${country} ${number} : ${sold ? 'ENCORE VENDABLE (anomalie)' : 'exclu de la vente'}`);
}
await mongoose.disconnect();
