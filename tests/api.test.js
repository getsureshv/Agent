/**
 * Cricket Scorer API — Smoke Tests
 *
 * These are documented curl commands covering all smoke-test cases from
 * docs/ARCHITECTURE_V2.md §11.
 *
 * To run against a local server:
 *   docker run -d --name pg-cric -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:16
 *   DATABASE_URL=postgres://postgres:dev@localhost:5432/postgres npm start &
 *   node tests/api.test.js
 *
 * Or run the curl commands manually (substitute TOKEN/MATCH_ID/TOURNAMENT_ID as shown).
 */

import http from 'node:http';

const BASE = process.env.BASE_URL || 'http://localhost:3000';

async function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };

    const clientReq = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    clientReq.on('error', reject);
    if (bodyStr) clientReq.write(bodyStr);
    clientReq.end();
  });
}

function uuid() {
  // Simple UUIDv4 generator
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  PASS: ${message}`);
}

async function runTests() {
  console.log(`\n=== Cricket Scorer API Smoke Tests ===`);
  console.log(`Base URL: ${BASE}\n`);

  // Test 1: Health check
  console.log('Test 1: GET /api/health');
  const health = await req('GET', '/api/health');
  assert(health.status === 200, `health returns 200 (got ${health.status})`);
  assert(health.body.ok === true, 'health.ok is true');
  assert(health.body.db === 'connected', 'health.db is connected');
  console.log('  →', health.body);

  // Test 2: Register device
  console.log('\nTest 2: POST /api/devices/register');
  const reg = await req('POST', '/api/devices/register', { label: 'Test Device' });
  assert(reg.status === 201, `register returns 201 (got ${reg.status})`);
  assert(typeof reg.body.token === 'string', 'register returns a token string');
  const token = reg.body.token;
  console.log('  → token:', token);

  // Test 2b: Register a second device (non-owner tests)
  const reg2 = await req('POST', '/api/devices/register', { label: 'Other Device' });
  const token2 = reg2.body.token;

  // Test 3: POST /api/tournaments with Bearer
  console.log('\nTest 3: POST /api/tournaments');
  const tournId = uuid();
  const tournResp = await req('POST', '/api/tournaments', {
    id: tournId,
    name: 'Test Cup 2024',
    format: 'league',
    overs_per_innings: 20,
    players_per_team: 11,
    squad_size: 15,
  }, token);
  assert(tournResp.status === 200, `tournament upsert returns 200 (got ${tournResp.status})`);
  assert(tournResp.body.id === tournId, 'returned tournament has correct id');
  console.log('  → tournament:', tournResp.body.id, tournResp.body.name);

  // GET /api/tournaments
  const tournaments = await req('GET', '/api/tournaments', null, token);
  assert(tournaments.status === 200, 'GET /api/tournaments returns 200');
  assert(Array.isArray(tournaments.body), 'tournaments is an array');
  assert(tournaments.body.some(t => t.id === tournId), 'newly created tournament in list');

  // Test 4: POST /api/matches
  console.log('\nTest 4: POST /api/matches');
  const matchId = uuid();
  const matchResp = await req('POST', '/api/matches', {
    id: matchId,
    overs_limit: 20,
    players_per_team: 11,
    status: 'setup',
  }, token);
  assert(matchResp.status === 200, `match upsert returns 200 (got ${matchResp.status})`);
  assert(matchResp.body.id === matchId, 'returned match has correct id');
  assert(matchResp.body.owner_token === token, 'match owner_token matches device token');
  console.log('  → match:', matchResp.body.id, 'owner:', matchResp.body.owner_token);

  // Test 5: POST /api/matches/:id/events — 10 events
  console.log('\nTest 5: POST /api/matches/:id/events (10 new events)');
  const events = Array.from({ length: 10 }, (_, i) => ({
    id: uuid(),
    match_id: matchId,
    innings_number: 0,
    over_number: Math.floor(i / 6),
    ball_in_over: i % 6,
    event_type: 'runs',
    runs: i % 7,
    seq: i + 1,
  }));
  const evResp = await req('POST', `/api/matches/${matchId}/events`, events, token);
  assert(evResp.status === 200, `events insert returns 200 (got ${evResp.status}): ${JSON.stringify(evResp.body)}`);
  assert(evResp.body.inserted === 10, `inserted 10 (got ${evResp.body.inserted})`);
  assert(evResp.body.skipped === 0, `skipped 0 (got ${evResp.body.skipped})`);
  console.log('  →', evResp.body);

  // Test 6: Repeat same events — idempotency
  console.log('\nTest 6: POST same events again (idempotency)');
  const evResp2 = await req('POST', `/api/matches/${matchId}/events`, events, token);
  assert(evResp2.status === 409, `duplicate batch returns 409 (got ${evResp2.status})`);
  assert(evResp2.body.inserted === 0, `inserted 0 (got ${evResp2.body.inserted})`);
  assert(evResp2.body.skipped === 10, `skipped 10 (got ${evResp2.body.skipped})`);
  console.log('  →', evResp2.body);

  // Test 9: Non-owner device tries to post events → 403
  console.log('\nTest 9: Non-owner POST /api/matches/:id/events → 403');
  const forbiddenResp = await req('POST', `/api/matches/${matchId}/events`, [{
    id: uuid(),
    innings_number: 0,
    over_number: 2,
    ball_in_over: 0,
    event_type: 'runs',
    runs: 1,
    seq: 100,
  }], token2);
  assert(forbiddenResp.status === 403, `non-owner gets 403 (got ${forbiddenResp.status})`);
  console.log('  →', forbiddenResp.body);

  // Test 10: GET /api/matches/:id/events?since_seq=5
  console.log('\nTest 10: GET /api/matches/:id/events?since_seq=5');
  const getEvResp = await req('GET', `/api/matches/${matchId}/events?since_seq=5`, null, token);
  assert(getEvResp.status === 200, `GET events returns 200 (got ${getEvResp.status})`);
  assert(Array.isArray(getEvResp.body), 'events is an array');
  assert(getEvResp.body.every(e => e.seq > 5), 'all events have seq > 5');
  assert(getEvResp.body.length === 5, `returned 5 events (got ${getEvResp.body.length})`);
  console.log(`  → returned ${getEvResp.body.length} events with seq > 5`);

  // Test: Static file serving
  console.log('\nTest: GET / serves index.html');
  const staticResp = await new Promise((resolve) => {
    const r = http.get(`${BASE}/`, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, contentType: res.headers['content-type'], body: data }));
    });
    r.on('error', (e) => resolve({ status: 0, error: e.message }));
  });
  assert(staticResp.status === 200, `GET / returns 200 (got ${staticResp.status})`);
  assert(staticResp.body.includes('<!DOCTYPE html') || staticResp.body.includes('<html'), 'GET / returns HTML');
  console.log('  → static serving works');

  // Test: 401 for missing token
  console.log('\nTest: GET /api/tournaments without auth → 401');
  const unauthedResp = await req('GET', '/api/tournaments');
  assert(unauthedResp.status === 401, `no-auth returns 401 (got ${unauthedResp.status})`);
  console.log('  →', unauthedResp.body);

  console.log('\n=== All tests passed ===\n');
}

runTests().catch((err) => {
  console.error('\n=== TEST FAILED ===\n', err.message);
  process.exit(1);
});

/*
 * ─── Manual curl equivalents ──────────────────────────────────────────────────
 *
 * # 1. Health check
 * curl localhost:3000/api/health
 *
 * # 2. Register device
 * TOKEN=$(curl -s -X POST localhost:3000/api/devices/register \
 *   -H "Content-Type: application/json" \
 *   -d '{"label":"dev"}' | jq -r .token)
 *
 * # 3. Create tournament
 * curl -s -X POST localhost:3000/api/tournaments \
 *   -H "Authorization: Bearer $TOKEN" \
 *   -H "Content-Type: application/json" \
 *   -d '{"id":"<uuidv4>","name":"Cup","format":"league"}' | jq .
 *
 * # 4. Create match
 * MATCH_ID=$(uuidgen)
 * curl -s -X POST localhost:3000/api/matches \
 *   -H "Authorization: Bearer $TOKEN" \
 *   -H "Content-Type: application/json" \
 *   -d "{\"id\":\"$MATCH_ID\",\"overs_limit\":20,\"status\":\"setup\"}" | jq .
 *
 * # 5. Post 1 event
 * curl -s -X POST localhost:3000/api/matches/$MATCH_ID/events \
 *   -H "Authorization: Bearer $TOKEN" \
 *   -H "Content-Type: application/json" \
 *   -d '[{"id":"<uuid>","innings_number":0,"over_number":0,"ball_in_over":0,"event_type":"runs","runs":4,"seq":1}]' | jq .
 *
 * # 6. WebSocket test (requires wscat: npm i -g wscat)
 * wscat -c ws://localhost:3000/ws
 * > {"type":"subscribe","match_id":"$MATCH_ID"}
 *
 * # 7. Admin wipe (if ADMIN_PASSWORD=secret)
 * curl -s -X DELETE http://admin:secret@localhost:3000/admin/wipe | jq .
 */
