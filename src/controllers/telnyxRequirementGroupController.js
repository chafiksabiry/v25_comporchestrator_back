import { telnyxRequirementGroupService } from '../services/telnyxRequirementGroupService.js';

export const telnyxRequirementGroupController = {
  // Créer un nouveau groupe de requirements
  async createGroup(req, res) {
    try {
      const { companyId, destinationZone } = req.body;

      if (!companyId || !destinationZone) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Company ID and destination zone are required'
        });
      }

      // Valider le format du code pays
      if (!/^[A-Z]{2}$/.test(destinationZone)) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Destination zone must be a 2-letter country code'
        });
      }

      const group = await telnyxRequirementGroupService.createRequirementGroup(
        companyId,
        destinationZone
      );

      res.status(201).json(group);
    } catch (error) {
      console.error('Error in createGroup:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: error.message
      });
    }
  },

  // Récupérer un groupe de requirements
  async getGroup(req, res) {
    try {
      const { groupId } = req.params;

      const group = await telnyxRequirementGroupService.getRequirementGroup(groupId);
      res.json(group);
    } catch (error) {
      console.error('Error in getGroup:', error);
      
      if (error.message.includes('not found')) {
        return res.status(404).json({
          error: 'Not Found',
          message: error.message
        });
      }

      res.status(500).json({
        error: 'Internal Server Error',
        message: error.message
      });
    }
  },

  // Récupérer le groupe de requirements d'une entreprise
  async getCompanyGroup(req, res) {
    try {
      const { companyId, destinationZone } = req.params;

      const group = await telnyxRequirementGroupService.getCompanyRequirementGroup(
        companyId,
        destinationZone
      );

      if (!group) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'No requirement group found for this company and destination'
        });
      }

      res.json(group);
    } catch (error) {
      console.error('Error in getCompanyGroup:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: error.message
      });
    }
  },

  // Mettre à jour une valeur de requirement
  async updateRequirementValue(req, res) {
    try {
      const { groupId, requirementId } = req.params;
      const { value } = req.body;

      if (!value) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Value is required'
        });
      }

      const group = await telnyxRequirementGroupService.updateRequirementValue(
        groupId,
        requirementId,
        value
      );

      res.json(group);
    } catch (error) {
      console.error('Error in updateRequirementValue:', error);
      
      if (error.message.includes('not found')) {
        return res.status(404).json({
          error: 'Not Found',
          message: error.message
        });
      }

      res.status(500).json({
        error: 'Internal Server Error',
        message: error.message
      });
    }
  }
};