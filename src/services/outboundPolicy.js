import InboundSettings from '../models/InboundSettings.js';
import { PhoneNumber } from '../models/PhoneNumber.js';
import { allowedPrefixes } from './browserOutbound.js';
import { checkDestination, countryPrefixOf, effectiveOutboundPrefixes, toStrictE164 } from './outboundDestinations.js';
import { isNationalFormat } from './voicemailCallback.js';

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

/**
 * Pays de l'entreprise (indicatif de sa première ligne lisible), ou ''. Contrairement à resolveOutboundPolicy, ne dépend pas des pays
 * activés par le titulaire (qui court-circuitent la lecture des lignes).
 */
export async function resolveCompanyCountry(companyId, {
  loadLines = async (id) => PhoneNumber.find({ companyId: id }).sort({ createdAt: 1 }).limit(5).select('phoneNumber').lean(),
} = {}) {
  for (const line of (await loadLines(companyId)) || []) {
    const country = countryPrefixOf(toStrictE164(line?.phoneNumber));
    if (country) return country;
  }
  return '';
}

/**
 * Numéro (E.164) de la première ligne lisible de l'entreprise, ou ''. Le numéro complet (et pas seulement l'indicatif) permet de
 * distinguer les territoires qui partagent un indicatif (+1, +7, +262…).
 */
export async function resolveCompanyHome(companyId, {
  loadLines = async (id) => PhoneNumber.find({ companyId: id }).sort({ createdAt: 1 }).limit(5).select('phoneNumber').lean(),
} = {}) {
  for (const line of (await loadLines(companyId)) || []) {
    const e164 = toStrictE164(line?.phoneNumber);
    if (e164 && countryPrefixOf(e164)) return e164;
  }
  return '';
}

/**
 * Contrôle serveur d'une destination pour cette entreprise (E.164, pays activé, pas de numéro surtaxé). Un numéro saisi au format national
 * est lu selon le pays de la ligne appelante : `options.lineNumber` si fourni, sinon la première ligne lisible de l'entreprise (jamais la
 * France par défaut ; entreprise sans ligne lisible : numéro national refusé, à saisir au format international).
 */
export async function checkCompanyDestination(companyId, raw, options = {}) {
  const policy = await resolveOutboundPolicy(companyId, options);
  let lineNumber = options.lineNumber;
  if (lineNumber === undefined) lineNumber = isNationalFormat(raw) ? await resolveCompanyHome(companyId, options.loadLines ? { loadLines: options.loadLines } : {}) : '';
  return checkDestination(raw, policy.prefixes, { lineNumber });
}
