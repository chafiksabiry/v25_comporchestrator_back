import { PhoneNumber } from '../models/PhoneNumber.js';
import { requirementGroupService } from './requirementGroupService.js';
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

  async initiateNumberPurchase(phoneNumber, gigId, companyId, requirementGroupId = null) {
    try {
      console.log('🛒 Starting number purchase process');

      // Vérifier si un numéro existe déjà pour ce gig
      const existingNumber = await PhoneNumber.findOne({ 
        gigId,
        status: { $in: ['active', 'pending', 'processing', 'requirements_pending'] }
      });

      if (existingNumber) {
        throw new Error('A phone number is already associated with this gig');
      }

      // Créer l'order chez Telnyx
      const orderParams = {
        phone_numbers: [{ phone_number: phoneNumber }]
      };

      // Ajouter le requirement group si fourni
      if (requirementGroupId) {
        const groupValidity = await requirementGroupService.checkGroupValidity(requirementGroupId);
        if (groupValidity.valid) {
          const group = await RequirementGroup.findById(requirementGroupId);
          orderParams.requirement_group_id = group.telnyxGroupId;
        }
      }

      console.log('📞 Creating order with params:', orderParams);
      const order = await this.telnyxClient.numberOrders.create(orderParams);

      // Créer l'entrée dans notre base
      const phoneNumberDoc = new PhoneNumber({
        phoneNumber,
        provider: 'telnyx',
        orderId: order.data.id,
        requirementGroupId,
        gigId,
        companyId,
        status: 'processing',
        orderStatus: 'pending'
      });

      await phoneNumberDoc.save();
      console.log('✅ Number purchase initiated:', phoneNumberDoc._id);

      return phoneNumberDoc;
    } catch (error) {
      console.error('❌ Error initiating number purchase:', error);
      throw error;
    }
  }

  async handleOrderWebhook(event) {
    try {
      const { payload } = event.data;
      const { id: orderId, status, phone_numbers, requirements } = payload;

      console.log(`📱 Processing order webhook: ${orderId} (${status})`);

      const phoneNumber = await PhoneNumber.findOne({ orderId });
      if (!phoneNumber) {
        console.log('⚠️ No matching phone number found for order:', orderId);
        return;
      }

      // Mettre à jour le statut
      phoneNumber.orderStatus = status;

      switch (status) {
        case 'requirements-info-pending':
          phoneNumber.status = 'requirements_pending';
          phoneNumber.metadata.requirements = requirements;
          break;

        case 'completed':
          phoneNumber.status = 'active';
          phoneNumber.telnyxId = phone_numbers[0].id;
          
          // Configurer les webhooks et la connexion voix
          await this.configureNumberSettings(phoneNumber);
          break;

        case 'failed':
          phoneNumber.status = 'error';
          phoneNumber.errorDetails = {
            code: payload.error_code,
            message: payload.error_message,
            timestamp: new Date()
          };
          break;

        case 'expired':
          phoneNumber.status = 'deleted';
          break;
      }

      await phoneNumber.save();
      console.log(`✅ Updated number status: ${phoneNumber.status}`);

      return phoneNumber;
    } catch (error) {
      console.error('❌ Error processing order webhook:', error);
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
          webhook_url: `${config.baseUrl}/api/webhooks/voice`
        }
      });

      phoneNumber.connectionId = config.telnyxConnectionId;
      phoneNumber.webhookUrl = `${config.baseUrl}/api/webhooks/voice`;
      await phoneNumber.save();

      console.log('✅ Number settings configured successfully');
    } catch (error) {
      console.error('❌ Error configuring number settings:', error);
      phoneNumber.errorDetails = {
        code: 'configuration_error',
        message: error.message,
        timestamp: new Date()
      };
      await phoneNumber.save();
      throw error;
    }
  }

  async getNumberStatus(gigId) {
    try {
      const number = await PhoneNumber.findOne({ gigId })
        .populate('requirementGroupId')
        .lean();

      if (!number) {
        return { hasNumber: false };
      }

      return {
        hasNumber: true,
        status: number.status,
        orderStatus: number.orderStatus,
        phoneNumber: number.phoneNumber,
        requirementGroup: number.requirementGroupId,
        needsDocuments: number.status === 'requirements_pending',
        error: number.errorDetails
      };
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