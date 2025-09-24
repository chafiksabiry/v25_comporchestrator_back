import { addressService } from '../services/addressService.js';

export const addressController = {
  async createAddress(req, res) {
    try {
      let {
        businessName,
        streetAddress,
        locality,
        postalCode,
        countryCode,
        extendedAddress,
        administrativeArea,
        customerReference
      } = req.body;

      // Normalize and trim inputs
      if (typeof countryCode === 'string') {
        countryCode = countryCode.trim().toUpperCase();
      }

      [businessName, streetAddress, locality, postalCode, extendedAddress, administrativeArea, customerReference] =
        [businessName, streetAddress, locality, postalCode, extendedAddress, administrativeArea, customerReference]
          .map(v => (typeof v === 'string' ? v.trim() : v));

      // Validation des champs requis
      const requiredFields = ['businessName', 'streetAddress', 'locality', 'postalCode', 'countryCode'];
      const fieldValues = { businessName, streetAddress, locality, postalCode, countryCode };
      const missingFields = requiredFields.filter(field => !fieldValues[field]);

      if (missingFields.length > 0) {
        return res.status(400).json({
          error: 'Bad Request',
          message: `Missing required fields: ${missingFields.join(', ')}`
        });
      }

      // Validation du code pays
      if (!countryCode || countryCode.length !== 2) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Country code must be a 2-letter ISO code'
        });
      }

      // Rules spécifiques pour la France
      if (countryCode === 'FR' && !/^[0-9]{5}$/.test(postalCode)) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'For country FR, postalCode must be 5 digits (e.g. "75001")'
        });
      }

      const address = await addressService.createBusinessAddress({
        businessName,
        streetAddress,
        locality,
        postalCode,
        countryCode,
        extendedAddress,
        administrativeArea,
        customerReference
      });

      res.status(201).json(address);
    } catch (error) {
      console.error('Error in createAddress:', error);
      
      // Gestion spécifique des erreurs Telnyx : renvoyer les détails si disponibles
      if (error.response?.data) {
        const telnyxData = error.response.data;
        const msg = Array.isArray(telnyxData.errors)
          ? telnyxData.errors.map(e => e.detail).join(', ')
          : JSON.stringify(telnyxData);

        return res.status(error.response.status || 400).json({
          error: 'Telnyx API Error',
          message: msg
        });
      }

      res.status(500).json({
        error: 'Internal Server Error',
        message: error.message
      });
    }
  },

  async getAddress(req, res) {
    try {
      const { addressId } = req.params;

      if (!addressId) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Address ID is required'
        });
      }

      const address = await addressService.retrieveAddress(addressId);
      res.json(address);
    } catch (error) {
      console.error('Error in getAddress:', error);
      
      if (error.response?.status === 404) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Address not found'
        });
      }

      res.status(500).json({
        error: 'Internal Server Error',
        message: error.message
      });
    }
  }
};
