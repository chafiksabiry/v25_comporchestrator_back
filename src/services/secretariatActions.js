import { registerCompanyCalendarResolver } from './calendarSync.js';
import { connectedAccount, withConnection } from './secretariatConnections.js';
import { SecretariatError } from './secretariatProviders/common.js';
import { PROVIDERS } from './secretariatProviders/index.js';
import { loadTools, localMeetingUrl, mergedTools, VISIO_NEEDS } from './secretariatTools.js';

/**
 * Actions du secrétariat qui passent par un compte connecté : envoi d'e-mail, événements d'agenda, liens de visio.
 * Toute erreur est une SecretariatError au message français sûr (jamais de jeton ni de corps de réponse du fournisseur).
 */
const VISIO_LABEL = { google_meet: 'Google Meet', teams: 'Teams', zoom: 'Zoom' };
const DEFAULT_MINUTES = 30;

/** Convertit toute erreur inattendue en erreur générique (aucun détail technique). */
const safe = (error) => (error instanceof SecretariatError ? error : new SecretariatError('provider_error', 'Le service du fournisseur a rencontré une erreur.'));

// ---------- e-mail
/**
 * Envoie par la messagerie connectée du centre (From = compte connecté). Aucun repli sur l'expéditeur HARX : l'appelant décide.
 * @param {{fromName: string, to: string[], subject: string, text: string, html?: string, replyTo?: {email: string, name?: string},
 *   attachments?: Array<{name: string, contentType: string, contentBase64: string}>}} message
 */
export async function sendViaConnection(companyId, provider, message) {
  try {
    const account = await connectedAccount(companyId, provider);
    return await withConnection(companyId, provider, (accessToken, http) => PROVIDERS[provider].sendMail({ http, accessToken, account, message }));
  } catch (error) {
    throw safe(error);
  }
}

// ---------- événements d'agenda
const describe = (i) => [i.contactName ? `Rendez-vous avec ${i.contactName}` : '', i.videoUrl ? `Visio : ${i.videoUrl}` : ''].filter(Boolean).join('\n');
function eventOf(item) {
  const start = new Date(item.dueAt);
  return { title: item.title, description: describe(item), location: item.videoUrl || '', startsAt: start, endsAt: new Date(start.getTime() + (Number(item.durationMinutes) || DEFAULT_MINUTES) * 60000) };
}

/** Adaptateur d'agenda d'UN centre pour calendarSync (rendez-vous = vue `toItem` + companyId + calendarExternalId). */
function calendarAdapter(companyId, provider) {
  const P = PROVIDERS[provider];
  const upsert = (item, id) => withConnection(companyId, provider, (accessToken, http) => P.upsertEvent({ http, accessToken, id, event: eventOf(item) }));
  const push = async (item) => ({ provider, externalId: (await upsert(item, null)).id });
  return {
    id: provider,
    push,
    update: async (item) => (item.calendarExternalId ? { provider, externalId: (await upsert(item, item.calendarExternalId)).id } : push(item)),
    remove: async (item) => {
      if (item.calendarExternalId) await withConnection(companyId, provider, (accessToken, http) => P.deleteEvent({ http, accessToken, id: item.calendarExternalId }));
    },
  };
}

/** Agenda du centre : celui des réglages ; pour modifier / supprimer, celui où l'événement a été créé. Null sans agenda connecté. */
registerCompanyCalendarResolver(async (companyId, hint) => {
  let provider = mergedTools(await loadTools(companyId)).agenda.provider;
  if ((hint.op === 'update' || hint.op === 'remove') && hint.hasExternalId && (hint.provider === 'google' || hint.provider === 'microsoft')) provider = hint.provider;
  return provider === 'google' || provider === 'microsoft' ? calendarAdapter(companyId, provider) : null;
});

// ---------- visio
/**
 * Lien de visio d'un rendez-vous. jitsi / lien permanent : inchangés. Meet / Teams : un événement du compte connecté (c'est l'événement
 * d'agenda du rendez-vous quand l'agenda est le même fournisseur, sinon un événement dédié au lien). Zoom : une réunion planifiée.
 * En cas d'échec : SecretariatError claire, jamais de faux lien.
 * @param {{title: string, contactName?: string, dueAt: Date|string, durationMinutes?: number|null}} appt
 * @param {{calendar?: {provider: string|null, externalId: string|null}|null}} [options] événement d'agenda déjà créé pour ce rendez-vous
 * @returns {Promise<{url: string, provider: '' | 'google_meet' | 'teams' | 'zoom', externalId: string, sharesCalendar: boolean, eventProvider: string}>}
 */
export async function createVideo(companyId, appt, { calendar = null } = {}) {
  const tools = mergedTools(await loadTools(companyId));
  const kind = tools.visio.provider;
  if (!VISIO_NEEDS[kind]) return { url: localMeetingUrl(tools.visio), provider: '', externalId: '', sharesCalendar: false, eventProvider: '' };
  const account = VISIO_NEEDS[kind];
  const event = eventOf({ ...appt, videoUrl: '' });
  try {
    if (kind === 'zoom') {
      const r = await withConnection(companyId, 'zoom', (accessToken, http) => PROVIDERS.zoom.createMeeting({ http, accessToken, event }));
      return { url: r.joinUrl, provider: 'zoom', externalId: r.id, sharesCalendar: false, eventProvider: '' };
    }
    const existing = calendar?.provider === account && calendar.externalId ? calendar.externalId : null;
    const r = await withConnection(companyId, account, (accessToken, http) => PROVIDERS[account].upsertEvent({ http, accessToken, id: existing, event, addMeeting: true }));
    return { url: r.joinUrl, provider: kind, externalId: r.id, sharesCalendar: Boolean(existing) || tools.agenda.provider === account, eventProvider: account };
  } catch (error) {
    const e = safe(error);
    const detail = e.code === 'not_connected' || e.code === 'needs_reauth' ? e.message : 'Réessayez dans un instant ou choisissez un autre outil de visio dans Paramétrage > Outils.';
    throw new SecretariatError(e.code, `Le lien de visio ${VISIO_LABEL[kind]} n’a pas pu être créé. ${detail}`, { status: e.status });
  }
}

/** Met à jour la réunion / l'événement DÉDIÉ au lien (jamais l'événement d'agenda, géré par calendarSync). Au mieux : renvoie false en cas d'échec. */
export async function updateVideoResource(companyId, item) {
  if (!item.videoProvider || !item.videoExternalId) return true;
  try {
    const event = eventOf({ ...item, videoUrl: '' });
    if (item.videoProvider === 'zoom') await withConnection(companyId, 'zoom', (accessToken, http) => PROVIDERS.zoom.updateMeeting({ http, accessToken, id: item.videoExternalId, event }));
    else if (item.videoExternalId !== item.calendarExternalId) {
      const account = VISIO_NEEDS[item.videoProvider];
      await withConnection(companyId, account, (accessToken, http) => PROVIDERS[account].upsertEvent({ http, accessToken, id: item.videoExternalId, event }));
    }
    return true;
  } catch (error) {
    console.error(`[secretariat] mise à jour de la visio impossible: ${safe(error).code}`);
    return false;
  }
}

/** Supprime la réunion Zoom / l'événement dédié au lien. L'événement partagé avec l'agenda est supprimé par calendarSync. Au mieux. */
export async function removeVideoResource(companyId, item) {
  if (!item.videoProvider || !item.videoExternalId || item.videoExternalId === item.calendarExternalId) return true;
  try {
    if (item.videoProvider === 'zoom') await withConnection(companyId, 'zoom', (accessToken, http) => PROVIDERS.zoom.deleteMeeting({ http, accessToken, id: item.videoExternalId }));
    else {
      const account = VISIO_NEEDS[item.videoProvider];
      await withConnection(companyId, account, (accessToken, http) => PROVIDERS[account].deleteEvent({ http, accessToken, id: item.videoExternalId }));
    }
    return true;
  } catch (error) {
    console.error(`[secretariat] suppression de la visio impossible: ${safe(error).code}`);
    return false;
  }
}
