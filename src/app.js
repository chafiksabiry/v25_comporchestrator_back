import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import { runMigrations } from './db/migrations.js';
import { routes } from './routes/index.js';
import { config } from './config/env.js';
// ... other imports ...

const app = express();

app.use(cors());
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