import { phoneNumberService } from '../services/phoneNumberService.js';
import { config } from '../config/env.js';
import telnyx from 'telnyx';
import mongoose from 'mongoose';
import PhoneNumberPayment from '../models/PhoneNumberPayment.js';

// Default checkout pricing for a phone line (overridable via env).
// Stored in cents (EUR) — 100 = 1.00€.
const DEFAULT_LINE_SETUP_FEE_CENTS = parseInt(process.env.PHONE_LINE_SETUP_FEE_CENTS || '500', 10); // 5.00€
const DEFAULT_LINE_CURRENCY = (process.env.PHONE_LINE_CURRENCY || 'EUR').toUpperCase();

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
      console.log("countryCode", countryCode);
      console.log("areaCode", areaCode);
      console.log("limit", limit);
      const numbers = await phoneNumberService.searchTwilioNumbers({
        countryCode: countryCode || 'US',
        areaCode,
        limit: parseInt(limit) || 10
      });
      res.json(numbers);
    } catch (error) {
      console.error('Error searching Twilio phone numbers:', error);
      res.status(error.status || 500).json({ error: error.message || 'Failed to search Twilio phone numbers' });
    }
  }

  async purchaseNumber(req, res) {
    try {
      const { phoneNumber, provider, gigId, requirementGroupId, companyId, bundleSid, addressSid } = req.body;

      // Validation des champs obligatoires
      // Validation des champs obligatoires
      const missingFields = {
        phoneNumber: !phoneNumber ? 'Phone number is required' : null,
        provider: !provider ? 'Provider is required' : null,
        gigId: !gigId ? 'Gig ID is required' : null,
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
        companyId,
        { bundleSid, addressSid }
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
      console.log("📥 Received purchaseTwilioNumber request");
      console.log("📦 req.body:", JSON.stringify(req.body, null, 2));

      const { phoneNumber, gigId, companyId, bundleSid, addressSid, paymentId } = req.body;
      console.log("phoneNumber", phoneNumber);

      // Gate the purchase behind a confirmed Stripe / PayPal payment.
      // This keeps the company wallet (€ commissions) completely separate
      // from phone line spend.
      if (!paymentId || !mongoose.Types.ObjectId.isValid(paymentId)) {
        return res.status(402).json({
          error: 'Payment required',
          message: 'A confirmed payment (Stripe or PayPal) is required to provision a phone line.'
        });
      }
      const payment = await PhoneNumberPayment.findById(paymentId);
      if (!payment || payment.status !== 'succeeded') {
        return res.status(402).json({
          error: 'Payment not completed',
          message: 'No succeeded payment matches this purchase request.'
        });
      }
      if (payment.phoneNumber !== phoneNumber) {
        return res.status(400).json({
          error: 'Payment / number mismatch',
          message: 'The payment was not authorized for this exact phone number.'
        });
      }

      // Multi-number support: we allow multiple phone numbers per gig now.
      // Removed the 'existingNumber' check.

      // Convert the Stripe / PayPal amount (stored in cents) to major units
      // for persistence on the PhoneNumber document (e.g. 500 -> 5.00€).
      const paidPrice = payment.amount > 0 ? payment.amount / 100 : 0;

      const newNumber = await phoneNumberService.purchaseTwilioNumber(
        phoneNumber,
        config.baseUrl,
        gigId,
        companyId,
        {
          bundleSid,
          addressSid,
          price: paidPrice,
          currency: payment.currency,
          paymentRef: payment._id
        }
      );
      console.log("newNumber", newNumber);

      // Backlink the payment to the provisioned PhoneNumber doc for audit.
      try {
        if (newNumber?._id) {
          payment.phoneNumberRef = newNumber._id;
          await payment.save();
        }
      } catch (linkErr) {
        console.warn('Could not backlink payment -> phone number:', linkErr.message);
      }

      res.json(newNumber);
    } catch (error) {
      console.error('Error purchasing Twilio phone number:', error);

      if (error.code === 21404) {
        return res.status(400).json({
          error: 'Twilio Trial Limit Reached',
          message: 'Trial accounts are allowed only one Twilio number. Please upgrade your Twilio account to purchase more numbers.'
        });
      }

      if (error.code === 21649) {
        return res.status(400).json({
          error: 'Regulatory Bundle Required',
          message: 'This phone number requires regulatory documentation (Identity/Address verification). Please submit the required documents in the Twilio Console or choose a number from a different region.',
          moreInfo: error.moreInfo
        });
      }

      res.status(500).json({
        error: 'Failed to purchase Twilio phone number',
        message: error.message
      });
    }
  }

  /**
   * Create a pending payment for a phone line.
   * Returns { paymentId, amount, currency, checkoutUrl? } so the client
   * can either redirect to a Stripe Checkout Session / PayPal order, or
   * — when no provider SDK is configured server-side — fall back to a
   * client-side simulated confirmation.
   *
   * No wallet (`WalletCompany`) interaction here; this is fully separate.
   */
  async initLineCheckout(req, res) {
    try {
      const { phoneNumber, gigId, companyId, provider } = req.body;
      if (!phoneNumber || !companyId || !provider) {
        return res.status(400).json({ error: 'phoneNumber, companyId and provider are required' });
      }
      if (!['stripe', 'paypal'].includes(provider)) {
        return res.status(400).json({ error: "provider must be either 'stripe' or 'paypal'" });
      }
      if (!mongoose.Types.ObjectId.isValid(companyId)) {
        return res.status(400).json({ error: 'Invalid companyId' });
      }

      const payment = await PhoneNumberPayment.create({
        companyId: new mongoose.Types.ObjectId(companyId),
        gigId: gigId && mongoose.Types.ObjectId.isValid(gigId) ? new mongoose.Types.ObjectId(gigId) : undefined,
        phoneNumber,
        provider,
        amount: DEFAULT_LINE_SETUP_FEE_CENTS,
        currency: DEFAULT_LINE_CURRENCY,
        status: 'pending'
      });

      // 💳 Real Stripe / PayPal session creation should happen here.
      // Until SDK keys are wired in `process.env`, we expose a stub
      // checkout URL that the frontend recognizes and walks through a
      // simulated confirmation step. The DB record + audit trail are
      // already real.
      let checkoutUrl;
      if (provider === 'stripe' && process.env.STRIPE_SECRET_KEY) {
        // TODO: create a Stripe Checkout Session and set checkoutUrl.
        checkoutUrl = undefined;
      } else if (provider === 'paypal' && process.env.PAYPAL_CLIENT_SECRET) {
        // TODO: create a PayPal order and set checkoutUrl.
        checkoutUrl = undefined;
      } else {
        checkoutUrl = `internal://stub-checkout/${payment._id}`;
      }

      if (checkoutUrl) {
        payment.checkoutUrl = checkoutUrl;
        await payment.save();
      }

      res.status(201).json({
        success: true,
        paymentId: payment._id,
        amount: payment.amount,
        currency: payment.currency,
        provider: payment.provider,
        checkoutUrl
      });
    } catch (error) {
      console.error('Error initializing line checkout:', error);
      res.status(500).json({ error: 'Failed to initialize checkout', message: error.message });
    }
  }

  /**
   * Confirm a phone line payment (called from the frontend after the
   * Stripe / PayPal popup resolves, or by a provider webhook). Marks
   * the payment as `succeeded`. The actual line provisioning is still
   * done by `purchaseTwilioNumber`, which now requires this payment.
   */
  async confirmLineCheckout(req, res) {
    try {
      const { paymentId, providerRef } = req.body;
      if (!paymentId || !mongoose.Types.ObjectId.isValid(paymentId)) {
        return res.status(400).json({ error: 'Valid paymentId is required' });
      }
      const payment = await PhoneNumberPayment.findById(paymentId);
      if (!payment) {
        return res.status(404).json({ error: 'Payment not found' });
      }
      if (payment.status === 'succeeded') {
        return res.status(200).json({ success: true, payment });
      }
      if (payment.status === 'failed' || payment.status === 'refunded') {
        return res.status(409).json({ error: `Payment is already ${payment.status}` });
      }

      // 🔐 In a real Stripe / PayPal integration we would verify the
      // server-side payment status against the provider here using
      // `providerRef`. With stub mode (no SDK keys) we trust the client.
      payment.status = 'succeeded';
      if (providerRef) payment.providerRef = providerRef;
      await payment.save();

      res.json({ success: true, payment });
    } catch (error) {
      console.error('Error confirming line checkout:', error);
      res.status(500).json({ error: 'Failed to confirm checkout', message: error.message });
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

  /**
   * Configure la fonctionnalité voix pour un numéro de téléphone
   * @route POST /api/phone-numbers/:phoneNumber/configure-voice
   */
  async configureVoiceFeature(req, res) {
    try {
      const { phoneNumber } = req.params;

      // Valider le format du numéro
      if (!phoneNumber || !phoneNumber.match(/^\+[1-9]\d{1,14}$/)) {
        return res.status(400).json({
          error: 'Invalid phone number format',
          message: 'Phone number must be in E.164 format (e.g., +33123456789)'
        });
      }

      console.log(`🎯 Configuring voice feature for number: ${phoneNumber}`);

      // Vérifier si le numéro existe dans notre base
      const existingNumber = await phoneNumberService.getPhoneNumberByNumber(phoneNumber);
      if (!existingNumber) {
        return res.status(404).json({
          error: 'Phone number not found',
          message: 'The specified phone number is not found in our database'
        });
      }

      // Vérifier si le numéro est actif
      if (existingNumber.status !== 'success') {
        return res.status(400).json({
          error: 'Invalid number status',
          message: 'Phone number must be in success status to configure voice feature',
          currentStatus: existingNumber.status
        });
      }

      // Configurer la fonctionnalité voix
      const updatedNumber = await phoneNumberService.configureVoiceFeature(phoneNumber);

      res.json({
        success: true,
        message: 'Voice feature configured successfully',
        data: {
          phoneNumber: updatedNumber.phoneNumber,
          features: updatedNumber.features,
          status: updatedNumber.status
        }
      });

    } catch (error) {
      console.error('❌ Error configuring voice feature:', error);

      // Gérer les erreurs spécifiques
      if (error.message === 'Phone number not found in Telnyx') {
        return res.status(404).json({
          error: 'Telnyx configuration error',
          message: 'Phone number not found in Telnyx system'
        });
      }

      // Erreur de l'API Telnyx
      if (error.response?.data) {
        return res.status(error.response.status || 500).json({
          error: 'Telnyx API error',
          message: error.response.data.errors?.[0]?.detail || 'Failed to configure voice feature',
          telnyxError: error.response.data
        });
      }

      // Erreur générique
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to configure voice feature'
      });
    }
  }

  async handleTelnyxNumberOrderWebhook(req, res) {
    try {
      // 1. Vérifier les headers requis
      const timestamp = req.headers['telnyx-timestamp'];
      const signature = req.headers['telnyx-signature-ed25519'];

      console.log('📝 Headers received:', {
        timestamp: req.headers['telnyx-timestamp'],
        signature: req.headers['telnyx-signature-ed25519'] ? req.headers['telnyx-signature-ed25519'] : undefined,
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

      // Laisser Telnyx gérer la conversion et la normalisation
      console.log('📝 Debug webhook verification:');
      console.log('- Body type:', typeof req.body);
      console.log('- Is Buffer?', Buffer.isBuffer(req.body));

      const event = telnyx.webhooks.constructEvent(
        req.body,  // Passer le body tel quel, Telnyx s'occupe de la conversion
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
  async getTwilioRequirements(req, res) {
    try {
      const { countryCode, type } = req.query;
      const requirements = await phoneNumberService.getTwilioRequirements(countryCode, type);
      res.json(requirements);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch Twilio requirements', details: error.message });
    }
  }

  async createTwilioEndUser(req, res) {
    try {
      const { friendlyName, type, attributes } = req.body;
      const endUser = await phoneNumberService.createTwilioEndUser(friendlyName, type, attributes);
      res.json(endUser);
    } catch (error) {
      res.status(500).json({ error: 'Failed to create End User', details: error.message });
    }
  }

  async createTwilioDocument(req, res) {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'File is required' });
      }

      const { friendlyName, type, attributes } = req.body;
      const parsedAttributes = typeof attributes === 'string' ? JSON.parse(attributes) : attributes;

      const document = await phoneNumberService.createTwilioDocument(
        req.file.buffer,
        req.file.mimetype,
        friendlyName || req.file.originalname,
        type,
        parsedAttributes
      );
      res.json(document);
    } catch (error) {
      console.error('Error in createTwilioDocument:', error);
      res.status(500).json({ error: 'Failed to upload document', details: error.message });
    }
  }

  async createTwilioBundle(req, res) {
    try {
      // Expects friendlyName, email, regulationSid, isoCountry
      const { friendlyName, email, regulationSid, isoCountry } = req.body;
      const bundle = await phoneNumberService.createTwilioBundle(friendlyName, email, undefined, regulationSid, isoCountry);
      res.json(bundle);
    } catch (error) {
      res.status(500).json({ error: 'Failed to create Bundle', details: error.message });
    }
  }

  async assignItemToBundle(req, res) {
    try {
      const { sid } = req.params;
      const { objectSid } = req.body;
      const item = await phoneNumberService.assignItemToBundle(sid, objectSid);
      res.json(item);
    } catch (error) {
      res.status(500).json({ error: 'Failed to assign item', details: error.message });
    }
  }

  async submitTwilioBundle(req, res) {
    try {
      const { sid } = req.params;
      const bundle = await phoneNumberService.submitTwilioBundle(sid);
      res.json(bundle);
    } catch (error) {
      res.status(500).json({ error: 'Failed to submit Bundle', details: error.message });
    }
  }

  async createTwilioAddress(req, res) {
    try {
      const { customerName, street, city, region, postalCode, isoCountry } = req.body;
      const address = await phoneNumberService.createTwilioAddress(
        customerName,
        street,
        city,
        region,
        postalCode,
        isoCountry
      );
      res.json(address);
    } catch (error) {
      console.error('Error in createTwilioAddress:', error);
      res.status(500).json({ error: 'Failed to create Address', details: error.message });
    }
  }
}

export const phoneNumberController = new PhoneNumberController();