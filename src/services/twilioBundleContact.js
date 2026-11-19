import mongoose from 'mongoose';
import { loadUserProfile } from './followUpDirectory.js';
import { normalizeCountryCode } from '../middleware/companyScope.js';

/**
 * Contact et libellé d'un dossier réglementaire Twilio (POST /api/phone-numbers/twilio/bundles), décidés par le SERVEUR.
 * Twilio envoie les notifications d'état du dossier (approuvé, refusé, pièces manquantes) à l'adresse `email` du dossier : ce doit être
 * le contact de l'entreprise cliente, jamais une adresse fournie par le navigateur (ni celle d'un développeur).
 * Ordre : e-mail de contact de l'entreprise (`companies.contact.email`), sinon e-mail du compte de l'appelant (service d'inscription).
 * Aucune adresse : la création est refusée (400 `contact_email_required`) et rien n'est envoyé à Twilio.
 */

export const CONTACT_EMAIL_REQUIRED = 'contact_email_required';
export const CONTACT_EMAIL_REQUIRED_MESSAGE = "Aucune adresse e-mail de contact n'est renseignée pour votre entreprise : complétez le profil de l'entreprise avant de déposer le dossier réglementaire.";

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
const FRIENDLY_NAME_MAX = 64;

/** Adresse e-mail exploitable (minuscules, sans espaces), sinon ''. */
export function cleanEmail(value) {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return s.length <= 254 && EMAIL_RE.test(s) ? s : '';
}

const oneLine = (v, max) => (typeof v === 'string' ? v.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Nom et e-mail de contact de l'entreprise, lus dans la base partagée (collection `companies`). Chaînes vides si introuvable. */
async function defaultLoadCompany(companyId) {
  const id = String(companyId || '');
  const db = mongoose.connection?.db;
  if (!db || !mongoose.isValidObjectId(id)) return { name: '', email: '' };
  const company = await db.collection('companies').findOne({ _id: new mongoose.Types.ObjectId(id) }, { projection: { name: 1, 'contact.email': 1 } });
  return { name: oneLine(company?.name, 120), email: company?.contact?.email || '' };
}

/** Points d'accès remplaçables par les tests. */
export const bundleContactSources = {
  loadCompany: defaultLoadCompany,
  loadUser: (userId) => loadUserProfile(userId),
};

/**
 * @param {{ companyId: string, userId?: string }} access accès de l'appelant (guardCompanyAccess)
 * @returns {Promise<{ email: string, companyName: string, source: 'company'|'user'|'' }>}
 */
export async function resolveBundleContact(access, sources = bundleContactSources) {
  let companyName = '';
  try {
    const company = (await sources.loadCompany(access?.companyId)) || {};
    companyName = oneLine(company.name, 120);
    const email = cleanEmail(company.email);
    if (email) return { email, companyName, source: 'company' };
  } catch (error) {
    console.error('resolveBundleContact (company):', error?.message || error);
  }
  try {
    const email = access?.userId ? cleanEmail((await sources.loadUser(access.userId))?.email) : '';
    if (email) return { email, companyName, source: 'user' };
  } catch (error) {
    console.error('resolveBundleContact (user):', error?.message || error);
  }
  return { email: '', companyName, source: '' };
}

const TYPES = { local: 'Local', mobile: 'Mobile', national: 'National', 'toll-free': 'Toll-free', tollfree: 'Toll-free', toll_free: 'Toll-free' };
const END_USER_TYPES = { business: 'Business', individual: 'Individual' };

/** Nom du pays en anglais (comme les libellés Twilio), sinon le code ISO. */
export function countryLabel(isoCountry) {
  const iso = normalizeCountryCode(isoCountry);
  if (!/^[A-Z]{2}$/.test(iso)) return iso || 'Unknown';
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(iso);
    return name && name !== iso && name !== 'Unknown Region' ? name : iso;
  } catch {
    return iso;
  }
}

/**
 * Libellé du dossier : « <pays> : <type> - <type de titulaire> » (+ « - <entreprise> » quand le nom est connu), tronqué à 64 caractères.
 * `type` / `endUserType` hors liste connue : valeurs par défaut Local / Business.
 */
export function bundleFriendlyName({ isoCountry, type, endUserType, companyName }) {
  const t = TYPES[String(type || '').trim().toLowerCase()] || 'Local';
  const u = END_USER_TYPES[String(endUserType || '').trim().toLowerCase()] || 'Business';
  const base = `${countryLabel(isoCountry)}: ${t} - ${u}`;
  const company = oneLine(companyName, 120);
  return (company ? `${base} - ${company}` : base).slice(0, FRIENDLY_NAME_MAX).trim();
}
