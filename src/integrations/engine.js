import { decryptJson } from './crypto.js';
import { createAdapter } from './adapters/index.js';
import { buildCallEvent, contactOfCall, crmCallInput, worthLoggingInCrm } from './events.js';
import { signPayload } from './webhookSign.js';
import { assertResolvesPublic } from './urlGuard.js';
import { CrmError } from './http.js';

export const MAX_ATTEMPTS = 6;
const BACKOFF_MIN = [1, 5, 30, 120, 720];
export const nextDelayMs = (attempts) => BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)] * 60_000;

/** Message d'erreur stocké : court et sans secret (jamais d'identifiant : seuls des messages de CrmError ou génériques). */
export function safeMessage(e) {
  if (e instanceof CrmError) return e.message.slice(0, 300);
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'Délai dépassé.';
  return 'Erreur réseau ou inattendue.';
}

export const connectionContext = (companyId, provider) => `${companyId}:${provider}`;
export const webhookContext = (companyId) => `${companyId}:webhook`;

/**
 * Met en file ce qu'un appel terminé déclenche : une ligne dans le CRM connecté et une livraison par webhook abonné.
 * Ne lève jamais (jamais bloquant pour l'appel) : renvoie le nombre de tâches créées.
 * deps : { store, hasIntegrations(companyId), loadConnection(companyId), listEndpoints(companyId) }
 */
export async function enqueueCallEnded({ companyId, call }, deps) {
  try {
    if (!companyId || !call?.sid || call.isTest) return 0;
    if (!(await deps.hasIntegrations(companyId))) return 0;
    let created = 0;
    const conn = await deps.loadConnection(companyId);
    if (conn?.enabled && conn.status === 'ok' && worthLoggingInCrm(call)) {
      const ok = await deps.store.insert({ companyId, kind: 'crm_call', targetId: String(conn._id || conn.provider), ref: String(call.sid), payload: { provider: conn.provider, call: crmCallInput(call), contact: contactOfCall(call) } });
      if (ok) created += 1;
    }
    const event = buildCallEvent(companyId, call);
    for (const ep of await deps.listEndpoints(companyId)) {
      if (!ep.enabled || !ep.events?.includes('call.completed')) continue;
      if (await deps.store.insert({ companyId, kind: 'webhook', targetId: String(ep._id), ref: String(call.sid), payload: { event } })) created += 1;
    }
    return created;
  } catch (e) {
    console.error('[integrations] mise en file impossible:', e.message);
    return 0;
  }
}

async function runCrm(job, deps) {
  const conn = await deps.loadConnection(job.companyId);
  if (!conn || !conn.enabled) throw new CrmError('Connexion CRM désactivée ou supprimée.', { retryable: false });
  const creds = decryptJson(conn.credentialsEnc, { context: connectionContext(job.companyId, conn.provider), key: deps.key });
  const adapter = createAdapter(conn.provider, creds, { http: deps.http });
  let contactRef = job.payload.contactRef || null;
  const c = job.payload.contact || {};
  if (!contactRef && (c.email || c.phone)) {
    contactRef = await adapter.upsertContact(c);
    job.payload = { ...job.payload, contactRef };
  }
  await adapter.logCall(job.payload.call, contactRef);
}

async function runWebhook(job, deps) {
  const ep = await deps.loadEndpoint(job.targetId);
  if (!ep || !ep.enabled) throw new CrmError('Webhook désactivé ou supprimé.', { retryable: false });
  if (!(await (deps.assertPublic || assertResolvesPublic)(ep.url).catch(() => false))) throw new CrmError('Adresse du webhook non publique.', { retryable: false });
  const secret = decryptJson(ep.secretEnc, { context: webhookContext(job.companyId), key: deps.key }).secret;
  const body = JSON.stringify(job.payload.event);
  const res = await deps.http({
    method: 'POST', url: ep.url, body, timeoutMs: 10000,
    headers: { 'Content-Type': 'application/json', 'X-Harx-Event': job.payload.event.type, 'X-Harx-Delivery': String(job._id || job.ref), 'X-Harx-Signature': signPayload(secret, body, Math.floor(deps.now().getTime() / 1000)) },
  });
  if (res.status < 200 || res.status >= 300) throw new CrmError(`Le destinataire a répondu ${res.status}.`, { status: res.status, retryable: res.status >= 500 || res.status === 429 || res.status === 408 });
}

/** Exécute une tâche et enregistre le résultat (reprises avec délais croissants, abandon après MAX_ATTEMPTS). */
export async function processJob(job, deps) {
  const now = deps.now();
  job.attempts += 1;
  try {
    if (job.kind === 'crm_call') await runCrm(job, deps);
    else await runWebhook(job, deps);
    job.status = 'done';
    job.lastError = '';
    job.doneAt = now;
  } catch (e) {
    job.lastError = safeMessage(e);
    const retry = !(e instanceof CrmError) || e.retryable;
    if (!retry || job.attempts >= MAX_ATTEMPTS) job.status = 'dead';
    else job.nextAttemptAt = new Date(now.getTime() + nextDelayMs(job.attempts));
  }
  await deps.store.save(job);
  return job.status;
}

export async function runDue(deps, limit = 20) {
  const jobs = await deps.store.claimDue(deps.now(), limit);
  let done = 0;
  for (const job of jobs) if ((await processJob(job, deps)) === 'done') done += 1;
  return { processed: jobs.length, done };
}
