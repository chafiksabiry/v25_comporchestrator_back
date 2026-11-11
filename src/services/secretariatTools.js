import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import mongoose from 'mongoose';
import SecretariatTools from '../models/SecretariatTools.js';
import { config } from '../config/env.js';
import { isValidEmail } from './emailService.js';
import { validateCustomVisioUrl } from './visio.js';
import { normalizeTimeZone, UNKNOWN_TIME_ZONE_MESSAGE } from './timeZone.js';

/**
 * Outils du secrétariat : fournisseur et identité d'envoi des e-mails, agenda connecté, choix de la visio, abonnement agenda (.ics).
 * Ici ne sont que des RÉGLAGES ; les connexions OAuth (Google, Microsoft 365, Zoom) vivent dans services/secretariatConnections.js.
 */
export const MAX_FROM_NAME = 80;
export const MAX_SIGNATURE = 500;
export const TOKEN_BYTES = 32;
/** 'jitsi' et 'custom' = AUCUNE visio choisie (valeurs conservées pour compatibilité) : HARX ne fournit aucun outil de visio. */
export const PROVIDERS = ['jitsi', 'custom', 'google_meet', 'teams', 'zoom'];
/** 'platform' = AUCUNE messagerie choisie (valeur conservée pour compatibilité) : les e-mails ne partent jamais de HARX. */
export const EMAIL_PROVIDERS = ['platform', 'google', 'microsoft'];
export const AGENDA_PROVIDERS = ['none', 'google', 'microsoft'];
/** Compte à connecter pour utiliser chaque valeur de réglage. */
export const VISIO_NEEDS = { google_meet: 'google', teams: 'microsoft', zoom: 'zoom' };
const ACCOUNT_LABEL = { google: 'Google', microsoft: 'Microsoft 365', zoom: 'Zoom' };
const notConnected = (p) => bad(`${ACCOUNT_LABEL[p]} n’est pas connecté : connectez d’abord votre compte dans Paramétrage > Outils.`);

const bad = (error) => ({ error });
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** Valeurs par défaut quand le centre n'a rien enregistré. */
export const DEFAULT_TOOLS = Object.freeze({
  email: { provider: 'platform', fromName: '', replyTo: '', signature: '' },
  agenda: { provider: 'none' },
  visio: { provider: 'jitsi', customUrl: '', chosen: false },
  timeZone: '',
  inbound: { enabled: false, secretaries: false, mailboxActions: false, lastSyncAt: null },
  agendaFeed: { tokenHash: null },
});

/** Réglages complets : un document ancien (sans les nouveaux champs) reprend les valeurs par défaut. */
export const mergedTools = (doc) => ({
  email: { ...DEFAULT_TOOLS.email, ...(doc?.email || {}) },
  agenda: { ...DEFAULT_TOOLS.agenda, ...(doc?.agenda || {}) },
  visio: { ...DEFAULT_TOOLS.visio, ...(doc?.visio || {}) },
  timeZone: typeof doc?.timeZone === 'string' ? doc.timeZone : DEFAULT_TOOLS.timeZone,
  inbound: { ...DEFAULT_TOOLS.inbound, ...(doc?.inbound || {}) },
  agendaFeed: { ...DEFAULT_TOOLS.agendaFeed, ...(doc?.agendaFeed || {}) },
});
const merged = mergedTools;

/**
 * Valide un corps partiel `{ email?, agenda?, visio?, timeZone? }` et le fusionne avec les réglages actuels.
 * `connected` = fournisseurs dont le compte est connecté (Set) : choisir un fournisseur non connecté est refusé.
 * @returns {{error: string} | {set: Record<string, any>}} `set` = champs à écrire (chemins pointés pour Mongo)
 */
export function validateToolsPatch(body, current, connected = new Set()) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const cur = merged(current);
  const set = {};
  if (b.email === undefined && b.visio === undefined && b.agenda === undefined && b.timeZone === undefined && b.inbound === undefined) return bad('Rien à modifier.');

  if (b.timeZone !== undefined) {
    if (b.timeZone === null || b.timeZone === '') set.timeZone = '';
    else {
      const tz = normalizeTimeZone(b.timeZone);
      if (!tz) return bad(UNKNOWN_TIME_ZONE_MESSAGE);
      set.timeZone = tz;
    }
  }

  if (b.email !== undefined) {
    const e = b.email;
    if (!e || typeof e !== 'object' || Array.isArray(e)) return bad('Réglages e-mail invalides.');
    if (e.provider !== undefined) {
      if (!EMAIL_PROVIDERS.includes(e.provider)) return bad('Fournisseur d’e-mail inconnu : choisissez « platform », « google » ou « microsoft ».');
      if (e.provider !== 'platform' && !connected.has(e.provider)) return notConnected(e.provider);
      set['email.provider'] = e.provider;
    }
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

  if (b.inbound !== undefined) {
    const i = b.inbound;
    if (!i || typeof i !== 'object' || Array.isArray(i)) return bad('Réglages des e-mails entrants invalides.');
    if (i.enabled !== undefined) {
      if (typeof i.enabled !== 'boolean') return bad('« inbound.enabled » doit être vrai ou faux.');
      set['inbound.enabled'] = i.enabled;
      // Désactivation : la dernière lecture est oubliée (les e-mails stockés sont purgés par le contrôleur).
      if (!i.enabled) { set['inbound.lastSyncAt'] = null; set['inbound.secretaries'] = false; set['inbound.mailboxActions'] = false; }
    }
    if (i.secretaries !== undefined) {
      if (typeof i.secretaries !== 'boolean') return bad('« inbound.secretaries » doit être vrai ou faux.');
      const enabledAfter = i.enabled !== undefined ? i.enabled : cur.inbound.enabled === true;
      if (i.secretaries && !enabledAfter) return bad('Activez d’abord la lecture des e-mails entrants avant de l’ouvrir aux secrétaires.');
      set['inbound.secretaries'] = i.secretaries;
    }
    if (i.mailboxActions !== undefined) {
      if (typeof i.mailboxActions !== 'boolean') return bad('« inbound.mailboxActions » doit être vrai ou faux.');
      const enabledAfter = i.enabled !== undefined ? i.enabled : cur.inbound.enabled === true;
      if (i.mailboxActions && !enabledAfter) return bad('Activez d’abord la lecture des e-mails entrants avant de répercuter la suppression et l’archivage dans la messagerie.');
      set['inbound.mailboxActions'] = i.mailboxActions; // aucune écriture chez le fournisseur à ce stade : le réglage ne fait qu'autoriser les actions ultérieures
    }
  }

  if (b.agenda !== undefined) {
    const a = b.agenda;
    if (!a || typeof a !== 'object' || Array.isArray(a)) return bad('Réglages d’agenda invalides.');
    if (a.provider !== undefined) {
      if (!AGENDA_PROVIDERS.includes(a.provider)) return bad('Fournisseur d’agenda inconnu : choisissez « none », « google » ou « microsoft ».');
      if (a.provider !== 'none' && !connected.has(a.provider)) return notConnected(a.provider);
      set['agenda.provider'] = a.provider;
    }
  }

  if (b.visio !== undefined) {
    const v = b.visio;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return bad('Réglages de visio invalides.');
    let provider = cur.visio.provider;
    let customUrl = cur.visio.customUrl;
    if (v.provider !== undefined) {
      if (!PROVIDERS.includes(v.provider)) return bad('Fournisseur de visio inconnu : choisissez « jitsi », « custom », « google_meet », « teams » ou « zoom ».');
      if (VISIO_NEEDS[v.provider] && !connected.has(VISIO_NEEDS[v.provider])) return notConnected(VISIO_NEEDS[v.provider]);
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
    set['visio.provider'] = provider;
    set['visio.customUrl'] = customUrl;
    set['visio.chosen'] = true;
  }
  if (Object.keys(set).length === 0) return bad('Rien à modifier.');
  return { set };
}

/** Réponse de l'API. `feedUrl` n'est renseigné qu'au moment où le jeton vient d'être créé (il n'est jamais relisible ensuite). */
export function toView(doc, feedUrl = null) {
  const t = merged(doc);
  const email = { provider: t.email.provider, fromName: t.email.fromName, replyTo: t.email.replyTo, signature: t.email.signature };
  return {
    email,
    visio: { provider: t.visio.provider, customUrl: t.visio.customUrl },
    agenda: { provider: t.agenda.provider, feedUrl: feedUrl || null },
    timeZone: t.timeZone,
    inbound: { enabled: t.inbound.enabled === true, secretaries: t.inbound.enabled === true && t.inbound.secretaries === true, mailboxActions: t.inbound.enabled === true && t.inbound.mailboxActions === true },
    configured: {
      email: Boolean(email.fromName || email.replyTo || email.signature) || email.provider !== 'platform',
      // Vrai seulement si un fournisseur connecté (Google Meet, Teams, Zoom) est choisi ; 'jitsi' / 'custom' = aucune visio.
      visio: Object.hasOwn(VISIO_NEEDS, t.visio.provider),
      agenda: (typeof t.agendaFeed.tokenHash === 'string' && t.agendaFeed.tokenHash.length > 0) || t.agenda.provider !== 'none',
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
