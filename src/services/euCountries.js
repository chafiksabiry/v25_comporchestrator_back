/**
 * Pays de l'Union européenne (27), codes ISO 3166-1 alpha-2. Constante de code (pas un prix). Le Royaume-Uni (sorti de l'UE),
 * la Suisse, la Norvège, l'Islande, le Liechtenstein et les États-Unis n'en font pas partie.
 */
export const EU_COUNTRY_CODES = Object.freeze([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT',
  'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

const EU = new Set(EU_COUNTRY_CODES);

/** Ce code ISO est-il celui d'un pays de l'UE ? (casse indifférente) */
export const isEuCountry = (iso) => EU.has(String(iso ?? '').trim().toUpperCase());
