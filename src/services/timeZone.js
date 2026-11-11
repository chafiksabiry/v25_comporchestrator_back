/**
 * Fuseaux horaires (noms IANA) des rendez-vous. Logique pure : aucun accès base ni réseau.
 * HARX est mondial : le fuseau d'un rendez-vous est celui choisi par la personne, à défaut celui du centre, à défaut Europe/Paris
 * (comportement historique des rendez-vous créés avant l'ajout du fuseau).
 */
export const DEFAULT_TIME_ZONE = 'Europe/Paris';
export const UNKNOWN_TIME_ZONE_MESSAGE = 'Fuseau horaire inconnu.';

/**
 * Nom IANA reconnu par `Intl.DateTimeFormat`. Renvoie le nom canonique (casse normalisée) ou null.
 * Les décalages (« +01:00 ») sont refusés : ce ne sont pas des noms de fuseau et les agendas ne les acceptent pas.
 */
export function normalizeTimeZone(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || name.length > 64 || /^[+-]/.test(name)) return null;
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: name }).resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export const isValidTimeZone = (value) => normalizeTimeZone(value) !== null;

/** Fuseau d'un rendez-vous : `item.timeZone`, sinon `tools.timeZone` du centre, sinon Europe/Paris. Une valeur invalide est ignorée. */
export function resolveItemTimeZone(item, tools) {
  return normalizeTimeZone(item?.timeZone) || normalizeTimeZone(tools?.timeZone) || DEFAULT_TIME_ZONE;
}

/** Heure murale `20261103T100000` d'un instant dans un fuseau. */
export function formatWallTime(date, timeZone = DEFAULT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}T${p.hour}${p.minute}${p.second}`;
}
