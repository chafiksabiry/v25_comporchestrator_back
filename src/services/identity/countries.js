/**
 * Pays des documents d'identité : codes ISO 3166-1 alpha-3 (MRZ, OACI Doc 9303) vers alpha-2 (règles des numéros), et formats de
 * code postal utilisés pour déduire le pays d'un justificatif qui n'imprime pas le pays (spec §5.2). Données pures, aucun appel réseau.
 */

// ISO 3166-1 : alpha-3 -> alpha-2 (tous les pays et territoires attribués).
const ISO3_TO_ISO2 = Object.freeze({
  AFG: 'AF', ALA: 'AX', ALB: 'AL', DZA: 'DZ', ASM: 'AS', AND: 'AD', AGO: 'AO', AIA: 'AI', ATA: 'AQ', ATG: 'AG', ARG: 'AR', ARM: 'AM',
  ABW: 'AW', AUS: 'AU', AUT: 'AT', AZE: 'AZ', BHS: 'BS', BHR: 'BH', BGD: 'BD', BRB: 'BB', BLR: 'BY', BEL: 'BE', BLZ: 'BZ', BEN: 'BJ',
  BMU: 'BM', BTN: 'BT', BOL: 'BO', BES: 'BQ', BIH: 'BA', BWA: 'BW', BVT: 'BV', BRA: 'BR', IOT: 'IO', BRN: 'BN', BGR: 'BG', BFA: 'BF',
  BDI: 'BI', CPV: 'CV', KHM: 'KH', CMR: 'CM', CAN: 'CA', CYM: 'KY', CAF: 'CF', TCD: 'TD', CHL: 'CL', CHN: 'CN', CXR: 'CX', CCK: 'CC',
  COL: 'CO', COM: 'KM', COG: 'CG', COD: 'CD', COK: 'CK', CRI: 'CR', CIV: 'CI', HRV: 'HR', CUB: 'CU', CUW: 'CW', CYP: 'CY', CZE: 'CZ',
  DNK: 'DK', DJI: 'DJ', DMA: 'DM', DOM: 'DO', ECU: 'EC', EGY: 'EG', SLV: 'SV', GNQ: 'GQ', ERI: 'ER', EST: 'EE', SWZ: 'SZ', ETH: 'ET',
  FLK: 'FK', FRO: 'FO', FJI: 'FJ', FIN: 'FI', FRA: 'FR', GUF: 'GF', PYF: 'PF', ATF: 'TF', GAB: 'GA', GMB: 'GM', GEO: 'GE', DEU: 'DE',
  GHA: 'GH', GIB: 'GI', GRC: 'GR', GRL: 'GL', GRD: 'GD', GLP: 'GP', GUM: 'GU', GTM: 'GT', GGY: 'GG', GIN: 'GN', GNB: 'GW', GUY: 'GY',
  HTI: 'HT', HMD: 'HM', VAT: 'VA', HND: 'HN', HKG: 'HK', HUN: 'HU', ISL: 'IS', IND: 'IN', IDN: 'ID', IRN: 'IR', IRQ: 'IQ', IRL: 'IE',
  IMN: 'IM', ISR: 'IL', ITA: 'IT', JAM: 'JM', JPN: 'JP', JEY: 'JE', JOR: 'JO', KAZ: 'KZ', KEN: 'KE', KIR: 'KI', PRK: 'KP', KOR: 'KR',
  KWT: 'KW', KGZ: 'KG', LAO: 'LA', LVA: 'LV', LBN: 'LB', LSO: 'LS', LBR: 'LR', LBY: 'LY', LIE: 'LI', LTU: 'LT', LUX: 'LU', MAC: 'MO',
  MDG: 'MG', MWI: 'MW', MYS: 'MY', MDV: 'MV', MLI: 'ML', MLT: 'MT', MHL: 'MH', MTQ: 'MQ', MRT: 'MR', MUS: 'MU', MYT: 'YT', MEX: 'MX',
  FSM: 'FM', MDA: 'MD', MCO: 'MC', MNG: 'MN', MNE: 'ME', MSR: 'MS', MAR: 'MA', MOZ: 'MZ', MMR: 'MM', NAM: 'NA', NRU: 'NR', NPL: 'NP',
  NLD: 'NL', NCL: 'NC', NZL: 'NZ', NIC: 'NI', NER: 'NE', NGA: 'NG', NIU: 'NU', NFK: 'NF', MKD: 'MK', MNP: 'MP', NOR: 'NO', OMN: 'OM',
  PAK: 'PK', PLW: 'PW', PSE: 'PS', PAN: 'PA', PNG: 'PG', PRY: 'PY', PER: 'PE', PHL: 'PH', PCN: 'PN', POL: 'PL', PRT: 'PT', PRI: 'PR',
  QAT: 'QA', REU: 'RE', ROU: 'RO', RUS: 'RU', RWA: 'RW', BLM: 'BL', SHN: 'SH', KNA: 'KN', LCA: 'LC', MAF: 'MF', SPM: 'PM', VCT: 'VC',
  WSM: 'WS', SMR: 'SM', STP: 'ST', SAU: 'SA', SEN: 'SN', SRB: 'RS', SYC: 'SC', SLE: 'SL', SGP: 'SG', SXM: 'SX', SVK: 'SK', SVN: 'SI',
  SLB: 'SB', SOM: 'SO', ZAF: 'ZA', SGS: 'GS', SSD: 'SS', ESP: 'ES', LKA: 'LK', SDN: 'SD', SUR: 'SR', SJM: 'SJ', SWE: 'SE', CHE: 'CH',
  SYR: 'SY', TWN: 'TW', TJK: 'TJ', TZA: 'TZ', THA: 'TH', TLS: 'TL', TGO: 'TG', TKL: 'TK', TON: 'TO', TTO: 'TT', TUN: 'TN', TUR: 'TR',
  TKM: 'TM', TCA: 'TC', TUV: 'TV', UGA: 'UG', UKR: 'UA', ARE: 'AE', GBR: 'GB', USA: 'US', UMI: 'UM', URY: 'UY', UZB: 'UZ', VUT: 'VU',
  VEN: 'VE', VNM: 'VN', VGB: 'VG', VIR: 'VI', WLF: 'WF', ESH: 'EH', YEM: 'YE', ZMB: 'ZM', ZWE: 'ZW',
  // Codes propres aux documents de voyage (OACI Doc 9303, partie 3) : Allemagne (« D »), nationalités britanniques, Kosovo.
  D: 'DE', GBD: 'GB', GBN: 'GB', GBO: 'GB', GBP: 'GB', GBS: 'GB', RKS: 'XK',
});

/** Code alpha-3 (ou code OACI) -> alpha-2 ; null si inconnu (ex. l'État fictif « UTO » des spécimens OACI). */
export function iso3ToIso2(code) {
  const c = String(code ?? '').toUpperCase().replace(/</g, '').trim();
  return ISO3_TO_ISO2[c] || null;
}

/** Code alpha-2 normalisé (UK -> GB) ; '' si invalide. */
export function normalizeIso2(code) {
  const c = String(code ?? '').trim().toUpperCase();
  const v = c === 'UK' ? 'GB' : c;
  return /^[A-Z]{2}$/.test(v) ? v : '';
}

/** Accepte un code à 2 ou 3 lettres et renvoie l'alpha-2, ou '' si rien d'exploitable. */
export function toIso2(code) {
  const c = String(code ?? '').trim().toUpperCase();
  if (c.length === 2) return normalizeIso2(c);
  return iso3ToIso2(c) || '';
}

/**
 * Formats de code postal (justificatif sans pays imprimé). Un format seul ne suffit jamais : plusieurs pays partagent « 5 chiffres ».
 * La règle (decision.js) exige en plus que le pays déduit par l'extraction soit le pays déclaré.
 */
const POSTAL_FORMATS = Object.freeze({
  FR: /^\d{5}$/, DE: /^\d{5}$/, ES: /^\d{5}$/, IT: /^\d{5}$/, MA: /^\d{5}$/, DZ: /^\d{5}$/, TN: /^\d{4}$/, SA: /^\d{5}(-\d{4})?$/,
  US: /^\d{5}(-\d{4})?$/, GB: /^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/, BE: /^\d{4}$/, CH: /^\d{4}$/, LU: /^(L-?)?\d{4}$/, NL: /^\d{4}\s?[A-Z]{2}$/,
  PT: /^\d{4}-\d{3}$/, CA: /^[A-Z]\d[A-Z]\s?\d[A-Z]\d$/, IE: /^[A-Z]\d[\dW]\s?[A-Z\d]{4}$/, SN: /^\d{5}$/,
});

/** Le code postal a-t-il la forme attendue pour ce pays ? `null` si le pays n'a pas de format connu (ou pas de code postal). */
export function postalCodeMatches(country, postalCode) {
  const re = POSTAL_FORMATS[normalizeIso2(country)];
  const v = String(postalCode ?? '').trim().toUpperCase();
  if (!re || !v) return null;
  return re.test(v);
}

// Noms de pays imprimés courants (adresse d'un justificatif) -> alpha-2. Le modèle donne aussi un code déduit ; ce tableau permet
// au code de ne pas dépendre du code produit par le modèle quand le pays est imprimé en toutes lettres.
const PRINTED_NAMES = Object.freeze({
  FRANCE: 'FR', 'REPUBLIQUE FRANCAISE': 'FR', MAROC: 'MA', MOROCCO: 'MA', 'ROYAUME DU MAROC': 'MA', 'KINGDOM OF MOROCCO': 'MA', 'المغرب': 'MA', 'المملكة المغربية': 'MA',
  'UNITED KINGDOM': 'GB', UK: 'GB', 'ROYAUME UNI': 'GB', 'GREAT BRITAIN': 'GB', ENGLAND: 'GB', SCOTLAND: 'GB', WALES: 'GB',
  'UNITED STATES': 'US', USA: 'US', 'UNITED STATES OF AMERICA': 'US', 'ETATS UNIS': 'US', BELGIQUE: 'BE', BELGIUM: 'BE', BELGIE: 'BE',
  SUISSE: 'CH', SWITZERLAND: 'CH', SCHWEIZ: 'CH', LUXEMBOURG: 'LU', ALLEMAGNE: 'DE', GERMANY: 'DE', DEUTSCHLAND: 'DE', ESPAGNE: 'ES',
  SPAIN: 'ES', ESPANA: 'ES', ITALIE: 'IT', ITALY: 'IT', ITALIA: 'IT', PORTUGAL: 'PT', 'PAYS BAS': 'NL', NETHERLANDS: 'NL', NEDERLAND: 'NL',
  IRLANDE: 'IE', IRELAND: 'IE', CANADA: 'CA', TUNISIE: 'TN', TUNISIA: 'TN', 'تونس': 'TN', ALGERIE: 'DZ', ALGERIA: 'DZ', 'الجزائر': 'DZ',
  SENEGAL: 'SN', 'COTE D IVOIRE': 'CI', 'IVORY COAST': 'CI', 'UNITED ARAB EMIRATES': 'AE', 'EMIRATS ARABES UNIS': 'AE', UAE: 'AE',
  'الإمارات العربية المتحدة': 'AE', 'الامارات العربية المتحدة': 'AE', 'SAUDI ARABIA': 'SA', 'ARABIE SAOUDITE': 'SA', 'المملكة العربية السعودية': 'SA',
});

/** Pays imprimé en toutes lettres (ou code) -> alpha-2 ; '' si non reconnu (le code ne devine jamais). */
export function printedCountryToIso2(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  if (PRINTED_NAMES[raw]) return PRINTED_NAMES[raw];
  const latin = raw.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().replace(/[^A-Z]+/g, ' ').trim();
  if (PRINTED_NAMES[latin]) return PRINTED_NAMES[latin];
  if (/^[A-Z]{2,3}$/.test(latin)) return toIso2(latin);
  return '';
}
