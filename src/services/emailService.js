import axios from 'axios';

/**
 * E-mails du secrétariat (écran « E-mails »). Audit : le service d'e-mail de la plateforme est `sendAppEmail`
 * (Brevo puis SMTP) du service d'inscription ; l'orchestrateur n'a ni client e-mail ni dépendance SMTP. Choix le plus
 * simple : appeler directement l'API Brevo d'ici avec les MÊMES variables d'environnement que le service d'inscription
 * (BREVO_API_KEY, BREVO_SENDER_EMAIL), sans nouveau service ni dépendance. Sans ces variables, rien n'est envoyé.
 *
 * Expéditeur : adresse vérifiée de la plateforme, nom affiché = nom du centre ; réponse = adresse de la personne connectée.
 * Aucun contenu complet n'est conservé (voir EmailLog).
 */
export const TEMPLATES = ['callback_confirmation', 'appointment_confirmation', 'free'];
export const MAX_RECIPIENTS = 5;
export const MAX_SUBJECT = 150;
export const MAX_BODY = 5000;
export const ICS_ATTACHMENT_NAME = 'rendez-vous.ics';

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const bad = (message, code = 'invalid') => ({ error: message, code });

export function isValidEmail(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s.length < 6 || s.length > 254 || /[\r\n\s,;<>]/.test(s)) return false;
  const [local] = s.split('@');
  return Boolean(local) && local.length <= 64 && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..') && EMAIL_RE.test(s);
}

/** Liste de destinataires (tableau ou texte séparé par virgules/points-virgules), dédoublonnée, en minuscules. */
export function parseRecipients(input) {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[;,]/) : null;
  if (!raw) return bad('Indiquez au moins un destinataire.');
  const list = [...new Set(raw.map((x) => (typeof x === 'string' ? x.trim().toLowerCase() : '')).filter(Boolean))];
  if (list.length === 0) return bad('Indiquez au moins un destinataire.');
  if (list.length > MAX_RECIPIENTS) return bad(`Cinq destinataires au maximum par e-mail.`);
  const wrong = list.find((a) => !isValidEmail(a));
  if (wrong) return bad(`Adresse e-mail invalide : ${wrong.slice(0, 80)}.`);
  return { value: list };
}

/** Nom affiché de l'expéditeur : texte simple, sans caractère pouvant casser un en-tête. */
export function cleanDisplayName(v, fallback = 'HARX') {
  const s = typeof v === 'string' ? v.replace(/[\r\n\t"<>@\\]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  return s || fallback;
}

/** Validation du corps de `POST /api/emails`. @returns {{error, code} | {value}} */
export function validateSend(body) {
  const b = body && typeof body === 'object' ? body : {};
  const to = parseRecipients(b.to);
  if (to.error) return to;
  if (typeof b.subject !== 'string' || !b.subject.trim()) return bad('Indiquez l’objet de l’e-mail.');
  if (/[\r\n]/.test(b.subject)) return bad('L’objet doit tenir sur une seule ligne.');
  if (b.subject.trim().length > MAX_SUBJECT) return bad(`L’objet doit faire ${MAX_SUBJECT} caractères au maximum.`);
  if (typeof b.body !== 'string' || !b.body.trim()) return bad('Écrivez le message.');
  if (b.body.length > MAX_BODY) return bad(`Le message doit faire ${MAX_BODY} caractères au maximum.`);
  const template = b.template === undefined ? 'free' : b.template;
  if (!TEMPLATES.includes(template)) return bad('Modèle d’e-mail inconnu.');
  const followUpId = b.followUpId === undefined || b.followUpId === null || b.followUpId === '' ? null : b.followUpId;
  if (followUpId !== null && !(typeof followUpId === 'string' && /^[0-9a-fA-F]{24}$/.test(followUpId))) return bad('Élément « À traiter » invalide.');
  if (b.attachIcs !== undefined && typeof b.attachIcs !== 'boolean') return bad('Pièce jointe invalide.');
  if (b.attachIcs === true && !followUpId) return bad('Le fichier agenda se joint à partir d’un rendez-vous.');
  return {
    value: {
      to: to.value, subject: b.subject.trim(), body: b.body.replace(/\r\n?/g, '\n').trim(), template, followUpId,
      attachIcs: b.attachIcs === true, centerName: cleanDisplayName(b.centerName, ''),
    },
  };
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Texte brut -> HTML sûr : paragraphes, retours à la ligne et adresses https:// cliquables. */
export function textToHtml(text) {
  const link = (s) => s.replace(/https:\/\/[^\s<]+/g, (u) => { const clean = u.replace(/[.,;:!?)]+$/, ''); const tail = u.slice(clean.length); return `<a href="${clean}">${clean}</a>${tail}`; });
  return text.split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${link(escapeHtml(p)).replace(/\n/g, '<br>')}</p>`).join('');
}

/**
 * Ajoute la signature du centre à la fin du message, sauf si le message se termine déjà par elle (les modèles de message
 * proposent « Cordialement, <nom> » : la signature ne doit pas apparaître deux fois). Comparaison sans tenir compte de la
 * casse, des espaces ni des retours à la ligne.
 */
export function appendSignature(body, signature) {
  const sig = String(signature ?? '').trim();
  if (!sig) return body;
  const squash = (v) => String(v).replace(/\s+/g, ' ').trim().toLowerCase();
  if (squash(body).endsWith(squash(sig))) return body;
  return `${body}\n\n${sig}`;
}

/** Charge utile de l'API Brevo (pure, testable). */
export function buildPayload({ senderEmail, centerName, replyTo, to, subject, text: body, signature = '', icsContent, harxFooter = true }) {
  const name = cleanDisplayName(centerName);
  // Signature du centre (texte brut, déjà validée à l'enregistrement) : ajoutée à la fin du message, avant la mention HARX.
  const text = appendSignature(body, signature);
  // Mention HARX : seulement pour les envois qui partent réellement de la plateforme ; jamais pour un message envoyé depuis la boîte de l'entreprise.
  const footer = harxFooter ? `\n\nMessage envoyé via HARX pour le compte de ${name}. Vous pouvez répondre directement à ce message.` : '';
  return {
    sender: { name, email: senderEmail },
    to: to.map((email) => ({ email })),
    replyTo: { email: replyTo.email, name: cleanDisplayName(replyTo.name, name) },
    subject,
    htmlContent: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1e293b">${textToHtml(text)}${footer ? `<p style="margin:18px 0 0;font-size:12px;color:#64748b">${escapeHtml(footer.trim())}</p>` : ''}</div>`,
    textContent: text + footer,
    ...(icsContent ? { attachment: [{ name: ICS_ATTACHMENT_NAME, content: Buffer.from(icsContent, 'utf8').toString('base64') }] } : {}),
  };
}

export const senderEmail = (env = process.env) => env.BREVO_SENDER_EMAIL || env.BREVO_FROM_EMAIL || env.SMTP_FROM_EMAIL || '';
export const isEmailConfigured = (env = process.env) => Boolean(env.BREVO_API_KEY && senderEmail(env));

export const NOT_CONFIGURED_MESSAGE = 'L’envoi d’e-mails n’est pas encore activé sur la plateforme. Aucun e-mail n’a été envoyé.';

/** Limites d'envoi par centre (modifiables par variables d'environnement). */
export function limits(env = process.env) {
  const n = (v, d) => { const x = Math.floor(Number(v)); return Number.isFinite(x) && x > 0 ? x : d; };
  return { perHour: n(env.EMAIL_MAX_PER_HOUR, 30), perDay: n(env.EMAIL_MAX_PER_DAY, 200) };
}

/** `counts` = envois du centre sur la dernière heure et les dernières 24 h. @returns {{ok: boolean, message?: string}} */
export function checkRate(counts, max) {
  if (counts.hour >= max.perHour) return { ok: false, message: `Limite atteinte : ${max.perHour} e-mails par heure pour votre centre. Réessayez dans quelques minutes.` };
  if (counts.day >= max.perDay) return { ok: false, message: `Limite atteinte : ${max.perDay} e-mails par jour pour votre centre. Réessayez demain.` };
  return { ok: true };
}

async function brevoTransport(payload) {
  try {
    const { data } = await axios.post('https://api.brevo.com/v3/smtp/email', payload, {
      headers: { 'api-key': process.env.BREVO_API_KEY, accept: 'application/json', 'content-type': 'application/json' },
      timeout: 15000,
    });
    return data;
  } catch (error) {
    throw new Error(`Brevo : ${error.response?.data?.message || error.message || 'envoi impossible'}`);
  }
}

let transport = brevoTransport;
/** Remplace l'envoi réel (tests, simulation). Sans argument, rétablit Brevo. */
export function setMailTransport(fn) { transport = typeof fn === 'function' ? fn : brevoTransport; }
export const sendMail = (payload) => transport(payload);
