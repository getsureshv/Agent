/**
 * src/scoring/engine.js
 * PURE scoring functions — given (state, command) return new state.
 * NO DOM access, NO side effects, NO storage calls.
 *
 * These functions are called by Dev 5's UI event handlers.
 * After each call, Dev 5 must call updateDisplay().
 *
 * state shape mirrors app.js match/innings objects so that integration
 * with the existing UI is a drop-in swap.
 *
 * Exported functions operate on the in-memory store (store.js) and
 * trigger matchRepo.saveMatch() / appendMatchEvent() after each mutation.
 *
 * ARCHITECTURE NOTE: The engine functions are "pure" in the sense that
 * they contain no DOM, no fetch, and no global side effects — they only
 * mutate the state object passed in (returning the mutated object), and
 * optionally call the storage callbacks injected via init().
 */

import { match as storeMatch, setMatch } from '../state/store.js';
import { saveMatch, appendMatchEvent } from '../storage/matchRepo.js';
import { newUUID } from '../utils/uuid.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Return the currently active innings from the store. */
function currentInnings() {
  return storeMatch.innings[storeMatch.currentInnings];
}

/** Deep-clone an innings snapshot for undo history. */
function snapshot(inn) {
  return JSON.parse(JSON.stringify({
    totalRuns:           inn.totalRuns,
    totalWickets:        inn.totalWickets,
    totalBalls:          inn.totalBalls,
    extras:              { ...inn.extras },
    strikerIndex:        inn.strikerIndex,
    nonStrikerIndex:     inn.nonStrikerIndex,
    currentBowlerIndex:  inn.currentBowlerIndex,
    thisOver:            [...inn.thisOver],
    lastOver:            [...inn.lastOver],
    lastOverRuns:        inn.lastOverRuns,
    batsmen:             inn.batsmen.map(b => ({ ...b, ballHistory: [...b.ballHistory] })),
    bowlers:             inn.bowlers.map(b => ({
      ...b,
      overHistory:      b.overHistory.map(o => ({ balls: [...o.balls], runs: o.runs })),
      currentOverBalls: [...b.currentOverBalls],
    })),
  }));
}

function addBallToOver(inn, bowler, ball) {
  inn.thisOver.push(ball);
  bowler.currentOverBalls.push(ball);
}

function _swapStrike(inn) {
  const tmp         = inn.strikerIndex;
  inn.strikerIndex  = inn.nonStrikerIndex;
  inn.nonStrikerIndex = tmp;
}

/**
 * Build a BallEvent record for the match_events table.
 */
function buildEvent(eventType, opts = {}) {
  const inn = currentInnings();
  return {
    id:             newUUID(),
    match_id:       storeMatch.id,
    innings_number: storeMatch.currentInnings,
    over_number:    Math.floor(inn.totalBalls / 6),
    ball_in_over:   inn.totalBalls % 6,
    event_type:     eventType,
    runs:           opts.runs          ?? 0,
    extra_type:     opts.extra_type    ?? null,
    extra_runs:     opts.extra_runs    ?? 0,
    dismissal_type: opts.dismissal_type ?? null,
    batsman_id:     opts.batsman_id    ?? null,
    bowler_id:      opts.bowler_id     ?? null,
    fielder_id:     opts.fielder_id    ?? null,
    created_at:     new Date().toISOString(),
    seq:            0, // overwritten by appendMatchEvent
  };
}

async function _persist() {
  if (!storeMatch?.id) return;
  setMatch(storeMatch);
  await saveMatch(storeMatch).catch(err => console.warn('[engine] saveMatch failed', err));
}

async function _persistWithEvent(event) {
  if (!storeMatch?.id) return;
  setMatch(storeMatch);
  await Promise.all([
    saveMatch(storeMatch).catch(err => console.warn('[engine] saveMatch failed', err)),
    appendMatchEvent(event).catch(err => console.warn('[engine] appendMatchEvent failed', err)),
  ]);
}

// ── checkOverComplete (exported for use in tests / UI) ──────────────────────

/**
 * checkOverComplete(inn)
 * Detects over boundary and resets bowler/over state.
 * Swaps strike at end of over.
 * Called internally by scoreRuns, processExtra, handleWicket.
 *
 * This is NOT pure (mutates inn in place) but has no I/O side effects.
 *
 * @param {object} inn - innings object
 * @returns {boolean} - true if the over just completed
 */
export function checkOverComplete(inn) {
  if (inn.totalBalls > 0 && inn.totalBalls % 6 === 0) {
    const bowler = inn.bowlers[inn.currentBowlerIndex];
    if (bowler) {
      bowler.overs += 1;
      bowler.ballsInOver = 0;
      if (bowler.runsThisOver === 0) bowler.maidens += 1;
      inn.lastOver     = [...inn.thisOver];
      inn.lastOverRuns = bowler.runsThisOver;
      bowler.overHistory.push({ balls: [...bowler.currentOverBalls], runs: bowler.runsThisOver });
      bowler.currentOverBalls = [];
      bowler.runsThisOver = 0;
    }
    inn.thisOver = [];
    _swapStrike(inn);
    return true;
  } else if (inn.currentBowlerIndex >= 0) {
    inn.bowlers[inn.currentBowlerIndex].ballsInOver = inn.totalBalls % 6;
  }
  return false;
}

// ── Public scoring API ──────────────────────────────────────────────────────

/**
 * scoreRuns(runs)
 * Award runs to the striker and update innings totals.
 * Mutates storeMatch in place, persists to Dexie, appends match_event.
 *
 * @param {number} runs  0-6
 */
export async function scoreRuns(runs) {
  if (isNaN(runs)) return;
  const inn     = currentInnings();
  const striker = inn.batsmen[inn.strikerIndex];
  const bowler  = inn.bowlers[inn.currentBowlerIndex];

  inn.history.push(snapshot(inn));

  striker.runs   += runs;
  striker.balls  += 1;
  if (runs === 4) striker.fours++;
  if (runs === 6) striker.sixes++;

  inn.totalRuns  += runs;
  inn.totalBalls += 1;
  bowler.runs    += runs;
  bowler.runsThisOver += runs;

  let chipClass = 'ball-dot';
  if (runs === 4) chipClass = 'ball-four';
  else if (runs === 6) chipClass = 'ball-six';
  else if (runs > 0)  chipClass = 'ball-run';

  const ball = { label: String(runs), chipClass };
  addBallToOver(inn, bowler, ball);
  striker.ballHistory.push(ball);

  if (runs % 2 === 1) _swapStrike(inn);
  checkOverComplete(inn);

  const event = buildEvent('runs', { runs });
  await _persistWithEvent(event);
}

/**
 * processExtra(type, additionalRuns)
 * Record a wide, no-ball, bye, or leg bye.
 *
 * @param {'wide'|'noball'|'bye'|'legbye'} type
 * @param {number} additionalRuns
 */
export async function processExtra(type, additionalRuns) {
  if (isNaN(additionalRuns)) return;
  const inn     = currentInnings();
  const bowler  = inn.bowlers[inn.currentBowlerIndex];
  const striker = inn.batsmen[inn.strikerIndex];

  inn.history.push(snapshot(inn));

  let eventRuns  = 0;
  let extraRuns  = 0;

  if (type === 'wide') {
    const total = 1 + additionalRuns;
    inn.totalRuns    += total;
    inn.extras.wides += total;
    bowler.runs      += total;
    bowler.runsThisOver += total;
    addBallToOver(inn, bowler, { label: `Wd+${additionalRuns}`, chipClass: 'ball-wide' });
    if (additionalRuns % 2 === 1) _swapStrike(inn);
    extraRuns = total;
    // Wide does NOT count as a legal delivery (no totalBalls increment)

  } else if (type === 'noball') {
    const total = 1 + additionalRuns;
    inn.totalRuns      += total;
    inn.extras.noBalls += total;
    bowler.runs        += total;
    bowler.runsThisOver += total;
    if (additionalRuns > 0) {
      striker.runs += additionalRuns;
      if (additionalRuns === 4) striker.fours++;
      if (additionalRuns === 6) striker.sixes++;
    }
    const nbBall = { label: `NB+${additionalRuns}`, chipClass: 'ball-noball' };
    addBallToOver(inn, bowler, nbBall);
    striker.ballHistory.push(nbBall);
    if (additionalRuns % 2 === 1) _swapStrike(inn);
    extraRuns = total;
    eventRuns = additionalRuns;
    // No ball does NOT count as a legal delivery

  } else if (type === 'bye') {
    inn.totalRuns    += additionalRuns;
    inn.extras.byes  += additionalRuns;
    inn.totalBalls   += 1;
    striker.balls    += 1;
    bowler.runsThisOver += 0;
    const byeBall = { label: `B${additionalRuns}`, chipClass: 'ball-bye' };
    addBallToOver(inn, bowler, byeBall);
    striker.ballHistory.push(byeBall);
    if (additionalRuns % 2 === 1) _swapStrike(inn);
    checkOverComplete(inn);
    extraRuns = additionalRuns;

  } else if (type === 'legbye') {
    inn.totalRuns      += additionalRuns;
    inn.extras.legByes += additionalRuns;
    inn.totalBalls     += 1;
    striker.balls      += 1;
    bowler.runsThisOver += 0;
    const lbBall = { label: `LB${additionalRuns}`, chipClass: 'ball-legbye' };
    addBallToOver(inn, bowler, lbBall);
    striker.ballHistory.push(lbBall);
    if (additionalRuns % 2 === 1) _swapStrike(inn);
    checkOverComplete(inn);
    extraRuns = additionalRuns;
  }

  const event = buildEvent('wide', {
    extra_type: type,
    extra_runs: extraRuns,
    runs:       eventRuns,
  });
  // Correct event_type for non-wide extras
  const typeMap = { wide: 'wide', noball: 'noball', bye: 'bye', legbye: 'legbye' };
  event.event_type = typeMap[type] ?? 'wide';

  await _persistWithEvent(event);
}

/**
 * handleWicket(type)
 * Dismiss the striker. Increments wicket count, updates bowler (if credited).
 *
 * @param {string} type - 'bowled'|'caught'|'lbw'|'run_out'|'stumped'|'hit_wicket'|'retired'
 */
export async function handleWicket(type) {
  const inn     = currentInnings();
  const striker = inn.batsmen[inn.strikerIndex];
  const bowler  = inn.bowlers[inn.currentBowlerIndex];

  inn.history.push(snapshot(inn));

  striker.isOut    = true;
  striker.dismissal = _formatDismissal(type, bowler?.name ?? '');
  striker.balls    += 1;
  inn.totalWickets += 1;
  inn.totalBalls   += 1;

  if (['bowled', 'caught', 'lbw', 'stumped', 'hit_wicket'].includes(type)) {
    bowler.wickets += 1;
  }

  const wBall = { label: 'W', chipClass: 'ball-wicket' };
  addBallToOver(inn, bowler, wBall);
  striker.ballHistory.push(wBall);

  checkOverComplete(inn);

  const event = buildEvent('wicket', { dismissal_type: type });
  await _persistWithEvent(event);
}

/**
 * undoLastBall()
 * Restore the previous innings state from the history stack.
 * Removes the last match_event row from Dexie.
 */
export async function undoLastBall() {
  const inn = currentInnings();
  if (!inn.history || inn.history.length === 0) return;

  const snap = inn.history.pop();
  _restoreSnapshot(inn, snap);

  // Remove last event from Dexie
  if (storeMatch?.id) {
    try {
      const { db } = await import('./db.js');
      const lastEvent = await db.match_events
        .where('match_id')
        .equals(storeMatch.id)
        .reverse()
        .first();
      if (lastEvent) await db.match_events.delete(lastEvent.id);
    } catch (err) {
      console.warn('[engine] undo deleteEvent failed', err);
    }
  }

  await _persist();
}

/**
 * swapStrike()
 * Manually swap striker and non-striker.
 */
export async function swapStrike() {
  const inn = currentInnings();
  _swapStrike(inn);
  await _persist();
}

// ── Private helpers ─────────────────────────────────────────────────────────

function _formatDismissal(type, bowlerName) {
  const labels = {
    bowled:      `b ${bowlerName}`,
    caught:      `c & b ${bowlerName}`,
    lbw:         `lbw ${bowlerName}`,
    run_out:     'run out',
    stumped:     `st ${bowlerName}`,
    hit_wicket:  `hit wicket b ${bowlerName}`,
    retired:     'retired',
  };
  return labels[type] ?? type;
}

function _restoreSnapshot(inn, snap) {
  inn.totalRuns           = snap.totalRuns;
  inn.totalWickets        = snap.totalWickets;
  inn.totalBalls          = snap.totalBalls;
  inn.extras              = { ...snap.extras };
  inn.strikerIndex        = snap.strikerIndex;
  inn.nonStrikerIndex     = snap.nonStrikerIndex;
  inn.currentBowlerIndex  = snap.currentBowlerIndex;
  inn.thisOver            = [...snap.thisOver];
  inn.lastOver            = [...snap.lastOver];
  inn.lastOverRuns        = snap.lastOverRuns;
  inn.batsmen             = snap.batsmen.map(b => ({ ...b, ballHistory: [...b.ballHistory] }));
  inn.bowlers             = snap.bowlers.map(b => ({
    ...b,
    overHistory:      b.overHistory.map(o => ({ balls: [...o.balls], runs: o.runs })),
    currentOverBalls: [...b.currentOverBalls],
  }));
}

// ── Pure state-transform version (for testing & server reuse) ───────────────

/**
 * applyCommand(state, command)
 * PURE function: given a full match state and a command object,
 * return the new match state (deep clone). No I/O, no side effects.
 *
 * Used by tests/engine.test.html and future server replay.
 *
 * @param {import('./commands.js').MatchStateClone} state
 * @param {import('./commands.js').ScoringCommand} command
 * @returns {import('./commands.js').MatchStateClone}
 */
export function applyCommand(state, command) {
  // Deep clone so callers get a new object
  const s = JSON.parse(JSON.stringify(state));
  const inn = s.innings[s.currentInnings];

  const striker = inn.batsmen[inn.strikerIndex];
  const bowler  = inn.bowlers[inn.currentBowlerIndex];

  // Save snapshot for undo
  if (!inn.history) inn.history = [];
  inn.history.push(JSON.parse(JSON.stringify({
    totalRuns: inn.totalRuns, totalWickets: inn.totalWickets, totalBalls: inn.totalBalls,
    extras: { ...inn.extras }, strikerIndex: inn.strikerIndex,
    nonStrikerIndex: inn.nonStrikerIndex, currentBowlerIndex: inn.currentBowlerIndex,
    thisOver: [...inn.thisOver], lastOver: [...inn.lastOver],
    lastOverRuns: inn.lastOverRuns,
    batsmen: inn.batsmen, bowlers: inn.bowlers,
  })));

  function swap() {
    const t = inn.strikerIndex; inn.strikerIndex = inn.nonStrikerIndex; inn.nonStrikerIndex = t;
  }
  function checkOver() {
    if (inn.totalBalls > 0 && inn.totalBalls % 6 === 0) {
      if (bowler) {
        bowler.overs += 1; bowler.ballsInOver = 0;
        if (bowler.runsThisOver === 0) bowler.maidens += 1;
        inn.lastOver = [...inn.thisOver];
        inn.lastOverRuns = bowler.runsThisOver;
        bowler.overHistory.push({ balls: [...(bowler.currentOverBalls || [])], runs: bowler.runsThisOver });
        bowler.currentOverBalls = [];
        bowler.runsThisOver = 0;
      }
      inn.thisOver = [];
      swap();
    } else if (inn.currentBowlerIndex >= 0) {
      inn.bowlers[inn.currentBowlerIndex].ballsInOver = inn.totalBalls % 6;
    }
  }

  switch (command.type) {
    case 'SCORE_RUNS': {
      const { runs } = command.payload;
      striker.runs += runs; striker.balls += 1;
      if (runs === 4) striker.fours++;
      if (runs === 6) striker.sixes++;
      inn.totalRuns += runs; inn.totalBalls += 1;
      bowler.runs += runs; bowler.runsThisOver += runs;
      let chipClass = runs === 0 ? 'ball-dot' : runs === 4 ? 'ball-four' : runs === 6 ? 'ball-six' : 'ball-run';
      const ball = { label: String(runs), chipClass };
      inn.thisOver.push(ball); bowler.currentOverBalls.push(ball); striker.ballHistory.push(ball);
      if (runs % 2 === 1) swap();
      checkOver();
      break;
    }
    case 'PROCESS_EXTRA': {
      const { extraType, additionalRuns } = command.payload;
      if (extraType === 'wide') {
        const t = 1 + additionalRuns;
        inn.totalRuns += t; inn.extras.wides += t;
        bowler.runs += t; bowler.runsThisOver += t;
        inn.thisOver.push({ label: `Wd+${additionalRuns}`, chipClass: 'ball-wide' });
        if (additionalRuns % 2 === 1) swap();
      } else if (extraType === 'noball') {
        const t = 1 + additionalRuns;
        inn.totalRuns += t; inn.extras.noBalls += t;
        bowler.runs += t; bowler.runsThisOver += t;
        if (additionalRuns > 0) { striker.runs += additionalRuns; if (additionalRuns === 4) striker.fours++; if (additionalRuns === 6) striker.sixes++; }
        const b = { label: `NB+${additionalRuns}`, chipClass: 'ball-noball' }; inn.thisOver.push(b); striker.ballHistory.push(b);
        if (additionalRuns % 2 === 1) swap();
      } else if (extraType === 'bye') {
        inn.totalRuns += additionalRuns; inn.extras.byes += additionalRuns;
        inn.totalBalls += 1; striker.balls += 1;
        const b = { label: `B${additionalRuns}`, chipClass: 'ball-bye' }; inn.thisOver.push(b); striker.ballHistory.push(b);
        if (additionalRuns % 2 === 1) swap();
        checkOver();
      } else if (extraType === 'legbye') {
        inn.totalRuns += additionalRuns; inn.extras.legByes += additionalRuns;
        inn.totalBalls += 1; striker.balls += 1;
        const b = { label: `LB${additionalRuns}`, chipClass: 'ball-legbye' }; inn.thisOver.push(b); striker.ballHistory.push(b);
        if (additionalRuns % 2 === 1) swap();
        checkOver();
      }
      break;
    }
    case 'HANDLE_WICKET': {
      const { dismissalType } = command.payload;
      striker.isOut = true;
      striker.dismissal = dismissalType;
      striker.balls += 1;
      inn.totalWickets += 1; inn.totalBalls += 1;
      if (['bowled','caught','lbw','stumped','hit_wicket'].includes(dismissalType)) bowler.wickets += 1;
      const b = { label: 'W', chipClass: 'ball-wicket' }; inn.thisOver.push(b); striker.ballHistory.push(b);
      checkOver();
      break;
    }
    case 'UNDO_LAST_BALL': {
      if (inn.history && inn.history.length > 1) {
        inn.history.pop(); // pop current (which we just pushed)
        const prev = inn.history[inn.history.length - 1];
        Object.assign(inn, JSON.parse(JSON.stringify(prev)));
      }
      break;
    }
    case 'SWAP_STRIKE': {
      swap();
      break;
    }
  }

  return s;
}
