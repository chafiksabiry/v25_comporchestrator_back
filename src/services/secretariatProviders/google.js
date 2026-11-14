import { randomUUID } from 'node:crypto';
import { call, ensure, eventWindow, SecretariatError, VIDEO_LINK_RE } from './common.js';
import { dialIn, plainDescription, safeVideoUrl, videoUrlIn } from './eventConnection.js';
import { DEFAULT_TIME_ZONE } from '../timeZone.js';
import { buildMime, toBase64Url } from './mime.js';

/**
 * Google : Gmail (ENVOI seulement), Agenda (événements), Meet (via un événement). Tous les points d'accès ci-dessous sont les points
 * publics standards ; AUCUN n'a été essayé avec un vrai compte (aucun identifiant n'existe encore) : tout est « À VÉRIFIER » en recette.
 * AUCUNE lecture ni écriture de la boîte Gmail : les scopes restreints de lecture et d'écriture ne sont plus jamais demandés, et les
 * appels Gmail de lecture / écriture (liste de la boîte, corps, corbeille, archivage) ont été retirés. Le serveur refuse explicitement toute
 * lecture d'une messagerie Google (code `read_unavailable`, voir services/inboundEmails.js).
 */
const SCOPE_GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send';
const SCOPE_CALENDAR = 'https://www.googleapis.com/auth/calendar.events';
const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

export const google = {
  id: 'google',
  scopes: ['openid', 'email', SCOPE_GMAIL_SEND, SCOPE_CALENDAR],
  /** Scopes sans lesquels la connexion est inutilisable (l'utilisateur peut en décocher à l'écran de consentement). */
  requiredScopes: [SCOPE_GMAIL_SEND, SCOPE_CALENDAR],
  // Aucun readScope ni writeScope : Google ne demande plus jamais la lecture ni l'écriture de la boîte.
  authorizeUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: () => 'https://oauth2.googleapis.com/token',
  /** Paramètres propres à Google : refresh_token seulement avec access_type=offline + prompt=consent. */
  authorizeExtra: () => ({ access_type: 'offline', prompt: 'consent' }),
  /** Identifiants dans le corps du formulaire (client_secret_post). */
  clientAuth: ({ clientId, clientSecret }) => ({ form: { client_id: clientId, client_secret: clientSecret }, headers: {} }),
  refreshExtra: () => ({}),

  async accountEmail({ http, accessToken }) {
    const res = ensure(await call(http, { method: 'GET', url: 'https://openidconnect.googleapis.com/v1/userinfo', headers: { Authorization: `Bearer ${accessToken}` } }), 'Lecture du compte Google');
    return res.json?.email || '';
  },

  /** Révocation au mieux (le jeton de rafraîchissement révoque aussi les jetons d'accès). */
  async revoke({ http, credentials }) {
    const token = credentials.refreshToken || credentials.accessToken;
    if (!token) return;
    await call(http, { method: 'POST', url: 'https://oauth2.googleapis.com/revoke', form: { token } });
  },

  /** Gmail users.messages.send : RFC 822 en base64url ; From = compte connecté. */
  async sendMail({ http, accessToken, account, message }) {
    const raw = toBase64Url(buildMime({
      from: { email: account, name: message.fromName }, to: message.to, replyTo: message.replyTo, subject: message.subject,
      text: message.text, html: message.html, attachments: message.attachments,
    }));
    const res = ensure(await call(http, { method: 'POST', url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', headers: { Authorization: `Bearer ${accessToken}` }, body: { raw } }), 'Envoi Gmail', [200]);
    return { id: res.json?.id || '' };
  },

  /**
   * Agenda : crée (sans `id`) ou met à jour (PATCH) un événement. `addMeeting` ajoute un lien Meet (conferenceData.createRequest,
   * conferenceDataVersion=1). Aucun invité, aucune notification (sendUpdates=none) : rien n'est envoyé à des tiers.
   * @returns {Promise<{id: string, joinUrl: string}>}
   */
  async upsertEvent({ http, accessToken, id, event, addMeeting = false }) {
    const { start, end } = eventWindow(event);
    const timeZone = event.timeZone || DEFAULT_TIME_ZONE; // fuseau résolu par l'appelant (resolveItemTimeZone)
    const body = {
      summary: event.title, description: event.description || '', location: event.location || '',
      start: { dateTime: start.toISOString(), timeZone }, end: { dateTime: end.toISOString(), timeZone },
    };
    if (addMeeting) body.conferenceData = { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
    const q = `sendUpdates=none${addMeeting ? '&conferenceDataVersion=1' : ''}`;
    const headers = { Authorization: `Bearer ${accessToken}` };
    const res = ensure(await call(http, id
      ? { method: 'PATCH', url: `${CAL}/${encodeURIComponent(id)}?${q}`, headers, body }
      : { method: 'POST', url: `${CAL}?${q}`, headers, body }), 'Événement Google Agenda', [200]);
    const eventId = res.json?.id;
    if (!eventId) throw new SecretariatError('provider_error', 'Google Agenda n’a pas renvoyé d’identifiant d’événement.');
    let link = meetLink(res.json);
    // La conférence peut être « pending » à la création : une seule relecture, pas de boucle.
    if (addMeeting && !link) link = meetLink((await call(http, { method: 'GET', url: `${CAL}/${encodeURIComponent(eventId)}`, headers })).json);
    if (addMeeting && !VIDEO_LINK_RE.google_meet.test(link)) throw new SecretariatError('invalid_link', 'Google Meet n’a pas fourni de lien de visio utilisable.');
    return { id: eventId, joinUrl: addMeeting ? link : '' };
  },

  /**
   * Lecture seule des événements du calendrier principal du compte entre deux instants (instances des séries dépliées).
   * Le périmètre `calendar.events` déjà demandé suffit. Événements annulés ignorés.
   * @returns {Promise<Array<{id: string, title: string, startsAt: string, endsAt: string, allDay: boolean, location: string, private: boolean, busy: boolean}>>}
   */
  async listEvents({ http, accessToken, from, to }) {
    const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '250' });
    const res = ensure(await call(http, { method: 'GET', url: `${CAL}?${q}`, headers: { Authorization: `Bearer ${accessToken}` } }), 'Lecture de Google Agenda', [200]);
    const when = (t) => (t?.dateTime ? new Date(t.dateTime) : t?.date ? new Date(`${t.date}T00:00:00Z`) : null);
    return (Array.isArray(res.json?.items) ? res.json.items : []).filter((e) => e && e.status !== 'cancelled').flatMap((e) => {
      const startsAt = when(e.start); const endsAt = when(e.end);
      if (!e.id || !startsAt || !endsAt || Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) return [];
      return [{ id: String(e.id), title: String(e.summary || ''), startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), allDay: Boolean(e.start?.date), location: String(e.location || ''), private: e.visibility === 'private' || e.visibility === 'confidential', busy: e.transparency !== 'transparent' , ...connection(e) }];
    });
  },

  /** Suppression ; 404 et 410 (déjà supprimé) comptent comme réussis. */
  async deleteEvent({ http, accessToken, id }) {
    ensure(await call(http, { method: 'DELETE', url: `${CAL}/${encodeURIComponent(id)}?sendUpdates=none`, headers: { Authorization: `Bearer ${accessToken}` } }), 'Suppression Google Agenda', [200, 204, 404, 410]);
  },
};

/** Pour rejoindre : lien (Meet, sinon un lien de visio du lieu / de la description), numéros d'appel, code de réunion, description. */
function connection(e) {
  const points = Array.isArray(e.conferenceData?.entryPoints) ? e.conferenceData.entryPoints : [];
  const phones = points.filter((p) => p.entryPointType === 'phone').map((p) => dialIn(p.label || p.uri, p.pin)).filter(Boolean).slice(0, 3);
  return {
    joinUrl: safeVideoUrl(meetLink(e)) || videoUrlIn(e.location, e.description),
    dialIn: phones,
    conferenceCode: String(e.conferenceData?.conferenceId || '').replace(/[^\w-]/g, '').slice(0, 40),
    description: plainDescription(e.description),
  };
}

function meetLink(json) {
  const entry = json?.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video');
  return String(entry?.uri || json?.hangoutLink || '');
}
