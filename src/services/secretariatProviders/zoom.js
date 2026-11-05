import { call, ensure, eventWindow, SecretariatError, TIME_ZONE, VIDEO_LINK_RE } from './common.js';

/**
 * Zoom : création de réunions. Points d'accès publics standards ; AUCUN essayé avec un vrai compte : tout est « À VÉRIFIER ».
 * Scopes (noms granulaires, d'après le fichier de prérequis) : meeting:write:meeting, user:read:user [À VÉRIFIER : nom exact du scope de
 * lecture de l'e-mail, et si Zoom exige de les passer dans l'URL d'autorisation ou seulement de les déclarer dans l'application].
 */
const API = 'https://api.zoom.us/v2';

export const zoom = {
  id: 'zoom',
  scopes: ['meeting:write:meeting', 'user:read:user'],
  requiredScopes: [],
  authorizeUrl: () => 'https://zoom.us/oauth/authorize',
  tokenUrl: () => 'https://zoom.us/oauth/token',
  /** Zoom ne reçoit pas de paramètre `scope` à l'autorisation : les scopes sont déclarés dans l'application. */
  authorizeExtra: () => ({}),
  noScopeParam: true,
  /** Basic client_id:client_secret (jamais dans le corps ni dans l'URL). */
  clientAuth: ({ clientId, clientSecret }) => ({ form: {}, headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}` } }),
  refreshExtra: () => ({}),

  async accountEmail({ http, accessToken }) {
    const res = ensure(await call(http, { method: 'GET', url: `${API}/users/me`, headers: { Authorization: `Bearer ${accessToken}` } }), 'Lecture du compte Zoom');
    return String(res.json?.email || '');
  },

  async revoke({ http, credentials, auth }) {
    if (!credentials.accessToken) return;
    await call(http, { method: 'POST', url: 'https://zoom.us/oauth/revoke', headers: auth.headers, form: { token: credentials.accessToken } });
  },

  /** POST /users/me/meetings (type 2 = réunion planifiée). @returns {Promise<{id: string, joinUrl: string}>} */
  async createMeeting({ http, accessToken, event }) {
    const { start, end } = eventWindow(event);
    const body = { topic: event.title, type: 2, start_time: start.toISOString().slice(0, 19) + 'Z', duration: Math.max(1, Math.round((end - start) / 60000)), timezone: TIME_ZONE, agenda: event.description || '' };
    const res = ensure(await call(http, { method: 'POST', url: `${API}/users/me/meetings`, headers: { Authorization: `Bearer ${accessToken}` }, body }), 'Création de la réunion Zoom', [201]);
    const joinUrl = String(res.json?.join_url || '');
    if (res.json?.id === undefined || !VIDEO_LINK_RE.zoom.test(joinUrl)) throw new SecretariatError('invalid_link', 'Zoom n’a pas fourni de lien de visio utilisable.');
    return { id: String(res.json.id), joinUrl };
  },

  async updateMeeting({ http, accessToken, id, event }) {
    const { start, end } = eventWindow(event);
    const body = { topic: event.title, start_time: start.toISOString().slice(0, 19) + 'Z', duration: Math.max(1, Math.round((end - start) / 60000)), timezone: TIME_ZONE };
    ensure(await call(http, { method: 'PATCH', url: `${API}/meetings/${encodeURIComponent(id)}`, headers: { Authorization: `Bearer ${accessToken}` }, body }), 'Mise à jour de la réunion Zoom', [200, 204]);
  },

  async deleteMeeting({ http, accessToken, id }) {
    ensure(await call(http, { method: 'DELETE', url: `${API}/meetings/${encodeURIComponent(id)}`, headers: { Authorization: `Bearer ${accessToken}` } }), 'Suppression de la réunion Zoom', [200, 204, 404]);
  },
};
