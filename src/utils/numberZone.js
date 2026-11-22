/**
 * Zones d'indicatif partagé : plusieurs pays derrière le même indicatif international, dont les numéros sont interchangeables pour
 * HARX (décision du fondateur, 22/11 : « ajouter tous les numéros qui tombent sous l'indicatif US (+1) »). Un abonné d'un pays de
 * la zone peut prendre n'importe quel numéro libre de la zone, et la disponibilité d'un pays de la zone tient compte de toute la zone.
 * Aujourd'hui : +1 = États-Unis et Canada. Les autres pays ne sont dans aucune zone (règle inchangée : leur propre pays seulement).
 */
const ZONES = Object.freeze([Object.freeze(['US', 'CA'])]);

function iso(code) {
  const c = String(code ?? '').trim().toUpperCase();
  return c === 'UK' ? 'GB' : c;
}

/** Pays de la même zone d'indicatif que `code`, lui en premier ; `[code]` seul hors zone ; `[]` si vide. */
export function numberZonePeers(code) {
  const c = iso(code);
  if (!/^[A-Z]{2}$/.test(c)) return [];
  const zone = ZONES.find((z) => z.includes(c));
  return zone ? [c, ...zone.filter((x) => x !== c)] : [c];
}

/** Deux pays dont les numéros sont interchangeables : le même pays, ou deux pays de la même zone d'indicatif (US/CA). */
export function sameNumberZone(a, b) {
  const x = iso(a);
  const y = iso(b);
  if (!/^[A-Z]{2}$/.test(x) || !/^[A-Z]{2}$/.test(y)) return false;
  return numberZonePeers(x).includes(y);
}
