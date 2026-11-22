import CallGraceDeadline from '../models/CallGraceDeadline.js';
import MinutesCompany from '../models/MinutesCompany.js';
import ZeroBalanceReserve from '../models/ZeroBalanceReserve.js';
import { notifyCompany } from './companyNotificationService.js';
import { GRACE_MAX_CALL_SECONDS, ORPHAN_RELEASE_MS, debitMinutesClamped, raceTimeout, setZeroReserveHandlers } from './minutesGrace.js';

/**
 * Règle du fondateur : « quand le solde de minutes est à 0 laisser les appels entrants passer, notifier qu'il faut recharger les minutes
 * pour continuer à recevoir les appels, permettre 5 minutes d'appels entrants ». Précisions : 5 minutes AU TOTAL (une réserve unique après
 * le passage à 0, remise à neuf à la recharge) ; ces minutes sont GRATUITES (rien n'est débité, le solde ne passe jamais sous zéro).
 *
 * - Ouverture : au passage du solde à 0 (débit qui l'y amène : `onBalanceExhausted`), ou au premier appel entrant arrivé à solde nul.
 *   Notification « rechargez vos minutes pour continuer à recevoir les appels », une seule fois par épisode.
 * - Un appel entrant arrivé à solde nul sonne normalement tant que la réserve n'est pas épuisée : il prend une TRANCHE (60 s) réservée
 *   atomiquement ; le balayeur des échéances (minutesGrace.js, toutes les 10 s) prend la tranche suivante ~25 s avant la fin. Plus rien à
 *   prendre : l'échéance n'est plus repoussée et le balayeur coupe l'appel (même mécanisme que la grâce B.1 : CallGraceDeadline, coupure
 *   par l'API Twilio). Le timeLimit du <Dial> vaut la réserve libre à l'arrivée : filet de Twilio si le balayeur est arrêté.
 * - Appels simultanés : chaque tranche est prise par un findOneAndUpdate conditionné aux compteurs lus (jamais deux fois la même part).
 * - Fin de l'appel (compte rendu Twilio, ou filet du balayeur) : la durée décrochée est consignée (`usedSeconds`, `totalFreeSeconds`), les
 *   clés de l'appel sont inscrites dans `chargedCallSids` avec un coût nul (une synchronisation ultérieure ne le débite jamais), et la part
 *   tenue est rendue.
 * - Réserve épuisée : comportement d'avant (répondeur), et seconde notification (une seule fois par épisode).
 * - Remise à neuf : à la recharge (minutes achetées ou octroyées depuis l'ouverture, `fundedAtOpen`), constatée à l'appel suivant à solde
 *   nul ou au prochain passage à 0.
 * Les appels de test, le test de ligne, les appels sortants et la grâce B.1 ne passent jamais par ici.
 */
export const ZERO_RESERVE_SECONDS = 5 * 60;
export const ZERO_TRANCHE_SECONDS = 60;
/** La tranche suivante est prise quand l'échéance est à moins de 25 s (le balayeur passe toutes les 10 s). */
export const ZERO_EXTEND_LEAD_MS = 25_000;
/** Une ligne `pending` plus jeune que ce délai : un démarrage est en cours, le recalcul de la réserve attend. */
const PENDING_MS = 30_000;
const RETENTION_MS = 2 * 24 * 60 * 60 * 1000;
const FINISHED = new Set(['completed', 'canceled', 'failed', 'busy', 'no-answer']);
/** Page de recharge existante du portail (bandeau de solde, écran Facturation). */
export const RECHARGE_PATH = '/app/billing';
export const ZERO_LANGUAGES = ['fr', 'en', 'es', 'ar'];

/** Base connectée ? Remplaçable dans les tests. Sans base : la réserve n'existe pas, comportement d'avant (répondeur à solde nul). */
let dbReadyImpl = null;
export const zeroDbReady = () => (dbReadyImpl ? dbReadyImpl() : ZeroBalanceReserve.db?.readyState === 1);
export function setZeroReserveDbReady(fn) { dbReadyImpl = fn; }

const defaults = () => ({ Reserve: ZeroBalanceReserve, Model: CallGraceDeadline, Wallet: MinutesCompany, notify: notifyCompany });
const withDeps = (deps = {}) => ({ ...defaults(), ...deps });

export const fundedOf = (wallet) => (Number(wallet?.purchasedMinutes) || 0) + (Number(wallet?.planMinutesGranted) || 0);
export const balanceIsExhausted = (minutes) => Math.floor(Number(minutes) || 0) < 1;
export const zeroLanguage = (lang) => {
  const l = String(lang || '').trim().toLowerCase().slice(0, 2);
  return ZERO_LANGUAGES.includes(l) ? l : 'en';
};
/** Secondes encore libres dans la réserve (ni consommées ni tenues par un appel en cours). */
export const remainingOf = (doc) => Math.max(0, ZERO_RESERVE_SECONDS - Math.max(0, Number(doc?.usedSeconds) || 0) - Math.max(0, Number(doc?.heldSeconds) || 0));
const newEpisodeId = (now) => `${new Date(now).toISOString()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Textes des notifications, dans la langue de l'interface du titulaire (anglais par défaut). Aucun prix ni promotion.
 * `open` : passage à 0 (réserve ouverte) ; `exhausted` : réserve consommée (les appels vont au répondeur).
 */
export const ZERO_TEXTS = Object.freeze({
  fr: {
    open: {
      title: 'Minutes épuisées : rechargez pour continuer à recevoir les appels',
      message: 'Votre solde de minutes est à 0. Vous pouvez encore recevoir 5 minutes d’appels entrants au total, non facturées. Rechargez vos minutes pour continuer à recevoir les appels.',
    },
    exhausted: {
      title: 'Appels entrants envoyés au répondeur : rechargez vos minutes',
      message: 'Les 5 minutes d’appels entrants sont consommées : vos appels entrants vont désormais au répondeur. Rechargez vos minutes pour continuer à recevoir les appels.',
    },
  },
  en: {
    open: {
      title: 'Minutes used up: top up to keep receiving calls',
      message: 'Your minutes balance is 0. You can still receive 5 minutes of incoming calls in total, not billed. Top up your minutes to keep receiving calls.',
    },
    exhausted: {
      title: 'Incoming calls now go to voicemail: top up your minutes',
      message: 'The 5 minutes of incoming calls are used up: your incoming calls now go to voicemail. Top up your minutes to keep receiving calls.',
    },
  },
  es: {
    open: {
      title: 'Minutos agotados: recargue para seguir recibiendo llamadas',
      message: 'Su saldo de minutos es 0. Todavía puede recibir 5 minutos de llamadas entrantes en total, sin cargo. Recargue sus minutos para seguir recibiendo llamadas.',
    },
    exhausted: {
      title: 'Las llamadas entrantes van al buzón de voz: recargue sus minutos',
      message: 'Los 5 minutos de llamadas entrantes se han consumido: sus llamadas entrantes van ahora al buzón de voz. Recargue sus minutos para seguir recibiendo llamadas.',
    },
  },
  ar: {
    open: {
      title: 'نفدت الدقائق: أعد الشحن لمواصلة استقبال المكالمات',
      message: 'رصيد دقائقك 0. لا يزال بإمكانك استقبال 5 دقائق من المكالمات الواردة إجمالًا، دون احتسابها. أعد شحن دقائقك لمواصلة استقبال المكالمات.',
    },
    exhausted: {
      title: 'تُحوَّل المكالمات الواردة الآن إلى البريد الصوتي: أعد شحن دقائقك',
      message: 'استُهلكت الدقائق الخمس للمكالمات الواردة: تُحوَّل مكالماتك الواردة الآن إلى البريد الصوتي. أعد شحن دقائقك لمواصلة استقبال المكالمات.',
    },
  },
});

/** Contenu de la notification d'un évènement (clé de dédoublonnage incluse). */
export function zeroNotice({ event, episode, language }) {
  const text = ZERO_TEXTS[zeroLanguage(language)][event];
  return { key: `minutes-zero-inbound-${event}-${episode}`, kind: 'minutes', title: text.title, message: text.message, actionPath: RECHARGE_PATH };
}

/**
 * Notifie l'évènement une seule fois par épisode : drapeau posé atomiquement sur la réserve (le premier gagne), puis notification du
 * portail à clé unique (une seconde écriture du même évènement n'en crée pas d'autre). Ne lève jamais.
 */
export async function notifyZeroEvent({ companyId, episode, event }, deps = {}) {
  const { Reserve, notify } = withDeps(deps);
  if (!companyId || !episode) return false;
  const flag = event === 'open' ? 'notifiedOpen' : 'notifiedExhausted';
  try {
    const won = await Reserve.findOneAndUpdate({ companyId, episode, [flag]: { $ne: episode } }, { $set: { [flag]: episode } }, { new: true });
    if (!won) return false;
    await notify({ companyId, ...zeroNotice({ event, episode, language: won.ownerLanguage }) });
    console.log(`[minutes-zero] notification « ${event} » pour l'entreprise ${companyId}`);
    return true;
  } catch (error) {
    console.warn('[minutes-zero] notification non envoyée :', error?.message || error);
    return false;
  }
}

/**
 * Ouvre un NOUVEL épisode (réserve de 5 minutes remise à neuf) : compare-and-set sur l'épisode lu, le premier gagne ; les secondes tenues
 * par des appels gratuits encore en cours restent tenues. Puis notification « open ».
 * @returns {Promise<object|null>} la réserve à jour
 */
export async function openEpisode({ companyId, wallet, now = Date.now(), previous }, deps = {}) {
  const { Reserve } = withDeps(deps);
  if (!companyId) return null;
  const funded = fundedOf(wallet);
  // `previous` : épisode vu par l'appelant (périmé). Un autre l'a remplacé entre-temps (appels simultanés) : on prend le sien, jamais deux.
  let prev = previous;
  for (let i = 0; i < 4; i += 1) {
    const cur = await Reserve.findOne({ companyId }).lean();
    if (prev === undefined) prev = cur?.episode || '';
    if (cur?.episode && cur.episode !== prev) return cur;
    const episode = newEpisodeId(now);
    const set = { episode, openedAt: new Date(now), fundedAtOpen: funded, usedSeconds: 0, exhaustedAt: null };
    let doc = null;
    if (!cur) {
      try {
        const r = await Reserve.updateOne({ companyId }, { $setOnInsert: { companyId, ...set, heldSeconds: 0, episodes: 1, totalFreeSeconds: 0, notifiedOpen: '', notifiedExhausted: '', ownerLanguage: '' } }, { upsert: true });
        if (r?.upsertedCount) doc = await Reserve.findOne({ companyId }).lean();
      } catch (error) {
        if (error?.code !== 11000) throw error;
      }
    } else {
      doc = await Reserve.findOneAndUpdate({ companyId, episode: cur.episode ? cur.episode : { $in: ['', null] } }, { $set: set, $inc: { episodes: 1 } }, { new: true });
    }
    if (doc) {
      console.log(`[minutes-zero] réserve de 5 min d'appels entrants ouverte pour l'entreprise ${companyId}`);
      await notifyZeroEvent({ companyId, episode, event: 'open' }, deps);
      return doc;
    }
  }
  return Reserve.findOne({ companyId }).lean();
}

/** Épisode en cours, ouvert (ou remis à neuf après une recharge) si besoin. */
export async function currentEpisode({ companyId, wallet, now = Date.now() }, deps = {}) {
  const { Reserve } = withDeps(deps);
  const doc = await Reserve.findOne({ companyId }).lean();
  if (doc?.episode && fundedOf(wallet) <= (Number(doc.fundedAtOpen) || 0)) return doc;
  return openEpisode({ companyId, wallet, now, previous: doc?.episode || '' }, deps);
}

/** Réserve épuisée (première constatation de l'épisode) : notification « exhausted ». */
export async function markExhausted({ companyId, episode, now = Date.now() }, deps = {}) {
  const { Reserve } = withDeps(deps);
  if (!companyId || !episode) return false;
  const done = await Reserve.findOneAndUpdate({ companyId, episode, exhaustedAt: null }, { $set: { exhaustedAt: new Date(now) } }, { new: true });
  if (done) console.log(`[minutes-zero] réserve épuisée pour l'entreprise ${companyId} : les appels entrants vont au répondeur jusqu'à la recharge`);
  await notifyZeroEvent({ companyId, episode, event: 'exhausted' }, deps);
  return Boolean(done);
}

/**
 * Prise ATOMIQUE de `want` secondes au plus de la réserve : compare-and-set sur les compteurs lus (deux appels simultanés ne prennent
 * jamais la même part). @returns {Promise<{ amount: number, remaining: number, doc: object|null }>} `remaining` : libre AVANT la prise
 */
export async function takeSeconds({ companyId, want = ZERO_TRANCHE_SECONDS }, deps = {}, attempts = 8) {
  const { Reserve } = withDeps(deps);
  let remaining = 0; let doc = null;
  for (let i = 0; i < attempts; i += 1) {
    doc = await Reserve.findOne({ companyId }).lean();
    if (!doc?.episode) return { amount: 0, remaining: 0, doc };
    remaining = remainingOf(doc);
    const amount = Math.min(remaining, Math.max(0, Math.floor(Number(want) || 0)));
    if (amount <= 0) return { amount: 0, remaining, doc };
    const updated = await Reserve.findOneAndUpdate(
      { companyId, episode: doc.episode, usedSeconds: Number(doc.usedSeconds) || 0, heldSeconds: Number(doc.heldSeconds) || 0 },
      { $inc: { heldSeconds: amount } },
      { new: true }
    );
    if (updated) return { amount, remaining, doc: updated };
  }
  return { amount: 0, remaining, doc }; // contention persistante : prudence (jamais de part inventée)
}

/** Rend `held` secondes tenues et consigne `used` secondes consommées (dans l'épisode de l'appel seulement). Jamais négatif. */
async function giveBack({ companyId, held, used, episode }, deps = {}) {
  const { Reserve } = withDeps(deps);
  const h = Math.max(0, Math.round(Number(held) || 0));
  const u = Math.max(0, Math.round(Number(used) || 0));
  if (!companyId || (!h && !u)) return null;
  const cur = await Reserve.findOne({ companyId }).lean();
  if (!cur) return null;
  const sameEpisode = Boolean(episode) && cur.episode === episode;
  const inc = { totalFreeSeconds: u, ...(sameEpisode ? { usedSeconds: u } : {}) };
  let doc = await Reserve.findOneAndUpdate({ companyId, heldSeconds: { $gte: h } }, { $inc: { heldSeconds: -h, ...inc } }, { new: true });
  if (!doc) doc = await Reserve.findOneAndUpdate({ companyId }, { $set: { heldSeconds: 0 }, $inc: inc }, { new: true });
  return doc;
}

/**
 * Appel entrant arrivé à solde nul : part de la réserve gratuite. 1) épisode en cours (ouvert / remis à neuf si besoin) ; 2) échéance
 * écrite (`pending`) ; 3) première tranche prise atomiquement ; 4) échéance `held` (coupure à la fin de la tranche, repoussée par le
 * balayeur tant que la réserve a du libre). Réserve épuisée : null (répondeur, notification « exhausted »). Idempotent par CallSid.
 * @returns {Promise<null | { limitSeconds: number, allottedSeconds: number, remainingSeconds: number, episode: string }>}
 *   `limitSeconds` : timeLimit des <Dial> (réserve libre à l'arrivée) ; `remainingSeconds` : libre après cette tranche.
 */
export async function startZeroCall({ callSid, companyId, now = Date.now(), signal = null }, deps = {}) {
  const { Model, Wallet } = withDeps(deps);
  const sid = String(callSid || '').trim();
  if (!sid || !companyId) return null;
  const existing = await Model.findOne({ callSid: sid }).lean();
  if (existing) {
    if (!existing.zeroReserve || existing.zeroStatus !== 'held') return null;
    const limit = Math.max(1, Math.ceil((new Date(existing.zeroLimitAt || existing.deadline).getTime() - now) / 1000));
    return { limitSeconds: Math.min(limit, GRACE_MAX_CALL_SECONDS), allottedSeconds: existing.zeroAllottedSeconds || 0, remainingSeconds: 0, episode: existing.zeroEpisode || '' };
  }
  const wallet = await Wallet.findOne({ companyId }).select('minutes purchasedMinutes planMinutesGranted').lean();
  if (wallet && !balanceIsExhausted(wallet.minutes)) return null; // solde redevenu disponible entre-temps : flux normal
  const episodeDoc = await currentEpisode({ companyId, wallet, now }, deps);
  if (!episodeDoc?.episode) return null;
  if (signal?.aborted) return null;
  let inserted = false;
  try {
    const r = await Model.updateOne({ callSid: sid }, { $setOnInsert: {
      callSid: sid, companyId, path: 'inbound_zero', startedAt: new Date(now), coveredSeconds: 0, creditFactor: 1,
      graceStartsAt: new Date(now), deadline: new Date(now + ZERO_TRANCHE_SECONDS * 1000), status: 'scheduled', attempts: 0,
      reservedCredits: 0, reservationStatus: 'none', extensible: false,
      zeroReserve: true, zeroStatus: 'pending', zeroAllottedSeconds: 0, zeroUsedSeconds: 0, zeroEpisode: episodeDoc.episode, zeroFinal: false,
      expiresAt: new Date(now + ZERO_TRANCHE_SECONDS * 1000 + RETENTION_MS),
    } }, { upsert: true });
    inserted = Boolean(r?.upsertedCount);
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
  if (!inserted) return null;
  const abandon = () => Model.updateOne({ callSid: sid }, { $set: { status: 'ended', zeroStatus: 'none' } });
  const { amount, remaining, doc } = await takeSeconds({ companyId, want: ZERO_TRANCHE_SECONDS }, deps);
  if (amount <= 0 || signal?.aborted) {
    if (amount > 0) await giveBack({ companyId, held: amount, used: 0 }, deps);
    await abandon();
    // Plus rien de libre (et non une simple contention) : réserve épuisée, l'appel va au répondeur.
    if (amount <= 0 && remaining <= 0) await markExhausted({ companyId, episode: doc?.episode || episodeDoc.episode, now }, deps);
    return null;
  }
  const episode = doc?.episode || episodeDoc.episode;
  const limitSeconds = Math.min(remaining, GRACE_MAX_CALL_SECONDS);
  const deadline = new Date(now + amount * 1000);
  await Model.updateOne({ callSid: sid, zeroStatus: 'pending' }, { $set: {
    zeroStatus: 'held', zeroAllottedSeconds: amount, zeroEpisode: episode, zeroFinal: remaining - amount <= 0,
    graceStartsAt: deadline, deadline, zeroLimitAt: new Date(now + limitSeconds * 1000), expiresAt: new Date(deadline.getTime() + RETENTION_MS),
  } });
  // Clé de l'appel inscrite tout de suite avec un coût nul : une synchronisation des appels ne le débite jamais, même après une recharge.
  await debitMinutesClamped({ companyId, keys: [sid], cost: 0, seconds: 0, Wallet }).catch(() => null);
  return { limitSeconds, allottedSeconds: amount, remainingSeconds: remaining - amount, episode };
}

/**
 * Fin d'un appel gratuit (compte rendu de fin, ou filet du balayeur) : part rendue UNE fois (`held` → `released` posé atomiquement), durée
 * décrochée consignée (au plus la part tenue), clés inscrites sans débit. Réserve consommée : notification « exhausted ».
 * @returns {Promise<number>} secondes consignées
 */
export async function endZeroCall(row, durationSeconds, keys = [], deps = {}) {
  const { Model, Wallet } = withDeps(deps);
  if (!row?.callSid) return 0;
  const done = await Model.findOneAndUpdate({ callSid: row.callSid, zeroStatus: 'held' }, { $set: { zeroStatus: 'released', releasedAt: new Date() } }, { new: true });
  if (!done) return 0;
  const held = Number(done.zeroAllottedSeconds) || 0;
  const used = Math.min(held, Math.max(0, Math.round(Number(durationSeconds) || 0)));
  await Model.updateOne({ callSid: row.callSid }, { $set: { zeroUsedSeconds: used } });
  const allKeys = [...new Set([done.callSid, ...(done.childSids || []), ...keys].map((k) => String(k || '').trim()).filter(Boolean))];
  // Une clé à la fois : celles déjà inscrites (l'appel lui-même, au démarrage) n'empêchent pas d'inscrire les autres (jambe décrochée).
  for (const key of allKeys) await debitMinutesClamped({ companyId: done.companyId, keys: [key], cost: 0, seconds: 0, Wallet }).catch(() => null);
  const doc = await giveBack({ companyId: done.companyId, held, used, episode: done.zeroEpisode }, deps);
  if (used > 0) console.log(`[minutes-zero] ${used} s d'appel entrant gratuit consignées (non facturées) pour l'entreprise ${done.companyId}`);
  if (doc?.episode && doc.episode === done.zeroEpisode && (Number(doc.usedSeconds) || 0) >= ZERO_RESERVE_SECONDS) await markExhausted({ companyId: done.companyId, episode: doc.episode }, deps);
  return used;
}

/** Appel gratuit qui ne sonne plus chez personne (répondeur, agent IA) : part rendue sans consommation. */
export async function cancelZeroCall(callSid, deps = {}) {
  const { Model } = withDeps(deps);
  const sid = String(callSid || '').trim();
  if (!sid) return 0;
  const row = await Model.findOne({ callSid: sid, zeroReserve: true }).lean();
  if (!row) return 0;
  await Model.updateOne({ callSid: sid, status: 'scheduled' }, { $set: { status: 'ended' } });
  return endZeroCall(row, 0, [], deps).then(() => 1);
}

/**
 * Tranche suivante de chaque appel gratuit en cours dont l'échéance arrive (moins de 25 s) : prise atomique, échéance repoussée. Plus rien
 * de libre : l'appel est marqué « dernière tranche » (le portail avertit à 1 minute), la réserve est épuisée, le balayeur coupe à l'échéance.
 */
export async function extendZeroCalls({ now = Date.now(), limit = 50, log = console } = {}, deps = {}) {
  const { Model } = withDeps(deps);
  const out = { extended: 0, final: 0, errors: 0 };
  // Les appels déjà à leur dernière tranche sont relus : des secondes rendues entre-temps (appel voisin terminé tôt) les prolongent encore.
  const rows = await Model.find({ zeroReserve: true, zeroStatus: 'held', status: 'scheduled', deadline: { $gt: new Date(now), $lte: new Date(now + ZERO_EXTEND_LEAD_MS) } }).sort({ deadline: 1 }).limit(limit).lean();
  for (const row of rows || []) {
    try {
      const { amount, remaining, doc } = await takeSeconds({ companyId: row.companyId, want: ZERO_TRANCHE_SECONDS }, deps);
      if (amount <= 0) {
        if (remaining > 0) continue; // contention : nouvel essai au passage suivant
        if (!row.zeroFinal) { await Model.updateOne({ _id: row._id }, { $set: { zeroFinal: true } }); out.final += 1; }
        if (doc?.episode) await markExhausted({ companyId: row.companyId, episode: doc.episode, now }, deps);
        continue;
      }
      const deadline = new Date(new Date(row.deadline).getTime() + amount * 1000);
      const final = remaining - amount <= 0;
      const ok = await Model.findOneAndUpdate(
        { _id: row._id, status: 'scheduled', deadline: new Date(row.deadline) },
        { $inc: { zeroAllottedSeconds: amount }, $set: { deadline, graceStartsAt: deadline, zeroFinal: final, zeroEpisode: doc?.episode || row.zeroEpisode, expiresAt: new Date(deadline.getTime() + RETENTION_MS) } },
        { new: true }
      );
      if (ok) out.extended += 1; else await giveBack({ companyId: row.companyId, held: amount, used: 0 }, deps);
    } catch (error) {
      out.errors += 1;
      log.warn?.(`[minutes-zero] tranche de ${String(row.callSid).slice(0, 10)}… en échec :`, error?.message || error);
    }
  }
  return out;
}

/** Recalcul de la part tenue (crash entre deux écritures) : plus grande que la somme des appels gratuits tenus => ramenée à cette somme. */
export async function reconcileHeld({ now = Date.now() } = {}, deps = {}) {
  const { Reserve, Model } = withDeps(deps);
  let fixed = 0;
  const docs = await Reserve.find({ heldSeconds: { $gt: 0 } }).limit(200).lean();
  for (const doc of docs || []) {
    const rows = await Model.find({ companyId: doc.companyId, zeroReserve: true, zeroStatus: { $in: ['held', 'pending'] } }).limit(500).lean();
    if ((rows || []).some((r) => r.zeroStatus === 'pending' && now - new Date(r.startedAt).getTime() < PENDING_MS)) continue;
    const sum = (rows || []).filter((r) => r.zeroStatus === 'held').reduce((a, r) => a + (Number(r.zeroAllottedSeconds) || 0), 0);
    if ((Number(doc.heldSeconds) || 0) > sum) {
      const done = await Reserve.findOneAndUpdate({ companyId: doc.companyId, heldSeconds: doc.heldSeconds }, { $set: { heldSeconds: sum } }, { new: true });
      if (done) { fixed += 1; console.warn(`[minutes-zero] part tenue recalculée pour l'entreprise ${doc.companyId} : ${doc.heldSeconds} → ${sum}`); }
    }
  }
  return fixed;
}

/**
 * Passage du balayeur (minutesGrace.sweepGraceDeadlines, après les coupures) : tranches suivantes, recalcul, puis filet des appels gratuits
 * dont le compte rendu de fin s'est perdu (2 min après l'échéance : durée lue chez Twilio, sinon la part tenue). null sans base.
 */
export async function sweepZeroCalls({ client = null, now = Date.now(), log = console } = {}, deps = {}) {
  if (!deps.Model && !zeroDbReady()) return null;
  const { Model } = withDeps(deps);
  const out = await extendZeroCalls({ now, log }, deps);
  out.reconciled = 0; out.released = 0;
  try { out.reconciled = await reconcileHeld({ now }, deps); } catch (error) { log.warn?.('[minutes-zero] recalcul en échec :', error?.message || error); }
  const orphans = await Model.find({ zeroReserve: true, zeroStatus: 'held', deadline: { $lte: new Date(now - ORPHAN_RELEASE_MS) } }).sort({ deadline: 1 }).limit(50).lean();
  for (const row of orphans || []) {
    try {
      let call = null;
      if (client) call = await raceTimeout(Promise.resolve().then(() => client.calls(row.callSid).fetch()), 3000, null);
      const known = call && FINISHED.has(String(call.status || '')) && Number.isFinite(Number(call.duration));
      await Model.updateOne({ _id: row._id, status: 'scheduled' }, { $set: { status: 'ended' } });
      await endZeroCall(row, known ? Number(call.duration) : Number(row.zeroAllottedSeconds) || 0, [], deps);
      out.released += 1;
    } catch (error) { log.warn?.('[minutes-zero] appel gratuit orphelin non clôturé :', error?.message || error); }
  }
  return out.extended || out.final || out.errors || out.reconciled || out.released ? out : null;
}

/** Passage du solde à 0 par un débit : nouvel épisode (réserve remise à neuf) et notification « open ». Sans base : rien. */
export async function onBalanceExhausted(companyId, deps = {}) {
  if (!deps.Reserve && !zeroDbReady()) return null;
  const { Wallet } = withDeps(deps);
  const wallet = await Wallet.findOne({ companyId }).select('minutes purchasedMinutes planMinutesGranted').lean();
  if (!wallet || !balanceIsExhausted(wallet.minutes)) return null;
  return openEpisode({ companyId, wallet }, deps);
}

/**
 * État pour le portail (lecture du solde) : null si le solde n'est pas épuisé. Lecture seule : sans épisode ouvert (ou après une
 * recharge), la réserve est entière.
 * @returns {Promise<null | { reserveSeconds: number, remainingSeconds: number, exhausted: boolean }>}
 */
export async function zeroInboundView({ companyId, wallet }, deps = {}) {
  if (!deps.Reserve && !zeroDbReady()) return null;
  if (!wallet || !balanceIsExhausted(wallet.minutes)) return null;
  const { Reserve } = withDeps(deps);
  const doc = await Reserve.findOne({ companyId }).lean();
  const fresh = !doc?.episode || fundedOf(wallet) > (Number(doc.fundedAtOpen) || 0);
  const remainingSeconds = fresh ? ZERO_RESERVE_SECONDS : remainingOf(doc);
  return { reserveSeconds: ZERO_RESERVE_SECONDS, remainingSeconds, exhausted: remainingSeconds <= 0 };
}

/** Langue de l'interface du titulaire (relevée à sa lecture du solde) : textes des notifications. Langue inconnue : rien. */
export async function recordOwnerLanguage(companyId, language, deps = {}) {
  if (!deps.Reserve && !zeroDbReady()) return false;
  const l = String(language || '').trim().toLowerCase().slice(0, 2);
  if (!companyId || !ZERO_LANGUAGES.includes(l)) return false;
  const { Reserve } = withDeps(deps);
  const cur = await Reserve.findOne({ companyId }).select('ownerLanguage').lean();
  if (cur?.ownerLanguage === l) return false;
  try {
    const r = cur
      ? await Reserve.updateOne({ companyId }, { $set: { ownerLanguage: l } })
      : await Reserve.updateOne({ companyId }, { $setOnInsert: { companyId, ownerLanguage: l, episode: '', heldSeconds: 0, usedSeconds: 0 } }, { upsert: true });
    return Boolean(r?.modifiedCount || r?.upsertedCount);
  } catch (error) {
    if (error?.code === 11000) { await Reserve.updateOne({ companyId }, { $set: { ownerLanguage: l } }); return true; }
    throw error;
  }
}

/**
 * Clés d'appels (synchronisation du solde, charge-call) appartenant à un appel gratuit à solde nul : elles sont inscrites sans débit.
 * Sans base : ensemble vide (rien ne change).
 */
export async function freeZeroKeys(keys, deps = {}) {
  const list = [...new Set((keys || []).map(String).filter(Boolean))];
  if (!list.length || (!deps.Model && !zeroDbReady())) return new Set();
  const { Model } = withDeps(deps);
  const rows = await Model.find({ zeroReserve: true, $or: [{ callSid: { $in: list } }, { childSids: { $in: list } }] }).select('callSid childSids').lean();
  const free = new Set();
  for (const r of rows || []) for (const k of [r.callSid, ...(r.childSids || [])]) if (list.includes(String(k))) free.add(String(k));
  return free;
}

// Inscription auprès de minutesGrace (fin, annulation, balayeur, passage à 0), sans import circulaire.
setZeroReserveHandlers({
  end: (row, durationSeconds, keys) => endZeroCall(row, durationSeconds, keys),
  cancel: (callSid) => cancelZeroCall(callSid),
  sweep: (opts) => sweepZeroCalls(opts),
  onExhausted: (companyId) => onBalanceExhausted(companyId),
});
