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

/** Durée maximale d'un <Dial> : secondes couvertes + grâce, 4 h au plus. 0 couvert (appel refusé en amont) : 0. */
export function graceLimitSeconds(coveredSeconds) {
  const covered = Math.max(0, Math.floor(Number(coveredSeconds) || 0));
  if (!covered) return 0;
  return Math.min(covered + GRACE_SECONDS, GRACE_MAX_CALL_SECONDS);
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
 * @returns {Promise<null | { wallet: object, debit: number, waived: number }>} null : déjà débité (ou débit concurrent, repris plus tard)
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
  return null;
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
 * @returns {Promise<{ hungUp: number, ended: number, failed: number, retried: number }>}
 */
export async function sweepGraceDeadlines({ Model = CallGraceDeadline, client, now = Date.now(), limit = 50, log = console } = {}) {
  const result = { hungUp: 0, ended: 0, failed: 0, retried: 0 };
  if (!client) return result;
  const at = new Date(now);
  const staleBefore = new Date(now - STALE_CLAIM_MS);
  const due = await Model.find({
    deadline: { $lte: at },
    $or: [{ status: 'scheduled' }, { status: 'hanging', claimedAt: { $lte: staleBefore } }],
  }).sort({ deadline: 1 }).limit(limit).lean();
  for (const row of due) {
    const claimed = await Model.findOneAndUpdate(
      { _id: row._id, status: row.status, ...(row.status === 'hanging' ? { claimedAt: row.claimedAt } : {}) },
      { $set: { status: 'hanging', claimedAt: at }, $inc: { attempts: 1 } },
      { new: true }
    );
    if (!claimed) continue; // prise par une autre instance
    try {
      await client.calls(claimed.callSid).update({ status: 'completed' });
      await Model.updateOne({ _id: claimed._id }, { $set: { status: 'hung_up', hungUpAt: at, lastError: '' } });
      result.hungUp += 1;
      log.log?.(`[minutes-grace] appel ${String(claimed.callSid).slice(0, 10)}… coupé après la grâce (entreprise ${claimed.companyId})`);
    } catch (error) {
      if (callAlreadyOver(error)) {
        await Model.updateOne({ _id: claimed._id }, { $set: { status: 'ended', lastError: '' } });
        result.ended += 1;
        continue;
      }
      const giveUp = (claimed.attempts || 1) >= MAX_HANGUP_ATTEMPTS;
      await Model.updateOne({ _id: claimed._id }, { $set: { status: giveUp ? 'failed' : 'scheduled', claimedAt: null, lastError: String(error?.message || error).slice(0, 300) } });
      if (giveUp) result.failed += 1; else result.retried += 1;
      log.warn?.(`[minutes-grace] coupure en échec (${claimed.attempts} essai(s)) :`, error?.message || error);
    }
  }
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
