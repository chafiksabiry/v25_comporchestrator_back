import { call, ensure, eventWindow, SecretariatError, VIDEO_LINK_RE } from './common.js';

/**
 * Microsoft 365 : Outlook (envoi), Calendrier (événements), Teams (via un événement). Points d'accès Graph v1.0 publics ;
 * AUCUN essayé avec un vrai compte : tout est « À VÉRIFIER » en recette.
 *
 * Choix Teams : événement `isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness'` plutôt que POST /me/onlineMeetings.
 * Raisons : un seul objet à créer / déplacer / supprimer (le même que le rendez-vous quand l'agenda est Microsoft) ; un seul scope
 * déjà demandé (Calendars.ReadWrite) ; /me/onlineMeetings dépend des stratégies de réunion Teams du locataire et sa suppression
 * n'est pas garantie. Contrepartie : un événement apparaît dans le calendrier du compte même si l'agenda HARX n'est pas Microsoft.
 */
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPES = ['offline_access', 'openid', 'email', 'User.Read', 'Mail.Send', 'Calendars.ReadWrite', 'OnlineMeetings.ReadWrite'];
// MICROSOFT_TENANT_ID : GUID, domaine ou common|organizations|consumers. Tout autre caractère est refusé (pas d'injection dans l'URL).
export const tenantOf = (env) => String(env.MICROSOFT_TENANT_ID || '').trim() || 'common';
export const isValidTenant = (t) => /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/.test(t);
const base = (env) => `https://login.microsoftonline.com/${tenantOf(env)}/oauth2/v2.0`;

export const microsoft = {
  id: 'microsoft',
  scopes: SCOPES,
  requiredScopes: [],
  authorizeUrl: (env) => `${base(env)}/authorize`,
  tokenUrl: (env) => `${base(env)}/token`,
  authorizeExtra: () => ({ response_mode: 'query' }),
  clientAuth: ({ clientId, clientSecret }) => ({ form: { client_id: clientId, client_secret: clientSecret }, headers: {} }),
  refreshExtra: () => ({ scope: SCOPES.join(' ') }),

  async accountEmail({ http, accessToken }) {
    const res = ensure(await call(http, { method: 'GET', url: `${GRAPH}/me?$select=mail,userPrincipalName`, headers: { Authorization: `Bearer ${accessToken}` } }), 'Lecture du compte Microsoft');
    return String(res.json?.mail || res.json?.userPrincipalName || '');
  },

  /** Pas de point de révocation utilisateur fiable en v2.0 : les jetons sont supprimés de notre côté (rien à appeler). */
  async revoke() {},

  /** Graph POST /me/sendMail : l'expéditeur est la boîte connectée (aucun `from` imposé). Réponse attendue : 202. */
  async sendMail({ http, accessToken, message }) {
    const recipient = (address, name) => ({ emailAddress: { address, ...(name ? { name } : {}) } });
    const body = {
      message: {
        subject: message.subject,
        body: message.html ? { contentType: 'HTML', content: message.html } : { contentType: 'Text', content: message.text },
        toRecipients: message.to.map((a) => recipient(a)),
        ...(message.replyTo?.email ? { replyTo: [recipient(message.replyTo.email, message.replyTo.name)] } : {}),
        ...(message.attachments?.length ? { attachments: message.attachments.map((f) => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: f.name, contentType: f.contentType, contentBytes: f.contentBase64 })) } : {}),
      },
      saveToSentItems: true,
    };
    ensure(await call(http, { method: 'POST', url: `${GRAPH}/me/sendMail`, headers: { Authorization: `Bearer ${accessToken}` }, body }), 'Envoi Outlook', [202]);
    return { id: '' };
  },

  /** Crée (sans `id`) ou met à jour un événement ; `addMeeting` ajoute une réunion Teams. Aucun participant : aucune invitation. */
  async upsertEvent({ http, accessToken, id, event, addMeeting = false }) {
    const { start, end } = eventWindow(event);
    const utc = (d) => d.toISOString().slice(0, 19);
    const body = {
      subject: event.title, body: { contentType: 'Text', content: event.description || '' }, location: { displayName: event.location || '' },
      start: { dateTime: utc(start), timeZone: 'UTC' }, end: { dateTime: utc(end), timeZone: 'UTC' },
      ...(addMeeting ? { isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' } : {}),
    };
    const headers = { Authorization: `Bearer ${accessToken}` };
    const res = ensure(await call(http, id
      ? { method: 'PATCH', url: `${GRAPH}/me/events/${encodeURIComponent(id)}`, headers, body }
      : { method: 'POST', url: `${GRAPH}/me/events`, headers, body }), 'Événement Outlook', id ? [200] : [201]);
    const eventId = res.json?.id || id;
    if (!eventId) throw new SecretariatError('provider_error', 'Outlook n’a pas renvoyé d’identifiant d’événement.');
    const link = String(res.json?.onlineMeeting?.joinUrl || '');
    if (addMeeting && !VIDEO_LINK_RE.teams.test(link)) throw new SecretariatError('invalid_link', 'Teams n’a pas fourni de lien de visio utilisable.');
    return { id: eventId, joinUrl: addMeeting ? link : '' };
  },

  /**
   * Lecture seule des événements du calendrier par défaut entre deux instants (`calendarView` déplie les séries), en UTC.
   * Le périmètre `Calendars.ReadWrite` déjà demandé suffit. Événements annulés ignorés.
   * @returns {Promise<Array<{id: string, title: string, startsAt: string, endsAt: string, allDay: boolean, location: string, private: boolean, busy: boolean}>>}
   */
  async listEvents({ http, accessToken, from, to }) {
    const q = new URLSearchParams({ startDateTime: from.toISOString(), endDateTime: to.toISOString(), $top: '250', $orderby: 'start/dateTime', $select: 'id,subject,start,end,isAllDay,location,sensitivity,showAs,isCancelled' });
    const res = ensure(await call(http, { method: 'GET', url: `${GRAPH}/me/calendarView?${q}`, headers: { Authorization: `Bearer ${accessToken}`, Prefer: 'outlook.timezone="UTC"' } }), 'Lecture du calendrier Outlook', [200]);
    const when = (t) => (t?.dateTime ? new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(t.dateTime) ? t.dateTime : `${t.dateTime}Z`) : null);
    return (Array.isArray(res.json?.value) ? res.json.value : []).filter((e) => e && !e.isCancelled).flatMap((e) => {
      const startsAt = when(e.start); const endsAt = when(e.end);
      if (!e.id || !startsAt || !endsAt || Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) return [];
      return [{ id: String(e.id), title: String(e.subject || ''), startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), allDay: e.isAllDay === true, location: String(e.location?.displayName || ''), private: e.sensitivity === 'private' || e.sensitivity === 'confidential', busy: e.showAs !== 'free' }];
    });
  },

  /** Suppression ; 404 (déjà supprimé) compte comme réussi. */
  async deleteEvent({ http, accessToken, id }) {
    ensure(await call(http, { method: 'DELETE', url: `${GRAPH}/me/events/${encodeURIComponent(id)}`, headers: { Authorization: `Bearer ${accessToken}` } }), 'Suppression Outlook', [200, 204, 404]);
  },
};
