import { PhoneNumber } from '../models/PhoneNumber.js';

class PhoneNumberService {
  async searchAvailableNumbers(telnyx, searchParams) {
    const availableNumbers = await telnyx.availablePhoneNumbers.list({
      country_code: searchParams.countryCode || 'US',
      number_type: searchParams.type || 'local',
      features: searchParams.features || ['voice']
    });
    return availableNumbers.data;
  }

  async purchaseNumber(telnyx, phoneNumber, connectionId, messagingProfileId, baseUrl) {
    // Purchase the number through Telnyx
    const purchasedNumber = await telnyx.phoneNumbers.create({
      phone_number: phoneNumber,
      connection_id: connectionId,
      messaging_profile_id: messagingProfileId
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
    await telnyx.phoneNumbers.update(purchasedNumber.id, {
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

  async deletePhoneNumber(telnyx, id) {
    const phoneNumber = await PhoneNumber.findById(id);
    if (!phoneNumber) {
      throw new Error('Phone number not found');
    }

    // Release number from Telnyx
    await telnyx.phoneNumbers.delete(phoneNumber.telnyxId);

    // Remove from database
    await phoneNumber.remove();
    
    return { message: 'Phone number deleted successfully' };
  }
}

export const phoneNumberService = new PhoneNumberService(); 