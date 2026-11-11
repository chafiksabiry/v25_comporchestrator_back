import { appointmentEvent } from './secretariatActions.js';
import {
  createAccountEvent, deleteAccountEvent, requireAccount, updateAccountEvent,
} from './secretariatSharedAccounts.js';
import { SecretariatError } from './secretariatProviders/common.js';

/**
 * Rendez-vous ajouté AUSSI à l'agenda d'un compte DÉLÉGUÉ (compte partagé avec la secrétaire, droit « agenda »).
 *  - création : l'événement est créé dans l'agenda de CE compte (contrôle de conflit comme createAccountEvent, jamais d'invité) ;
 *    il n'est PAS créé dans l'agenda de la société ;
 *  - modification / annulation : toujours sur le MÊME compte (identifiant mémorisé dans le rendez-vous), jamais de repli sur l'agenda de
 *    la société ni sur un autre compte ; si le compte n'est plus utilisable, l'échec est conservé (`failed` + message) et jamais masqué ;
 *  - visio : non prise en charge avec un agenda délégué (voir DELEGATED_VIDEO_*) ; l'API répond 409 plutôt que de créer un lien à moitié.
 */
export const DELEGATED_VIDEO_CODE = 'delegated_calendar_video_unsupported';
export const DELEGATED_VIDEO_MESSAGE = 'Le lien de visio n’est pas disponible quand le rendez-vous est ajouté à l’agenda d’un collègue. Retirez le lien de visio ou choisissez l’agenda HARX seulement.';
export const DELEGATED_GONE_MESSAGE = 'Cet agenda n’est plus disponible ou n’est plus autorisé : le rendez-vous n’a pas été mis à jour dans cet agenda. Vérifiez-le directement dans l’agenda concerné.';
const DEFAULT_ERROR = 'Le service du fournisseur a rencontré une erreur.';

/** Erreur « visio + agenda délégué ». */
export const delegatedVideoError = () => new SecretariatError(DELEGATED_VIDEO_CODE, DELEGATED_VIDEO_MESSAGE, { status: 409 });

/** Compte autorisé pour l'agenda (404 introuvable / non autorisé, 403, 409 à reconnecter : voir requireAccount). */
export const openDelegatedAccount = (companyId, access, accountId) => requireAccount(String(companyId), access, accountId, 'calendar');

const inputOf = async (companyId, appt, ignoreConflicts) => {
  const e = await appointmentEvent(String(companyId), appt);
  return { title: e.title, description: e.description, location: e.location, timeZone: e.timeZone, startsAt: e.startsAt, endsAt: e.endsAt, durationMinutes: Math.round((e.endsAt - e.startsAt) / 60000), ignoreConflicts };
};

/** Crée l'événement dans l'agenda du compte. Lève `calendar_conflict` (409, `conflicts`) sauf `ignoreConflicts`. @returns {Promise<{id: string}>} */
export async function createDelegatedEvent(companyId, account, appt, { ignoreConflicts = false, authorName = '' } = {}) {
  return createAccountEvent(String(companyId), account, await inputOf(companyId, appt, ignoreConflicts), { authorName, companyName: '' });
}

/** Retire l'événement (annulation d'un enregistrement qui a échoué). Au mieux. */
export async function discardDelegatedEvent(companyId, account, eventId) {
  try { await deleteAccountEvent(String(companyId), account, eventId); } catch (error) { console.error(`[delegatedAppointments] suppression de l’événement impossible: ${error.code || error.message}`); }
}

/**
 * Répercute une modification (`update` : déplacement / réouverture ; `remove` : annulation) sur le compte délégué du rendez-vous. Ne lève jamais.
 * @param {object} appt vue du rendez-vous (companyId, calendarAccountId, calendarProvider, calendarExternalId, …)
 * @returns {Promise<{status: 'synced'|'failed', externalId: string|null, label?: string, provider?: string, message: string}>}
 */
export async function syncDelegated(appt, access, op) {
  const failed = (message) => ({ status: 'failed', externalId: appt.calendarExternalId || null, message });
  try {
    const account = await openDelegatedAccount(appt.companyId, access, appt.calendarAccountId);
    // Le compte ne doit pas avoir changé de fournisseur depuis la création (sinon l'identifiant d'événement n'a plus de sens) : aucun repli.
    if (appt.calendarExternalId && appt.calendarProvider && appt.calendarProvider !== account.provider) return failed(DELEGATED_GONE_MESSAGE);
    const base = { label: account.label, provider: account.provider, message: '' };
    if (op === 'remove') {
      await deleteAccountEvent(String(appt.companyId), account, appt.calendarExternalId);
      return { status: 'synced', externalId: null, ...base };
    }
    const input = await inputOf(appt.companyId, appt, true); // le créneau a été validé à la création : pas de nouveau contrôle de conflit
    if (appt.calendarExternalId) return { status: 'synced', externalId: (await updateAccountEvent(String(appt.companyId), account, appt.calendarExternalId, input)).id, ...base };
    return { status: 'synced', externalId: (await createAccountEvent(String(appt.companyId), account, input, { authorName: '', companyName: '' })).id, ...base };
  } catch (error) {
    if (!(error instanceof SecretariatError)) { console.error(`[delegatedAppointments] ${error.message}`); return failed(DEFAULT_ERROR); }
    return failed(error.code === 'account_not_found' ? DELEGATED_GONE_MESSAGE : error.message);
  }
}
