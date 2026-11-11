import { CrmError, failFrom } from '../http.js';

/**
 * Adaptateur Microsoft Dynamics 365 (Dataverse Web API v9.2 : tables `contacts` et `phonecalls`).
 * AVERTISSEMENT : documentation officielle (learn.microsoft.com) non joignable depuis l'environnement de développement.
 * Tous les points d'accès sont « À VÉRIFIER ». Identifiants : application Azure AD créée par le centre dans SON tenant
 * (flux « client credentials ») : aucune application HARX n'est nécessaire.
 */
export const dynamicsMeta = {
  id: 'dynamics',
  name: 'Microsoft Dynamics 365',
  fields: [
    { key: 'orgUrl', label: 'Adresse de l’environnement (https://xxx.crm4.dynamics.com)', secret: false },
    { key: 'tenantId', label: 'Identifiant du locataire (tenant)', secret: false },
    { key: 'clientId', label: 'Identifiant de l’application', secret: false },
    { key: 'clientSecret', label: 'Secret de l’application', secret: true },
  ],
  verified: false,
};

const API = '/api/data/v9.2';
const esc = (s) => String(s).replace(/'/g, "''");

export function normalizeOrgUrl(u) {
  let url;
  try { url = new URL(String(u).trim()); } catch { throw new CrmError('Adresse Dynamics invalide.', { retryable: false }); }
  if (url.protocol !== 'https:' || !/\.dynamics\.com$/i.test(url.hostname)) throw new CrmError('L’adresse doit être de la forme https://votre-organisation.crmN.dynamics.com.', { retryable: false });
  return url.origin;
}

export function createDynamicsAdapter(credentials, { http, loginUrl = 'https://login.microsoftonline.com' } = {}) {
  const { orgUrl, tenantId, clientId, clientSecret, accessToken: oauthToken } = credentials || {};
  if (!orgUrl || (!oauthToken && (!tenantId || !clientId || !clientSecret))) throw new CrmError('Identifiants Dynamics incomplets.', { retryable: false });
  const org = normalizeOrgUrl(orgUrl);
  let token = oauthToken || null;

  async function bearer() {
    if (token) return token;
    // À VÉRIFIER : POST login.microsoftonline.com/{tenant}/oauth2/v2.0/token (client_credentials, scope {org}/.default)
    const res = await http({ method: 'POST', url: `${loginUrl}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, form: { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: `${org}/.default` } });
    if (res.status !== 200 || !res.json?.access_token) throw new CrmError('Dynamics : jeton refusé. Vérifiez le tenant, l’identifiant et le secret de l’application.', { status: res.status, retryable: res.status >= 500 });
    token = res.json.access_token;
    return token;
  }
  const call = async (method, path, body, extra = {}) =>
    http({ method, url: `${org}${API}${path}`, headers: { Authorization: `Bearer ${await bearer()}`, 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', ...extra }, body });

  const toRow = (c) => {
    const r = {};
    if (c.firstName) r.firstname = c.firstName;
    r.lastname = c.lastName || c.firstName || c.phone || c.email;
    if (c.email) r.emailaddress1 = c.email;
    if (c.phone) r.telephone1 = c.phone;
    return r;
  };
  const idFromEntityHeader = (h) => /\(([0-9a-f-]{36})\)/i.exec(h?.['odata-entityid'] || '')?.[1] || null;

  return {
    id: 'dynamics',
    async testConnection() {
      const res = await call('GET', '/WhoAmI'); // À VÉRIFIER
      if (res.status === 200) return { ok: true };
      throw failFrom(res, 'Dynamics 365');
    },
    async upsertContact(c) {
      const filter = c.email ? `emailaddress1 eq '${esc(c.email)}'` : c.phone ? `telephone1 eq '${esc(c.phone)}'` : null;
      if (!filter) throw new CrmError('Contact sans e-mail ni téléphone.', { retryable: false });
      const found = await call('GET', `/contacts?$select=contactid&$top=1&$filter=${encodeURIComponent(filter)}`);
      if (found.status !== 200) throw failFrom(found, 'Dynamics 365 (recherche du contact)');
      const existing = found.json?.value?.[0]?.contactid;
      if (existing) {
        const upd = await call('PATCH', `/contacts(${existing})`, toRow(c), { 'If-Match': '*' });
        if (upd.status !== 204 && upd.status !== 200) throw failFrom(upd, 'Dynamics 365 (mise à jour du contact)');
        return { id: existing, created: false };
      }
      const created = await call('POST', '/contacts', toRow(c), { Prefer: 'return=representation' });
      const id = created.json?.contactid || idFromEntityHeader(created.headers);
      if ((created.status !== 201 && created.status !== 204) || !id) throw failFrom(created, 'Dynamics 365 (création du contact)');
      return { id, created: true };
    },
    async logCall(c, contact) {
      const end = new Date(new Date(c.startedAt).getTime() + Math.max(0, c.durationSeconds || 0) * 1000).toISOString();
      const row = {
        subject: c.title,
        description: c.summary || '',
        directioncode: c.direction !== 'inbound', // À VÉRIFIER : true = sortant
        phonenumber: (c.direction === 'inbound' ? c.fromNumber : c.toNumber) || undefined,
        actualstart: c.startedAt,
        actualend: end,
        actualdurationminutes: Math.max(0, Math.round((c.durationSeconds || 0) / 60)),
      };
      if (contact?.id) row['regardingobjectid_contact_phonecall@odata.bind'] = `/contacts(${contact.id})`;
      const created = await call('POST', '/phonecalls', row, { Prefer: 'return=representation' });
      const id = created.json?.activityid || idFromEntityHeader(created.headers);
      if ((created.status !== 201 && created.status !== 204) || !id) throw failFrom(created, 'Dynamics 365 (journal de l’appel)');
      // Une activité naît « ouverte » : on la clôt (À VÉRIFIER : statecode 1 = terminée, statuscode 2 = faite).
      const done = await call('PATCH', `/phonecalls(${id})`, { statecode: 1, statuscode: 2 }, { 'If-Match': '*' });
      if (done.status !== 204 && done.status !== 200) throw failFrom(done, 'Dynamics 365 (clôture de l’appel)');
      return { id };
    },
    /** À VÉRIFIER : GET /contacts?$select&$top, pagination par `@odata.nextLink`. */
    async listContacts({ cursor = null, limit = 100 } = {}) {
      const url = cursor || `${org}${API}/contacts?$select=firstname,lastname,emailaddress1,telephone1,mobilephone&$top=${limit}`;
      if (cursor) {
        let u; try { u = new URL(cursor); } catch { throw new CrmError('Curseur invalide.', { retryable: false }); }
        if (u.origin !== org) throw new CrmError('Curseur invalide.', { retryable: false });
      }
      const res = await http({ method: 'GET', url, headers: { Authorization: `Bearer ${await bearer()}`, 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' } });
      if (res.status !== 200) throw failFrom(res, 'Dynamics 365 (lecture des contacts)');
      return {
        contacts: (res.json?.value || []).map((r) => ({ externalId: String(r.contactid), firstName: r.firstname || '', lastName: r.lastname || '', email: r.emailaddress1 || '', phone: r.telephone1 || r.mobilephone || '' })),
        next: res.json?.['@odata.nextLink'] ?? null,
      };
    },
  };
}
