# Cricket Scorer Mobile — Full Technical Architecture

> **Repo:** https://github.com/getsureshv/Agent-Mobile  
> **Source baseline:** vanilla JS SPA, ~5 500 LOC (index.html 521, styles.css 1 904, app.js 3 031).  
> **Target:** PWA installable on iOS 16.4+ and Android 9+ via browser. No Capacitor for v1.

---

## 1. Backend Choice & Rationale

**Decision: Supabase (managed Postgres + Realtime + Auth + Storage)**

| # | Reason |
|---|--------|
| 1 | **Zero-ops Postgres.** Row-level SQL is the right model for cricket data (relational: tournaments → teams → players → matches → ball-by-ball events). Firebase's document model forces denormalization that makes aggregate queries (NRR, points table) awkward; Render self-host requires provisioning, migrations, and backups owned by the team. |
| 2 | **Built-in Realtime.** Supabase ships `supabase-js` with a Realtime channel that broadcasts row changes — live scoreboard sharing is a near-term feature. Replicating this on Render requires a separate WebSocket service. |
| 3 | **Row-Level Security (RLS).** RLS lets us enforce "only the match owner can write events" in the database, not in app code. This is the conflict-prevention mechanism for the outbox pattern at zero extra cost. |
| 4 | **Auth included.** Supabase Auth handles email/Google sign-in with JWTs. Firebase Auth is equally good but Firebase's Firestore billing model (per-read) is punishing for ball-by-ball fan views. Render requires a separate auth library. |
| 5 | **User already uses Render for other services.** A Supabase managed tier (free → Pro at $25/mo) keeps the database separate from the user's existing Render workloads, avoids a single point of failure, and offloads database operations. If Supabase is unacceptable, the entire data layer is standard Postgres — migrating to a Render-hosted Postgres later is a drop-in swap since the ORM (Drizzle or raw SQL) is identical. |

---

## 2. Data Model

### 2a. Local (Dexie / IndexedDB) Schema

```js
// src/storage/db.js
import Dexie from 'dexie';

export const db = new Dexie('CricketScorer');

db.version(1).stores({
  // ── Master data (replicated from server) ──────────────────
  users:       '&id, email, display_name, created_at',
  tournaments: '&id, owner_id, name, format, overs_per_innings, players_per_team, squad_size, status, created_at, updated_at, synced_at',
  teams:       '&id, tournament_id, name, created_at, updated_at',
  players:     '&id, team_id, tournament_id, name, jersey_number, created_at, updated_at',

  // ── Live match data ────────────────────────────────────────
  matches:     '&id, tournament_id, team1_id, team2_id, toss_winner_id, toss_decision, overs_limit, players_per_team, status, result_text, winner_id, created_at, updated_at, synced_at',

  // Ball-by-ball: one row per delivery
  match_events: '&id, match_id, innings_number, over_number, ball_in_over, event_type, runs, extra_type, extra_runs, dismissal_type, batsman_id, bowler_id, fielder_id, created_at, seq',

  // ── Sync infrastructure ────────────────────────────────────
  outbox:      '++local_id, entity_type, entity_id, operation, payload, seq, status, created_at, last_attempt_at, attempt_count',
});
```

**Field-level notes:**

- `id` is always a **client-generated UUIDv4** so records can be written offline and later synced without waiting for a server-assigned key.
- `seq` on `match_events` is a per-match monotonically increasing integer (maintained locally in `matches.local_seq`, incremented on each insert). Used for pull-changes ordering.
- `synced_at` is `null` until the record is acknowledged by the server.
- `outbox.status`: `'pending' | 'in_flight' | 'acked' | 'error'`.

---

### 2b. Server (Supabase / Postgres) Schema

```sql
-- ── Users ──────────────────────────────────────────────────
CREATE TABLE users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT UNIQUE NOT NULL,
  display_name TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ── Tournaments ────────────────────────────────────────────
CREATE TABLE tournaments (
  id                UUID PRIMARY KEY,          -- client-generated
  owner_id          UUID REFERENCES users(id) NOT NULL,
  name              TEXT NOT NULL,
  format            TEXT CHECK (format IN ('league','knockout')) NOT NULL,
  overs_per_innings INT  NOT NULL DEFAULT 10,
  players_per_team  INT  NOT NULL DEFAULT 11,
  squad_size        INT  NOT NULL DEFAULT 15,
  status            TEXT CHECK (status IN ('setup','active','completed')) NOT NULL DEFAULT 'setup',
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ── Teams ─────────────────────────────────────────────────
CREATE TABLE teams (
  id            UUID PRIMARY KEY,
  tournament_id UUID REFERENCES tournaments(id) ON DELETE CASCADE NOT NULL,
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Players ───────────────────────────────────────────────
CREATE TABLE players (
  id            UUID PRIMARY KEY,
  team_id       UUID REFERENCES teams(id) ON DELETE CASCADE NOT NULL,
  tournament_id UUID REFERENCES tournaments(id) ON DELETE CASCADE NOT NULL,
  name          TEXT NOT NULL,
  jersey_number INT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Matches ───────────────────────────────────────────────
CREATE TABLE matches (
  id               UUID PRIMARY KEY,
  tournament_id    UUID REFERENCES tournaments(id) ON DELETE CASCADE,   -- NULL for quick match
  team1_id         UUID REFERENCES teams(id),
  team2_id         UUID REFERENCES teams(id),
  toss_winner_id   UUID REFERENCES teams(id),
  toss_decision    TEXT CHECK (toss_decision IN ('bat','bowl')),
  overs_limit      INT NOT NULL DEFAULT 20,
  players_per_team INT NOT NULL DEFAULT 11,
  status           TEXT CHECK (status IN ('setup','in_progress','completed')) NOT NULL DEFAULT 'setup',
  result_text      TEXT,
  winner_id        UUID REFERENCES teams(id),
  owner_id         UUID REFERENCES users(id) NOT NULL,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── Match Events (ball-by-ball) ────────────────────────────
CREATE TABLE match_events (
  id             UUID PRIMARY KEY,
  match_id       UUID REFERENCES matches(id) ON DELETE CASCADE NOT NULL,
  innings_number SMALLINT NOT NULL CHECK (innings_number IN (0,1)),
  over_number    SMALLINT NOT NULL,
  ball_in_over   SMALLINT NOT NULL,
  event_type     TEXT NOT NULL CHECK (event_type IN (
                   'runs','wide','noball','bye','legbye','wicket','innings_end','match_end'
                 )),
  runs           SMALLINT NOT NULL DEFAULT 0,
  extra_type     TEXT,         -- 'wide'|'noball'|'bye'|'legbye'|NULL
  extra_runs     SMALLINT DEFAULT 0,
  dismissal_type TEXT,         -- 'bowled'|'caught'|'lbw'|'run_out'|'stumped'|'hit_wicket'|'retired'
  batsman_id     UUID REFERENCES players(id),
  bowler_id      UUID REFERENCES players(id),
  fielder_id     UUID REFERENCES players(id),
  seq            INT NOT NULL,  -- per-match monotone; used for ordering & conflict detection
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(match_id, seq)
);

CREATE INDEX ON match_events(match_id, seq);

-- ── Outbox (server-side audit; client drives writes) ───────
-- The outbox lives primarily on the CLIENT (Dexie).
-- The server has an events table that IS the truth;
-- the outbox is only a client-side queue.

-- RLS policies (abbreviated)
ALTER TABLE tournaments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE matches      ENABLE ROW LEVEL SECURITY;
ALTER TABLE match_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner can write" ON tournaments
  FOR ALL USING (auth.uid() = owner_id);
CREATE POLICY "owner can write" ON matches
  FOR ALL USING (auth.uid() = owner_id);
CREATE POLICY "owner can write" ON match_events
  FOR ALL USING (
    auth.uid() = (SELECT owner_id FROM matches WHERE id = match_id)
  );
CREATE POLICY "anyone authenticated can read" ON tournaments
  FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "anyone authenticated can read" ON matches
  FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "anyone authenticated can read" ON match_events
  FOR SELECT USING (auth.role() = 'authenticated');
```

---

## 3. Sync Protocol (Outbox Pattern)

### 3a. Event Envelope Shape

Every write to a local entity is also appended to `outbox` with this shape:

```ts
interface OutboxEntry {
  local_id:       number;       // Dexie auto-increment PK
  entity_type:    'tournament' | 'team' | 'player' | 'match' | 'match_event';
  entity_id:      string;       // UUIDv4
  operation:      'upsert' | 'delete';
  payload:        object;       // full entity JSON (not a diff)
  seq:            number;       // global outbox sequence (Date.now() ms + random suffix)
  status:         'pending' | 'in_flight' | 'acked' | 'error';
  created_at:     string;       // ISO-8601
  last_attempt_at: string|null;
  attempt_count:  number;
}
```

**Why full payload (not diff)?** Deltas require ordering guarantees. On a phone that can be offline for hours, replaying a full upsert is safe and idempotent. Postgres `INSERT … ON CONFLICT DO UPDATE` handles it.

### 3b. Sequence Numbers & Conflict Resolution

Strategy: **per-match owner lock** (simpler than vector clocks, appropriate for a single scorer per match).

- Each match has exactly one **owner** (the user who created it, stored in `matches.owner_id`).
- Only the owner can write `match_events`. RLS enforces this server-side.
- Spectators (future) get read-only realtime via Supabase Realtime channels.
- Within a match, events carry a monotone `seq` (`match.local_seq++` on the client). The server rejects any insert where `seq` already exists (UNIQUE constraint on `(match_id, seq)`).
- If a client accidentally duplicates a seq (e.g., network retry), the server returns HTTP 409; the client discards the duplicate and marks the outbox entry `acked`.

**Pull-changes endpoint contract:**

```
GET /rest/v1/match_events
  ?match_id=eq.<uuid>
  &seq=gt.<last_known_seq>
  &order=seq.asc
  (Supabase PostgREST auto-generated; no custom code needed)
```

Response: `application/json` array of `match_event` rows.

For full tournaments:
```
GET /rest/v1/tournaments?id=eq.<uuid>&select=*,teams(*,players(*)),matches(*)
```

### 3c. Retry / Backoff Rules

```
Attempt 1 : immediate
Attempt 2 : 5 s
Attempt 3 : 30 s
Attempt 4 : 5 min
Attempt 5+: 30 min (capped)
```

Implementation: a `SyncEngine` class (Dev 4 owns this) checks navigator.onLine and processes the outbox queue. It batches up to 50 `match_event` upserts per request using Supabase's bulk upsert endpoint. After a successful batch, entries are marked `acked` and can be pruned from Dexie after 7 days.

**Online/offline detection:** `window.addEventListener('online', drain)`. During offline, writes go only to Dexie; the UI shows "pending N" count.

---

## 4. Module Map

**Decision: Split app.js into ES modules for v1.** The file is 3 031 lines with clearly separable concerns. Keeping it monolithic prevents parallel development and makes PWA caching strategies less granular. We will NOT use a bundler for v1 — import maps + native ES modules work in all PWA target browsers (iOS 16.4+, Android Chrome 80+).

### Target File Tree

```
/
├── index.html                  (Dev 1 — minimal changes: add <link rel=manifest>, SW reg, sync icon)
├── styles.css                  (Dev 5 — mobile UI additions; original file kept)
├── manifest.json               (Dev 1)
├── sw.js                       (Dev 1)
│
├── src/
│   ├── main.js                 (Dev 1 — entry point, imports all modules, wires up init)
│   │
│   ├── state/
│   │   └── store.js            (Dev 2 — in-memory match/tournament state, same shape as today)
│   │
│   ├── storage/
│   │   ├── db.js               (Dev 2 — Dexie schema)
│   │   ├── matchRepo.js        (Dev 2 — CRUD for match + match_events in Dexie)
│   │   └── tournamentRepo.js   (Dev 2 — CRUD for tournament, teams, players in Dexie)
│   │
│   ├── sync/
│   │   ├── outbox.js           (Dev 4 — append to outbox, retry logic)
│   │   ├── syncEngine.js       (Dev 4 — drain outbox, pull changes, conflict resolution)
│   │   └── supabaseClient.js   (Dev 4 — Supabase JS client singleton)
│   │
│   ├── voice/
│   │   ├── voiceAdapter.js     (Dev 3 — public API; wraps either webkitSpeechRecognition or Vosk)
│   │   └── voskAdapter.js      (Dev 3 — lazy Vosk-browser loader, partial/final mapping)
│   │
│   ├── mediapipe/
│   │   └── umpirePose.js       (Dev 3 — wraps MediaPipe Pose; uses /vendor/ paths)
│   │
│   ├── scoring/
│   │   ├── engine.js           (Dev 2 — scoreRuns, processExtra, handleWicket, undo, checkOver)
│   │   └── commands.js         (Dev 2 — parseVoiceCommand, normalizeTranscript, wordToNumber)
│   │
│   ├── ui/
│   │   ├── screens.js          (Dev 5 — showScreen, all screen-transition logic)
│   │   ├── scoring-screen.js   (Dev 5 — updateDisplay, renderThisOver, renderLastOver)
│   │   ├── modals.js           (Dev 5 — showModal, hideModal, all modal event listeners)
│   │   ├── tournament-ui.js    (Dev 5 — fixtures list, points table, roster editor)
│   │   ├── scorecard.js        (Dev 5 — scorecard modal content builder)
│   │   ├── chat.js             (Dev 5 — rules chat panel, topic rendering, search)
│   │   └── syncIndicator.js    (Dev 4 — cloud status icon component)
│   │
│   └── utils/
│       ├── uuid.js             (shared — crypto.randomUUID wrapper)
│       └── format.js           (shared — formatOvers, formatDate)
│
├── vendor/
│   ├── mediapipe/
│   │   ├── camera_utils.js
│   │   ├── drawing_utils.js
│   │   └── pose/               (pose.js + WASM/BIN model files)
│   └── vosk/
│       └── (populated by Dev 3 — see §6)
│
└── docs/
    ├── ARCHITECTURE.md         (this file)
    └── INTERFACES.md
```

**Migration plan:** `app.js` stays in the repo root untouched on `main`. Each dev works on a feature branch. When all modules are ready, `index.html` swaps `<script src="app.js">` for `<script type="module" src="src/main.js">` in the integration PR (PR 5).

---

## 5. PWA Spec

### manifest.json

```json
{
  "name": "Cricket Scorer",
  "short_name": "CricketScorer",
  "description": "Ball-by-ball cricket scoring with voice and umpire detection",
  "start_url": "/",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#0d1117",
  "theme_color": "#1a237e",
  "categories": ["sports", "utilities"],
  "icons": [
    { "src": "/icons/icon-48.png",   "sizes": "48x48",   "type": "image/png" },
    { "src": "/icons/icon-72.png",   "sizes": "72x72",   "type": "image/png" },
    { "src": "/icons/icon-96.png",   "sizes": "96x96",   "type": "image/png" },
    { "src": "/icons/icon-144.png",  "sizes": "144x144", "type": "image/png" },
    { "src": "/icons/icon-192.png",  "sizes": "192x192", "type": "image/png", "purpose": "any maskable" },
    { "src": "/icons/icon-512.png",  "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
  ],
  "screenshots": [
    { "src": "/screenshots/scoring.png",    "sizes": "390x844", "type": "image/png", "form_factor": "narrow" },
    { "src": "/screenshots/tournament.png", "sizes": "390x844", "type": "image/png", "form_factor": "narrow" }
  ]
}
```

**Required icon sizes for store-quality install:** 48, 72, 96, 144, 192, 512. The 192 and 512 must also be `maskable` (safe-zone: inner 80% circle).

### Service Worker Caching Strategies (`sw.js`)

```
CACHE NAME              STRATEGY              CONTENTS
─────────────────────── ───────────────────── ──────────────────────────────────────────
app-shell-v1            Cache First           index.html, styles.css, manifest.json, icons/
                                              src/**/*.js (all app modules)
vendor-mediapipe-v1     Cache First           /vendor/mediapipe/**  (immutable after first load)
supabase-api            Network First         https://<project>.supabase.co/rest/v1/**
                        (fallback: cache)     (cache last-known GET responses for offline reads)
vosk-model              NOT cached by SW      40-50 MB model — user-initiated download only
                        (see below)
```

**Vosk model download (user-initiated):**

1. A "Download offline voice" button appears in Settings (disabled if model already cached).
2. On tap: `src/voice/voskAdapter.js` uses the **Cache Storage API** directly (not the SW precache) to download the model into a dedicated `vosk-model-v1` cache:
   ```js
   const cache = await caches.open('vosk-model-v1');
   await cache.add('/vendor/vosk/vosk-model-small-en-us-0.15.tar.gz');
   ```
3. Progress is shown via a `fetch` with `ReadableStream` to display MB downloaded.
4. SW intercepts `/vendor/vosk/**` with a Cache-First strategy **only if** the model cache exists:
   ```js
   // sw.js
   self.addEventListener('fetch', e => {
     if (e.request.url.includes('/vendor/vosk/')) {
       e.respondWith(
         caches.match(e.request).then(r => r || fetch(e.request))
       );
     }
   });
   ```
5. The "Download offline voice" button updates to "Voice: Ready (offline)" once downloaded.

---

## 6. Voice Integration Spec

### Package

```
vosk-browser  version: 0.0.8
npm page: https://www.npmjs.com/package/vosk-browser
CDN/vendor path: /vendor/vosk/vosk.js  (UMD build from node_modules/vosk-browser/dist/vosk.js)
WASM: /vendor/vosk/vosk.wasm
Model (downloaded on demand): /vendor/vosk/vosk-model-small-en-us-0.15/
  — untar'd directory served statically, ~44 MB
```

### Lazy Loading Strategy

```js
// src/voice/voskAdapter.js
let voskReady = false;
let recognizer = null;

export async function ensureVoskLoaded() {
  if (voskReady) return;
  // 1. Load the WASM module (already in vendor cache or fetched fresh)
  const { createModel } = await import('/vendor/vosk/vosk.js');
  // 2. Load model — only if previously downloaded (check cache)
  const cache = await caches.open('vosk-model-v1');
  const modelResp = await cache.match('/vendor/vosk/vosk-model-small-en-us-0.15.tar.gz');
  if (!modelResp) throw new Error('VOSK_MODEL_NOT_DOWNLOADED');
  const model = await createModel(modelResp);
  recognizer = new model.KaldiRecognizer(16000);
  recognizer.setWords(true);
  voskReady = true;
}
```

### Swapping the webkitSpeechRecognition Wrapper (app.js:2423-2428)

The existing code at lines 2423–2434:
```js
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const voiceSupported = !!SpeechRecognition;
function createRecognition() {
  if (!voiceSupported) return null;
  const r = new SpeechRecognition();
  r.continuous = false;
  r.interimResults = false;
  r.lang = 'en-US';
  r.maxAlternatives = 3;
  return r;
}
```

**Replacement in `src/voice/voiceAdapter.js`:**

```js
// src/voice/voiceAdapter.js
import { ensureVoskLoaded, recognizer } from './voskAdapter.js';

const webkitAvailable = !!(window.SpeechRecognition || window.webkitSpeechRecognition);

/**
 * createRecognition() — drop-in replacement.
 * Returns an object with the same callback surface as webkitSpeechRecognition.
 */
export function createRecognition() {
  // If Vosk model is downloaded, prefer it (true offline).
  // Otherwise, fall back to webkitSpeechRecognition.
  return new UnifiedRecognizer();
}

class UnifiedRecognizer {
  constructor() {
    this.onstart  = null;
    this.onresult = null;
    this.onerror  = null;
    this.onend    = null;
    this.continuous      = false;
    this.interimResults  = false;
    this.lang            = 'en-US';
    this.maxAlternatives = 3;
    this._impl = null; // set on start()
  }

  async start() {
    const modelCached = await _isModelCached();

    if (modelCached) {
      this._startVosk();
    } else if (webkitAvailable) {
      this._startWebkit();
    } else {
      this.onerror?.({ error: 'no-speech-engine' });
    }
  }

  stop() { this._impl?.stop?.(); }

  // ── WebKit path ──────────────────────────────────────────
  _startWebkit() {
    const WS = window.SpeechRecognition || window.webkitSpeechRecognition;
    const r = new WS();
    r.continuous      = this.continuous;
    r.interimResults  = this.interimResults;
    r.lang            = this.lang;
    r.maxAlternatives = this.maxAlternatives;
    r.onstart  = () => this.onstart?.();
    // Normalise to the same shape existing code expects:
    // e.results[0][0].transcript
    r.onresult = (e) => this.onresult?.(e);
    r.onerror  = (e) => this.onerror?.(e);
    r.onend    = () => this.onend?.();
    this._impl = r;
    r.start();
  }

  // ── Vosk path ────────────────────────────────────────────
  async _startVosk() {
    try {
      await ensureVoskLoaded();
    } catch (e) {
      // model not downloaded yet → fall back to webkit
      if (webkitAvailable) { this._startWebkit(); return; }
      this.onerror?.({ error: 'vosk-not-ready' }); return;
    }

    this.onstart?.();

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: 16000, channelCount: 1 }
    });
    const ctx  = new AudioContext({ sampleRate: 16000 });
    const src  = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);

    proc.onaudioprocess = (e) => {
      const buf = e.inputBuffer.getChannelData(0);
      // Vosk gives partials (partial) and finals (result)
      if (recognizer.acceptWaveform(buf)) {
        const final = JSON.parse(recognizer.result());
        if (final.text) {
          // Synthesise same shape as webkitSpeechRecognition event
          const synthetic = {
            results: [[{ transcript: final.text, confidence: 1 }]]
          };
          synthetic.results[0].isFinal = true;
          this.onresult?.(synthetic);
          if (!this.continuous) this.stop();
        }
      } else {
        const partial = JSON.parse(recognizer.partialResult());
        // Partials available but existing code uses interimResults=false,
        // so we suppress them unless caller opts in via this.interimResults.
        if (this.interimResults && partial.partial) {
          const synthetic = {
            results: [[{ transcript: partial.partial, confidence: 0 }]]
          };
          synthetic.results[0].isFinal = false;
          this.onresult?.(synthetic);
        }
      }
    };

    src.connect(proc);
    proc.connect(ctx.destination);
    this._impl = {
      stop: () => {
        proc.disconnect(); src.disconnect(); ctx.close();
        stream.getTracks().forEach(t => t.stop());
        this.onend?.();
      }
    };
  }
}

async function _isModelCached() {
  const cache = await caches.open('vosk-model-v1');
  const keys  = await cache.keys();
  return keys.length > 0;
}
```

**No other changes needed to calling code.** The existing `chatVoiceBtn` listener and `voiceScoreBtn` listener both call `createRecognition()` and attach `.onstart / .onresult / .onerror / .onend` — the `UnifiedRecognizer` fulfils that contract exactly.

---

## 7. MediaPipe Self-Hosting

### Files to Download

```bash
# From jsDelivr — exact versions matching the CDN URLs already in index.html
# Target: /vendor/mediapipe/

# camera_utils
curl -L "https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js" \
     -o vendor/mediapipe/camera_utils.js

# drawing_utils
curl -L "https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils/drawing_utils.js" \
     -o vendor/mediapipe/drawing_utils.js

# pose JS + WASM + BIN model files (the pose.js locateFile callback resolves these)
curl -L "https://cdn.jsdelivr.net/npm/@mediapipe/pose/pose.js"     -o vendor/mediapipe/pose/pose.js
curl -L "https://cdn.jsdelivr.net/npm/@mediapipe/pose/pose_solution_packed_assets_loader.js" \
     -o vendor/mediapipe/pose/pose_solution_packed_assets_loader.js
curl -L "https://cdn.jsdelivr.net/npm/@mediapipe/pose/pose_solution_simd_wasm_bin.js" \
     -o vendor/mediapipe/pose/pose_solution_simd_wasm_bin.js
curl -L "https://cdn.jsdelivr.net/npm/@mediapipe/pose/pose_solution_simd_wasm_bin.wasm" \
     -o vendor/mediapipe/pose/pose_solution_simd_wasm_bin.wasm
curl -L "https://cdn.jsdelivr.net/npm/@mediapipe/pose/pose_web.binarypb"  -o vendor/mediapipe/pose/pose_web.binarypb
curl -L "https://cdn.jsdelivr.net/npm/@mediapipe/pose/pose_landmark_heavy.tflite" -o vendor/mediapipe/pose/pose_landmark_heavy.tflite
curl -L "https://cdn.jsdelivr.net/npm/@mediapipe/pose/pose_landmark_full.tflite"  -o vendor/mediapipe/pose/pose_landmark_full.tflite
curl -L "https://cdn.jsdelivr.net/npm/@mediapipe/pose/pose_landmark_lite.tflite"  -o vendor/mediapipe/pose/pose_landmark_lite.tflite
```

A `scripts/download-vendor.sh` script should be committed that runs the above, so any dev can reproduce it.

### index.html Changes

Replace CDN `<script>` tags:
```html
<!-- BEFORE -->
<script src="https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js" crossorigin="anonymous"></script>
<script src="https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils/drawing_utils.js" crossorigin="anonymous"></script>
<script src="https://cdn.jsdelivr.net/npm/@mediapipe/pose/pose.js" crossorigin="anonymous"></script>

<!-- AFTER -->
<script src="/vendor/mediapipe/camera_utils.js"></script>
<script src="/vendor/mediapipe/drawing_utils.js"></script>
<script src="/vendor/mediapipe/pose/pose.js"></script>
```

### app.js (`src/mediapipe/umpirePose.js`) locateFile Change

```js
// BEFORE (app.js:2803-2805)
umpirePose = new Pose({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`
});

// AFTER (src/mediapipe/umpirePose.js)
umpirePose = new Pose({
  locateFile: (file) => `/vendor/mediapipe/pose/${file}`
});
```

The SW caches `/vendor/mediapipe/**` with Cache-First, so MediaPipe works fully offline after first load.

---

## 8. Sync UI — Cloud Status Icon

### States

| State | Icon | Color | Label |
|-------|------|-------|-------|
| `offline` | Cloud with X | `#9e9e9e` | "Offline" |
| `pending` | Cloud with number badge | `#ff9800` | "Pending N" |
| `syncing` | Cloud with spinning arrow | `#42a5f5` | "Syncing…" |
| `synced` | Cloud with checkmark | `#66bb6a` | "Synced" |
| `error` | Cloud with `!` | `#ef5350` | "Sync error" |

### Placement

Insert into `.match-header` in `index.html`, right-aligned:

```html
<div class="match-header">
  <div class="innings-indicator" id="innings-indicator">1st Innings</div>
  <div class="score-display">…</div>
  <div class="run-rate">…</div>
  <!-- NEW: -->
  <div class="sync-status" id="sync-status" title="Sync status">
    <!-- Populated by src/ui/syncIndicator.js -->
  </div>
</div>
```

The component is also visible on the home screen header (always-on), not only during a match.

### Component API (`src/ui/syncIndicator.js`)

```js
export function setSyncState(state, pendingCount = 0) {
  // state: 'offline' | 'pending' | 'syncing' | 'synced' | 'error'
  // Re-renders the #sync-status element
}
```

`SyncEngine` calls `setSyncState` on every state transition.

---

## 9. Work Breakdown for 5 Dev Agents

### Dev 1 — PWA Shell

**Brief:** Owns everything needed to make the app installable and offline-cacheable. Creates `manifest.json`, `sw.js`, and the icon set. Registers the SW in `index.html`. Configures the four caching strategies (app shell, vendor-mediapipe, supabase-api, vosk-model user-initiated). Writes `src/main.js` as the module entry point — it imports from all other devs' modules and wires up app initialization. Does NOT touch scoring logic, storage, or voice internals.

**Files owned:**
- `manifest.json`
- `sw.js`
- `icons/` (all 6 PNG sizes)
- `src/main.js`
- Changes to `index.html`: add `<link rel="manifest">`, SW registration `<script>`, swap CDN MediaPipe for vendor paths, swap `<script src="app.js">` for `<script type="module" src="src/main.js">`.

**Interface contracts:**
- Exports nothing (entry point). Imports `init()` from each module and calls them in order: `storage → sync → voice → ui`.
- SW must expose a `CACHE_VERSION` constant; bump it to invalidate on each release.
- Notifies Dev 4's `SyncEngine` of online/offline via `window.dispatchEvent(new Event('app:online'))` / `app:offline` — Dev 4 listens for these.

---

### Dev 2 — Storage / Dexie

**Brief:** Owns all client-side persistence. Migrates the existing `localStorage` calls in `app.js` to Dexie. Implements the `matchRepo`, `tournamentRepo`, and `store.js` in-memory state layer. Rewrites `saveMatchState`, `loadMatchState`, `clearMatchState`, `saveTournament`, `loadTournaments` (all currently in app.js) to use Dexie. Wraps every Dexie write in an outbox append call (interface provided by Dev 4). Keeps the same public API shape so Dev 5's UI code and Dev 4's sync code can depend on it.

**Files owned:**
- `src/state/store.js`
- `src/storage/db.js`
- `src/storage/matchRepo.js`
- `src/storage/tournamentRepo.js`
- `src/scoring/engine.js`
- `src/scoring/commands.js`
- `src/utils/uuid.js`
- `src/utils/format.js`

**Interface contracts Dev 2 EXPORTS (others depend on these):**

```ts
// store.js
export let match: MatchState | null;
export let tournament: TournamentState | null;
export let currentFixtureIndex: number;
export function setMatch(m: MatchState): void;
export function setTournament(t: TournamentState): void;

// matchRepo.js
export async function saveMatch(match: MatchState): Promise<void>;
export async function loadMatch(key: string): Promise<MatchState | null>;
export async function appendMatchEvent(event: MatchEvent): Promise<void>;
export async function getMatchEvents(matchId: string, afterSeq?: number): Promise<MatchEvent[]>;

// tournamentRepo.js
export async function saveTournament(t: TournamentState): Promise<void>;
export async function loadTournaments(): Promise<TournamentState[]>;
export async function deleteTournament(id: string): Promise<void>;

// engine.js
export function scoreRuns(runs: number): void;
export function processExtra(type: string, additionalRuns: number): void;
export function handleWicket(type: string): void;
export function undoLastBall(): void;
export function checkOverComplete(inn: Innings): void;

// commands.js
export function parseVoiceCommand(transcript: string): VoiceCommand | null;
export function normalizeTranscript(raw: string): string;
```

**Dev 2 DEPENDS ON:**
- `src/sync/outbox.js` → `appendToOutbox(entry)` (Dev 4 must implement this first; use a stub that logs until Dev 4 lands).

---

### Dev 3 — Vendor + Voice

**Brief:** Owns all third-party vendor assets and the voice recognition layer. Downloads MediaPipe files to `/vendor/mediapipe/`, updates the `locateFile` callback. Packages `vosk-browser@0.0.8` into `/vendor/vosk/`. Implements the `UnifiedRecognizer` adapter that wraps both `webkitSpeechRecognition` and Vosk behind the same callback interface. Implements lazy Vosk model loading and the "Download offline voice" user action (progress UI). Extracts umpire pose detection logic into `src/mediapipe/umpirePose.js`.

**Files owned:**
- `vendor/mediapipe/**`
- `vendor/vosk/**`
- `scripts/download-vendor.sh`
- `src/voice/voiceAdapter.js`
- `src/voice/voskAdapter.js`
- `src/mediapipe/umpirePose.js`

**Interface contracts Dev 3 EXPORTS:**

```ts
// voiceAdapter.js
export function createRecognition(): UnifiedRecognizer;
// UnifiedRecognizer has: .onstart, .onresult, .onerror, .onend, .start(), .stop()

// voiceAdapter.js
export function isVoskReady(): boolean;
export async function downloadVoskModel(onProgress: (pct: number) => void): Promise<void>;

// umpirePose.js
export function initUmpirePose(videoEl: HTMLVideoElement, canvasEl: HTMLCanvasElement,
  onSignal: (cmd: VoiceCommand) => void): void;
export function stopUmpirePose(): void;
```

**Dev 3 DEPENDS ON:**
- `src/scoring/commands.js` → `VoiceCommand` type (Dev 2).
- Dev 5 calls `createRecognition()` — Dev 3 must not change the callback signature.

---

### Dev 4 — Backend + Sync

**Brief:** Owns everything that touches the network. Sets up the Supabase project (creates tables, RLS policies, generates the API URL + anon key). Implements `supabaseClient.js`, `outbox.js`, and `syncEngine.js`. Implements the `syncIndicator.js` UI component. Wires up online/offline events from Dev 1's SW. Implements pull-changes on app resume. Writes auth flow (email sign-in, anonymous-first with upgrade prompt after first tournament saved).

**Files owned:**
- `src/sync/supabaseClient.js`
- `src/sync/outbox.js`
- `src/sync/syncEngine.js`
- `src/ui/syncIndicator.js`
- `supabase/migrations/` (SQL files)
- `.env.example` (SUPABASE_URL, SUPABASE_ANON_KEY)

**Interface contracts Dev 4 EXPORTS:**

```ts
// outbox.js
export async function appendToOutbox(entry: Omit<OutboxEntry, 'local_id' | 'status' | 'created_at'>): Promise<void>;

// syncEngine.js
export function startSyncEngine(): void;   // called once in main.js
export function forceDrain(): Promise<void>; // called on app:online event

// syncIndicator.js
export function setSyncState(state: SyncState, pendingCount?: number): void;
type SyncState = 'offline' | 'pending' | 'syncing' | 'synced' | 'error';
```

**Dev 4 DEPENDS ON:**
- `src/storage/db.js` → `db.outbox` table (Dev 2).
- `src/state/store.js` → current match/tournament IDs (Dev 2).
- `window` events `app:online` / `app:offline` (Dev 1).

---

### Dev 5 — Mobile UI

**Brief:** Owns all visual and interaction improvements for mobile. Extracts UI code from `app.js` into the `src/ui/` modules. Adds mobile-specific CSS to `styles.css` (touch target sizing, safe-area insets, landscape/portrait handling). Implements the `syncIndicator` placeholder in the header (the actual logic is Dev 4's). Does NOT refactor scoring engine logic — only event wiring and DOM rendering.

**Files owned:**
- `styles.css` (additions only; original rules preserved)
- `src/ui/screens.js`
- `src/ui/scoring-screen.js`
- `src/ui/modals.js`
- `src/ui/tournament-ui.js`
- `src/ui/scorecard.js`
- `src/ui/chat.js`

**Interface contracts Dev 5 DEPENDS ON:**

```ts
// From Dev 2 (store.js):
import { match, tournament, currentFixtureIndex } from '../state/store.js';

// From Dev 2 (engine.js):
import { scoreRuns, processExtra, handleWicket, undoLastBall } from '../scoring/engine.js';

// From Dev 3 (voiceAdapter.js):
import { createRecognition } from '../voice/voiceAdapter.js';

// From Dev 4 (syncIndicator.js):
import { setSyncState } from './syncIndicator.js';
```

**Dev 5 EXPORTS:**
```ts
// screens.js
export function showScreen(id: string): void;

// modals.js
export function showModal(id: string): void;
export function hideModal(id: string): void;

// scoring-screen.js
export function updateDisplay(): void;
```

---

## 10. Integration Order & Smoke-Test Checklist

### PR Order

```
PR 1: Dev 2 — Storage/Dexie (no UI, runs in tests)
PR 2: Dev 4 — Backend+Sync (depends on PR 1's Dexie outbox table)
PR 3: Dev 3 — Vendor+Voice (independent; no deps on PRs 1-2)
  ↑ PRs 1, 2, 3 can be opened in parallel and reviewed simultaneously
PR 4: Dev 5 — Mobile UI (depends on PR 1 for store/engine imports)
PR 5: Dev 1 — PWA Shell + main.js integration (depends on ALL PRs 1-4 merged)
```

### Smoke Tests After Each PR

**After PR 1 (Storage/Dexie):**
- [ ] Open app; play a 2-over quick match; refresh page; match state is restored from Dexie (not localStorage).
- [ ] Create tournament, add 2 teams, generate fixtures; reload; tournament appears in Saved list.
- [ ] DevTools → Application → IndexedDB: `match_events` table shows ball-by-ball rows.
- [ ] Undo last ball: row removed from `match_events` in Dexie.

**After PR 2 (Backend+Sync):**
- [ ] Sign in with email; create a tournament; Supabase dashboard shows row in `tournaments` table.
- [ ] Score 6 balls offline (disable network in DevTools); `outbox` table in Dexie shows 6 `pending` entries; sync icon shows "Pending 6".
- [ ] Re-enable network; entries drain; Supabase `match_events` table shows 6 rows; sync icon shows "Synced".
- [ ] Open app on second device with same account; tournament is visible (pull-changes working).

**After PR 3 (Vendor+Voice):**
- [ ] Load app with network disabled; no CDN errors in console (MediaPipe loads from `/vendor/`).
- [ ] Umpire Cam opens; skeleton overlay visible on person; Six/Four/Wide signals trigger confirm panel.
- [ ] webkitSpeechRecognition path: tap mic, say "four"; score updates.
- [ ] Download offline voice: progress bar reaches 100%, button changes to "Voice: Ready (offline)".
- [ ] Vosk path (after download): enable airplane mode; tap mic, say "wide"; score updates without network.

**After PR 4 (Mobile UI):**
- [ ] Install PWA on Android (Chrome → "Add to Home Screen"); launches in standalone mode.
- [ ] Install PWA on iOS (Safari → Share → "Add to Home Screen"); launches standalone.
- [ ] Rotate device to landscape; scoring screen reflows correctly.
- [ ] Touch targets: all scoring buttons ≥ 44 × 44 pt; no accidental hits.
- [ ] Scorecard modal scrolls on small screens.

**After PR 5 (PWA Shell — Final Integration):**
- [ ] `lighthouse --preset=pwa` scores ≥ 90 PWA, ≥ 80 Performance, 100 Best Practices.
- [ ] Full offline smoke test: start fresh, enable airplane mode, complete a 5-over match, check scorecards, undo 2 balls — all work.
- [ ] App shell loads within 2 s on throttled 3G (Lighthouse "First Contentful Paint").
- [ ] SW update flow: bump `CACHE_VERSION`; reload app; old cache is deleted; new shell serves correctly.
- [ ] End-to-end: two users, one creates tournament and scores 3 overs offline, goes online; second user sees results in real time via Supabase Realtime.

---

## Appendix: Key Version Pins

| Package | Version | Notes |
|---------|---------|-------|
| `dexie` | `^4.0.7` | Stable v4 with TypeScript types |
| `@supabase/supabase-js` | `^2.45.0` | Realtime v2 included |
| `vosk-browser` | `0.0.8` | Latest stable with WASM support |
| `@mediapipe/pose` | CDN default (`latest`) → pin to `0.5.1675469404` | Exact version from jsDelivr to avoid breakage |
| `@mediapipe/camera_utils` | `0.3.1675466862` | Match pose version |
| `@mediapipe/drawing_utils` | `0.3.1675466124` | Match pose version |
