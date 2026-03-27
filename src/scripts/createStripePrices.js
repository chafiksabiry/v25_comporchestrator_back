import Stripe from 'stripe';
import { config } from '../config/env.js';

const stripe = new Stripe(config.stripeSecretKey);

async function createProductsAndPrices() {
  try {
    console.log('🚀 Creating products and prices in Stripe...');

    const plans = [
      { name: 'STARTER', amount: 99 },
      { name: 'GROWTH', amount: 249 },
      { name: 'SCALE', amount: 499 }
    ];

    const results = {};

    for (const plan of plans) {
      console.log(`\n📦 Creating product: ${plan.name}...`);
      const product = await stripe.products.create({
        name: plan.name,
      });

      console.log(`💰 Creating price for ${plan.name}: ${plan.amount} EUR...`);
      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: plan.amount * 100,
        currency: 'eur',
        recurring: { interval: 'month' },
      });

      console.log(`✅ ${plan.name} created! Price ID: ${price.id}`);
      results[plan.name] = price.id;
    }

    console.log('\n✨ All products and prices created successfully!');
    console.log('Update your .env with these Price IDs:');
    console.log(`STRIPE_PRICE_STARTER=${results.STARTER}`);
    console.log(`STRIPE_PRICE_GROWTH=${results.GROWTH}`);
    console.log(`STRIPE_PRICE_SCALE=${results.SCALE}`);

  } catch (error) {
    console.error('❌ Error creating Stripe resources:', error.message);
  }
}

createProductsAndPrices();
