/**
 * src/scoring/commands.js
 * Command pattern objects: { type, payload, ts, matchId }
 * Consumed by engine.js's applyCommand() and written to the outbox.
 *
 * Also exports voice transcript parsing (extracted from app.js).
 * Dev 3's voiceAdapter and Dev 5's UI call parseVoiceCommand().
 */

// ── Command Constructors ──────────────────────────────────────────────────

/**
 * @typedef {Object} ScoringCommand
 * @property {'SCORE_RUNS'|'PROCESS_EXTRA'|'HANDLE_WICKET'|'UNDO_LAST_BALL'|'SWAP_STRIKE'} type
 * @property {object} payload
 * @property {number} ts       - Date.now() at creation
 * @property {string} matchId  - UUIDv4 of the match
 */

/**
 * Create a SCORE_RUNS command.
 * @param {number} runs
 * @param {string} matchId
 * @returns {ScoringCommand}
 */
export function cmdScoreRuns(runs, matchId) {
  return { type: 'SCORE_RUNS', payload: { runs }, ts: Date.now(), matchId };
}

/**
 * Create a PROCESS_EXTRA command.
 * @param {'wide'|'noball'|'bye'|'legbye'} extraType
 * @param {number} additionalRuns
 * @param {string} matchId
 * @returns {ScoringCommand}
 */
export function cmdProcessExtra(extraType, additionalRuns, matchId) {
  return { type: 'PROCESS_EXTRA', payload: { extraType, additionalRuns }, ts: Date.now(), matchId };
}

/**
 * Create a HANDLE_WICKET command.
 * @param {string} dismissalType
 * @param {string} matchId
 * @returns {ScoringCommand}
 */
export function cmdHandleWicket(dismissalType, matchId) {
  return { type: 'HANDLE_WICKET', payload: { dismissalType }, ts: Date.now(), matchId };
}

/**
 * Create an UNDO_LAST_BALL command.
 * @param {string} matchId
 * @returns {ScoringCommand}
 */
export function cmdUndoLastBall(matchId) {
  return { type: 'UNDO_LAST_BALL', payload: {}, ts: Date.now(), matchId };
}

/**
 * Create a SWAP_STRIKE command.
 * @param {string} matchId
 * @returns {ScoringCommand}
 */
export function cmdSwapStrike(matchId) {
  return { type: 'SWAP_STRIKE', payload: {}, ts: Date.now(), matchId };
}

// ── VoiceCommand Type ─────────────────────────────────────────────────────

/**
 * @typedef {Object} VoiceCommand
 * @property {'runs'|'extra'|'wicket'|'undo'|'swap'|'scorecard'|'change_bowler'|'change_striker'|'change_non_striker'} action
 * @property {number}  [runs]
 * @property {string}  [type]
 * @property {number}  [additionalRuns]
 */

// ── Word-to-number map (extracted from app.js) ────────────────────────────

const wordToNumber = {
  zero: 0, oh: 0, dot: 0, 'no run': 0, 'no runs': 0, 'dot ball': 0, nought: 0, nothing: 0,
  one: 1, single: 1, 'a run': 1, 'one run': 1,
  two: 2, double: 2, couple: 2, 'two runs': 2,
  three: 3, triple: 3, 'three runs': 3,
  four: 4, boundary: 4, 'four runs': 4,
  five: 5, 'five runs': 5,
  six: 6, sixer: 6, maximum: 6, 'six runs': 6, 'over the fence': 6, 'out of the park': 6,
};

// ── Transcript normalization (extracted from app.js) ─────────────────────

/**
 * normalizeTranscript(raw)
 * Fix common speech-to-text mishearings of cricket terms.
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeTranscript(raw) {
  return raw
    // Wicket/dismissal terms
    .replace(/\bwicked\b/g, 'wicket')
    .replace(/\bcourt\b/g, 'caught')
    .replace(/\bcot\b/g, 'caught')
    .replace(/\bcut\b/g, 'caught')
    .replace(/\bcaught it\b/g, 'caught')
    .replace(/\bbold\b/g, 'bowled')
    .replace(/\bbolt\b/g, 'bowled')
    .replace(/\bbow?led?\b/g, 'bowled')
    .replace(/\bstomped\b/g, 'stumped')
    .replace(/\bstumps\b/g, 'stumped')
    .replace(/\brun now\b/g, 'run out')
    .replace(/\bran out\b/g, 'run out')
    // Extras
    .replace(/\bwild\b/g, 'wide')
    .replace(/\bwhy\b/g, 'wide')
    .replace(/\bnoble\b/g, 'no ball')
    .replace(/\bno bull\b/g, 'no ball')
    .replace(/\bleg buy\b/g, 'leg bye')
    // Runs — standalone homophones only
    .replace(/\bwon\b/g, 'one')
    .replace(/\btoo\b/g, 'two')
    .replace(/\btree\b/g, 'three')
    .replace(/\bfor\b/g, 'four')
    .replace(/\bsex\b/g, 'six')
    .replace(/\bsick\b/g, 'six')
    // Misc
    .replace(/\band do\b/g, 'undo')
    .replace(/\bswat\b/g, 'swap');
}

// ── Voice Command Parser (extracted from app.js) ──────────────────────────

/**
 * extractExtraRuns(t) — private helper
 */
function extractExtraRuns(t) {
  for (const [word, num] of Object.entries(wordToNumber)) {
    if (word !== 'dot' && word !== 'dot ball' && t.includes(word)) return num;
  }
  const m = t.match(/\b([0-4])\b/);
  return m ? parseInt(m[1]) : 0;
}

/**
 * parseVoiceCommand(transcript)
 * Parse a raw speech transcript into a VoiceCommand object.
 * Returns null if the transcript is unrecognised.
 *
 * @param {string} transcript
 * @returns {VoiceCommand | null}
 */
export function parseVoiceCommand(transcript) {
  const t = normalizeTranscript(transcript.toLowerCase().trim())
    .replace(/[.,!?;:'"]+/g, '')   // strip punctuation
    .replace(/\s+/g, ' ');          // normalise whitespace

  // Change bowler
  if (/\b(change|switch|new)\s*(the\s+|to\s+|a\s+)?bowler\b/.test(t)) return { action: 'change_bowler' };

  // Change batsman / striker / non-striker
  if (/\b(change|switch|new|replace)\s*(the\s+|to\s+|a\s+)?(striker|batsman|batter|batman)\b/.test(t)) return { action: 'change_striker' };
  if (/\b(change|switch|new|replace)\s*(the\s+|to\s+|a\s+)?non[- ]?striker\b/.test(t)) return { action: 'change_non_striker' };

  // Scorecard
  if (/\b(scorecard|score\s*card|score\s*board|scoreboard|show\s*score|view\s*score)\b/.test(t)) return { action: 'scorecard' };

  // Wicket
  if (/\b(wicket|out|bowled|dismiss(ed)?|gone|got\s*him)\b/.test(t)) {
    if (/\bcaught\b/.test(t) || /\bcatch\b/.test(t)) return { action: 'wicket', type: 'caught' };
    if (/\blbw\b/.test(t) || /\bleg\s*before\b/.test(t)) return { action: 'wicket', type: 'lbw' };
    if (/\brun\s*out\b/.test(t)) return { action: 'wicket', type: 'run_out' };
    if (/\bstump(ed|ing)?\b/.test(t)) return { action: 'wicket', type: 'stumped' };
    if (/\bhit\s*wicket\b/.test(t)) return { action: 'wicket', type: 'hit_wicket' };
    if (/\bretire[d]?\b/.test(t)) return { action: 'wicket', type: 'retired' };
    if (/\bbowled\b/.test(t) || /\bclean\s*bowled\b/.test(t)) return { action: 'wicket', type: 'bowled' };
    return { action: 'wicket', type: 'bowled' };
  }

  // Extras
  if (/\bwide\b/.test(t)) return { action: 'extra', type: 'wide', additionalRuns: extractExtraRuns(t) };
  if (/\bno\s*ball\b/.test(t) || /\bfree\s*hit\b/.test(t)) return { action: 'extra', type: 'noball', additionalRuns: extractExtraRuns(t) };
  if (/\bleg\s*bye\b/.test(t) || /\bleg\s*by\b/.test(t)) return { action: 'extra', type: 'legbye', additionalRuns: extractExtraRuns(t) };
  if (/\bbye\b/.test(t) && !/\bgood\s*bye\b/.test(t) && !/\bbye\s*bye\b/.test(t)) return { action: 'extra', type: 'bye', additionalRuns: extractExtraRuns(t) };

  // Undo
  if (/\bundo\b/.test(t) || /\bgo\s*back\b/.test(t) || /\brevert\b/.test(t) || /\bcancel\s*last\b/.test(t)) return { action: 'undo' };

  // Swap
  if (/\bswap\b/.test(t) || /\bswitch\s*(the\s+)?(ends|strike|batsmen|batsman|strikers)\b/.test(t) || /\brotate\s*strike\b/.test(t)) return { action: 'swap' };

  // Runs — word names first
  for (const [word, num] of Object.entries(wordToNumber)) {
    if (t === word || new RegExp(`\\b${word}\\b`).test(t)) return { action: 'runs', runs: num };
  }

  // Runs — digit
  const digitMatch = t.match(/\b([0-6])\b/);
  if (digitMatch) return { action: 'runs', runs: parseInt(digitMatch[1]) };

  return null;
}
