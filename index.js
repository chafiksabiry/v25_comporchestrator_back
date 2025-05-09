// Load environment variables first
import dotenv from 'dotenv';
// Load .env file
const result = dotenv.config();

if (result.error) {
  console.error('Error loading .env file:', result.error);
  process.exit(1);
}

// Debug logs
/* console.log('Environment variables loaded:');
console.log('TELNYX_API_KEY:', process.env.TELNYX_API_KEY);
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('Current working directory:', process.cwd()); */

import { config } from './src/config/env.js';
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import mongoose from 'mongoose';
import { phoneNumberRoutes } from './src/routes/phoneNumber.js';
import { callRoutes } from './src/routes/call.js';

const app = express();
// Connect to MongoDB
mongoose.connect(config.mongodbUri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('Connected to MongoDB'))
.catch((error) => console.error('MongoDB connection error:', error));
// Middleware
app.use(cors({
  origin: [
    'https://comp-orchestrator.harx.ai',
    'https://api-comp-orchestrator.harx.ai',
    'http://localhost:5173', // Pour le développement local
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Origin', 'X-Requested-With', 'Accept'],
  exposedHeaders: ['Content-Length', 'X-Foo', 'X-Bar'],
  credentials: true,
  maxAge: 86400 // Cache les résultats du preflight pendant 24 heures
}));

// Ajout d'un middleware pour les headers CORS sur toutes les routes
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'https://comp-orchestrator.harx.ai');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  next();
});

app.use(bodyParser.json());
// Routes
app.use('/api/phone-numbers', phoneNumberRoutes);
app.use('/api/calls', callRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something broke!' });
});

// Start server
app.listen(config.port, () => {
  console.log(`Server is running on port ${config.port}`);
});