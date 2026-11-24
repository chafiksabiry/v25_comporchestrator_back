import mongoose from 'mongoose';

/**
 * Stock de numéros (inventaire Twilio) : une fiche PhoneNumber ne retient plus son numéro quand
 *  - la ligne est libérée / résiliée (statut ou cycle de facturation terminal), ou
 *  - l'entreprise qui la détenait n'existe plus (entreprise supprimée, fiche orpheline).
 * Le numéro, s'il est encore chez Twilio, revient alors automatiquement en stock. Rien n'est jamais supprimé chez Twilio ici.
 * En cas de doute (base des entreprises illisible), on considère le numéro comme détenu : on ne libère jamais à l'aveugle.
 */

/** Statuts de ligne terminaux : la ligne n'appartient plus à personne. */
export const RELEASED_STATUSES = new Set(['cancelled', 'canceled', 'released', 'terminated', 'deleted', 'failed']);

/** Cycle de facturation terminal. `release_failed` n'en fait PAS partie : la libération reste à reprendre, le numéro est retenu. */
export function hasReleasedStatus(doc) {
  if (String(doc?.billingStatus || '') === 'release_failed') return false;
  return RELEASED_STATUSES.has(String(doc?.status || '').toLowerCase()) || String(doc?.billingStatus || '') === 'terminated';
}

function toObjectId(value) {
  const s = value == null ? '' : String(value);
  return mongoose.isValidObjectId(s) && /^[0-9a-f]{24}$/i.test(s) ? new mongoose.Types.ObjectId(s) : null;
}

/**
 * Identifiants (chaînes) des entreprises qui existent encore, parmi `ids`, en une seule requête.
 * Lève une erreur si la base des entreprises n'est pas lisible (l'appelant garde alors les numéros comme détenus).
 * @param {{ collection: (name: string) => any }} db
 */
export async function existingCompanyIds(ids, db = mongoose.connection?.db) {
  if (!db || typeof db.collection !== 'function') throw new Error('companies collection unavailable');
  const oids = [...new Set(ids.map((id) => String(id)))].map(toObjectId).filter(Boolean);
  if (!oids.length) return new Set();
  const companies = db.collection('companies');
  const rows = await companies.find({ _id: { $in: oids } }, { projection: { _id: 1 } }).toArray();
  if (!rows.length) {
    // Garde-fou : une collection vide (mauvaise base, connexion à une autre base) ne doit pas libérer tout le stock.
    const total = await companies.estimatedDocumentCount();
    if (!total) throw new Error('companies collection is empty');
  }
  return new Set(rows.map((r) => String(r._id)));
}

/**
 * Parmi des fiches PhoneNumber, celles qui retiennent encore leur numéro.
 * @param {Array<{phoneNumber: string, companyId?: any, status?: string, billingStatus?: string}>} docs
 * @returns {Promise<Set<string>>} numéros E.164 retenus
 */
export async function heldNumbers(docs, { db, lookup = existingCompanyIds } = {}) {
  const live = docs.filter((d) => !hasReleasedStatus(d));
  if (!live.length) return new Set();
  let existing;
  try {
    existing = await lookup(live.map((d) => d.companyId).filter((id) => id != null), db);
  } catch (err) {
    console.warn('[telephony] entreprises illisibles, aucun numéro rendu au stock:', err.message);
    return new Set(live.map((d) => d.phoneNumber));
  }
  const held = new Set();
  for (const d of live) {
    const companyId = d.companyId == null ? '' : String(d.companyId);
    if (companyId && existing.has(companyId)) held.add(d.phoneNumber);
  }
  return held;
}
