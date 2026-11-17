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

/** Enregistre la propriété d'une pièce (premier enregistrement gagnant ; idempotent). */
export async function claimAsset({ companyId, userId = '' }, kind, externalId) {
  if (!externalId) return;
  await RegulatoryAsset.updateOne(
    { kind, externalId: String(externalId) },
    { $setOnInsert: { kind, externalId: String(externalId), companyId: String(companyId), userId: String(userId || '') } },
    { upsert: true },
  );
}

/**
 * La pièce appartient-elle à cette société ? Enregistrement explicite (création) ; à défaut, REPRISE des pièces créées avant le déploiement : si un
 * groupe d'exigences DE CETTE société référence déjà la pièce (`submittedValueId`), elle lui appartient et la propriété est enregistrée (idempotent,
 * rien n'est supprimé ni déplacé). Une pièce déjà enregistrée au nom d'une AUTRE société n'est jamais reprise.
 */
export async function isOwnedAsset(kind, externalId, companyId) {
  const id = String(externalId || '');
  const company = String(companyId || '');
  if (!id || !company) return false;
  const known = await RegulatoryAsset.findOne({ kind, externalId: id }).select('companyId').lean();
  if (known) return String(known.companyId) === company;
  const groups = await TelnyxRequirementGroup.find({ companyId: company }).select('requirements').lean();
  const referenced = (groups || []).some((g) => (g.requirements || []).some((r) => r.type === kind && assetIdOf(r.submittedValueId) === id));
  if (referenced) await claimAsset({ companyId: company }, kind, id);
  return referenced;
}
