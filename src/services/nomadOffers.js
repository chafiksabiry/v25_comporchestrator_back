import { EU_COUNTRY_CODES } from './euCountries.js';
import { INCLUDED_MINUTES_BY_TIER } from './callcenterTier.js';
import { callingInfoOf, isPremiumRate, toStrictE164 } from './outboundDestinations.js';

/**
 * Offres NOMAD (décisions du fondateur du 26/11/2026, maquette validée PR portail #654). Règles de gestion en un seul endroit :
 *  - NOMAD (abonnement mensuel, prix Stripe inchangé) : 120 minutes incluses par mois (au lieu de 30), 20 000 jetons IA inchangés.
 *  - NOMAD Traveler : 9,99 (même chiffre en €, $, £), paiement UNIQUE, 30 minutes incluses, 21 jours depuis l'activation puis
 *    résiliation automatique (ligne arrêtée, numéro rendu au fournisseur, minutes restantes perdues). Numéro des États-Unis, du Canada
 *    (numéros locaux), du Royaume-Uni (mobiles +447 seulement, jamais +4470) ou de France (numéros géographiques).
 *  - Recharges de minutes : 30 minutes pour 5 (même chiffre en €, $, £, devise de l'abonnement du client) ; choix 60 / 150 / 300 min,
 *    ou toute quantité par tranche de 30 min. Aucun prix à la minute affiché.
 *  - Décompte : 1 minute d'appel entamée = 1 minute, appels passés et reçus (plus de coefficient international).
 */

export const NOMAD_TIER = 'nomad_solo';
export const TRAVELER_TIER = 'nomad_traveler';

/** Minutes incluses par palier (prioritaires sur les métadonnées Stripe : règle de gestion, pas un réglage). */
export { INCLUDED_MINUTES_BY_TIER };
export const NOMAD_INCLUDED_MINUTES = INCLUDED_MINUTES_BY_TIER[NOMAD_TIER];
export const TRAVELER_INCLUDED_MINUTES = INCLUDED_MINUTES_BY_TIER[TRAVELER_TIER];

/** Minutes incluses imposées pour ce palier, ou null (autres offres : métadonnées Stripe). */
export const includedMinutesForTier = (tier) => INCLUDED_MINUTES_BY_TIER[tier] ?? null;

/** NOMAD Traveler : prix unique (centimes, même chiffre dans les trois devises), durée, devises acceptées. */
export const TRAVELER_PRICE_CENTS = 999;
export const TRAVELER_DAYS = 21;
export const TRAVELER_DURATION_MS = TRAVELER_DAYS * 24 * 60 * 60 * 1000;
export const OFFER_CURRENCIES = Object.freeze(['EUR', 'USD', 'GBP']);

/** Recharges : tranche de 30 min pour 5 ; trois choix proposés ; plafond d'une recharge (garde-fou). */
export const MINUTE_BLOCK = Object.freeze({ minutes: 30, priceCents: 500 });
export const MINUTE_PACKS = Object.freeze([
  Object.freeze({ minutes: 60, priceCents: 1000, label: '60' }),
  Object.freeze({ minutes: 150, priceCents: 2500, label: '150' }),
  Object.freeze({ minutes: 300, priceCents: 5000, label: '300' }),
]);
export const MAX_MINUTES_PER_PURCHASE = 3000;

/** Prix (centimes) d'une recharge de `minutes` : multiple positif de 30, au plus MAX_MINUTES_PER_PURCHASE ; sinon null (refusé). */
export function minutesBlockPriceCents(minutes) {
  const qty = Number(minutes);
  if (!Number.isInteger(qty) || qty <= 0 || qty > MAX_MINUTES_PER_PURCHASE || qty % MINUTE_BLOCK.minutes !== 0) return null;
  return (qty / MINUTE_BLOCK.minutes) * MINUTE_BLOCK.priceCents;
}

/** Pays de numéro proposés à NOMAD (décision du 26/11 : Italie, Espagne, Maroc, Émirats, Arabie saoudite retirés). */
export const NOMAD_NUMBER_COUNTRIES = Object.freeze(['US', 'CA', 'GB', 'FR', 'DE', 'NL', 'BE']);
/**
 * Pays de numéro de NOMAD Traveler (décision du 26/11 : États-Unis, Canada, Royaume-Uni, France). France : numéros géographiques
 * +33 1 à 5, achetés par le même chemin que les lignes NOMAD françaises (dossier réglementaire et adresse France de HARX joints à
 * l'achat par phoneNumberService.purchaseTwilioNumber).
 */
export const TRAVELER_NUMBER_COUNTRIES = Object.freeze(['US', 'CA', 'GB', 'FR']);

const iso = (c) => { const v = String(c ?? '').trim().toUpperCase(); return v === 'UK' ? 'GB' : v; };
export const isNomadNumberCountry = (country) => NOMAD_NUMBER_COUNTRIES.includes(iso(country));

/**
 * Numéro autorisé pour NOMAD Traveler : +1 des États-Unis ou du Canada (jamais les Caraïbes ni un numéro surtaxé),
 * mobile britannique +447 (jamais +4470, numéros personnels bloqués) ou numéro géographique français +33 1 à 5. Rend le pays ou null.
 */
export function travelerNumberCountry(raw) {
  const e164 = toStrictE164(raw);
  if (!e164 || isPremiumRate(e164)) return null;
  if (e164.startsWith('+44')) return /^\+447[1-9]\d{8}$/.test(e164) ? 'GB' : null;
  if (e164.startsWith('+33')) return /^\+33[1-5]\d{8}$/.test(e164) ? 'FR' : null;
  if (e164.startsWith('+1')) {
    const { countryIso } = callingInfoOf(e164);
    return countryIso === 'US' || countryIso === 'CA' ? countryIso : null;
  }
  return null;
}

/** Pays dont les ressortissants n'ont PAS besoin de visa pour NOMAD Traveler : GCC, États-Unis, Canada, Royaume-Uni, UE/EEE, Suisse. */
export const VISA_EXEMPT_COUNTRIES = Object.freeze([
  'AE', 'SA', 'QA', 'KW', 'BH', 'OM', // Conseil de coopération du Golfe
  'US', 'CA', 'GB',
  ...EU_COUNTRY_CODES,
  'IS', 'LI', 'NO', // EEE hors UE
  'CH',
]);

/** Visa exigé pour cette nationalité (ISO alpha-2) ? Nationalité inconnue : visa exigé (jamais d'exemption devinée). */
export const travelerVisaRequired = (nationality) => !VISA_EXEMPT_COUNTRIES.includes(iso(nationality));

/** Devise d'une offre (€, $, £ : même chiffre) ; autre devise : null. */
export const offerCurrency = (currency) => { const c = String(currency ?? '').trim().toUpperCase(); return OFFER_CURRENCIES.includes(c) ? c : null; };
