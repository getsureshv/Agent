/**
 * src/ui/scoring.js — Dev 5
 * Live scoring screen — biggest module.
 * Wires scoring buttons, extras, wickets, undo, voice, swap strike.
 * Calls Dev 2's engine functions; calls Dev 3's voice adapter.
 */

import { showScreen } from './screens.js';
import { showModal, hideModal } from './modal.js';
import { updateScoreboard, renderThisOver, renderLastOver, buildScorecardHTML, buildBatsmanDetailHTML, buildBowlerDetailHTML } from './scoreboard.js';

// ── Dev 2 lazy imports ────────────────────────────────────────────────────────
async function getEngine() {
  try { return await import('../scoring/engine.js'); }
  catch (_) {
    // Stub for parallel dev
    return {
      scoreRuns: (n) => console.log('[engine stub] scoreRuns', n),
      processExtra: (t, n) => console.log('[engine stub] processExtra', t, n),
      handleWicket: (t) => console.log('[engine stub] handleWicket', t),
      undoLastBall: () => console.log('[engine stub] undoLastBall'),
      swapStrike: () => console.log('[engine stub] swapStrike'),
    };
  }
}
async function getStore() {
  try { return await import('../state/store.js'); }
  catch (_) { return { match: null, tournament: null, currentFixtureIndex: -1 }; }
}
async function getCommands() {
  try { return await import('../scoring/commands.js'); }
  catch (_) {
    return {
      parseVoiceCommand: () => null,
      normalizeTranscript: (s) => s,
    };
  }
}

// ── Dev 3 lazy imports ────────────────────────────────────────────────────────
async function getVoice() {
  try { return await import('../voice/voiceAdapter.js'); }
  catch (_) {
    return {
      createRecognition: () => {
        const WS = window.SpeechRecognition || window.webkitSpeechRecognition;
        return WS ? new WS() : null;
      },
    };
  }
}

// ── State ─────────────────────────────────────────────────────────────────────
let _pendingExtraType = null;
let _scoreRecog = null;
let _scoreListening = false;

/**
 * updateDisplay() — exported, called after every engine mutation.
 * Reads current match state and repaints entire scoring screen.
 */
export async function updateDisplay() {
  const store = await getStore();
  const match = store.match;
  if (!match) return;
  updateScoreboard(match);
  _updateTournamentNavVisibility(store);
}

function _updateTournamentNavVisibility(store) {
  const btn = document.getElementById('scoring-back-to-tournament-btn');
  if (!btn) return;
  if (store.tournament && store.currentFixtureIndex >= 0) {
    btn.classList.remove('hidden');
  } else {
    btn.classList.add('hidden');
  }
}

/** Wire all scoring screen event handlers. */
export function initScoring() {
  _wireRunButtons();
  _wireExtrasButtons();
  _wireWicketButton();
  _wireUndoSwapScorecard();
  _wireVoiceButton();
  _wireChangeBatsmanBowler();
  _wireLastOverToggle();
  _wireMatchStart();
  _wireScoringNav();
}

// ── Run Buttons ───────────────────────────────────────────────────────────────

function _wireRunButtons() {
  document.querySelectorAll('.btn-run').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const runs = parseInt(btn.dataset.runs);
      const engine = await getEngine();
      engine.scoreRuns(runs);
      await updateDisplay();
    });
  });
}

// ── Extras ────────────────────────────────────────────────────────────────────

function _wireExtrasButtons() {
  const extraMap = {
    'wide-btn':   { type: 'wide',   title: 'Wide - Additional Runs' },
    'noball-btn': { type: 'noball', title: 'No Ball - Additional Runs' },
    'bye-btn':    { type: 'bye',    title: 'Bye - Runs Taken' },
    'legbye-btn': { type: 'legbye', title: 'Leg Bye - Runs Taken' },
  };
  Object.entries(extraMap).forEach(([id, { type, title }]) => {
    document.getElementById(id)?.addEventListener('click', () => {
      _pendingExtraType = type;
      const titleEl = document.getElementById('extras-modal-title');
      if (titleEl) titleEl.textContent = title;
      showModal('extras-modal');
    });
  });

  document.querySelectorAll('.extras-runs-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const additionalRuns = parseInt(btn.dataset.extraRuns);
      const engine = await getEngine();
      engine.processExtra(_pendingExtraType, additionalRuns);
      hideModal('extras-modal');
      await updateDisplay();
    });
  });

  document.getElementById('cancel-extras')?.addEventListener('click', () =>
    hideModal('extras-modal')
  );
}

// ── Wickets ───────────────────────────────────────────────────────────────────

function _wireWicketButton() {
  document.getElementById('wicket-btn')?.addEventListener('click', () =>
    showModal('wicket-modal')
  );
  document.getElementById('cancel-wicket')?.addEventListener('click', () =>
    hideModal('wicket-modal')
  );

  document.querySelectorAll('.btn-wicket-type').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const engine = await getEngine();
      engine.handleWicket(btn.dataset.type);
      hideModal('wicket-modal');
      await updateDisplay();
      // Check if innings ended — handled by engine which fires inningsComplete event
    });
  });
}

// ── Undo / Swap / Scorecard ───────────────────────────────────────────────────

function _wireUndoSwapScorecard() {
  document.getElementById('undo-btn')?.addEventListener('click', async () => {
    const engine = await getEngine();
    engine.undoLastBall();
    await updateDisplay();
  });

  document.getElementById('swap-btn')?.addEventListener('click', async () => {
    const engine = await getEngine();
    engine.swapStrike();
    await updateDisplay();
  });

  document.getElementById('scorecard-btn')?.addEventListener('click', async () => {
    const store = await getStore();
    const html = buildScorecardHTML(store.match);
    const content = document.getElementById('scorecard-content');
    if (content) content.innerHTML = html;
    showModal('scorecard-modal');
  });

  document.getElementById('close-scorecard')?.addEventListener('click', () =>
    hideModal('scorecard-modal')
  );
}

// ── Voice ─────────────────────────────────────────────────────────────────────

function _wireVoiceButton() {
  const voiceBtn    = document.getElementById('voice-score-btn');
  const voiceStatus = document.getElementById('score-voice-status');
  const cmdInput    = document.getElementById('score-command-input');

  // Text command enter
  cmdInput?.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const text = cmdInput.value.trim();
    if (!text) return;
    const commands = await getCommands();
    const cmd = commands.parseVoiceCommand(text);
    if (cmd) {
      await _executeVoiceCommand(cmd);
      _setVoiceStatus(voiceStatus, _describeCommand(cmd), 'success-text');
      cmdInput.value = '';
    } else {
      _setVoiceStatus(voiceStatus, `"${text}" — not recognized`, 'error-text');
    }
  });

  voiceBtn?.addEventListener('click', async () => {
    if (_scoreListening) {
      _scoreRecog?.stop();
      return;
    }
    const voice = await getVoice();
    _scoreRecog = voice.createRecognition();
    if (!_scoreRecog) {
      voiceBtn.style.display = 'none';
      return;
    }

    _scoreRecog.onstart = () => {
      _scoreListening = true;
      voiceBtn.classList.add('listening');
      _setVoiceStatus(voiceStatus, 'Listening…', 'listening-text');
    };
    _scoreRecog.onresult = async (e) => {
      const transcript = e.results[0][0].transcript;
      if (cmdInput) cmdInput.value = transcript;
      const commands = await getCommands();
      const cmd = commands.parseVoiceCommand(transcript);
      if (cmd) {
        await _executeVoiceCommand(cmd);
        _setVoiceStatus(voiceStatus, `Heard: "${transcript}" → ${_describeCommand(cmd)}`, 'success-text');
        setTimeout(() => { if (cmdInput) cmdInput.value = ''; }, 1500);
      } else {
        _setVoiceStatus(voiceStatus, `Heard: "${transcript}" — not understood`, 'error-text');
      }
    };
    _scoreRecog.onerror = (e) => {
      _setVoiceStatus(voiceStatus, `Voice error: ${e.error}`, 'error-text');
    };
    _scoreRecog.onend = () => {
      _scoreListening = false;
      voiceBtn.classList.remove('listening');
    };
    _scoreRecog.start();
  });
}

async function _executeVoiceCommand(cmd) {
  if (!cmd) return;
  const engine = await getEngine();
  switch (cmd.action) {
    case 'runs':      engine.scoreRuns(cmd.runs); break;
    case 'extra':     engine.processExtra(cmd.type, cmd.additionalRuns); break;
    case 'wicket':    engine.handleWicket(cmd.type); break;
    case 'undo':      engine.undoLastBall(); break;
    case 'swap':      engine.swapStrike(); break;
    case 'scorecard': document.getElementById('scorecard-btn')?.click(); return;
    case 'change_bowler':     _showChangeBowler(); return;
    case 'change_striker':    _showChangeBatsman('striker'); return;
    case 'change_non_striker':_showChangeBatsman('non-striker'); return;
    default: return;
  }
  await updateDisplay();
}

function _describeCommand(cmd) {
  if (!cmd) return 'Not understood';
  const names = { wide: 'Wide', noball: 'No Ball', bye: 'Bye', legbye: 'Leg Bye' };
  const wNames = { bowled: 'Bowled', caught: 'Caught', lbw: 'LBW', runout: 'Run Out', stumped: 'Stumped', hitwicket: 'Hit Wicket', retired: 'Retired' };
  switch (cmd.action) {
    case 'runs':    return `${cmd.runs} run${cmd.runs !== 1 ? 's' : ''}`;
    case 'extra':   return (names[cmd.type] || cmd.type) + (cmd.additionalRuns ? ` + ${cmd.additionalRuns}` : '');
    case 'wicket':  return 'Wicket — ' + (wNames[cmd.type] || cmd.type);
    case 'undo':    return 'Undo';
    case 'swap':    return 'Swap Batsmen';
    case 'scorecard': return 'Show Scorecard';
    case 'change_bowler': return 'Change Bowler';
    case 'change_striker': return 'Change Striker';
    case 'change_non_striker': return 'Change Non-Striker';
  }
  return 'Unknown';
}

function _setVoiceStatus(el, text, cls) {
  if (!el) return;
  el.textContent = text;
  el.className = 'voice-status ' + (cls || '');
  el.classList.remove('hidden');
  if (cls !== 'listening-text') {
    setTimeout(() => el.classList.add('hidden'), 3000);
  }
}

// ── New Bowler / Change Bowler ────────────────────────────────────────────────

function _wireChangeBatsmanBowler() {
  // Change bowler tap
  document.getElementById('bowler-info-tap')?.addEventListener('click', _showChangeBowler);
  document.getElementById('bowler-change-btn')?.addEventListener('click', _showChangeBowler);
  document.getElementById('close-change-bowler')?.addEventListener('click', () =>
    hideModal('change-bowler-modal')
  );

  // Change striker tap
  document.getElementById('striker-info-tap')?.addEventListener('click', () => _showChangeBatsman('striker'));
  document.getElementById('striker-change-btn')?.addEventListener('click', () => _showChangeBatsman('striker'));

  // Change non-striker tap
  document.getElementById('non-striker-info-tap')?.addEventListener('click', () => _showChangeBatsman('non-striker'));
  document.getElementById('non-striker-change-btn')?.addEventListener('click', () => _showChangeBatsman('non-striker'));

  document.getElementById('close-change-batsman')?.addEventListener('click', () =>
    hideModal('change-batsman-modal')
  );

  // Batsman detail tap (long-press or info icon would be ideal; tap on score for now)
  document.getElementById('close-batsman-detail')?.addEventListener('click', () =>
    hideModal('batsman-detail-modal')
  );
  document.getElementById('close-bowler-detail')?.addEventListener('click', () =>
    hideModal('bowler-detail-modal')
  );
}

export async function promptNewBowler() {
  const store = await getStore();
  const match = store.match;
  if (!match) return;
  const inn = match.innings[match.currentInnings];
  if (!inn) return;
  _renderBowlerList('bowler-list', inn, (name) => {
    // Dev 2 engine handles new bowler via a naming approach in existing app.js
    // We dispatch an event; engine.js in Dev 2 branch should handle it.
    window.dispatchEvent(new CustomEvent('scoring:newBowler', { detail: { name } }));
    hideModal('new-bowler-modal');
    updateDisplay();
  });
  showModal('new-bowler-modal');
}

async function _showChangeBowler() {
  const store = await getStore();
  const match = store.match;
  if (!match) return;
  const inn = match.innings[match.currentInnings];
  const current = document.getElementById('change-bowler-current');
  if (current && inn?.currentBowlerIndex >= 0) {
    current.textContent = 'Current: ' + inn.bowlers[inn.currentBowlerIndex].name;
  }
  _renderBowlerList('change-bowler-list', inn, (name) => {
    window.dispatchEvent(new CustomEvent('scoring:changeBowler', { detail: { name } }));
    hideModal('change-bowler-modal');
    updateDisplay();
  });
  showModal('change-bowler-modal');
}

function _renderBowlerList(containerId, inn, onSelect) {
  const container = document.getElementById(containerId);
  if (!container || !inn) return;
  container.innerHTML = '';
  (inn.bowlingNames || []).forEach((name) => {
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary player-list-btn';
    btn.textContent = name;
    btn.addEventListener('click', () => onSelect(name));
    container.appendChild(btn);
  });
}

async function _showChangeBatsman(role) {
  const store = await getStore();
  const match = store.match;
  if (!match) return;
  const inn = match.innings[match.currentInnings];
  const title = document.getElementById('change-batsman-title');
  if (title) title.textContent = role === 'striker' ? 'Change Striker' : 'Change Non-Striker';
  const current = document.getElementById('change-batsman-current');
  if (current) {
    const idx = role === 'striker' ? inn.strikerIndex : inn.nonStrikerIndex;
    current.textContent = 'Current: ' + (inn.batsmen[idx]?.name || '');
  }
  const list = document.getElementById('change-batsman-list');
  if (list) {
    list.innerHTML = '';
    inn.batsmen.filter((b) => !b.isOut).forEach((b) => {
      const btn = document.createElement('button');
      btn.className = 'btn btn-secondary player-list-btn';
      btn.textContent = b.name;
      btn.addEventListener('click', () => {
        window.dispatchEvent(new CustomEvent('scoring:changeBatsman', { detail: { role, name: b.name } }));
        hideModal('change-batsman-modal');
        updateDisplay();
      });
      list.appendChild(btn);
    });
  }
  showModal('change-batsman-modal');
}

// ── Last over toggle ──────────────────────────────────────────────────────────

function _wireLastOverToggle() {
  document.getElementById('last-over-toggle')?.addEventListener('click', () => {
    const detail = document.getElementById('last-over-detail');
    const arrow  = document.getElementById('toggle-arrow');
    detail?.classList.toggle('hidden');
    arrow?.classList.toggle('open');
  });
}

// ── Match start event ─────────────────────────────────────────────────────────

function _wireMatchStart() {
  window.addEventListener('match:start', () => {
    updateDisplay();
    // Prompt for first bowler
    setTimeout(promptNewBowler, 100);
  });

  // Innings complete / match complete
  window.addEventListener('innings:complete', async () => {
    const store = await getStore();
    const match = store.match;
    // Engine drives second innings start; UI just refreshes
    await updateDisplay();
  });

  window.addEventListener('match:complete', async () => {
    const store = await getStore();
    const match = store.match;
    if (!match) return;
    _showResultScreen(match);
  });
}

// ── Tournament navigation from scoring ───────────────────────────────────────

function _wireScoringNav() {
  document.getElementById('scoring-back-to-tournament-btn')?.addEventListener('click', () =>
    showScreen('tournament-dashboard-screen')
  );
}

// ── Result screen ─────────────────────────────────────────────────────────────

function _showResultScreen(match) {
  const resultText = document.getElementById('result-text');
  const resultSummary = document.getElementById('result-summary');

  if (resultText) resultText.textContent = match.result_text || 'Match Complete';
  if (resultSummary) {
    let html = '';
    match.innings?.forEach((inn, i) => {
      html += `<p>${inn.battingTeam}: ${inn.totalRuns}/${inn.totalWickets} (${Math.floor(inn.totalBalls / 6)}.${inn.totalBalls % 6} ov)</p>`;
    });
    resultSummary.innerHTML = html;
  }

  // Show/hide back to tournament button
  const backTournBtn = document.getElementById('back-to-tournament-btn');
  const newMatchBtn  = document.getElementById('new-match-btn');

  if (backTournBtn) {
    getStore().then((store) => {
      if (store.tournament) backTournBtn.classList.remove('hidden');
      else backTournBtn.classList.add('hidden');
    });
  }

  newMatchBtn?.addEventListener('click', () => {
    showScreen('home-screen', { clearStack: true });
  }, { once: true });

  backTournBtn?.addEventListener('click', () => {
    showScreen('tournament-dashboard-screen');
  }, { once: true });

  showScreen('result-screen');
}
