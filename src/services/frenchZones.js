/**
 * Zones des numéros géographiques français (plan de numérotation ARCEP) : le premier chiffre après le 0 dit la zone.
 *   1 Île-de-France · 2 Nord-Ouest · 3 Nord-Est · 4 Sud-Est · 5 Sud-Ouest
 * Une ville (ou un département, ou un code postal) saisie pour chercher un numéro donne sa zone ; la recherche Twilio se fait
 * alors par préfixe (« +334 » pour le Sud-Est), car Twilio renseigne rarement la localité des numéros français.
 * Aucune correspondance : null (le comportement de recherche reste celui d'avant).
 */

const ZONES = {
  1: ['75', '77', '78', '91', '92', '93', '94', '95'],
  // Bretagne, Normandie, Pays de la Loire, Centre-Val de Loire
  2: ['14', '18', '22', '27', '28', '29', '35', '36', '37', '41', '44', '45', '49', '50', '53', '56', '61', '72', '76', '85'],
  // Hauts-de-France, Grand Est, Bourgogne-Franche-Comté
  3: ['02', '08', '10', '21', '25', '39', '51', '52', '54', '55', '57', '58', '59', '60', '62', '67', '68', '70', '71', '80', '88', '89', '90'],
  // Auvergne-Rhône-Alpes, Provence-Alpes-Côte d'Azur, Corse, ex-Languedoc-Roussillon
  4: ['01', '03', '04', '05', '06', '07', '11', '13', '15', '26', '2A', '2B', '30', '34', '38', '42', '43', '48', '63', '66', '69', '73', '74', '83', '84'],
  // Nouvelle-Aquitaine, ex-Midi-Pyrénées
  5: ['09', '12', '16', '17', '19', '23', '24', '31', '32', '33', '40', '46', '47', '64', '65', '79', '81', '82', '86', '87'],
};

export const DEPARTMENT_ZONE = Object.freeze(
  Object.fromEntries(Object.entries(ZONES).flatMap(([zone, deps]) => deps.map((d) => [d, zone])))
);

/** Grandes villes et préfectures → département. Les noms sont comparés sans accents, tirets ni apostrophes. */
const CITY_DEPARTMENT = {
  // Île-de-France
  paris: '75', 'boulogne billancourt': '92', nanterre: '92', courbevoie: '92', 'neuilly sur seine': '92', 'la defense': '92', 'rueil malmaison': '92',
  colombes: '92', 'issy les moulineaux': '92', 'levallois perret': '92', antony: '92', 'saint denis': '93', montreuil: '93', bobigny: '93', aubervilliers: '93',
  creteil: '94', vitry: '94', 'vitry sur seine': '94', vincennes: '94', 'ivry sur seine': '94', orly: '94', versailles: '78', 'saint germain en laye': '78',
  evry: '91', 'evry courcouronnes': '91', massy: '91', argenteuil: '95', cergy: '95', pontoise: '95', melun: '77', meaux: '77', 'marne la vallee': '77',
  // Nord-Ouest
  nantes: '44', 'saint nazaire': '44', rennes: '35', 'saint malo': '35', brest: '29', quimper: '29', lorient: '56', vannes: '56', 'saint brieuc': '22', lannion: '22',
  caen: '14', rouen: '76', 'le havre': '76', dieppe: '76', cherbourg: '50', 'cherbourg en cotentin': '50', 'saint lo': '50', evreux: '27', alencon: '61',
  angers: '49', cholet: '49', 'le mans': '72', laval: '53', 'la roche sur yon': '85', tours: '37', orleans: '45', blois: '41', chartres: '28', bourges: '18',
  chateauroux: '36', vierzon: '18',
  // Nord-Est
  lille: '59', roubaix: '59', tourcoing: '59', dunkerque: '59', valenciennes: '59', douai: '59', arras: '62', calais: '62', 'boulogne sur mer': '62', lens: '62',
  amiens: '80', beauvais: '60', compiegne: '60', 'saint quentin': '02', soissons: '02', laon: '02', reims: '51', 'chalons en champagne': '51', troyes: '10',
  'charleville mezieres': '08', chaumont: '52', strasbourg: '67', haguenau: '67', colmar: '68', mulhouse: '68', metz: '57', thionville: '57', nancy: '54',
  epinal: '88', 'bar le duc': '55', verdun: '55', dijon: '21', besancon: '25', belfort: '90', vesoul: '70', 'lons le saunier': '39', auxerre: '89', nevers: '58',
  macon: '71', 'chalon sur saone': '71',
  // Sud-Est
  marseille: '13', 'aix en provence': '13', arles: '13', martigues: '13', aubagne: '13', lyon: '69', villeurbanne: '69', 'venissieux': '69', nice: '06', cannes: '06',
  antibes: '06', grasse: '06', toulon: '83', 'frejus': '83', hyeres: '83', avignon: '84', montpellier: '34', beziers: '34', sete: '34', nimes: '30', ales: '30',
  perpignan: '66', narbonne: '11', carcassonne: '11', mende: '48', grenoble: '38', vienne: '38', 'saint etienne': '42', roanne: '42', 'clermont ferrand': '63',
  vichy: '03', montlucon: '03', moulins: '03', 'le puy en velay': '43', aurillac: '15', valence: '26', privas: '07', annecy: '74', annemasse: '74', 'thonon les bains': '74',
  chambery: '73', 'bourg en bresse': '01', gap: '05', 'digne les bains': '04', ajaccio: '2A', bastia: '2B',
  // Sud-Ouest
  toulouse: '31', bordeaux: '33', merignac: '33', pessac: '33', limoges: '87', poitiers: '86', 'la rochelle': '17', niort: '79', angouleme: '16', pau: '64',
  bayonne: '64', biarritz: '64', 'mont de marsan': '40', dax: '40', agen: '47', perigueux: '24', bergerac: '24', brive: '19', 'brive la gaillarde': '19', tulle: '19',
  gueret: '23', montauban: '82', albi: '81', castres: '81', rodez: '12', cahors: '46', auch: '32', tarbes: '65', lourdes: '65', foix: '09',
};

/** Minuscules, sans accents, tirets ni apostrophes ; « St » → « saint ». */
export function normalizePlace(value) {
  return String(value ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[-'’_.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(ste?)\s/, (m, p) => (p === 'st' ? 'saint ' : 'sainte '))
    .replace(/\s(ste?)\s/g, (m, p) => (p === 'st' ? ' saint ' : ' sainte '));
}

/** Département d'un code postal français (« 34000 » → « 34 », « 20000 » → « 2A », « 20200 » → « 2B ») ; null hors métropole ou illisible. */
export function departmentFromPostalCode(postalCode) {
  const m = String(postalCode ?? '').trim().match(/^(\d{5})$/);
  if (!m) return null;
  const code = m[1];
  if (code.startsWith('97') || code.startsWith('98') || code.startsWith('00')) return null;
  if (code.startsWith('20')) return Number(code) < 20200 ? '2A' : '2B';
  return code.slice(0, 2);
}

/** Département saisi tel quel (« 34 », « 2a », « 06 », « 6 »). */
function departmentFromText(text) {
  const t = text.toUpperCase();
  if (/^2[AB]$/.test(t)) return t;
  if (/^\d{1,2}$/.test(t)) return t.padStart(2, '0');
  return null;
}

/**
 * Zone (« 1 » … « 5 ») d'une ville, d'un département ou d'un code postal saisi ; à défaut, celle du code postal de l'adresse.
 * null si rien ne correspond.
 */
export function frenchZoneFor(locality, { postalCode } = {}) {
  const raw = String(locality ?? '').trim();
  if (raw) {
    const postal = raw.match(/\b(\d{5})\b/);
    if (postal) {
      const zone = DEPARTMENT_ZONE[departmentFromPostalCode(postal[1])];
      if (zone) return zone;
    }
    const dep = departmentFromText(raw);
    if (dep) return DEPARTMENT_ZONE[dep] || null;
    const name = normalizePlace(raw.replace(/\b\d{5}\b/g, '')).replace(/\s+\d{1,2}\s*(er|e|eme)?(\s+arrondissement)?$/, '').replace(/\s+cedex.*$/, '').trim();
    const cityDep = CITY_DEPARTMENT[name];
    if (cityDep) return DEPARTMENT_ZONE[cityDep];
  }
  const fromAddress = DEPARTMENT_ZONE[departmentFromPostalCode(postalCode)];
  return fromAddress || null;
}

/** Préfixe E.164 d'une zone (« 4 » → « +334 »), forme utilisée par le paramètre `contains` de Twilio pour un début de numéro. */
export function frenchZonePrefix(zone) {
  return /^[1-5]$/.test(String(zone)) ? `+33${zone}` : null;
}

/** Zone d'un numéro français géographique (« +33467… » → « 4 ») ; null sinon. */
export function zoneOfFrenchNumber(phoneNumber) {
  const m = String(phoneNumber ?? '').replace(/[^\d+]/g, '').match(/^\+33([1-5])\d{8}$/);
  return m ? m[1] : null;
}
