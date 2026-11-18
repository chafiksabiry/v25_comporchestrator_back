/**
 * Apprentissage de l'agent IA, validé par un humain (étude, section 7, options d et a) : AUCUN entraînement de modèle.
 * Après chaque appel IA, une analyse (un seul appel à un modèle texte économique, côté dash_calls) produit des propositions ; elles sont
 * anonymisées, regroupées (« appris de 3 appels ») puis validées, modifiées ou refusées par le titulaire. Seules les réponses validées
 * (AiLearnedAnswer) sont injectées dans les consignes de l'agent, dès l'appel suivant. Logique pure : aucun accès base ni réseau.
 */
export const KINDS = ['unanswered', 'transfer_unknown', 'caller_correction', 'recurring'];
export const LEARNED_KINDS = ['faq', 'instruction'];
export const MAX_QUESTION = 300;
export const MAX_ANSWER = 1000;
export const MAX_PROPOSALS_PER_CALL = 5;
export const RECURRING_THRESHOLD = 3;
export const SIMILARITY_THRESHOLD = 0.6;
export const MAX_INJECTED = 40;

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Anonymise un texte destiné à une réponse apprise : e-mails, numéros (téléphone, IBAN, carte…), noms connus de l'appel, et noms
 * annoncés (« je m'appelle X », « Monsieur X », « Mme X »). Les réponses apprises ne contiennent jamais de donnée personnelle de l'appelant.
 */
export function anonymize(text, { names = [] } = {}) {
  let t = String(text ?? '');
  t = t.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[e-mail]');
  t = t.replace(/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}\b/g, '[numéro]');
  t = t.replace(/(?:\+|00)?\d[\d\s.\-()]{5,}\d/g, '[numéro]');
  for (const raw of names) {
    for (const part of String(raw || '').split(/\s+/).filter((p) => p.length >= 2)) {
      t = t.replace(new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '[nom]');
    }
  }
  t = t.replace(/\b(je m'appelle|je suis|mon nom est|my name is|this is)\s+([A-ZÀ-Ý][\p{L}'-]+(?:\s+[A-ZÀ-Ý][\p{L}'-]+)?)/giu, (m, a) => `${a} [nom]`);
  t = t.replace(/\b(Monsieur|Madame|Mademoiselle|M\.|Mme|Mlle|Mr\.?|Mrs\.?|Ms\.?|Dr\.?)\s+[A-ZÀ-Ý][\p{L}'-]+/gu, (m, a) => `${a} [nom]`);
  return t.replace(/\s+/g, ' ').trim();
}

const STOP = new Set('etes avez faites fait suis le la les un une des de du d l et ou a à au aux en est sont pour par sur dans avec que qui quoi quel quelle quels quelles est-ce ce cet cette ces vous nous je tu il elle on ils elles mon ma mes votre vos notre nos the a an of to is are do does what how when where can i you your my for in on at it'.split(' '));
/** Mots significatifs d'une question (minuscules, sans accents ni ponctuation, sans mots vides). */
export function tokens(text) {
  return String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
}
/** Similarité de Jaccard entre deux questions. */
export function similarity(a, b) {
  const A = new Set(tokens(a)); const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const w of A) if (B.has(w)) inter += 1;
  return inter / (A.size + B.size - inter);
}
export const groupKey = (question) => [...new Set(tokens(question))].sort().join(' ').slice(0, 120);

/**
 * Nettoie les propositions envoyées par dash pour UN appel : types connus, textes bornés et anonymisés, confiance 0..1, au plus 5.
 * @returns {{ kind, question, answer, confidence }[]}
 */
export function cleanProposals(raw, { names = [] } = {}) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const kind = KINDS.includes(p.kind) ? p.kind : 'unanswered';
    const question = clip(anonymize(p.question, { names }), MAX_QUESTION);
    if (tokens(question).length < 1) continue;
    const answer = clip(anonymize(p.proposedAnswer ?? p.answer ?? '', { names }), MAX_ANSWER);
    const c = Number(p.confidence);
    out.push({ kind, question, answer, confidence: Number.isFinite(c) ? Math.min(1, Math.max(0, Math.round(c * 100) / 100)) : 0.5 });
    if (out.length >= MAX_PROPOSALS_PER_CALL) break;
  }
  return out;
}

/** Proposition en attente la plus proche (même entreprise, déjà filtrée par l'appelant), ou null. */
export function findSimilar(pending, question, threshold = SIMILARITY_THRESHOLD) {
  let best = null; let score = 0;
  for (const p of pending || []) {
    const s = p.key && p.key === groupKey(question) ? 1 : similarity(p.question, question);
    if (s > score) { best = p; score = s; }
  }
  return score >= threshold ? best : null;
}

/** Valide une réponse apprise (validation d'une proposition, modification ou correction manuelle). */
export function validateLearned(body, { names = [] } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const issues = [];
  const question = clip(anonymize(b.question, { names }), MAX_QUESTION);
  const answer = clip(anonymize(b.answer, { names }), MAX_ANSWER);
  const kind = b.kind === undefined ? 'faq' : b.kind;
  if (!LEARNED_KINDS.includes(kind)) issues.push({ field: 'kind', code: 'invalid_kind', message: 'Type : faq ou instruction.' });
  if (kind === 'faq' && !tokens(question).length) issues.push({ field: 'question', code: 'required', message: 'Indiquez la question.' });
  if (!answer) issues.push({ field: 'answer', code: 'required', message: kind === 'instruction' ? 'Indiquez la consigne.' : 'Indiquez la réponse.' });
  return { ok: !issues.length, issues, value: { kind, question, answer } };
}

/** Réponses validées injectées dans les consignes de l'agent (les plus récentes d'abord, bornées). */
export function toInjected(rows) {
  return (rows || []).filter((r) => r.active !== false).slice(0, MAX_INJECTED)
    .map((r) => ({ kind: r.kind === 'instruction' ? 'instruction' : 'faq', question: clip(r.question, MAX_QUESTION), answer: clip(r.answer, MAX_ANSWER) }));
}

/** Lundi (AAAA-MM-JJ, UTC) de la semaine d'une date. */
export function weekOf(date) {
  const d = new Date(date);
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
}

/**
 * Progression par semaine : appels IA, taux de résolution sans transfert, questions sans réponse.
 * `calls` : fiches { startedAt, status, transfer, learning: { unanswered } , actions }.
 */
export function weeklyMetrics(calls) {
  const by = new Map();
  for (const c of calls || []) {
    if (!c.startedAt) continue;
    const w = weekOf(c.startedAt);
    const m = by.get(w) || { week: w, calls: 0, resolvedWithoutTransfer: 0, unanswered: 0 };
    m.calls += 1;
    if (c.status === 'completed' && !c.transfer?.entryName) m.resolvedWithoutTransfer += 1;
    const misses = (c.actions || []).filter((a) => a.type === 'search_knowledge' && a.ok === true && /Rien dans la base/.test(a.label || '')).length;
    m.unanswered += Number.isFinite(c.learning?.unanswered) ? c.learning.unanswered : misses;
    by.set(w, m);
  }
  return [...by.values()].sort((a, b) => a.week.localeCompare(b.week)).map((m) => ({ ...m, resolutionRate: m.calls ? Math.round((m.resolvedWithoutTransfer / m.calls) * 1000) / 1000 : null }));
}
