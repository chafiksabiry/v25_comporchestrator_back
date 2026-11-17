import mongoose from 'mongoose';
import InboundEmail from '../models/InboundEmail.js';
import SecretariatSharedAccount from '../models/SecretariatSharedAccount.js';
import SecretariatTools from '../models/SecretariatTools.js';

const oid = (v) => new mongoose.Types.ObjectId(String(v));

/** Valeur de `purgeInboundEmails` pour TOUS les propriétaires (désactivation du réglage global par le titulaire). */
export const ALL_OWNERS = '*';

/**
 * Purge des e-mails entrants stockés de l'ENTREPRISE (désactivation, déconnexion de la messagerie) et remise à zéro de la dernière lecture.
 * Le propriétaire est OBLIGATOIRE et explicite : `ownerId` = seulement les e-mails de la boîte de CE propriétaire ; `ALL_OWNERS` = tous (réglage global coupé par le titulaire) ;
 * vide / null = seulement les anciens e-mails SANS propriétaire de connexion (reprise d'une connexion orpheline). Jamais « tout » par défaut.
 * Ne touche JAMAIS aux e-mails des messageries personnelles (`ownerUserId` renseigné) : ils ont leur propre purge.
 * Module minimal (modèles seulement) pour être appelé depuis secretariatConnections.js sans dépendance circulaire.
 */
export async function purgeInboundEmails(companyId, ownerId) {
  const id = oid(companyId);
  const byOwner = ownerId === ALL_OWNERS ? {} : ownerId ? { connectionOwnerId: String(ownerId) } : { connectionOwnerId: null };
  await InboundEmail.deleteMany({ companyId: id, ownerUserId: null, ...byOwner });
  await SecretariatTools.updateOne({ companyId: id }, { $set: { 'inbound.lastSyncAt': null } });
}

/**
 * Purge de TOUS les e-mails stockés d'UNE messagerie personnelle (arrêt de la lecture, déconnexion de la messagerie, perte de l'autorisation de lecture)
 * et remise à zéro de sa dernière lecture. Filtre société + propriétaire + compte : aucune autre portée n'est touchée.
 */
export async function purgePersonalInbox(companyId, userId, accountId) {
  await InboundEmail.deleteMany({ companyId: oid(companyId), ownerUserId: String(userId), accountId: oid(accountId) });
  await SecretariatSharedAccount.updateOne({ _id: oid(accountId), companyId: oid(companyId), personalUserId: String(userId) }, { $set: { 'inbound.lastSyncAt': null } });
}
