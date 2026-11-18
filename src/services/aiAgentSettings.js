import mongoose from 'mongoose';
import { normalizeTimeZone, DEFAULT_TIME_ZONE } from './timeZone.js';
import { clockIn } from './callTransfer.js';
import { covers, normalizeSkills } from './callQueues.js';

/**
 * Pilote « Téléphonie + agent IA » (appels ENTRANTS) : réglages de l'entreprise, disponibilité du pilote, annonce IA obligatoire et
 * décision de routage. Logique pure : aucun accès base ni réseau. Contrat : etude-secretaire-ia/contrat-pilote.md, section 2.
 */
/** Priorité de l'agent IA face aux humains : « après les humains » (défaut) ou « en premier ». */
export const PRIORITIES = ['after_humans', 'first'];
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
    // L'agent IA se règle comme un agent humain : ses horaires (plages jour / heure, même format que le planning de l'annuaire),
    // ses compétences (mêmes étiquettes que le routage des files), et une priorité. Plus de « niveau » ni de déclencheurs.
    schedule: { always: false, timeZone: DEFAULT_TIME_ZONE, slots: [] },
    skills: [],
    priority: 'after_humans',
    // Horaires d'ouverture : servent seulement à proposer des créneaux de rendez-vous.
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
    learning: { enabled: true },
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
    schedule: {
      always: s.schedule?.always === true,
      timeZone: normalizeTimeZone(s.schedule?.timeZone) || d.schedule.timeZone,
      slots: Array.isArray(s.schedule?.slots) ? s.schedule.slots.map(({ day, start, end }) => ({ day, start, end })) : [],
    },
    skills: Array.isArray(s.skills) ? [...s.skills] : [],
    priority: PRIORITIES.includes(s.priority) ? s.priority : d.priority,
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
    learning: { enabled: pick(s.learning?.enabled, true) === true },
    listeningBench: {
      enabled: s.listeningBench?.enabled === true,
      provider: BENCH_PROVIDERS.includes(s.listeningBench?.provider) ? s.listeningBench.provider : 'alternate',
    },
    updatedAt: s.updatedAt || null,
  };
}

/** Plages { day 1..7, start, end } (format du planning de l'annuaire). @returns {object[]|null} */
function checkSlots(field, slots, issues) {
  if (!Array.isArray(slots)) { issues.push(issue(field, 'invalid_type', 'Plages : liste attendue.')); return null; }
  if (slots.length > MAX_SLOTS) { issues.push(issue(field, 'too_many_slots', `${MAX_SLOTS} plages au maximum.`)); return null; }
  const bad = slots.findIndex((x) => !x || !Number.isInteger(x.day) || x.day < 1 || x.day > 7 || !HHMM.test(x.start) || !(HHMM.test(x.end) || x.end === '24:00') || x.start >= x.end);
  if (bad >= 0) { issues.push(issue(`${field}.${bad}`, 'invalid_slot', 'Plage invalide (jour 1 à 7, HH:MM, début avant fin).')); return null; }
  return slots.map(({ day, start, end }) => ({ day, start, end })).sort((a, c) => a.day - c.day || a.start.localeCompare(c.start));
}

/** Avertissements (sans erreur) : agent activé qui ne décrochera jamais. */
export function settingsWarnings(settings) {
  const w = [];
  if (settings.enabled && !settings.schedule.always && !settings.schedule.slots.length) {
    w.push({ code: 'AI_NO_SCHEDULE', message: "L'agent IA est activé mais n'a aucun horaire : il ne décrochera aucun appel." });
  }
  return w;
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
  // `level` (ancien « partiel / total ») et `triggers` : ignorés sans erreur (remplacés par horaires + priorité).
  if (has('schedule')) {
    const sc = b.schedule || {};
    if (sc.always !== undefined) bool('schedule.always', sc.always);
    if (sc.timeZone !== undefined) {
      const tz = normalizeTimeZone(sc.timeZone);
      if (tz) v['schedule.timeZone'] = tz; else issues.push(issue('schedule.timeZone', 'invalid_time_zone', 'Fuseau horaire inconnu.'));
    }
    if (sc.slots !== undefined) {
      const slots = checkSlots('schedule.slots', sc.slots, issues);
      if (slots) v['schedule.slots'] = slots;
    }
  }
  if (has('skills')) {
    const r = normalizeSkills(b.skills);
    if (r && r.error) issues.push(issue('skills', 'invalid_skills', r.error));
    else v.skills = Array.isArray(r) ? r : (r?.value || []);
  }
  if (has('priority')) { if (PRIORITIES.includes(b.priority)) v.priority = b.priority; else issues.push(issue('priority', 'invalid_priority', 'Priorité : after_humans ou first.')); }
  if (has('businessHours')) {
    const h = b.businessHours || {};
    if (h.timeZone !== undefined) {
      const tz = normalizeTimeZone(h.timeZone);
      if (tz) v['businessHours.timeZone'] = tz; else issues.push(issue('businessHours.timeZone', 'invalid_time_zone', 'Fuseau horaire inconnu.'));
    }
    if (h.slots !== undefined) {
      const slots = checkSlots('businessHours.slots', h.slots, issues);
      if (slots) v['businessHours.slots'] = slots;
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
  if (has('learning')) { const l = b.learning || {}; if (l.enabled !== undefined) bool('learning.enabled', l.enabled); }
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

/**
 * Agent IA ouvert pour l'entreprise : drapeau AI_INBOUND_ENABLED (désactivé par défaut) ET (entreprise dans AI_INBOUND_COMPANY_IDS OU
 * abonnement actif à une formule portant `ai_agent=true`). L'interrupteur `enabled` de l'entreprise reste ensuite décisif.
 * @param {{ aiAgentPlan?: boolean }} plan  abonnement actif à la formule « Secrétariat avec agent IA »
 */
export function pilotAvailability(companyId, env = process.env, { aiAgentPlan = false } = {}) {
  const pilotEnabled = truthy(env.AI_INBOUND_ENABLED);
  const listed = Boolean(companyId) && allowedCompanyIds(env).includes(String(companyId));
  const subscribed = Boolean(companyId) && aiAgentPlan === true;
  const companyAllowed = listed || subscribed;
  return { pilotEnabled, companyAllowed, available: pilotEnabled && companyAllowed, source: listed ? 'whitelist' : subscribed ? 'subscription' : null };
}

// ---------------------------------------------------------------- horaires et décision de routage

/** Dans une plage d'ouverture maintenant (fuseau de l'entreprise) ? */
export function isWithinBusinessHours(businessHours, now = Date.now()) {
  const tz = normalizeTimeZone(businessHours?.timeZone) || DEFAULT_TIME_ZONE;
  const clock = clockIn(tz, now);
  return (businessHours?.slots || []).some((s) => s.day === clock.weekday && s.start <= clock.time && clock.time < s.end);
}

/** L'agent IA est-il « disponible » maintenant (ses horaires, comme un agent) ? `always` = 24 h/24, 7 j/7. */
export function isOnSchedule(schedule, now = Date.now()) {
  if (schedule?.always) return true;
  return isWithinBusinessHours({ timeZone: schedule?.timeZone, slots: (schedule?.slots || []).map((x) => ({ ...x, end: x.end === '24:00' ? '24:00' : x.end })) }, now);
}

/** Langues de routage de l'IA (codes ISO 639-1, comme StaffRouting) : déduites des langues parlées (fr-FR → fr). */
export const routingLanguagesOf = (settings) => [...new Set((settings.languages || []).map((l) => String(l).slice(0, 2).toLowerCase()))];

/** L'IA a-t-elle la compétence demandée ? Même règle que pour une secrétaire (callQueues.covers). Sans file : aucune exigence. */
export const isCompetent = (settings, queue) => !queue || covers({ languages: routingLanguagesOf(settings), skills: settings.skills || [] }, queue);

/**
 * L'agent IA prend-il cet appel ? Pilote ouvert, interrupteur, capacité de la ligne (épuisée = flux classique), horaires de l'IA,
 * compétence pour la file, priorité, plafond mensuel.
 *  - `first` : l'IA décroche dès l'arrivée de l'appel (ou au retour du menu vocal), avant les humains ;
 *  - `after_humans` (défaut) : l'IA décroche seulement quand aucun humain ne peut prendre l'appel (`humansAvailable` faux à l'arrivée),
 *    ou en dernier recours après la sonnerie sans réponse des humains (étape `after_humans`), avant le répondeur.
 * @param {'call'|'menu'|'after_humans'} stage
 * @returns {{ route: boolean, reason: string, trigger?: 'first'|'no_human'|'after_humans' }}
 */
export function decideAiRoute({ settings, availability, lineBusy = false, stage = 'call', humansAvailable = false, queue = null, minutesUsed = 0, now = Date.now() }) {
  if (!availability?.available) return { route: false, reason: 'pilot_closed' };
  if (!settings?.enabled) return { route: false, reason: 'disabled' };
  if (lineBusy) return { route: false, reason: 'line_busy' };
  if (!isOnSchedule(settings.schedule, now)) return { route: false, reason: 'off_schedule' };
  if (!isCompetent(settings, queue)) return { route: false, reason: 'not_competent' };
  let trigger = null;
  if (stage === 'after_humans') trigger = 'after_humans';
  else if (settings.priority === 'first') trigger = 'first';
  else if (!humansAvailable) trigger = 'no_human';
  if (!trigger) return { route: false, reason: 'humans_first' };
  if (Number(minutesUsed) >= Number(settings.monthlyMinutesCap)) return { route: false, reason: 'cap_reached' };
  return { route: true, reason: 'ok', trigger };
}

/**
 * Migration des réglages du pilote d'avant (niveau / déclencheurs) vers horaires + priorité :
 *  - `level: total` → horaires 24/7 et priorité « en premier » ;
 *  - `level: partial` + « hors horaires » → horaires de l'IA = complément des horaires d'ouverture, priorité « en premier » ;
 *  - `level: partial` + « toutes les lignes occupées » seul → 24/7 et priorité « après les humains » (l'IA prend quand personne ne peut) ;
 *  - aucun déclencheur → aucun horaire (l'agent ne décroche rien, avertissement).
 * @returns {{ $set: object, $unset: object }|null} null si le document est déjà au nouveau format.
 */
export function migrateLegacySettings(doc) {
  if (!doc || doc.schedule !== undefined || (doc.level === undefined && doc.triggers === undefined)) return null;
  const tz = normalizeTimeZone(doc.businessHours?.timeZone) || DEFAULT_TIME_ZONE;
  let schedule = { always: false, timeZone: tz, slots: [] };
  let priority = 'after_humans';
  const outsideHours = doc.triggers?.outsideHours === undefined ? true : doc.triggers.outsideHours === true;
  if (doc.level === 'total') {
    schedule = { always: true, timeZone: tz, slots: [] };
    priority = 'first';
  } else if (outsideHours) {
    const open = Array.isArray(doc.businessHours?.slots) ? doc.businessHours.slots : defaultSettings().businessHours.slots;
    schedule = { always: false, timeZone: tz, slots: complementSlots(open) };
    priority = 'first';
  } else if (doc.triggers?.allBusy === true) {
    schedule = { always: true, timeZone: tz, slots: [] };
  }
  // Anciens champs sauvegardés (retour arrière possible), puis retirés.
  return { $set: { schedule, priority, legacyLevel: doc.level ?? null, legacyTriggers: doc.triggers ?? null }, $unset: { level: '', triggers: '' } };
}

/** Complément d'une semaine de plages (« hors horaires d'ouverture ») : mêmes jours 1..7, fin de journée notée 24:00. */
export function complementSlots(open) {
  const out = [];
  for (let day = 1; day <= 7; day += 1) {
    const ranges = (open || []).filter((x) => x.day === day).sort((a, b) => a.start.localeCompare(b.start));
    let cursor = '00:00';
    for (const r of ranges) { if (r.start > cursor) out.push({ day, start: cursor, end: r.start }); if (r.end > cursor) cursor = r.end; }
    if (cursor < '24:00') out.push({ day, start: cursor, end: '24:00' });
  }
  return out;
}

// ---------------------------------------------------------------- annonce IA obligatoire (AI Act art. 50)

const shortLang = (language) => (String(language || '').toLowerCase().startsWith('en') ? 'en' : 'fr');

/**
 * Texte exact de l'annonce (contrat, section 3). Seul `companyName` est personnalisable ; la phrase IA ne l'est jamais.
 * `recorded` : banc d'écoute (appel enregistré) → phrase de consentement existante ajoutée.
 */
export function announcementText({ language = 'fr-FR', companyName = '', canTransfer = true, voice = 'female', recorded = false, consentText = '' } = {}) {
  const name = String(companyName || '').replace(/\s+/g, ' ').trim().slice(0, MAX_COMPANY_NAME);
  if (shortLang(language) === 'en') {
    const hello = name ? `Hello, you've reached ${name}.` : 'Hello.';
    const last = !canTransfer ? 'You can ask to be called back by a person or leave a message.' : 'You can ask to speak to a person at any time.';
    return [hello, "I'm the company's virtual assistant, an artificial intelligence.", 'This conversation is transcribed to handle your request.', last, recorded ? consentText : ''].filter(Boolean).join(' ');
  }
  const hello = name ? `Bonjour, vous êtes bien chez ${name}.` : 'Bonjour.';
  const who = voice === 'male' ? "Je suis l'assistant virtuel de l'entreprise, une intelligence artificielle." : "Je suis l'assistante virtuelle de l'entreprise, une intelligence artificielle.";
  const last = !canTransfer ? 'Vous pouvez demander à être rappelé par une personne ou laisser un message.' : 'Vous pouvez demander à parler à une personne à tout moment.';
  return [hello, who, 'Notre échange est transcrit pour traiter votre demande.', last, recorded ? consentText : ''].filter(Boolean).join(' ');
}

/** Mention IA que la transcription de l'IA doit contenir pour que l'annonce soit validée. */
export const ANNOUNCEMENT_MARKERS = { fr: /intelligence artificielle/i, en: /artificial intelligence/i };
export const announcementVerified = (transcript, language) => ANNOUNCEMENT_MARKERS[shortLang(language)].test(String(transcript || ''));

/** Langue d'accueil : la première langue réglée (l'IA suit ensuite l'appelant parmi les langues réglées). */
export const greetingLanguage = (settings) => (settings?.languages?.[0] && LANGUAGES.includes(settings.languages[0]) ? settings.languages[0] : 'fr-FR');
