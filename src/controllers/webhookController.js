import { config } from '../config/env.js';
import telnyx from 'telnyx';
import { RequirementGroup } from '../models/RequirementGroup.js';
import { PhoneNumber } from '../models/PhoneNumber.js';

export const webhookController = {
  async handleTelnyxWebhook(req, res) {
    try {
      // 1. Vérifier la signature du webhook
      const event = telnyx.webhooks.constructEvent(
        JSON.stringify(req.body),
        req.header('telnyx-signature-ed25519'),
        req.header('telnyx-timestamp'),
        config.telnyxWebhookSecret
      );

      console.log('📨 Received Telnyx webhook:', event.type);

      // 2. Traiter l'événement selon son type
      switch (event.type) {
        case 'requirement_group.updated': {
          await handleRequirementGroupUpdate(event.data);
          break;
        }
        case 'requirement_group.document.updated': {
          await handleDocumentUpdate(event.data);
          break;
        }
        case 'number_order.complete': {
          await handleNumberOrderUpdate(event.data);
          break;
        }
        default: {
          console.log('⚠️ Unhandled webhook event type:', event.type);
        }
      }

      res.json({ received: true });
    } catch (error) {
      console.error('❌ Error processing webhook:', error);
      return res.status(400).json({
        error: 'Webhook Error',
        message: error.message
      });
    }
  }
};

// Gestion des mises à jour de requirement group
async function handleRequirementGroupUpdate(data) {
  try {
    console.log('📝 Processing requirement group update:', data.id);

    // 1. Trouver le groupe dans notre base de données
    const group = await RequirementGroup.findOne({ telnyxId: data.id });
    if (!group) {
      console.log('⚠️ Requirement group not found:', data.id);
      return;
    }

    // 2. Mettre à jour le statut global
    group.status = data.status;
    if (data.valid_until) {
      group.validUntil = new Date(data.valid_until);
    }

    // 3. Mettre à jour le statut de chaque requirement
    if (data.requirements) {
      Object.entries(data.requirements).forEach(([field, status]) => {
        const requirement = group.requirements.find(r => r.field === field);
        if (requirement) {
          requirement.status = status;
          if (status === 'rejected' && data.rejection_reasons?.[field]) {
            requirement.rejectionReason = data.rejection_reasons[field];
          }
        }
      });
    }

    await group.save();
    console.log('✅ Requirement group updated:', group._id);

    // 4. Si le groupe est approuvé, mettre à jour les numéros associés
    if (group.status === 'active') {
      await PhoneNumber.updateMany(
        { requirementGroupId: group._id },
        { 
          $set: { 
            requirementStatus: 'approved',
            updatedAt: new Date()
          }
        }
      );
      console.log('✅ Associated phone numbers updated');
    }

  } catch (error) {
    console.error('❌ Error handling requirement group update:', error);
    throw error;
  }
}

// Gestion des mises à jour de documents
async function handleDocumentUpdate(data) {
  try {
    console.log('📄 Processing document update:', data.id);

    // 1. Trouver le requirement group associé
    const group = await RequirementGroup.findOne({
      'requirements.documentUrl': data.id
    });

    if (!group) {
      console.log('⚠️ No requirement group found for document:', data.id);
      return;
    }

    // 2. Mettre à jour le statut du document
    const requirement = group.requirements.find(r => r.documentUrl === data.id);
    if (requirement) {
      requirement.status = data.status;
      if (data.status === 'rejected' && data.rejection_reason) {
        requirement.rejectionReason = data.rejection_reason;
      }
    }

    await group.save();
    console.log('✅ Document status updated:', data.status);

  } catch (error) {
    console.error('❌ Error handling document update:', error);
    throw error;
  }
}

// Gestion des mises à jour de commande de numéro
async function handleNumberOrderUpdate(data) {
  try {
    console.log('📱 Processing number order update:', data.id);

    // 1. Trouver le numéro associé
    const phoneNumber = await PhoneNumber.findOne({ orderId: data.id });
    if (!phoneNumber) {
      console.log('⚠️ Phone number not found for order:', data.id);
      return;
    }

    // 2. Mettre à jour le statut de la commande
    phoneNumber.orderStatus = data.status;

    // 3. Si des requirements sont nécessaires
    if (data.requirements) {
      phoneNumber.requiredDocuments = data.requirements.map(req => ({
        field: req.field,
        description: req.description,
        type: req.type,
        status: 'pending',
        submission_type: req.submission_type,
        acceptable_values: req.acceptable_values,
        example: req.example
      }));

      if (data.requirements.deadline) {
        phoneNumber.orderDeadline = new Date(data.requirements.deadline);
      }

      // Mettre à jour le statut global
      phoneNumber.status = 'requirements_pending';
    }
    // 4. Si la commande est complétée
    else if (data.status === 'completed') {
      phoneNumber.status = 'active';
      phoneNumber.telnyxId = data.phone_number?.id;
    }
    // 5. Si la commande a échoué
    else if (data.status === 'failed') {
      phoneNumber.status = 'error';
    }

    await phoneNumber.save();
    console.log('✅ Phone number order updated:', phoneNumber._id);

  } catch (error) {
    console.error('❌ Error handling number order update:', error);
    throw error;
  }
}
