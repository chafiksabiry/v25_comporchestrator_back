import mongoose from 'mongoose';
import { callerAccess, ScopeError } from '../middleware/companyScope.js';
import IntegrationConnection from '../models/IntegrationConnection.js';
import IntegrationJob from '../models/IntegrationJob.js';
import ApiKey from '../models/ApiKey.js';
import WebhookEndpoint from '../models/WebhookEndpoint.js';
import { PROVIDERS, cleanCredentials, createAdapter } from '../integrations/adapters/index.js';
import { encryptJson, decryptJson, integrationsEnabled, loadKey } from '../integrations/crypto.js';
import { generateApiKey } from '../integrations/apiKeys.js';
import { generateWebhookSecret } from '../integrations/webhookSign.js';
import { checkWebhookUrl } from '../integrations/urlGuard.js';
import { connectionContext, safeMessage, webhookContext } from '../integrations/engine.js';
import { companyHasIntegrations, realDeps } from '../integrations/runtime.js';
import { defaultHttp } from '../integrations/http.js';
import { finishZohoOAuth, oauthStatus, startZohoOAuth } from '../integrations/oauth.js';
import { callCenterData } from '../integrations/centerData.js';
import { buildCallEvent } from '../integrations/events.js';
import { signPayload } from '../integrations/webhookSign.js';

const fail = (res, status, message, error = 'error') => res.status(status).json({ success: false, error, message });
const MAX_KEYS = 10;
const MAX_WEBHOOKS = 5;
const oid = (v) => (/^[0-9a-fA-F]{24}$/.test(String(v)) ? new mongoose.Types.ObjectId(String(v)) : null);

/** Droit de gérer les intégrations : titulaire, ou membre à qui le droit `integrations.manage` a été donné. Jamais un agent. */
export const canManageIntegrations = (access) => access.role === 'owner' || (access.role === 'member' && access.permissions?.['integrations.manage'] === true);

/** Contexte commun : droits, centre, forfait (groupe H) et clé de chiffrement. Répond lui-même et renvoie null en cas de refus. */
export async function context(req, res, { needKey = true } = {}) {
  let access;
  try { access = await callerAccess(req); } catch (e) {
    if (e instanceof ScopeError) { fail(res, e.status, e.message); return null; }
    throw e;
  }
  if (!access.companyId) { fail(res, 403, 'Aucun centre rattaché à votre compte.'); return null; }
  const asked = req.query?.companyId ?? req.body?.companyId;
  if (asked && String(asked) !== access.companyId) { fail(res, 403, 'Ce centre n’est pas le vôtre.'); return null; }
  if (!canManageIntegrations(access)) { fail(res, 403, 'Vous n’avez pas accès aux intégrations.', 'forbidden'); return null; }
  if (!(await companyHasIntegrations(access.companyId))) { fail(res, 403, 'Les intégrations ne sont pas incluses dans votre forfait (Full Scope ou Multi-clients).', 'plan_required'); return null; }
  if (needKey && !integrationsEnabled()) { fail(res, 503, 'Les intégrations ne sont pas encore activées sur ce serveur.', 'integrations_disabled'); return null; }
  return access;
}

const connView = (c) => c && ({ provider: c.provider, enabled: c.enabled, status: c.status, lastTestAt: c.lastTestAt, lastError: c.lastError, hasCredentials: true });
const keyView = (k) => ({ id: String(k._id), name: k.name, prefix: k.prefix, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt, revoked: !!k.revokedAt });
const hookView = (h) => ({ id: String(h._id), url: h.url, events: h.events, enabled: h.enabled, secretHint: h.secretHint });
const jobView = (j) => ({ id: String(j._id), kind: j.kind, ref: j.ref, status: j.status, attempts: j.attempts, lastError: j.lastError, nextAttemptAt: j.nextAttemptAt, createdAt: j.createdAt });

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    console.error(`[integrations] ${req.method} ${req.path}:`, e.message);
    fail(res, 500, 'Opération impossible pour le moment.');
  }
};

export const integrationsController = {
  state: wrap(async (req, res) => {
    const access = await context(req, res, { needKey: false });
    if (!access) return;
    const cid = oid(access.companyId);
    const [conn, keys, hooks, jobs, pending] = await Promise.all([
      IntegrationConnection.findOne({ companyId: cid }), ApiKey.find({ companyId: cid }).sort({ createdAt: -1 }).limit(50),
      WebhookEndpoint.find({ companyId: cid }).sort({ createdAt: -1 }), IntegrationJob.find({ companyId: cid, $or: [{ lastError: { $ne: '' } }, { status: 'dead' }] }).sort({ updatedAt: -1 }).limit(30),
      IntegrationJob.countDocuments({ companyId: cid, status: 'pending' }),
    ]);
    res.json({ success: true, data: {
      enabled: integrationsEnabled(),
      providers: Object.values(PROVIDERS).map((p) => ({ id: p.meta.id, name: p.meta.name, fields: p.meta.fields.map(({ key, label, secret, options }) => ({ key, label, secret, options })), verified: p.meta.verified, oauth: oauthStatus(p.meta.id) })),
      connection: connView(conn), apiKeys: keys.map(keyView), webhooks: hooks.map(hookView), journal: jobs.map(jobView), pending,
    } });
  }),

  saveConnection: wrap(async (req, res) => {
    const access = await context(req, res);
    if (!access) return;
    const { provider } = req.body || {};
    const clean = cleanCredentials(provider, req.body?.credentials);
    if (clean.error) return fail(res, 400, clean.error);
    const enc = encryptJson(clean.value, { context: connectionContext(access.companyId, provider) });
    // Nouveaux identifiants : désactivés jusqu'à un test réussi.
    const conn = await IntegrationConnection.findOneAndUpdate({ companyId: oid(access.companyId) }, { $set: { provider, credentialsEnc: enc, enabled: false, status: 'untested', lastError: '', lastTestAt: null, updatedBy: access.userId } }, { upsert: true, new: true, setDefaultsOnInsert: true });
    res.json({ success: true, data: connView(conn) });
  }),

  testConnection: wrap(async (req, res) => {
    const access = await context(req, res);
    if (!access) return;
    const conn = await IntegrationConnection.findOne({ companyId: oid(access.companyId) });
    if (!conn) return fail(res, 404, 'Aucune connexion enregistrée.');
    let ok = false; let error = '';
    try {
      const creds = decryptJson(conn.credentialsEnc, { context: connectionContext(access.companyId, conn.provider) });
      await createAdapter(conn.provider, creds, { http: realDeps().http }).testConnection();
      ok = true;
    } catch (e) { error = safeMessage(e); }
    conn.status = ok ? 'ok' : 'error'; conn.lastError = error; conn.lastTestAt = new Date();
    if (!ok) conn.enabled = false;
    await conn.save();
    res.json({ success: true, data: { ok, message: ok ? 'Connexion réussie.' : error, connection: connView(conn) } });
  }),

  setEnabled: wrap(async (req, res) => {
    const access = await context(req, res);
    if (!access) return;
    const conn = await IntegrationConnection.findOne({ companyId: oid(access.companyId) });
    if (!conn) return fail(res, 404, 'Aucune connexion enregistrée.');
    const enabled = req.body?.enabled === true;
    if (enabled && conn.status !== 'ok') return fail(res, 409, 'Testez la connexion avant de l’activer.');
    conn.enabled = enabled;
    await conn.save();
    res.json({ success: true, data: connView(conn) });
  }),

  removeConnection: wrap(async (req, res) => {
    const access = await context(req, res);
    if (!access) return;
    await IntegrationConnection.deleteOne({ companyId: oid(access.companyId) });
    await IntegrationJob.updateMany({ companyId: oid(access.companyId), kind: 'crm_call', status: 'pending' }, { $set: { status: 'dead', lastError: 'Connexion supprimée.' } });
    res.json({ success: true });
  }),

  journal: wrap(async (req, res) => {
    const access = await context(req, res, { needKey: false });
    if (!access) return;
    const jobs = await IntegrationJob.find({ companyId: oid(access.companyId) }).sort({ createdAt: -1 }).limit(50);
    res.json({ success: true, data: { items: jobs.map(jobView) } });
  }),

  retryJob: wrap(async (req, res) => {
    const access = await context(req, res);
    if (!access) return;
    const id = oid(req.params.id);
    const job = id && await IntegrationJob.findOne({ _id: id, companyId: oid(access.companyId) });
    if (!job) return fail(res, 404, 'Tâche introuvable.');
    if (job.status === 'done') return fail(res, 409, 'Cette tâche est déjà réussie.');
    job.status = 'pending'; job.attempts = 0; job.nextAttemptAt = new Date();
    await job.save();
    res.json({ success: true, data: jobView(job) });
  }),

  createApiKey: wrap(async (req, res) => {
    const access = await context(req, res, { needKey: false });
    if (!access) return;
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 80) : '';
    if (!name) return fail(res, 400, 'Donnez un nom à la clé.');
    if ((await ApiKey.countDocuments({ companyId: oid(access.companyId), revokedAt: null })) >= MAX_KEYS) return fail(res, 409, `Au maximum ${MAX_KEYS} clés actives.`);
    const { key, hash, prefix } = generateApiKey();
    const row = await ApiKey.create({ companyId: oid(access.companyId), name, hash, prefix, createdBy: access.userId });
    // La clé en clair n'est renvoyée QUE ici, une seule fois.
    res.status(201).json({ success: true, data: { ...keyView(row), key } });
  }),

  revokeApiKey: wrap(async (req, res) => {
    const access = await context(req, res, { needKey: false });
    if (!access) return;
    const id = oid(req.params.id);
    const row = id && await ApiKey.findOneAndUpdate({ _id: id, companyId: oid(access.companyId), revokedAt: null }, { $set: { revokedAt: new Date() } }, { new: true });
    if (!row) return fail(res, 404, 'Clé introuvable ou déjà révoquée.');
    res.json({ success: true, data: keyView(row) });
  }),

  createWebhook: wrap(async (req, res) => {
    const access = await context(req, res);
    if (!access) return;
    const url = checkWebhookUrl(req.body?.url);
    if (url.error) return fail(res, 400, url.error);
    if ((await WebhookEndpoint.countDocuments({ companyId: oid(access.companyId) })) >= MAX_WEBHOOKS) return fail(res, 409, `Au maximum ${MAX_WEBHOOKS} webhooks.`);
    const secret = generateWebhookSecret();
    const row = await WebhookEndpoint.create({ companyId: oid(access.companyId), url: url.value, secretEnc: encryptJson({ secret }, { context: webhookContext(access.companyId) }), secretHint: `…${secret.slice(-4)}`, events: ['call.completed'] });
    res.status(201).json({ success: true, data: { ...hookView(row), secret } });
  }),

  patchWebhook: wrap(async (req, res) => {
    const access = await context(req, res, { needKey: false });
    if (!access) return;
    const id = oid(req.params.id);
    if (typeof req.body?.enabled !== 'boolean') return fail(res, 400, 'Indiquez enabled.');
    const row = id && await WebhookEndpoint.findOneAndUpdate({ _id: id, companyId: oid(access.companyId) }, { $set: { enabled: req.body.enabled } }, { new: true });
    if (!row) return fail(res, 404, 'Webhook introuvable.');
    res.json({ success: true, data: hookView(row) });
  }),

  deleteWebhook: wrap(async (req, res) => {
    const access = await context(req, res, { needKey: false });
    if (!access) return;
    const id = oid(req.params.id);
    const row = id && await WebhookEndpoint.findOneAndDelete({ _id: id, companyId: oid(access.companyId) });
    if (!row) return fail(res, 404, 'Webhook introuvable.');
    await IntegrationJob.updateMany({ kind: 'webhook', targetId: String(row._id), status: 'pending' }, { $set: { status: 'dead', lastError: 'Webhook supprimé.' } });
    res.json({ success: true });
  }),

  /** Envoie un événement d'essai signé (`call.test`) : le centre vérifie sa réception et sa signature. */
  testWebhook: wrap(async (req, res) => {
    const access = await context(req, res);
    if (!access) return;
    const id = oid(req.params.id);
    const row = id && await WebhookEndpoint.findOne({ _id: id, companyId: oid(access.companyId) });
    if (!row) return fail(res, 404, 'Webhook introuvable.');
    const deps = realDeps();
    const event = { ...buildCallEvent(access.companyId, { sid: 'test', status: 'completed', direction: 'outbound', duration: 0 }), type: 'call.test' };
    const body = JSON.stringify(event);
    let message = 'Livraison réussie.'; let ok = true;
    try {
      const { assertResolvesPublic } = await import('../integrations/urlGuard.js');
      if (!(await assertResolvesPublic(row.url))) throw new Error('privée');
      const secret = decryptJson(row.secretEnc, { context: webhookContext(access.companyId), key: loadKey() }).secret;
      const r = await deps.http({ method: 'POST', url: row.url, body, timeoutMs: 10000, headers: { 'X-Harx-Event': event.type, 'X-Harx-Signature': signPayload(secret, body) } });
      if (r.status < 200 || r.status >= 300) { ok = false; message = `Le destinataire a répondu ${r.status}.`; }
    } catch { ok = false; message = 'Destinataire injoignable ou adresse non publique.'; }
    res.json({ success: true, data: { ok, message } });
  }),

  /** Import de contacts du CRM vers les prospects d'une opération (le service des appels écrit dans la collection des prospects). */
  importContacts: wrap(async (req, res) => {
    const access = await context(req, res);
    if (!access) return;
    const gigId = String(req.body?.gigId || '');
    if (!oid(gigId)) return fail(res, 400, 'Choisissez une opération.');
    const conn = await IntegrationConnection.findOne({ companyId: oid(access.companyId) });
    if (!conn || !conn.enabled) return fail(res, 409, 'Activez d’abord la connexion au CRM.');
    const max = Math.min(2000, Math.max(1, Math.floor(Number(req.body?.max)) || 500));
    const adapter = createAdapter(conn.provider, decryptJson(conn.credentialsEnc, { context: connectionContext(access.companyId, conn.provider) }), { http: realDeps().http });
    const contacts = []; let cursor = null;
    try {
      do {
        const page = await adapter.listContacts({ cursor, limit: 100 });
        contacts.push(...page.contacts);
        cursor = page.next;
      } while (cursor && contacts.length < max);
    } catch (e) { return fail(res, 502, safeMessage(e)); }
    const usable = contacts.slice(0, max).filter((c) => c.phone || c.email);
    const total = { created: 0, skipped: 0 };
    try {
      // Par lots : le service des appels limite la taille des corps reçus.
      for (let i = 0; i < usable.length; i += 200) {
        const r = await callCenterData(`/${access.companyId}/leads/import`, { method: 'POST', body: { gigId, source: conn.provider, contacts: usable.slice(i, i + 200) } });
        total.created += r?.data?.created ?? 0;
        total.skipped += r?.data?.skipped ?? 0;
      }
    } catch (e) { return fail(res, e.status === 404 ? 404 : 502, e.status === 404 ? 'Opération introuvable pour ce centre.' : 'Import impossible pour le moment.'); }
    res.json({ success: true, data: { read: contacts.length, usable: usable.length, created: total.created, skipped: total.skipped } });
  }),

  oauthStart: wrap(async (req, res) => {
    const access = await context(req, res);
    if (!access) return;
    const { provider } = req.params;
    if (provider !== 'zoho' || !oauthStatus('zoho').available) return fail(res, 501, 'La connexion en un clic n’est pas encore disponible : utilisez vos identifiants.', 'oauth_not_configured');
    res.json({ success: true, data: { url: startZohoOAuth({ companyId: access.companyId, userId: access.userId, region: String(req.query.region || 'eu') }) } });
  }),

  /** Retour de Zoho : appelé par le navigateur, sans jeton utilisateur ; l'état signé identifie le centre. */
  oauthCallback: async (req, res) => {
    const back = (status) => process.env.INTEGRATIONS_RETURN_URL ? res.redirect(`${process.env.INTEGRATIONS_RETURN_URL}${process.env.INTEGRATIONS_RETURN_URL.includes('?') ? '&' : '?'}integration=zoho&status=${status}`) : res.status(status === 'ok' ? 200 : 400).json({ success: status === 'ok' });
    try {
      if (req.params.provider !== 'zoho' || !oauthStatus('zoho').available || !integrationsEnabled()) return fail(res, 501, 'OAuth non configuré.', 'oauth_not_configured');
      if (req.query.error || !req.query.code) return back('refused');
      const out = await finishZohoOAuth({ code: req.query.code, state: req.query.state }, { http: defaultHttp });
      if (!(await companyHasIntegrations(out.companyId))) return back('plan');
      await IntegrationConnection.findOneAndUpdate({ companyId: oid(out.companyId) }, { $set: { provider: 'zoho', credentialsEnc: encryptJson(out.credentials, { context: connectionContext(out.companyId, 'zoho') }), enabled: false, status: 'untested', lastError: '', lastTestAt: null, updatedBy: out.userId } }, { upsert: true, setDefaultsOnInsert: true });
      return back('ok');
    } catch (e) {
      console.error('[integrations] oauth callback:', e.message);
      return back('error');
    }
  },
};
