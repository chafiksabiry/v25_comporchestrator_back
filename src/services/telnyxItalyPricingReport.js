/**
 * Diagnostic en lecture seule de l'offre Telnyx pour l'Italie (IT) : pour chaque type de numéro (local, mobile, national,
 * toll_free), quelques numéros disponibles avec coût initial / mensuel, capacités (features) et région ; puis les exigences
 * réglementaires Telnyx (GET /v2/requirements) par type.
 * Activé au démarrage uniquement avec LOG_TELNYX_IT_PRICING=1 (index.js). Aucune commande, réservation ni écriture chez Telnyx :
 * seuls des GET. La clé API n'est jamais écrite dans les logs.
 */

export const LOG_PREFIX = '[telnyx-it-pricing]';
export const NUMBER_TYPES = ['local', 'mobile', 'national', 'toll_free'];
const API = 'https://api.telnyx.com/v2';

export function italyPricingReportEnabled(env = process.env) {
  return String(env.LOG_TELNYX_IT_PRICING || '').trim() === '1';
}

export function availableNumbersUrl(type, limit = 5) {
  const q = new URLSearchParams({
    'filter[country_code]': 'IT',
    'filter[phone_number_type]': type,
    'filter[limit]': String(limit),
  });
  return `${API}/available_phone_numbers?${q.toString()}`;
}

export function requirementsUrl(type) {
  const q = new URLSearchParams({ 'filter[country_code]': 'IT', 'page[size]': '50' });
  if (type) q.set('filter[phone_number_type]', type);
  return `${API}/requirements?${q.toString()}`;
}

export function requirementDetailUrl(id) {
  return `${API}/requirements/${encodeURIComponent(id)}`;
}

const oneLine = (v, max = 400) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Ligne de synthèse d'un numéro disponible. */
export function formatNumberLine(type, n) {
  const cost = n?.cost_information || {};
  const features = (n?.features || []).map((f) => f?.name).filter(Boolean).join(',') || '(aucune)';
  const region = (n?.region_information || []).map((r) => `${r?.region_type}:${r?.region_name}`).join('|') || '?';
  return [
    LOG_PREFIX,
    `type=${type}`,
    n?.phone_number || '(sans numéro)',
    `type_telnyx=${n?.phone_number_type || n?.record_type || '?'}`,
    `initial=${cost.upfront_cost ?? '?'}`,
    `mensuel=${cost.monthly_cost ?? '?'}`,
    `devise=${cost.currency || '?'}`,
    `features=${features}`,
    `region=${region}`,
    `reservable=${n?.reservable ?? '?'}`,
    `quickship=${n?.quickship ?? '?'}`,
    `best_effort=${n?.best_effort ?? '?'}`,
  ].join(' ');
}

/** Lignes décrivant une exigence Telnyx (un enregistrement de /v2/requirements). */
export function formatRequirementLines(type, r) {
  const head = `${LOG_PREFIX} EXIGENCES type=${type} id=${r?.id || '?'} pays=${r?.country_code || '?'} type_numero=${r?.phone_number_type || '?'} action=${r?.action || '?'} locality=${r?.locality || '-'}`;
  const lines = [head];
  for (const t of r?.requirements_types || []) {
    const crit = t?.acceptance_criteria ? JSON.stringify(t.acceptance_criteria) : '';
    lines.push(`${LOG_PREFIX}   - ${oneLine(t?.name, 120)} [${t?.type || '?'}] : ${oneLine(t?.description)}${t?.example ? ` | ex. ${oneLine(t.example, 150)}` : ''}${crit ? ` | critères ${oneLine(crit, 300)}` : ''}`);
  }
  return lines;
}

function errorText(err) {
  const status = err?.response?.status;
  const details = (err?.response?.data?.errors || []).map((e) => oneLine(`${e?.code || ''} ${e?.title || ''} ${e?.detail || ''}`, 200)).join(' ; ');
  return `${status ? `HTTP ${status} ` : ''}${details || oneLine(err?.message || err, 200)}`;
}

/**
 * Écrit le diagnostic dans les logs. Ne lève jamais.
 * @param {{ apiKey?: string, http: { get: (url: string, opts: object) => Promise<{ data: any }> }, log?: (line: string) => void }} deps
 */
export async function logTelnyxItalyPricing({ apiKey, http, log = console.log }) {
  if (!apiKey) {
    log(`${LOG_PREFIX} clé Telnyx absente : diagnostic ignoré`);
    return;
  }
  const opts = { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }, timeout: 20000 };
  log(`${LOG_PREFIX} début — lecture seule (GET), aucune commande ni réservation`);
  for (const type of NUMBER_TYPES) {
    try {
      const { data } = await http.get(availableNumbersUrl(type), opts);
      const rows = data?.data || [];
      log(`${LOG_PREFIX} DISPONIBLES type=${type} : ${rows.length} renvoyé(s), total=${data?.metadata?.total_results ?? data?.meta?.total_results ?? '?'}`);
      for (const n of rows) log(formatNumberLine(type, n));
    } catch (err) {
      log(`${LOG_PREFIX} DISPONIBLES type=${type} : échec ${errorText(err)}`);
    }
  }
  for (const type of [null, ...NUMBER_TYPES]) {
    const label = type || 'tous';
    try {
      const { data } = await http.get(requirementsUrl(type), opts);
      const rows = data?.data || [];
      log(`${LOG_PREFIX} EXIGENCES type=${label} : ${rows.length} enregistrement(s)`);
      for (const r of rows) {
        for (const line of formatRequirementLines(label, r)) log(line);
        log(`${LOG_PREFIX}   champs=${Object.keys(r || {}).join(',')}`);
      }
    } catch (err) {
      log(`${LOG_PREFIX} EXIGENCES type=${label} : échec ${errorText(err)}`);
    }
  }
  // Détail de chaque exigence (la liste peut omettre les types de pièces demandées).
  const ids = new Set();
  try {
    const { data } = await http.get(requirementsUrl(null), opts);
    for (const r of data?.data || []) if (r?.id) ids.add(r.id);
  } catch { /* déjà journalisé plus haut */ }
  for (const id of ids) {
    try {
      const { data } = await http.get(requirementDetailUrl(id), opts);
      const r = data?.data || {};
      for (const line of formatRequirementLines('detail', r)) log(line);
      log(`${LOG_PREFIX}   brut=${oneLine(JSON.stringify(r), 3000)}`);
    } catch (err) {
      log(`${LOG_PREFIX} DETAIL ${id} : échec ${errorText(err)}`);
    }
  }
  log(`${LOG_PREFIX} fin`);
}
