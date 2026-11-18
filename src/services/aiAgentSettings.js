import mongoose from 'mongoose';
import { normalizeTimeZone, DEFAULT_TIME_ZONE } from './timeZone.js';
import { clockIn } from './callTransfer.js';

/**
 * Pilote « Téléphonie + agent IA » (appels ENTRANTS) : réglages de l'entreprise, disponibilité du pilote, annonce IA obligatoire et
 * décision de routage. Logique pure : aucun accès base ni réseau. Contrat : etude-secretaire-ia/contrat-pilote.md, section 2.
 */
export const LEVELS = ['partial', 'total'];
export const LANGUAGES = ['fr-FR', 'en-GB', 'en-US'];
export const VOICES = ['female', 'male'];
export const ADDRESS_FORMS = ['vous', 'tu'];
export const TONES = ['professional', 'warm', 'energetic'];
export const BENCH_PROVIDERS = ['alternate', 'gemini', 'openai'];
export const MAX_INSTRUCTIONS = 4000;
export const MAX_COMPANY_NAME = 80;
export const MAX_SLOTS = 21;
export const MAX_TARGETS = 10;
export const RANGES = Object.freeze({
  maxCallMinutes: { min: 3, max: 15, def: 8 },
  monthlyMinutesCap: { min: 10, max: 10000, def: 200 },
  retentionDays: { min: 30, max: 365, def: 365 },
  'appointment.durationMinutes': { min: 15, max: 120, def: 30 },
  'appointment.daysAhead': { min: 1, max: 60, def: 14 },
});

const WEEKDAY_SLOTS = [1, 2, 3, 4, 5].flatMap((day) => [{ day, start: '09:00', end: '12:00' }, { day, start: '14:00', end: '18:00' }]);

export function defaultSettings() {
  return {
    enabled: false,
    level: 'partial',
    triggers: { outsideHours: true, allBusy: false },
    businessHours: { timeZone: DEFAULT_TIME_ZONE, slots: WEEKDAY_SLOTS.map((s) => ({ ...s })) },
    languages: ['fr-FR'],
    voice: 'female',
    addressForm: 'vous',
    tone: 'professional',
    companyName: '',
    instructions: '',
    knowledgeBase: { enabled: true, gigId: null },
    actions: { appointment: false, request: true, transfer: false },
    transferTargets: [],
    appointment: { durationMinutes: 30, daysAhead: 14 },
    maxCallMinutes: 8,
    monthlyMinutesCap: 200,
    retentionDays: 365,
    listeningBench: { enabled: false, provider: 'alternate' },
  };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const isObjectId = (v) => typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v) && mongoose.Types.ObjectId.isValid(v);
const issue = (field, code, message, extra = {}) => ({ field, code, message, ...extra });

/** Réglages stockés (document, éventuellement partiel) complétés des valeurs par défaut : forme publique du contrat (2.2). */
export function toPublicSettings(doc, { companyNameFallback = '' } = {}) {
  const d = defaultSettings();
  const s = doc || {};
  const pick = (v, def) => (v === undefined || v === null ? def : v);
  return {
    enabled: s.enabled === true,
    level: LEVELS.includes(s.level) ? s.level : d.level,
    triggers: { outsideHours: pick(s.triggers?.outsideHours, d.triggers.outsideHours) === true, allBusy: s.triggers?.allBusy === true },
    businessHours: {
      timeZone: normalizeTimeZone(s.businessHours?.timeZone) || d.businessHours.timeZone,
      slots: Array.isArray(s.businessHours?.slots) ? s.businessHours.slots.map(({ day, start, end }) => ({ day, start, end })) : d.businessHours.slots,
    },
    languages: Array.isArray(s.languages) && s.languages.length ? [...s.languages] : d.languages,
    voice: VOICES.includes(s.voice) ? s.voice : d.voice,
    addressForm: ADDRESS_FORMS.includes(s.addressForm) ? s.addressForm : d.addressForm,
    tone: TONES.includes(s.tone) ? s.tone : d.tone,
    companyName: s.companyName || companyNameFallback || '',
    instructions: s.instructions || '',
    knowledgeBase: { enabled: pick(s.knowledgeBase?.enabled, true) === true, gigId: s.knowledgeBase?.gigId ? String(s.knowledgeBase.gigId) : null },
    actions: {
      appointment: s.actions?.appointment === true,
      request: pick(s.actions?.request, true) === true,
      transfer: s.actions?.transfer === true,
    },
    transferTargets: Array.isArray(s.transferTargets) ? s.transferTargets.map(String) : [],
    appointment: {
      durationMinutes: pick(s.appointment?.durationMinutes, d.appointment.durationMinutes),
      daysAhead: pick(s.appointment?.daysAhead, d.appointment.daysAhead),
    },
    maxCallMinutes: pick(s.maxCallMinutes, d.maxCallMinutes),
    monthlyMinutesCap: pick(s.monthlyMinutesCap, d.monthlyMinutesCap),
    retentionDays: pick(s.retentionDays, d.retentionDays),
    listeningBench: {
      enabled: s.listeningBench?.enabled === true,
      provider: BENCH_PROVIDERS.includes(s.listeningBench?.provider) ? s.listeningBench.provider : 'alternate',
    },
    updatedAt: s.updatedAt || null,
  };
}

function intIn(field, value, issues) {
  const r = RANGES[field];
  const n = Number(value);
  if (!Number.isInteger(n) || n < r.min || n > r.max) { issues.push(issue(field, 'out_of_range', `${field} : entre ${r.min} et ${r.max}.`, { min: r.min, max: r.max })); return undefined; }
  return n;
}

/**
 * Valide une mise à jour PARTIELLE. Seuls les champs présents sont contrôlés et renvoyés dans `value` (chemins à plat pour $set).
 * `directoryEntryIds` : ids des fiches de l'annuaire de l'entreprise (destinataires de transfert autorisés).
 * @returns {{ ok: boolean, value: object, issues: object[], unknownTarget?: boolean }}
 */
export function validateSettingsUpdate(body, { directoryEntryIds = [] } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const issues = [];
  const v = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const bool = (field, value) => { if (typeof value !== 'boolean') { issues.push(issue(field, 'invalid_type', `${field} : vrai ou faux.`)); return; } v[field] = value; };

  if (has('enabled')) bool('enabled', b.enabled);
  if (has('level')) { if (LEVELS.includes(b.level)) v.level = b.level; else issues.push(issue('level', 'invalid_level', 'Niveau inconnu.')); }
  if (has('triggers')) {
    const t = b.triggers || {};
    // « Tous occupés » : limité par la capacité d'appels simultanés de la ligne (une ligne = un appel à la fois au-delà).
    if (t.allBusy !== undefined) bool('triggers.allBusy', t.allBusy);
    if (t.outsideHours !== undefined) bool('triggers.outsideHours', t.outsideHours);
  }
  if (has('businessHours')) {
    const h = b.businessHours || {};
    if (h.timeZone !== undefined) {
      const tz = normalizeTimeZone(h.timeZone);
      if (tz) v['businessHours.timeZone'] = tz; else issues.push(issue('businessHours.timeZone', 'invalid_time_zone', 'Fuseau horaire inconnu.'));
    }
    if (h.slots !== undefined) {
      if (!Array.isArray(h.slots)) issues.push(issue('businessHours.slots', 'invalid_type', 'Plages : liste attendue.'));
      else if (h.slots.length > MAX_SLOTS) issues.push(issue('businessHours.slots', 'too_many_slots', `${MAX_SLOTS} plages au maximum.`));
      else {
        const bad = h.slots.findIndex((s) => !s || !Number.isInteger(s.day) || s.day < 1 || s.day > 7 || !HHMM.test(s.start) || !HHMM.test(s.end) || s.start >= s.end);
        if (bad >= 0) issues.push(issue(`businessHours.slots.${bad}`, 'invalid_slot', 'Plage invalide (jour 1 à 7, HH:MM, début avant fin).'));
        else v['businessHours.slots'] = h.slots.map(({ day, start, end }) => ({ day, start, end })).sort((a, c) => a.day - c.day || a.start.localeCompare(c.start));
      }
    }
  }
  if (has('languages')) {
    const l = b.languages;
    if (!Array.isArray(l) || !l.length || l.length > 3 || new Set(l).size !== l.length || l.some((x) => !LANGUAGES.includes(x))) issues.push(issue('languages', 'invalid_language', 'Langues : 1 à 3 parmi fr-FR, en-GB, en-US, sans doublon.'));
    else v.languages = [...l];
  }
  if (has('voice')) { if (VOICES.includes(b.voice)) v.voice = b.voice; else issues.push(issue('voice', 'invalid_voice', 'Voix : female ou male.')); }
  if (has('addressForm')) { if (ADDRESS_FORMS.includes(b.addressForm)) v.addressForm = b.addressForm; else issues.push(issue('addressForm', 'invalid_address_form', 'Vouvoiement ou tutoiement : vous ou tu.')); }
  if (has('tone')) { if (TONES.includes(b.tone)) v.tone = b.tone; else issues.push(issue('tone', 'invalid_tone', 'Ton inconnu.')); }
  for (const [field, max] of [['companyName', MAX_COMPANY_NAME], ['instructions', MAX_INSTRUCTIONS]]) {
    if (!has(field)) continue;
    if (typeof b[field] !== 'string') issues.push(issue(field, 'invalid_type', `${field} : texte attendu.`));
    else if (b[field].trim().length > max) issues.push(issue(field, 'too_long', `${field} : ${max} caractères au maximum.`, { max }));
    else v[field] = field === 'companyName' ? b[field].replace(/\s+/g, ' ').trim() : b[field].trim();
  }
  if (has('knowledgeBase')) {
    const k = b.knowledgeBase || {};
    if (k.enabled !== undefined) bool('knowledgeBase.enabled', k.enabled);
    if (k.gigId !== undefined) {
      if (k.gigId === null || k.gigId === '') v['knowledgeBase.gigId'] = null;
      else if (isObjectId(k.gigId)) v['knowledgeBase.gigId'] = k.gigId;
      else issues.push(issue('knowledgeBase.gigId', 'invalid_gig', 'Base de connaissances inconnue.'));
    }
  }
  if (has('actions')) {
    const a = b.actions || {};
    for (const k of ['appointment', 'request', 'transfer']) if (a[k] !== undefined) bool(`actions.${k}`, a[k]);
  }
  let unknownTarget = false;
  if (has('transferTargets')) {
    const t = b.transferTargets;
    if (!Array.isArray(t)) issues.push(issue('transferTargets', 'invalid_type', 'Destinataires : liste attendue.'));
    else if (t.length > MAX_TARGETS) issues.push(issue('transferTargets', 'too_many_targets', `${MAX_TARGETS} destinataires au maximum.`));
    else if (t.some((x) => !isObjectId(x))) issues.push(issue('transferTargets', 'invalid_target', 'Destinataire invalide.'));
    else if (t.some((x) => !directoryEntryIds.map(String).includes(x))) unknownTarget = true;
    else v.transferTargets = [...new Set(t)];
  }
  if (has('appointment')) {
    const a = b.appointment || {};
    for (const k of ['durationMinutes', 'daysAhead']) if (a[k] !== undefined) { const n = intIn(`appointment.${k}`, a[k], issues); if (n !== undefined) v[`appointment.${k}`] = n; }
  }
  for (const field of ['maxCallMinutes', 'monthlyMinutesCap', 'retentionDays']) if (has(field)) { const n = intIn(field, b[field], issues); if (n !== undefined) v[field] = n; }
  if (has('listeningBench')) {
    const lb = b.listeningBench || {};
    if (lb.enabled !== undefined) bool('listeningBench.enabled', lb.enabled);
    if (lb.provider !== undefined) { if (BENCH_PROVIDERS.includes(lb.provider)) v['listeningBench.provider'] = lb.provider; else issues.push(issue('listeningBench.provider', 'invalid_provider', 'Moteur inconnu.')); }
  }
  return { ok: !issues.length && !unknownTarget, value: v, issues, unknownTarget };
}

// ---------------------------------------------------------------- disponibilité du pilote (recette)

const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());
export const allowedCompanyIds = (env = process.env) => String(env.AI_INBOUND_COMPANY_IDS || '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);

/** Drapeau AI_INBOUND_ENABLED ET entreprise dans AI_INBOUND_COMPANY_IDS : les deux sont désactivés par défaut. */
export function pilotAvailability(companyId, env = process.env) {
  const pilotEnabled = truthy(env.AI_INBOUND_ENABLED);
  const companyAllowed = Boolean(companyId) && allowedCompanyIds(env).includes(String(companyId));
  return { pilotEnabled, companyAllowed, available: pilotEnabled && companyAllowed };
}

// ---------------------------------------------------------------- horaires et décision de routage

/** Dans une plage d'ouverture maintenant (fuseau de l'entreprise) ? */
export function isWithinBusinessHours(businessHours, now = Date.now()) {
  const tz = normalizeTimeZone(businessHours?.timeZone) || DEFAULT_TIME_ZONE;
  const clock = clockIn(tz, now);
  return (businessHours?.slots || []).some((s) => s.day === clock.weekday && s.start <= clock.time && clock.time < s.end);
}

/**
 * L'agent IA décroche-t-il cet appel ? Ordre des contrôles : pilote ouvert, réglage activé, capacité de la ligne (appels simultanés choisis
 * par l'entreprise ; capacité épuisée = flux classique), déclencheur (total ; partiel : hors horaires, ou « tous occupés » = appel simultané
 * pris dans la capacité restante alors qu'un autre appel tient déjà la ligne), plafond mensuel.
 * @returns {{ route: boolean, reason: string, trigger?: string }}
 */
export function decideAiRoute({ settings, availability, lineBusy = false, concurrent = false, minutesUsed = 0, now = Date.now() }) {
  if (!availability?.available) return { route: false, reason: 'pilot_closed' };
  if (!settings?.enabled) return { route: false, reason: 'disabled' };
  if (lineBusy) return { route: false, reason: 'line_busy' };
  let trigger = null;
  if (settings.level === 'total') trigger = 'total';
  else if (settings.triggers?.outsideHours && !isWithinBusinessHours(settings.businessHours, now)) trigger = 'outside_hours';
  else if (settings.triggers?.allBusy && concurrent) trigger = 'all_busy';
  if (!trigger) return { route: false, reason: 'no_trigger' };
  if (Number(minutesUsed) >= Number(settings.monthlyMinutesCap)) return { route: false, reason: 'cap_reached' };
  return { route: true, reason: 'ok', trigger };
}

// ---------------------------------------------------------------- annonce IA obligatoire (AI Act art. 50)

const shortLang = (language) => (String(language || '').toLowerCase().startsWith('en') ? 'en' : 'fr');

/**
 * Texte exact de l'annonce (contrat, section 3). Seul `companyName` est personnalisable ; la phrase IA ne l'est jamais.
 * `recorded` : banc d'écoute (appel enregistré) → phrase de consentement existante ajoutée.
 */
export function announcementText({ language = 'fr-FR', companyName = '', level = 'partial', voice = 'female', recorded = false, consentText = '' } = {}) {
  const name = String(companyName || '').replace(/\s+/g, ' ').trim().slice(0, MAX_COMPANY_NAME);
  if (shortLang(language) === 'en') {
    const hello = name ? `Hello, you've reached ${name}.` : 'Hello.';
    const last = level === 'total' ? 'You can ask to be called back by a person or leave a message.' : 'You can ask to speak to a person at any time.';
    return [hello, "I'm the company's virtual assistant, an artificial intelligence.", 'This conversation is transcribed to handle your request.', last, recorded ? consentText : ''].filter(Boolean).join(' ');
  }
  const hello = name ? `Bonjour, vous êtes bien chez ${name}.` : 'Bonjour.';
  const who = voice === 'male' ? "Je suis l'assistant virtuel de l'entreprise, une intelligence artificielle." : "Je suis l'assistante virtuelle de l'entreprise, une intelligence artificielle.";
  const last = level === 'total' ? 'Vous pouvez demander à être rappelé par une personne ou laisser un message.' : 'Vous pouvez demander à parler à une personne à tout moment.';
  return [hello, who, 'Notre échange est transcrit pour traiter votre demande.', last, recorded ? consentText : ''].filter(Boolean).join(' ');
}

/** Mention IA que la transcription de l'IA doit contenir pour que l'annonce soit validée. */
export const ANNOUNCEMENT_MARKERS = { fr: /intelligence artificielle/i, en: /artificial intelligence/i };
export const announcementVerified = (transcript, language) => ANNOUNCEMENT_MARKERS[shortLang(language)].test(String(transcript || ''));

/** Langue d'accueil : la première langue réglée (l'IA suit ensuite l'appelant parmi les langues réglées). */
export const greetingLanguage = (settings) => (settings?.languages?.[0] && LANGUAGES.includes(settings.languages[0]) ? settings.languages[0] : 'fr-FR');
