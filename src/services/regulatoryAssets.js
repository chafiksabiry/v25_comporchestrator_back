import RegulatoryAsset from '../models/RegulatoryAsset.js';
import { TelnyxRequirementGroup } from '../models/TelnyxRequirementGroup.js';

/** Identifiant d'une pièce d'après la valeur d'une exigence : identifiant brut, JSON `{"id":…}` ou objet `{ id }`. null si illisible. */
export function assetIdOf(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object') return value.id ? String(value.id) : null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.startsWith('{')) {
    try { const o = JSON.parse(text); return o && o.id ? String(o.id) : null; } catch { return null; }
  }
  return text;
}

const escapeRegExp = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Enregistre la propriété d'une pièce (premier enregistrement gagnant ; idempotent). Une collision d'index (E11000) d'une inscription concurrente n'est pas une erreur. */
export async function claimAsset({ companyId, userId = '' }, kind, externalId) {
  if (!externalId) return;
  try {
    await RegulatoryAsset.updateOne(
      { kind, externalId: String(externalId) },
      { $setOnInsert: { kind, externalId: String(externalId), companyId: String(companyId), userId: String(userId || '') } },
      { upsert: true },
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
}

/** Sociétés dont un groupe référence cette pièce (`submittedValueId`, brut ou JSON). */
async function companiesReferencing(kind, id) {
  const groups = await TelnyxRequirementGroup.find({ requirements: { $elemMatch: { type: kind, submittedValueId: { $regex: escapeRegExp(id) } } } }).select('companyId requirements').lean();
  const out = new Set();
  for (const g of groups || []) if ((g.requirements || []).some((r) => r.type === kind && assetIdOf(r.submittedValueId) === id)) out.add(String(g.companyId));
  return out;
}

/**
 * La pièce appartient-elle à cette société ? Enregistrement explicite d'abord. À défaut, REPRISE des pièces créées avant le déploiement : seulement si les
 * groupes qui la référencent sont TOUS ceux de cette société (si des groupes de plus d'une société la référencent, la reprise est refusée : elle
 * récompenserait un PATCH antérieur avec l'id d'autrui). Après l'inscription on RELIT l'enregistrement et l'accès n'est accordé que si c'est bien le nom de
 * cette société (course entre deux sociétés). Rien n'est supprimé ni déplacé ; une pièce enregistrée au nom d'une autre société n'est jamais reprise.
 */
export async function isOwnedAsset(kind, externalId, companyId) {
  const id = String(externalId || '');
  const company = String(companyId || '');
  if (!id || !company) return false;
  const known = await RegulatoryAsset.findOne({ kind, externalId: id }).select('companyId').lean();
  if (known) return String(known.companyId) === company;
  const referencing = await companiesReferencing(kind, id);
  if (referencing.size !== 1 || !referencing.has(company)) return false;
  await claimAsset({ companyId: company }, kind, id);
  const after = await RegulatoryAsset.findOne({ kind, externalId: id }).select('companyId').lean();
  return !!after && String(after.companyId) === company;
}
