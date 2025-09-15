import express from 'express';
import crypto from 'crypto';
import { phoneNumberService } from '../services/phoneNumberService.js';
import { requirementGroupService } from '../services/requirementGroupService.js';
import { config } from '../config/env.js';

const router = express.Router();

// Middleware pour vérifier la signature Telnyx
const verifyTelnyxSignature = (req, res, next) => {
  try {
    const telnyxSignature = req.header('telnyx-signature-ed25519');
    const telnyxTimestamp = req.header('telnyx-timestamp');

    if (!telnyxSignature || !telnyxTimestamp) {
      console.log('❌ Missing Telnyx signature headers');
      return res.status(400).json({ error: 'Missing signature headers' });
    }

    // Construire le payload à vérifier
    const payload = telnyxTimestamp + JSON.stringify(req.body);

    // Vérifier la signature
    const publicKey = config.telnyxPublicKey;
    const verified = crypto.verify(
      null,
      Buffer.from(payload),
      publicKey,
      Buffer.from(telnyxSignature, 'hex')
    );

    if (!verified) {
      console.log('❌ Invalid Telnyx signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    next();
  } catch (error) {
    console.error('❌ Error verifying signature:', error);
    res.status(500).json({ error: 'Signature verification failed' });
  }
};

// Endpoint principal pour les webhooks Telnyx
router.post('/', verifyTelnyxSignature, async (req, res) => {
  try {
    const event = req.body;
    console.log('�webhook Received Telnyx event:', {
      type: event.data.event_type,
      id: event.data.id
    });

    switch (event.data.event_type) {
      case 'number_order.updated':
        await handleNumberOrderUpdate(event);
        break;

      case 'requirement_group.updated':
        await handleRequirementGroupUpdate(event);
        break;

      default:
        console.log('⚠️ Unhandled event type:', event.data.event_type);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Error processing webhook:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Gestionnaire pour les mises à jour de commande de numéro
async function handleNumberOrderUpdate(event) {
  try {
    const updatedNumber = await phoneNumberService.handleOrderWebhook(event);
    
    if (updatedNumber && updatedNumber.status === 'requirements_pending') {
      // TODO: Implémenter la notification à l'entreprise
      console.log('📧 Should notify company about pending requirements');
    }
  } catch (error) {
    console.error('❌ Error handling number order update:', error);
    throw error;
  }
}

// Gestionnaire pour les mises à jour de groupe de requirements
async function handleRequirementGroupUpdate(event) {
  try {
    const { payload } = event.data;
    await requirementGroupService.updateGroupStatus(
      payload.id,
      payload.status
    );
  } catch (error) {
    console.error('❌ Error handling requirement group update:', error);
    throw error;
  }
}

export const telnyxWebhookRoutes = router;
