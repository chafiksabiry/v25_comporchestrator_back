/**
 * POINT D'EXTENSION — synchronisation d'un rendez-vous interne HARX avec un agenda externe.
 *
 * Aujourd'hui aucun fournisseur n'est branché : la connexion OAuth Google / Microsoft 365 / Zoom n'est pas disponible.
 * Cette fonction ne simule donc rien : elle répond « non connecté » et le rendez-vous reste uniquement dans HARX.
 *
 * Pour brancher un fournisseur plus tard : enregistrer un adaptateur avec `registerCalendarProvider(adaptateur)` ;
 * il reçoit le rendez-vous et renvoie `{ provider, externalId }`. `FollowUpItem.externalCalendar` conserve le résultat.
 * @typedef {{ id: string, push: (item: object) => Promise<{ provider: string, externalId: string }> }} CalendarProvider
 */
const providers = new Map();

/** @param {CalendarProvider} adapter */
export function registerCalendarProvider(adapter) {
  if (!adapter || !adapter.id || typeof adapter.push !== 'function') throw new Error('Adaptateur d’agenda invalide.');
  providers.set(adapter.id, adapter);
}

export const hasCalendarProvider = () => providers.size > 0;

/** @returns {Promise<{ status: 'not_connected' | 'synced' | 'failed', provider: string | null, externalId: string | null }>} */
export async function syncAppointment(item) {
  const adapter = providers.values().next().value;
  if (!adapter) return { status: 'not_connected', provider: null, externalId: null };
  try {
    const r = await adapter.push(item);
    return { status: 'synced', provider: r.provider, externalId: r.externalId };
  } catch (error) {
    console.error(`[calendarSync] ${adapter.id} failed: ${error.message}`);
    return { status: 'failed', provider: adapter.id, externalId: null };
  }
}
