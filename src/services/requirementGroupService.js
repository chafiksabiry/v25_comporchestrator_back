import { RequirementGroup } from '../models/RequirementGroup.js';
import { config } from '../config/env.js';
import telnyx from 'telnyx';

class RequirementGroupService {
  constructor() {
    if (!config.telnyxApiKey) {
      throw new Error('TELNYX_API_KEY is not defined in environment variables');
    }
    this.telnyxClient = telnyx(config.telnyxApiKey);
  }

  async findOrCreateGroup(companyId, countryCode, businessInfo) {
    try {
      // Chercher un groupe existant et valide
      const existingGroup = await RequirementGroup.findOne({
        companyId,
        countryCode,
        status: 'active',
        validUntil: { $gt: new Date() }
      });

      if (existingGroup) {
        console.log('✅ Found existing valid requirement group:', existingGroup.telnyxGroupId);
        return existingGroup;
      }

      console.log('📝 Creating new requirement group for company:', companyId);

      // Créer un nouveau groupe chez Telnyx
      const telnyxGroup = await this.telnyxClient.requirementGroups.create({
        requirements: {
          business_name: businessInfo.name,
          business_registration: businessInfo.registrationNumber,
          address: {
            street: businessInfo.address.street,
            city: businessInfo.address.city,
            postal_code: businessInfo.address.postalCode,
            country: businessInfo.address.country
          },
          contact: {
            phone: businessInfo.contactPhone,
            email: businessInfo.contactEmail
          }
        }
      });

      // Créer le groupe dans notre base
      const newGroup = new RequirementGroup({
        companyId,
        countryCode,
        telnyxGroupId: telnyxGroup.data.id,
        businessInfo,
        status: 'pending',
        validUntil: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000) // 90 jours
      });

      await newGroup.save();
      console.log('✅ Created new requirement group:', newGroup.telnyxGroupId);

      return newGroup;
    } catch (error) {
      console.error('❌ Error in findOrCreateGroup:', error);
      throw error;
    }
  }

  async uploadDocument(groupId, documentType, fileBuffer, fileName) {
    try {
      const group = await RequirementGroup.findById(groupId);
      if (!group) {
        throw new Error('Requirement group not found');
      }

      // Upload to Telnyx
      const uploadResponse = await this.telnyxClient.files.create({
        file: fileBuffer,
        filename: fileName
      });

      // Associate file with requirement group
      await this.telnyxClient.requirementGroups.update(group.telnyxGroupId, {
        requirements: {
          [documentType]: uploadResponse.data.id
        }
      });

      // Update our database
      group.documents.push({
        type: documentType,
        telnyxFileId: uploadResponse.data.id,
        status: 'pending'
      });

      await group.save();
      return group;
    } catch (error) {
      console.error('❌ Error uploading document:', error);
      throw error;
    }
  }

  async updateGroupStatus(telnyxGroupId, status) {
    try {
      const group = await RequirementGroup.findOne({ telnyxGroupId });
      if (!group) {
        console.log('⚠️ Group not found for Telnyx ID:', telnyxGroupId);
        return null;
      }

      group.status = status;
      if (status === 'active') {
        group.validUntil = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
      }

      await group.save();
      console.log(`✅ Updated group ${telnyxGroupId} status to ${status}`);
      return group;
    } catch (error) {
      console.error('❌ Error updating group status:', error);
      throw error;
    }
  }

  async checkGroupValidity(groupId) {
    try {
      const group = await RequirementGroup.findById(groupId);
      if (!group) {
        return { valid: false, reason: 'Group not found' };
      }

      if (group.status !== 'active') {
        return { valid: false, reason: 'Group not active' };
      }

      if (group.validUntil < new Date()) {
        return { valid: false, reason: 'Group expired' };
      }

      return { valid: true };
    } catch (error) {
      console.error('❌ Error checking group validity:', error);
      throw error;
    }
  }
}

export const requirementGroupService = new RequirementGroupService();
