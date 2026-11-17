import InboundEmail from '../models/InboundEmail.js';
import SecretariatConnection from '../models/SecretariatConnection.js';
import SecretariatSharedAccount from '../models/SecretariatSharedAccount.js';
import SecretariatTools from '../models/SecretariatTools.js';
import { MAIL_PROVIDERS } from './mailOwnership.js';

/**
 * Migration « boîte mail = propriétaire seulement » (voir mailOwnership.js). PRUDENTE, IDEMPOTENTE, JOURNALISÉE SANS DONNÉE PERSONNELLE :
 *  1. connexions d'entreprise Google / Microsoft ET comptes partagés SANS `connectedBy` : marqués `ownerless` (inutilisables par tous jusqu'à reconnexion, retirables par
 *     le titulaire de la société). Elles ne sont JAMAIS rattachées à quelqu'un au hasard : les lignes qui ont un `connectedBy` gardent ce propriétaire, rien d'autre ne change ;
 *  2. e-mails entrants stockés de l'entreprise SANS propriétaire de connexion (`connectionOwnerId`) : purgés (ils étaient partagés ; ce ne sont que des métadonnées de 30 jours,
 *     relues pour le propriétaire au prochain rafraîchissement) ; les messageries personnelles ne sont pas touchées ;
 *  3. réglage `inbound.secretaries` (lecture ouverte aux secrétaires) : remis à faux, sans effet de toute façon.
 * Une seule ligne JSON `mail_ownership_applied` avec des compteurs : ni adresse, ni identifiant, ni société. Appelée au démarrage du serveur ; ne lève jamais.
 */
const count = (r) => Number(r?.modifiedCount ?? r?.nModified ?? r?.matchedCount ?? 0);
const noOwner = { $or: [{ connectedBy: '' }, { connectedBy: null }, { connectedBy: { $exists: false } }] };

export async function applyMailOwnership({ log = console.log } = {}) {
  const result = { connectionsOwnerless: 0, sharedAccountsOwnerless: 0, legacyInboxPurged: 0, secretariesSettingReset: 0 };
  try {
    result.connectionsOwnerless = count(await SecretariatConnection.updateMany({ provider: { $in: MAIL_PROVIDERS }, ownerless: { $ne: true }, ...noOwner }, { $set: { ownerless: true } }));
    result.sharedAccountsOwnerless = count(await SecretariatSharedAccount.updateMany({ ownerless: { $ne: true }, personalUserId: null, ...noOwner }, { $set: { ownerless: true } }));
    result.legacyInboxPurged = Number((await InboundEmail.deleteMany({ ownerUserId: null, connectionOwnerId: null }))?.deletedCount ?? 0);
    result.secretariesSettingReset = count(await SecretariatTools.updateMany({ 'inbound.secretaries': true }, { $set: { 'inbound.secretaries': false } }));
    log(JSON.stringify({ event: 'mail_ownership_applied', ...result }));
  } catch (error) {
    console.warn('[mailOwnershipMigration] failed:', error.message);
    result.error = error.message;
  }
  return result;
}
