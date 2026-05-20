import { WebSocketServer } from 'ws';

/**
 * In-memory rooms: Map<matchId, Set<WebSocket>>
 * Subscriptions are ephemeral — cleared on server restart.
 * Clients must re-subscribe on reconnect.
 */
const rooms = new Map();

/**
 * Attach the WebSocket server to an existing HTTP server.
 * @param {import('http').Server} httpServer
 * @returns {WebSocketServer}
 */
export function createWss(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  // Heartbeat interval — keeps connections alive and detects stale clients
  const HEARTBEAT_INTERVAL = 30_000;
  const heartbeatTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL);

  wss.on('close', () => clearInterval(heartbeatTimer));

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    console.log('[ws] new connection from', req.socket.remoteAddress);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
        return;
      }

      if (msg.type === 'subscribe' && msg.match_id) {
        // Remove from any previous subscription
        if (ws._subscribedMatch && ws._subscribedMatch !== msg.match_id) {
          rooms.get(ws._subscribedMatch)?.delete(ws);
        }
        if (!rooms.has(msg.match_id)) rooms.set(msg.match_id, new Set());
        rooms.get(msg.match_id).add(ws);
        ws._subscribedMatch = msg.match_id;
        console.log('[ws] subscribed to match', msg.match_id, '— room size:', rooms.get(msg.match_id).size);
        ws.send(JSON.stringify({ type: 'subscribed', match_id: msg.match_id }));
      }

      if (msg.type === 'unsubscribe' && msg.match_id) {
        rooms.get(msg.match_id)?.delete(ws);
        if (ws._subscribedMatch === msg.match_id) ws._subscribedMatch = null;
        console.log('[ws] unsubscribed from match', msg.match_id);
        ws.send(JSON.stringify({ type: 'unsubscribed', match_id: msg.match_id }));
      }
    });

    ws.on('close', () => {
      if (ws._subscribedMatch) {
        rooms.get(ws._subscribedMatch)?.delete(ws);
        console.log('[ws] connection closed, removed from match', ws._subscribedMatch);
      }
    });

    ws.on('error', (err) => {
      console.error('[ws] socket error', err.message);
    });
  });

  console.log('[ws] WebSocket server listening on /ws');
  return wss;
}

/**
 * Broadcast a match event to all subscribers in the match room.
 * Called from routes/matches.js after a successful event insert.
 * @param {string} matchId
 * @param {object} event  — the inserted match_event row
 */
export function broadcast(matchId, event) {
  const sockets = rooms.get(matchId);
  if (!sockets || sockets.size === 0) return;
  const payload = JSON.stringify({ type: 'match_event', match_id: matchId, event });
  for (const s of sockets) {
    if (s.readyState === 1 /* OPEN */) {
      s.send(payload);
    }
  }
}
