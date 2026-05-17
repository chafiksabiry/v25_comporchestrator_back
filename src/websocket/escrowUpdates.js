import { WebSocketServer } from 'ws';

let wss;

export function setupEscrowWebSocket(server) {
  wss = new WebSocketServer({
    server,
    path: '/escrow-updates'
  });

  wss.on('connection', (ws) => {
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
  wss.clients.forEach((client) => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(message);
    }
  });
}
