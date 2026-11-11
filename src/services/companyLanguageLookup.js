import { PhoneNumber } from '../models/PhoneNumber.js';
import { DEFAULT_COMPANY_LANGUAGE, languageForPhone } from './companyLanguage.js';

/**
 * Langue des textes de l'entreprise quand seul son identifiant est connu (rappel Twilio sans numéro, analyse d'un message du répondeur).
 * Le pays de la société est celui de ses propres lignes (premier numéro dont l'indicatif donne une langue) : c'est déjà ainsi que le
 * serveur déduit son pays pour les appels sortants (outboundPolicy.js). Aucune ligne, indicatif illisible ou erreur : français, comme avant.
 * `loadLines` est injectable pour les tests ; le résultat est gardé quelques minutes (un webhook Twilio ne doit pas attendre la base).
 */
const TTL_MS = 10 * 60 * 1000;
const cache = new Map();

const defaultLoadLines = (companyId) => PhoneNumber.find({ companyId }).sort({ createdAt: 1 }).limit(5).select('phoneNumber').lean();

export const clearCompanyLanguageCache = () => cache.clear();

export async function companyLanguage(companyId, { loadLines = defaultLoadLines, now = Date.now() } = {}) {
  const id = String(companyId || '');
  if (!id) return DEFAULT_COMPANY_LANGUAGE;
  const hit = cache.get(id);
  if (hit && hit.expires > now) return hit.language;
  try {
    const lines = (await loadLines(id)) || [];
    let language = DEFAULT_COMPANY_LANGUAGE;
    for (const line of lines) {
      const candidate = languageForPhone(line?.phoneNumber, '');
      if (candidate) { language = candidate; break; }
    }
    cache.set(id, { language, expires: now + TTL_MS });
    return language;
  } catch (error) {
    console.error('companyLanguage:', error?.message || error);
    return DEFAULT_COMPANY_LANGUAGE;
  }
}
