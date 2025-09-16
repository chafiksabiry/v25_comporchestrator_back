import { requirementService } from '../services/requirementService.js';

export const requirementController = {
  async getCountryRequirements(req, res) {
    try {
      const { countryCode } = req.params;
      
      if (!countryCode) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Country code is required'
        });
      }

      const requirements = await requirementService.getCountryRequirements(countryCode);
      res.json(requirements);
    } catch (error) {
      console.error('Error in getCountryRequirements:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: error.message
      });
    }
  }
};