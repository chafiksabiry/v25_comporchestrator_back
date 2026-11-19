import { hostOf, isHarxApiHost, PRODUCTION_API_HOST, publicApiOrigin } from './inboundWebhook.js';

/**
 * Applications TwiML des appels sortants du navigateur (Voice SDK) : UNE application par environnement.
 *
 * La recette et la production partagent le même compte Twilio. Une application TwiML commune (même friendlyName) était réécrite par
 * l'environnement qui émettait le dernier jeton : sa VoiceUrl pointait alors sur l'autre environnement, et les appels sortants de l'un
 * partaient vers l'API (et la base) de l'autre. Désormais :
 *  - le friendlyName porte l'environnement : « harx-callcentre-outbound (recette) », « harx-callcentre-outbound (production) » ;
 *  - la VoiceUrl vient de la même source que les webhooks entrants (inboundWebhook.publicApiOrigin : RAILWAY_PUBLIC_DOMAIN d'abord) ;
 *  - on ne met à jour QUE l'application qui porte exactement le nom de CET environnement : jamais celle d'un autre environnement,
 *    ni l'ancienne application commune sans suffixe ;
 *  - un SID imposé par variable d'environnement est utilisé tel quel, sans aucun appel à Twilio ni mise à jour (sa configuration
 *    relève de la personne qui l'a posé) ;
 *  - recherche / création idempotentes : on retrouve l'application par son nom exact avant d'en créer une, et les demandes simultanées
 *    d'un même processus partagent la même recherche (pas de doublon).
 */

/** Libellé de l'environnement d'après l'hôte public de l'API : 'production', 'recette', … ; '' s'il est inconnu. */
export function environmentLabel(opts = {}) {
  const host = hostOf(publicApiOrigin(opts));
  if (!host) return '';
  if (host === PRODUCTION_API_HOST) return 'production';
  if (isHarxApiHost(host)) {
    const m = /^v25comporchestratorback-([a-z0-9-]+)\.up\.railway\.app$/i.exec(host);
    if (m) return m[1].toLowerCase();
  }
  return host;
}

/** friendlyName de l'application `baseName` pour cet environnement, ex. « harx-callcentre-outbound (recette) ». */
export const envAppName = (baseName, label) => `${baseName} (${label})`;

const cache = new Map();

/** Vide le cache (tests). */
export function resetTwimlAppCache() { cache.clear(); }

async function findOrCreate(client, friendlyName, voiceUrl) {
  const listed = await client.applications.list({ friendlyName, limit: 20 });
  // Twilio filtre déjà par nom, on revérifie le nom EXACT : jamais une application d'un autre environnement ni l'ancienne commune.
  const mine = (listed || []).filter((a) => a && a.friendlyName === friendlyName)
    .sort((a, b) => new Date(a.dateCreated || 0) - new Date(b.dateCreated || 0));
  let app = mine[0];
  if (!app) return client.applications.create({ friendlyName, voiceUrl, voiceMethod: 'POST' });
  if (app.voiceUrl !== voiceUrl || String(app.voiceMethod || 'POST').toUpperCase() !== 'POST') {
    app = await client.applications(app.sid).update({ voiceUrl, voiceMethod: 'POST' });
  }
  return app;
}

/**
 * SID de l'application TwiML `baseName` de CET environnement, pointée sur `${origine publique}${path}`.
 * @param {object} client  client Twilio
 * @param {{ baseName: string, path: string, pinnedSid?: string, env?: object, req?: object }} opts
 */
export async function ensureEnvTwimlApp(client, { baseName, path, pinnedSid, env = process.env, req } = {}) {
  if (pinnedSid) return pinnedSid;
  const origin = publicApiOrigin({ env, req });
  const label = environmentLabel({ env, req });
  if (!origin || !label) throw new Error('URL publique de l’API inconnue : application TwiML non configurée.');
  const friendlyName = envAppName(baseName, label);
  const voiceUrl = `${origin}${path}`;
  const key = `${friendlyName}|${voiceUrl}`;
  if (!cache.has(key)) {
    const pending = findOrCreate(client, friendlyName, voiceUrl).then((app) => app.sid);
    cache.set(key, pending);
    pending.catch(() => cache.delete(key));
  }
  return cache.get(key);
}
