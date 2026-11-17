import jwt from 'jsonwebtoken';
import { WebSocketServer } from 'ws';
import { callerAccess } from '../middleware/companyScope.js';
import { agentIdsOfUser } from '../middleware/agentGuard.js';

/**
 * WebSocket /escrow-updates : évènements temps réel du portefeuille (escrow_update, reconciliation_complete, rep_wallet_update,
 * ai_audit_flagged, call_analysis_complete, call_analysis_help_requested).
 *
 * Connexion : jeton UTILISATEUR obligatoire (celui de l'application, localStorage `token`), présenté UNIQUEMENT en sous-protocole :
 * `new WebSocket(url, ['bearer', token])` (le serveur répond le sous-protocole `bearer`). Pas de `?token=` : l'URL finit dans les
 * journaux d'accès des proxys.
 * La société de l'appelant vient du service d'inscription (callerAccess), jamais du client. Refus à la poignée de main :
 * 401 sans jeton ou jeton invalide / de service, 403 utilisateur sans société, 503 service d'inscription indisponible.
 * La connexion est fermée (code 4401) à l'expiration du jeton : le client se reconnecte avec un jeton frais.
 *
 * Diffusion filtrée CÔTÉ SERVEUR (`canReceive`) : un évènement d'une société ne part qu'aux connexions de CETTE société (titulaire ou
 * membre), un évènement d'un agent (`repId`) qu'à la connexion de CET agent. Un évènement sans `companyId` ni `repId` n'est envoyé à personne.
 *
 * ESCROW_WS_AUTH_REQUIRED=false (transition, à retirer dès que l'application envoie son jeton) : les connexions SANS jeton restent
 * acceptées et reçoivent l'ancien flux non filtré ; un jeton présenté est toujours vérifié et filtré. Valeur par défaut : true.
 */

let wss;

export function wsAuthRequired(env = process.env) {
  return String(env.ESCROW_WS_AUTH_REQUIRED ?? 'true').trim().toLowerCase() !== 'false';
}

/** Jeton présenté à la poignée de main : sous-protocole `bearer, <jeton>` uniquement (un `?token=` est ignoré). */
export function tokenFromUpgrade(req) {
  const protocols = String(req.headers?.['sec-websocket-protocol'] || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const i = protocols.findIndex((p) => p.toLowerCase() === 'bearer');
  if (i >= 0 && protocols[i + 1]) return protocols[i + 1];
  return null;
}

/**
 * Authentifie une demande de connexion. @returns {Promise<{ok: true, access: object|null} | {ok: false, code: number, message: string}>}
 * `access` null = connexion héritée sans jeton (seulement si ESCROW_WS_AUTH_REQUIRED=false).
 */
export async function authenticateUpgrade(req, { lookup = callerAccess, env = process.env, agentIds = agentIdsOfUser } = {}) {
  const token = tokenFromUpgrade(req);
  if (!token) {
    if (!wsAuthRequired(env)) return { ok: true, access: null };
    return { ok: false, code: 401, message: 'Unauthorized' };
  }
  let decoded;
  try {
    decoded = jwt.verify(token, env.JWT_SECRET);
  } catch {
    return { ok: false, code: 401, message: 'Unauthorized' };
  }
  const userId = decoded && (decoded.userId || decoded.id);
  if (!userId) return { ok: false, code: 401, message: 'Unauthorized' };
  let a;
  try {
    a = await lookup({ user: decoded, headers: { authorization: `Bearer ${token}` } });
  } catch (error) {
    const code = error?.status === 401 ? 401 : error?.status === 403 ? 403 : 503;
    return { ok: false, code, message: code === 503 ? 'Service Unavailable' : code === 403 ? 'Forbidden' : 'Unauthorized' };
  }
  const companyIds = [a.companyId, ...(a.companyIds || [])].filter(Boolean).map(String);
  // Fiches agent liées au compte : la fiche a son PROPRE `_id` (service d'inscription : `agents.insertOne({ userId, … })`), c'est lui le `repId` des évènements.
  let ownAgentIds = [];
  if (a.role === 'agent') {
    try { ownAgentIds = [...(await agentIds(String(a.userId || userId)))]; } catch { ownAgentIds = []; }
  }
  if (a.role !== 'agent' && !a.companyId) return { ok: false, code: 403, message: 'Forbidden' };
  return {
    ok: true,
    access: {
      userId: String(a.userId || userId),
      agentIds: ownAgentIds,
      companyId: a.companyId ? String(a.companyId) : null,
      companyIds: [...new Set(companyIds)],
      role: a.role,
      isOwner: a.isOwner === true,
      exp: typeof decoded.exp === 'number' ? decoded.exp : null,
    },
  };
}

/**
 * Cette connexion peut-elle recevoir cet évènement ?
 *  - connexion héritée sans jeton (`access` null, seulement si ESCROW_WS_AUTH_REQUIRED=false) : oui (ancien comportement) ;
 *  - agent : seulement les évènements portant SON `repId` ;
 *  - titulaire / membre : seulement les évènements portant le `companyId` de SA société ;
 *  - évènement sans `companyId` ni `repId` : personne.
 */
export function canReceive(access, data) {
  if (access === null) return true;
  if (!access || !data) return false;
  const companyId = data.companyId ? String(data.companyId) : '';
  const repId = data.repId ? String(data.repId) : '';
  if (access.role === 'agent') return !!repId && (repId === access.userId || (access.agentIds || []).includes(repId));
  return !!companyId && !!access.companyId && companyId === access.companyId;
}

export function setupEscrowWebSocket(server, options = {}) {
  if (!wsAuthRequired()) {
    console.warn('⚠️ [Escrow WS] ESCROW_WS_AUTH_REQUIRED=false : connexions sans jeton acceptées, flux NON filtré pour elles (transition uniquement)');
  }
  wss = new WebSocketServer({
    server,
    path: '/escrow-updates',
    // Le navigateur exige que le serveur choisisse un des sous-protocoles proposés : on choisit `bearer`, jamais le jeton.
    handleProtocols: (protocols) => {
      for (const p of protocols) if (String(p).toLowerCase() === 'bearer') return p;
      return false;
    },
    verifyClient: (info, done) => {
      authenticateUpgrade(info.req, options)
        .then((result) => {
          if (!result.ok) return done(false, result.code, result.message);
          info.req.escrowAccess = result.access;
          return done(true);
        })
        .catch(() => done(false, 503, 'Service Unavailable'));
    },
  });

  wss.on('connection', (ws, req) => {
    // Objet = appelant vérifié ; null = connexion héritée sans jeton (ESCROW_WS_AUTH_REQUIRED=false) ; undefined = ne reçoit rien.
    ws.escrowAccess = req.escrowAccess;
    const exp = ws.escrowAccess?.exp;
    if (exp) {
      const ms = exp * 1000 - Date.now();
      const timer = setTimeout(() => { try { ws.close(4401, 'Token expired'); } catch { /* ignore */ } }, Math.max(0, Math.min(ms, 2 ** 31 - 1)));
      ws.on('close', () => clearTimeout(timer));
    }
    ws.send(JSON.stringify({ type: 'connected', message: 'Ready for escrow updates' }));
  });
}

/** Envoie l'évènement aux seules connexions autorisées à le recevoir (voir canReceive). @returns {number} connexions servies */
export function broadcastUpdate(data, clients = wss?.clients) {
  if (!clients) {
    console.warn('⚠️ [Escrow WS] WebSocket server not initialized');
    return 0;
  }
  const message = JSON.stringify(data);
  let sent = 0;
  clients.forEach((client) => {
    if (client.readyState !== 1) return; // WebSocket.OPEN
    if (client.escrowAccess === undefined || !canReceive(client.escrowAccess, data)) return;
    client.send(message);
    sent += 1;
  });
  return sent;
}
