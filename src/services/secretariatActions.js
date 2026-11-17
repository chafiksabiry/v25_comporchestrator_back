import { registerCompanyCalendarResolver } from './calendarSync.js';
import SecretariatConnection from '../models/SecretariatConnection.js';
import { connectedAccount, messages, resolveVisio, withConnection } from './secretariatConnections.js';
import { isMailProvider, isOwnerless, ownerOf, ownsRow } from './mailOwnership.js';
import { sendFromAccount } from './secretariatSharedAccounts.js';
import { ownerHasLeft } from './mailOwnerMembership.js';
import { SecretariatError } from './secretariatProviders/common.js';
import { PROVIDERS } from './secretariatProviders/index.js';
import { loadTools, mergedTools, VISIO_NEEDS } from './secretariatTools.js';
import { resolveItemTimeZone } from './timeZone.js';

/**
 * Actions du secrétariat qui passent par un compte connecté : envoi d'e-mail, événements d'agenda, liens de visio.
 * Toute erreur est une SecretariatError au message français sûr (jamais de jeton ni de corps de réponse du fournisseur).
 */
const VISIO_LABEL = { google_meet: 'Google Meet', teams: 'Teams', zoom: 'Zoom' };
const DEFAULT_MINUTES = 30;
export const VISIO_NOT_CONNECTED_MESSAGE = 'Connectez Google Meet, Microsoft Teams ou Zoom dans Paramétrage > Outils pour créer un lien de visio.';

/** Convertit toute erreur inattendue en erreur générique (aucun détail technique). */
const safe = (error) => (error instanceof SecretariatError ? error : new SecretariatError('provider_error', 'Le service du fournisseur a rencontré une erreur.'));

// ---------- e-mail
/**
 * Envoie par la messagerie que `userId` a connectée (From = ce compte ; SEUL son propriétaire peut l'utiliser). Aucun repli sur l'expéditeur HARX ni sur la boîte
 * d'une autre personne : sans `userId` propriétaire, `not_connected`. L'appelant décide.
 * @param {{fromName: string, to: string[], subject: string, text: string, html?: string, replyTo?: {email: string, name?: string},
 *   attachments?: Array<{name: string, contentType: string, contentBase64: string}>}} message
 */
export async function sendViaConnection(companyId, provider, message, { userId = null } = {}) {
  try {
    const account = await connectedAccount(companyId, provider, userId);
    return await withConnection(companyId, provider, (accessToken, http) => PROVIDERS[provider].sendMail({ http, accessToken, account, message }), { ownerId: userId });
  } catch (error) {
    throw safe(error);
  }
}

/**
 * Envoi pour le compte d'une boîte résolue par `resolveUserMailbox` : la connexion dont `userId` est propriétaire, ou SA messagerie personnelle.
 * Jamais la boîte d'un autre. @param {{kind: 'connection'|'personal', provider: string, account: string, accountId?: string}} mailbox
 */
export async function sendViaMailbox(companyId, mailbox, message, { userId } = {}) {
  if (mailbox?.kind === 'personal') return sendFromAccount(companyId, { _id: mailbox.accountId, provider: mailbox.provider, accountEmail: mailbox.account }, message);
  return sendViaConnection(companyId, mailbox?.provider, message, { userId });
}

// ---------- événements d'agenda
const describe = (i) => [i.contactName ? `Rendez-vous avec ${i.contactName}` : '', i.location ? `Lieu : ${i.location}` : '', i.videoUrl ? `Visio : ${i.videoUrl}` : ''].filter(Boolean).join('\n');
/** `tools` = réglages du centre (fuseau par défaut) ; le fuseau envoyé au fournisseur est celui du rendez-vous (resolveItemTimeZone). */
function eventOf(item, tools) {
  const start = new Date(item.dueAt);
  return { timeZone: resolveItemTimeZone(item, tools), title: item.title, description: describe(item), location: item.location || item.videoUrl || '', startsAt: start, endsAt: new Date(start.getTime() + (Number(item.durationMinutes) || DEFAULT_MINUTES) * 60000) };
}

/** Événement d'agenda d'un rendez-vous (titre, description, lieu, créneau, fuseau résolu) : sert aussi à l'agenda délégué (voir delegatedAppointments.js). */
export async function appointmentEvent(companyId, appt) {
  return eventOf({ ...appt, videoUrl: '' }, mergedTools(await loadTools(companyId)));
}

/** Adaptateur d'agenda d'UN centre pour calendarSync (rendez-vous = vue `toItem` + companyId + calendarExternalId). */
function calendarAdapter(companyId, provider, ownerId) {
  const P = PROVIDERS[provider];
  const upsert = async (item, id) => {
    const tools = mergedTools(await loadTools(companyId));
    return withConnection(companyId, provider, (accessToken, http) => P.upsertEvent({ http, accessToken, id, event: eventOf(item, tools) }), { ownerId });
  };
  const push = async (item) => ({ provider, externalId: (await upsert(item, null)).id, ownerId });
  return {
    id: provider,
    push,
    update: async (item) => (item.calendarExternalId ? { provider, externalId: (await upsert(item, item.calendarExternalId)).id, ownerId } : push(item)),
    remove: async (item) => {
      if (item.calendarExternalId) await withConnection(companyId, provider, (accessToken, http) => P.deleteEvent({ http, accessToken, id: item.calendarExternalId }), { ownerId });
    },
  };
}

/**
 * Connexion Google / Microsoft de `userId` utilisable pour l'agenda : celle du fournisseur choisi (réglage) si elle est active, sinon son autre boîte active.
 * Les connexions des AUTRES personnes ne comptent jamais. @returns {Promise<'google'|'microsoft'|null>}
 */
async function agendaProviderOf(companyId, userId, preferred) {
  if (!userId) return null;
  const rows = (await SecretariatConnection.find({ companyId, provider: { $in: ['google', 'microsoft'] } }).select('provider status connectedBy').lean()).filter((r) => r.status === 'connected' && ownsRow(r, userId));
  return (rows.find((r) => r.provider === preferred) || rows[0])?.provider || null;
}

/**
 * Agenda d'un rendez-vous. CRÉATION : l'agenda de la personne ASSIGNÉE, sinon celui de CELLE QUI CRÉE le rendez-vous (`hint.userIds`, dans cet ordre), s'ils ont connecté
 * une boîte Google / Microsoft ; sinon null (`not_connected`) : jamais l'agenda d'une autre personne. MODIFICATION / ANNULATION : le calendrier où l'événement a été créé
 * (`hint.ownerId` mémorisé) ; rendez-vous antérieur sans propriétaire mémorisé : le propriétaire actuel de la connexion de ce fournisseur (jamais une connexion orpheline).
 * Réglage d'agenda « none » : aucun envoi.
 */
registerCompanyCalendarResolver(async (companyId, hint) => {
  const agenda = mergedTools(await loadTools(companyId)).agenda.provider;
  if (agenda !== 'google' && agenda !== 'microsoft') return null;
  if ((hint.op === 'update' || hint.op === 'remove') && hint.hasExternalId && isMailProvider(hint.provider)) {
    let ownerId = String(hint.ownerId || '').trim();
    if (!ownerId) { // rendez-vous antérieur à la règle : la connexion qui a créé l'événement, si elle a un propriétaire
      const row = await SecretariatConnection.findOne({ companyId, provider: hint.provider }).select('connectedBy').lean();
      ownerId = row && !isOwnerless(row) ? ownerOf(row) : '';
    }
    if (!ownerId) return null;
    // Agir dans le calendrier de son propriétaire mémorisé seulement s'il est encore rattaché à la société ET que sa connexion est valide ; sinon `not_connected` sans erreur.
    const conn = await SecretariatConnection.findOne({ companyId, provider: hint.provider }).select('status connectedBy').lean();
    if (!conn || conn.status !== 'connected' || !ownsRow(conn, ownerId) || (await ownerHasLeft(companyId, ownerId, hint.token))) return { id: hint.provider, unavailable: true };
    return calendarAdapter(companyId, hint.provider, ownerId);
  }
  for (const userId of [...new Set((hint.userIds || []).map((u) => String(u || '').trim()).filter(Boolean))]) {
    const provider = await agendaProviderOf(companyId, userId, agenda);
    if (provider) return calendarAdapter(companyId, provider, userId);
  }
  return null;
});

// ---------- visio
/**
 * Lien de visio d'un rendez-vous. HARX ne fournit AUCUNE visio : jamais de lien Jitsi ni de lien permanent. Sans fournisseur connecté
 * (choisi, ou unique connexion possible) : SecretariatError `visio_not_connected` / `visio_needs_reauth`. Meet / Teams : un événement du compte connecté (c'est l'événement
 * d'agenda du rendez-vous quand l'agenda est le même fournisseur, sinon un événement dédié au lien). Zoom : une réunion planifiée.
 * En cas d'échec : SecretariatError claire, jamais de faux lien.
 * @param {{title: string, contactName?: string, dueAt: Date|string, durationMinutes?: number|null, timeZone?: string|null}} appt
 * @param {{calendar?: {provider: string|null, externalId: string|null}|null}} [options] événement d'agenda déjà créé pour ce rendez-vous
 * @returns {Promise<{url: string, provider: '' | 'google_meet' | 'teams' | 'zoom', externalId: string, sharesCalendar: boolean, eventProvider: string}>}
 */
export async function createVideo(companyId, appt, { calendar = null, userId = null } = {}) {
  const tools = mergedTools(await loadTools(companyId));
  const resolved = await resolveVisio(companyId, tools.visio.provider, userId); // Meet / Teams : la boîte de `userId` seulement
  if (resolved.error) throw new SecretariatError(`visio_${resolved.error}`, resolved.error === 'needs_reauth' ? messages.needsReauth(resolved.account) : VISIO_NOT_CONNECTED_MESSAGE, { status: 409 });
  const kind = resolved.provider;
  const account = VISIO_NEEDS[kind];
  const event = eventOf({ ...appt, videoUrl: '' }, tools);
  try {
    if (kind === 'zoom') {
      const r = await withConnection(companyId, 'zoom', (accessToken, http) => PROVIDERS.zoom.createMeeting({ http, accessToken, event }));
      return { url: r.joinUrl, provider: 'zoom', externalId: r.id, sharesCalendar: false, eventProvider: '', ownerId: '' };
    }
    const existing = calendar?.provider === account && calendar.externalId ? calendar.externalId : null;
    const r = await withConnection(companyId, account, (accessToken, http) => PROVIDERS[account].upsertEvent({ http, accessToken, id: existing, event, addMeeting: true }), { ownerId: userId });
    return { url: r.joinUrl, provider: kind, externalId: r.id, sharesCalendar: Boolean(existing) || tools.agenda.provider === account, eventProvider: account, ownerId: userId };
  } catch (error) {
    const e = safe(error);
    const detail = e.code === 'not_connected' || e.code === 'needs_reauth' ? e.message : 'Réessayez dans un instant ou choisissez un autre outil de visio dans Paramétrage > Outils.';
    throw new SecretariatError(e.code, `Le lien de visio ${VISIO_LABEL[kind]} n’a pas pu être créé. ${detail}`, { status: e.status });
  }
}

/** Propriétaire de la boîte qui porte le lien Meet / Teams d'un rendez-vous : celui mémorisé ; antérieur à la règle : le propriétaire actuel de la connexion (jamais orpheline). */
async function videoOwnerOf(companyId, item, account) {
  const stored = String(item.videoOwnerId || item.calendarOwnerId || '').trim();
  if (stored) return stored;
  const row = await SecretariatConnection.findOne({ companyId, provider: account }).select('connectedBy').lean();
  return row && !isOwnerless(row) ? ownerOf(row) : '';
}

/** Met à jour la réunion / l'événement DÉDIÉ au lien (jamais l'événement d'agenda, géré par calendarSync). Au mieux : renvoie false en cas d'échec. */
export async function updateVideoResource(companyId, item) {
  if (!item.videoProvider || !item.videoExternalId) return true;
  try {
    const event = eventOf({ ...item, videoUrl: '' }, mergedTools(await loadTools(companyId)));
    if (item.videoProvider === 'zoom') await withConnection(companyId, 'zoom', (accessToken, http) => PROVIDERS.zoom.updateMeeting({ http, accessToken, id: item.videoExternalId, event }));
    else if (item.videoExternalId !== item.calendarExternalId) {
      const account = VISIO_NEEDS[item.videoProvider];
      await withConnection(companyId, account, (accessToken, http) => PROVIDERS[account].upsertEvent({ http, accessToken, id: item.videoExternalId, event }), { ownerId: await videoOwnerOf(companyId, item, account) });
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
      await withConnection(companyId, account, (accessToken, http) => PROVIDERS[account].deleteEvent({ http, accessToken, id: item.videoExternalId }), { ownerId: await videoOwnerOf(companyId, item, account) });
    }
    return true;
  } catch (error) {
    console.error(`[secretariat] suppression de la visio impossible: ${safe(error).code}`);
    return false;
  }
}
