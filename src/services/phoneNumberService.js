import { PhoneNumber } from '../models/PhoneNumber.js';
import telnyx from 'telnyx';
import { config } from '../config/env.js';

class PhoneNumberService {
  constructor() {
    if (!config.telnyxApiKey) {
      throw new Error('TELNYX_API_KEY is not defined in environment variables');
    }
    this.telnyxClient = telnyx(config.telnyxApiKey);
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

  async purchaseNumber(phoneNumber, connectionId, messagingProfileId, baseUrl) {
    // Purchase the number through Telnyx
    const purchasedNumber = await this.telnyxClient.numberOrders.create({
    /*   phone_number: phoneNumber,
      connection_id: connectionId,
      messaging_profile_id: messagingProfileId */
      phone_numbers:[{"phone_number": phoneNumber}]
    });

    // Save to database
    const newPhoneNumber = new PhoneNumber({
      phoneNumber: purchasedNumber.phone_number,
      telnyxId: purchasedNumber.id,
      connectionId,
      status: 'active'
    });

    await newPhoneNumber.save();

    // Configure voice settings
    await this.telnyxClient.phoneNumbers.update(purchasedNumber.id, {
      connection_id: connectionId,
      voice: {
        format: 'sip',
        webhook_url: `${baseUrl}/api/webhooks/voice`
      }
    });

    return newPhoneNumber;
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