import { config } from '../config/env.js';
import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';

class DocumentService {
  constructor() {
    if (!config.telnyxApiKey) {
      throw new Error('TELNYX_API_KEY is not defined');
    }
    
    this.axiosInstance = axios.create({
      baseURL: 'https://api.telnyx.com/v2',
      headers: {
        'Authorization': `Bearer ${config.telnyxApiKey}`,
        'Accept': 'application/json'
      }
    });
  }

  async uploadDocument(file, customFilename = null, customerReference = null) {
    try {
      // Utiliser le nom personnalisé si fourni, sinon utiliser le nom original
      const filename = customFilename || file.originalname;

      console.log('📄 Uploading document to Telnyx:', {
        filename,
        originalName: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
        customerReference
      });

      // Créer un FormData pour l'upload multipart
      const form = new FormData();
      
      // Ajouter le fichier comme un Buffer avec le nom personnalisé
      form.append('file', file.buffer, filename);

      // Ajouter la référence client si fournie
      if (customerReference) {
        form.append('customer_reference', customerReference);
      }

      // Faire la requête avec les bons headers
      const response = await this.axiosInstance.post('/documents', form, {
        headers: {
          ...form.getHeaders(),
          'Content-Length': form.getLengthSync()
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });

      console.log('✅ Document uploaded successfully:', response.data.data);

      return {
        id: response.data.data.id,
        filename: response.data.data.filename,
        size: response.data.data.size,
        mimeType: response.data.data.mime_type,
        sha256: response.data.data.sha256,
        status: response.data.data.status,
        content_type: response.data.data.content_type,
        customerReference: response.data.data.customer_reference,
        createdAt: response.data.data.created_at
      };
    } catch (error) {
      console.error('❌ Error uploading document:', error.response?.data || error);
      throw error;
    }
  }

  async deleteDocument(documentId) {
    try {
      console.log(`🗑️ Deleting document: ${documentId}`);
      
      const response = await this.axiosInstance.delete(`/documents/${documentId}`);
      
      return {
        success: true,
        message: 'Document deleted successfully'
      };
    } catch (error) {
      console.error(`❌ Error deleting document ${documentId}:`, error.response?.data || error);
      throw error;
    }
  }

  async getDocument(documentId) {
    try {
      console.log(`📄 Retrieving document metadata: ${documentId}`);
      
      const response = await this.axiosInstance.get(`/documents/${documentId}`);
      
      return {
        id: response.data.data.id,
        filename: response.data.data.filename,
        size: response.data.data.size,
        mimeType: response.data.data.mime_type,
        sha256: response.data.data.sha256,
        status: response.data.data.status,
        content_type: response.data.data.content_type,
        customerReference: response.data.data.customer_reference,
        createdAt: response.data.data.created_at
      };
    } catch (error) {
      console.error(`❌ Error retrieving document metadata ${documentId}:`, error.response?.data || error);
      throw error;
    }
  }

  async downloadDocument(documentId) {
    try {
      console.log(`📥 Downloading document content: ${documentId}`);

      // D'abord, récupérer les métadonnées pour avoir le type de contenu et le nom du fichier
      const metadata = await this.getDocument(documentId);
      
      // Configurer axios pour recevoir une réponse binaire
      const response = await this.axiosInstance.get(`/documents/${documentId}/download`, {
        responseType: 'arraybuffer',
        headers: {
          'Accept': '*/*' // Accepter tous les types de contenu
        }
      });

      return {
        content: response.data, // Le contenu binaire du document
        contentType: metadata.content_type || 'application/octet-stream',
        filename: metadata.filename
      };
    } catch (error) {
      console.error(`❌ Error downloading document ${documentId}:`, error.response?.data || error);
      throw error;
    }
  }
}

export const documentService = new DocumentService();