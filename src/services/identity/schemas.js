/**
 * Schémas des sorties structurées (spec §4) : `output_config.format`, JSON strict, `additionalProperties: false` partout.
 * Aucun champ « valide », « éligible », « confiance » ou « avis » : l'IA extrait, le code décide (spec §9.2).
 * Les observations sont des CODES d'une liste fermée (jamais du texte libre) : la décision ne lit aucun texte rédigé par l'IA.
 * Aucune donnée personnelle dans les schémas (ils sont mis en cache séparément par l'API).
 */
import { OBSERVATION_CODES } from './decision.js';

const str = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const date = { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] };
const observations = { type: 'array', items: { type: 'string', enum: [...OBSERVATION_CODES] } };

export const IDENTITY_DOCUMENT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'document_type', 'issuing_country_printed', 'issuing_country_iso3', 'nationality_iso3', 'last_name_latin', 'given_names_latin',
    'last_name_native', 'given_names_native', 'birth_date', 'issue_date', 'expiry_date', 'mrz_lines', 'document_number', 'sides_visible',
    'legibility', 'observations',
  ],
  properties: {
    document_type: { type: 'string', enum: ['passport', 'national_id_card', 'residence_permit', 'driving_licence', 'other', 'unreadable'] },
    issuing_country_printed: str,
    issuing_country_iso3: str,
    nationality_iso3: str,
    last_name_latin: str,
    given_names_latin: str,
    last_name_native: str,
    given_names_native: str,
    birth_date: date,
    issue_date: date,
    expiry_date: date,
    mrz_lines: { type: 'array', items: { type: 'string' } },
    document_number: str,
    sides_visible: { type: 'string', enum: ['front', 'back', 'both', 'photo_page'] },
    legibility: { type: 'string', enum: ['good', 'partial', 'poor'] },
    observations,
  },
});

export const ADDRESS_PROOF_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'document_type', 'issuer_name', 'holder_name', 'holder_name_native', 'address_lines', 'postal_code', 'city', 'country_printed',
    'country_iso2_inferred', 'country_inference_basis', 'issue_date', 'period_end', 'legibility', 'observations',
  ],
  properties: {
    document_type: {
      type: 'string',
      enum: ['utility_bill', 'telecom_bill', 'bank_statement', 'tax_notice', 'home_insurance', 'rent_receipt', 'hosting_certificate', 'other', 'unreadable'],
    },
    issuer_name: str,
    holder_name: str,
    holder_name_native: str,
    address_lines: { type: 'array', items: { type: 'string' } },
    postal_code: str,
    city: str,
    country_printed: str,
    country_iso2_inferred: str,
    country_inference_basis: { type: 'string', enum: ['printed', 'postal_format', 'issuer', 'currency', 'language', 'none'] },
    issue_date: date,
    period_end: date,
    legibility: { type: 'string', enum: ['good', 'partial', 'poor'] },
    observations,
  },
});

/**
 * Validation locale, indépendante de l'API (défense en profondeur) : types, énumérations, champs requis, aucun champ en plus.
 * Renvoie la liste des erreurs (vide si conforme). Sous-ensemble de JSON Schema suffisant pour les deux schémas ci-dessus.
 */
export function validateAgainst(schema, value, path = '$') {
  const errors = [];
  const check = (s, v, p) => {
    if (s.anyOf) {
      if (!s.anyOf.some((alt) => !validateAgainst(alt, v, p).length)) errors.push(`${p}: no alternative matches`);
      return;
    }
    if (s.type === 'null') { if (v !== null) errors.push(`${p}: expected null`); return; }
    if (s.type === 'string') {
      if (typeof v !== 'string') { errors.push(`${p}: expected string`); return; }
      if (s.enum && !s.enum.includes(v)) errors.push(`${p}: not in enum`);
      if (s.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) errors.push(`${p}: expected date`);
      if (v.length > 400) errors.push(`${p}: too long`);
      return;
    }
    if (s.type === 'array') {
      if (!Array.isArray(v)) { errors.push(`${p}: expected array`); return; }
      if (v.length > 20) errors.push(`${p}: too many items`);
      v.forEach((x, i) => check(s.items, x, `${p}[${i}]`));
      return;
    }
    if (s.type === 'object') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) { errors.push(`${p}: expected object`); return; }
      for (const k of s.required || []) if (!(k in v)) errors.push(`${p}.${k}: required`);
      for (const k of Object.keys(v)) {
        if (!s.properties[k]) errors.push(`${p}.${k}: not allowed`);
        else check(s.properties[k], v[k], `${p}.${k}`);
      }
    }
  };
  check(schema, value, path);
  return errors;
}
