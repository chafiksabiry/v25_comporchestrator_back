/**
 * Les serveurs WebSocket de l'application (escrow, Inbox support) sont en mode « noServer » : chacun ne traite que son chemin.
 * Ce filet ferme proprement toute autre demande de mise à niveau (comportement d'avant : 400) au lieu de la laisser pendre.
 */
export function setupUpgradeFallback(server, knownPaths) {
  const known = new Set(knownPaths);
  server.on('upgrade', (req, socket) => {
    const path = String(req.url || '').split('?')[0];
    if (known.has(path) || socket.destroyed) return;
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
  });
}
