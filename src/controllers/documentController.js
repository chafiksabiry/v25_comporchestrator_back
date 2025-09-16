import { documentService } from '../services/documentService.js';
import multer from 'multer';

// Configuration de multer pour les uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB max
  },
  fileFilter: (req, file, cb) => {
    // N'accepter que les fichiers PDF
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed.'));
    }
  }
});

export const documentController = {
  // Middleware pour l'upload de fichiers
  uploadMiddleware: upload.single('file'),

  // Upload d'un document
  async uploadDocument(req, res) {
    try {
      if (!req.file) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'No file uploaded'
        });
      }

      // Vérifier la taille du fichier
      if (req.file.size > 5 * 1024 * 1024) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'File size exceeds 5MB limit'
        });
      }

      // Récupérer le nom personnalisé et la référence client du body
      const customFilename = req.body.filename;
      const customerReference = req.body.customer_reference;

      const document = await documentService.uploadDocument(
        req.file,
        customFilename,
        customerReference
      );
      
      res.status(201).json(document);
    } catch (error) {
      console.error('Error in uploadDocument:', error);
      
      if (error.response?.data?.errors) {
        return res.status(error.response.status || 400).json({
          error: 'Telnyx API Error',
          message: error.response.data.errors.map(e => e.detail).join(', ')
        });
      }

      res.status(500).json({
        error: 'Internal Server Error',
        message: error.message
      });
    }
  },

  async deleteDocument(req, res) {
    try {
      const { documentId } = req.params;

      if (!documentId) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Document ID is required'
        });
      }

      const result = await documentService.deleteDocument(documentId);
      res.json(result);
    } catch (error) {
      console.error('Error in deleteDocument:', error);
      
      if (error.response?.status === 404) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Document not found'
        });
      }

      res.status(500).json({
        error: 'Internal Server Error',
        message: error.message
      });
    }
  },

  async getDocument(req, res) {
    try {
      const { documentId } = req.params;

      if (!documentId) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Document ID is required'
        });
      }

      const document = await documentService.getDocument(documentId);
      res.json(document);
    } catch (error) {
      console.error('Error in getDocument:', error);
      
      if (error.response?.status === 404) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Document not found'
        });
      }

      res.status(500).json({
        error: 'Internal Server Error',
        message: error.message
      });
    }
  }
};