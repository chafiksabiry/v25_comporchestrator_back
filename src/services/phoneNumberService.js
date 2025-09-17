import { PhoneNumber } from '../models/PhoneNumber.js';
import { config } from '../config/env.js';
import telnyx from 'telnyx';

class PhoneNumberService {
  constructor() {
    if (!config.telnyxApiKey) {
      throw new Error('TELNYX_API_KEY is not defined in environment variables');
    }
    this.telnyxClient = telnyx(config.telnyxApiKey);
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
          webhook_url: `${config.baseUrl}/api/webhooks/voice`
        }
      });

      return newPhoneNumber;
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

  async getAllPhoneNumbers() {
    return await PhoneNumber.find();
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
}

export const phoneNumberService = new PhoneNumberService(); 