import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import telnyx from 'telnyx';

import { phoneNumberRoutes } from './src/routes/phoneNumber.js';
import { callRoutes } from './src/routes/call.js';

// Load environment variables
dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Initialize Telnyx client
const telnyxClient = telnyx(process.env.TELNYX_API_KEY);

// Add Telnyx client to requests
app.use((req, res, next) => {
  req.telnyx = telnyxClient;
  next();
});

// Routes
app.use('/api/phone-numbers', phoneNumberRoutes);
app.use('/api/calls', callRoutes);

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('Connected to MongoDB'))
.catch((error) => console.error('MongoDB connection error:', error));

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something broke!' });
});

// Start server
const PORT = process.env.PORT || 3007;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});