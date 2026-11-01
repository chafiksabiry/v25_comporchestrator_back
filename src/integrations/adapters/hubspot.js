import { CrmError, failFrom } from '../http.js';

/**
 * Adaptateur HubSpot (API v3, jeton d'application privée).
 * AVERTISSEMENT : la documentation officielle (developers.hubspot.com) n'était pas joignable depuis l'environnement de
 * développement. Chaque point d'accès ci-dessous est écrit de mémoire et marqué « À VÉRIFIER » : aucun n'a été confronté
 * à la documentation ni à un vrai compte HubSpot. Les tests n'utilisent qu'un faux serveur.
 */
export const hubspotMeta = {
  id: 'hubspot',
  name: 'HubSpot',
  fields: [{ key: 'accessToken', label: 'Jeton d’application privée', secret: true }],
  verified: false,
};

const BASE = 'https://api.hubapi.com';
const PROPS = ['firstname', 'lastname', 'email', 'phone', 'mobilephone'];

export function createHubspotAdapter(credentials, { http, baseUrl = BASE } = {}) {
  if (!credentials?.accessToken) throw new CrmError('Jeton HubSpot manquant.', { retryable: false });
  const auth = { Authorization: `Bearer ${credentials.accessToken}` };
  const call = (method, path, body) => http({ method, url: `${baseUrl}${path}`, headers: auth, body });

  const toProps = (c) => {
    const p = {};
    if (c.firstName) p.firstname = c.firstName;
    if (c.lastName) p.lastname = c.lastName;
    if (c.email) p.email = c.email;
    if (c.phone) p.phone = c.phone;
    return p;
  };

  return {
    id: 'hubspot',
    async testConnection() {
      // À VÉRIFIER : GET /crm/v3/objects/contacts?limit=1
      const res = await call('GET', '/crm/v3/objects/contacts?limit=1');
      if (res.status === 200) return { ok: true };
      throw failFrom(res, 'HubSpot');
    },
    async upsertContact(c) {
      const filter = c.email ? { propertyName: 'email', operator: 'EQ', value: c.email } : c.phone ? { propertyName: 'phone', operator: 'EQ', value: c.phone } : null;
      if (!filter) throw new CrmError('Contact sans e-mail ni téléphone.', { retryable: false });
      // À VÉRIFIER : POST /crm/v3/objects/contacts/search
      const found = await call('POST', '/crm/v3/objects/contacts/search', { filterGroups: [{ filters: [filter] }], properties: ['email'], limit: 1 });
      if (found.status !== 200) throw failFrom(found, 'HubSpot (recherche du contact)');
      const existing = found.json?.results?.[0];
      if (existing?.id) {
        // À VÉRIFIER : PATCH /crm/v3/objects/contacts/{id}
        const upd = await call('PATCH', `/crm/v3/objects/contacts/${encodeURIComponent(existing.id)}`, { properties: toProps(c) });
        if (upd.status !== 200) throw failFrom(upd, 'HubSpot (mise à jour du contact)');
        return { id: String(existing.id), created: false };
      }
      // À VÉRIFIER : POST /crm/v3/objects/contacts
      const created = await call('POST', '/crm/v3/objects/contacts', { properties: toProps(c) });
      if (created.status !== 201 || !created.json?.id) throw failFrom(created, 'HubSpot (création du contact)');
      return { id: String(created.json.id), created: true };
    },
    async logCall(c, contact) {
      // À VÉRIFIER : objet « calls » ; hs_call_duration en millisecondes ; type d'association 194 (appel -> contact).
      const properties = {
        hs_timestamp: c.startedAt,
        hs_call_title: c.title,
        hs_call_body: c.summary || '',
        hs_call_duration: String(Math.max(0, Math.round(c.durationSeconds || 0)) * 1000),
        hs_call_direction: c.direction === 'inbound' ? 'INBOUND' : 'OUTBOUND',
        hs_call_status: 'COMPLETED',
      };
      if (c.fromNumber) properties.hs_call_from_number = c.fromNumber;
      if (c.toNumber) properties.hs_call_to_number = c.toNumber;
      const body = { properties };
      if (contact?.id) body.associations = [{ to: { id: contact.id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 194 }] }];
      const res = await call('POST', '/crm/v3/objects/calls', body);
      if (res.status !== 201) throw failFrom(res, 'HubSpot (journal de l’appel)');
      return { id: String(res.json?.id ?? '') };
    },
    /** Import : page de contacts. À VÉRIFIER : GET /crm/v3/objects/contacts?limit&after&properties. */
    async listContacts({ cursor = null, limit = 100 } = {}) {
      const q = new URLSearchParams({ limit: String(limit), properties: PROPS.join(',') });
      if (cursor) q.set('after', cursor);
      const res = await call('GET', `/crm/v3/objects/contacts?${q}`);
      if (res.status !== 200) throw failFrom(res, 'HubSpot (lecture des contacts)');
      return {
        contacts: (res.json?.results || []).map((r) => ({ externalId: String(r.id), firstName: r.properties?.firstname || '', lastName: r.properties?.lastname || '', email: r.properties?.email || '', phone: r.properties?.phone || r.properties?.mobilephone || '' })),
        next: res.json?.paging?.next?.after ?? null,
      };
    },
  };
}
