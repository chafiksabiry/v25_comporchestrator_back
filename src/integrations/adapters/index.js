import { createHubspotAdapter, hubspotMeta } from './hubspot.js';
import { createZohoAdapter, zohoMeta } from './zoho.js';
import { createDynamicsAdapter, dynamicsMeta } from './dynamics.js';
import { defaultHttp } from '../http.js';

/**
 * Interface commune d'un adaptateur CRM :
 *   testConnection() -> { ok: true } | lève CrmError
 *   upsertContact({ firstName, lastName, email, phone }) -> { id, created }
 *   logCall({ title, direction, startedAt, durationSeconds, fromNumber, toNumber, summary }, contact|null) -> { id }
 *   listContacts({ cursor, limit }) -> { contacts: [{ externalId, firstName, lastName, email, phone }], next }
 */
export const PROVIDERS = {
  hubspot: { meta: hubspotMeta, create: createHubspotAdapter },
  zoho: { meta: zohoMeta, create: createZohoAdapter },
  dynamics: { meta: dynamicsMeta, create: createDynamicsAdapter },
};

export const providerIds = () => Object.keys(PROVIDERS);

export function createAdapter(provider, credentials, { http = defaultHttp } = {}) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error('Fournisseur CRM inconnu.');
  return p.create(credentials, { http });
}

/** Valide la saisie d'identifiants : champs connus, non vides, longueur raisonnable. Renvoie les identifiants nettoyés. */
export function cleanCredentials(provider, input) {
  const p = PROVIDERS[provider];
  if (!p) return { error: 'Fournisseur CRM inconnu.' };
  const out = {};
  for (const f of p.meta.fields) {
    const v = typeof input?.[f.key] === 'string' ? input[f.key].trim() : '';
    if (!v) return { error: `Champ obligatoire : ${f.label}.` };
    if (v.length > 2000) return { error: `Champ trop long : ${f.label}.` };
    if (f.options && !f.options.includes(v)) return { error: `Valeur inconnue : ${f.label}.` };
    out[f.key] = v;
  }
  return { value: out };
}
