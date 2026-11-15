import { normalizeDestination } from './voicemailCallback.js';

/**
 * Destinations autorisées pour les appels SORTANTS (navigateur). Logique pure, sans accès base ni réseau.
 * Décision toujours prise par le serveur : le navigateur n'est jamais cru (ni pays, ni liste, ni numéro « déjà validé »).
 *
 * Ordre des contrôles : E.164 valide -> indicatif pays connu -> numéro surtaxé (refus définitif, aucun réglage ne le lève)
 * -> pays activé pour l'entreprise.
 */
export const DESTINATION_NOT_ALLOWED = 'destination_not_allowed';
export const INVALID_NUMBER = 'invalid_number';

export const MESSAGES = Object.freeze({
  country_not_enabled: 'Les appels vers ce pays ne sont pas activés pour votre entreprise.',
  premium_rate: 'Les numéros surtaxés ou à valeur ajoutée ne peuvent pas être appelés.',
  invalid_number: 'Numéro invalide. Saisissez-le au format international, par exemple +33 6 12 34 56 78.',
  unknown_country: 'Les appels vers ce pays ne sont pas pris en charge.',
});

/** Libellés additifs (clé ISO 3166-1 alpha-2 + libellé anglais), par indicatif : les clients traduisent d'après `iso`. Le champ `name` (français) est inchangé. */
export const COUNTRY_LABELS_EN = Object.freeze({
  '+1': { iso: ['US', 'CA'], nameEn: "United States / Canada" }, '+7': { iso: ['RU', 'KZ'], nameEn: "Russia / Kazakhstan" },
  '+20': { iso: ['EG'], nameEn: "Egypt" }, '+27': { iso: ['ZA'], nameEn: "South Africa" }, '+30': { iso: ['GR'], nameEn: "Greece" },
  '+31': { iso: ['NL'], nameEn: "Netherlands" }, '+32': { iso: ['BE'], nameEn: "Belgium" }, '+33': { iso: ['FR'], nameEn: "France" },
  '+34': { iso: ['ES'], nameEn: "Spain" }, '+36': { iso: ['HU'], nameEn: "Hungary" }, '+39': { iso: ['IT'], nameEn: "Italy" },
  '+40': { iso: ['RO'], nameEn: "Romania" }, '+41': { iso: ['CH'], nameEn: "Switzerland" }, '+43': { iso: ['AT'], nameEn: "Austria" },
  '+44': { iso: ['GB'], nameEn: "United Kingdom" }, '+45': { iso: ['DK'], nameEn: "Denmark" }, '+46': { iso: ['SE'], nameEn: "Sweden" },
  '+47': { iso: ['NO'], nameEn: "Norway" }, '+48': { iso: ['PL'], nameEn: "Poland" }, '+49': { iso: ['DE'], nameEn: "Germany" },
  '+51': { iso: ['PE'], nameEn: "Peru" }, '+52': { iso: ['MX'], nameEn: "Mexico" }, '+53': { iso: ['CU'], nameEn: "Cuba" },
  '+54': { iso: ['AR'], nameEn: "Argentina" }, '+55': { iso: ['BR'], nameEn: "Brazil" }, '+56': { iso: ['CL'], nameEn: "Chile" },
  '+57': { iso: ['CO'], nameEn: "Colombia" }, '+58': { iso: ['VE'], nameEn: "Venezuela" }, '+60': { iso: ['MY'], nameEn: "Malaysia" },
  '+61': { iso: ['AU'], nameEn: "Australia" }, '+62': { iso: ['ID'], nameEn: "Indonesia" }, '+63': { iso: ['PH'], nameEn: "Philippines" },
  '+64': { iso: ['NZ'], nameEn: "New Zealand" }, '+65': { iso: ['SG'], nameEn: "Singapore" }, '+66': { iso: ['TH'], nameEn: "Thailand" },
  '+81': { iso: ['JP'], nameEn: "Japan" }, '+82': { iso: ['KR'], nameEn: "South Korea" }, '+84': { iso: ['VN'], nameEn: "Vietnam" },
  '+86': { iso: ['CN'], nameEn: "China" }, '+90': { iso: ['TR'], nameEn: "Türkiye" }, '+91': { iso: ['IN'], nameEn: "India" },
  '+92': { iso: ['PK'], nameEn: "Pakistan" }, '+93': { iso: ['AF'], nameEn: "Afghanistan" }, '+94': { iso: ['LK'], nameEn: "Sri Lanka" },
  '+95': { iso: ['MM'], nameEn: "Myanmar" }, '+98': { iso: ['IR'], nameEn: "Iran" }, '+211': { iso: ['SS'], nameEn: "South Sudan" },
  '+212': { iso: ['MA'], nameEn: "Morocco" }, '+213': { iso: ['DZ'], nameEn: "Algeria" }, '+216': { iso: ['TN'], nameEn: "Tunisia" },
  '+218': { iso: ['LY'], nameEn: "Libya" }, '+220': { iso: ['GM'], nameEn: "Gambia" }, '+221': { iso: ['SN'], nameEn: "Senegal" },
  '+222': { iso: ['MR'], nameEn: "Mauritania" }, '+223': { iso: ['ML'], nameEn: "Mali" }, '+224': { iso: ['GN'], nameEn: "Guinea" },
  '+225': { iso: ['CI'], nameEn: "Côte d’Ivoire" }, '+226': { iso: ['BF'], nameEn: "Burkina Faso" }, '+227': { iso: ['NE'], nameEn: "Niger" },
  '+228': { iso: ['TG'], nameEn: "Togo" }, '+229': { iso: ['BJ'], nameEn: "Benin" }, '+230': { iso: ['MU'], nameEn: "Mauritius" },
  '+231': { iso: ['LR'], nameEn: "Liberia" }, '+232': { iso: ['SL'], nameEn: "Sierra Leone" }, '+233': { iso: ['GH'], nameEn: "Ghana" },
  '+234': { iso: ['NG'], nameEn: "Nigeria" }, '+235': { iso: ['TD'], nameEn: "Chad" }, '+236': { iso: ['CF'], nameEn: "Central African Republic" },
  '+237': { iso: ['CM'], nameEn: "Cameroon" }, '+238': { iso: ['CV'], nameEn: "Cape Verde" }, '+239': { iso: ['ST'], nameEn: "São Tomé and Príncipe" },
  '+240': { iso: ['GQ'], nameEn: "Equatorial Guinea" }, '+241': { iso: ['GA'], nameEn: "Gabon" }, '+242': { iso: ['CG'], nameEn: "Congo" },
  '+243': { iso: ['CD'], nameEn: "DR Congo" }, '+244': { iso: ['AO'], nameEn: "Angola" }, '+245': { iso: ['GW'], nameEn: "Guinea-Bissau" },
  '+248': { iso: ['SC'], nameEn: "Seychelles" }, '+249': { iso: ['SD'], nameEn: "Sudan" }, '+250': { iso: ['RW'], nameEn: "Rwanda" },
  '+251': { iso: ['ET'], nameEn: "Ethiopia" }, '+252': { iso: ['SO'], nameEn: "Somalia" }, '+253': { iso: ['DJ'], nameEn: "Djibouti" },
  '+254': { iso: ['KE'], nameEn: "Kenya" }, '+255': { iso: ['TZ'], nameEn: "Tanzania" }, '+256': { iso: ['UG'], nameEn: "Uganda" },
  '+257': { iso: ['BI'], nameEn: "Burundi" }, '+258': { iso: ['MZ'], nameEn: "Mozambique" }, '+260': { iso: ['ZM'], nameEn: "Zambia" },
  '+261': { iso: ['MG'], nameEn: "Madagascar" }, '+262': { iso: ['RE', 'YT'], nameEn: "Réunion / Mayotte" },
  '+263': { iso: ['ZW'], nameEn: "Zimbabwe" }, '+264': { iso: ['NA'], nameEn: "Namibia" }, '+265': { iso: ['MW'], nameEn: "Malawi" },
  '+266': { iso: ['LS'], nameEn: "Lesotho" }, '+267': { iso: ['BW'], nameEn: "Botswana" }, '+268': { iso: ['SZ'], nameEn: "Eswatini" },
  '+269': { iso: ['KM'], nameEn: "Comoros" }, '+297': { iso: ['AW'], nameEn: "Aruba" }, '+298': { iso: ['FO'], nameEn: "Faroe Islands" },
  '+299': { iso: ['GL'], nameEn: "Greenland" }, '+350': { iso: ['GI'], nameEn: "Gibraltar" }, '+351': { iso: ['PT'], nameEn: "Portugal" },
  '+352': { iso: ['LU'], nameEn: "Luxembourg" }, '+353': { iso: ['IE'], nameEn: "Ireland" }, '+354': { iso: ['IS'], nameEn: "Iceland" },
  '+355': { iso: ['AL'], nameEn: "Albania" }, '+356': { iso: ['MT'], nameEn: "Malta" }, '+357': { iso: ['CY'], nameEn: "Cyprus" },
  '+358': { iso: ['FI'], nameEn: "Finland" }, '+359': { iso: ['BG'], nameEn: "Bulgaria" }, '+370': { iso: ['LT'], nameEn: "Lithuania" },
  '+371': { iso: ['LV'], nameEn: "Latvia" }, '+372': { iso: ['EE'], nameEn: "Estonia" }, '+373': { iso: ['MD'], nameEn: "Moldova" },
  '+374': { iso: ['AM'], nameEn: "Armenia" }, '+375': { iso: ['BY'], nameEn: "Belarus" }, '+376': { iso: ['AD'], nameEn: "Andorra" },
  '+377': { iso: ['MC'], nameEn: "Monaco" }, '+378': { iso: ['SM'], nameEn: "San Marino" }, '+380': { iso: ['UA'], nameEn: "Ukraine" },
  '+381': { iso: ['RS'], nameEn: "Serbia" }, '+382': { iso: ['ME'], nameEn: "Montenegro" }, '+383': { iso: ['XK'], nameEn: "Kosovo" },
  '+385': { iso: ['HR'], nameEn: "Croatia" }, '+386': { iso: ['SI'], nameEn: "Slovenia" }, '+387': { iso: ['BA'], nameEn: "Bosnia & Herzegovina" },
  '+389': { iso: ['MK'], nameEn: "North Macedonia" }, '+420': { iso: ['CZ'], nameEn: "Czechia" }, '+421': { iso: ['SK'], nameEn: "Slovakia" },
  '+423': { iso: ['LI'], nameEn: "Liechtenstein" }, '+500': { iso: ['FK'], nameEn: "Falkland Islands" }, '+501': { iso: ['BZ'], nameEn: "Belize" },
  '+502': { iso: ['GT'], nameEn: "Guatemala" }, '+503': { iso: ['SV'], nameEn: "El Salvador" }, '+504': { iso: ['HN'], nameEn: "Honduras" },
  '+505': { iso: ['NI'], nameEn: "Nicaragua" }, '+506': { iso: ['CR'], nameEn: "Costa Rica" }, '+507': { iso: ['PA'], nameEn: "Panama" },
  '+508': { iso: ['PM'], nameEn: "St. Pierre & Miquelon" }, '+509': { iso: ['HT'], nameEn: "Haiti" }, '+590': { iso: ['GP'], nameEn: "Guadeloupe" },
  '+591': { iso: ['BO'], nameEn: "Bolivia" }, '+592': { iso: ['GY'], nameEn: "Guyana" }, '+593': { iso: ['EC'], nameEn: "Ecuador" },
  '+594': { iso: ['GF'], nameEn: "French Guiana" }, '+595': { iso: ['PY'], nameEn: "Paraguay" }, '+596': { iso: ['MQ'], nameEn: "Martinique" },
  '+597': { iso: ['SR'], nameEn: "Suriname" }, '+598': { iso: ['UY'], nameEn: "Uruguay" },
  '+599': { iso: ['CW', 'BQ'], nameEn: "Curaçao / Caribbean Netherlands" }, '+670': { iso: ['TL'], nameEn: "Timor-Leste" },
  '+673': { iso: ['BN'], nameEn: "Brunei" }, '+674': { iso: ['NR'], nameEn: "Nauru" }, '+675': { iso: ['PG'], nameEn: "Papua New Guinea" },
  '+676': { iso: ['TO'], nameEn: "Tonga" }, '+677': { iso: ['SB'], nameEn: "Solomon Islands" }, '+678': { iso: ['VU'], nameEn: "Vanuatu" },
  '+679': { iso: ['FJ'], nameEn: "Fiji" }, '+681': { iso: ['WF'], nameEn: "Wallis & Futuna" }, '+682': { iso: ['CK'], nameEn: "Cook Islands" },
  '+685': { iso: ['WS'], nameEn: "Samoa" }, '+687': { iso: ['NC'], nameEn: "New Caledonia" }, '+689': { iso: ['PF'], nameEn: "French Polynesia" },
  '+850': { iso: ['KP'], nameEn: "North Korea" }, '+852': { iso: ['HK'], nameEn: "Hong Kong" }, '+853': { iso: ['MO'], nameEn: "Macao" },
  '+855': { iso: ['KH'], nameEn: "Cambodia" }, '+856': { iso: ['LA'], nameEn: "Laos" }, '+880': { iso: ['BD'], nameEn: "Bangladesh" },
  '+886': { iso: ['TW'], nameEn: "Taiwan" }, '+960': { iso: ['MV'], nameEn: "Maldives" }, '+961': { iso: ['LB'], nameEn: "Lebanon" },
  '+962': { iso: ['JO'], nameEn: "Jordan" }, '+963': { iso: ['SY'], nameEn: "Syria" }, '+964': { iso: ['IQ'], nameEn: "Iraq" },
  '+965': { iso: ['KW'], nameEn: "Kuwait" }, '+966': { iso: ['SA'], nameEn: "Saudi Arabia" }, '+967': { iso: ['YE'], nameEn: "Yemen" },
  '+968': { iso: ['OM'], nameEn: "Oman" }, '+970': { iso: ['PS'], nameEn: "Palestine" }, '+971': { iso: ['AE'], nameEn: "United Arab Emirates" },
  '+972': { iso: ['IL'], nameEn: "Israel" }, '+973': { iso: ['BH'], nameEn: "Bahrain" }, '+974': { iso: ['QA'], nameEn: "Qatar" },
  '+975': { iso: ['BT'], nameEn: "Bhutan" }, '+976': { iso: ['MN'], nameEn: "Mongolia" }, '+977': { iso: ['NP'], nameEn: "Nepal" },
  '+992': { iso: ['TJ'], nameEn: "Tajikistan" }, '+993': { iso: ['TM'], nameEn: "Turkmenistan" }, '+994': { iso: ['AZ'], nameEn: "Azerbaijan" },
  '+995': { iso: ['GE'], nameEn: "Georgia" }, '+996': { iso: ['KG'], nameEn: "Kyrgyzstan" }, '+998': { iso: ['UZ'], nameEn: "Uzbekistan" },
});

/** Indicatifs pays connus (UIT) : [indicatif, libellé]. Les pays du plan nord-américain partagent « +1 ». */
export const COUNTRY_CATALOG = Object.freeze([
  ['+1', 'États-Unis / Canada'], ['+7', 'Russie / Kazakhstan'], ['+20', 'Égypte'], ['+27', 'Afrique du Sud'],
  ['+30', 'Grèce'], ['+31', 'Pays-Bas'], ['+32', 'Belgique'], ['+33', 'France'], ['+34', 'Espagne'], ['+36', 'Hongrie'],
  ['+39', 'Italie'], ['+40', 'Roumanie'], ['+41', 'Suisse'], ['+43', 'Autriche'], ['+44', 'Royaume-Uni'], ['+45', 'Danemark'],
  ['+46', 'Suède'], ['+47', 'Norvège'], ['+48', 'Pologne'], ['+49', 'Allemagne'], ['+51', 'Pérou'], ['+52', 'Mexique'],
  ['+53', 'Cuba'], ['+54', 'Argentine'], ['+55', 'Brésil'], ['+56', 'Chili'], ['+57', 'Colombie'], ['+58', 'Venezuela'],
  ['+60', 'Malaisie'], ['+61', 'Australie'], ['+62', 'Indonésie'], ['+63', 'Philippines'], ['+64', 'Nouvelle-Zélande'],
  ['+65', 'Singapour'], ['+66', 'Thaïlande'], ['+81', 'Japon'], ['+82', 'Corée du Sud'], ['+84', 'Viêt Nam'], ['+86', 'Chine'],
  ['+90', 'Turquie'], ['+91', 'Inde'], ['+92', 'Pakistan'], ['+93', 'Afghanistan'], ['+94', 'Sri Lanka'], ['+95', 'Birmanie'],
  ['+98', 'Iran'], ['+211', 'Soudan du Sud'], ['+212', 'Maroc'], ['+213', 'Algérie'], ['+216', 'Tunisie'], ['+218', 'Libye'],
  ['+220', 'Gambie'], ['+221', 'Sénégal'], ['+222', 'Mauritanie'], ['+223', 'Mali'], ['+224', 'Guinée'], ['+225', 'Côte d’Ivoire'],
  ['+226', 'Burkina Faso'], ['+227', 'Niger'], ['+228', 'Togo'], ['+229', 'Bénin'], ['+230', 'Maurice'], ['+231', 'Libéria'],
  ['+232', 'Sierra Leone'], ['+233', 'Ghana'], ['+234', 'Nigéria'], ['+235', 'Tchad'], ['+236', 'Centrafrique'], ['+237', 'Cameroun'],
  ['+238', 'Cap-Vert'], ['+239', 'Sao Tomé-et-Principe'], ['+240', 'Guinée équatoriale'], ['+241', 'Gabon'], ['+242', 'Congo'],
  ['+243', 'RD Congo'], ['+244', 'Angola'], ['+245', 'Guinée-Bissau'], ['+248', 'Seychelles'], ['+249', 'Soudan'], ['+250', 'Rwanda'],
  ['+251', 'Éthiopie'], ['+252', 'Somalie'], ['+253', 'Djibouti'], ['+254', 'Kenya'], ['+255', 'Tanzanie'], ['+256', 'Ouganda'],
  ['+257', 'Burundi'], ['+258', 'Mozambique'], ['+260', 'Zambie'], ['+261', 'Madagascar'], ['+262', 'La Réunion / Mayotte'],
  ['+263', 'Zimbabwe'], ['+264', 'Namibie'], ['+265', 'Malawi'], ['+266', 'Lesotho'], ['+267', 'Botswana'], ['+268', 'Eswatini'],
  ['+269', 'Comores'], ['+297', 'Aruba'], ['+298', 'Îles Féroé'], ['+299', 'Groenland'], ['+350', 'Gibraltar'], ['+351', 'Portugal'],
  ['+352', 'Luxembourg'], ['+353', 'Irlande'], ['+354', 'Islande'], ['+355', 'Albanie'], ['+356', 'Malte'], ['+357', 'Chypre'],
  ['+358', 'Finlande'], ['+359', 'Bulgarie'], ['+370', 'Lituanie'], ['+371', 'Lettonie'], ['+372', 'Estonie'], ['+373', 'Moldavie'],
  ['+374', 'Arménie'], ['+375', 'Biélorussie'], ['+376', 'Andorre'], ['+377', 'Monaco'], ['+378', 'Saint-Marin'], ['+380', 'Ukraine'],
  ['+381', 'Serbie'], ['+382', 'Monténégro'], ['+383', 'Kosovo'], ['+385', 'Croatie'], ['+386', 'Slovénie'], ['+387', 'Bosnie-Herzégovine'],
  ['+389', 'Macédoine du Nord'], ['+420', 'Tchéquie'], ['+421', 'Slovaquie'], ['+423', 'Liechtenstein'], ['+500', 'Îles Malouines'],
  ['+501', 'Belize'], ['+502', 'Guatemala'], ['+503', 'Salvador'], ['+504', 'Honduras'], ['+505', 'Nicaragua'], ['+506', 'Costa Rica'],
  ['+507', 'Panama'], ['+508', 'Saint-Pierre-et-Miquelon'], ['+509', 'Haïti'], ['+590', 'Guadeloupe'], ['+591', 'Bolivie'],
  ['+592', 'Guyana'], ['+593', 'Équateur'], ['+594', 'Guyane'], ['+595', 'Paraguay'], ['+596', 'Martinique'], ['+597', 'Suriname'],
  ['+598', 'Uruguay'], ['+599', 'Curaçao / Antilles néerlandaises'], ['+670', 'Timor oriental'], ['+673', 'Brunéi'], ['+674', 'Nauru'],
  ['+675', 'Papouasie-Nouvelle-Guinée'], ['+676', 'Tonga'], ['+677', 'Îles Salomon'], ['+678', 'Vanuatu'], ['+679', 'Fidji'],
  ['+681', 'Wallis-et-Futuna'], ['+682', 'Îles Cook'], ['+685', 'Samoa'], ['+687', 'Nouvelle-Calédonie'], ['+689', 'Polynésie française'],
  ['+850', 'Corée du Nord'], ['+852', 'Hong Kong'], ['+853', 'Macao'], ['+855', 'Cambodge'], ['+856', 'Laos'], ['+880', 'Bangladesh'],
  ['+886', 'Taïwan'], ['+960', 'Maldives'], ['+961', 'Liban'], ['+962', 'Jordanie'], ['+963', 'Syrie'], ['+964', 'Irak'], ['+965', 'Koweït'],
  ['+966', 'Arabie saoudite'], ['+967', 'Yémen'], ['+968', 'Oman'], ['+970', 'Palestine'], ['+971', 'Émirats arabes unis'],
  ['+972', 'Israël'], ['+973', 'Bahreïn'], ['+974', 'Qatar'], ['+975', 'Bhoutan'], ['+976', 'Mongolie'], ['+977', 'Népal'],
  ['+992', 'Tadjikistan'], ['+993', 'Turkménistan'], ['+994', 'Azerbaïdjan'], ['+995', 'Géorgie'], ['+996', 'Kirghizistan'], ['+998', 'Ouzbékistan'],
].map(([prefix, name]) => Object.freeze({ prefix, name, ...COUNTRY_LABELS_EN[prefix] })));

const KNOWN = new Set(COUNTRY_CATALOG.map((c) => c.prefix));

/**
 * Plages surtaxées ou à valeur ajoutée, refusées pour toutes les entreprises, quel que soit leur réglage.
 * Préfixes E.164 complets (indicatif pays compris).
 */
export const PREMIUM_RATE_PREFIXES = Object.freeze([
  // France : 08 9x (surtaxés), 3x xx (numéros courts à tarif spécial), 08 1x / 08 2x (à valeur ajoutée)
  '+3389', '+3336', '+3381', '+3382',
  // Belgique, Suisse, Pays-Bas, Autriche, Allemagne, Royaume-Uni, Irlande, Espagne, Italie, Portugal
  '+3290', '+3270', '+4190', '+31900', '+31909', '+43900', '+43930', '+43939', '+49900', '+49137', '+49118', '+449', '+4470', '+35315', '+3531550', '+34803', '+34806', '+34807', '+34905', '+3989', '+35176', '+351707',
  // Amérique du Nord : numéros payants, et indicatifs des Caraïbes à l'origine des fraudes « un seul appel »
  '+1900', '+1976', '+1242', '+1246', '+1264', '+1268', '+1284', '+1345', '+1441', '+1473', '+1649', '+1664', '+1721', '+1758', '+1767', '+1784', '+1809', '+1829', '+1849', '+1868', '+1869', '+1876',
  // Numéros internationaux à tarif premium et réseaux mobiles / satellites internationaux
  '+979', '+870', '+871', '+872', '+873', '+874', '+881', '+882', '+883', '+888', '+878', '+808',
]);

/** Numéro E.164 strict (« + », un indicatif ne commençant pas par 0, 8 à 15 chiffres), ou '' sinon. */
export function toStrictE164(raw) {
  const to = normalizeDestination(raw);
  return /^\+[1-9]\d{7,14}$/.test(to) ? to : '';
}

/** Indicatif pays connu de ce numéro E.164 (le plus long d'abord), ou ''. */
export function countryPrefixOf(e164) {
  for (const len of [4, 3, 2]) {
    const candidate = String(e164).slice(0, len);
    if (KNOWN.has(candidate)) return candidate;
  }
  return '';
}

/**
 * Indicatifs régionaux (NANP, « +1 ») qui ne sont NI américains NI canadiens : territoires et pays des Caraïbes.
 * Sans cette distinction, tout « +1 » serait attribué aux États-Unis.
 */
const NANP_OTHER = Object.freeze({
  242: 'BS', 246: 'BB', 264: 'AI', 268: 'AG', 284: 'VG', 340: 'VI', 345: 'KY', 441: 'BM', 473: 'GD', 649: 'TC', 664: 'MS',
  670: 'MP', 671: 'GU', 684: 'AS', 721: 'SX', 758: 'LC', 767: 'DM', 784: 'VC', 787: 'PR', 809: 'DO', 829: 'DO', 849: 'DO',
  868: 'TT', 869: 'KN', 876: 'JM', 939: 'PR',
});
/** Indicatifs régionaux canadiens (source : Wikipédia, « Telephone numbers in Canada », plan de numérotation par province ; 600 : non géographique canadien). */
const CANADA_AREA_CODES = new Set([
  403, 780, 368, 587, 825, 604, 250, 236, 672, 778, 257, 204, 431, 584, 506, 428, 709, 879, 902, 782,
  416, 613, 519, 705, 807, 905, 226, 249, 289, 343, 382, 365, 437, 548, 647, 683, 742, 753, 942,
  418, 514, 450, 819, 263, 354, 367, 438, 468, 579, 581, 873, 306, 474, 639, 867, 600,
]);

/** Pays le plus probable pour un indicatif partagé (« +1 », « +7 », « +262 », « +599 ») d'après le numéro national ; null si indéterminé. */
function sharedPrefixCountry(prefix, national) {
  if (prefix === '+1') {
    const area = Number(national.slice(0, 3));
    if (national.length < 3) return null;
    if (CANADA_AREA_CODES.has(area)) return 'CA';
    return NANP_OTHER[area] || 'US';
  }
  if (prefix === '+7') return national[0] === '6' || national[0] === '7' ? 'KZ' : 'RU';
  if (prefix === '+262') return national.startsWith('269') || national.startsWith('639') ? 'YT' : 'RE';
  if (prefix === '+599') return national[0] === '9' ? 'CW' : ['3', '4', '7'].includes(national[0]) ? 'BQ' : null;
  return null;
}

/**
 * Indicatif numérique et pays (ISO 3166-1 alpha-2) d'un numéro de ligne E.164 (« + » facultatif), d'après la table des indicatifs.
 * Indicatif partagé : pays le plus probable d'après le numéro national, sinon null. Numéro invalide, national (sans indicatif) ou indicatif inconnu :
 * { callingCode: null, countryIso: null }. Un numéro n'est jamais « deviné » français.
 * @returns {{callingCode: number|null, countryIso: string|null}}
 */
export function callingInfoOf(raw) {
  const none = { callingCode: null, countryIso: null };
  const s = String(raw ?? '').trim().replace(/[\s().-]/g, '');
  const e164 = /^\+[1-9]\d{7,14}$/.test(s) ? s : /^[1-9]\d{7,14}$/.test(s) ? `+${s}` : '';
  if (!e164) return none;
  const prefix = countryPrefixOf(e164);
  if (!prefix) return none;
  const isos = COUNTRY_LABELS_EN[prefix]?.iso || [];
  const countryIso = isos.length === 1 ? isos[0] : isos.length > 1 ? sharedPrefixCountry(prefix, e164.slice(prefix.length)) : null;
  return { callingCode: Number(prefix.slice(1)), countryIso: countryIso || null };
}

export const isPremiumRate = (e164) => PREMIUM_RATE_PREFIXES.some((p) => String(e164).startsWith(p));

/** Indicatifs proposés dans les réglages : seulement les pays connus, sans doublon, ordre du catalogue. */
export function validatePrefixList(list) {
  if (!Array.isArray(list)) return { ok: false, code: 'LIST_NOT_ARRAY', error: 'La liste des pays autorisés doit être un tableau.' };
  const clean = [...new Set(list.map((p) => String(p ?? '').trim()))];
  const unknown = clean.find((p) => !KNOWN.has(p));
  if (unknown !== undefined) return { ok: false, code: 'UNKNOWN_COUNTRY_PREFIX', params: { prefix: unknown }, error: `Indicatif de pays inconnu : « ${unknown} ».` };
  return { ok: true, value: COUNTRY_CATALOG.map((c) => c.prefix).filter((p) => clean.includes(p)) };
}

/**
 * Pays autorisés pour une entreprise : sa sélection enregistrée si elle en a une ; sinon son propre pays
 * (déduit de ses lignes) et la liste globale de l'environnement (OUTBOUND_ALLOWED_PREFIXES, +33 sans réglage).
 * @returns {{prefixes: string[], customized: boolean}}
 */
export function effectiveOutboundPrefixes({ saved, companyCountry = '', envPrefixes = ['+33'] }) {
  if (Array.isArray(saved)) {
    const checked = validatePrefixList(saved);
    return { prefixes: checked.ok ? checked.value : [], customized: true };
  }
  const defaults = [...new Set([companyCountry, ...envPrefixes].filter((p) => KNOWN.has(p)))];
  return { prefixes: defaults, customized: false };
}

/**
 * Décision serveur sur une destination.
 * @returns {{ok: true, to: string} | {ok: false, code: string, reason: string, message: string}}
 */
export function checkDestination(raw, allowedPrefixes) {
  const to = toStrictE164(raw);
  if (!to) return { ok: false, code: INVALID_NUMBER, reason: 'invalid_number', message: MESSAGES.invalid_number };
  if (isPremiumRate(to)) return { ok: false, code: DESTINATION_NOT_ALLOWED, reason: 'premium_rate', message: MESSAGES.premium_rate };
  const country = countryPrefixOf(to);
  if (!country) return { ok: false, code: DESTINATION_NOT_ALLOWED, reason: 'unknown_country', message: MESSAGES.unknown_country };
  if (!allowedPrefixes.includes(country)) return { ok: false, code: DESTINATION_NOT_ALLOWED, reason: 'country_not_enabled', message: MESSAGES.country_not_enabled };
  return { ok: true, to };
}
