import { PhoneNumber } from '../models/PhoneNumber.js';
import { config } from '../config/env.js';
import telnyx from 'telnyx';
import twilio from 'twilio';


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
      console.log(`🔍 Searching numbers for country: ${countryCode}`);
      const response = await this.telnyxClient.availablePhoneNumbers.list({
        filter: {
          country_code: countryCode,
          features: ['voice'],
          phone_number_type: 'local'
        }
      });

      return response.data;
    } catch (error) {
      console.error('❌ Error searching numbers:', error);
      throw error;
    }
  }

  async purchaseNumber(phoneNumber, provider, gigId, requirementGroupId, companyId) {
    if (!gigId || !requirementGroupId || !companyId) {
      throw new Error('gigId, requirementGroupId, and companyId are required to purchase a number');
    }

    try {
      if (provider === 'telnyx') {
        // 1. Créer la commande avec le requirement group
        const orderData = {
          phone_numbers: [
            {
              phone_number: phoneNumber,
              requirement_group_id: requirementGroupId
            }
          ]
        };

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
      
      // Handle specific Telnyx errors
      if (error.raw) {
        switch (error.raw.code) {
          case 'number_already_registered':
            throw new Error('This number already exists in your account');
          case 'insufficient_funds':
            throw new Error('Insufficient balance to purchase this number');
          case 'number_not_available':
            throw new Error('This number is no longer available');
          default:
            throw new Error(error.raw.message || 'Failed to purchase number');
        }
      }
      
      throw error;
    }
  }

  async searchTwilioNumbers(searchParams) {
    const countryCode = (searchParams.countryCode || 'US').toString().toUpperCase();
    
    // Prepare search options without areaCode by default
    const searchOptions = {
      limit: searchParams.limit,
      excludeAllAddressRequired: true,
      voice: true
    };

    // Only add areaCode if it's provided
    if (searchParams.areaCode) {
      searchOptions.areaCode = searchParams.areaCode;
    }

    const numbers = await this.twilioClient.availablePhoneNumbers(countryCode)
      .local
      .list(searchOptions);
    
    console.log("numbers", numbers);
    
    return numbers.map(number => ({
      phoneNumber: number.phoneNumber,
      friendlyName: number.friendlyName,
      locality: number.locality,
      region: number.region,
      isoCountry: number.isoCountry,
      capabilities: {
        voice: number.capabilities.voice,
        SMS: number.capabilities.SMS,
        MMS: number.capabilities.MMS
      }
    }));
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
      
      // Chercher un numéro actif pour ce gig
      const number = await PhoneNumber.findOne({
        gigId,
      });

      if (!number) {
        return {
          hasNumber: false,
          message: 'No active phone number found for this gig'
        };
      }

      return {
        hasNumber: true,
        number: {
          phoneNumber: number.phoneNumber,
          provider: number.provider,
          status: number.status,
          features: number.features
        }
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
        .lean(); // Pour de meilleures performances

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
      console.log(`📝 Processing number order: ${orderId} (${orderStatus})`);

      // 1. Trouver tous les numéros associés à cette commande
      const existingNumbers = await PhoneNumber.find({ orderId });
      console.log(`📱 Found ${existingNumbers.length} numbers in DB for order ${orderId}`);

      // 2. Créer un Map des numéros existants pour une recherche rapide
      const existingNumbersMap = new Map(
        existingNumbers.map(n => [n.phoneNumber, n])
      );

      // 3. Pour chaque numéro dans la commande
      let updatedCount = 0;
      for (const phoneNumberData of phoneNumbers) {
        const { 
          phone_number,
          id: telnyxId,
          status,
          requirements_met,
          requirements_status,
          country_code
        } = phoneNumberData;

        // Trouver le numéro dans notre base de données
        let phoneNumber = existingNumbersMap.get(phone_number);

        if (!phoneNumber) {
          console.warn(`⚠️ Phone number not found in DB: ${phone_number}`);
          continue;
        }

        // 4. Mettre à jour le statut selon la réponse Telnyx
        phoneNumber.status = status;
        phoneNumber.telnyxId = telnyxId;
        
        // Mettre à jour les métadonnées
        phoneNumber.metadata = {
          ...phoneNumber.metadata,
          countryCode: country_code,
          requirementsMet: requirements_met,
          requirementsStatus: requirements_status,
          lastEventId: eventId,
          lastEventAt: occurredAt,
          orderStatus,
          subOrderIds
        };

        // 5. Sauvegarder les changements
        await phoneNumber.save();
        console.log(`✅ Updated phone number: ${phone_number} -> ${status}`);
        updatedCount++;
      }

      // 6. Vérifier si tous les numéros ont été mis à jour
      const success = updatedCount === existingNumbers.length;
      const finalStatus = success ? 'success' : 
                         updatedCount > 0 ? 'partial-success' : 
                         'failed';

      console.log(`📊 Order status: ${finalStatus} (${updatedCount}/${existingNumbers.length} numbers updated)`);

      return { 
        success: true, 
        updatedCount,
        totalCount: existingNumbers.length,
        finalStatus
      };
    } catch (error) {
      console.error('❌ Error updating number order status:', error);
      throw error;
    }
  }

  async purchaseTwilioNumber(phoneNumber, baseUrl, gigId) {
    if (!gigId) {
      throw new Error('gigId is required to purchase a phone number');
    }

    try {
      // Purchase number through Twilio
  /*     const purchasedNumber = await this.twilioClient.incomingPhoneNumbers
        .create({
          phoneNumber: phoneNumber,
          friendlyName: 'Test Number:' + phoneNumber,
        });  */
        const purchasedNumber = {
          accountSid: 'AC8a453959a6cb01cbbd1c819b00c5782f',
          addressSid: null,
          addressRequirements: 'none',
          apiVersion: '2010-04-01',
          beta: false,
          capabilities: { fax: false, mms: true, sms: true, voice: true },
          dateCreated: '2025-06-12T15:39:07.000Z',
          dateUpdated: '2025-06-12T15:39:07.000Z',
          friendlyName: 'Test Number = +16086557543',
          identitySid: null,
          phoneNumber: '+16086557543',
          origin: 'twilio',
          sid: 'PN8b00ba8d95cf44ace1e04d2ec5eb96b2',
          smsApplicationSid: '',
          smsFallbackMethod: 'POST',
          smsFallbackUrl: '',
          smsMethod: 'POST',
          smsUrl: '',
          statusCallback: '',
          statusCallbackMethod: 'POST',
          trunkSid: null,
          uri: '/2010-04-01/Accounts/AC8a453959a6cb01cbbd1c819b00c5782f/IncomingPhoneNumbers/PN8b00ba8d95cf44ace1e04d2ec5eb96b2.json',
          voiceReceiveMode: 'voice',
          voiceApplicationSid: null,
          voiceCallerIdLookup: false,
          voiceFallbackMethod: 'POST',
          voiceFallbackUrl: null,
          voiceMethod: 'POST',
          voiceUrl: null,
          emergencyStatus: 'Active',
          emergencyAddressSid: null,
          emergencyAddressStatus: 'unregistered',
          bundleSid: null,
          status: 'in-use'
        } 

      console.log("purchasedNumber", purchasedNumber);

      // Create document with only the necessary fields for Twilio
      const phoneNumberData = {
        phoneNumber: purchasedNumber.phoneNumber,
        twilioId: purchasedNumber.sid,
        provider: 'twilio',
        status: 'active',
        features: ['voice', 'sms'],
        gigId
      };

      // Save to database
      const newPhoneNumber = new PhoneNumber(phoneNumberData);
      await newPhoneNumber.save();
      
      console.log("newPhoneNumber", newPhoneNumber);
      return newPhoneNumber;
    } catch (error) {
      console.error('❌ Error getting number status:', error);
      throw error;
    }
  }
}

export const phoneNumberService = new PhoneNumberService(); 