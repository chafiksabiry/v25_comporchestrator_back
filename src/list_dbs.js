import mongoose from 'mongoose';
import { config } from './config/env.js';

async function run() {
  await mongoose.connect(config.mongodbUri);
  const admin = mongoose.connection.db.admin();
  const dbs = await admin.listDatabases();
  console.log('Databases:', dbs.databases.map(d => d.name));
  await mongoose.disconnect();
}

run().catch(console.error);
