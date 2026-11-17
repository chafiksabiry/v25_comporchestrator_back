import { documentService } from '../services/documentService.js';
import multer from 'multer';
import { claimAsset as claim, isOwnedAsset } from '../services/regulatoryAssets.js';
import { guardCompanyAccess } from '../middleware/companyGuard.js';

/** La pièce doit appartenir à la société de l'appelant (enregistrée à sa création, ou reprise d'un groupe de la société) : sinon 404, rien n'est lu chez l'opérateur ni modifié. */
async function ownAsset(req, res, kind, externalId) {
  const access = await guardCompanyAccess(req, res, null, { ownCompany: true });
  if (!access) return null;
  if (!(await isOwnedAsset(kind, externalId, access.companyId))) {
    res.status(404).json({ error: 'Not Found', message: 'Not found' });
    return null;
  }
  return access;
}

/** Enregistre la propriété d'une pièce créée chez l'opérateur (première inscription gagnante). */
async function claimAsset(access, kind, externalId) {
  await claim(access, kind, externalId);
}


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
    const access = await guardCompanyAccess(req, res, null, { ownCompany: true });
    if (!access) return;
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
      
      try {
        await claimAsset(access, 'document', document?.id);
      } catch (claimError) {
        // Propriété non enregistrée : la pièce serait inaccessible à sa propre société ; nettoyage chez l'opérateur au mieux, erreur claire.
        console.error('Error registering document ownership:', claimError);
        if (document?.id) await documentService.deleteDocument(document.id).catch((e) => console.error('Cleanup of document failed:', e?.message || e));
        return res.status(500).json({ error: 'Internal Server Error', code: 'ownership_registration_failed', message: 'The document could not be registered for your company; please retry.' });
      }
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

      if (!(await ownAsset(req, res, 'document', documentId))) return;
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

      if (!(await ownAsset(req, res, 'document', documentId))) return;
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
  },

  async downloadDocument(req, res) {
    try {
      const { documentId } = req.params;

      if (!documentId) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Document ID is required'
        });
      }

      if (!(await ownAsset(req, res, 'document', documentId))) return;
      const documentData = await documentService.downloadDocument(documentId);
      
      // Définir les headers pour le téléchargement
      res.setHeader('Content-Type', documentData.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${documentData.filename}"`);
      
      // Envoyer le contenu binaire
      res.send(documentData.content);
    } catch (error) {
      console.error('Error in downloadDocument:', error);
      
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