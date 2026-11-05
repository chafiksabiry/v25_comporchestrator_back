import { languageInfo, normalizeLanguageCode } from './routingLanguages.js';

/**
 * Files d'attente : validation, vues et logique de routage PURES (aucun accès base ni réseau, testables telles quelles).
 * Une file porte des langues et des compétences ; une secrétaire (StaffRouting) aussi. Une secrétaire est éligible à une file
 * quand son profil couvre TOUTES les langues ET TOUTES les compétences de la file.
 */
export const NAME_MAX = 60;
export const PROMPT_MAX = 160;
export const SKILL_MAX_LENGTH = 24;
export const SKILLS_MAX = 12;
export const MAX_INBOUND_QUEUES = 9;
export const MAX_QUEUES = 50;
export const DIRECTIONS = ['inbound', 'outbound'];
export const STRATEGIES = ['simultaneous', 'longest_idle', 'round_robin'];
export const MENU_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
/** Sonnerie d'une secrétaire quand les files sonnent une par une. */
export const SEQUENTIAL_RING_SECONDS = 15;
/** Plafond de tentatives (une tentative = une secrétaire à tour de rôle, ou le groupe entier en sonnerie simultanée). */
export const MAX_ATTEMPTS = 5;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const OBJECT_ID = /^[a-f0-9]{24}$/i;

// ---------------------------------------------------------------- normalisation

/** @returns {{value: string[]}|{error: string}} codes en minuscules, sans doublon, dans la liste fermée */
export function normalizeLanguages(input) {
  if (input === undefined || input === null) return { value: [] };
  if (!Array.isArray(input)) return { error: 'Les langues doivent être une liste.' };
  const out = [];
  for (const raw of input) {
    const code = normalizeLanguageCode(raw);
    if (!code) return { error: `Langue inconnue : « ${typeof raw === 'string' ? raw.trim().slice(0, 20) : String(raw)} ».` };
    if (!out.includes(code)) out.push(code);
  }
  return { value: out };
}

/** @returns {{value: string[]}|{error: string}} trim, minuscules, ≤ 24 caractères, 12 au plus, sans doublon */
export function normalizeSkills(input) {
  if (input === undefined || input === null) return { value: [] };
  if (!Array.isArray(input)) return { error: 'Les compétences doivent être une liste.' };
  const out = [];
  for (const raw of input) {
    if (typeof raw !== 'string') return { error: 'Chaque compétence doit être un texte.' };
    const skill = raw.trim().replace(/\s+/g, ' ').toLowerCase();
    if (!skill) continue;
    if (CONTROL.test(skill)) return { error: 'Une compétence contient des caractères non autorisés.' };
    if (skill.length > SKILL_MAX_LENGTH) return { error: `Une compétence ne peut pas dépasser ${SKILL_MAX_LENGTH} caractères (« ${skill.slice(0, 30)} »).` };
    if (!out.includes(skill)) out.push(skill);
  }
  if (out.length > SKILLS_MAX) return { error: `Au plus ${SKILLS_MAX} compétences.` };
  return { value: out };
}

/** Profil d'une secrétaire : { languages, skills } (les deux listes sont obligatoires, elles remplacent l'existant). */
export function validateStaffProfile(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b) return { error: 'Corps de requête invalide.' };
  if (!Array.isArray(b.languages)) return { error: 'Les langues doivent être une liste.' };
  if (!Array.isArray(b.skills)) return { error: 'Les compétences doivent être une liste.' };
  const languages = normalizeLanguages(b.languages);
  if (languages.error) return { error: languages.error };
  const skills = normalizeSkills(b.skills);
  if (skills.error) return { error: skills.error };
  return { value: { languages: languages.value, skills: skills.value } };
}

const normalizeMenuKey = (v) => {
  if (v === undefined || v === null || v === '') return { value: null };
  const s = typeof v === 'number' && Number.isInteger(v) ? String(v) : v;
  if (typeof s === 'string' && MENU_KEYS.includes(s.trim())) return { value: s.trim() };
  return { error: 'La touche du menu doit être un chiffre de 1 à 9.' };
};

/** Valide une file seule (sans les règles d'ensemble). `index` ne sert qu'à nommer la file dans le message. */
export function validateQueue(raw, index = 0) {
  const q = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  const label = `File ${index + 1}`;
  if (!q) return { error: `${label} : données invalides.` };
  if (typeof q.name !== 'string') return { error: `${label} : le nom est obligatoire.` };
  const name = q.name.trim().replace(/\s+/g, ' ');
  if (!name) return { error: `${label} : le nom est obligatoire.` };
  if (name.length > NAME_MAX) return { error: `${label} : le nom ne peut pas dépasser ${NAME_MAX} caractères.` };
  if (CONTROL.test(name)) return { error: `${label} : le nom contient des caractères non autorisés.` };
  const at = `File « ${name} »`;

  const direction = q.direction === undefined ? 'inbound' : q.direction;
  if (!DIRECTIONS.includes(direction)) return { error: `${at} : le sens doit être « inbound » ou « outbound ».` };
  const strategy = q.strategy === undefined ? 'simultaneous' : q.strategy;
  if (!STRATEGIES.includes(strategy)) return { error: `${at} : la répartition doit être « simultaneous », « longest_idle » ou « round_robin ».` };

  const languages = normalizeLanguages(q.languages);
  if (languages.error) return { error: `${at} : ${languages.error}` };
  const skills = normalizeSkills(q.skills);
  if (skills.error) return { error: `${at} : ${skills.error}` };

  if (q.isDefault !== undefined && typeof q.isDefault !== 'boolean') return { error: `${at} : « file par défaut » doit être vrai ou faux.` };
  const isDefault = q.isDefault === true;
  const key = normalizeMenuKey(q.menuKey);
  if (key.error) return { error: `${at} : ${key.error}` };
  if (direction === 'outbound' && (isDefault || key.value)) return { error: `${at} : une file sortante n'a ni touche de menu ni statut de file par défaut.` };

  let prompt = '';
  if (q.prompt !== undefined && q.prompt !== null) {
    if (typeof q.prompt !== 'string') return { error: `${at} : le texte du menu doit être du texte.` };
    prompt = q.prompt.trim().replace(/\s+/g, ' ');
    if (prompt.length > PROMPT_MAX) return { error: `${at} : le texte du menu ne peut pas dépasser ${PROMPT_MAX} caractères.` };
    if (CONTROL.test(prompt)) return { error: `${at} : le texte du menu contient des caractères non autorisés.` };
  }
  let promptLanguage = '';
  if (q.promptLanguage !== undefined && q.promptLanguage !== null && q.promptLanguage !== '') {
    promptLanguage = normalizeLanguageCode(q.promptLanguage);
    if (!promptLanguage) return { error: `${at} : langue du texte du menu inconnue.` };
  }
  const id = typeof q.id === 'string' && OBJECT_ID.test(q.id) ? q.id : null;
  return { value: { id, name, direction, strategy, languages: languages.value, skills: skills.value, isDefault, menuKey: key.value, prompt, promptLanguage } };
}

/** Valide TOUT l'ensemble des files d'un centre (corps `{ queues: [...] }` ou liste). */
export function validateQueueSet(list) {
  if (!Array.isArray(list)) return { error: 'La liste des files est invalide.' };
  if (list.length > MAX_QUEUES) return { error: `Au plus ${MAX_QUEUES} files par centre.` };
  const queues = [];
  for (let i = 0; i < list.length; i += 1) {
    const r = validateQueue(list[i], i);
    if (r.error) return { error: r.error };
    queues.push(r.value);
  }
  const inbound = queues.filter((q) => q.direction === 'inbound');
  if (inbound.length > MAX_INBOUND_QUEUES) return { error: `Au plus ${MAX_INBOUND_QUEUES} files entrantes (une touche de 1 à 9 par file).` };
  if (inbound.filter((q) => q.isDefault).length > 1) return { error: 'Une seule file entrante peut être la file par défaut.' };
  const seen = new Map();
  for (const q of inbound) {
    if (!q.menuKey) continue;
    if (seen.has(q.menuKey)) return { error: `La touche ${q.menuKey} est utilisée par deux files (« ${seen.get(q.menuKey)} » et « ${q.name} »).` };
    seen.set(q.menuKey, q.name);
  }
  const ids = queues.map((q) => q.id).filter(Boolean);
  if (new Set(ids).size !== ids.length) return { error: 'Une même file apparaît deux fois.' };
  return { queues };
}

export const toQueueView = (d) => ({
  id: String(d._id ?? d.id),
  name: d.name,
  direction: d.direction || 'inbound',
  strategy: d.strategy || 'simultaneous',
  languages: Array.isArray(d.languages) ? [...d.languages] : [],
  skills: Array.isArray(d.skills) ? [...d.skills] : [],
  isDefault: Boolean(d.isDefault),
  menuKey: d.menuKey || null,
  prompt: d.prompt || '',
  promptLanguage: d.promptLanguage || '',
});

export const toStaffView = (d) => ({
  userId: String(d.userId),
  languages: Array.isArray(d.languages) ? [...d.languages] : [],
  skills: Array.isArray(d.skills) ? [...d.skills] : [],
});

// ---------------------------------------------------------------- routage pur

const sameId = (a, b) => String(a._id ?? a.id) === String(b._id ?? b.id);

/** Files entrantes, dans l'ordre stable (création puis identifiant). */
export function inboundQueues(all) {
  const t = (q) => (q.createdAt ? new Date(q.createdAt).getTime() : 0);
  return (Array.isArray(all) ? all : [])
    .filter((q) => (q.direction || 'inbound') === 'inbound')
    .sort((a, b) => t(a) - t(b) || String(a._id ?? a.id).localeCompare(String(b._id ?? b.id)));
}

/** Files présentes dans le menu vocal (celles qui ont une touche), par touche croissante. */
export const menuQueues = (inbound) => inbound.filter((q) => q.menuKey).sort((a, b) => Number(a.menuKey) - Number(b.menuKey));

/** File par défaut, sinon la première. */
export const defaultQueueOf = (inbound) => inbound.find((q) => q.isDefault) || inbound[0] || null;

/** File choisie par une touche (null si la touche est absente ou inconnue). */
export function chooseMenuQueue(inbound, digit) {
  const d = String(digit ?? '').trim();
  if (!MENU_KEYS.includes(d)) return null;
  return menuQueues(inbound).find((q) => q.menuKey === d) || null;
}

/** Faut-il un menu vocal ? Plusieurs files entrantes dont au moins deux ont une touche. */
export const needsMenu = (inbound) => inbound.length > 1 && menuQueues(inbound).length >= 2;

/** Le profil couvre-t-il toutes les langues et toutes les compétences de la file ? (profil absent = rien) */
export function covers(profile, queue) {
  const langs = new Set(profile?.languages || []);
  const skills = new Set(profile?.skills || []);
  return (queue.languages || []).every((l) => langs.has(l)) && (queue.skills || []).every((s) => skills.has(s));
}

/**
 * Identités en ligne éligibles pour une file (l'ordre de `online` est conservé).
 * `profiles` : Map identité -> { languages, skills } ; une identité absente de la Map a un profil vide.
 */
export function eligibleIdentities(queue, online, profiles) {
  return (online || []).filter((id) => covers(profiles?.get(id), queue));
}

/**
 * Tentatives de sonnerie d'une file : `[{ ids, t }]`.
 * - simultaneous : un seul groupe, toutes les identités éligibles (comportement actuel) ;
 * - longest_idle : une par une, la libre depuis le plus longtemps d'abord (`lastEnd` : Map identité -> ms ; inconnu = jamais
 *   vu = en tête) ;
 * - round_robin : une par une, en tournant à partir de `cursor`.
 */
export function attemptsFor(queue, ids, { cursor = 0, lastEnd = new Map(), ringSeconds = 30 } = {}) {
  if (!ids.length) return [];
  if (queue.strategy === 'longest_idle') {
    const sorted = [...ids].sort((a, b) => (lastEnd.get(a) ?? -Infinity) - (lastEnd.get(b) ?? -Infinity) || a.localeCompare(b));
    return sorted.map((id) => ({ ids: [id], t: SEQUENTIAL_RING_SECONDS, seq: true }));
  }
  if (queue.strategy === 'round_robin') {
    const sorted = [...ids].sort((a, b) => a.localeCompare(b));
    const start = ((Number.isInteger(cursor) ? cursor : 0) % sorted.length + sorted.length) % sorted.length;
    return [...sorted.slice(start), ...sorted.slice(0, start)].map((id) => ({ ids: [id], t: SEQUENTIAL_RING_SECONDS, seq: true }));
  }
  return [{ ids: [...ids], t: ringSeconds, seq: false }];
}

/**
 * Plan complet de sonnerie : la file choisie, puis (si ce n'est pas la file par défaut) les éligibles de la file par défaut
 * qui n'ont pas déjà été appelés. Plafonné à MAX_ATTEMPTS. Vide = personne à appeler (repli : mobile puis répondeur).
 */
export function buildPlan({ queue, defaultQueue = null, online, profiles, cursor = 0, defaultCursor = 0, lastEnd, ringSeconds = 30 }) {
  const primary = eligibleIdentities(queue, online, profiles);
  const attempts = attemptsFor(queue, primary, { cursor, lastEnd, ringSeconds });
  if (defaultQueue && !sameId(defaultQueue, queue)) {
    const tried = new Set(primary);
    const extra = eligibleIdentities(defaultQueue, online, profiles).filter((id) => !tried.has(id));
    attempts.push(...attemptsFor(defaultQueue, extra, { cursor: defaultCursor, lastEnd, ringSeconds }));
  }
  return attempts.slice(0, MAX_ATTEMPTS);
}

// ---------------------------------------------------------------- aperçu du routage

const list = (items) => items.join(', ');

/**
 * Aperçu pour l'écran : pour chaque file entrante, les secrétaires compatibles en ligne et au total.
 * `staff` : profils connus [{ identity, languages, skills }] ; `online` : identités en ligne (même sans profil).
 * Les secrétaires « connues » = celles qui ont un profil enregistré + celles actuellement en ligne.
 */
export function previewQueues({ queues, online, staff }) {
  const inbound = inboundQueues(queues);
  const profiles = new Map((staff || []).map((s) => [s.identity, s]));
  const known = [...new Set([...profiles.keys(), ...(online || [])])];
  const onlineSet = new Set(online || []);
  const def = defaultQueueOf(inbound);
  const stats = (q) => {
    const total = known.filter((id) => covers(profiles.get(id), q));
    return { total: total.length, online: total.filter((id) => onlineSet.has(id)).length };
  };
  return inbound.map((q) => {
    const { total, online: on } = stats(q);
    let warning = null;
    if (on === 0) {
      let cause;
      if (total === 0) {
        const missingLangs = (q.languages || []).filter((l) => !known.some((id) => (profiles.get(id)?.languages || []).includes(l)));
        const missingSkills = (q.skills || []).filter((s) => !known.some((id) => (profiles.get(id)?.skills || []).includes(s)));
        if (missingLangs.length) {
          const names = missingLangs.map((l) => languageInfo(l)?.nameFr || l);
          cause = missingLangs.length === 1 ? `Aucune secrétaire n'a la langue ${names[0]}` : `Aucune secrétaire n'a les langues ${list(names)}`;
        } else if (missingSkills.length) {
          cause = missingSkills.length === 1 ? `Aucune secrétaire n'a la compétence « ${missingSkills[0]} »` : `Aucune secrétaire n'a les compétences ${list(missingSkills.map((s) => `« ${s} »`))}`;
        } else if ((q.languages || []).length || (q.skills || []).length) {
          cause = "Aucune secrétaire n'a à la fois toutes les langues et toutes les compétences de cette file";
        } else {
          cause = "Aucune secrétaire n'est enregistrée ni en ligne pour cette file";
        }
      } else {
        cause = "Aucune secrétaire compatible n'est en ligne pour le moment";
      }
      const defaultHasOnline = def && !sameId(def, q) && stats(def).online > 0;
      const dest = defaultHasOnline ? `à la file par défaut « ${def.name} »` : 'au mobile puis au répondeur';
      warning = `${cause} : les appels de cette file iront ${dest}.`;
    }
    return { id: String(q._id ?? q.id), name: q.name, eligibleOnline: on, eligibleTotal: total, warning };
  });
}
