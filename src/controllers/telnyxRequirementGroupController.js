import { telnyxRequirementGroupService } from '../services/telnyxRequirementGroupService.js';
import { addressService } from '../services/addressService.js';
import { documentService } from '../services/documentService.js';
import { config } from '../config/env.js';
import mongoose from 'mongoose';
import { TelnyxRequirementGroup } from '../models/TelnyxRequirementGroup.js';
import { assetIdOf, isOwnedAsset } from '../services/regulatoryAssets.js';
import { guardCompanyAccess } from '../middleware/companyGuard.js';

/**
 * Contrôle d'accès à un groupe désigné par son identifiant (`_id` Mongo : le service lit `findById`) : l'appelant doit être rattaché à une société, et le groupe doit
 * être celui de CETTE société (sinon 404). Renvoie { access, group } (group : exigences avec leur type) ou null si la réponse d'erreur est déjà envoyée.
 */
async function ownGroup(req, res, groupId) {
  const access = await guardCompanyAccess(req, res, null, { ownCompany: true });
  if (!access) return null;
  const row = mongoose.Types.ObjectId.isValid(String(groupId))
    ? await TelnyxRequirementGroup.findOne({ _id: String(groupId), companyId: String(access.companyId) }).select('requirements').lean()
    : null;
  if (!row) {
    res.status(404).json({ error: 'Not Found', message: 'Requirement group not found' });
    return null;
  }
  return { access, group: row };
}

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

      // L'appelant doit appartenir à CETTE société (propriétaire ou membre) ; refus 403 avant toute écriture.
      if (!(await guardCompanyAccess(req, res, companyId))) return;

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
      if (!(await ownGroup(req, res, groupId))) return;

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
      if (!(await guardCompanyAccess(req, res, companyId))) return;

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

  // Mettre à jour plusieurs requirements
  async updateRequirements(req, res) {
    try {
      const { groupId } = req.params;
      const { requirements } = req.body;
      const own = await ownGroup(req, res, groupId);
      if (!own) return;

      if (!Array.isArray(requirements) || requirements.length === 0) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Requirements array is required and must not be empty'
        });
      }

      // Valider le format de chaque requirement
      const invalidRequirements = requirements.filter(
        req => !req.requirementId || !req.value
      );

      if (invalidRequirements.length > 0) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Each requirement must have requirementId and value'
        });
      }

      // Les pièces (documents, adresses) référencées doivent appartenir à CETTE société : on n'attache pas la pièce d'autrui à son groupe (refus avant tout appel Telnyx).
      for (const r of requirements) {
        const declared = (own.group.requirements || []).find((x) => x.requirementId === r.requirementId);
        if (declared && (declared.type === 'document' || declared.type === 'address')) {
          const assetId = assetIdOf(r.value);
          if (!assetId || !(await isOwnedAsset(declared.type, assetId, own.access.companyId))) {
            return res.status(403).json({ error: 'Forbidden', code: 'asset_not_owned', message: `Requirement ${r.requirementId}: the ${declared.type} does not belong to your company` });
          }
        }
      }

      const group = await telnyxRequirementGroupService.updateRequirements(
        groupId,
        requirements
      );

      res.json(group);
    } catch (error) {
      console.error('Error in updateRequirements:', error);
      
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

  // Vérifier le statut des requirements d'une entreprise
  async checkCompanyRequirementsStatus(req, res) {
    try {
      const { companyId } = req.params;
      if (!(await guardCompanyAccess(req, res, companyId))) return;

      const groups = await telnyxRequirementGroupService.getCompanyRequirementGroups(companyId);
      
      // Récupérer les détails pour chaque groupe
      const status = await Promise.all(groups.map(async group => {
        const completedRequirements = await Promise.all(
          group.requirements
            .filter(req => req.status === 'completed')
            .map(async req => {
              const details = {
                id: req.requirementId,
                type: req.type,
                status: req.status,
                submittedAt: req.submittedAt
              };

              if (req.type === 'address' && req.submittedValueId) {
                try {
                  const addressDetails = await addressService.retrieveAddress(req.submittedValueId);
                  details.value = addressDetails;
                } catch (error) {
                  console.error(`Failed to fetch address details for ${req.submittedValueId}:`, error);
                  details.value = { id: req.submittedValueId, error: 'Failed to fetch address details' };
                }
              } else if (req.type === 'document' && req.submittedValueId) {
                try {
                  const documentDetails = await documentService.getDocument(req.submittedValueId);
                  details.value = {
                    ...documentDetails,
                    downloadUrl: `${config.baseUrl}/api/documents/${req.submittedValueId}/download`
                  };
                } catch (error) {
                  console.error(`Failed to fetch document details for ${req.submittedValueId}:`, error);
                  details.value = { id: req.submittedValueId, error: 'Failed to fetch document details' };
                }
              } else {
                details.value = req.submittedValueId; // Pour les requirements textuels
              }

              return details;
            })
        );

        return {
          destinationZone: group.destinationZone,
          isComplete: group.isComplete(),
          totalRequirements: group.requirements.length,
          completedRequirements: completedRequirements,
          pendingRequirements: group.requirements.filter(req => req.status === 'pending').length
        };
      }));

      res.json({
        companyId,
        requirementGroups: status
      });
    } catch (error) {
      console.error('Error in checkCompanyRequirementsStatus:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: error.message
      });
    }
  },

  // Vérifier le statut d'un groupe de requirements spécifique
  async checkGroupStatus(req, res) {
    try {
      const { groupId } = req.params;
      if (!(await ownGroup(req, res, groupId))) return;

      const group = await telnyxRequirementGroupService.getRequirementGroup(groupId);
      
      // Récupérer les détails des requirements complétés
      const completedRequirements = await Promise.all(
        group.requirements
          .filter(req => req.status === 'completed')
          .map(async req => {
            const details = {
              id: req.requirementId,
              type: req.type,
              status: req.status,
              submittedAt: req.submittedAt
            };

            if (req.type === 'address' && req.submittedValueId) {
              try {
                const addressDetails = await addressService.retrieveAddress(req.submittedValueId);
                details.value = addressDetails;
              } catch (error) {
                console.error(`Failed to fetch address details for ${req.submittedValueId}:`, error);
                details.value = { id: req.submittedValueId, error: 'Failed to fetch address details' };
              }
            } else if (req.type === 'document' && req.submittedValueId) {
              try {
                const documentDetails = await documentService.getDocument(req.submittedValueId);
                details.value = {
                  ...documentDetails,
                  downloadUrl: `${config.baseUrl}/api/documents/${req.submittedValueId}/download`
                };
              } catch (error) {
                console.error(`Failed to fetch document details for ${req.submittedValueId}:`, error);
                details.value = { id: req.submittedValueId, error: 'Failed to fetch document details' };
              }
            } else {
              details.value = req.submittedValueId; // Pour les requirements textuels
            }

            return details;
          })
      );

      const status = {
        groupId: group._id,
        destinationZone: group.destinationZone,
        isComplete: group.isComplete(),
        totalRequirements: group.requirements.length,
        completedRequirements,
        pendingRequirements: group.requirements.filter(req => req.status === 'pending').length
      };

      res.json(status);
    } catch (error) {
      console.error('Error in checkGroupStatus:', error);
      
      if (error.message.includes('not found')) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Requirement group not found'
        });
      }

      res.status(500).json({
        error: 'Internal Server Error',
        message: error.message
      });
    }
  }
};