import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

/**
 * « M'envoyer le lien par SMS » (fin de mise en route Nomad, Mon poste) : un SMS court avec le lien harx.ai/app, envoyé au mobile du
 * compte HARX (users.phone, jamais un numéro saisi dans la requête). Fonctions pures : texte, masque du numéro, contrôle du mobile.
 */
export const NOMAD_APP_LINK = 'https://harx.ai/app';
/** Limites anti-abus par compte : 1 envoi par minute, 3 par jour. */
export const PER_MINUTE = 1;
export const PER_DAY = 3;

// Apostrophe droite en français : le SMS reste en alphabet GSM (une seule partie, moins cher).
const TEXTS = {
  fr: `HARX Nomad : téléchargez l'app sur ce téléphone : ${NOMAD_APP_LINK}`,
  en: `HARX Nomad: download the app on this phone: ${NOMAD_APP_LINK}`,
  es: `HARX Nomad: descargue la app en este teléfono: ${NOMAD_APP_LINK}`,
  ar: `HARX Nomad: نزّل التطبيق على هذا الهاتف: ${NOMAD_APP_LINK}`,
};
export const appLinkSmsBody = (lang) => TEXTS[String(lang || '').slice(0, 2)] || TEXTS.en;

/** Numéro E.164 valide de type mobile (ou fixe-ou-mobile quand le plan de numérotation ne distingue pas), sinon null. */
export function mobileOf(phone) {
  try {
    const p = parsePhoneNumberFromString(String(phone || '').trim());
    if (!p || !p.isValid()) return null;
    const type = p.getType();
    return type === 'MOBILE' || type === 'FIXED_LINE_OR_MOBILE' ? p.number : null;
  } catch {
    return null;
  }
}

/** « +33 6 •• •• •• 08 » : indicatif, premier chiffre national et deux derniers chiffres visibles, le reste masqué. */
export function maskPhone(e164) {
  const p = parsePhoneNumberFromString(String(e164 || ''));
  if (!p) return '';
  const intl = p.formatInternational();
  const cc = `+${p.countryCallingCode}`;
  const rest = intl.slice(cc.length);
  const total = rest.replace(/\D/g, '').length;
  let seen = 0;
  const masked = rest.replace(/\d/g, (d) => { seen += 1; return seen === 1 || seen > total - 2 ? d : '•'; });
  return cc + masked;
}
