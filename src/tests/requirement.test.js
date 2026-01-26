import { requirementService } from '../services/requirementService.js';
import mongoose from 'mongoose';
import { config } from '../config/env.js';
import fs from 'fs';
import path from 'path';

const connectDB = async () => {
  try {
    console.log('📡 Connecting to MongoDB...');
    await mongoose.connect(config.mongodbUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000, // Timeout après 5 secondes
      socketTimeoutMS: 45000, // Timeout socket après 45 secondes
    });
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

const testRequirements = async () => {
  try {
    // S'assurer que la connexion est établie
    await connectDB();

    console.log('🧪 Starting requirement tests...');
    
    // 1. Test de création de groupe
    console.log('\n1️⃣ Creating requirement group...');
    const { group } = await requirementService.createGroup(
      '68b5b0babacbd5f319451b2a', // Test Company ID
      'FR'
    );
    console.log('✅ Group created:', group._id);

    // 2. Test de soumission d'adresse
    console.log('\n2️⃣ Submitting address...');
    const addressData = {
      businessName: "Test Company",
      street: "123 Test Street",
      city: "Paris",
      state: "Île-de-France",
      postalCode: "75001",
      country: "FR"
    };
    
    const addressResult = await requirementService.submitAddress(
      group._id,
      'a7d9a3a3-70ed-4cb4-821b-b94e8ea6dc9b', // ID du requirement d'adresse
      addressData
    );
    console.log('✅ Address submitted:', addressResult);

    // 3. Test de soumission de valeur textuelle
    console.log('\n3️⃣ Submitting text value...');
    const textResult = await requirementService.submitTextValue(
      group._id,
      '2708e569-696a-4fc7-9305-5fdb3eb9c7dd', // ID du requirement textuel
      'Contact: John Doe, +33123456789'
    );
    console.log('✅ Text value submitted:', textResult);

    // 4. Test de soumission de document
    console.log('\n4️⃣ Submitting document...');
    const testFile = {
      buffer: fs.readFileSync(path.join(process.cwd(), 'src/tests/test.pdf')),
      originalname: 'test.pdf',
      mimetype: 'application/pdf'
    };
    
    const documentResult = await requirementService.submitDocument(
      group._id,
      'b0197fa1-c2fd-4500-9875-2c658b2396eb', // ID du requirement de document
      testFile
    );
    console.log('✅ Document submitted:', documentResult);

    // 5. Test de validation du groupe
    console.log('\n5️⃣ Validating requirement group...');
    const validationResult = await requirementService.validateRequirements(group._id);
    console.log('✅ Validation result:', validationResult);

    // 6. Test de vérification du statut
    console.log('\n6️⃣ Checking group status...');
    const statusResult = await requirementService.checkGroupStatus(group._id);
    console.log('✅ Status result:', statusResult);

    console.log('\n✅ All tests completed successfully!');

    // Fermer proprement la connexion MongoDB
    await mongoose.connection.close();
    console.log('📡 MongoDB connection closed');
    process.exit(0);
  } catch (error) {
    console.error('❌ Test failed:', error);
    // Fermer la connexion même en cas d'erreur
    await mongoose.connection.close();
    console.log('📡 MongoDB connection closed');
    process.exit(1);
  }
};

// Exécuter les tests
testRequirements().catch(async (error) => {
  console.error('❌ Unhandled error:', error);
  await mongoose.connection.close();
  console.log('📡 MongoDB connection closed');
  process.exit(1);
});