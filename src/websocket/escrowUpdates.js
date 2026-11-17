import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import { callerAccess, ScopeError } from '../middleware/companyScope.js';
import mongoose from 'mongoose';

let wss;

/**
 * Jeton de la connexion : paramètre `?token=` (un navigateur ne peut pas poser d'en-tête sur un WebSocket) ou sous-protocole
 * `bearer, <jeton>`. Jamais journalisé.
 */
export function tokenOfUpgrade(req) {
  try {
    const url = new URL(req.url || '/', 'http://x');
    const q = url.searchParams.get('token');
    if (q) return q;
  } catch { /* url illisible : pas de jeton */ }
  const proto = String(req.headers?.['sec-websocket-protocol'] || '').split(',').map((s) => s.trim());
  const i = proto.indexOf('bearer');
  return i >= 0 && proto[i + 1] ? proto[i + 1] : '';
}

/**
 * Authentifie la connexion : jeton valide (même secret que `authenticate`), puis société de la personne fournie par le service d'inscription
 * (source de vérité, jamais le navigateur). Échec : { ok:false, status } (401 sans jeton valide, 503 si l'inscription est indisponible : jamais ouvert).
 * `agentIds` : fiches agent (`agents._id`) liées au compte (la fiche a son propre `_id` et un champ `userId` : le `repId` des événements est cet `_id`).
 * @returns {Promise<{ok:true, userId:string, companyIds:string[], agentIds:string[], expiresAt:number}|{ok:false,status:number}>}
 */
export async function authenticateUpgrade(req) {
  const token = tokenOfUpgrade(req);
  if (!token) return { ok: false, status: 401 };
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return { ok: false, status: 401 };
  }
  const userId = decoded && (decoded.userId || decoded.id);
  if (!userId) return { ok: false, status: 401 };
  try {
    const access = await callerAccess({ user: decoded, headers: { authorization: `Bearer ${token}` } });
    // Les événements financiers d'une société ne vont qu'à son propriétaire et à ses membres ; un agent ne reçoit que SES événements.
    const companyIds = access.role === 'agent' ? [] : [access.companyId].filter(Boolean).map(String);
    const expiresAt = decoded.exp ? decoded.exp * 1000 : Date.now() + 60 * 60 * 1000;
    let agentIds = [];
    try {
      const uid = String(userId);
      const forms = [uid, ...(mongoose.Types.ObjectId.isValid(uid) ? [new mongoose.Types.ObjectId(uid)] : [])];
      const rows = await mongoose.connection.db.collection('agents').find({ userId: { $in: forms } }, { projection: { _id: 1 } }).toArray();
      agentIds = (rows || []).map((r) => String(r._id));
    } catch { agentIds = []; }
    return { ok: true, userId: String(userId), companyIds, agentIds, expiresAt };
  } catch (error) {
    return { ok: false, status: error instanceof ScopeError && error.status === 401 ? 401 : 503 };
  }
}

/**
 * Qui reçoit cet événement ? Jamais « tous » : l'événement porte une société (`companyId`) et/ou un agent (`repId`) ; il n'est remis qu'aux
 * clients de cette société ou à cet agent. Un événement sans destinataire identifiable n'est remis à personne.
 */
export function canReceive(client, data) {
  if (!client || !data) return false;
  if (data.companyId && client.companyIds.includes(String(data.companyId))) return true;
  if (data.repId && (client.userId === String(data.repId) || (client.agentIds || []).includes(String(data.repId)))) return true;
  return false;
}

export function setupEscrowWebSocket(server) {
  wss = new WebSocketServer({
    server,
    path: '/escrow-updates',
    // Authentification AVANT l'établissement de la connexion : refus 401 / 503, aucune connexion ouverte.
    verifyClient: (info, done) => {
      authenticateUpgrade(info.req).then((auth) => {
        if (!auth.ok) return done(false, auth.status, auth.status === 401 ? 'Unauthorized' : 'Service Unavailable');
        info.req.escrowAuth = auth;
        // Sous-protocole « bearer » : le serveur doit en accepter un pour que le navigateur finalise la connexion.
        return done(true);
      }).catch(() => done(false, 503, 'Service Unavailable'));
    },
    handleProtocols: (protocols) => (protocols.has('bearer') ? 'bearer' : false),
  });

  wss.on('connection', (ws, req) => {
    ws.escrowAuth = req.escrowAuth;
    console.log('✅ [Escrow WS] Client connected');

    ws.on('close', () => {
      console.log('🔌 [Escrow WS] Client disconnected');
    });

    // Send initial success message
    ws.send(JSON.stringify({ type: 'connected', message: 'Ready for escrow updates' }));
  });
}

export function broadcastUpdate(data) {
  if (!wss) {
    console.warn('⚠️ [Escrow WS] WebSocket server not initialized');
    return;
  }

  const message = JSON.stringify(data);
  const now = Date.now();
  wss.clients.forEach((client) => {
    if (client.readyState !== 1) return; // WebSocket.OPEN
    const auth = client.escrowAuth;
    // Jeton expiré : la connexion est fermée (le front se reconnecte avec son jeton à jour).
    if (!auth || auth.expiresAt <= now) { try { client.close(4401, 'token expired'); } catch { /* ignore */ } return; }
    if (canReceive(auth, data)) client.send(message);
  });
}
