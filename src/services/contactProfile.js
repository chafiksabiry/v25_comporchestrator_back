import { PhoneNumber } from '../models/PhoneNumber.js';
import { loadCompanyPlanLimits } from './planLimits.js';
import { offerKind } from './lineAssignment.js';
import { callingInfoOf } from './outboundDestinations.js';
import { LEGACY_CALLING_CODE } from './contacts.js';

/**
 * Profil « contacts » d'une société : est-ce une société Nomad, et dans quel pays lire un numéro national saisi sans `+`.
 *  - Nomad : indicatif de la ligne Nomad (la plus ancienne ligne active) ; sans ligne, `null` (un numéro national est refusé).
 *  - autres offres : 33, comme avant (aucun changement pour elles).
 * Dépendances remplaçables par les tests.
 */
export const contactProfileDeps = {
  loadLimits: (companyId) => loadCompanyPlanLimits(companyId),
  findLine: (companyId) => PhoneNumber.findOne({ companyId, status: 'active' }).sort({ createdAt: 1 }).lean(),
};

const TTL_MS = 60 * 1000;
const cache = new Map();
export const clearContactProfileCache = () => cache.clear();

/** @returns {Promise<{nomad: boolean, callingCode: number|null, lineCountry: string|null}>} lève si l'offre ne peut pas être lue */
export async function contactProfile(companyId) {
  const key = String(companyId);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const limits = await contactProfileDeps.loadLimits(key);
  let value = { nomad: false, callingCode: LEGACY_CALLING_CODE, lineCountry: null };
  if (offerKind(limits) === 'nomad') {
    const line = await contactProfileDeps.findLine(key);
    const info = callingInfoOf(line?.phoneNumber);
    value = { nomad: true, callingCode: info.callingCode, lineCountry: info.countryIso };
  }
  cache.set(key, { value, expires: Date.now() + TTL_MS });
  return value;
}
