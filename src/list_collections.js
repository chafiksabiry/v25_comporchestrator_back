import mongoose from 'mongoose';
import { config } from './config/env.js';

async function run() {
  await mongoose.connect(config.mongodbUri);
  const db = mongoose.connection.db;
  const collections = await db.listCollections().toArray();
  console.log('Collections in database:', collections.map(c => c.name));
  await mongoose.disconnect();
}

run().catch(console.error);
