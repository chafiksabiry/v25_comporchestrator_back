import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import { runMigrations } from './db/migrations.js';
import { routes } from './routes/index.js';
import { config } from './config/env.js';
import { subscriptionController } from './controllers/subscriptionController.js';
// ... other imports ...

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id', 'x-agent-id']
}));

// IMPORTANT: Stripe webhooks need the raw request body to verify the signature.
// This MUST be mounted before express.json() so the JSON parser does not consume the body.
app.post(
  '/api/subscriptions/webhook',
  express.raw({ type: 'application/json' }),
  subscriptionController.handleWebhook
);

app.use(express.json());

// Connect to MongoDB
mongoose.connect(config.mongodbUri)
  .then(async () => {
    console.log('Connected to MongoDB');
    try {
      await runMigrations();
      console.log('Migrations completed successfully');
    } catch (error) {
      console.error('Error running migrations:', error);
    }
  })
  .catch((error) => {
    console.error('MongoDB connection error:', error);
  });

// Routes
app.use('/api', routes);

// ... rest of your app configuration ...

export default app; 