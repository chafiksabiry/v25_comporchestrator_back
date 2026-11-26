import { countryOfE164 } from '../utils/e164Country.js';
import { heldNumbers } from './inventoryHolders.js';

/**
 * Diagnostic en lecture seule des numéros du compte Twilio : pour chaque numéro, pays, type (local / mobile / toll-free / national),
 * capacités voix / SMS / MMS et rattachement à une société HARX ; puis une ligne de totaux par pays et type.
 * Activé au démarrage uniquement avec LOG_TWILIO_CAPABILITIES=1 (index.js). N'achète, ne modifie et n'envoie rien chez Twilio :
 * seuls des GET (incomingPhoneNumbers.list et ses sous-listes local / mobile / tollFree).
 * Le SID du compte n'est jamais écrit en entier (4 derniers caractères), le jeton jamais.
 */

export const LOG_PREFIX = '[twilio-capabilities]';

export function capabilitiesReportEnabled(env = process.env) {
  return String(env.LOG_TWILIO_CAPABILITIES || '').trim() === '1';
}

/** 4 derniers caractères d'un SID, précédés de « … » ; jamais le SID complet. */
export function maskSid(sid) {
  const s = String(sid || '').trim();
  if (s.length < 8) return '(inconnu)';
  return `…${s.slice(-4)}`;
}

const US_TOLL_FREE = ['800', '833', '844', '855', '866', '877', '888'];

/**
 * Type déduit du numéro quand Twilio ne le donne pas.
 * FR : +336/+337 mobile, +331–+335 géographique (local), +339 non géographique (national), +3380 numéro vert (toll-free).
 * GB : +447 mobile, +441/+442 géographique, +44800/+44808 toll-free, +443 national. US/CA (+1) : toll-free 8xx sinon local.
 */
export function deduceNumberType(e164) {
  const n = String(e164 || '').replace(/[^\d+]/g, '');
  if (n.startsWith('+33')) {
    const d = n.charAt(3);
    if (d === '6' || d === '7') return 'mobile';
    if (d >= '1' && d <= '5') return 'local';
    if (d === '9') return 'national';
    if (n.startsWith('+3380')) return 'toll-free';
    return 'inconnu';
  }
  if (n.startsWith('+44')) {
    if (n.startsWith('+447')) return 'mobile';
    if (n.startsWith('+441') || n.startsWith('+442')) return 'local';
    if (n.startsWith('+44800') || n.startsWith('+44808')) return 'toll-free';
    if (n.startsWith('+443')) return 'national';
    return 'inconnu';
  }
  if (n.startsWith('+1')) return US_TOLL_FREE.includes(n.slice(2, 5)) ? 'toll-free' : 'local';
  return 'inconnu';
}

const yesNo = (v) => (v === true ? 'oui' : v === false ? 'non' : '?');

/**
 * Ligne de synthèse d'un numéro.
 * @param {{ phoneNumber: string, capabilities?: object, status?: string, smsUrl?: string, bundleSid?: string }} n numéro Twilio
 * @param {{ twilioType?: string|null, holder?: { companyId: string, name?: string|null, recordStatus?: string }|null, record?: object|null }} ctx
 */
export function formatNumberLine(n, { twilioType = null, holder = null, record = null } = {}) {
  const caps = n?.capabilities || {};
  const country = countryOfE164(n?.phoneNumber) || '??';
  const type = twilioType ? `${twilioType} (twilio)` : `${deduceNumberType(n?.phoneNumber)} (déduit)`;
  let attribution = 'non';
  if (holder) attribution = `oui société=${holder.companyId}${holder.name ? ` « ${holder.name} »` : ''}`;
  else if (record) attribution = `non (fiche HARX ${record.status || 'sans statut'}, non retenue)`;
  return [
    LOG_PREFIX,
    n?.phoneNumber || '(sans numéro)',
    `pays=${country}`,
    `type=${type}`,
    `voix=${yesNo(caps.voice)}`,
    `sms=${yesNo(caps.sms)}`,
    `mms=${yesNo(caps.mms)}`,
    `attribué=${attribution}`,
    `statut=${n?.status || '?'}`,
    `smsUrl=${n?.smsUrl ? 'configurée' : 'vide'}`,
    `bundle=${n?.bundleSid ? 'oui' : 'non'}`,
  ].join(' ');
}

/** Agrège les lignes par pays et type. @param {Array<{country: string, type: string, caps: object, assigned: boolean}>} rows */
export function summarize(rows) {
  const totals = new Map();
  for (const r of rows) {
    const key = `${r.country}/${r.type}`;
    const t = totals.get(key) || { country: r.country, type: r.type, count: 0, sms: 0, voice: 0, mms: 0, assigned: 0 };
    t.count += 1;
    if (r.caps?.sms === true) t.sms += 1;
    if (r.caps?.voice === true) t.voice += 1;
    if (r.caps?.mms === true) t.mms += 1;
    if (r.assigned) t.assigned += 1;
    totals.set(key, t);
  }
  return [...totals.values()].sort((a, b) => a.country.localeCompare(b.country) || a.type.localeCompare(b.type));
}

export function formatTotalLine(t) {
  return `${LOG_PREFIX} TOTAL ${t.country}/${t.type} : ${t.count} numéro(s), sms=${t.sms}, voix=${t.voice}, mms=${t.mms}, attribués=${t.assigned}`;
}

/** SID → type Twilio, d'après les sous-listes local / mobile / tollFree (lecture seule). Une sous-liste illisible est ignorée. */
async function twilioTypesBySid(client) {
  const types = new Map();
  const lists = [['local', 'local'], ['mobile', 'mobile'], ['tollFree', 'toll-free']];
  for (const [prop, label] of lists) {
    try {
      const sub = client.incomingPhoneNumbers[prop];
      if (!sub || typeof sub.list !== 'function') continue;
      const rows = await sub.list({ limit: 1000 });
      for (const r of rows) if (r?.sid) types.set(r.sid, label);
    } catch (err) {
      console.warn(`${LOG_PREFIX} sous-liste ${prop} illisible :`, err?.message || err);
    }
  }
  return types;
}

/** Noms des sociétés (best effort ; vide si la base n'est pas lisible). */
async function companyNames(db, ids) {
  const names = new Map();
  if (!db || !ids.length) return names;
  try {
    const { default: mongoose } = await import('mongoose');
    const oids = ids.filter((id) => /^[0-9a-f]{24}$/i.test(id)).map((id) => new mongoose.Types.ObjectId(id));
    const rows = await db.collection('companies').find({ _id: { $in: oids } }, { projection: { name: 1, companyName: 1 } }).toArray();
    for (const r of rows) names.set(String(r._id), r.name || r.companyName || null);
  } catch (err) {
    console.warn(`${LOG_PREFIX} noms des sociétés illisibles :`, err?.message || err);
  }
  return names;
}

/**
 * Écrit le diagnostic dans les logs. Ne lève jamais (un échec est journalisé).
 * @param {{ twilioClient: any, PhoneNumber: any, accountSid?: string, db?: any, log?: (line: string) => void, held?: (docs: any[]) => Promise<Set<string>> }} deps
 */
export async function logTwilioCapabilities({ twilioClient, PhoneNumber, accountSid, db, log = console.log, held = heldNumbers }) {
  try {
    log(`${LOG_PREFIX} compte Twilio SID ${maskSid(accountSid)} — lecture seule, aucun achat / modification / envoi`);
    const owned = await twilioClient.incomingPhoneNumbers.list({ limit: 1000 });
    const types = await twilioTypesBySid(twilioClient);
    const numbers = owned.map((n) => n.phoneNumber).filter(Boolean);
    const docs = numbers.length
      ? await PhoneNumber.find({ phoneNumber: { $in: numbers } }).select('phoneNumber companyId status billingStatus').lean()
      : [];
    const heldSet = await held(docs);
    const recordOf = new Map(docs.map((d) => [d.phoneNumber, d]));
    const heldIds = [...new Set(docs.filter((d) => heldSet.has(d.phoneNumber) && d.companyId != null).map((d) => String(d.companyId)))];
    const names = await companyNames(db, heldIds);

    const rows = [];
    const sorted = [...owned].sort((a, b) => String(a.phoneNumber).localeCompare(String(b.phoneNumber)));
    for (const n of sorted) {
      const record = recordOf.get(n.phoneNumber) || null;
      const isHeld = heldSet.has(n.phoneNumber) && record?.companyId != null;
      const holder = isHeld ? { companyId: String(record.companyId), name: names.get(String(record.companyId)) || null } : null;
      const twilioType = types.get(n.sid) || null;
      log(formatNumberLine(n, { twilioType, holder, record }));
      rows.push({
        country: countryOfE164(n.phoneNumber) || '??',
        type: twilioType || deduceNumberType(n.phoneNumber),
        caps: n.capabilities || {},
        assigned: Boolean(holder),
      });
    }
    for (const t of summarize(rows)) log(formatTotalLine(t));
    log(`${LOG_PREFIX} fin : ${owned.length} numéro(s) sur le compte ${maskSid(accountSid)}`);
  } catch (err) {
    console.error(`${LOG_PREFIX} échec :`, err?.message || err);
  }
}
