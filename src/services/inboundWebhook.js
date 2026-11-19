import { publicOrigin } from './twilioSignature.js';

/**
 * Branchement des numéros Twilio sur l'API de CET environnement (recette ou production).
 *
 * La recette et la production partagent le même compte Twilio mais ont chacune leur base : la voice_url d'un numéro décide quel
 * environnement reçoit ses appels. Tout branchement passe par ce module : achat neuf, prise dans l'inventaire, test d'appel entrant,
 * présence du conseiller, réglages d'accueil, renvoi (Reach) et resynchronisation au démarrage.
 *
 * Source unique de l'URL publique de l'API, dans l'ordre :
 *  1. RAILWAY_PUBLIC_DOMAIN : posée par Railway dans chaque environnement, c'est le domaine public du service DANS cet environnement
 *     (production : v25comporchestratorback-production.up.railway.app, recette : v25comporchestratorback-recette.up.railway.app).
 *     Elle ne peut pas être recopiée par erreur d'un environnement à l'autre ;
 *  2. PUBLIC_API_BASE_URL (hébergement hors Railway) : déjà utilisée pour la signature Twilio des webhooks ;
 *  3. l'hôte de la requête en cours, quand il y en a une (comportement historique).
 */

export const INBOUND_CALL_PATH = '/api/phone-numbers/webhooks/twilio/inbound-call';
export const PRODUCTION_API_HOST = 'v25comporchestratorback-production.up.railway.app';
/** Hôtes Railway de l'API HARX (production, recette, préproduction…). */
const HARX_API_HOST_RE = /^v25comporchestratorback(-[a-z0-9-]+)?\.up\.railway\.app$/i;
const HOST_RE = /^[A-Za-z0-9.-]+(:\d+)?$/;

/** Refus de rebrancher un numéro qui appartient à un autre environnement. */
export const NUMBER_OWNED_BY_PRODUCTION = 'NUMBER_OWNED_BY_PRODUCTION';
export const NUMBER_OWNED_BY_PRODUCTION_MESSAGE = 'Ce numéro est branché sur la production HARX : la recette ne le rebranche pas. Utilisez un numéro de la recette.';

const requestHost = (req) => {
  const host = req ? (typeof req.get === 'function' ? req.get('host') : req.headers?.host) : '';
  return host && HOST_RE.test(String(host)) ? String(host).toLowerCase() : '';
};

const railwayHost = (env) => {
  const raw = String(env.RAILWAY_PUBLIC_DOMAIN || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return raw && HOST_RE.test(raw) ? raw : '';
};

/** Origine publique (https://hôte) de l'API de cet environnement ; '' si aucune source n'est disponible. */
export function publicApiOrigin({ env = process.env, req } = {}) {
  const railway = railwayHost(env);
  if (railway) return `https://${railway}`;
  const fromBase = publicOrigin(env);
  if (fromBase) return fromBase.toLowerCase();
  const host = requestHost(req);
  return host ? `https://${host}` : '';
}

/**
 * Paramètres Twilio à poser sur un numéro pour que ses appels arrivent sur cet environnement ; `null` sans URL publique connue.
 * Seuls voiceUrl et voiceMethod sont posés : aucune route ne reçoit les SMS entrants, et la route `call-status` ne sert qu'aux appels
 * de test sortants (la poser en statusCallback du numéro y enverrait chaque appel entrant). Les autres réglages du numéro restent tels quels.
 */
export function inboundWebhookUrls(opts = {}) {
  const origin = publicApiOrigin(opts);
  if (!origin) return null;
  return { voiceUrl: `${origin}${INBOUND_CALL_PATH}`, voiceMethod: 'POST' };
}

export function hostOf(url) {
  try { return new URL(String(url || '')).host.toLowerCase(); } catch { return ''; }
}

export const isHarxApiHost = (host) => HARX_API_HOST_RE.test(String(host || ''));

/** Hôte de l'API de cet environnement ('' s'il est inconnu, ex. en local sans requête). */
export const ownApiHost = (opts = {}) => hostOf(publicApiOrigin(opts));

/** Cet environnement est-il la production ? */
export const isProductionEnv = (opts = {}) => ownApiHost(opts) === PRODUCTION_API_HOST;

/**
 * Hôte HARX d'un AUTRE environnement vers lequel pointe `voiceUrl`, sinon ''. Une voice_url vide, celle par défaut de Twilio
 * (demo.twilio.com) ou un hôte hors HARX ne désignent aucun autre environnement. Sans hôte propre connu, tout hôte HARX est « autre ».
 */
export function foreignHarxHost(voiceUrl, opts = {}) {
  const host = hostOf(voiceUrl);
  if (!host || !isHarxApiHost(host)) return '';
  return host === ownApiHost(opts) ? '' : host;
}

/** Le numéro est branché sur la PRODUCTION alors que cet environnement n'est pas la production : il ne faut pas le réécrire. */
export function ownedByProduction(voiceUrl, opts = {}) {
  return !isProductionEnv(opts) && foreignHarxHost(voiceUrl, opts) === PRODUCTION_API_HOST;
}

/**
 * Incohérence de configuration : PUBLIC_API_BASE_URL désigne un hôte HARX différent du domaine Railway de ce service (ex. la recette
 * configurée avec l'URL de la production). La resynchronisation refuse alors de tourner.
 */
export function originMismatch(env = process.env) {
  const configured = hostOf(publicOrigin(env));
  const railway = railwayHost(env);
  if (!configured || !railway || !isHarxApiHost(configured) || !isHarxApiHost(railway)) return '';
  return configured === railway ? '' : `PUBLIC_API_BASE_URL (${configured}) ≠ RAILWAY_PUBLIC_DOMAIN (${railway})`;
}

/** Numéro masqué sauf les 4 derniers chiffres. */
export const maskNumber = (e164) => {
  const s = String(e164 || '');
  return s.length > 4 ? `${'•'.repeat(s.length - 4)}${s.slice(-4)}` : s;
};

const normalizeUrls = (urls) => (typeof urls === 'string' ? (urls ? { voiceUrl: urls, voiceMethod: 'POST' } : null) : urls || null);

/**
 * Branche UNE ligne (document PhoneNumber avec twilioId) sur `urls` : lit la voice_url actuelle chez Twilio, refuse (hors production) un
 * numéro branché sur la production, n'écrit chez Twilio que si elle diffère, et enregistre metadata.inboundWebhook.
 * @returns {Promise<{ changed: boolean, refused?: string, from: string, to: string }>}
 */
export async function applyInboundWebhook({ twilioClient, PhoneNumber, line, sid, urls, env = process.env, req } = {}) {
  const wanted = normalizeUrls(urls);
  const twilioSid = String(sid || line?.twilioId || '');
  if (!wanted?.voiceUrl || !twilioSid) return { changed: false, from: '', to: wanted?.voiceUrl || '' };
  const current = await twilioClient.incomingPhoneNumbers(twilioSid).fetch();
  const from = String(current?.voiceUrl || '');
  if (ownedByProduction(from, { env, req })) return { changed: false, refused: NUMBER_OWNED_BY_PRODUCTION, from, to: wanted.voiceUrl };
  const changed = from !== wanted.voiceUrl || String(current?.voiceMethod || 'POST').toUpperCase() !== String(wanted.voiceMethod || 'POST').toUpperCase();
  if (changed) await twilioClient.incomingPhoneNumbers(twilioSid).update(wanted);
  if (line?._id && PhoneNumber) await PhoneNumber.updateOne({ _id: line._id }, { $set: { 'metadata.inboundWebhook': wanted.voiceUrl } });
  return { changed, from, to: wanted.voiceUrl };
}

/**
 * Resynchronisation au démarrage (INBOUND_WEBHOOK_RESYNC=1, désactivée par défaut) : pour chaque ligne Twilio ACTIVE de la base de cet
 * environnement, réaligne la voice_url si elle diffère. Ne touche jamais un numéro absent de la base (on part de la base, pas de Twilio),
 * ni, hors production, un numéro branché sur la production.
 * @returns {Promise<{ enabled: boolean, changed: number, skipped: number, refused: number, failed: number }>}
 */
export async function resyncInboundWebhooks({ env = process.env, PhoneNumber, twilioClient, log = console } = {}) {
  const result = { enabled: false, changed: 0, skipped: 0, refused: 0, failed: 0 };
  if (String(env.INBOUND_WEBHOOK_RESYNC || '').trim() !== '1') return result;
  result.enabled = true;
  const mismatch = originMismatch(env);
  if (mismatch) { log.warn(`[inbound-resync] annulée : ${mismatch}.`); return result; }
  const urls = inboundWebhookUrls({ env });
  if (!urls) { log.warn('[inbound-resync] annulée : URL publique de l’API inconnue (RAILWAY_PUBLIC_DOMAIN / PUBLIC_API_BASE_URL).'); return result; }
  const lines = await PhoneNumber.find({ status: 'active', twilioId: { $exists: true, $nin: [null, ''] } }).select('_id phoneNumber twilioId').lean();
  for (const line of lines) {
    const masked = maskNumber(line.phoneNumber);
    try {
      const out = await applyInboundWebhook({ twilioClient, PhoneNumber, line, urls, env });
      if (out.refused) {
        log.warn(`[inbound-resync] ${masked} branché sur la production (${hostOf(out.from)}) : laissé tel quel.`);
        result.refused += 1;
      } else if (out.changed) {
        log.log(`[inbound-resync] ${masked} : ${hostOf(out.from) || '(vide)'} → ${hostOf(out.to)}`);
        result.changed += 1;
      } else {
        result.skipped += 1;
      }
    } catch (err) {
      log.warn(`[inbound-resync] ${masked} : échec (${err?.message || err}).`);
      result.failed += 1;
    }
  }
  log.log(`[inbound-resync] terminé (${hostOf(urls.voiceUrl)}) : ${result.changed} réaligné(s), ${result.skipped} déjà bon(s), ${result.refused} refusé(s), ${result.failed} échec(s).`);
  return result;
}
