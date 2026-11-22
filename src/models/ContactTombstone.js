import mongoose from 'mongoose';

/**
 * Trace d'un contact du téléphone supprimé dans le portail : la synchronisation suivante ne le recrée pas.
 * Elle n'expire pas (la promesse « ils ne reviendront pas » est sans limite de durée). Elle est effacée quand l'abonné désactive la
 * synchronisation, et 90 jours après la résiliation (services/contactsRetention.js).
 */
const schema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
  deviceId: { type: String, required: true, maxlength: 100 },
  externalId: { type: String, required: true, maxlength: 200 },
  createdAt: { type: Date, default: Date.now },
});
schema.index({ companyId: 1, deviceId: 1, externalId: 1 }, { unique: true });

const ContactTombstone = mongoose.models.ContactTombstone || mongoose.model('ContactTombstone', schema);
export default ContactTombstone;

const missingCollection = (e) => e?.code === 26 || e?.codeName === 'NamespaceNotFound' || /ns (does not exist|not found)/i.test(String(e?.message || ''));
const missingIndex = (e) => e?.code === 27 || e?.codeName === 'IndexNotFound' || /index not found/i.test(String(e?.message || ''));

/**
 * Migration (au démarrage, idempotente) : retire l'ancien index d'expiration (TTL 180 jours sur `createdAt`) des traces de suppression.
 * Sans index TTL : rien. Collection absente, ou index déjà retiré par une autre instance : rien. L'index unique n'est jamais touché.
 */
export async function removeTombstoneExpiry(collection = ContactTombstone.collection) {
  let indexes;
  try {
    indexes = await collection.indexes();
  } catch (e) {
    if (missingCollection(e)) return { dropped: [] };
    throw e;
  }
  const ttl = indexes.filter((i) => i && i.name !== '_id_' && i.expireAfterSeconds !== undefined && i.expireAfterSeconds !== null && !i.unique);
  const dropped = [];
  for (const i of ttl) {
    try {
      await collection.dropIndex(i.name);
      dropped.push(i.name);
    } catch (e) {
      if (!missingIndex(e) && !missingCollection(e)) throw e;
    }
  }
  return { dropped };
}
