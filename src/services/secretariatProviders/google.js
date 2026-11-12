import { randomUUID } from 'node:crypto';
import { call, ensure, eventWindow, READ_SCOPE, WRITE_SCOPE, SecretariatError, VIDEO_LINK_RE } from './common.js';
import { dialIn, plainDescription, safeVideoUrl, videoUrlIn } from './eventConnection.js';
import { cleanSnippet, cleanSubject, htmlToText, limitBody, parseAddress, stripQuoted } from './mailText.js';
import { DEFAULT_TIME_ZONE } from '../timeZone.js';
import { buildMime, toBase64Url } from './mime.js';

/**
 * Google : Gmail (envoi), Agenda (événements), Meet (via un événement). Tous les points d'accès ci-dessous sont les points
 * publics standards ; AUCUN n'a été essayé avec un vrai compte (aucun identifiant n'existe encore) : tout est « À VÉRIFIER » en recette.
 */
const SCOPE_GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send';
/** Partie HTML d'un message renvoyée à l'application (mise en page) : plafond en caractères. */
const MAX_HTML = 400_000;
const SCOPE_CALENDAR = 'https://www.googleapis.com/auth/calendar.events';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

export const google = {
  id: 'google',
  scopes: ['openid', 'email', SCOPE_GMAIL_SEND, SCOPE_CALENDAR],
  /** Scopes sans lesquels la connexion est inutilisable (l'utilisateur peut en décocher à l'écran de consentement). */
  requiredScopes: [SCOPE_GMAIL_SEND, SCOPE_CALENDAR],
  /** Lecture de la boîte de réception (e-mails entrants) : OPTIONNEL, demandé seulement avec `read: true`. */
  readScope: READ_SCOPE.google,
  /** Écriture (corbeille / archivage) : OPTIONNEL, demandé seulement avec `write: true`. Inclut la lecture. */
  writeScope: WRITE_SCOPE.google,
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

  /**
   * E-mails ENTRANTS (scope gmail.readonly) : messages récents de la boîte de réception. `users.messages.list` (q « in:inbox newer_than:7d »)
   * puis `get` format=metadata (en-têtes From / Subject / Date + extrait) : AUCUN corps n'est lu ici. Un message disparu entre-temps (404) est ignoré.
   * [À VÉRIFIER en recette avec un vrai compte : format des en-têtes, limites de débit, comportement du scope restreint gmail.readonly.]
   * @returns {Promise<Array<{id: string, fromName: string, fromEmail: string, subject: string, receivedAt: Date, snippet: string}>>}
   */
  async listInbox({ http, accessToken, limit = 25 }) {
    const headers = { Authorization: `Bearer ${accessToken}` };
    const q = new URLSearchParams({ q: 'in:inbox newer_than:7d', maxResults: String(limit) });
    const list = ensure(await call(http, { method: 'GET', url: `${GMAIL}/messages?${q}`, headers }), 'Lecture de la boîte Gmail', [200]);
    const ids = (Array.isArray(list.json?.messages) ? list.json.messages : []).map((m) => String(m?.id || '')).filter(Boolean).slice(0, limit);
    const out = [];
    for (let i = 0; i < ids.length; i += 5) {
      const rows = await Promise.all(ids.slice(i, i + 5).map(async (id) => {
        const res = ensure(await call(http, { method: 'GET', url: `${GMAIL}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, headers }), 'Lecture d’un message Gmail', [200, 404]);
        return res.status === 404 ? null : { id, json: res.json };
      }));
      for (const row of rows) {
        if (!row) continue;
        const h = (name) => String((row.json?.payload?.headers || []).find((x) => String(x?.name).toLowerCase() === name)?.value || '');
        const from = parseAddress(h('from'));
        const ms = Number(row.json?.internalDate);
        const date = Number.isFinite(ms) && ms > 0 ? new Date(ms) : new Date(h('date'));
        out.push({ id: row.id, fromName: from.name, fromEmail: from.email, subject: cleanSubject(h('subject')), receivedAt: Number.isNaN(date.getTime()) ? new Date() : date, snippet: cleanSnippet(row.json?.snippet) });
      }
    }
    return out;
  },

  /** Corps d'un message lu EN DIRECT (format=full) : texte brut de préférence, sinon HTML nettoyé en texte ; citations retirées, 20 000 caractères max. Jamais stocké. */
  async readBody(args) {
    return (await google.readBodyFull(args)).text;
  },

  /**
   * Même lecture, avec en plus la partie HTML d'origine (mise en page et design du message, 400 000 caractères max) : l'application l'affiche dans un cadre
   * isolé (sans script, images distantes bloquées tant que l'utilisateur ne les demande pas). Jamais stocké.
   */
  async readBodyFull({ http, accessToken, id }) {
    const res = ensure(await call(http, { method: 'GET', url: `${GMAIL}/messages/${encodeURIComponent(id)}?format=full`, headers: { Authorization: `Bearer ${accessToken}` } }), 'Lecture d’un message Gmail', [200]);
    const plain = []; const html = [];
    const walk = (part, depth = 0) => {
      if (!part || typeof part !== 'object' || depth > 12) return;
      const type = String(part.mimeType || '').toLowerCase();
      if (!part.filename && typeof part.body?.data === 'string' && part.body.data) {
        const text = Buffer.from(part.body.data, 'base64url').toString('utf8');
        if (type === 'text/plain') plain.push(text); else if (type === 'text/html') html.push(text);
      }
      for (const p of Array.isArray(part.parts) ? part.parts : []) walk(p, depth + 1);
    };
    walk(res.json?.payload);
    const text = limitBody(stripQuoted(plain.length ? plain.join('\n') : htmlToText(html.join('\n'))));
    const htmlOut = html.join('\n').slice(0, MAX_HTML);
    return htmlOut.trim() ? { text, html: htmlOut } : { text };
  },

  /**
   * Mise à la CORBEILLE (réversible, jamais de suppression définitive) : `users.messages.trash`. 404 (message déjà absent) = réussi. Scope gmail.modify.
   * [À VÉRIFIER en recette avec un vrai compte.]
   */
  async trashMessage({ http, accessToken, id }) {
    ensure(await call(http, { method: 'POST', url: `${GMAIL}/messages/${encodeURIComponent(id)}/trash`, headers: { Authorization: `Bearer ${accessToken}` } }), 'Mise à la corbeille Gmail', [200, 404]);
    return { id: null };
  },

  /** Archivage = retrait du libellé INBOX (`users.messages.modify`) ; désarchivage = ajout de INBOX. 404 = réussi. L'identifiant Gmail ne change pas. */
  async setArchived({ http, accessToken, id, archived }) {
    const body = archived ? { removeLabelIds: ['INBOX'] } : { addLabelIds: ['INBOX'] };
    ensure(await call(http, { method: 'POST', url: `${GMAIL}/messages/${encodeURIComponent(id)}/modify`, headers: { Authorization: `Bearer ${accessToken}` }, body }), 'Archivage Gmail', [200, 404]);
    return { id: null };
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
