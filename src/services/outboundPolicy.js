import InboundSettings from '../models/InboundSettings.js';
import { PhoneNumber } from '../models/PhoneNumber.js';
import { checkDestination, countryPrefixOf, effectiveOutboundPrefixes, toStrictE164 } from './outboundDestinations.js';

/**
 * Pays autorisés pour les appels sortants d'une entreprise : l'indicatif de sa ligne seulement (premier numéro lisible ; aucune donnée
 * d'une autre entreprise n'est lue). OUTBOUND_ALLOWED_PREFIXES n'ajoute plus rien. `loadSaved` / `loadLines` injectables (tests).
 */
export async function resolveOutboundPolicy(companyId, {
  loadSaved = async (id) => (await InboundSettings.findOne({ companyId: id }).select('outboundPrefixes').lean())?.outboundPrefixes,
  loadLines = async (id) => PhoneNumber.find({ companyId: id }).sort({ createdAt: 1 }).limit(5).select('phoneNumber').lean(),
} = {}) {
  const saved = await loadSaved(companyId);
  // Pays de la ligne TOUJOURS lu (décision du 26/11/2026) : c'est le seul pays appelable, même quand le titulaire a enregistré une sélection.
  const companyCountry = await resolveCompanyCountry(companyId, { loadLines });
  const defaults = effectiveOutboundPrefixes({ saved: undefined, companyCountry }).prefixes;
  const { prefixes, customized } = effectiveOutboundPrefixes({ saved, companyCountry });
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
 * Contrôle serveur d'une destination pour cette entreprise : E.164, jamais un numéro surtaxé ou court, MÊME indicatif pays que la ligne
 * (première ligne lisible de l'entreprise ; NOMAD n'en a qu'une), pays non retiré par le titulaire.
 */
export async function checkCompanyDestination(companyId, raw, options = {}) {
  const policy = await resolveOutboundPolicy(companyId, options);
  return checkDestination(raw, policy.prefixes, { lineCountry: policy.companyCountry });
}
