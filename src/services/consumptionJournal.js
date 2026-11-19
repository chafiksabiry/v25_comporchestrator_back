import { createHash } from 'node:crypto';
/**
 * Journal de consommation (minutes | jetons IA) d'une entreprise : fonctions PURES, en lecture seule.
 *
 * Le journal n'est pas stocké : il est reconstruit à chaque lecture à partir des sources existantes (portefeuille, paiements,
 * appels, registre d'usage des jetons). Aucune fonction d'ici n'écrit quoi que ce soit ni ne touche un solde.
 * Voir docs/JOURNAL_CONSOMMATION.md pour ce qui est tracé, reconstruit ou non reconstructible.
 */

export const NATURES = ['octroi_forfait', 'recharge', 'consommation', 'ajustement', 'expiration'];
export const TYPES = ['minutes', 'tokens'];
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
/** Plafond de lignes d'un export CSV (au-delà : export tronqué, signalé par un en-tête). */
export const CSV_MAX_ROWS = 20000;

const ISO_AT_END = /(\d{4}-\d{2}-\d{2}T[\d:.]+Z)$/;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const isoOrNull = (d) => {
  if (!d) return null;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
};
const str = (v) => (v == null || v === '' ? null : String(v));
/** Texte libre d'un service tiers : toute suite ressemblant à un numéro (6 chiffres ou plus) est masquée. */
export function scrub(v, n = 200) {
  if (v == null) return null;
  let s = String(v).slice(0, n);
  if (s.replace(/\D/g, '').length >= 6) s = s.replace(/\+?\d[\d\s().-]{3,}\d/g, '•••');
  return s;
}
const clip = scrub;

/** Date de période portée par une clé d'octroi (`<abonnement>:<ISO>` ou `tokens:<abonnement>:<ISO>`), null si absente. */
export function dateFromGrantKey(key) {
  const m = ISO_AT_END.exec(String(key || ''));
  return m ? isoOrNull(m[1]) : null;
}

/**
 * Numéro de la contrepartie, masqué : seuls les deux derniers chiffres restent, sans indicatif ni « + ».
 * Tout ce qui n'est pas un numéro (identifiant de client navigateur, vide, trop court) disparaît : null.
 */
export function maskCounterpart(raw) {
  const s = String(raw ?? '').trim();
  if (!s || /[a-z]/i.test(s)) return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 6) return null;
  return `${'•'.repeat(digits.length - 2)}${digits.slice(-2)}`;
}

const row = (r) => ({
  id: r.id,
  type: r.type,
  date: r.date ?? null,
  nature: r.nature,
  quantity: Number.isFinite(r.quantity) ? r.quantity : null,
  balanceAfter: null,
  reference: r.reference,
  coefficient: Number.isInteger(r.coefficient) ? r.coefficient : null, // crédits par minute, si connu pour cet appel
  zone: r.zone ?? null, // 'domestic' | 'international' si connue, sinon null
  source: r.source,
  reconstructed: Boolean(r.reconstructed),
  quantityApproximate: Boolean(r.quantityApproximate),
});

function paymentRows(type, payments, credits) {
  const out = [];
  const known = (credits || []).map((c) => String(c?.grantKey || ''));
  for (const p of payments || []) {
    if (!p || p.status !== 'succeeded') continue;
    const id = String(p._id);
    if (known.some((k) => k && k.includes(id))) continue; // déjà inscrit dans les crédits datés du portefeuille
    let quantity = null;
    let date = isoOrNull(p.fulfilledAt);
    const bundle = p.purpose === 'bundle_purchase';
    if (type === 'minutes') {
      if (p.purpose === 'minutes_purchase') quantity = round2(p.quantity);
      else if (bundle && p.meta?.minutesCredited === true) quantity = round2(p.meta.minutes);
    } else if (p.purpose === 'tokens_purchase') quantity = Math.round(Number(p.quantity));
    else if (bundle && p.meta?.tokensCredited === true) quantity = Math.round(Number(p.meta.tokens));
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    if (!date && bundle) date = isoOrNull(p.updatedAt) || isoOrNull(p.createdAt);
    if (!date) continue; // crédit non confirmé (fulfilledAt absent) : pas de ligne
    out.push(row({
      id: `payment:${id}:${type}`,
      type,
      date,
      nature: 'recharge',
      quantity,
      reference: {
        paymentId: id,
        purpose: p.purpose,
        provider: str(p.provider),
        providerRef: str(p.providerRef),
        amountCents: Number.isFinite(Number(p.amount)) ? Number(p.amount) : null,
        currency: str(p.currency),
        pack: bundle ? { minutes: Number(p.meta?.minutes) || null, tokens: Math.round(Number(p.meta?.tokens)) || null } : null,
      },
      source: 'payment',
      reconstructed: true,
    }));
  }
  return out;
}

/** Lignes du journal des minutes. Entrées : portefeuille (ou null), paiements de la société, appels de la société. */
export function buildMinutesRows({ wallet, payments, calls, debits = {} }) {
  const rows = [];
  const credits = Array.isArray(wallet?.credits) ? wallet.credits : [];
  credits.forEach((c, i) => {
    const plan = c.kind === 'plan';
    rows.push(row({
      id: `credit:${c.grantKey || `n${i}`}`,
      type: 'minutes',
      date: isoOrNull(c.at),
      nature: plan ? 'octroi_forfait' : 'recharge',
      quantity: Number(c.minutes),
      quantityApproximate: !Number.isFinite(Number(c.minutes)),
      reference: plan ? { planName: str(c.planName), grantKey: str(c.grantKey) } : { grantKey: str(c.grantKey) },
      source: 'credits',
    }));
  });
  // Périodes de forfait créditées au solde mais sans ligne datée (fenêtre entre le crédit et l'écriture de la ligne) : quantité inconnue.
  const dated = new Set(credits.map((c) => String(c.grantKey || '')));
  for (const key of wallet?.planGrantKeys || []) {
    if (!key || dated.has(String(key))) continue;
    rows.push(row({
      id: `grantkey:${key}`, type: 'minutes', date: dateFromGrantKey(key), nature: 'octroi_forfait', quantity: null,
      reference: { planName: null, grantKey: String(key) }, source: 'plan_grant_key', reconstructed: true, quantityApproximate: true,
    }));
  }
  rows.push(...paymentRows('minutes', payments, credits));

  const charged = new Set((wallet?.chargedCallSids || []).map(String));
  const matched = new Set();
  for (const c of calls || []) {
    const key = String(c.sid || c._id || '');
    const secs = Number(c.duration);
    if (!key || !charged.has(key) || matched.has(key) || c.isTest === true || !(secs > 0)) continue;
    matched.add(key);
    const dir = String(c.direction || '').toLowerCase();
    const direction = /^inbound/.test(dir) ? 'inbound' : /^outbound/.test(dir) ? 'outbound' : null;
    const counterpart = direction === 'outbound' ? c.to : direction === 'inbound' ? c.from : null;
    const billedMinutes = Math.ceil(secs / 60);
    // Coefficient (crédits par minute) : seulement s'il est connu pour CET appel (entier >= 1) avec une zone connue ; sinon la
    // quantité historique (minutes arrondies) et coefficient null. `debits[sid]` = { coefficient, zone } : source branchée à la fusion du coefficient.
    const d = debits?.[key];
    const known = d && Number.isInteger(d.coefficient) && d.coefficient >= 1 && (d.zone === 'domestic' || d.zone === 'international');
    const coefficient = known ? d.coefficient : null;
    rows.push(row({
      id: `call:${key}`,
      type: 'minutes',
      date: isoOrNull(c.startTime) || isoOrNull(c.createdAt) || isoOrNull(c.endTime),
      nature: 'consommation',
      quantity: -(billedMinutes * (coefficient || 1)),
      coefficient,
      zone: known ? d.zone : null,
      reference: {
        callSid: key, direction, counterpart: maskCounterpart(counterpart), durationSeconds: secs, billedMinutes,
        // Jambe d'un appel transféré (champ additif) : libellé « Transfert vers <fiche> » et jambe (vers la fiche / reste du correspondant).
        ...(c.source === 'transfer' ? { label: str(c.handledBy?.name) || 'Transfert', transferLeg: str(c.transfer?.leg) } : {}),
      },
      source: 'calls',
      reconstructed: true,
    }));
  }
  return { rows, orphanDebitedCalls: Math.max(0, charged.size - matched.size) };
}

/** Lignes du journal des jetons. Entrées : portefeuille (ou null), paiements de la société, registre d'usage de la société. */
export function buildTokensRows({ wallet, payments, usage }) {
  const rows = [];
  const keys = (wallet?.planGrantKeys || []).filter(Boolean).map(String);
  const total = Number(wallet?.planTokensGranted);
  for (const key of keys) {
    // Seul le cumul est stocké : la quantité d'une période n'est connue que s'il n'y a eu qu'une seule période.
    const single = keys.length === 1 && total > 0;
    rows.push(row({
      id: `grantkey:${key}`, type: 'tokens', date: dateFromGrantKey(key), nature: 'octroi_forfait',
      quantity: single ? total : null, reference: { planName: null, grantKey: key }, source: 'plan_grant_key',
      reconstructed: true, quantityApproximate: !single,
    }));
  }
  rows.push(...paymentRows('tokens', payments, []));
  for (const u of usage || []) {
    const used = Number(u.tokensUsed);
    if (!u.usageId || !(used > 0)) continue;
    rows.push(row({
      id: `usage:${createHash('sha256').update(String(u.usageId)).digest('hex').slice(0, 24)}`,
      type: 'tokens',
      date: isoOrNull(u.createdAt),
      nature: 'consommation',
      quantity: -used,
      reference: {
        usageId: scrub(u.usageId),
        tool: clip(u.tool),
        gigId: u.gigId ? String(u.gigId) : null,
        provider: clip(u.provider, 60),
        model: clip(u.model, 100),
        estimated: Boolean(u.estimated),
        inputTokens: typeof u.inputTokens === 'number' ? u.inputTokens : null,
        outputTokens: typeof u.outputTokens === 'number' ? u.outputTokens : null,
      },
      source: 'tokens_ledger',
    }));
  }
  const attributed = rows.filter((r) => r.nature === 'octroi_forfait' && r.quantity != null).reduce((a, r) => a + r.quantity, 0);
  return { rows, unattributedPlanGrant: Number.isFinite(total) && total > 0 ? Math.max(0, total - attributed) : 0 };
}

/**
 * Trie (le plus récent d'abord) et pose le solde après opération en REMONTANT depuis le solde actuel : la ligne la plus récente
 * porte le solde actuel, chaque ligne précédente = solde de la suivante - quantité de la suivante. Une quantité inconnue
 * interrompt la chaîne (null avant elle) ; une ligne sans date n'a pas de solde. L'écart avec la somme du journal n'est pas
 * absorbé : il est restitué par `summarize` (`unexplained`).
 */
export function sortWithBalances(rows, currentBalance) {
  const dated = rows.filter((r) => r.date).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let next = Number.isFinite(Number(currentBalance)) ? Number(currentBalance) : null;
  for (let i = dated.length - 1; i >= 0; i--) {
    dated[i].balanceAfter = next == null ? null : round2(next);
    const q = dated[i].quantity;
    next = next == null || q == null ? null : next - q;
  }
  // Une ligne sans date a bougé le solde à un moment inconnu : aucun solde après opération n'est fiable, on ne les affiche pas.
  const undated = rows.filter((r) => !r.date).sort((a, b) => (a.id < b.id ? 1 : -1));
  if (undated.length) dated.forEach((r) => { r.balanceAfter = null; });
  return [...dated.reverse(), ...undated];
}

export function inPeriod(r, from, to) {
  if (!from && !to) return true;
  if (!r.date) return false;
  return (!from || r.date >= from) && (!to || r.date <= to);
}

export function summarize(all, { from, to, currentBalance, extra = {} }) {
  const sum = (nature) => round2(all.filter((r) => r.nature === nature && r.quantity != null && inPeriod(r, from, to)).reduce((a, r) => a + r.quantity, 0));
  const hasUnknown = all.some((r) => r.quantity == null);
  const balance = Number.isFinite(Number(currentBalance)) ? Number(currentBalance) : 0;
  return {
    granted: sum('octroi_forfait'),
    recharged: sum('recharge'),
    consumed: -sum('consommation') || 0,
    adjusted: sum('ajustement'),
    expired: -sum('expiration') || 0,
    currentBalance: round2(balance),
    // Solde actuel moins tout ce que le journal explique : solde d'ouverture ou mouvements sans trace. Null si une quantité est inconnue.
    unexplained: hasUnknown ? null : round2(balance - all.reduce((a, r) => a + r.quantity, 0)),
    ...extra,
    from: from || null,
    to: to || null,
  };
}

export function paginate(items, page, limit) {
  const total = items.length;
  return { total, totalPages: Math.ceil(total / limit), page, limit, items: items.slice((page - 1) * limit, page * limit) };
}

// ---------- Paramètres de requête ----------

export class QueryError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const oneString = (v) => (typeof v === 'string' ? v : v == null ? '' : null);

function parseBound(raw, edge) {
  const v = oneString(raw);
  if (v === null) throw new QueryError('invalid_date', 'Date invalide.');
  if (v === '') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const iso = `${v}T${edge === 'to' ? '23:59:59.999' : '00:00:00.000'}Z`;
    const t = new Date(iso);
    if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== v) throw new QueryError('invalid_date', 'Date invalide.');
    return t.toISOString();
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(v) || Number.isNaN(Date.parse(v))) throw new QueryError('invalid_date', 'Date invalide.');
  return new Date(v).toISOString();
}

/** Valide les paramètres ; lève QueryError(code) sinon. `paged: false` pour l'export (page et limite ignorées). */
export function parseQuery(query = {}, { paged = true } = {}) {
  const type = query.type;
  if (typeof type !== 'string' || !TYPES.includes(type)) throw new QueryError('invalid_type', 'type doit valoir minutes ou tokens.');
  const from = parseBound(query.from, 'from');
  const to = parseBound(query.to, 'to');
  if (from && to && from > to) throw new QueryError('invalid_range', 'from doit précéder to.');
  let natures = null;
  const rawNature = oneString(query.nature);
  if (rawNature === null) throw new QueryError('invalid_nature', 'Nature invalide.');
  if (rawNature !== '') {
    natures = [...new Set(rawNature.split(','))];
    if (natures.some((n) => !NATURES.includes(n))) throw new QueryError('invalid_nature', `nature doit être parmi : ${NATURES.join(', ')}.`);
  }
  let page = 1;
  let limit = DEFAULT_LIMIT;
  if (paged) {
    const p = oneString(query.page);
    const l = oneString(query.limit);
    if ((p !== '' && (p === null || !/^\d+$/.test(p) || Number(p) < 1)) || (l !== '' && (l === null || !/^\d+$/.test(l) || Number(l) < 1))) {
      throw new QueryError('invalid_pagination', 'page et limit doivent être des entiers supérieurs ou égaux à 1.');
    }
    if (p !== '') page = Number(p);
    if (l !== '') limit = Math.min(MAX_LIMIT, Number(l));
  }
  return { type, from, to, natures, page, limit };
}

// ---------- CSV ----------

export const CSV_COLUMNS = [
  'date', 'type', 'nature', 'quantity', 'balance_after', 'coefficient', 'zone', 'reconstructed',
  'call_sid', 'direction', 'counterpart', 'duration_seconds', 'usage_id', 'tool', 'provider', 'model', 'gig_id',
  'payment_id', 'payment_provider', 'payment_ref', 'pack', 'plan_name', 'grant_key',
];

/**
 * Cellule CSV sûre. Les nombres sortent tels quels (valeurs calculées ici). Tout texte dont le premier caractère significatif
 * peut être interprété comme une formule (= + - @, tabulation, retour chariot, après d'éventuels espaces) est préfixé par une apostrophe.
 */
export function csvCell(v) {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  let s = String(v);
  const lead = s.replace(/^[\u0000-\u0008\u000e-\u001f\u200b-\u200f\u2060\ufeff\u180e\s]+/, '');
  if (/^[=+\-@]/.test(lead) || /^[\t\r]/.test(s)) s = `'${s}`;
  return /[",;\r\n\t]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const packText = (p) => (p ? [p.minutes ? `${p.minutes} min` : null, p.tokens ? `${p.tokens} tokens` : null].filter(Boolean).join(' + ') : null);

export function toCsv(rows) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) {
    const f = r.reference || {};
    const cells = [
      r.date, r.type, r.nature, r.quantity, r.balanceAfter, r.coefficient, r.zone, r.reconstructed,
      f.callSid, f.direction, f.counterpart, f.durationSeconds, f.usageId, f.tool, r.source === 'tokens_ledger' ? f.provider : null, f.model, f.gigId,
      f.paymentId, r.source === 'payment' ? f.provider : null, f.providerRef, packText(f.pack), f.planName, f.grantKey,
    ];
    lines.push(cells.map(csvCell).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}
