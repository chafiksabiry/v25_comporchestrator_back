import mongoose from 'mongoose';
import { config } from '../config/env.js';
import { SubscriptionPlan } from '../models/SubscriptionPlan.js';

const plans = [
  {
    name: 'STARTER',
    price: 99,
    stripePriceId: 'price_starter_placeholder',
    description: 'Start your campaigns with simplicity and efficiency',
    features: [
      'Active GIGs: 3',
      'Active REPs: 5',
      'AI Powered Gig Engine',
      'AI Powered Script Engine',
      'AI Powered Learning Planner',
      'AI Powered GIGS REPS Matching Scheduler',
      'Qualified REPs on demand',
      'Dashboard with Standard KPIs',
      'Email support with assisted onboarding'
    ],
    maxGigs: 3,
    maxReps: 5
  },
  {
    name: 'GROWTH',
    price: 249,
    stripePriceId: 'price_growth_placeholder',
    description: 'Drive multi channel efforts with AI automation',
    isPopular: true,
    features: [
      'Active GIGs: 10',
      'Active REPs: 15',
      'Channels: Outbound Calls Only',
      'All Starter Features',
      'AI Powered Lead Management Engine',
      'AI Powered Knowledge Base Engine',
      'AI Powered Call Monitoring and Audit',
      'Call storage - 3 months',
      'Priority support + chat'
    ],
    maxGigs: 10,
    maxReps: 15
  },
  {
    name: 'SCALE',
    price: 499,
    stripePriceId: 'price_scale_placeholder',
    description: 'Activate Intelligence at scale',
    features: [
      'Active GIGs: 25',
      'Active REPs: 50',
      'Channels: Outbound Calls Only',
      'Global Coverage',
      'All Growth Features Included',
      'Priority Support - live chat, email',
      'Customization - Dashboard, Analytics, Integrations'
    ],
    maxGigs: 25,
    maxReps: 50
  }
];

const seedPlans = async () => {
  try {
    await mongoose.connect(config.mongodbUri);
    console.log('✅ Connected to MongoDB for seeding');

    for (const planData of plans) {
      await SubscriptionPlan.findOneAndUpdate(
        { name: planData.name },
        planData,
        { upsert: true, new: true }
      );
    }

    console.log('✅ Subscription plans seeded successfully');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding plans:', error);
    process.exit(1);
  }
};

seedPlans();
