import mongoose from 'mongoose';
import { config } from '../config/env.js';
import { stripeService } from '../services/stripeService.js';
import { MINUTE_PACKS } from '../config/minutesPricing.js';

const NAME_HINTS = [
  { match: /standard|150/i, minutes: 150 },
  { match: /\bpro\b|500/i, minutes: 500 },
  { match: /expert|1000/i, minutes: 1000 },
];

async function syncStripeMinutePacks() {
  if (!stripeService.isConfigured()) {
    console.error('STRIPE_SECRET_KEY manquant');
    process.exit(1);
  }

  await mongoose.connect(config.mongodbUri);
  console.log('Connected to MongoDB');

  const prices = await stripeService.getPublicPlans();
  console.log(`Found ${prices.data.length} active Stripe prices`);

  for (const price of prices.data) {
    const productName = String(price.product?.name || '');
    const hint = NAME_HINTS.find((h) => h.match.test(productName));
    if (!hint) continue;

    const pack = MINUTE_PACKS.find((p) => p.minutes === hint.minutes);
    if (!pack) continue;

    console.log(
      `Match: ${productName} → ${hint.minutes} min (${price.id}) — set STRIPE_PRICE_MINUTES_${hint.minutes}=${price.id}`
    );
  }

  console.log('Sync terminé. Copiez les price_id dans les variables STRIPE_PRICE_MINUTES_* sur Railway.');
  await mongoose.connection.close();
  process.exit(0);
}

syncStripeMinutePacks().catch((err) => {
  console.error(err);
  process.exit(1);
});
