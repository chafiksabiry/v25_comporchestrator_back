import { config } from '../config/env.js';
import telnyx from 'telnyx';
import { RequirementGroup } from '../models/RequirementGroup.js';

class RequirementService {
  constructor() {
    if (!config.telnyxApiKey) {
      throw new Error('TELNYX_API_KEY is not defined');
    }
    this.telnyxClient = telnyx(config.telnyxApiKey);
  }

  async getCountryRequirements(countryCode) {
    try {
      console.log(`🔍 Fetching requirements for ${countryCode}`);
      const response = await this.telnyxClient.requirements.list({
        filter: {
          country_code: countryCode,
          phone_number_type: 'local',
          action: 'ordering'
        }
      });

      // Vérifier si la réponse contient des requirements
      if (!response.data || !response.data.length) {
        console.log('✅ No requirements found for this country');
        return { hasRequirements: false };
      }

      // Extraire les requirements types
      const requirements = response.data[0].requirement_types.map(req => ({
        id: req.id,
        name: req.name,
        type: req.type,
        description: req.description,
        example: req.example,
        acceptance_criteria: req.acceptance_criteria
      }));

      console.log(`✅ Found ${requirements.length} requirements`);
      return {
        hasRequirements: true,
        requirements
      };
    } catch (error) {
      console.error('❌ Error fetching requirements:', error);
      throw error;
    }
  }

  async getOrCreateGroup(companyId, countryCode) {
    try {
      console.log(`🔍 Checking requirement group for company ${companyId} in ${countryCode}`);
      
      // 1. Chercher un groupe existant et valide
      let group = await RequirementGroup.findOne({
        companyId,
        countryCode,
        status: { $ne: 'rejected' }
      });

      // Si le groupe existe et est valide, le retourner
      if (group && group.isValid() && group.status === 'active') {
        console.log('✅ Found existing active group:', group._id);
        return { group, isNew: false };
      }

      // 2. Si pas de groupe ou groupe invalide/rejeté, créer un nouveau
      if (!group || !group.isValid() || group.status === 'rejected') {
        console.log('📝 Creating new requirement group');
        
        // Récupérer les requirements nécessaires de Telnyx
        const { requirements } = await this.getCountryRequirements(countryCode);

        // Créer le nouveau groupe
        group = new RequirementGroup({
          companyId,
          countryCode,
          requirements: requirements.map(req => ({
            field: req.id,
            type: req.type,
            status: 'pending'
          }))
        });

        await group.save();
        console.log('✅ Created new group:', group._id);
      }

      return { group, isNew: true };
    } catch (error) {
      console.error('❌ Error in getOrCreateGroup:', error);
      throw error;
    }
  }

  async submitDocument(groupId, field, file) {
    try {
      console.log(`📄 Submitting document for group ${groupId}, field ${field}`);
      
      const group = await RequirementGroup.findById(groupId);
      if (!group) {
        throw new Error('Requirement group not found');
      }

      // 1. Upload le document chez Telnyx
      const uploadResponse = await this.telnyxClient.files.create({
        file: file.buffer,
        filename: file.originalname,
        // Ajouter des métadonnées pour le tracking
        metadata: {
          groupId: groupId.toString(),
          field,
          companyId: group.companyId.toString()
        }
      });

      console.log('✅ File uploaded to Telnyx:', uploadResponse.data.id);

      // 2. Si le groupe a déjà un ID Telnyx, mettre à jour
      if (group.telnyxId) {
        await this.telnyxClient.requirementGroups.update(group.telnyxId, {
          requirements: {
            [field]: uploadResponse.data.id
          }
        });
        console.log('✅ Document associated with Telnyx group');
      }

      // 3. Mettre à jour notre base de données
      const requirement = group.requirements.find(r => r.field === field);
      if (requirement) {
        requirement.documentUrl = uploadResponse.data.id;
        requirement.submittedAt = new Date();
        requirement.status = 'pending';
      }

      await group.save();
      console.log('✅ Document saved in database');
      
      return group;
    } catch (error) {
      console.error('❌ Error submitting document:', error);
      throw error;
    }
  }

  async submitTextValue(groupId, field, value) {
    try {
      console.log(`📝 Submitting text value for group ${groupId}, field ${field}`);
      
      const group = await RequirementGroup.findById(groupId);
      if (!group) {
        throw new Error('Requirement group not found');
      }

      // 1. Si le groupe a un ID Telnyx, mettre à jour
      if (group.telnyxId) {
        await this.telnyxClient.requirementGroups.update(group.telnyxId, {
          requirements: {
            [field]: value
          }
        });
        console.log('✅ Value submitted to Telnyx');
      }

      // 2. Mettre à jour notre base de données
      const requirement = group.requirements.find(r => r.field === field);
      if (requirement) {
        requirement.value = value;
        requirement.submittedAt = new Date();
        requirement.status = 'pending';
      }

      await group.save();
      console.log('✅ Value saved in database');
      
      return group;
    } catch (error) {
      console.error('❌ Error submitting text value:', error);
      throw error;
    }
  }

  async checkGroupStatus(groupId) {
    try {
      console.log(`🔍 Checking status for group ${groupId}`);
      
      const group = await RequirementGroup.findById(groupId);
      if (!group) {
        throw new Error('Requirement group not found');
      }

      // Si le groupe a un ID Telnyx, vérifier le statut
      if (group.telnyxId) {
        const telnyxGroup = await this.telnyxClient.requirementGroups.retrieve(group.telnyxId);
        
        // Mettre à jour le statut et la date de validité
        group.status = telnyxGroup.data.status;
        group.validUntil = telnyxGroup.data.valid_until;
        
        // Mettre à jour le statut de chaque requirement
        telnyxGroup.data.requirements.forEach(req => {
          const localReq = group.requirements.find(r => r.field === req.field);
          if (localReq) {
            localReq.status = req.status;
            if (req.status === 'rejected') {
              localReq.rejectionReason = req.rejection_reason;
            }
          }
        });

        await group.save();
        console.log('✅ Group status updated:', group.status);
      }

      return {
        id: group._id,
        status: group.status,
        requirements: group.requirements,
        validUntil: group.validUntil,
        isComplete: group.isComplete()
      };
    } catch (error) {
      console.error('❌ Error checking group status:', error);
      throw error;
    }
  }

  async validateRequirements(groupId) {
    try {
      console.log(`🔍 Validating requirements for group ${groupId}`);
      
      const group = await RequirementGroup.findById(groupId);
      if (!group) {
        throw new Error('Requirement group not found');
      }

      // Vérifier que tous les requirements sont remplis
      const missingRequirements = group.getMissingRequirements();
      if (missingRequirements.length > 0) {
        console.log('⚠️ Missing requirements:', missingRequirements);
        return {
          isValid: false,
          missingRequirements: missingRequirements.map(req => ({
            field: req.field,
            type: req.type
          }))
        };
      }

      // Si le groupe n'a pas d'ID Telnyx, le créer
      if (!group.telnyxId) {
        const telnyxGroup = await this.telnyxClient.requirementGroups.create({
          requirements: group.requirements.reduce((acc, req) => ({
            ...acc,
            [req.field]: req.type === 'document' ? req.documentUrl : req.value
          }), {})
        });

        group.telnyxId = telnyxGroup.data.id;
        await group.save();
        console.log('✅ Created Telnyx requirement group:', telnyxGroup.data.id);
      }

      return {
        isValid: true,
        groupId: group._id,
        telnyxId: group.telnyxId
      };
    } catch (error) {
      console.error('❌ Error validating requirements:', error);
      throw error;
    }
  }
}

export const requirementService = new RequirementService();