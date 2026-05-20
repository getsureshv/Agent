/**
 * src/ui/chat.js — Dev 5
 * Rules chat panel: topic rendering, search, voice search.
 * Extracted from app.js chat logic.
 */

// ── Dev 3 lazy import ─────────────────────────────────────────────────────────
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

export function initChat() {
  const fab       = document.getElementById('chat-fab');
  const panel     = document.getElementById('chat-panel');
  const closeBtn  = document.getElementById('chat-panel-close');
  const searchInput = document.getElementById('chat-search-input');
  const backBtn   = document.getElementById('chat-back-btn');
  const voiceBtn  = document.getElementById('chat-voice-btn');

  fab?.addEventListener('click', () => panel?.classList.toggle('hidden'));
  closeBtn?.addEventListener('click', () => panel?.classList.add('hidden'));

  // Topic buttons
  panel?.addEventListener('click', (e) => {
    const topicBtn = e.target.closest('.chat-topic-btn');
    if (topicBtn) showRuleTopic(topicBtn.dataset.topic);
  });

  // Back to topics
  backBtn?.addEventListener('click', _showTopics);

  // Search
  searchInput?.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    if (q.length >= 2) _performSearch(q);
    else _showTopics();
  });
  searchInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const q = searchInput.value.trim().toLowerCase();
      if (q) _performSearch(q);
    }
  });

  // Voice search
  _initVoiceSearch(voiceBtn);
}

// ── Render helpers ────────────────────────────────────────────────────────────

function _showTopics() {
  document.getElementById('chat-topics')?.classList.remove('hidden');
  document.getElementById('chat-answer')?.classList.add('hidden');
  document.getElementById('chat-search-results')?.classList.add('hidden');
}

export function showRuleTopic(key) {
  const content = _getRuleContent(key);
  if (!content) return;

  document.getElementById('chat-topics')?.classList.add('hidden');
  document.getElementById('chat-search-results')?.classList.add('hidden');

  const answerEl = document.getElementById('chat-answer');
  const contentEl = document.getElementById('chat-answer-content');
  if (contentEl) contentEl.innerHTML = content;
  answerEl?.classList.remove('hidden');
}

function _performSearch(query) {
  const words = query.split(/\s+/).filter((w) => w.length > 1);
  const allTopics = _getAllTopicEntries();
  const results = allTopics.filter(({ title, snippet }) => {
    const haystack = (title + ' ' + snippet).toLowerCase();
    return words.some((w) => haystack.includes(w));
  });

  const container = document.getElementById('chat-search-results');
  if (!container) return;
  container.innerHTML = '';

  if (!results.length) {
    container.innerHTML = '<div class="chat-no-results">No matching rules found. Try different keywords.</div>';
    container.classList.remove('hidden');
    document.getElementById('chat-topics')?.classList.add('hidden');
    document.getElementById('chat-answer')?.classList.add('hidden');
    return;
  }

  results.forEach((r) => {
    const card = document.createElement('div');
    card.className = 'chat-search-result-card';
    card.innerHTML = `
      <div class="chat-search-result-title">${_esc(r.title)}</div>
      <div class="chat-search-result-snippet">${_highlightWords(_esc(r.snippet), words)}</div>`;
    card.addEventListener('click', () => showRuleTopic(r.key));
    container.appendChild(card);
  });

  container.classList.remove('hidden');
  document.getElementById('chat-topics')?.classList.add('hidden');
  document.getElementById('chat-answer')?.classList.add('hidden');
}

function _highlightWords(text, words) {
  words.forEach((w) => {
    const regex = new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    text = text.replace(regex, '<mark>$1</mark>');
  });
  return text;
}

// ── Voice search ──────────────────────────────────────────────────────────────

function _initVoiceSearch(btn) {
  if (!btn) return;
  let recog = null;
  let listening = false;
  const statusEl = document.getElementById('chat-voice-status');

  btn.addEventListener('click', async () => {
    if (listening) { recog?.stop(); return; }
    const voice = await getVoice();
    recog = voice.createRecognition();
    if (!recog) { btn.style.display = 'none'; return; }

    recog.onstart = () => {
      listening = true;
      btn.classList.add('listening');
      _setVoiceStatus(statusEl, 'Listening… speak your question', 'listening-text');
    };
    recog.onresult = (e) => {
      const transcript = e.results[0][0].transcript;
      const searchInput = document.getElementById('chat-search-input');
      if (searchInput) searchInput.value = transcript;
      _setVoiceStatus(statusEl, `Heard: "${transcript}"`, 'success-text');
      _performSearch(transcript.trim().toLowerCase());
    };
    recog.onerror = (e) => {
      _setVoiceStatus(statusEl, 'Voice error: ' + e.error, 'error-text');
    };
    recog.onend = () => {
      listening = false;
      btn.classList.remove('listening');
    };
    recog.start();
  });
}

function _setVoiceStatus(el, text, cls) {
  if (!el) return;
  el.textContent = text;
  el.className = 'voice-status ' + (cls || '');
  el.classList.remove('hidden');
  if (cls !== 'listening-text') setTimeout(() => el.classList.add('hidden'), 3000);
}

// ── Rule content ──────────────────────────────────────────────────────────────
// Moved from app.js — topic content definitions

function _getAllTopicEntries() {
  return Object.entries(_RULES).map(([key, { title, content }]) => ({
    key, title, snippet: content.replace(/<[^>]+>/g, '').slice(0, 200),
  }));
}

function _getRuleContent(key) {
  return _RULES[key]?.content || null;
}

// Minimal rules data (app.js has the full set; these stubs ensure module works standalone)
const _RULES = {
  basics: {
    title: 'Basic Rules',
    content: `<h3>Basic Rules of Cricket</h3>
      <p>Cricket is played between two teams of 11 players. The batting team scores runs while the bowling team tries to get batsmen out. An innings ends when 10 wickets fall or the overs limit is reached.</p>`,
  },
  scoring: {
    title: 'Scoring & Runs',
    content: `<h3>Scoring Runs</h3>
      <p>Runs are scored by running between wickets, hitting boundaries (4 = ball reaches boundary, 6 = ball clears boundary without bouncing), or from extras (wides, no balls, byes, leg byes).</p>`,
  },
  dismissals: {
    title: 'All 11 Dismissals',
    content: `<h3>Ways of Dismissal</h3>
      <ol><li>Bowled</li><li>Caught</li><li>LBW (Leg Before Wicket)</li><li>Run Out</li>
      <li>Stumped</li><li>Hit the Ball Twice</li><li>Hit Wicket</li><li>Obstructing the Field</li>
      <li>Timed Out</li><li>Handled the Ball (now Obstructing)</li><li>Retired Out</li></ol>`,
  },
  extras: {
    title: 'Extras (Wides, No Balls)',
    content: `<h3>Extras</h3>
      <p><strong>Wide:</strong> Ball beyond reach of striker = 1 extra + any runs scored.<br>
      <strong>No Ball:</strong> Illegal delivery = 1 extra + free hit on next ball.<br>
      <strong>Bye:</strong> Runs scored off a legal ball that misses bat and body.<br>
      <strong>Leg Bye:</strong> Runs off body (not bat) on a legal ball.</p>`,
  },
  freehit: {
    title: 'Free Hit Rules',
    content: `<h3>Free Hit</h3>
      <p>After a no-ball, the next delivery is a free hit — the batsman cannot be dismissed by the ball hitting the wickets. Only run out, obstructing the field, or hit the ball twice dismissals apply.</p>`,
  },
  // remaining topics kept brief; full content is in app.js
  fielding: { title: 'Fielding Positions', content: '<h3>Fielding Positions</h3><p>See full app for detailed fielding chart.</p>' },
  formats: { title: 'Match Formats', content: '<h3>ICC Formats</h3><p>Test (5 days), ODI (50 overs), T20 (20 overs), The Hundred (100 balls).</p>' },
  powerplay: { title: 'Powerplay Rules', content: '<h3>Powerplay</h3><p>First 6 overs in ODI/T20: max 2 fielders outside 30-yard circle.</p>' },
  dls: { title: 'DLS & Rain Rules', content: '<h3>Duckworth-Lewis-Stern</h3><p>Used in rain-affected matches to recalculate targets.</p>' },
  superover: { title: 'Super Over Rules', content: '<h3>Super Over</h3><p>1-over eliminator when scores are tied after regulation play.</p>' },
  drs: { title: 'DRS', content: '<h3>Decision Review System</h3><p>Teams can challenge on-field decisions using technology (ball tracking, snicko, hotspot).</p>' },
  nrr: { title: 'Net Run Rate', content: '<h3>NRR = (runs scored / overs faced) − (runs conceded / overs bowled)</h3>' },
  lbw: { title: 'LBW', content: '<h3>LBW</h3><p>Out if ball pitches in line, hits body in line with stumps, and umpire believes it would have hit stumps. Not out if pitches outside leg stump or impact outside off stump (unless not playing a shot).</p>' },
  umpire: { title: 'Umpire Signals', content: '<h3>Umpire Signals</h3><p>Four: wave arm to boundary; Six: both arms raised; Wide: arms extended horizontally; No Ball: one arm horizontal; Out: index finger raised.</p>' },
  ntca_toss: { title: 'NTCA Toss & Match Start', content: '<p>NTCA toss rules: toss at least 5 min before scheduled start. Winner decides bat/bowl. Both captains sign sheet.</p>' },
  ntca_fielding: { title: 'NTCA Fielding', content: '<p>NTCA: fielding restrictions apply per playing conditions.</p>' },
  ntca_noball: { title: 'NTCA No Ball Rules', content: '<p>NTCA no ball: front foot must be behind popping crease. Back foot must not touch return crease.</p>' },
  ntca_deadball: { title: 'NTCA Dead Ball Rules', content: '<p>Ball is dead when fielding side appeals and umpire signals dead ball, or ball comes to rest with bowler/wicketkeeper.</p>' },
  ntca_dismissals: { title: 'NTCA Dismissal Scenarios', content: '<p>NTCA: common dismissal scenarios and umpire calls.</p>' },
  ntca_lbw: { title: 'NTCA LBW', content: '<p>NTCA LBW considerations: all three conditions (pitch, impact, would have hit) must be satisfied.</p>' },
  ntca_penalty: { title: 'NTCA Penalty Runs', content: '<p>5 penalty runs for deliberate time wasting, damage to ball, deliberate distraction.</p>' },
  ntca_powerplay: { title: 'NTCA Powerplay', content: '<p>NTCA follows ICC powerplay rules for limited-overs formats.</p>' },
  ntca_ground: { title: 'NTCA Ground Setup', content: '<p>Minimum pitch dimensions: 22 yards length. Boundary 50–90 yards from centre.</p>' },
  ntca_match: { title: 'NTCA Match Formats', content: '<p>NTCA: 20/30/40-over formats. All matches timed to completion.</p>' },
  ntca_over_misc: { title: 'NTCA Over & Misc', content: '<p>An over is 6 legal deliveries. Maiden: over where no runs scored off the bat.</p>' },
  usacua_exam: { title: 'USACUA Exam Q&A', content: '<p>Practice questions for USACUA umpire certification exam.</p>' },
};

function _esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
