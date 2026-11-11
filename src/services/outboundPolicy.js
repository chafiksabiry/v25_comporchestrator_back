import InboundSettings from '../models/InboundSettings.js';
import { PhoneNumber } from '../models/PhoneNumber.js';
import { allowedPrefixes } from './browserOutbound.js';
import { checkDestination, countryPrefixOf, effectiveOutboundPrefixes, toStrictE164 } from './outboundDestinations.js';

/**
 * Pays autorisés pour les appels sortants d'une entreprise. Le pays de l'entreprise est celui de ses propres lignes
 * (premier numéro actif) : aucune donnée d'une autre entreprise n'est lue.
 * `loadSaved` / `loadLines` sont injectables pour les tests.
 */
export async function resolveOutboundPolicy(companyId, {
  loadSaved = async (id) => (await InboundSettings.findOne({ companyId: id }).select('outboundPrefixes').lean())?.outboundPrefixes,
  loadLines = async (id) => PhoneNumber.find({ companyId: id }).sort({ createdAt: 1 }).limit(5).select('phoneNumber').lean(),
  env = process.env.OUTBOUND_ALLOWED_PREFIXES,
} = {}) {
  const saved = await loadSaved(companyId);
  const lines = Array.isArray(saved) ? [] : await loadLines(companyId);
  let companyCountry = '';
  for (const line of lines || []) {
    companyCountry = countryPrefixOf(toStrictE164(line?.phoneNumber));
    if (companyCountry) break;
  }
  const envPrefixes = allowedPrefixes(env);
  const defaults = effectiveOutboundPrefixes({ saved: undefined, companyCountry, envPrefixes }).prefixes;
  const { prefixes, customized } = effectiveOutboundPrefixes({ saved, companyCountry, envPrefixes });
  return { prefixes, customized, defaults, companyCountry };
}

/** Contrôle serveur d'une destination pour cette entreprise (E.164, pays activé, pas de numéro surtaxé). */
export async function checkCompanyDestination(companyId, raw, options) {
  const policy = await resolveOutboundPolicy(companyId, options);
  return checkDestination(raw, policy.prefixes);
}
