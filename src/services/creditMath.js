/**
 * Arithmétique des crédits minute, AU CENTIÈME DE MINUTE, sans perte.
 *
 * Le solde (`MinutesCompany.minutes`) reste exprimé en minutes locales (nombre), mais peut désormais porter des centièmes depuis que le
 * coefficient international est décimal (ex. 4,2 : 2 minutes internationales = 8,40 minutes locales débitées). Pour qu'aucune dérive de
 * virgule flottante ne s'accumule (91,6 − 8,4 ≠ 83,2 en double), TOUT calcul de crédit passe par des entiers de centièmes
 * (`toHundredths`) puis revient en minutes arrondies au centième. Le débit écrit le nouveau solde calculé ainsi (`$set` sous garde du
 * solde lu) au lieu d'un `$inc` flottant. Un solde historique entier reste entier tant que le coefficient est entier.
 *
 * Module sans dépendance (utilisé par browserOutbound.js, creditCoefficient.js et minutesGrace.js sans import circulaire).
 */

/** Minutes (ou crédits) → entier de centièmes. */
export const toHundredths = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

/** Arrondi au centième de minute. */
export const roundCredits = (value) => toHundredths(value) / 100;

/** Coefficient utilisable (>= 1, au centième) ; toute autre valeur : 1. */
export const normalizeFactor = (factor) => {
  const f = roundCredits(factor);
  return f > 1 ? f : 1;
};

/** Crédits d'un nombre ENTIER de minutes facturées à `factor` crédits la minute (2 min × 4,2 = 8,4), au centième, sans perte. */
export const creditsForMinutes = (minutes, factor = 1) => {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  return (m * toHundredths(normalizeFactor(factor))) / 100;
};

/** Crédits d'une durée en secondes : minute entamée arrondie à la minute supérieure, PUIS × facteur. */
export const creditsForSeconds = (seconds, factor = 1) => creditsForMinutes(Math.ceil(Math.max(0, Number(seconds) || 0) / 60), factor);

/** Minutes ENTIÈRES qu'un solde couvre à `factor` crédits la minute (8,4 à 4,2 → 2 ; 8,39 → 1). Solde nul ou négatif : 0. */
export const affordableMinutes = (balance, factor = 1) => {
  const b = toHundredths(balance);
  if (b <= 0) return 0;
  return Math.floor(b / toHundredths(normalizeFactor(factor)));
};

/** a − b au centième, sans dérive. */
export const subtractCredits = (a, b) => (toHundredths(a) - toHundredths(b)) / 100;

/** a + b au centième, sans dérive. */
export const addCredits = (a, b) => (toHundredths(a) + toHundredths(b)) / 100;

/** Affichage d'un nombre de crédits : « 4 », « 4,2 » (fr, es, ar…), « 4.2 » (en). Jamais de « 4.200000001 ». */
export const formatCredits = (value, lang = 'fr') => {
  const text = String(roundCredits(value));
  return String(lang || '').toLowerCase().startsWith('en') ? text : text.replace('.', ',');
};
