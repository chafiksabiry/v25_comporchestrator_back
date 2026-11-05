import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import mongoose from 'mongoose';
import SecretariatTools from '../models/SecretariatTools.js';
import { config } from '../config/env.js';
import { isValidEmail } from './emailService.js';
import { newVisioUrl, validateCustomVisioUrl } from './visio.js';

/**
 * Outils du secrétariat : identité d'envoi des e-mails, choix de la visio, abonnement agenda (.ics).
 * Rien ici ne se connecte à Google, Microsoft 365 ou Zoom : ce sont des réglages saisis par le centre.
 */
export const MAX_FROM_NAME = 80;
export const MAX_SIGNATURE = 500;
export const TOKEN_BYTES = 32;
export const PROVIDERS = ['jitsi', 'custom'];

const bad = (error) => ({ error });
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** Valeurs par défaut quand le centre n'a rien enregistré. */
export const DEFAULT_TOOLS = Object.freeze({ email: { fromName: '', replyTo: '', signature: '' }, visio: { provider: 'jitsi', customUrl: '', chosen: false }, agendaFeed: { tokenHash: null } });

const merged = (doc) => ({
  email: { ...DEFAULT_TOOLS.email, ...(doc?.email || {}) },
  visio: { ...DEFAULT_TOOLS.visio, ...(doc?.visio || {}) },
  agendaFeed: { ...DEFAULT_TOOLS.agendaFeed, ...(doc?.agendaFeed || {}) },
});

/**
 * Valide un corps partiel `{ email?, visio? }` et le fusionne avec les réglages actuels.
 * @returns {{error: string} | {set: Record<string, any>}} `set` = champs à écrire (chemins pointés pour Mongo)
 */
export function validateToolsPatch(body, current) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const cur = merged(current);
  const set = {};
  if (b.email === undefined && b.visio === undefined) return bad('Rien à modifier.');

  if (b.email !== undefined) {
    const e = b.email;
    if (!e || typeof e !== 'object' || Array.isArray(e)) return bad('Réglages e-mail invalides.');
    if (e.fromName !== undefined) {
      if (typeof e.fromName !== 'string') return bad('Le nom d’expéditeur doit être un texte.');
      const name = e.fromName.replace(/\s+/g, ' ').trim();
      if (name.length > MAX_FROM_NAME) return bad(`Le nom d’expéditeur doit faire ${MAX_FROM_NAME} caractères au maximum.`);
      if (CONTROL.test(name) || /[<>"@\\]/.test(name)) return bad('Le nom d’expéditeur ne doit pas contenir les caractères < > " @ \\.');
      set['email.fromName'] = name;
    }
    if (e.replyTo !== undefined) {
      if (typeof e.replyTo !== 'string') return bad('L’adresse de réponse doit être un texte.');
      const addr = e.replyTo.trim().toLowerCase();
      if (addr && !isValidEmail(addr)) return bad('L’adresse de réponse n’est pas une adresse e-mail valide.');
      set['email.replyTo'] = addr;
    }
    if (e.signature !== undefined) {
      if (typeof e.signature !== 'string') return bad('La signature doit être un texte.');
      const sig = e.signature.replace(/\r\n?/g, '\n').trim();
      if (sig.length > MAX_SIGNATURE) return bad(`La signature doit faire ${MAX_SIGNATURE} caractères au maximum.`);
      if (CONTROL.test(sig)) return bad('La signature contient des caractères non autorisés.');
      set['email.signature'] = sig;
    }
  }

  if (b.visio !== undefined) {
    const v = b.visio;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return bad('Réglages de visio invalides.');
    let provider = cur.visio.provider;
    let customUrl = cur.visio.customUrl;
    if (v.provider !== undefined) {
      if (!PROVIDERS.includes(v.provider)) return bad('Fournisseur de visio inconnu : choisissez « jitsi » ou « custom ».');
      provider = v.provider;
    }
    if (v.customUrl !== undefined) {
      if (typeof v.customUrl !== 'string') return bad('Le lien de visio doit être un texte.');
      if (v.customUrl.trim() === '') customUrl = '';
      else {
        const checked = validateCustomVisioUrl(v.customUrl);
        if (checked.error) return checked;
        customUrl = checked.value;
      }
    }
    if (provider === 'custom' && !customUrl) return bad('Indiquez le lien de votre salle de visio pour utiliser votre propre outil.');
    set['visio.provider'] = provider;
    set['visio.customUrl'] = customUrl;
    set['visio.chosen'] = true;
  }
  return { set };
}

/** Réponse de l'API. `feedUrl` n'est renseigné qu'au moment où le jeton vient d'être créé (il n'est jamais relisible ensuite). */
export function toView(doc, feedUrl = null) {
  const t = merged(doc);
  const email = { fromName: t.email.fromName, replyTo: t.email.replyTo, signature: t.email.signature };
  return {
    email,
    visio: { provider: t.visio.provider, customUrl: t.visio.customUrl },
    agenda: { feedUrl: feedUrl || null },
    configured: {
      email: Boolean(email.fromName || email.replyTo || email.signature),
      visio: t.visio.provider === 'custom' ? Boolean(t.visio.customUrl) : t.visio.chosen === true,
      agenda: typeof t.agendaFeed.tokenHash === 'string' && t.agendaFeed.tokenHash.length > 0,
    },
  };
}

// ---------- jeton du flux agenda
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 octets en base64url

export const newFeedToken = (random = randomBytes) => random(TOKEN_BYTES).toString('base64url');
export const hashFeedToken = (token) => createHash('sha256').update(String(token), 'utf8').digest('hex');
export const isFeedTokenShape = (token) => typeof token === 'string' && TOKEN_RE.test(token);

/** Comparaison à temps constant de l'empreinte attendue et de celle du jeton présenté. */
export function feedTokenMatches(storedHash, token) {
  if (typeof storedHash !== 'string' || !isFeedTokenShape(token)) return false;
  const a = Buffer.from(storedHash, 'hex');
  const b = Buffer.from(hashFeedToken(token), 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export const feedUrlFor = (token, base = config.publicApiBaseUrl) => `${String(base).replace(/\/+$/, '')}/secretariat/agenda/${token}.ics`;

// ---------- accès base
const oid = (id) => new mongoose.Types.ObjectId(String(id));

/** Réglages du centre (document brut ou null). Laisse remonter une erreur de base : on n'enverra pas avec une identité devinée. */
export const loadTools = (companyId) => SecretariatTools.findOne({ companyId: oid(companyId) }).lean();

/** Identité d'envoi des e-mails du centre (champs vides si non renseignée). */
export async function loadEmailIdentity(companyId) {
  return merged(await loadTools(companyId)).email;
}

/** Lien de visio d'un nouveau rendez-vous : le lien permanent du centre s'il l'a choisi, sinon une salle Jitsi. */
export async function newMeetingUrl(companyId) {
  const { visio } = merged(await loadTools(companyId));
  return visio.provider === 'custom' && visio.customUrl ? visio.customUrl : newVisioUrl();
}
