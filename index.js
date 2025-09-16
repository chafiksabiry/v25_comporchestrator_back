// Load environment variables first
import dotenv from 'dotenv';
dotenv.config({ silent: true });

import { config } from './src/config/env.js';
import express from 'express';
import cors from 'cors';
import { requirementRoutes } from './src/routes/requirement.js';
import { addressRoutes } from './src/routes/address.js';
import { documentRoutes } from './src/routes/document.js';

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(cors({
  origin: [
    'https://comp-orchestrator.harx.ai',
    'https://api-comp-orchestrator.harx.ai',
    'http://localhost:5184',
    'http://localhost:5183',
    'http://localhost:3000',
    'https://v25.harx.ai',
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// Routes API
app.use('/api/requirements', requirementRoutes);
app.use('/api/addresses', addressRoutes);
app.use('/api/documents', documentRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something broke!' });
});

// Start server
app.listen(config.port, () => {
  console.log(`Server is running on port ${config.port}`);
});