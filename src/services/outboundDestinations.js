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
].map(([prefix, name]) => Object.freeze({ prefix, name })));

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

export const isPremiumRate = (e164) => PREMIUM_RATE_PREFIXES.some((p) => String(e164).startsWith(p));

/** Indicatifs proposés dans les réglages : seulement les pays connus, sans doublon, ordre du catalogue. */
export function validatePrefixList(list) {
  if (!Array.isArray(list)) return { ok: false, error: 'La liste des pays autorisés doit être un tableau.' };
  const clean = [...new Set(list.map((p) => String(p ?? '').trim()))];
  const unknown = clean.find((p) => !KNOWN.has(p));
  if (unknown !== undefined) return { ok: false, error: `Indicatif de pays inconnu : « ${unknown} ».` };
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
