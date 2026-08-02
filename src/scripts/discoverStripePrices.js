import Stripe from 'stripe';
import { config } from '../config/env.js';

const stripe = new Stripe(config.stripeSecretKey);

async function discoverPrices() {
  try {
    console.log('🔍 Fetching prices from Stripe...');
    const prices = await stripe.prices.list({
      active: true,
      expand: ['data.product'],
    });

    console.log(`✅ Found ${prices.data.length} active prices:`);
    
    const mapping = {
      STARTER: null,
      GROWTH: null,
      SCALE: null
    };

    prices.data.forEach(price => {
      const amount = price.unit_amount / 100;
      const currency = price.currency.toUpperCase();
      const productName = price.product.name;
      
      console.log(`- [${price.id}] ${productName}: ${amount} ${currency}`);

      if (amount === 99) mapping.STARTER = price.id;
      if (amount === 249) mapping.GROWTH = price.id;
      if (amount === 499) mapping.SCALE = price.id;
    });

    console.log('\nSuggested Mapping based on amounts (99, 249, 499):');
    console.log(JSON.stringify(mapping, null, 2));

    if (mapping.STARTER && mapping.GROWTH && mapping.SCALE) {
      console.log('\n🚀 ALL PRICES FOUND! You should update your .env with these values.');
    } else {
      console.log('\n⚠️ Some prices could not be matched automatically. Please check the list above.');
    }

  } catch (error) {
    console.error('❌ Error fetching prices:', error.message);
  }
}

discoverPrices();
