import { isValidEmail } from './payload.js';

/**
 * Client Zoho minimal : SalesIQ (rappel de réponse différée, notes internes, recherche de conversation) et CRM
 * (LECTURE SEULE : une seule méthode, la recherche de deals). Un jeton OAuth de rafraîchissement unique, mis en cache.
 * Scopes à demander : SalesIQ.callbacks.UPDATE, SalesIQ.conversations.READ, SalesIQ.conversations.CREATE,
 * SalesIQ.conversations.UPDATE, ZohoCRM.modules.deals.READ.
 */
export function createZohoClient({ cfg, fetchImpl = globalThis.fetch, now = () => Date.now(), logger = console }) {
  const z = cfg.zoho;
  let token = null;
  let expiresAt = 0;

  async function refreshToken() {
    if (!z.clientId || !z.clientSecret || !z.refreshToken) throw new Error('Zoho OAuth is not configured');
    const body = new URLSearchParams({
      refresh_token: z.refreshToken, client_id: z.clientId, client_secret: z.clientSecret, grant_type: 'refresh_token',
    });
    const res = await fetchImpl(`${z.accountsUrl}/oauth/v2/token`, { method: 'POST', body });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) throw new Error(`Zoho token refresh failed (${res.status}${json.error ? `: ${json.error}` : ''})`);
    token = json.access_token;
    expiresAt = now() + Math.max(60, Number(json.expires_in || 3600) - 120) * 1000;
    return token;
  }

  async function getToken() {
    return token && now() < expiresAt ? token : refreshToken();
  }

  async function request(method, url, { json } = {}) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const t = await getToken();
      const res = await fetchImpl(url, {
        method,
        headers: { Authorization: `Zoho-oauthtoken ${t}`, ...(json ? { 'Content-Type': 'application/json' } : {}) },
        body: json ? JSON.stringify(json) : undefined,
      });
      if (res.status === 401 && attempt === 0) { token = null; continue; }
      if (res.status === 204) return { status: 204, data: null };
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(`Zoho ${method} ${new URL(url).pathname} -> ${res.status}`);
      return { status: res.status, data };
    }
    throw new Error('Zoho request failed after token refresh');
  }

  const siq = (path) => `${z.salesiqUrl}/api/v2/${encodeURIComponent(cfg.screenname)}${path}`;
  const num = (s) => /^\d{1,19}$/.test(String(s || ''));

  return {
    /** Livre la réponse finale d'une action « pending » (valable 3 minutes après la requête du bot). */
    async callbackResponse(requestId, payload) {
      if (!requestId) throw new Error('missing request id');
      await request('POST', siq(`/callbacks/${encodeURIComponent(requestId)}/response`), { json: payload });
    },

    async addNote(conversationId, text) {
      if (!num(conversationId)) throw new Error('invalid conversation id');
      await request('POST', siq(`/conversations/${conversationId}/notes`), { json: { notes: String(text).slice(0, 4000) } });
    },

    /** Vrai si l'identifiant est une conversation SalesIQ existante, et (si connus des deux côtés) du même visiteur. */
    async verifyConversation(conversationId, email = null) {
      if (!num(conversationId)) return false;
      try {
        const { data } = await request('GET', siq(`/conversations/${conversationId}`));
        const conv = data?.data || data || {};
        if (!conv.id) return false;
        const theirs = String(conv.visitor?.email || '').toLowerCase();
        return !(email && theirs && theirs !== email);
      } catch {
        return false;
      }
    },

    /** Retrouve la conversation active du visiteur (le webhook ne la donne pas toujours). */
    async findConversationId({ email, visitorId, visitorUuid } = {}) {
      const qs = new URLSearchParams({ sort_by: 'updated_time', sort_order: 'desc', limit: '10', fields: 'id,visitor,chat_status' });
      const { data } = await request('GET', `${siq('/conversations')}?${qs}`);
      const rows = data?.data || [];
      const hit = rows.find((c) => {
        const v = c.visitor || {};
        return (visitorId && String(v.id) === String(visitorId)) || (visitorUuid && v.uuid === visitorUuid)
          || (email && String(v.email || '').toLowerCase() === email);
      });
      return hit?.id ? String(hit.id) : null;
    },

    /** Deals du pipeline REPS dont le nom est l'email du candidat. LECTURE SEULE. */
    async findDeals(email) {
      if (!isValidEmail(email)) return [];
      const criteria = `(Deal_Name:equals:${email})`;
      const qs = new URLSearchParams({ criteria, fields: 'Deal_Name,Stage,Pipeline,Modified_Time', per_page: '10' });
      const { status, data } = await request('GET', `${z.crmUrl}/crm/v6/Deals/search?${qs}`);
      if (status === 204 || !data?.data) return [];
      return data.data.filter((d) => String(d.Pipeline || '') === z.crmPipeline)
        .map((d) => ({ stage: String(d.Stage || ''), modified: d.Modified_Time || '' }))
        .sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
    },
  };
}

/** Étape documentée dans pipeline.md (1 à 5) d'après le libellé CRM, ou null si l'étape n'est pas documentée. */
export function stepFromStage(stage) {
  const s = String(stage || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  if (s === 'reps inscrits') return 1;
  if (s === 'completed profile') return 2;
  if (s === 'inscrit au projets' || s === 'inscrit aux projets') return 3;
  if (s === 'mock calls') return 4;
  if (s === 'mock calls valide par le client') return 5;
  return null;
}
