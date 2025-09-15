import { config } from '../config/env.js';
import telnyx from 'telnyx';

class TelnyxRequirementService {
  constructor() {
    if (!config.telnyxApiKey) {
      throw new Error('TELNYX_API_KEY is not defined');
    }
    this.telnyxClient = telnyx(config.telnyxApiKey);
  }

  async getCountryRequirements(countryCode, phoneNumberType = 'local') {
    try {
      console.log(`🔍 Checking requirements for ${countryCode}`);
      const response = await this.telnyxClient.requirements.list({
        filter: {
          country_code: countryCode,
          phone_number_type: phoneNumberType,
          action: 'ordering'
        }
      });

      console.log(`✅ Found ${response.data.length} requirements`);
      return response.data;
    } catch (error) {
      console.error('❌ Error fetching requirements:', error);
      throw error;
    }
  }

  async getRequirementDetails(requirementId) {
    try {
      console.log(`🔍 Getting details for requirement: ${requirementId}`);
      const response = await this.telnyxClient.requirementTypes.retrieve(requirementId);
      return response.data;
    } catch (error) {
      console.error('❌ Error fetching requirement details:', error);
      throw error;
    }
  }

  async createRequirementGroup(companyInfo) {
    try {
      console.log('📝 Creating requirement group with info:', companyInfo);
      
      const response = await this.telnyxClient.requirementGroups.create({
        requirements: {
          business_name: companyInfo.businessName,
          business_registration: companyInfo.registrationNumber,
          address: {
            street: companyInfo.address.street,
            city: companyInfo.address.city,
            postal_code: companyInfo.address.postalCode,
            country: companyInfo.address.country
          },
          contact: {
            phone: companyInfo.contactPhone,
            email: companyInfo.contactEmail
          }
        }
      });

      console.log('✅ Requirement group created:', response.data.id);
      return response.data;
    } catch (error) {
      console.error('❌ Error creating requirement group:', error);
      throw error;
    }
  }

  async uploadDocument(requirementGroupId, documentType, fileBuffer, fileName) {
    try {
      console.log(`📄 Uploading document for group ${requirementGroupId}`);
      
      // 1. Upload file to Telnyx
      const fileResponse = await this.telnyxClient.files.create({
        file: fileBuffer,
        filename: fileName
      });

      console.log('✅ File uploaded:', fileResponse.data.id);

      // 2. Associate file with requirement group
      const updateResponse = await this.telnyxClient.requirementGroups.update(
        requirementGroupId,
        {
          requirements: {
            [documentType]: fileResponse.data.id
          }
        }
      );

      console.log('✅ Document associated with group');
      return updateResponse.data;
    } catch (error) {
      console.error('❌ Error uploading document:', error);
      throw error;
    }
  }

  async checkRequirementGroupStatus(groupId) {
    try {
      console.log(`🔍 Checking status of group: ${groupId}`);
      const response = await this.telnyxClient.requirementGroups.retrieve(groupId);
      
      return {
        status: response.data.status,
        requirements: response.data.requirements,
        validUntil: response.data.valid_until
      };
    } catch (error) {
      console.error('❌ Error checking requirement group status:', error);
      throw error;
    }
  }
}

export const telnyxRequirementService = new TelnyxRequirementService();
