import jwt from 'jsonwebtoken';
import { WebSocketServer } from 'ws';
import { tokenFromUpgrade } from './escrowUpdates.js';

/**
 * WebSocket /support-inbox : temps réel de l'Inbox support du tableau de bord admin.
 *
 * Connexion : jeton ADMIN (typeUser 'admin', celui de la connexion au tableau de bord) présenté UNIQUEMENT en sous-protocole :
 * `new WebSocket(url, ['bearer', token])`. Pas de `?token=` (l'URL finit dans les journaux des proxys). Refus à la poignée de
 * main : 401 sans jeton, jeton invalide ou non admin. La connexion est fermée (code 4401) à l'expiration du jeton.
 *
 * Le serveur n'envoie que des signaux sans contenu : { type: 'inbox.changed', waId, reason } (reason : message, handoff, ticket,
 * deleted). Le client relit ensuite les données par les routes HTTP authentifiées /api/whatsapp/admin/*. Un ping toutes les 30 s
 * garde la connexion ouverte derrière les proxys et supprime les connexions mortes.
 */
export const SUPPORT_INBOX_PATH = '/support-inbox';

export function isAdminToken(token, secret = process.env.JWT_SECRET) {
  if (!token || !secret) return null;
  try {
    const decoded = jwt.verify(token, secret);
    return decoded?.typeUser === 'admin' ? decoded : null;
  } catch {
    return null;
  }
}

const pathOf = (req) => String(req.url || '').split('?')[0];

export function setupSupportInboxWebSocket(server, { bus, secret, pingMs = 30000 } = {}) {
  const wss = new WebSocketServer({
    noServer: true,
    // Le navigateur exige que le serveur choisisse un des sous-protocoles proposés : `bearer`, jamais le jeton.
    handleProtocols: (protocols) => {
      for (const p of protocols) if (String(p).toLowerCase() === 'bearer') return p;
      return false;
    },
    verifyClient: (info, done) => {
      const decoded = isAdminToken(tokenFromUpgrade(info.req), secret || process.env.JWT_SECRET);
      if (!decoded) return done(false, 401, 'Unauthorized');
      info.req.inboxAdmin = decoded;
      return done(true);
    },
  });

  server.on('upgrade', (req, socket, head) => {
    if (pathOf(req) !== SUPPORT_INBOX_PATH) return; // les autres chemins sont traités par leurs propres serveurs
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const exp = req.inboxAdmin?.exp;
    if (typeof exp === 'number') {
      const ms = exp * 1000 - Date.now();
      const timer = setTimeout(() => { try { ws.close(4401, 'Token expired'); } catch { /* ignore */ } }, Math.max(0, Math.min(ms, 2 ** 31 - 1)));
      ws.on('close', () => clearTimeout(timer));
    }
    ws.send(JSON.stringify({ type: 'connected' }));
  });

  const onChange = (event) => {
    const message = JSON.stringify({ type: 'inbox.changed', waId: event.waId, reason: event.reason });
    wss.clients.forEach((client) => { if (client.readyState === 1) client.send(message); });
  };
  bus?.on('change', onChange);

  const heartbeat = setInterval(() => {
    wss.clients.forEach((client) => {
      if (client.isAlive === false) return client.terminate();
      client.isAlive = false;
      try { client.ping(); } catch { /* connexion déjà fermée */ }
      return undefined;
    });
  }, pingMs);
  if (heartbeat.unref) heartbeat.unref();

  return {
    wss,
    close() {
      clearInterval(heartbeat);
      bus?.off('change', onChange);
      wss.clients.forEach((c) => c.terminate());
      wss.close();
    },
  };
}
