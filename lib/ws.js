// v3 per-match WebSocket server. Mounted at /ws/match/:matchId.
//
// - Auth is optional. If the cs_session cookie resolves to a user, the
//   socket is "auth'd" and receives the full event payload on broadcasts.
//   Anonymous viewers receive a score-only payload.
// - On connect we immediately send a snapshot of current state.
// - Ping/pong every 25s; terminate sockets that don't pong in 60s.
// - Broadcast helper is called from routes/v3_scoring.js after every
//   committed write.

import { WebSocketServer } from 'ws';
import { pool } from '../db.js';
import { getSessionUser, COOKIE_NAME } from '../auth/sessions.js';
import { computeMatchState, scoreOnlyView } from './scoring.js';

const MATCH_PATH_RE = /^\/ws\/match\/([0-9a-f-]{36})\/?(?:\?.*)?$/i;
const PING_EVERY_MS = 25_000;
const STALE_AFTER_MS = 60_000;

// rooms: Map<matchId, Set<WebSocket>>
const rooms = new Map();

function getRoom(matchId) {
  let room = rooms.get(matchId);
  if (!room) { room = new Set(); rooms.set(matchId, room); }
  return room;
}

function readCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq)] = decodeURIComponent(part.slice(eq + 1));
  }
  return out;
}

async function loadStateSnapshot(matchId) {
  const matchRes = await pool.query('SELECT * FROM v3_matches WHERE id = $1', [matchId]);
  if (matchRes.rowCount === 0) return null;
  const match = matchRes.rows[0];
  const evtRes = await pool.query(
    'SELECT * FROM v3_match_events WHERE match_id = $1 ORDER BY seq ASC',
    [matchId]
  );
  const lineupRes = await pool.query(
    `SELECT l.team_id, p.id, p.name, p.batting_order, p.is_wicket_keeper, p.is_captain, p.role
       FROM v3_match_lineups l
       JOIN v3_players p ON p.id = l.player_id
      WHERE l.match_id = $1
      ORDER BY l.team_id, COALESCE(p.batting_order, 9999), p.name`,
    [matchId]
  );
  const rosters = {};
  for (const r of lineupRes.rows) {
    if (!rosters[r.team_id]) rosters[r.team_id] = [];
    rosters[r.team_id].push({
      id: r.id, name: r.name, batting_order: r.batting_order,
      is_wicket_keeper: r.is_wicket_keeper, is_captain: r.is_captain, role: r.role,
    });
  }
  const teamRes = await pool.query(
    `SELECT id, name FROM v3_teams WHERE id IN (
      SELECT team_a_id FROM v3_fixtures WHERE id = $1
      UNION SELECT team_b_id FROM v3_fixtures WHERE id = $1)`,
    [match.fixture_id]
  );
  const teamLookup = {};
  for (const t of teamRes.rows) teamLookup[t.id] = t.name;

  const state = computeMatchState(match, evtRes.rows, rosters);
  return { state, scoreOnly: scoreOnlyView(state, teamLookup), teamLookup };
}

export function createMatchWss(httpServer) {
  const wss = new WebSocketServer({ noServer: true });
  httpServer._matchWss = wss;

  const timer = setInterval(() => {
    const now = Date.now();
    for (const ws of wss.clients) {
      if (ws._lastPong && now - ws._lastPong > STALE_AFTER_MS) {
        try { ws.terminate(); } catch {}
        continue;
      }
      try { ws.ping(); } catch {}
    }
  }, PING_EVERY_MS);
  wss.on('close', () => clearInterval(timer));

  wss.on('connection', async (ws, req, matchId) => {
    ws._lastPong = Date.now();
    ws.on('pong', () => { ws._lastPong = Date.now(); });

    // Cookie-based auth (optional).
    let user = null;
    try {
      const cookies = readCookies(req.headers.cookie);
      const sid = cookies[COOKIE_NAME];
      if (sid) user = await getSessionUser(sid);
    } catch (err) {
      console.error('[ws/match] cookie parse error', err.message);
    }
    ws._user = user;
    ws._matchId = matchId;
    getRoom(matchId).add(ws);

    // Snapshot on connect
    try {
      const snap = await loadStateSnapshot(matchId);
      if (!snap) {
        ws.send(JSON.stringify({ type: 'error', error: 'Match not found' }));
        ws.close();
        return;
      }
      const payload = user
        ? { type: 'snapshot', match_id: matchId, state: snap.state, scoreOnly: snap.scoreOnly }
        : { type: 'snapshot', match_id: matchId, scoreOnly: snap.scoreOnly };
      ws.send(JSON.stringify(payload));
    } catch (err) {
      console.error('[ws/match] snapshot error', err.message);
    }

    ws.on('close', () => {
      const room = rooms.get(matchId);
      if (room) {
        room.delete(ws);
        if (room.size === 0) rooms.delete(matchId);
      }
    });
    ws.on('error', (err) => console.error('[ws/match] socket error', err.message));
  });

  return wss;
}

// Called from routes/v3_scoring.js after any committed write.
// `eventType` is a short tag like 'event_appended', 'event_undone',
// 'setup', 'innings_end', 'match_complete', 'lock_changed'.
export async function broadcastMatchUpdate(matchId, eventType, extra = {}) {
  const room = rooms.get(matchId);
  if (!room || room.size === 0) return;
  let snap = null;
  try {
    snap = await loadStateSnapshot(matchId);
  } catch (err) {
    console.error('[ws/match] broadcast snapshot error', err.message);
    return;
  }
  if (!snap) return;

  for (const ws of room) {
    if (ws.readyState !== 1) continue;
    const payload = ws._user
      ? { type: eventType, match_id: matchId, state: snap.state, scoreOnly: snap.scoreOnly, ...extra }
      : { type: eventType, match_id: matchId, scoreOnly: snap.scoreOnly };
    try { ws.send(JSON.stringify(payload)); } catch {}
  }
}

// Upgrade dispatcher — server.js calls this for /ws/match/* upgrades.
export function handleUpgrade(req, socket, head, wss) {
  const m = MATCH_PATH_RE.exec(req.url || '');
  if (!m) {
    socket.destroy();
    return;
  }
  const matchId = m[1].toLowerCase();
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, matchId);
  });
}

export { MATCH_PATH_RE };
