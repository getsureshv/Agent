# Cricket Scorer Mobile — Cross-Dev Interfaces

> Quick-reference for parallel development. Each dev owns specific files.  
> Do NOT break these contracts — other devs depend on them without coordination.  
> Full detail in `ARCHITECTURE.md §9`.

---

## Overview: Who Depends on Whom

```
Dev 1 (PWA Shell)
  └── imports init() from ALL modules; exports nothing; dispatches app:online/offline events

Dev 2 (Storage/Dexie)
  ├── exports: store.js, matchRepo.js, tournamentRepo.js, engine.js, commands.js
  └── depends on: Dev 4 → appendToOutbox()

Dev 3 (Vendor + Voice)
  ├── exports: createRecognition(), isVoskReady(), downloadVoskModel(), initUmpirePose(), stopUmpirePose()
  └── depends on: Dev 2 → VoiceCommand type

Dev 4 (Backend + Sync)
  ├── exports: appendToOutbox(), startSyncEngine(), forceDrain(), setSyncState()
  └── depends on: Dev 2 → db.outbox table, store.js; Dev 1 → app:online/offline events

Dev 5 (Mobile UI)
  ├── exports: showScreen(), showModal(), hideModal(), updateDisplay()
  └── depends on: Dev 2 → store.js, engine.js; Dev 3 → createRecognition(); Dev 4 → setSyncState()
```

---

## Dev 1 — PWA Shell

**Files:** `manifest.json`, `sw.js`, `icons/`, `src/main.js`, `index.html` (manifest link + SW reg + vendor script tags)

### Dispatches (all other devs listen)
```js
window.dispatchEvent(new Event('app:online'));   // when SW detects network restored
window.dispatchEvent(new Event('app:offline'));  // when SW detects network lost
```

### SW Cache Names (do not collide)
```
'app-shell-v1'        — app JS/CSS/HTML
'vendor-mediapipe-v1' — /vendor/mediapipe/**
'supabase-api-v1'     — Supabase REST GET responses
'vosk-model-v1'       — populated only by user action (Dev 3)
```

### main.js Init Order
```js
import { initDB }          from './storage/db.js';          // Dev 2
import { startSyncEngine } from './sync/syncEngine.js';     // Dev 4
import { initUI }          from './ui/screens.js';          // Dev 5
// call in sequence: await initDB(); startSyncEngine(); initUI();
```

---

## Dev 2 — Storage / Dexie

**Files:** `src/state/store.js`, `src/storage/db.js`, `src/storage/matchRepo.js`, `src/storage/tournamentRepo.js`, `src/scoring/engine.js`, `src/scoring/commands.js`, `src/utils/uuid.js`, `src/utils/format.js`

### `src/state/store.js` — State Singleton
```ts
export let match: MatchState | null;              // read by Dev 5, Dev 4
export let tournament: TournamentState | null;    // read by Dev 5, Dev 4
export let currentFixtureIndex: number;           // read by Dev 5

export function setMatch(m: MatchState): void;
export function setTournament(t: TournamentState): void;
export function clearMatch(): void;
```

### `src/storage/matchRepo.js`
```ts
export async function saveMatch(match: MatchState): Promise<void>;
export async function loadMatch(key: string): Promise<MatchState | null>;
export async function appendMatchEvent(event: MatchEvent): Promise<void>;
export async function getMatchEvents(matchId: string, afterSeq?: number): Promise<MatchEvent[]>;
export async function deleteMatch(key: string): Promise<void>;
```

### `src/storage/tournamentRepo.js`
```ts
export async function saveTournament(t: TournamentState): Promise<void>;
export async function loadTournaments(): Promise<TournamentState[]>;
export async function getTournament(id: string): Promise<TournamentState | null>;
export async function deleteTournament(id: string): Promise<void>;
```

### `src/scoring/engine.js` — called by Dev 5 UI event handlers
```ts
export function scoreRuns(runs: number): void;
export function processExtra(type: 'wide'|'noball'|'bye'|'legbye', additionalRuns: number): void;
export function handleWicket(type: string): void;
export function undoLastBall(): void;
export function swapStrike(): void;
// These mutate store.match and call matchRepo.appendMatchEvent internally.
// After each call, Dev 5 must call updateDisplay().
```

### `src/scoring/commands.js` — called by Dev 3 & Dev 5
```ts
export interface VoiceCommand {
  action: 'runs'|'extra'|'wicket'|'undo'|'swap'|'scorecard'|'change_bowler'|'change_striker'|'change_non_striker';
  runs?: number;
  type?: string;
  additionalRuns?: number;
}
export function parseVoiceCommand(transcript: string): VoiceCommand | null;
export function normalizeTranscript(raw: string): string;
```

### `src/utils/uuid.js`
```ts
export function newUUID(): string;  // crypto.randomUUID() wrapper
```

### `src/utils/format.js`
```ts
export function formatOvers(balls: number): string;   // e.g. "4.3"
export function formatDate(iso: string): string;
```

### Dev 2 STUB requirement for Dev 4's outbox
```ts
// src/sync/outbox.js — Dev 4 must implement; Dev 2 uses this stub until PR 2 lands:
export async function appendToOutbox(entry) { console.log('[outbox stub]', entry); }
```

---

## Dev 3 — Vendor + Voice

**Files:** `vendor/mediapipe/**`, `vendor/vosk/**`, `scripts/download-vendor.sh`, `src/voice/voiceAdapter.js`, `src/voice/voskAdapter.js`, `src/mediapipe/umpirePose.js`

### `src/voice/voiceAdapter.js` — used by Dev 5
```ts
// Drop-in replacement for new webkitSpeechRecognition()
export function createRecognition(): UnifiedRecognizer;

interface UnifiedRecognizer {
  onstart:  (() => void) | null;
  onresult: ((e: SpeechResultEvent) => void) | null;   // e.results[0][0].transcript
  onerror:  ((e: { error: string }) => void) | null;
  onend:    (() => void) | null;
  continuous:      boolean;
  interimResults:  boolean;
  lang:            string;
  maxAlternatives: number;
  start(): Promise<void>;
  stop(): void;
}

// SpeechResultEvent shape (same as webkitSpeechRecognition):
// { results: Array<[{ transcript: string, confidence: number }]> }
// results[0].isFinal: boolean
```

### `src/voice/voiceAdapter.js` — used by Dev 5 settings UI
```ts
export function isVoskReady(): boolean;
export async function downloadVoskModel(
  onProgress: (percent: number) => void
): Promise<void>;
// Throws 'DOWNLOAD_FAILED' or 'ALREADY_DOWNLOADED'
```

### `src/mediapipe/umpirePose.js` — used by Dev 5 umpire cam UI
```ts
export function initUmpirePose(
  videoEl:  HTMLVideoElement,
  canvasEl: HTMLCanvasElement,
  onSignal: (cmd: VoiceCommand) => void   // VoiceCommand from Dev 2
): void;

export function stopUmpirePose(): void;
export function isUmpirePoseActive(): boolean;
```

---

## Dev 4 — Backend + Sync

**Files:** `src/sync/supabaseClient.js`, `src/sync/outbox.js`, `src/sync/syncEngine.js`, `src/ui/syncIndicator.js`, `supabase/migrations/`

### `src/sync/outbox.js` — used by Dev 2
```ts
export interface OutboxEntry {
  entity_type:    'tournament'|'team'|'player'|'match'|'match_event';
  entity_id:      string;
  operation:      'upsert'|'delete';
  payload:        object;
  seq:            number;   // Date.now() for non-events; per-match seq for match_events
}
export async function appendToOutbox(entry: OutboxEntry): Promise<void>;
export async function getPendingCount(): Promise<number>;
```

### `src/sync/syncEngine.js` — called by Dev 1 (main.js)
```ts
export function startSyncEngine(): void;
export async function forceDrain(): Promise<void>;
// Listens for: window 'app:online' (from Dev 1 SW)
// Calls: setSyncState() internally
// Calls: supabaseClient for upserts
```

### `src/ui/syncIndicator.js` — called by Dev 4 internally; used by Dev 5 for manual override
```ts
export type SyncState = 'offline' | 'pending' | 'syncing' | 'synced' | 'error';

export function setSyncState(state: SyncState, pendingCount?: number): void;
// Mutates #sync-status DOM element.
// Dev 5 must add <div id="sync-status" class="sync-status"></div> to index.html header.
```

### Environment Variables (`.env.example`)
```
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_ANON_KEY=<anon-key>
```
Accessed in `supabaseClient.js` via `import.meta.env.VITE_SUPABASE_URL` (or inline constants for no-bundler build).

---

## Dev 5 — Mobile UI

**Files:** `styles.css` (additions), `src/ui/screens.js`, `src/ui/scoring-screen.js`, `src/ui/modals.js`, `src/ui/tournament-ui.js`, `src/ui/scorecard.js`, `src/ui/chat.js`

### `src/ui/screens.js` — used by ALL devs
```ts
export function showScreen(id: string): void;
// Valid ids: 'home-screen'|'tournament-setup-screen'|'team-setup-screen'|
//   'team-players-screen'|'tournament-dashboard-screen'|'setup-screen'|
//   'players-screen'|'scoring-screen'|'result-screen'
```

### `src/ui/modals.js`
```ts
export function showModal(id: string): void;
export function hideModal(id: string): void;
```

### `src/ui/scoring-screen.js`
```ts
// Called after every scoring action by Dev 2's engine.js
export function updateDisplay(): void;
```

### DOM contract for Dev 4's sync icon
```html
<!-- Dev 5 must add this to the <header> / .match-header in index.html -->
<div id="sync-status" class="sync-status" aria-label="Sync status"></div>
```

### Voice wiring pattern (how Dev 5 uses Dev 3's adapter)
```js
// Dev 5 replaces the existing createRecognition() calls:
import { createRecognition } from '../voice/voiceAdapter.js';

const recog = createRecognition();
recog.onstart  = () => { /* show listening UI */ };
recog.onresult = (e) => {
  const transcript = e.results[0][0].transcript;
  // pass to parseVoiceCommand (Dev 2) then engine (Dev 2)
};
recog.onerror  = (e) => { /* show error */ };
recog.onend    = () => { /* hide listening UI */ };
recog.start();
```

---

## Stub Implementations for Day-1 Parallel Start

Each dev can start immediately using these stubs for dependencies not yet landed:

```js
// stubs/outbox.stub.js  (Dev 2 uses until Dev 4 PR lands)
export async function appendToOutbox(e) { console.log('[outbox]', e); }

// stubs/syncIndicator.stub.js  (Dev 5 uses until Dev 4 PR lands)
export function setSyncState(s, n) { console.log('[sync]', s, n); }

// stubs/voiceAdapter.stub.js  (Dev 5 uses until Dev 3 PR lands)
export function createRecognition() {
  const WS = window.SpeechRecognition || window.webkitSpeechRecognition;
  return WS ? new WS() : { start(){}, stop(){}, onstart:null, onresult:null, onerror:null, onend:null };
}
export function isVoskReady() { return false; }
export async function downloadVoskModel() { throw new Error('stub'); }
```
