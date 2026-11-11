import { CrmError, failFrom } from '../http.js';

/**
 * Adaptateur Zoho CRM (API REST v6, module Contacts et Calls).
 * AVERTISSEMENT : documentation officielle (zoho.com/crm/developer) non joignable depuis l'environnement de développement.
 * Tous les points d'accès sont « À VÉRIFIER ». Les identifiants sont ceux d'un « Self Client » créé par le centre dans sa
 * propre console Zoho (identifiant client, secret, jeton de rafraîchissement) : aucune application HARX n'est nécessaire.
 */
export const zohoMeta = {
  id: 'zoho',
  name: 'Zoho CRM',
  fields: [
    { key: 'clientId', label: 'Identifiant client', secret: false },
    { key: 'clientSecret', label: 'Secret client', secret: true },
    { key: 'refreshToken', label: 'Jeton de rafraîchissement', secret: true },
    { key: 'region', label: 'Région du compte (eu, com, in, com.au, jp)', secret: false, options: ['eu', 'com', 'in', 'com.au', 'jp'] },
  ],
  verified: false,
};

const REGIONS = ['eu', 'com', 'in', 'com.au', 'jp'];
export const zohoAccountsUrl = (region) => `https://accounts.zoho.${REGIONS.includes(region) ? region : 'eu'}`;
export const zohoApiUrl = (region) => `https://www.zohoapis.${REGIONS.includes(region) ? region : 'eu'}`;

const pad = (n) => String(n).padStart(2, '0');
/** Zoho attend une durée « mm:ss » (À VÉRIFIER). */
export const zohoDuration = (s) => `${pad(Math.floor((s || 0) / 60))}:${pad(Math.round(s || 0) % 60)}`;

export function createZohoAdapter(credentials, { http } = {}) {
  const { clientId, clientSecret, refreshToken, region } = credentials || {};
  if (!clientId || !clientSecret || !refreshToken) throw new CrmError('Identifiants Zoho incomplets.', { retryable: false });
  const api = zohoApiUrl(region);
  let token = null;

  async function accessToken() {
    if (token) return token;
    // À VÉRIFIER : POST {accounts}/oauth/v2/token (grant_type=refresh_token)
    const res = await http({ method: 'POST', url: `${zohoAccountsUrl(region)}/oauth/v2/token`, form: { grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken } });
    if (res.status !== 200 || !res.json?.access_token) {
      throw new CrmError('Zoho : jeton refusé. Vérifiez l’identifiant, le secret, le jeton de rafraîchissement et la région.', { status: res.status, retryable: res.status >= 500 });
    }
    token = res.json.access_token;
    return token;
  }
  const call = async (method, path, body) => http({ method, url: `${api}${path}`, headers: { Authorization: `Zoho-oauthtoken ${await accessToken()}` }, body });

  return {
    id: 'zoho',
    async testConnection() {
      const res = await call('GET', '/crm/v6/Contacts?fields=id&per_page=1');
      // 204 : module vide, connexion valide.
      if (res.status === 200 || res.status === 204) return { ok: true };
      throw failFrom(res, 'Zoho CRM');
    },
    async upsertContact(c) {
      if (!c.email && !c.phone) throw new CrmError('Contact sans e-mail ni téléphone.', { retryable: false });
      const record = { Last_Name: c.lastName || c.firstName || c.phone || c.email };
      if (c.lastName && c.firstName) record.First_Name = c.firstName;
      if (c.email) record.Email = c.email;
      if (c.phone) record.Phone = c.phone;
      // À VÉRIFIER : POST /crm/v6/Contacts/upsert avec duplicate_check_fields
      const res = await call('POST', '/crm/v6/Contacts/upsert', { data: [record], duplicate_check_fields: [c.email ? 'Email' : 'Phone'] });
      const row = res.json?.data?.[0];
      if ((res.status !== 200 && res.status !== 201) || row?.code !== 'SUCCESS' || !row?.details?.id) throw failFrom(res.status < 400 ? { status: 422, json: { message: row?.message } } : res, 'Zoho CRM (contact)');
      return { id: String(row.details.id), created: row.action === 'insert' };
    },
    async logCall(c, contact) {
      // À VÉRIFIER : module Calls, champs Subject, Call_Type, Call_Start_Time, Call_Duration (mm:ss), Who_Id.
      const record = {
        Subject: c.title,
        Call_Type: c.direction === 'inbound' ? 'Inbound' : 'Outbound',
        Call_Start_Time: c.startedAt,
        Call_Duration: zohoDuration(c.durationSeconds),
        Description: c.summary || '',
      };
      if (contact?.id) record.Who_Id = { id: contact.id };
      const res = await call('POST', '/crm/v6/Calls', { data: [record] });
      const row = res.json?.data?.[0];
      if ((res.status !== 200 && res.status !== 201) || row?.code !== 'SUCCESS') throw failFrom(res.status < 400 ? { status: 422, json: { message: row?.message } } : res, 'Zoho CRM (journal de l’appel)');
      return { id: String(row.details?.id ?? '') };
    },
    /** À VÉRIFIER : GET /crm/v6/Contacts?fields&page&per_page ; `info.more_records`. */
    async listContacts({ cursor = null, limit = 100 } = {}) {
      const page = Number(cursor) || 1;
      const res = await call('GET', `/crm/v6/Contacts?fields=First_Name,Last_Name,Email,Phone,Mobile&per_page=${limit}&page=${page}`);
      if (res.status === 204) return { contacts: [], next: null };
      if (res.status !== 200) throw failFrom(res, 'Zoho CRM (lecture des contacts)');
      return {
        contacts: (res.json?.data || []).map((r) => ({ externalId: String(r.id), firstName: r.First_Name || '', lastName: r.Last_Name || '', email: r.Email || '', phone: r.Phone || r.Mobile || '' })),
        next: res.json?.info?.more_records ? String(page + 1) : null,
      };
    },
  };
}
