// Load environment variables first
import dotenv from 'dotenv';
dotenv.config({ silent: true });

import { config } from './src/config/env.js';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import { requirementRoutes } from './src/routes/requirement.js';
import { addressRoutes } from './src/routes/address.js';
import { documentRoutes } from './src/routes/document.js';
import { phoneNumberRoutes } from './src/routes/phoneNumber.js';
import { telnyxRequirementGroupRoutes } from './src/routes/telnyxRequirementGroup.js';

const app = express();

// MongoDB Connection
mongoose.connect(config.mongodbUri, {
  serverSelectionTimeoutMS: 15000, // Timeout after 15s instead of 10s
  socketTimeoutMS: 45000, // Close sockets after 45 seconds of inactivity
  connectTimeoutMS: 15000, // Give up initial connection after 15s
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => {
  console.log('✅ Connected to MongoDB');
}).catch((error) => {
  console.error('❌ MongoDB connection error:', error);
  process.exit(1); // Exit if we can't connect to database
});

// Middleware
app.use((req, res, next) => {
  if (req.originalUrl === '/api/phone-numbers/webhooks/telnyx/number-order') {
    next();
  } else {
    express.json()(req, res, next);
  }
});
app.use(express.urlencoded({ extended: true }));

app.use(cors({
  origin: [
    'https://comp-orchestrator.harx.ai',
    'https://api-comp-orchestrator.harx.ai',
    'http://localhost:5184',
    'http://localhost:5183',
    'http://localhost:3000',
    'https://v25.harx.ai' // Pour le développement local
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// Routes API
app.use('/api/requirements', requirementRoutes);
app.use('/api/addresses', addressRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/requirement-groups', telnyxRequirementGroupRoutes);
app.use('/api/phone-numbers', phoneNumberRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something broke!' });
});

// Start server
const server = app.listen(config.port, () => {
  console.log(`✅ Server is running on port ${config.port}`);
});

// Handle process termination
process.on('SIGINT', () => {
  mongoose.connection.close(() => {
    console.log('MongoDB connection closed through app termination');
    server.close(() => {
      console.log('Server closed through app termination');
      process.exit(0);
    });
  });
});