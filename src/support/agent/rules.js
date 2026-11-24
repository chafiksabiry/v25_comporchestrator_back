import { detectLanguage } from '../../whatsapp/language.js';

/**
 * Règles DÉTERMINISTES de l'agent support (sans appel au modèle), appliquées EN PLUS du jugement de Claude : une demande est escaladée
 * au fondateur dès que l'une des deux voies y voit un cas interdit (prudence : en cas de doute, on escalade).
 *
 * Cas jamais traités seuls (spécification validée le 24/11/2026) :
 *  refund_commercial  remboursement, avoir, geste commercial, prix / remise
 *  cancellation       résiliation de l'abonnement
 *  number_change      changement, libération ou portabilité de numéro
 *  account_deletion   suppression de compte
 *  identity_decision  décision sur une vérification d'identité (accepter / refuser / contester)
 *  legal              juridique (RGPD, réclamation, litige) -> copie à legal@
 *  incident           même code d'erreur chez plusieurs clients (seuil en 1 h), calculé à part
 *  uncertain          l'agent n'est pas sûr
 */
export const FORBIDDEN = ['refund_commercial', 'cancellation', 'number_change', 'account_deletion', 'identity_decision', 'legal', 'incident', 'uncertain'];
export const SUPPORTED_LANGUAGES = ['fr', 'en', 'es', 'ar'];

export const FORBIDDEN_LABEL = {
  refund_commercial: 'Remboursement, avoir, geste commercial ou prix',
  cancellation: 'Résiliation',
  number_change: 'Changement ou libération de numéro',
  account_deletion: 'Suppression de compte',
  identity_decision: 'Décision sur une vérification d’identité',
  legal: 'Juridique (RGPD, réclamation, litige)',
  incident: 'Incident touchant plusieurs clients',
  uncertain: 'L’agent n’est pas sûr',
};

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, "'");

// Motifs écrits sur le texte normalisé (minuscules, sans accents). Arabe : texte brut.
const PATTERNS = {
  refund_commercial: [
    /\brembours/, /\bun avoir\b/, /\bavoir sur (ma|la) facture/, /geste commercial/, /\bremise\b/, /\breduction\b/, /moins cher/, /baisser? (le|mon) prix/, /changer? (le|de) prix/,
    /\brefund/, /\bcredit note\b/, /\bchargeback/, /\bdiscount\b/, /\bmoney back\b/, /lower (the|my) price/, /\bcompensation\b/, /goodwill gesture/,
    /\breembols/, /\bdevolucion\b/, /devuelvan? (mi|el) dinero/, /\bdescuento\b/, /nota de credito/,
    /استرداد/, /استرجاع (المبلغ|أموالي|فلوسي)/, /تعويض/, /خصم/, /ارجاع المبلغ/, /إرجاع المبلغ/,
  ],
  cancellation: [
    /\bresili/, /\b(annuler|arreter|stopper|suspendre)\b.{0,40}\b(abonnement|forfait|contrat)/, /me desabonner/, /mettre fin a .{0,30}(abonnement|contrat)/,
    /\b(cancel|terminate|stop|end)\b.{0,40}\b(subscription|plan|contract|membership)\b/, /\bunsubscribe from (harx|the plan|nomad|cloud)/,
    /\b(cancelar|anular|terminar)\b.{0,40}\b(suscripcion|subscripcion|plan|contrato|abono)\b/, /dar(me)? de baja/,
    /إلغاء الاشتراك/, /الغاء الاشتراك/, /إلغاء اشتراكي/, /الغاء اشتراكي/, /فسخ العقد/,
  ],
  number_change: [
    /changer (de|mon) numero/, /nouveau numero/, /liberer (mon|le) numero/, /portabilite/, /porter mon numero/, /garder mon numero/, /transferer mon numero/,
    /change (my|the) (phone )?number/, /release (my|the) number/, /\bport (my|the|out)/, /number porting/, /keep my number/, /different number/,
    /cambiar (mi|el) numero/, /liberar (mi|el) numero/, /portabilidad/, /otro numero/,
    /تغيير (الرقم|رقمي)/, /رقم جديد/, /نقل رقمي/,
  ],
  account_deletion: [
    /supprimer? (mon|le|notre) compte/, /suppression (de|du) (mon )?compte/, /fermer (mon|le) compte/, /effacer (mes|toutes mes) donnees/,
    /delete (my|the|our) account/, /close (my|the) account/, /erase (my|all my) data/, /remove my account/,
    /eliminar (mi|la) cuenta/, /borrar (mi|la) cuenta/, /cerrar (mi|la) cuenta/, /borrar mis datos/,
    /حذف (حسابي|الحساب)/, /إغلاق حسابي/, /اغلاق حسابي/, /مسح بياناتي/,
  ],
  legal: [
    /\brgpd\b/, /\bgdpr\b/, /\bcnil\b/, /\bavocat/, /\bjuridique/, /mise en demeure/, /\btribunal/, /\blitige/, /\bplainte\b/, /reclamation formelle/, /droit d'acces/, /\bdpo\b/, /action en justice/, /\bpoursuite/,
    /\blawyer/, /\blegal action/, /\blawsuit/, /\bsue\b/, /\bdispute\b/, /formal complaint/, /data protection/, /subject access request/, /\battorney/,
    /\babogado/, /\bdemanda judicial/, /\bdenuncia/, /queja formal/, /proteccion de datos/, /\blitigio/,
    /محامي/, /محام/, /دعوى/, /شكوى رسمية/, /المحكمة/, /حماية البيانات/,
  ],
};
// Décision d'identité : un mot d'identité ET un mot de décision (« comment vérifier mon identité ? » reste une question d'aide).
const IDENTITY_WORD = [/identit/, /\bkyc\b/, /piece d'identite/, /passeport/, /passport/, /\bid card\b/, /verificacion de identidad/, /identidad/, /الهوية/, /جواز/];
const DECISION_WORD = [/refus/, /rejet/, /reject/, /denied/, /rechaz/, /deneg/, /valider (manuellement|mon dossier)/, /accepter mon dossier/, /approve (me|my)/, /validate (me|my) (manually|file)/, /contest/, /appeal/, /recurso/, /revis(ar|ion) (manual|humana)/, /مرفوض/, /رفض/, /قبول ملفي/];

/** @returns {string[]} catégories interdites repérées dans le texte (ordre stable, sans doublon). */
export function detectForbidden(text) {
  const raw = String(text || '');
  const t = norm(raw);
  const hit = (list) => list.some((re) => re.test(t) || re.test(raw));
  const out = Object.keys(PATTERNS).filter((k) => hit(PATTERNS[k]));
  if (hit(IDENTITY_WORD) && hit(DECISION_WORD)) out.push('identity_decision');
  return FORBIDDEN.filter((k) => out.includes(k));
}

// --- Code d'erreur et référence de compte (message pré-rempli de l'encadré « Besoin d'aide ? ») ---
const CODE_LABEL_RE = /(?:code d[’']erreur|error code|c[oó]digo de error|رمز الخطأ)\s*[:：]\s*([A-Za-z][A-Za-z0-9_-]{2,40})/gi;
const CODE_TOKEN_RE = /\b[A-Z][A-Z0-9]{1,}(?:[_-][A-Z0-9]{2,}){1,5}\b/g;
const NOT_CODES = /^(HARX-[A-Z0-9]{8}|[A-Z]{2}-[0-9]+)$/;
/** @returns {string[]} codes d'erreur cités (majuscules, dédoublonnés). */
export function extractErrorCodes(text) {
  const s = String(text || '');
  const found = new Set();
  for (const m of s.matchAll(CODE_LABEL_RE)) found.add(m[1].toUpperCase());
  for (const m of s.matchAll(CODE_TOKEN_RE)) if (!NOT_CODES.test(m[0])) found.add(m[0]);
  return [...found].slice(0, 10);
}

const REF_RE = /(?:r[ée]f[ée]rence du compte|r[ée]f\.? compte|account reference|account ref\.?|referencia de (?:la )?cuenta|مرجع الحساب)\s*[:：]\s*([A-Za-z0-9]{6,12})\b/i;
/** Référence courte du compte citée par le client, ou ''. Ce n'est PAS une preuve d'identité (n'importe qui peut l'écrire). */
export function extractAccountRef(text) {
  const m = REF_RE.exec(String(text || ''));
  return m ? m[1].toUpperCase() : '';
}

/** Langue de réponse parmi fr, en, es, ar (darija -> ar ; autre langue -> en ; texte trop court -> langue connue de la conversation). */
export function replyLanguage(text, known = null) {
  const d = detectLanguage(String(text || ''));
  const map = (l) => (l === 'ary' ? 'ar' : l);
  const lang = map(d.language);
  if (SUPPORTED_LANGUAGES.includes(lang) && d.confidence !== 'low') return lang;
  const k = map(known);
  if (SUPPORTED_LANGUAGES.includes(k)) return k;
  if (SUPPORTED_LANGUAGES.includes(lang)) return lang;
  return d.language && d.language !== 'unknown' ? 'en' : 'fr';
}

/** Message d'attente envoyé au client pour un cas escaladé (texte validé dans la spécification). */
export const HOLDING_MESSAGE = {
  fr: 'Bonjour, merci pour votre message. Votre demande est transmise à l’équipe HARX : vous aurez une réponse sous 24 h ouvrées.',
  en: 'Hello, thank you for your message. Your request has been passed on to the HARX team: you will receive a reply within 24 business hours.',
  es: 'Hola, gracias por su mensaje. Su solicitud ha sido transmitida al equipo de HARX: recibirá una respuesta en un plazo de 24 horas hábiles.',
  ar: 'مرحبًا، شكرًا على رسالتك. تم تحويل طلبك إلى فريق HARX، وستتلقى ردًا خلال 24 ساعة عمل.',
};
export const holdingMessage = (lang) => HOLDING_MESSAGE[lang] || HOLDING_MESSAGE.fr;

/** Confirmation explicite du client que son problème est réglé (clôture). */
const RESOLVED_PATTERNS = [/\b(c'est|ca|tout est) (bon|regle|resolu|ok)\b/, /\bresolu\b/, /\bca marche\b/, /\bca fonctionne\b/, /\bproblem(e)? (is )?(solved|fixed|resolved)\b/, /\bit works( now)?\b/, /\ball good\b/, /\bthat fixed it\b/, /\bya funciona\b/, /\bresuelto\b/, /\bsolucionado\b/, /تم الحل/, /اشتغل/, /خدام دابا/, /تحل المشكل/];
export function confirmsResolution(text) {
  const raw = String(text || '');
  const t = norm(raw);
  return RESOLVED_PATTERNS.some((re) => re.test(t) || re.test(raw));
}
