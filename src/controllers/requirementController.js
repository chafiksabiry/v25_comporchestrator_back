import { requirementService } from '../services/requirementService.js';
import multer from 'multer';

// Configuration de multer pour les uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB max
  },
  fileFilter: (req, file, cb) => {
    // Vérifier le type de fichier
    if (file.mimetype === 'application/pdf' ||
        file.mimetype === 'image/jpeg' ||
        file.mimetype === 'image/png') {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF, JPEG and PNG are allowed.'));
    }
  }
});

export const requirementController = {
  // Middleware pour l'upload de fichiers
  uploadMiddleware: upload.single('file'),

  // Obtenir les requirements pour un pays
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
  },

  // Obtenir ou créer un groupe de requirements
  async getOrCreateGroup(req, res) {
    try {
      const { companyId, countryCode } = req.params;
      
      if (!companyId || !countryCode) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Company ID and country code are required'
        });
      }

      const result = await requirementService.getOrCreateGroup(companyId, countryCode);
      res.json(result);
    } catch (error) {
      console.error('Error in getOrCreateGroup:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: error.message
      });
    }
  },

  // Soumettre un document
  async submitDocument(req, res) {
    try {
      const { groupId, field } = req.params;
      
      if (!req.file) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'No file uploaded'
        });
      }

      const group = await requirementService.submitDocument(groupId, field, req.file);
      res.json(group);
    } catch (error) {
      console.error('Error in submitDocument:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: error.message
      });
    }
  },

  // Soumettre une valeur textuelle
  async submitTextValue(req, res) {
    try {
      const { groupId, field } = req.params;
      const { value } = req.body;
      
      if (!value) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Value is required'
        });
      }

      const group = await requirementService.submitTextValue(groupId, field, value);
      res.json(group);
    } catch (error) {
      console.error('Error in submitTextValue:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: error.message
      });
    }
  },

  // Vérifier le statut d'un groupe
  async checkStatus(req, res) {
    try {
      const { groupId } = req.params;
      const status = await requirementService.checkGroupStatus(groupId);
      res.json(status);
    } catch (error) {
      console.error('Error in checkStatus:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: error.message
      });
    }
  },

  // Valider les requirements d'un groupe
  async validateRequirements(req, res) {
    try {
      const { groupId } = req.params;
      const result = await requirementService.validateRequirements(groupId);
      res.json(result);
    } catch (error) {
      console.error('Error in validateRequirements:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: error.message
      });
    }
  }
};