/**
 * SYNCHRONISATION d'un rendez-vous interne HARX avec un agenda externe (Google Agenda, Calendrier Outlook).
 *
 * Deux façons de brancher un fournisseur, qui coexistent :
 *  - registre GLOBAL (historique) : `registerCalendarProvider(adaptateur)`, un adaptateur pour tout le monde ;
 *  - adaptateurs PAR ENTREPRISE : `registerCompanyCalendarResolver(fn)` ; `fn(companyId, indice)` renvoie l'adaptateur de CE centre
 *    (ou null s'il n'a pas d'agenda connecté). Le résolveur par entreprise passe avant le registre global.
 * Un adaptateur : `{ id, push(item), update?(item), remove?(item) }` ; `push` renvoie `{ provider, externalId }`, `update` aussi,
 * `remove` ne renvoie rien d'utile. `item` = le rendez-vous (vue `toItem` + `companyId`, `calendarExternalId`, `videoUrl`).
 * `FollowUpItem.calendarProvider / calendarExternalId / calendarStatus` conservent le résultat.
 * Un échec est TOUJOURS renvoyé sous forme `failed` : il n'empêche jamais le rendez-vous HARX.
 * @typedef {{ id: string, push: (item: object) => Promise<{ provider: string, externalId: string }>, update?: (item: object) => Promise<{ provider: string, externalId: string }>, remove?: (item: object) => Promise<unknown> }} CalendarProvider
 */
const providers = new Map();
let companyResolver = null;

/** @param {CalendarProvider} adapter */
export function registerCalendarProvider(adapter) {
  if (!adapter || !adapter.id || typeof adapter.push !== 'function') throw new Error('Adaptateur d’agenda invalide.');
  providers.set(adapter.id, adapter);
}

/** Retire un adaptateur global (tests, désactivation). */
export const unregisterCalendarProvider = (id) => providers.delete(id);

/** @param {((companyId: string, hint: {op: string, provider?: string|null, hasExternalId: boolean}) => Promise<CalendarProvider|null>) | null} fn */
export function registerCompanyCalendarResolver(fn) {
  if (fn !== null && typeof fn !== 'function') throw new Error('Résolveur d’agenda invalide.');
  companyResolver = fn;
}

/** Vrai si un adaptateur GLOBAL est enregistré (les adaptateurs par entreprise sont signalés par `hasCompanyCalendarResolver`). */
export const hasCalendarProvider = () => providers.size > 0;
export const hasCompanyCalendarResolver = () => companyResolver !== null;

/**
 * @param {object} item rendez-vous (avec `companyId` pour le choix de l'agenda du centre)
 * @param {{ op?: 'push' | 'update' | 'remove' }} [options]
 * @returns {Promise<{ status: 'not_connected' | 'synced' | 'failed', provider: string | null, externalId: string | null }>}
 */
export async function syncAppointment(item, { op = 'push' } = {}) {
  let adapter = null;
  try {
    if (companyResolver && item?.companyId) adapter = await companyResolver(String(item.companyId), { op, provider: item.calendarProvider || null, hasExternalId: Boolean(item.calendarExternalId) });
  } catch (error) {
    console.error(`[calendarSync] résolution de l’agenda impossible: ${error.code || error.message}`);
    return { status: 'failed', provider: null, externalId: null };
  }
  adapter = adapter || providers.values().next().value;
  if (!adapter) return { status: 'not_connected', provider: null, externalId: null };
  try {
    if (op === 'remove') {
      if (typeof adapter.remove !== 'function') return { status: 'not_connected', provider: adapter.id, externalId: null };
      await adapter.remove(item);
      return { status: 'synced', provider: adapter.id, externalId: null };
    }
    const r = await (op === 'update' && typeof adapter.update === 'function' ? adapter.update(item) : adapter.push(item));
    return { status: 'synced', provider: r.provider, externalId: r.externalId };
  } catch (error) {
    console.error(`[calendarSync] ${adapter.id} failed: ${error.code || error.message}`); // jamais le détail du fournisseur
    return { status: 'failed', provider: adapter.id, externalId: null };
  }
}
