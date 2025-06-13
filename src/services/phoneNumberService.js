import { PhoneNumber } from '../models/PhoneNumber.js';
import telnyx from 'telnyx';
import twilio from 'twilio';
import { config } from '../config/env.js';

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

  async searchAvailableNumbers(searchParams) {
    const availableNumbers = await this.telnyxClient.availablePhoneNumbers.list({
      filter: {
        "country_code": searchParams.countryCode,
         "phone_number_type": "local",
          "features": ["voice"],
           "limit": 10
          }
    });
    return availableNumbers.data;
  }

  async purchaseNumber(phoneNumber, provider, connectionId, messagingProfileId, baseUrl, gigId) {
    if (!gigId) {
      throw new Error('gigId is required to purchase a phone number');
    }

    if (provider === 'twilio') {
      // Purchase number through Twilio
      const purchasedNumber = await this.twilioClient.incomingPhoneNumbers
        .create({
          phoneNumber: phoneNumber,
          voiceUrl: `${baseUrl}/api/webhooks/voice`
        });

      // Create document without telnyxId field for Twilio numbers
      const phoneNumberData = {
        phoneNumber: purchasedNumber.phoneNumber,
        twilioId: purchasedNumber.sid,
        provider: 'twilio',
        connectionId,
        status: 'active',
        gigId
      };

      // Save to database
      const newPhoneNumber = new PhoneNumber(phoneNumberData);
      await newPhoneNumber.save();
      return newPhoneNumber;
    } else {
      // Purchase the number through Telnyx
      const purchasedNumber = await this.telnyxClient.numberOrders.create({
        phone_numbers:[{"phone_number": phoneNumber}]
      });
      console.log(purchasedNumber);

      // Create document without twilioId field for Telnyx numbers
      const phoneNumberData = {
        phoneNumber: phoneNumber,
        telnyxId: purchasedNumber.data.id,
        provider: 'telnyx',
        connectionId,
        status: 'active',
        gigId
      };

      // Save to database
      const newPhoneNumber = new PhoneNumber(phoneNumberData);
      await newPhoneNumber.save();

      // Configure voice settings
      await this.telnyxClient.phoneNumbers.update(purchasedNumber.data.id, {
        connection_id: connectionId,
        voice: {
          format: 'sip',
          webhook_url: `${baseUrl}/api/webhooks/voice`
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
      const purchasedNumber = await this.twilioClient.incomingPhoneNumbers
        .create({
          phoneNumber: phoneNumber,
          friendlyName: 'Test Number:' + phoneNumber,
        }); 

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
      console.error('Error in purchaseTwilioNumber:', error);
      throw error;
    }
  }

  async getAllPhoneNumbers() {
    return await PhoneNumber.find();
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