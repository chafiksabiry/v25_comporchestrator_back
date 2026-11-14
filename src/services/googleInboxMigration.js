import SecretariatConnection from '../models/SecretariatConnection.js';
import SecretariatSharedAccount from '../models/SecretariatSharedAccount.js';
import InboundEmail from '../models/InboundEmail.js';
import { revokeStoredGrant } from './secretariatConnections.js';

/**
 * Migration « Google sans lecture » : Google ne demande plus jamais gmail.readonly ni gmail.modify (scopes restreints retirés de la
 * demande de vérification). Pour les comptes autorisés AVANT ce retrait :
 *  1. la lecture de la boîte est désactivée (`inbound.readEnabled = false`, dernière lecture remise à zéro) ;
 *  2. les e-mails entrants conservés des comptes Google sont PURGÉS (entreprise et messageries personnelles) ;
 *  3. les scopes restreints sont retirés des scopes mémorisés (la lecture est de toute façon refusée par le code) ;
 *  4. révocation chez Google : DÉSACTIVÉE par défaut. Google ne sait pas retirer un seul scope d'une autorisation : révoquer le jeton coupe
 *     aussi l'envoi et l'agenda, et oblige le compte à se reconnecter (il passe en `needs_reauth`, et la reconnexion ne demandera plus que
 *     l'envoi et l'agenda). Activée seulement avec GOOGLE_REVOKE_RESTRICTED_GRANTS=1, au mieux (un échec est toléré et compté).
 * IDEMPOTENTE (un second passage ne trouve plus rien) et JOURNALISÉE (une ligne JSON `google_inbox_neutralized` avec les compteurs, sans adresse
 * ni contenu). Appelée au démarrage du serveur ; ne lève jamais (le démarrage n'en dépend pas).
 */
export const RESTRICTED_GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
];

const withRestricted = { provider: 'google', scopes: { $in: RESTRICTED_GOOGLE_SCOPES } };
const count = (r) => Number(r?.modifiedCount ?? r?.nModified ?? 0);

export async function neutralizeGoogleInbox({ env = process.env, revoke = (kind, doc) => revokeStoredGrant(kind, doc, { env }), log = console.log } = {}) {
  const result = { sharedReadDisabled: 0, emailsPurged: 0, connectionScopesStripped: 0, accountScopesStripped: 0, revoked: 0, revokeFailed: 0 };
  try {
    // Révocation d'abord (elle a besoin d'identifier les comptes qui ont encore les scopes restreints), puis retrait des scopes.
    if (String(env.GOOGLE_REVOKE_RESTRICTED_GRANTS || '') === '1') {
      const targets = [
        ...(await SecretariatConnection.find(withRestricted).select('_id companyId provider').lean()).map((d) => ['connection', d]),
        ...(await SecretariatSharedAccount.find(withRestricted).select('_id companyId provider').lean()).map((d) => ['shared', d]),
      ];
      for (const [kind, doc] of targets) {
        try {
          await revoke(kind, doc);
          const Model = kind === 'shared' ? SecretariatSharedAccount : SecretariatConnection;
          await Model.updateMany({ _id: doc._id }, { $set: { status: 'needs_reauth' } });
          result.revoked += 1;
        } catch {
          result.revokeFailed += 1; // au mieux : on continue, rien n'est perdu
        }
      }
    }
    result.sharedReadDisabled = count(await SecretariatSharedAccount.updateMany(
      { provider: 'google', 'inbound.readEnabled': true },
      { $set: { 'inbound.readEnabled': false, 'inbound.lastSyncAt': null } }
    ));
    const purged = await InboundEmail.deleteMany({ provider: 'google' });
    result.emailsPurged = Number(purged?.deletedCount ?? 0);
    result.connectionScopesStripped = count(await SecretariatConnection.updateMany(withRestricted, { $pull: { scopes: { $in: RESTRICTED_GOOGLE_SCOPES } } }));
    result.accountScopesStripped = count(await SecretariatSharedAccount.updateMany(withRestricted, { $pull: { scopes: { $in: RESTRICTED_GOOGLE_SCOPES } } }));
    log(JSON.stringify({ event: 'google_inbox_neutralized', ...result }));
  } catch (error) {
    console.warn('[googleInboxMigration] failed:', error.message);
    result.error = error.message;
  }
  return result;
}
