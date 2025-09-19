import { config } from '../config/env.js';
import { TelnyxRequirementGroup } from '../models/TelnyxRequirementGroup.js';
import axios from 'axios';

class TelnyxRequirementGroupService {
  constructor() {
    if (!config.telnyxApiKey) {
      throw new Error('TELNYX_API_KEY is not defined');
    }
    
    this.axiosInstance = axios.create({
      baseURL: 'https://api.telnyx.com/v2',
      headers: {
        'Authorization': `Bearer ${config.telnyxApiKey}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });
  }

  async createTelnyxRequirementGroup(countryCode) {
    try {
      console.log(`📝 Creating Telnyx requirement group for ${countryCode}`);

      const response = await this.axiosInstance.post('/requirement_groups', {
        country_code: countryCode,
        phone_number_type: 'local',
        action: 'ordering'
      });

      console.log('✅ Created Telnyx requirement group:', response.data.data.id);
      return response.data.data;
    } catch (error) {
      console.error('❌ Error creating Telnyx requirement group:', error);
      throw error;
    }
  }

  async createRequirementGroup(companyId, destinationZone) {
    try {
      console.log(`📝 Creating requirement group for company ${companyId} in ${destinationZone}`);

      // 1. Créer le groupe chez Telnyx
      const telnyxGroup = await this.createTelnyxRequirementGroup(destinationZone);

      // 2. Créer le groupe dans notre base de données avec les requirements minimaux
      const group = new TelnyxRequirementGroup({
        telnyxId: telnyxGroup.id,
        companyId,
        destinationZone,
        requirements: telnyxGroup.regulatory_requirements.map(req => ({
          requirementId: req.requirement_id,
          type: req.field_type,
          status: 'pending'
        }))
      });

      await group.save();
      console.log('✅ Saved requirement group in database:', group._id);

      return group;
    } catch (error) {
      console.error('❌ Error creating requirement group:', error);
      throw error;
    }
  }

  async updateRequirements(groupId, requirements) {
    try {
      console.log(`📝 Updating requirements for group ${groupId}`);

      // 1. Trouver le groupe
      const group = await TelnyxRequirementGroup.findById(groupId);
      if (!group) {
        throw new Error('Requirement group not found');
      }

      // 2. Mettre à jour chez Telnyx d'abord
      const updateData = {
        regulatory_requirements: requirements.map(req => ({
          requirement_id: req.requirementId,
          field_value: req.value
        }))
      };

      await this.axiosInstance.patch(`/requirement_groups/${group.telnyxId}`, updateData);

      // 3. Si la mise à jour Telnyx réussit, mettre à jour en local
      for (const req of requirements) {
        const requirement = group.requirements.find(r => r.requirementId === req.requirementId);
        if (requirement) {
          requirement.submittedValueId = req.value;
          requirement.submittedAt = new Date();
          requirement.status = 'completed'; // Marquer comme complété dès qu'une valeur est soumise
        }
      }

      await group.save();
      return group;
    } catch (error) {
      console.error('❌ Error updating requirements:', error);
      throw error;
    }
  }

  async getRequirementGroup(groupId) {
    try {
      console.log(`🔍 Fetching requirement group: ${groupId}`);
      
      const group = await TelnyxRequirementGroup.findById(groupId);
      if (!group) {
        throw new Error('Requirement group not found');
      }

      // Récupérer les détails complets depuis Telnyx
      const telnyxResponse = await this.axiosInstance.get(`/requirement_groups/${group.telnyxId}`);
      
      // Mettre à jour uniquement les statuts
      const telnyxReqs = telnyxResponse.data.data.regulatory_requirements;
      for (const req of group.requirements) {
        const telnyxReq = telnyxReqs.find(tr => tr.requirement_id === req.requirementId);
        if (telnyxReq) {
          req.status = telnyxReq.field_value ? 'completed' : 'pending';
        }
      }

      await group.save();
      return group;
    } catch (error) {
      console.error('❌ Error fetching requirement group:', error);
      throw error;
    }
  }

  async getCompanyRequirementGroup(companyId, destinationZone) {
    try {
      console.log(`🔍 Fetching requirement group for company ${companyId} in ${destinationZone}`);
      
      const group = await TelnyxRequirementGroup.findOne({
        companyId,
        destinationZone,
        status: { $ne: 'rejected' }
      });

      if (!group) {
        return null;
      }

      return this.getRequirementGroup(group._id);
    } catch (error) {
      console.error('❌ Error fetching company requirement group:', error);
      throw error;
    }
  }

  async getCompanyRequirementGroups(companyId) {
    try {
      console.log(`🔍 Fetching all requirement groups for company ${companyId}`);
      
      const groups = await TelnyxRequirementGroup.find({
        companyId,
        status: { $ne: 'rejected' }
      });

      return groups;
    } catch (error) {
      console.error('❌ Error fetching company requirement groups:', error);
      throw error;
    }
  }
}

export const telnyxRequirementGroupService = new TelnyxRequirementGroupService();