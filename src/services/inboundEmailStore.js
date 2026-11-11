import mongoose from 'mongoose';
import InboundEmail from '../models/InboundEmail.js';
import SecretariatTools from '../models/SecretariatTools.js';

/**
 * Purge de TOUS les e-mails entrants stockés d'un centre (désactivation, déconnexion de la messagerie) et remise à zéro de la dernière lecture.
 * Module minimal (modèles seulement) pour être appelé depuis secretariatConnections.js sans dépendance circulaire.
 */
export async function purgeInboundEmails(companyId) {
  const id = new mongoose.Types.ObjectId(String(companyId));
  await InboundEmail.deleteMany({ companyId: id });
  await SecretariatTools.updateOne({ companyId: id }, { $set: { 'inbound.lastSyncAt': null } });
}
