import { config } from '../config/env.js';
import telnyx from 'telnyx';

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
}

export const requirementService = new RequirementService();