import CallGraceDeadline from '../models/CallGraceDeadline.js';
import MinutesCompany from '../models/MinutesCompany.js';

/**
 * B.1 (décision du fondateur) : « Minutes : jamais de dépassement, 5 minutes de grâce puis coupure ».
 *
 * - Un appel ne démarre pas sans minutes (contrôles existants : jeton, vérification de destination, webhooks).
 * - Pendant l'appel, quand les minutes couvertes par le solde sont écoulées, l'appel continue au plus GRACE_SECONDS (5 min), puis il est
 *   coupé par le serveur (API Twilio, `calls(sid).update({ status: 'completed' })`) à l'échéance enregistrée en base.
 * - La grâce est GRATUITE : le débit d'un appel ne fait jamais passer le solde sous zéro (`clampDebit`) ; la part non couverte est
 *   consignée (`graceWaivedMinutes`), jamais facturée.
 *
 * L'échéance est calculée au début de l'appel avec le solde frais (comme l'ancien plafond `timeLimit`) : début + secondes couvertes + 5 min.
 * Les <Dial> gardent un `timeLimit` = couvertes + grâce : filet natif de Twilio si le serveur est arrêté à l'échéance.
 *
 * Appels simultanés : au démarrage, chaque appel RÉSERVE atomiquement sa part du solde (`MinutesCompany.reservedCredits`, au plus 4 h) ;
 * disponible = solde − réserve. La réserve est rendue une seule fois (`releaseReservation`) : au débit de l'appel, à son compte rendu de
 * fin (line-call-end, call-status, inbound-dial-result, voicemail-done), ou par le balayeur 2 min après la coupure.
 */
export const GRACE_SECONDS = 5 * 60;
/** Plafond de Twilio pour timeLimit (4 h) : même valeur que MAX_CALL_SECONDS de browserOutbound.js. */
export const GRACE_MAX_CALL_SECONDS = 14400;
/** Avertissement « plus qu'une minute ». */
export const LAST_MINUTE_SECONDS = 60;
export const SWEEP_INTERVAL_MS = 10_000;
/** Une prise (`hanging`) plus vieille que ce délai est reprise : l'instance qui l'avait prise s'est arrêtée en cours de route. */
export const STALE_CLAIM_MS = 60_000;
export const MAX_HANGUP_ATTEMPTS = 5;
const RETENTION_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Durée maximale d'un <Dial> : secondes couvertes + grâce, 4 h au plus. 0 couvert (solde déjà réservé par les appels en cours) : l'appel
 * démarre directement en grâce (5 min). Le refus d'un appel sans minutes se décide en amont (solde à zéro).
 */
export function graceLimitSeconds(coveredSeconds) {
  const covered = Math.max(0, Math.floor(Number(coveredSeconds) || 0));
  return Math.min(covered + GRACE_SECONDS, GRACE_MAX_CALL_SECONDS);
}

const withTimeout = (promise, ms, fallback) => {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([Promise.resolve(promise).catch(() => fallback), late]).finally(() => clearTimeout(timer));
};

/** Valeur ou `fallback` au-delà de `ms` (lecture de base qui pend pendant un webhook). */
export const raceTimeout = withTimeout;

/** Base connectée ? Remplaçable dans les tests (`setGraceDbReady`). Sans base : ni réservation ni libération (jamais d'attente). */
let dbReadyImpl = null;
const dbReady = () => (dbReadyImpl ? dbReadyImpl() : CallGraceDeadline.db?.readyState === 1);
export function setGraceDbReady(fn) { dbReadyImpl = fn; }

/** Filtre « reservedCredits vaut r » (champ absent = 0). */
const reservedIs = (r) => (r > 0 ? r : { $in: [0, null] });

/** Tranche réservée à la fois (au démarrage, puis à chaque prolongation par le balayeur). */
export const TRANCHE_SECONDS = 10 * 60;
/** Le balayeur prolonge un appel environ 60 s avant la fin de sa tranche. */
export const EXTEND_LEAD_MS = 60_000;
/** Délai après la coupure au-delà duquel le balayeur débite puis rend une réservation encore tenue (compte rendu perdu, redémarrage). */
export const ORPHAN_RELEASE_MS = 2 * 60_000;
/** Une échéance `pending` plus jeune que ce délai : un démarrage est en cours, le recalcul de la réserve attend. */
const PENDING_GRACE_MS = 30_000;
const FINISHED = new Set(['completed', 'canceled', 'failed', 'busy', 'no-answer']);

/**
 * RÉSERVATION ATOMIQUE d'une tranche du solde : `min(solde − reservedCredits, need)` arrondi aux crédits par minute, par un findOneAndUpdate
 * conditionnel (solde et réserve lus font partie du filtre : deux démarrages simultanés ne réservent jamais la même part).
 * @returns {Promise<{ amount: number, available: number }>} crédits réservés et crédits libres AVANT la réservation
 */
export async function reserveCredits({ companyId, need, creditFactor = 1, Wallet = MinutesCompany, attempts = 8 }) {
  const factor = Number(creditFactor) > 1 ? Number(creditFactor) : 1;
  const wanted = Math.max(0, Math.floor(Number(need) || 0));
  let available = 0;
  if (!companyId) return { amount: 0, available };
  for (let i = 0; i < attempts; i += 1) {
    const wallet = await Wallet.findOne({ companyId });
    if (!wallet) return { amount: 0, available: 0 };
    const reserved = Math.max(0, Number(wallet.reservedCredits) || 0);
    available = Math.max(0, Math.floor(Number(wallet.minutes) || 0) - reserved);
    const amount = Math.floor(Math.min(available, wanted) / factor) * factor;
    if (amount <= 0) return { amount: 0, available };
    const updated = await Wallet.findOneAndUpdate(
      { companyId, minutes: wallet.minutes, reservedCredits: reservedIs(Number(wallet.reservedCredits) || 0) },
      { $inc: { reservedCredits: amount } },
      { new: true }
    );
    if (updated) return { amount, available };
  }
  return { amount: 0, available }; // contention persistante : prudence (jamais de réserve inventée)
}

/** Rend `amount` crédits : `$inc` négatif si la réserve les contient, sinon remise à 0 (jamais négative ; le recalcul corrige le reste). */
export async function unreserveCredits({ companyId, amount, Wallet = MinutesCompany }) {
  const a = Math.max(0, Number(amount) || 0);
  if (!companyId || !a) return 0;
  const done = await Wallet.findOneAndUpdate({ companyId, reservedCredits: { $gte: a } }, { $inc: { reservedCredits: -a } }, { new: true });
  if (!done) await Wallet.updateOne({ companyId, reservedCredits: { $lt: a } }, { $set: { reservedCredits: 0 } });
  return a;
}

/** Rend la réservation d'un appel une seule fois (`held` → `released` posé atomiquement). @returns {Promise<number>} crédits rendus */
export async function releaseReservation(callSid, { Model = CallGraceDeadline, Wallet = MinutesCompany, now = Date.now() } = {}) {
  const sid = String(callSid || '').trim();
  if (!sid) return 0;
  const row = await Model.findOneAndUpdate(
    { $or: [{ callSid: sid }, { childSids: sid }], reservationStatus: 'held' },
    { $set: { reservationStatus: 'released', releasedAt: new Date(now) } },
    { new: true }
  );
  if (!row) return 0;
  return unreserveCredits({ companyId: row.companyId, amount: row.reservedCredits, Wallet });
}

/**
 * Débit d'un appel terminé avec sa durée réelle (minute entamée × crédits par minute, borné par le solde), idempotent par CallSid : ses
 * clés (l'appel, ses jambes connues) sont inscrites dans chargedCallSids, une synchronisation ultérieure ne le débite pas une seconde fois.
 * @returns {Promise<boolean>} débité maintenant ou déjà débité ; false : à reprendre (débits concurrents)
 */
export async function chargeGraceCall(row, durationSeconds, extraKeys = [], { Wallet = MinutesCompany } = {}) {
  const seconds = Math.max(0, Math.round(Number(durationSeconds) || 0));
  const factor = Number(row.creditFactor) > 1 ? Number(row.creditFactor) : 1;
  const keys = [...new Set([row.callSid, ...(row.childSids || []), ...extraKeys].map((k) => String(k || '').trim()).filter(Boolean))];
  const done = await debitMinutesClamped({ companyId: row.companyId, keys, cost: Math.ceil(seconds / 60) * factor, seconds, batch: keys.length > 1, Wallet });
  return !done?.retryLater;
}

/**
 * Compte rendu de fin d'appel (call-status, line-call-end, inbound-dial-result, voicemail-done ; filet du balayeur) : plus rien à couper,
 * DÉBIT de l'appel avec sa durée, PUIS réserve rendue. Durée inconnue : la réserve est gardée jusqu'au débit. Ne lève jamais.
 */
export async function endGraceCall(callSid, { durationSeconds, keys = [], ...deps } = {}) {
  if (!deps.Model && !dbReady()) return 0;
  const Model = deps.Model || CallGraceDeadline;
  try {
    const sid = String(callSid || '').trim();
    await markGraceEnded(sid, { Model });
    const row = await Model.findOne({ $or: [{ callSid: sid }, { childSids: sid }] }).lean();
    if (!row) return 0;
    const duration = Number(durationSeconds);
    if (durationSeconds === undefined || durationSeconds === null || !Number.isFinite(duration)) return 0;
    if (!(await chargeGraceCall(row, duration, keys, deps))) return 0;
    return await releaseReservation(row.callSid, { ...deps, Model });
  } catch (error) {
    console.warn('[minutes-grace] fin d\'appel non traitée :', error?.message || error);
    return 0;
  }
}

/** Appel repris par l'agent IA (qui ne consomme pas le solde) : plus rien à couper, réserve rendue SANS débit. */
export async function cancelGraceCall(callSid, deps = {}) {
  if (!deps.Model && !dbReady()) return 0;
  try {
    await markGraceEnded(callSid, deps);
    return await releaseReservation(callSid, deps);
  } catch (error) {
    console.warn('[minutes-grace] annulation non traitée :', error?.message || error);
    return 0;
  }
}

/** Débit d'appels (clés `calls`, lecture du solde ou charge-call) : leurs réservations sont rendues APRÈS ce débit. Ne lève jamais. */
export async function releaseForChargedKeys(keys, deps = {}) {
  if (!deps.Model && !dbReady()) return 0;
  let total = 0;
  for (const k of [...new Set((keys || []).map(String).filter(Boolean))]) {
    try { total += await releaseReservation(k, deps); } catch (error) { console.warn('[minutes-grace] réservation non rendue :', error?.message || error); }
  }
  return total;
}

const planOfRow = (row) => {
  const factor = Number(row.creditFactor) > 1 ? Number(row.creditFactor) : 1;
  return { coveredSeconds: row.coveredSeconds || 0, reservedCredits: row.reservedCredits || 0, availableSeconds: row.coveredSeconds || 0, graceStartsAt: new Date(row.graceStartsAt), deadline: new Date(row.deadline), limitSeconds: graceLimitSeconds(row.coveredSeconds || 0), factor };
};

/**
 * Début d'un appel qui consomme des minutes. 1) échéance écrite (`pending`) ; 2) réservation atomique d'une TRANCHE (10 min au plus) ;
 * 3) échéance passée en `held` avec sa réservation (couvertes = tranche ; grâce à la fin de la tranche, prolongée par le balayeur tant
 * que du solde est libre). Rien de libre : grâce dès le début. Idempotent par CallSid. `signal.aborted` (délai dépassé côté webhook) :
 * rien n'est réservé, l'échéance est abandonnée.
 * @returns {Promise<null | { coveredSeconds, reservedCredits, availableSeconds, graceStartsAt, deadline, limitSeconds }>}
 *   `availableSeconds` : solde libre (non réservé) au démarrage, base du timeLimit large du <Dial>.
 */
export async function startGraceCall({ callSid, companyId, path, creditFactor = 1, now = Date.now(), signal = null }, { Model = CallGraceDeadline, Wallet = MinutesCompany } = {}) {
  const sid = String(callSid || '').trim();
  if (!sid || !companyId) return null;
  const factor = Number(creditFactor) > 1 ? Number(creditFactor) : 1;
  const existing = await Model.findOne({ callSid: sid }).lean();
  if (existing) return planOfRow(existing);
  const provisional = planGrace({ coveredSeconds: 0, now });
  let inserted = false;
  try {
    const r = await Model.updateOne(
      { callSid: sid },
      { $setOnInsert: {
        callSid: sid, companyId, path, startedAt: new Date(now), coveredSeconds: 0, creditFactor: factor,
        graceStartsAt: provisional.graceStartsAt, deadline: provisional.deadline, status: 'scheduled', attempts: 0,
        reservedCredits: 0, reservationStatus: 'pending', extensible: false,
        expiresAt: new Date(provisional.deadline.getTime() + RETENTION_MS),
      } },
      { upsert: true }
    );
    inserted = Boolean(r?.upsertedCount);
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
  if (!inserted) {
    const row = await Model.findOne({ callSid: sid }).lean();
    return row ? planOfRow(row) : null;
  }
  const abandon = () => Model.updateOne({ callSid: sid }, { $set: { status: 'ended', reservationStatus: 'none' } });
  if (signal?.aborted) { await abandon(); return null; }
  const { amount, available } = await reserveCredits({ companyId, need: (TRANCHE_SECONDS / 60) * factor, creditFactor: factor, Wallet });
  if (signal?.aborted) { await unreserveCredits({ companyId, amount, Wallet }); await abandon(); return null; }
  const coveredSeconds = Math.floor(amount / factor) * 60;
  const plan = planGrace({ coveredSeconds, now });
  await Model.updateOne({ callSid: sid, reservationStatus: 'pending' }, { $set: {
    reservationStatus: amount > 0 ? 'held' : 'none', reservedCredits: amount, coveredSeconds, extensible: true,
    graceStartsAt: plan.graceStartsAt, deadline: plan.deadline, expiresAt: new Date(plan.deadline.getTime() + RETENTION_MS),
  } });
  const availableSeconds = Math.floor(available / factor) * 60;
  return { ...plan, reservedCredits: amount, availableSeconds, limitSeconds: graceLimitSeconds(availableSeconds) };
}

/** Secondes restantes jusqu'à la coupure d'un appel (timeLimit des <Dial> suivants : file, menu, mobile) ; 0 si aucune échéance. */
export async function remainingLimitFor(callSid, { Model = CallGraceDeadline, now = Date.now() } = {}) {
  const sid = String(callSid || '').trim();
  if (!sid) return 0;
  const row = await Model.findOne({ callSid: sid, status: 'scheduled' }).lean();
  if (!row) return 0;
  return Math.min(GRACE_MAX_CALL_SECONDS, Math.max(1, Math.ceil((new Date(row.deadline).getTime() - now) / 1000)));
}

/** Ajoute `timeLimit="N"` à chaque <Dial> qui n'en a pas (TwiML des files d'attente, du menu, du mobile). N ≤ 0 : inchangé. */
export function withDialTimeLimit(xml, seconds) {
  const n = Math.floor(Number(seconds) || 0);
  if (!xml || n <= 0) return xml;
  return String(xml).replace(/<Dial\b([^>]*)>/g, (m, attrs) => (/\btimeLimit=/.test(attrs) ? m : `<Dial${attrs} timeLimit="${Math.min(n, GRACE_MAX_CALL_SECONDS)}">`));
}

/**
 * Toutes les échéances qui répondent à `filter`, par lots de `limit` (tri `sort`), jusqu'au bout : un lot déjà traité est exclu du suivant
 * (`_id` hors de ceux vus), donc ni des échéances en échec répété ni des appels en grâce n'empêchent jamais les autres d'être traités.
 * Garde-fou : `maxBatches` lots par passage.
 */
async function eachBatch(Model, filter, sort, limit, fn, maxBatches = 40, { clock = Date.now, prepare = null } = {}) {
  const seen = [];
  for (let b = 0; b < maxBatches; b += 1) {
    // Heure relue à chaque lot (un passage long ne travaille pas sur une heure périmée) ; `filter` peut en dépendre.
    const nowB = clock();
    const f = typeof filter === 'function' ? filter(nowB) : filter;
    const rows = await Model.find(seen.length ? { ...f, _id: { $nin: seen } } : f).sort(sort).limit(limit).lean();
    if (!rows?.length) return;
    const ctx = prepare ? await prepare(rows) : null;
    for (const row of rows) { seen.push(row._id); await fn(row, nowB, ctx); }
    if (rows.length < limit) return;
  }
}

/** `fn` sur `items` par petits lots concurrents de `size` (lectures Twilio du groupe « fin de tranche »). */
async function inChunks(items, size, fn) {
  const out = new Map();
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size);
    const res = await Promise.all(chunk.map((x) => fn(x)));
    chunk.forEach((x, k) => out.set(x, res[k]));
  }
  return out;
}
export const TWILIO_READ_CONCURRENCY = 5;

/** État et durée d'un appel chez Twilio (client existant), borné à 3 s ; null si illisible. */
async function twilioCallOf(client, callSid) {
  if (!client) return null;
  return withTimeout(Promise.resolve().then(() => client.calls(callSid).fetch()), 3000, null);
}

/**
 * Prolongation, à chaque passage du balayeur, de tout appel EN COURS (`scheduled`) dont la tranche finit dans ~60 s ou qui est déjà en
 * grâce : une tranche de plus est réservée si du solde est libre (même momentanément manquant auparavant), la grâce et la coupure sont
 * repoussées et l'appel SORT de la grâce. La grâce déjà passée est décomptée (`graceUsedSeconds`) : 5 min gratuites au plus par appel,
 * en une ou plusieurs fois. Rien de libre : rien ne change, nouvel essai au passage suivant. Un appel déjà terminé chez Twilio (compte
 * rendu perdu, vu avant sa grâce) est débité de sa durée puis sa réserve est rendue.
 */
export async function extendGraceCalls({ Model = CallGraceDeadline, Wallet = MinutesCompany, client = null, now = undefined, clock = undefined, limit = 50, log = console } = {}) {
  const out = { extended: 0, exhausted: 0, finished: 0, errors: 0 };
  const tick = clock || (now !== undefined ? () => now : Date.now);
  const base = (t) => ({ status: 'scheduled', reservationStatus: { $in: ['held', 'none'] }, extensible: true, deadline: { $gt: new Date(t) } });
  // D'abord les appels PAYÉS en fin de tranche (pas encore en grâce), puis ceux déjà en grâce ; chaque groupe jusqu'au bout (par lots).
  const groups = [
    { filter: (t) => ({ ...base(t), graceStartsAt: { $gt: new Date(t), $lte: new Date(t + EXTEND_LEAD_MS) } }), twilio: true },
    { filter: (t) => ({ ...base(t), graceStartsAt: { $lte: new Date(t) } }), twilio: false },
  ];
  const handle = async (row, t, calls) => {
    try {
      const graceStart = new Date(row.graceStartsAt).getTime();
      // Avant la grâce seulement (une fois par tranche) : un appel fini chez Twilio dont le compte rendu s'est perdu est clôturé ici.
      const call = calls ? calls.get(row) : null;
      if (call && FINISHED.has(String(call.status || ''))) {
        await endGraceCall(row.callSid, { durationSeconds: Number(call.duration) || 0, Model, Wallet });
        out.finished += 1;
        return;
      }
      const factor = Number(row.creditFactor) > 1 ? Number(row.creditFactor) : 1;
      const { amount } = await reserveCredits({ companyId: row.companyId, need: (TRANCHE_SECONDS / 60) * factor, creditFactor: factor, Wallet });
      if (amount <= 0) { out.exhausted += 1; return; }
      const add = Math.floor(amount / factor) * 60 * 1000;
      const used = Math.min(GRACE_SECONDS, (Number(row.graceUsedSeconds) || 0) + Math.max(0, Math.round((t - graceStart) / 1000)));
      const graceStartsAt = new Date(Math.max(graceStart, t) + add);
      const deadline = new Date(graceStartsAt.getTime() + Math.max(0, GRACE_SECONDS - used) * 1000);
      const done = await Model.findOneAndUpdate(
        { _id: row._id, status: 'scheduled', graceStartsAt: new Date(row.graceStartsAt) },
        { $inc: { reservedCredits: amount, coveredSeconds: add / 1000 }, $set: { reservationStatus: 'held', graceUsedSeconds: used, graceStartsAt, deadline, expiresAt: new Date(deadline.getTime() + RETENTION_MS) } },
        { new: true }
      );
      if (done) out.extended += 1; else await unreserveCredits({ companyId: row.companyId, amount, Wallet });
    } catch (error) {
      // Un appel en erreur (lecture, écriture) ne bloque jamais les suivants : nouvel essai au passage suivant.
      out.errors += 1;
      log.warn?.(`[minutes-grace] prolongation de ${String(row.callSid).slice(0, 10)}… en échec :`, error?.message || error);
    }
  };
  for (const g of groups) {
    await eachBatch(Model, g.filter, { graceStartsAt: 1 }, limit, handle, 40, {
      clock: tick,
      // Lectures Twilio du lot faites à l'avance, 5 à la fois (au lieu d'une à une), chacune bornée à 3 s.
      prepare: g.twilio && client ? (rows) => inChunks(rows, TWILIO_READ_CONCURRENCY, (row) => twilioCallOf(client, row.callSid).catch(() => null)) : null,
    });
  }
  return out;
}

/**
 * Réserve auto-réparatrice (crash entre deux écritures, course). Ordre : portefeuilles d'abord, échéances ensuite (une réservation qui se
 * termine entre les deux lectures n'apparaît jamais deux fois). Réserve PLUS GRANDE que la somme des échéances `held` : baissée tout de
 * suite (compare-and-set sur la valeur lue). Plus PETITE : remontée seulement si l'écart persiste deux passages de suite (jamais sur une
 * lecture prise au milieu d'une réservation). Démarrage `pending` récent : l'entreprise attend.
 */
const lowStreak = new Map();
export async function reconcileReserves({ Model = CallGraceDeadline, Wallet = MinutesCompany, now = Date.now(), limit = 200 } = {}) {
  let fixed = 0;
  const wallets = await Wallet.find({ reservedCredits: { $gt: 0 } }).select('companyId reservedCredits').limit(limit).lean();
  const held = await Model.find({ reservationStatus: { $in: ['held', 'pending'] } }).limit(5000).lean();
  const byCompany = new Map();
  for (const r of held || []) {
    const k = String(r.companyId);
    const e = byCompany.get(k) || { sum: 0, pending: false };
    if (r.reservationStatus === 'held') e.sum += Number(r.reservedCredits) || 0;
    if (r.reservationStatus === 'pending' && now - new Date(r.startedAt).getTime() < PENDING_GRACE_MS) e.pending = true;
    byCompany.set(k, e);
  }
  const ids = new Set([...(wallets || []).map((w) => String(w.companyId)), ...byCompany.keys()]);
  for (const companyId of ids) {
    const e = byCompany.get(companyId) || { sum: 0, pending: false };
    if (e.pending) continue;
    const w = (wallets || []).find((x) => String(x.companyId) === companyId) || await Wallet.findOne({ companyId });
    if (!w) continue;
    const cur = Math.max(0, Number(w.reservedCredits) || 0);
    if (cur === e.sum) { lowStreak.delete(companyId); continue; }
    if (cur < e.sum) {
      // Réserve trop basse : seulement si le même écart a été vu au passage précédent.
      const seen = lowStreak.get(companyId);
      lowStreak.set(companyId, e.sum);
      if (seen !== e.sum) continue;
    }
    const done = await Wallet.findOneAndUpdate({ companyId: w.companyId, reservedCredits: reservedIs(Number(w.reservedCredits) || 0) }, { $set: { reservedCredits: e.sum } }, { new: true });
    if (done) { fixed += 1; lowStreak.delete(companyId); console.warn(`[minutes-grace] réserve recalculée pour l'entreprise ${companyId} : ${cur} → ${e.sum}`); }
  }
  return fixed;
}

/**
 * Échéances d'un appel qui démarre à `now` avec `coveredSeconds` couvertes par le solde : début de la grâce et coupure (début + couvertes + 5 min).
 * @returns {{ coveredSeconds: number, graceStartsAt: Date, deadline: Date, limitSeconds: number }}
 */
export function planGrace({ coveredSeconds, now = Date.now() }) {
  const covered = Math.max(0, Math.floor(Number(coveredSeconds) || 0));
  const limitSeconds = Math.min(covered + GRACE_SECONDS, GRACE_MAX_CALL_SECONDS);
  const start = new Date(now).getTime();
  // La coupure par le serveur n'a pas le plafond de 4 h de Twilio (`limitSeconds` ne vaut que pour le timeLimit d'un <Dial>).
  return {
    coveredSeconds: covered,
    graceStartsAt: new Date(start + covered * 1000),
    deadline: new Date(start + (covered + GRACE_SECONDS) * 1000),
    limitSeconds,
  };
}

/**
 * Débit d'un appel borné par le solde : le solde ne passe jamais sous zéro. `waived` = crédits non facturés (grâce, ou appels simultanés).
 * Un solde déjà négatif (historique, avant B.1) n'est pas creusé davantage.
 */
export function clampDebit(cost, balance) {
  const c = Math.max(0, Number(cost) || 0);
  const available = Math.max(0, Number(balance) || 0);
  const debit = Math.min(c, available);
  return { debit, waived: c - debit };
}

/**
 * Débit atomique d'un ou plusieurs appels (clés `keys`, idempotence `chargedCallSids` inchangée), borné par le solde (`clampDebit`) :
 * le solde ne passe jamais sous zéro, la part non couverte est consignée dans `graceWaivedMinutes` (jamais facturée).
 * Concurrence : le solde lu fait partie du filtre ; s'il a changé entre la lecture et l'écriture, on relit (3 essais).
 * @returns {Promise<null | { wallet: object, debit: number, waived: number } | { wallet: null, retryLater: true }>} null : déjà débité ;
 *   `retryLater` : le solde a changé à chaque essai (débits concurrents) — rien n'est débité, l'appel sera repris à la prochaine lecture du solde.
 */
export async function debitMinutesClamped({ companyId, keys, cost, seconds, batch = false, Wallet = MinutesCompany, attempts = 3 }) {
  const list = [...new Set((keys || []).map(String).filter(Boolean))];
  if (!companyId || !list.length) return null;
  // Un appel : `$ne` ; un lot (lecture du solde) : `$nin` / `$each`, comme avant.
  const single = list.length === 1 && !batch;
  const keyFilter = single ? { $ne: list[0] } : { $nin: list };
  for (let i = 0; i < attempts; i += 1) {
    let wallet = await Wallet.findOne({ companyId });
    if (!wallet) wallet = await Wallet.create({ companyId, minutes: 0 });
    const charged = new Set((wallet.chargedCallSids || []).map(String));
    if (list.some((k) => charged.has(k))) return null;
    const balance = Number(wallet.minutes) || 0;
    const { debit, waived } = clampDebit(cost, balance);
    const updated = await Wallet.findOneAndUpdate(
      { companyId, chargedCallSids: keyFilter, minutes: wallet.minutes },
      {
        $inc: { minutes: -debit, consumedSeconds: Number(seconds) || 0, ...(waived > 0 ? { graceWaivedMinutes: waived } : {}) },
        $addToSet: { chargedCallSids: single ? list[0] : { $each: list } },
      },
      { new: true }
    );
    if (updated) {
      if (waived > 0) console.log(`[minutes-grace] ${waived} crédit(s) non facturé(s) (solde à zéro) pour l'entreprise ${companyId}`);
      return { wallet: updated, debit, waived };
    }
  }
  return { wallet: null, retryLater: true };
}

/** Clé de l'idempotence : un appel n'a qu'une échéance (la première écrite gagne : un webhook rejoué ne la repousse pas). */
export async function scheduleGraceDeadline({ callSid, companyId, path, coveredSeconds, creditFactor = 1, now = Date.now() }, { Model = CallGraceDeadline } = {}) {
  const sid = String(callSid || '').trim();
  if (!sid || !companyId) return null;
  const plan = planGrace({ coveredSeconds, now });
  try {
    await Model.updateOne(
      { callSid: sid },
      { $setOnInsert: {
        callSid: sid, companyId, path, startedAt: new Date(now), coveredSeconds: plan.coveredSeconds, creditFactor,
        graceStartsAt: plan.graceStartsAt, deadline: plan.deadline, status: 'scheduled', attempts: 0,
        expiresAt: new Date(plan.deadline.getTime() + RETENTION_MS),
      } },
      { upsert: true }
    );
  } catch (error) {
    // Course entre deux écritures du même sid (index unique) : la première a gagné, rien à faire.
    if (error?.code !== 11000) throw error;
  }
  return plan;
}

/** Fin normale de l'appel : plus rien à couper (idempotent). */
export async function markGraceEnded(callSid, { Model = CallGraceDeadline } = {}) {
  const sid = String(callSid || '').trim();
  if (!sid) return false;
  const r = await Model.updateOne({ callSid: sid, status: 'scheduled' }, { $set: { status: 'ended' } });
  return Boolean(r?.modifiedCount);
}

/** L'appel n'est plus en cours chez Twilio (déjà terminé, inconnu) : rien à couper, ce n'est pas une panne. */
const callAlreadyOver = (error) => error?.code === 21220 || error?.status === 404 || error?.code === 20404;

/**
 * Un passage du balayeur : coupe les appels dont l'échéance est dépassée. Rejouable sans risque (redémarrage, plusieurs instances) :
 * chaque échéance est prise atomiquement avant l'appel à Twilio, et une échéance coupée ne l'est jamais deux fois.
 * @returns {Promise<{ hungUp: number, ended: number, failed: number, retried: number, released: number }>}
 */
export async function sweepGraceDeadlines({ Model = CallGraceDeadline, Wallet = MinutesCompany, client, now = undefined, limit = 50, log = console } = {}) {
  const result = { hungUp: 0, ended: 0, failed: 0, retried: 0, released: 0, reconciled: 0, extended: 0, exhausted: 0, finished: 0, errors: 0 };
  const clock = now !== undefined ? () => now : Date.now;
  // 1) COUPURES d'abord : une échéance due n'attend jamais les prolongations ni les lectures Twilio lentes. Heure relue à chaque lot.
  if (client) {
    await eachBatch(Model, (t) => ({
      deadline: { $lte: new Date(t) },
      $or: [{ status: 'scheduled' }, { status: 'hanging', claimedAt: { $lte: new Date(t - STALE_CLAIM_MS) } }],
    }), { deadline: 1 }, limit, async (row, t) => {
      const at = new Date(t);
      // Prise conditionnée à l'échéance LUE : une prolongation concurrente (autre instance) qui l'a repoussée gagne, l'appel n'est pas coupé.
      const claimed = await Model.findOneAndUpdate(
        { _id: row._id, status: row.status, deadline: new Date(row.deadline), ...(row.status === 'hanging' ? { claimedAt: row.claimedAt } : {}) },
        { $set: { status: 'hanging', claimedAt: at }, $inc: { attempts: 1 } },
        { new: true }
      );
      if (!claimed) return; // prise par une autre instance, ou échéance repoussée entre-temps
      try {
        await client.calls(claimed.callSid).update({ status: 'completed' });
        await Model.updateOne({ _id: claimed._id }, { $set: { status: 'hung_up', hungUpAt: at, lastError: '' } });
        result.hungUp += 1;
        log.log?.(`[minutes-grace] appel ${String(claimed.callSid).slice(0, 10)}… coupé après la grâce (entreprise ${claimed.companyId})`);
      } catch (error) {
        if (callAlreadyOver(error)) {
          await Model.updateOne({ _id: claimed._id }, { $set: { status: 'ended', lastError: '' } });
          result.ended += 1;
          return;
        }
        const giveUp = (claimed.attempts || 1) >= MAX_HANGUP_ATTEMPTS;
        await Model.updateOne({ _id: claimed._id }, { $set: { status: giveUp ? 'failed' : 'scheduled', claimedAt: null, lastError: String(error?.message || error).slice(0, 300) } });
        if (giveUp) result.failed += 1; else result.retried += 1;
        log.warn?.(`[minutes-grace] coupure en échec (${claimed.attempts} essai(s)) :`, error?.message || error);
      }
    }, 40, { clock });
  }
  // 2) Réserve auto-réparatrice, prolongations (tranche suivante si du solde est libre), filet des réservations orphelines.
  try { result.reconciled = await reconcileReserves({ Model, Wallet, now: clock() }); } catch (error) { log.warn?.('[minutes-grace] recalcul de la réserve en échec :', error?.message || error); }
  try { Object.assign(result, await extendGraceCalls({ Model, Wallet, client, clock, limit, log })); } catch (error) { log.warn?.('[minutes-grace] prolongation en échec :', error?.message || error); }
  // Filet : réservation encore tenue plus de 2 min après la coupure (compte rendu de fin perdu, serveur redémarré) : DÉBIT d'abord
  // (durée lue chez Twilio, sinon le temps couvert réservé), puis réserve rendue.
  await eachBatch(Model, (t) => ({ reservationStatus: 'held', deadline: { $lte: new Date(t - ORPHAN_RELEASE_MS) } }), { deadline: 1 }, limit, async (row) => {
    try {
      const call = await twilioCallOf(client, row.callSid);
      const known = call && FINISHED.has(String(call.status || '')) && Number.isFinite(Number(call.duration));
      if (await endGraceCall(row.callSid, { durationSeconds: known ? Number(call.duration) : row.coveredSeconds || 0, Model, Wallet })) result.released += 1;
    } catch (error) { log.warn?.('[minutes-grace] réservation orpheline non rendue :', error?.message || error); }
  }, 40, { clock });
  return result;
}

/** Vue pour le portail : instants de la grâce et de la coupure (le portail avertit au début de la grâce puis à 1 minute de la fin). */
export function graceView(row, now = Date.now()) {
  if (!row) return null;
  const graceStartsAt = new Date(row.graceStartsAt).getTime();
  const deadline = new Date(row.deadline).getTime();
  const active = row.status === 'scheduled' || row.status === 'hanging';
  return {
    callSid: row.callSid,
    graceSeconds: GRACE_SECONDS,
    graceStartsAt: new Date(graceStartsAt).toISOString(),
    deadline: new Date(deadline).toISOString(),
    inGrace: active && now >= graceStartsAt && now < deadline,
    secondsLeft: Math.max(0, Math.round((deadline - now) / 1000)),
    status: row.status,
  };
}

/**
 * Échéance d'un appel vu par le portail : par son sid, sinon (appel entrant décroché dans le navigateur, le portail ne connaît que sa
 * jambe) par l'appel parent lu chez Twilio. Toujours restreint à l'entreprise demandée.
 */
export async function findGraceForCall({ companyId, callSid, client, Model = CallGraceDeadline }) {
  const sid = String(callSid || '').trim();
  if (!sid || !companyId) return null;
  const direct = await Model.findOne({ companyId, $or: [{ callSid: sid }, { childSids: sid }] }).lean();
  if (direct) return direct;
  if (!client) return null;
  let parent = '';
  try { parent = String((await client.calls(sid).fetch())?.parentCallSid || ''); } catch { parent = ''; }
  if (!parent) return null;
  const row = await Model.findOne({ companyId, callSid: parent }).lean();
  if (row) await Model.updateOne({ _id: row._id }, { $addToSet: { childSids: sid } }).catch(() => {});
  return row;
}

let sweeping = false;
/** Démarre le balayeur (toutes les 10 s). `getClient` : client Twilio existant (jamais un nouveau). */
export function startGraceSweeper({ getClient, run = sweepGraceDeadlines, every = SWEEP_INTERVAL_MS, isReady = () => true } = {}) {
  const tick = async () => {
    if (sweeping || !isReady()) return;
    sweeping = true;
    try {
      const client = await getClient();
      const r = await run({ client });
      if (r.failed) console.warn(`[minutes-grace] ${r.failed} coupure(s) abandonnée(s) après ${MAX_HANGUP_ATTEMPTS} essais`);
    } catch (error) {
      console.error('[minutes-grace] passage en échec :', error?.message || error);
    } finally {
      sweeping = false;
    }
  };
  const timer = setInterval(tick, every);
  timer.unref?.();
  return timer;
}
