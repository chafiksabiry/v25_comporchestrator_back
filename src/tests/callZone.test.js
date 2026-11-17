// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/callZone.test.js
// Zone d'un appel (domestique / international) : pays de l'entreprise, extension aux 27 pays de l'UE pour une entreprise de l'UE, régions
// françaises d'outre-mer domestiques, +1, entreprise sans ligne = zone inconnue. Logique pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
const EU = await import('../services/euCountries.js');
const Z = await import('../services/callZone.js');
const FR = '+33612345678'; const DE = '+4915112345678'; const GB = '+442071234567'; const US = '+14155550123'; const NO = '+4791234567'; const CH = '+41791234567'; const MA = '+212612345678';

test('liste UE : 27 pays (codes ISO), Royaume-Uni, Suisse, Norvège, États-Unis absents', () => {
  assert.equal(EU.EU_COUNTRY_CODES.length, 27);
  assert.equal(new Set(EU.EU_COUNTRY_CODES).size, 27);
  for (const iso of ['FR', 'DE', 'ES', 'IT', 'NL', 'BE', 'PT', 'IE', 'PL', 'SE', 'DK', 'FI', 'AT', 'GR', 'CZ', 'SK', 'SI', 'HR', 'HU', 'RO', 'BG', 'CY', 'MT', 'LU', 'LV', 'LT', 'EE']) assert.ok(EU.isEuCountry(iso), iso);
  for (const iso of ['GB', 'UK', 'CH', 'NO', 'US', 'IS', 'LI', 'MA', 'TR', 'UA', 'CA']) assert.equal(EU.isEuCountry(iso), false, iso);
  assert.ok(EU.EU_COUNTRY_CODES.every((c) => /^[A-Z]{2}$/.test(c)));
  assert.equal(EU.isEuCountry('fr'), true, 'casse tolérée');
  assert.equal(EU.isEuCountry(''), false);
});


test('classification : France→France et France→Allemagne = domestique ; France→Royaume-Uni et États-Unis→France = international', () => {
  assert.equal(Z.classifyZone({ to: FR, companyCountry: '+33' }).zone, 'domestic');
  assert.equal(Z.classifyZone({ to: DE, companyCountry: '+33' }).zone, 'domestic');
  assert.equal(Z.classifyZone({ to: GB, companyCountry: '+33' }).zone, 'international');
  assert.equal(Z.classifyZone({ to: FR, companyCountry: '+1' }).zone, 'international');
  assert.equal(Z.classifyZone({ to: US, companyCountry: '+1' }).zone, 'domestic');
});

test('classification : hors UE (Suisse, Norvège, Maroc) = international ; entreprise hors UE appelant l\'UE = international', () => {
  for (const to of [NO, CH, MA, GB, US]) assert.equal(Z.classifyZone({ to, companyCountry: '+33' }).zone, 'international', to);
  assert.equal(Z.classifyZone({ to: FR, companyCountry: '+44' }).zone, 'international', 'Royaume-Uni → France');
  assert.equal(Z.classifyZone({ to: DE, companyCountry: '+41' }).zone, 'international', 'Suisse → Allemagne');
  assert.equal(Z.classifyZone({ to: DE, companyCountry: '+49' }).zone, 'domestic');
  assert.equal(Z.classifyZone({ to: FR, companyCountry: '+49' }).zone, 'domestic', 'Allemagne → France : UE');
  assert.equal(Z.classifyZone({ to: GB, companyCountry: '+44' }).zone, 'domestic', 'même pays, hors UE');
  assert.equal(Z.classifyZone({ to: NO, companyCountry: '+47' }).zone, 'domestic');
});

test('classification : indicateur euZone, pays de l\'entreprise INCONNU => zone inconnue (jamais supposée UE), destination illisible => domestique', () => {
  assert.equal(Z.classifyZone({ to: FR, companyCountry: '+33' }).euZone, true);
  assert.equal(Z.classifyZone({ to: FR, companyCountry: '+44' }).euZone, false);
  assert.deepEqual(Z.classifyZone({ to: GB, companyCountry: '' }), { zone: 'unknown', euZone: null });
  assert.deepEqual(Z.classifyZone({ to: DE }), { zone: 'unknown', euZone: null });
  assert.equal(Z.classifyZone({ to: '', companyCountry: '+33' }).zone, 'domestic');
  assert.equal(Z.classifyZone({ to: '0033612345678', companyCountry: '+33' }).zone, 'domestic');
});

test('DOM-TOM (régions de l\'UE) : +262, +590, +594, +596 domestiques pour une entreprise française, et pour toute entreprise de l\'UE', () => {
  for (const to of ['+262692123456', '+590690123456', '+594694123456', '+596696123456']) {
    assert.equal(Z.classifyZone({ to, companyCountry: '+33' }).zone, 'domestic', `FR → ${to}`);
    assert.equal(Z.classifyZone({ to, companyCountry: '+49' }).zone, 'domestic', `DE → ${to}`);
    assert.equal(Z.classifyZone({ to, companyCountry: '+44' }).zone, 'international', `GB → ${to}`);
    assert.equal(Z.classifyZone({ to, companyCountry: '+1' }).zone, 'international', `US → ${to}`);
  }
  // une entreprise dont la ligne est un numéro DOM-TOM est française (UE)
  for (const home of ['+262', '+590', '+594', '+596']) {
    assert.deepEqual(Z.classifyZone({ to: FR, companyCountry: home }), { zone: 'domestic', euZone: true }, home);
    assert.equal(Z.classifyZone({ to: DE, companyCountry: home }).zone, 'domestic');
    assert.equal(Z.classifyZone({ to: GB, companyCountry: home }).zone, 'international');
  }
  // collectivités d'outre-mer hors UE : internationales
  for (const to of ['+687123456', '+689123456', '+681123456'].map((n) => n.padEnd(12, '0'))) assert.equal(Z.classifyZone({ to, companyCountry: '+33' }).zone, 'international', to);
});

test('+1 : États-Unis et Canada domestiques entre eux (un seul indicatif), limite connue', () => {
  assert.equal(Z.classifyZone({ to: '+14165550123', companyCountry: '+1' }).zone, 'domestic');
  assert.equal(Z.classifyZone({ to: '+14155550123', companyCountry: '+1' }).zone, 'domestic');
});


// --- Revue : territoires distingués par pays (callingInfoOf), numéro de ligne complet --------------------------------------------
const US_LINE = '+14155550123'; const CA_LINE = '+14165550123'; const JM = '+18765550123'; const BS = '+12425550123'; const PR = '+17875550123'; const DO = '+18095550123'; const TT = '+18685550123';
test('NANP : États-Unis et Canada seulement domestiques entre eux ; Jamaïque, Bahamas, Porto Rico, Rép. dominicaine, Trinité-et-Tobago internationaux pour une entreprise +1', () => {
  assert.equal(Z.classifyZone({ to: CA_LINE, companyCountry: US_LINE }).zone, 'domestic', 'US → CA');
  assert.equal(Z.classifyZone({ to: US_LINE, companyCountry: CA_LINE }).zone, 'domestic', 'CA → US');
  assert.equal(Z.classifyZone({ to: '+12125550123', companyCountry: US_LINE }).zone, 'domestic', 'US → US');
  for (const to of [JM, BS, PR, DO, TT]) {
    assert.equal(Z.classifyZone({ to, companyCountry: US_LINE }).zone, 'international', `US → ${to}`);
    assert.equal(Z.classifyZone({ to, companyCountry: CA_LINE }).zone, 'international', `CA → ${to}`);
  }
  assert.equal(Z.classifyZone({ to: US_LINE, companyCountry: JM }).zone, 'international', 'Jamaïque → États-Unis');
  assert.equal(Z.classifyZone({ to: JM, companyCountry: '+18765550999' }).zone, 'domestic', 'Jamaïque → Jamaïque');
  assert.equal(Z.classifyZone({ to: FR, companyCountry: US_LINE }).zone, 'international');
});

test('+7 et +44 : pays distingués quand le numéro le permet', () => {
  assert.equal(Z.classifyZone({ to: '+77012345678', companyCountry: '+79123456789' }).zone, 'international', 'Russie → Kazakhstan');
  assert.equal(Z.classifyZone({ to: '+79123456780', companyCountry: '+79123456789' }).zone, 'domestic', 'Russie → Russie');
  assert.equal(Z.classifyZone({ to: '+447911123456', companyCountry: '+442071234567' }).zone, 'domestic', 'Royaume-Uni (+44 indivisible)');
});

test('+262 : La Réunion et Mayotte restent la France (domestiques pour l\'UE) ; destination sans pays identifiable => domestique par prudence + avertissement', () => {
  assert.equal(Z.classifyZone({ to: '+262692123456', companyCountry: '+33612345678' }).zone, 'domestic');
  assert.equal(Z.classifyZone({ to: '+262639123456', companyCountry: '+33612345678' }).zone, 'domestic');
  const w = []; const orig = console.warn; console.warn = (...a) => w.push(a.join(' '));
  try {
    assert.equal(Z.classifyZone({ to: '+999123456789', companyCountry: '+33612345678' }).zone, 'domestic');
    assert.ok(w.some((x) => /sans pays identifiable|non identifiable/.test(x)));
    w.length = 0;
    assert.equal(Z.classifyZone({ to: '+14005550123', companyCountry: '+1' }).zone, 'domestic', 'préfixe seul : même indicatif, pays non identifiable');
  } finally { console.warn = orig; }
});

test('l\'entreprise peut être donnée par un indicatif seul ou par un numéro de ligne complet', () => {
  assert.equal(Z.classifyZone({ to: DE, companyCountry: '+33' }).euZone, true);
  assert.equal(Z.classifyZone({ to: DE, companyCountry: '+33612345678' }).euZone, true);
  assert.equal(Z.classifyZone({ to: DE, companyCountry: US_LINE }).euZone, false);
});
