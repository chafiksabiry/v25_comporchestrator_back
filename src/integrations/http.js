/**
 * Client HTTP injectable : les adaptateurs ne connaissent que cette signature, les tests y branchent un faux serveur.
 * `request({ method, url, headers, body, form, timeoutMs })` -> `{ status, json, headers }`. Ne lève que sur erreur réseau.
 */
export async function defaultHttp({ method = 'GET', url, headers = {}, body, form, timeoutMs = 15000 }) {
  const h = { Accept: 'application/json', ...headers };
  let payload;
  if (form) {
    payload = new URLSearchParams(form).toString();
    h['Content-Type'] = 'application/x-www-form-urlencoded';
  } else if (body !== undefined) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    h['Content-Type'] = h['Content-Type'] || 'application/json';
  }
  const res = await fetch(url, { method, headers: h, body: payload, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, headers: Object.fromEntries(res.headers.entries()) };
}

/** Message d'erreur sûr (sans en-tête ni identifiant) pour le journal visible par le centre. */
export class CrmError extends Error {
  constructor(message, { status = null, retryable = true } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

export function failFrom(res, what) {
  const detail = res.json?.message || res.json?.error?.message || res.json?.error_description || res.json?.error || '';
  const text = typeof detail === 'string' ? detail.slice(0, 200) : '';
  if (res.status === 401 || res.status === 403) return new CrmError(`${what} : accès refusé (${res.status}). Vérifiez les identifiants et leurs droits.${text ? ' ' + text : ''}`, { status: res.status, retryable: false });
  if (res.status === 429) return new CrmError(`${what} : limite de débit du CRM atteinte.`, { status: 429 });
  if (res.status >= 400 && res.status < 500) return new CrmError(`${what} : requête refusée (${res.status}). ${text}`.trim(), { status: res.status, retryable: false });
  return new CrmError(`${what} : erreur du CRM (${res.status}).`, { status: res.status });
}
