import { PhoneNumber } from '../models/PhoneNumber.js';
import { config } from '../config/env.js';
import telnyx from 'telnyx';
import twilio from 'twilio';
import axios from 'axios';
import FormData from 'form-data';


class PhoneNumberService {
  constructor() {
    if (!config.telnyxApiKey) {
      throw new Error('TELNYX_API_KEY is not defined in environment variables');
    }
    this.telnyxClient = telnyx(config.telnyxApiKey);
    if (!config.twilioAccountSid || !config.twilioAuthToken) {
      throw new Error('TWILIO credentials are not defined in environment variables');
    }
    this.twilioClient = twilio(config.twilioAccountSid, config.twilioAuthToken);
  }

  async searchAvailableNumbers(countryCode) {
    try {
      console.log(`🔍 Searching Telnyx numbers for country: ${countryCode}`);
      
      const searchType = async (type) => {
        const response = await this.telnyxClient.availablePhoneNumbers.list({
          filter: {
            country_code: countryCode,
            features: ['voice'],
            phone_number_type: type
          }
        });
        return (response.data || []).map(number => ({
          ...number,
          type: type
        }));
      };

      const localNumbersPromise = searchType('local');

      if (countryCode === 'FR') {
        const nationalNumbersPromise = searchType('national').catch(natError => {
          console.error('❌ Error searching Telnyx national numbers:', natError);
          return [];
        });
        const mobileNumbersPromise = searchType('mobile').catch(mobError => {
          console.error('❌ Error searching Telnyx mobile numbers:', mobError);
          return [];
        });

        const [localResults, nationalResults, mobileResults] = await Promise.all([
          localNumbersPromise,
          nationalNumbersPromise,
          mobileNumbersPromise
        ]);

        const combined = [
          ...localResults.map(n => ({ ...n, type: 'local' })),
          ...nationalResults.map(n => ({ ...n, type: 'national' })),
          ...mobileResults.map(n => ({ ...n, type: 'mobile' }))
        ];
        
        // Use a default limit if not provided
        const searchLimit = limit || 10;
        return combined.slice(0, Math.max(searchLimit * 3, 30));
      }

      return await localNumbersPromise;
    } catch (error) {
      console.error('❌ Error searching Telnyx numbers:', error);
      throw error;
    }
  }

  async purchaseNumber(phoneNumber, provider, gigId, requirementGroupId, companyId, options = {}) {
    if (!gigId || !companyId) {
      throw new Error('gigId and companyId are required to purchase a number');
    }

    try {
      if (provider === 'twilio') {
        return await this.purchaseTwilioNumber(phoneNumber, null, gigId, companyId, options);
      } else if (provider === 'telnyx') {
        // 1. Créer la commande avec le requirement group
        const orderData = {
          phone_numbers: [
            {
              phone_number: phoneNumber
            }
          ]
        };

        if (requirementGroupId) {
          orderData.phone_numbers[0].requirement_group_id = requirementGroupId;
        }

        // 2. Envoyer la commande à Telnyx
        const response = await this.telnyxClient.numberOrders.create(orderData);
        console.log('📝 Telnyx response:', response.data);

        if (!response.data) {
          throw new Error('Invalid response from Telnyx');
        }

        // 3. Sauvegarder en DB avec le statut Telnyx
        const phoneNumberData = {
          phoneNumber: phoneNumber,
          provider: 'telnyx',
          status: response.data.status || 'pending',
          gigId,
          companyId,
          orderId: response.data.id,
          telnyxId: response.data.phone_numbers[0]?.id,
          features: {
            voice: false,
            sms: false,
            mms: false
          }
        };

        const newPhoneNumber = new PhoneNumber(phoneNumberData);
        await newPhoneNumber.save();

        // 4. Retourner la réponse Telnyx
        return response.data;
      } else {
        throw new Error(`Unsupported provider: ${provider}`);
      }
    } catch (error) {
      console.error('❌ Error purchasing number:', error);

      if (error.raw) {
        const errorCode = error.raw.code || (error.raw.errors && error.raw.errors[0]?.code);
        const errorMessage = error.raw.message || (error.raw.errors && error.raw.errors[0]?.detail) || 'Failed to purchase number';

        switch (errorCode) {
          case 'number_already_registered':
            throw new Error('This number already exists in your account');
          case 'insufficient_funds':
            throw new Error('Insufficient balance to purchase this number');
          case 'number_not_available':
            throw new Error('This number is no longer available');
          default:
            throw new Error(errorMessage);
        }
      }

      throw error;
    }
  }

  async searchTwilioNumbers(searchParams) {
    const countryCode = (searchParams.countryCode || 'US').toString().toUpperCase();
    const limit = searchParams.limit || 10;
    const areaCode = searchParams.areaCode;
    const numberType = 'local';

    // Countries like FR require an approved Twilio Regulatory Bundle before
    // any number can be purchased. Skip the Twilio inventory search when we
    // cannot actually provision — avoids showing numbers the user can pay for
    // but never activate (Twilio error 21649).
    const bundleRequired = await this.isRegulatoryBundleRequired(countryCode, numberType);
    if (bundleRequired) {
      const bundleSid = this.getBundleSidForCountry(countryCode);
      const approved = await this.isBundleApproved(bundleSid);
      if (!approved) {
        console.log(
          `⛔ Twilio search skipped for ${countryCode}: regulatory bundle required but not approved (bundle=${bundleSid || 'missing'})`
        );
        const err = new Error(
          `Les numéros ${countryCode} nécessitent un Regulatory Bundle Twilio approuvé. Soumettez vos documents dans la console Twilio ou choisissez un pays sans régulation.`
        );
        err.code = 'REGULATORY_BUNDLE_REQUIRED';
        err.countryCode = countryCode;
        throw err;
      }
    }

    const searchOptions = {
      limit: limit,
      voice: true
    };

    if (areaCode) {
      searchOptions.areaCode = areaCode;
    }

    try {
      console.log(`📡 Searching Twilio numbers for ${countryCode}...`);
      
      // Standard local search for all countries (US, FR, etc.)
      const numbers = await Promise.race([
        this.twilioClient.availablePhoneNumbers(countryCode).local.list(searchOptions),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Twilio search timeout')), 25000)
        )
      ]);

      console.log(`✅ Found ${numbers.length} numbers for ${countryCode}`);

      return numbers.map(number => ({
        phoneNumber: number.phoneNumber,
        friendlyName: number.friendlyName,
        locality: number.locality,
        region: number.region,
        isoCountry: number.isoCountry,
        type: 'local',
        capabilities: {
          voice: number.capabilities.voice,
          SMS: number.capabilities.SMS,
          MMS: number.capabilities.MMS
        }
      }));
    } catch (error) {
      console.error('❌ Error in searchTwilioNumbers:', error);
      if (error.code === 'REGULATORY_BUNDLE_REQUIRED') {
        throw error;
      }
      if (error.status === 403 || error.message?.includes('403') || error.message?.includes('Forbidden')) {
        const friendlyError = new Error(`Twilio Forbidden (403): Activez les Geo Permissions pour "${countryCode}" dans Twilio Console (Voice > Settings > Geo Permissions). La recherche de numéros en France (FR) requiert également un Regulatory Bundle approuvé.`);
        friendlyError.status = 403;
        throw friendlyError;
      }
      throw error;
    }
  }

  /** ISO country → configured Regulatory Bundle SID (if any). */
  getBundleSidForCountry(isoCountry) {
    const cc = String(isoCountry || '').toUpperCase();
    if (cc === 'FR') return config.twilioFrenchBundleSid || null;
    return null;
  }

  /**
   * Best-effort ISO country code guess from an E.164 phone number. Used as
   * a pre-payment gate to detect numbers that need a Twilio Regulatory
   * Bundle before the customer is charged. This is a small static prefix
   * map covering the countries we support — extend as needed. Returns null
   * if the prefix is unknown so the caller can fall through (we do not want
   * to block payments for countries we haven't mapped yet).
   */
  guessCountryFromE164(phoneNumber) {
    const raw = String(phoneNumber || '').replace(/[^\d+]/g, '');
    if (!raw.startsWith('+')) return null;
    // Order matters: longer prefixes must be tested first.
    const prefixes = [
      ['+1', 'US'],
      ['+33', 'FR'],
      ['+44', 'GB'],
      ['+49', 'DE'],
      ['+34', 'ES'],
      ['+39', 'IT'],
      ['+31', 'NL'],
      ['+32', 'BE'],
      ['+41', 'CH'],
      ['+352', 'LU'],
      ['+212', 'MA']
    ].sort((a, b) => b[0].length - a[0].length);
    for (const [prefix, iso] of prefixes) {
      if (raw.startsWith(prefix)) return iso;
    }
    return null;
  }

  /**
   * True when Twilio mandates regulatory compliance docs for this country/type.
   */
  async isRegulatoryBundleRequired(isoCountry, numberType = 'local') {
    try {
      const regulations = await this.twilioClient.numbers.v2.regulatoryCompliance
        .regulations
        .list({
          isoCountry: String(isoCountry || '').toUpperCase(),
          numberType,
          limit: 1
        });
      return Array.isArray(regulations) && regulations.length > 0;
    } catch (error) {
      console.warn(`[telephony] could not fetch regulations for ${isoCountry}:`, error.message);
      // Fail open for unknown errors so non-regulated countries still work.
      return false;
    }
  }

  /** True only when the bundle exists on Twilio and status is twilio-approved. */
  async isBundleApproved(bundleSid) {
    if (!bundleSid) return false;
    try {
      const bundle = await this.twilioClient.numbers.v2.regulatoryCompliance
        .bundles(bundleSid)
        .fetch();
      return bundle?.status === 'twilio-approved';
    } catch (error) {
      console.warn(`[telephony] bundle ${bundleSid} not approved or not found:`, error.message);
      return false;
    }
  }

  async configureVoiceFeature(phoneNumber) {
    try {
      console.log(`🔧 Configuring voice feature for number: ${phoneNumber}`);

      // 1. Vérifier si la voix est déjà configurée
      const existingNumber = await PhoneNumber.findOne({ phoneNumber });
      if (existingNumber?.features?.voice) {
        console.log('✅ Voice already configured');
        return existingNumber;
      }

      // 2. Obtenir l'ID Telnyx du numéro
      const response = await this.telnyxClient.phoneNumbers.list({
        filter: { phone_number: phoneNumber }
      });
      console.log("Retreiving phone number details from telnyx", response);
      if (!response.data?.[0]) {
        throw new Error('Phone number not found in Telnyx');
      }

      const telnyxNumberId = response.data[0].id;

      console.log("telnyxNumberId retrieved from telnyx", telnyxNumberId);
      // 3. Configurer la voix
      console.log("Configuring voice settings with connection_id:", config.telnyxConnectionId);
      const updateNumberVoiceSettingsResponse = await this.telnyxClient.phoneNumbers.update(telnyxNumberId, {
        connection_id: config.TELNYX_APPLICATION_ID
      });
      console.log("Voice settings update response:", updateNumberVoiceSettingsResponse);

      // 4. Mettre à jour notre base de données
      const updatedNumber = await PhoneNumber.findOneAndUpdate(
        { phoneNumber },
        {
          'features.voice': true,
          telnyxId: telnyxNumberId  // Sauvegarder l'ID pour usage futur
        },
        { new: true }
      );

      console.log('✅ Voice feature configured successfully');
      return updatedNumber;
    } catch (error) {
      console.error('❌ Failed to configure voice feature:', error);
      throw error;
    }
  }

  async configureNumberSettings(phoneNumber) {
    try {
      console.log('⚙️ Configuring number settings:', phoneNumber.telnyxId);

      await this.telnyxClient.phoneNumbers.update(phoneNumber.telnyxId, {
        connection_id: config.telnyxConnectionId,
        voice: {
          format: 'sip',
          webhook_url: `${config.baseUrl}/api/webhooks/voice`,
          outbound: {
            outbound_voice_profile_id: config.telnyxOutboundProfileId
          }
        }
      });

      return phoneNumber;
    }
    catch (error) {
      console.error('❌ Error configuring number settings:', error);
      throw error;
    }
  }

  async checkGigNumber(gigId) {
    try {
      console.log(`🔍 Checking number for gig: ${gigId}`);

      // Chercher tous les numéros actifs pour ce gig
      const numbers = await PhoneNumber.find({
        gigId,
      });

      if (!numbers || numbers.length === 0) {
        return {
          hasNumber: false,
          numbers: [],
          message: 'No active phone numbers found for this gig'
        };
      }

      return {
        hasNumber: true,
        numbers: numbers.map(number => ({
          phoneNumber: number.phoneNumber,
          provider: number.provider,
          status: number.status,
          features: number.features
        }))
      };
    } catch (error) {
      console.error('❌ Error checking gig number:', error);
      throw error;
    }
  }

  async getAllPhoneNumbers() {
    try {
      console.log('📞 Fetching all phone numbers');

      // Récupérer tous les numéros de téléphone de la base de données
      const numbers = await PhoneNumber.find({})
        .sort({ createdAt: -1 }) // Les plus récents d'abord
        .lean();

      return numbers.map(number => ({
        id: number._id,
        phoneNumber: number.phoneNumber,
        provider: number.provider,
        status: number.status,
        orderStatus: number.orderStatus,
        features: number.features,
        gigId: number.gigId,
        companyId: number.companyId,
        createdAt: number.createdAt,
        updatedAt: number.updatedAt
      }));
    } catch (error) {
      console.error('❌ Error fetching all phone numbers:', error);
      throw error;
    }
  }

  async updateNumberOrderStatus({ eventId, occurredAt, orderId, orderStatus, phoneNumbers, requirementsMet, subOrderIds }) {
    try {
      console.log(`📝 Processing number order update for ${phoneNumbers.length} numbers`);

      let updatedCount = 0;

      // Pour chaque numéro dans la commande
      for (const phoneNumberData of phoneNumbers) {
        const {
          id: telnyxId,
          status
        } = phoneNumberData;

        // Trouver le numéro dans notre base de données par telnyxId
        const phoneNumber = await PhoneNumber.findOne({ telnyxId });

        if (!phoneNumber) {
          console.warn(`⚠️ Phone number not found in DB for telnyxId: ${telnyxId}`);
          continue;
        }

        // Mettre à jour le statut avec celui envoyé par Telnyx
        phoneNumber.status = status;

        // Sauvegarder les changements
        await phoneNumber.save();
        console.log(`✅ Updated phone number ${phoneNumber.phoneNumber} status to: ${status}`);
        updatedCount++;
      }

      return {
        success: true,
        updatedCount
      };
    } catch (error) {
      console.error('❌ Error updating number order status:', error);
      throw error;
    }
  }

  async purchaseTwilioNumber(phoneNumber, baseUrl, gigId, companyId, { bundleSid, addressSid, type, price, currency, paymentRef, isTrial, trialExpiresAt } = {}) {
    if (!gigId || !companyId) {
      throw new Error('gigId and companyId are required to purchase a phone number');
    }

    console.log(`🛒 Attempting to purchase number: ${phoneNumber} for gig: ${gigId}`);

    let purchasedNumber;
    try {
      const purchaseOptions = {
        phoneNumber: phoneNumber,
        friendlyName: 'Gig Number:' + phoneNumber,
      };

      const currentBundleSid = bundleSid || (phoneNumber.startsWith('+33') ? config.twilioFrenchBundleSid : null);
      const currentAddressSid = addressSid || (phoneNumber.startsWith('+33') ? config.twilioFrenchAddressSid : null);

      if (currentBundleSid) purchaseOptions.bundleSid = currentBundleSid;
      if (currentAddressSid) purchaseOptions.addressSid = currentAddressSid;

      purchasedNumber = await this.twilioClient.incomingPhoneNumbers
        .create(purchaseOptions);
      console.log('✅ Twilio purchase successful:', JSON.stringify(purchasedNumber, null, 2));
    } catch (twilioError) {
      console.error('❌ detailed Twilio API Error:', JSON.stringify(twilioError, Object.getOwnPropertyNames(twilioError), 2));
      const error = new Error(`Twilio Purchase Failed: ${twilioError.message}`);
      error.code = twilioError.code;
      error.status = twilioError.status;
      error.moreInfo = twilioError.moreInfo;
      throw error;
    }

    // Create document with only the necessary fields for Twilio
    const phoneNumberData = {
      phoneNumber: purchasedNumber.phoneNumber,
      twilioId: purchasedNumber.sid,
      provider: 'twilio',
      status: 'active',
      features: {
        voice: true,
        sms: true,
        mms: true
      },
      gigId,
      companyId,
      // Price actually paid via Stripe / PayPal (NOT debited from the wallet).
      price: typeof price === 'number' ? price : 0,
      currency: typeof currency === 'string' && currency ? currency.toUpperCase() : 'EUR',
      ...(paymentRef ? { paymentRef } : {}),
      isTrial: Boolean(isTrial),
      ...(trialExpiresAt ? { trialExpiresAt } : {}),
      metadata: {
        type: type, // Save the original type (local, national, mobile)
        ...(isTrial ? { trial: { granted: true, expiresAt: trialExpiresAt } } : {})
      }
    };

    // Save to database
    const newPhoneNumber = new PhoneNumber(phoneNumberData);
    await newPhoneNumber.save();

    console.log("newPhoneNumber", newPhoneNumber);
    return newPhoneNumber;

  }

  async getAllPhoneNumbers() {
    return await PhoneNumber.find();
  }

  async getPhoneNumberByNumber(phoneNumber) {
    return await PhoneNumber.findOne({ phoneNumber });
  }

  async getPhoneNumbersByGigId(gigId) {
    return await PhoneNumber.find({ gigId });
  }

  async deletePhoneNumber(id) {
    const phoneNumber = await PhoneNumber.findById(id);
    if (!phoneNumber) {
      throw new Error('Phone number not found');
    }

    // Release number from Telnyx
    await this.telnyxClient.phoneNumbers.delete(phoneNumber.telnyxId);

    // Remove from database
    await phoneNumber.remove();

    return { message: 'Phone number deleted successfully' };
  }
  // Twilio Regulatory Compliance Methods

  async getTwilioRequirements(isoCountry, numberType = 'local') {
    try {
      console.log(`🔍 Fetching Twilio requirements for ${isoCountry} ${numberType}`);
      const regulations = await this.twilioClient.numbers.v2.regulatoryCompliance
        .regulations
        .list({
          isoCountry: isoCountry,
          numberType: numberType,
          limit: 1
        });

      if (!regulations || regulations.length === 0) {
        return { requirements: [] };
      }

      const regulation = regulations[0];

      // Get detailed requirements including end-user and document types
      // Note: In a real implementation, we would need to fetch end-user-types and document-types linked to this regulation
      // For now, we return the regulation details and let the frontend drive the form based on known Twilio patterns
      // or we can fetch them here.

      return {
        regulationSid: regulation.sid,
        friendlyName: regulation.friendlyName,
        endUserType: regulation.endUserType,
        requirements: regulation.requirements
      };
    } catch (error) {
      console.error('❌ Error fetching Twilio requirements:', error);
      throw error;
    }
  }

  async createTwilioEndUser(friendlyName, type, attributes) {
    try {
      console.log(`👤 Creating Twilio End User: ${friendlyName} (${type})`);
      const endUser = await this.twilioClient.numbers.v2.regulatoryCompliance
        .endUsers
        .create({
          friendlyName: friendlyName,
          type: type,
          attributes: JSON.stringify(attributes)
        });

      return endUser;
    } catch (error) {
      console.error('❌ Error creating Twilio End User:', error);
    }
  }

  async createTwilioDocument(fileBuffer, mimeType, fileName, type, attributes) {
    try {
      console.log(`📄 Uploading Twilio Document via Axios: ${fileName} `);

      const form = new FormData();
      form.append('FriendlyName', fileName);
      form.append('Type', type);
      form.append('Attributes', JSON.stringify(attributes));
      form.append('File', fileBuffer, { filename: fileName, contentType: mimeType });

      const auth = Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken} `).toString('base64');

      const response = await axios.post(
        'https://numbers.twilio.com/v2/RegulatoryCompliance/SupportingDocuments',
        form,
        {
          headers: {
            ...form.getHeaders(),
            'Authorization': `Basic ${auth} `
          }
        }
      );

      console.log('✅ Twilio Document Uploaded:', response.data.sid);
      return response.data;
    } catch (error) {
      console.error('❌ Error creating Twilio Document:', error.response?.data || error.message);
      throw error;
    }
  }

  async createTwilioBundle(friendlyName, email, statusCallback) {
    try {
      console.log(`📦 Creating Twilio Bundle: ${friendlyName} `);
      const bundle = await this.twilioClient.numbers.v2.regulatoryCompliance
        .bundles
        .create({
          friendlyName: friendlyName,
          email: email,
          statusCallback: statusCallback,
          regulationSid: arguments[3], // Hack if we pass more args
          isoCountry: arguments[4]
        });
      return bundle;
    } catch (error) {
      console.error('❌ Error creating Twilio Bundle:', error);
      throw error;
    }
  }

  async assignItemToBundle(bundleSid, objectSid) {
    try {
      const item = await this.twilioClient.numbers.v2.regulatoryCompliance
        .bundles(bundleSid)
        .itemAssignments
        .create({ objectSid: objectSid });
      return item;
    } catch (error) {
      console.error('❌ Error assigning item to bundle:', error);
      throw error;
    }
  }

  async submitTwilioBundle(bundleSid) {
    try {
      console.log(`🚀 Submitting Twilio Bundle: ${bundleSid}`);
      const bundle = await this.twilioClient.numbers.v2.regulatoryCompliance
        .bundles(bundleSid)
        .update({ status: 'pending-review' });
      return bundle;
    } catch (error) {
      console.error('❌ Error submitting Twilio Bundle:', error);
      throw error;
    }
  }

  async createTwilioAddress(customerName, street, city, region, postalCode, isoCountry) {
    try {
      console.log(`📍 Creating Twilio Address for ${customerName} in ${isoCountry}`);
      const address = await this.twilioClient.addresses.create({
        customerName,
        street,
        city,
        region,
        postalCode,
        isoCountry
      });
      console.log('✅ Twilio Address Created:', address.sid);
      return address;
    } catch (error) {
      console.error('❌ Error creating Twilio Address:', error);
      throw error;
    }
  }
}

export const phoneNumberService = new PhoneNumberService(); 