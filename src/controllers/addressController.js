import { addressService } from '../services/addressService.js';
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


export const addressController = {
  async createAddress(req, res) {
    const access = await guardCompanyAccess(req, res, null, { ownCompany: true });
    if (!access) return;
    try {
      const {
        businessName,
        streetAddress,
        locality,
        postalCode,
        countryCode,
        extendedAddress,
        administrativeArea,
        customerReference
      } = req.body;

      // Validation des champs requis
      const requiredFields = ['businessName', 'streetAddress', 'locality', 'postalCode', 'countryCode'];
      const missingFields = requiredFields.filter(field => !req.body[field]);

      if (missingFields.length > 0) {
        return res.status(400).json({
          error: 'Bad Request',
          message: `Missing required fields: ${missingFields.join(', ')}`
        });
      }

      // Validation du code pays
      if (countryCode.length !== 2) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Country code must be a 2-letter ISO code'
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

      await claimAsset(access, 'address', address?.id);
      res.status(201).json(address);
    } catch (error) {
      console.error('Error in createAddress:', error);
      
      // Gestion spécifique des erreurs Telnyx
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

  async getAddress(req, res) {
    try {
      const { addressId } = req.params;

      if (!addressId) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Address ID is required'
        });
      }

      if (!(await ownAsset(req, res, 'address', addressId))) return;
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
