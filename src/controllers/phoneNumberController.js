import { phoneNumberService } from '../services/phoneNumberService.js';
import { config } from '../config/env.js';
import telnyx from 'telnyx';

class PhoneNumberController {
  async searchNumbers(req, res) {
    try {
      const { countryCode, type, features } = req.query;
      console.log(countryCode, type, features);
      const numbers = await phoneNumberService.searchAvailableNumbers({
        countryCode,
        type,
        features
      });
      res.json(numbers);
    } catch (error) {
      console.error('Error searching phone numbers:', error);
      res.status(500).json({ error: 'Failed to search phone numbers' });
    }
  }

  async searchTwilioNumbers(req, res) {
    try {
      const { countryCode, areaCode, limit } = req.query;
      console.log("countryCode",countryCode);
      console.log("areaCode",areaCode);
      console.log("limit",limit);
      const numbers = await phoneNumberService.searchTwilioNumbers({
        countryCode: countryCode || 'US',
        areaCode,
        limit: parseInt(limit) || 10
      });
      res.json(numbers);
    } catch (error) {
      console.error('Error searching Twilio phone numbers:', error);
      res.status(500).json({ error: 'Failed to search Twilio phone numbers' });
    }
  }

  async purchaseNumber(req, res) {
    try {
      const { phoneNumber, provider, gigId, requirementGroupId, companyId } = req.body;

      // Validation des champs obligatoires
      const missingFields = {
        phoneNumber: !phoneNumber ? 'Phone number is required' : null,
        provider: !provider ? 'Provider is required' : null,
        gigId: !gigId ? 'Gig ID is required' : null,
        requirementGroupId: !requirementGroupId ? 'Requirement group ID is required' : null,
        companyId: !companyId ? 'Company ID is required' : null
      };

      const missingFieldsList = Object.entries(missingFields)
        .filter(([_, value]) => value !== null)
        .map(([key, value]) => ({ field: key, message: value }));

      if (missingFieldsList.length > 0) {
        return res.status(400).json({
          error: 'Missing required fields',
          details: missingFieldsList
        });
      }

      // Validate provider
      if (!['telnyx', 'twilio'].includes(provider)) {
        return res.status(400).json({
          error: 'Invalid provider',
          details: 'Provider must be either "telnyx" or "twilio"'
        });
      }

      const newNumber = await phoneNumberService.purchaseNumber(
        phoneNumber,
        provider,
        gigId,
        requirementGroupId,
        companyId
      );

      res.json({
        success: true,
        data: {
          phoneNumber: newNumber.phoneNumber,
          status: newNumber.status,
          features: newNumber.features,
          provider: newNumber.provider
        }
      });

    } catch (error) {
      console.error('Error purchasing phone number:', error);

      // Handle specific error cases
      if (error.message.includes('already exists')) {
        return res.status(409).json({
          error: 'Conflict',
          message: error.message
        });
      }

      if (error.message.includes('Insufficient balance')) {
        return res.status(402).json({
          error: 'Payment Required',
          message: error.message
        });
      }

      if (error.message.includes('no longer available')) {
        return res.status(410).json({
          error: 'Gone',
          message: error.message
        });
      }

      if (error.message.includes('invalid')) {
        return res.status(400).json({
          error: 'Bad Request',
          message: error.message
        });
      }

      // Generic error handler
      res.status(500).json({
        error: 'Internal Server Error',
        message: error.message || 'Failed to purchase phone number'
      });
    }
  }

  async purchaseTwilioNumber(req, res) {
    try {
      const { phoneNumber, gigId } = req.body;
      console.log("phoneNumber", phoneNumber);

      // Check if gig already has a phone number
      const existingNumber = await phoneNumberService.getPhoneNumbersByGigId(gigId);
      if (existingNumber && existingNumber.length > 0) {
        return res.status(400).json({ 
          error: 'This gig already has a phone number assigned'
        });
      }

      const newNumber = await phoneNumberService.purchaseTwilioNumber(
        phoneNumber,
        config.baseUrl,
        gigId
      );
      console.log("newNumber", newNumber);
      res.json(newNumber);
    } catch (error) {
      console.error('Error purchasing Twilio phone number:', error);
      res.status(500).json({ error: 'Failed to purchase Twilio phone number' });
    }
  }

  async getAllNumbers(req, res) {
    try {
      const numbers = await phoneNumberService.getAllPhoneNumbers();
      res.json(numbers);
    } catch (error) {
      console.error('Error fetching phone numbers:', error);
      res.status(500).json({ error: 'Failed to fetch phone numbers' });
    }
  }

  async checkGigNumber(req, res) {
    try {
      const { gigId } = req.params;
      
      if (!gigId) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'gigId is required'
        });
      }

      console.log(`🔍 Checking number for gig: ${gigId}`);
      const result = await phoneNumberService.checkGigNumber(gigId);
      res.json(result);
    } catch (error) {
      console.error('Error checking gig number:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to check gig number'
      });
    }
  }

  async deleteNumber(req, res) {
    try {
      const result = await phoneNumberService.deletePhoneNumber(req.params.id);
      res.json(result);
    } catch (error) {
      console.error('Error deleting phone number:', error);
      if (error.message === 'Phone number not found') {
        res.status(404).json({ error: error.message });
      } else {
        res.status(500).json({ error: 'Failed to delete phone number' });
      }
    }
  }

  async handleTelnyxNumberOrderWebhook(req, res) {
    try {
      // 1. Vérifier les headers requis
      const timestamp = req.headers['Telnyx-Timestamp'];
      const signature = req.headers['Telnyx-Signature-Ed25519'];
      
      console.log('📝 Headers received:', {
        timestamp: req.headers['Telnyx-Timestamp'],
        signature: req.headers['Telnyx-Signature-Ed25519'] ? '***' : undefined,
        contentType: req.headers['content-type'],
        userAgent: req.headers['user-agent']
      });

      if (!timestamp || !signature) {
        return res.status(400).json({ 
          error: 'Missing required headers',
          details: 'Telnyx-Timestamp and Telnyx-Signature-Ed25519 are required'
        });
      }

      // 2. Vérifier la signature avec telnyx.webhooks.constructEvent
      console.log('📝 Raw body:', req.body);
      console.log('🔐 Signature:', signature);
      console.log('⏰ Timestamp:', timestamp);

      // 1. Convertir le Buffer en string UTF-8
      let rawBody = req.body.toString('utf8');
      
      // 2. Parser et re-stringifier pour avoir un format JSON consistant
      try {
        const parsedBody = JSON.parse(rawBody);
        rawBody = JSON.stringify(parsedBody);  // Sans espaces ni sauts de ligne
      } catch (e) {
        console.error('❌ Failed to normalize JSON:', e);
      }
      
      console.log('📝 Debug webhook verification:');
      console.log('- Original body:', req.body.toString('utf8'));
      console.log('- Normalized body:', rawBody);
      console.log('- Final verification string:', `${timestamp}|${rawBody}`);
      const event = telnyx.webhooks.constructEvent(
        rawBody,
        signature,
        timestamp,
        config.telnyxPublicKey
      );

      console.log('📞 Received Telnyx webhook:', {
        event_type: event.data.event_type,
        id: event.data.id,
        occurred_at: event.data.occurred_at
      });

      // 3. Vérifier que c'est un événement number_order.complete
      if (event.data.event_type !== 'number_order.complete') {
        console.log(`⚠️ Ignoring event type: ${event.data.event_type}`);
        return res.status(200).json({ 
          message: 'Event type not handled',
          eventType: event.data.event_type
        });
      }

      // 4. Extraire les informations de la commande
      const {
        data: {
          id: eventId,
          occurred_at: occurredAt,
          payload: {
            id: orderId,
            status: orderStatus,
            phone_numbers = [],
            requirements_met,
            sub_number_orders_ids = []
          }
        }
      } = event;

      console.log(`📦 Processing order ${orderId} with status ${orderStatus}`);

      // 4. Mettre à jour le statut dans la base de données
      const result = await phoneNumberService.updateNumberOrderStatus({
        eventId,
        occurredAt,
        orderId,
        orderStatus,
        phoneNumbers,
        requirementsMet: requirements_met,
        subOrderIds: sub_number_orders_ids
      });

      // Répondre avec succès après la vérification et le traitement
      res.status(200).json({ 
        success: true,
        orderId,
        status: orderStatus,
        updatedNumbers: result.updatedCount
      });
    } catch (error) {
      if (error.type === 'TelnyxSignatureVerificationError') {
        console.error('❌ Signature verification failed:', error.message);
        return res.status(400).json({
          error: 'Invalid signature',
          message: 'The webhook signature verification failed',
          telnyxError: error.message
        });
      }
      console.error('❌ Error handling Telnyx webhook:', error);
      res.status(500).json({ error: 'Failed to process webhook' });
    }
  }
}

export const phoneNumberController = new PhoneNumberController(); 