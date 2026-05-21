// Pure scoring engine. No DB calls. Given a match row + an ordered list of
// match events + the two team rosters, returns a fully derived match state.
//
// Conventions used throughout:
//   - innings_num is 1 or 2 (no super-overs in this PR)
//   - over_num is 1-based at the API layer; computed from balls bowled here
//   - ball_num is the 1-based position WITHIN an over for LEGAL deliveries
//   - Strike rotates on odd runs off the bat AND at end-of-over.
//     Byes / leg-byes do NOT affect strike rotation by run parity, but the
//     run still counts (we treat the run as crediting the batting side, and
//     follow real cricket: strike rotates by runs scored on the delivery
//     regardless of whether they're scored off the bat).
//   - Wide / no-ball: not a legal ball. Wide runs are all extras (no off-bat
//     credit). No-ball gives 1 extra plus whatever runs are scored off the
//     bat (which credit the batter and count as a ball faced).
//   - This engine is intentionally strict about what it computes and lax
//     about what it validates — input validation belongs in the route.

const MAX_BALLS_PER_OVER = 6;

function rosterByTeam(teamRosters, teamId) {
  return teamRosters?.[teamId] || [];
}

function lookupPlayer(teamRosters, playerId) {
  if (!playerId) return null;
  for (const teamId of Object.keys(teamRosters || {})) {
    const found = teamRosters[teamId].find((p) => p.id === playerId);
    if (found) return found;
  }
  return null;
}

// Build the running state for a single innings by replaying its events.
function buildInnings({ inningsNum, battingTeamId, bowlingTeamId, events, teamRosters }) {
  const batters = new Map();   // player_id → batter stats
  const bowlers = new Map();   // player_id → bowler stats
  const log = [];
  let runs = 0;
  let wickets = 0;
  let legalBalls = 0;
  let extras = { wide: 0, no_ball: 0, bye: 0, leg_bye: 0 };
  let striker = null;
  let nonStriker = null;
  let currentBowler = null;
  let lastLegalOver = null;       // over_num of last legal ball seen (1-based)
  let ballsInCurrentOver = 0;     // legal balls bowled in the current over
  let ended = false;
  let endReason = null;

  function ensureBatter(id) {
    if (!id) return null;
    let b = batters.get(id);
    if (!b) {
      const p = lookupPlayer(teamRosters, id);
      b = {
        player_id: id,
        name: p?.name || 'Unknown',
        runs: 0, balls: 0, fours: 0, sixes: 0,
        out: false, out_event_seq: null, dismissal: null,
      };
      batters.set(id, b);
    }
    return b;
  }
  function ensureBowler(id) {
    if (!id) return null;
    let bo = bowlers.get(id);
    if (!bo) {
      const p = lookupPlayer(teamRosters, id);
      bo = {
        player_id: id,
        name: p?.name || 'Unknown',
        balls: 0, runs: 0, wickets: 0, dots: 0,
      };
      bowlers.set(id, bo);
    }
    return bo;
  }

  for (const e of events) {
    // Track current open batters/bowler from the event itself.
    // The first ball of the innings establishes them.
    if (e.batter_on_strike_player_id)   striker = e.batter_on_strike_player_id;
    if (e.batter_non_strike_player_id)  nonStriker = e.batter_non_strike_player_id;
    if (e.bowler_player_id)             currentBowler = e.bowler_player_id;

    const batter = ensureBatter(striker);
    const nonStrikerB = ensureBatter(nonStriker);
    const bowler = ensureBowler(currentBowler);

    const offBat = Number(e.runs_off_bat || 0);
    const extrasRuns = Number(e.extras_runs || 0);
    const extrasType = e.extras_type || null;

    // Aggregate totals
    runs += offBat + extrasRuns;
    if (extrasType && extras[extrasType] !== undefined) {
      extras[extrasType] += extrasRuns;
    }

    // Bowler stats
    if (bowler) {
      bowler.runs += offBat + extrasRuns;
    }

    // Batter stats — only counted on deliveries where the batter "faced" the ball.
    // A wide is never faced; everything else (no-ball, byes, leg-byes, normal) is.
    const batterFacedBall = extrasType !== 'wide';
    if (batterFacedBall && batter) {
      batter.balls += 1;
      batter.runs += offBat;
      if (offBat === 4) batter.fours += 1;
      if (offBat === 6) batter.sixes += 1;
    }

    // Legal ball accounting
    let legal = e.legal_ball;
    if (legal === undefined || legal === null) {
      legal = extrasType !== 'wide' && extrasType !== 'no_ball';
    }
    if (legal) {
      legalBalls += 1;
      ballsInCurrentOver = (legalBalls - 1) % MAX_BALLS_PER_OVER + 1;
      if (bowler) {
        bowler.balls += 1;
        if (offBat === 0 && extrasRuns === 0) bowler.dots += 1;
      }
    }

    // Wicket
    if (e.is_wicket) {
      wickets += 1;
      const outId = e.out_batter_player_id || striker;
      const outB = ensureBatter(outId);
      if (outB) {
        outB.out = true;
        outB.out_event_seq = e.seq;
        outB.dismissal = e.wicket_type || 'unknown';
      }
      if (bowler && ['bowled', 'caught', 'lbw', 'stumped', 'hit_wicket'].includes(e.wicket_type)) {
        bowler.wickets += 1;
      }
      // New batter slot: replaces whichever end the out batter was at.
      const newId = e.new_batter_player_id || null;
      if (outId === striker) striker = newId;
      else if (outId === nonStriker) nonStriker = newId;
    }

    // Strike rotation
    // Total runs scored on this delivery for rotation purposes
    if (legal) {
      const runsOnDelivery = offBat + (['bye', 'leg_bye'].includes(extrasType) ? extrasRuns : 0);
      if (runsOnDelivery % 2 === 1) {
        [striker, nonStriker] = [nonStriker, striker];
      }
      // End of over: swap (only on the 6th legal ball within the over)
      if (ballsInCurrentOver === MAX_BALLS_PER_OVER) {
        [striker, nonStriker] = [nonStriker, striker];
      }
    } else if (extrasType === 'no_ball') {
      // On a no-ball, runs off the bat still rotate strike (the players ran).
      if (offBat % 2 === 1) {
        [striker, nonStriker] = [nonStriker, striker];
      }
    }

    // Synthetic explicit end-of-innings markers
    if (e.event_kind === 'innings_end') {
      ended = true;
      endReason = 'manual';
    }

    log.push({
      seq: e.seq,
      kind: e.event_kind || 'ball',
      over_num: e.over_num,
      ball_num: e.ball_num,
      legal,
      runs_off_bat: offBat,
      extras_runs: extrasRuns,
      extras_type: extrasType,
      is_wicket: !!e.is_wicket,
      wicket_type: e.wicket_type || null,
      runs_total: offBat + extrasRuns,
      created_at: e.created_at || null,
    });

    if (legal) lastLegalOver = Math.ceil(legalBalls / MAX_BALLS_PER_OVER);
  }

  const completedOvers = Math.floor(legalBalls / MAX_BALLS_PER_OVER);
  const ballsInOver = legalBalls % MAX_BALLS_PER_OVER;
  const overString = `${completedOvers}.${ballsInOver}`;

  return {
    innings_num: inningsNum,
    batting_team_id: battingTeamId,
    bowling_team_id: bowlingTeamId,
    runs,
    wickets,
    legal_balls: legalBalls,
    over: overString,
    completed_overs: completedOvers,
    balls_in_current_over: ballsInOver,
    extras,
    extras_total: extras.wide + extras.no_ball + extras.bye + extras.leg_bye,
    batting: Array.from(batters.values()),
    bowling: Array.from(bowlers.values()),
    striker_player_id: striker,
    non_striker_player_id: nonStriker,
    current_bowler_player_id: currentBowler,
    log,
    ended,
    end_reason: endReason,
  };
}

function inningsTermination(innings, { oversPerInnings, playersPerSide, target }) {
  if (innings.ended) return innings;
  // All out: wickets == playersPerSide - 1
  if (playersPerSide && innings.wickets >= playersPerSide - 1) {
    return { ...innings, ended: true, end_reason: 'all_out' };
  }
  // Overs exhausted
  if (oversPerInnings && innings.completed_overs >= oversPerInnings && innings.balls_in_current_over === 0) {
    return { ...innings, ended: true, end_reason: 'overs_complete' };
  }
  // Target chased (2nd innings only)
  if (target !== null && target !== undefined && innings.runs >= target) {
    return { ...innings, ended: true, end_reason: 'target_chased' };
  }
  return innings;
}

export function computeMatchState(match, events, teamRosters) {
  const safeRosters = teamRosters || {};
  const oversPerInnings = match.overs_per_innings || null;
  const playersPerSide = match.players_per_side || null;

  // Split events by innings_num. Events without innings_num go into innings 1
  // (defensive — shouldn't happen for new writes).
  const byInnings = new Map();
  for (const e of events) {
    const n = e.innings_num || match.current_innings_num || 1;
    if (!byInnings.has(n)) byInnings.set(n, []);
    byInnings.get(n).push(e);
  }
  // Stable ordering by seq just in case
  for (const arr of byInnings.values()) arr.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

  const battingTeamFor = {
    1: match.current_innings_num === 1 ? match.current_batting_team_id : null,
    2: null,
  };
  const bowlingTeamFor = {
    1: match.current_innings_num === 1 ? match.current_bowling_team_id : null,
    2: null,
  };
  // For innings 2 the teams swap (we don't know if the match flipped already;
  // best effort: deduce from any innings-2 event, otherwise treat as currents).
  if (byInnings.has(2)) {
    const firstE = byInnings.get(2)[0];
    if (firstE) {
      battingTeamFor[2] = firstE._batting_team_id || (
        match.current_innings_num === 2 ? match.current_batting_team_id : null
      );
      bowlingTeamFor[2] = firstE._bowling_team_id || (
        match.current_innings_num === 2 ? match.current_bowling_team_id : null
      );
    }
  }
  // Fallback: if innings 1 has events and we still don't know teams, fill from match row.
  if (!battingTeamFor[1] && byInnings.has(1)) {
    battingTeamFor[1] = match.current_batting_team_id;
    bowlingTeamFor[1] = match.current_bowling_team_id;
  }
  // 2nd-innings inference when 1st-innings teams known but flip not stamped
  if (byInnings.has(2) && !battingTeamFor[2] && battingTeamFor[1] && bowlingTeamFor[1]) {
    battingTeamFor[2] = bowlingTeamFor[1];
    bowlingTeamFor[2] = battingTeamFor[1];
  }

  let innings1 = byInnings.has(1)
    ? buildInnings({
        inningsNum: 1, battingTeamId: battingTeamFor[1], bowlingTeamId: bowlingTeamFor[1],
        events: byInnings.get(1), teamRosters: safeRosters,
      })
    : null;
  if (innings1) innings1 = inningsTermination(innings1, { oversPerInnings, playersPerSide, target: null });

  const target = innings1?.ended ? innings1.runs + 1 : null;

  let innings2 = byInnings.has(2)
    ? buildInnings({
        inningsNum: 2, battingTeamId: battingTeamFor[2], bowlingTeamId: bowlingTeamFor[2],
        events: byInnings.get(2), teamRosters: safeRosters,
      })
    : null;
  if (innings2) innings2 = inningsTermination(innings2, { oversPerInnings, playersPerSide, target });

  const innings = [innings1, innings2].filter(Boolean);

  // Run rate / required run rate based on the current innings.
  const currentInningsNum = innings2 ? 2 : 1;
  const current = innings2 || innings1 || null;
  let runRate = null, requiredRunRate = null, ballsRemaining = null, runsRequired = null;
  if (current) {
    runRate = current.legal_balls > 0 ? (current.runs / (current.legal_balls / MAX_BALLS_PER_OVER)) : 0;
    runRate = Math.round(runRate * 100) / 100;
  }
  if (innings2 && target !== null) {
    runsRequired = Math.max(0, target - innings2.runs);
    const totalBalls = (oversPerInnings || 0) * MAX_BALLS_PER_OVER;
    ballsRemaining = Math.max(0, totalBalls - innings2.legal_balls);
    if (ballsRemaining > 0) {
      requiredRunRate = Math.round((runsRequired / (ballsRemaining / MAX_BALLS_PER_OVER)) * 100) / 100;
    } else {
      requiredRunRate = null;
    }
  }

  // Result (very simple — final result is set explicitly via /complete in PR 4).
  let result = null;
  if (match.status === 'completed') {
    result = {
      winner_team_id: match.winner_team_id,
      summary: match.result_summary,
    };
  } else if (innings2 && innings2.ended) {
    if (innings2.runs >= (target || Infinity)) {
      const wicketsLeft = (playersPerSide || 11) - 1 - innings2.wickets;
      result = {
        winner_team_id: innings2.batting_team_id,
        summary: `${nameOfTeam(innings2.batting_team_id, safeRosters)} won by ${wicketsLeft} wickets`,
      };
    } else if (innings1) {
      const margin = innings1.runs - innings2.runs;
      result = margin === 0
        ? { winner_team_id: null, summary: 'Match tied' }
        : {
          winner_team_id: innings1.batting_team_id,
          summary: `${nameOfTeam(innings1.batting_team_id, safeRosters)} won by ${margin} runs`,
        };
    }
  }

  return {
    match_id: match.id,
    status: match.status,
    innings,
    currentInnings: currentInningsNum,
    batting: current ? {
      striker_player_id: current.striker_player_id,
      non_striker_player_id: current.non_striker_player_id,
    } : null,
    bowling: current ? {
      current_bowler_player_id: current.current_bowler_player_id,
    } : null,
    runRate,
    requiredRunRate,
    runsRequired,
    ballsRemaining,
    target,
    result,
    oversPerInnings,
    playersPerSide,
  };
}

function nameOfTeam(teamId /* , teamRosters */) {
  // The roster object is keyed by team_id and doesn't store team names; the
  // route handler appends names in the response. Here we just return the id
  // so the summary text contains a stable token the UI can rewrite.
  return teamId ? `Team ${teamId.slice(0, 6)}` : 'Team';
}

// Public score-only projection — strips roster detail, scorer, and event log.
export function scoreOnlyView(state, teamLookup = {}) {
  function teamName(id) { return teamLookup[id] || null; }
  return {
    match_id: state.match_id,
    status: state.status,
    currentInnings: state.currentInnings,
    innings: state.innings.map((i) => ({
      innings_num: i.innings_num,
      batting_team_id: i.batting_team_id,
      batting_team_name: teamName(i.batting_team_id),
      runs: i.runs,
      wickets: i.wickets,
      over: i.over,
      extras_total: i.extras_total,
      ended: i.ended,
    })),
    target: state.target,
    runsRequired: state.runsRequired,
    ballsRemaining: state.ballsRemaining,
    runRate: state.runRate,
    requiredRunRate: state.requiredRunRate,
    result: state.result
      ? { ...state.result, winner_team_name: teamName(state.result.winner_team_id) }
      : null,
  };
}

// Validation helper for an incoming ball event. Returns null on OK, or an
// error string. Doesn't touch the DB.
export function validateEvent(e) {
  if (!e || typeof e !== 'object') return 'event must be an object';
  const extras = e.extras_type || null;
  if (extras && !['wide', 'no_ball', 'bye', 'leg_bye'].includes(extras)) {
    return `extras_type must be one of wide|no_ball|bye|leg_bye, got ${extras}`;
  }
  if (e.is_wicket && !e.wicket_type) {
    return 'is_wicket requires wicket_type';
  }
  if (e.wicket_type && !['bowled','caught','lbw','run_out','stumped','hit_wicket','retired'].includes(e.wicket_type)) {
    return `invalid wicket_type ${e.wicket_type}`;
  }
  // Wide can't carry runs off the bat (those go to extras_runs as widerelease).
  if (extras === 'wide' && Number(e.runs_off_bat || 0) > 0) {
    return 'runs_off_bat must be 0 on a wide';
  }
  // legal_ball and wide/no_ball are mutually inconsistent
  if (e.legal_ball === true && (extras === 'wide' || extras === 'no_ball')) {
    return 'legal_ball cannot be true on wide or no_ball';
  }
  return null;
}
