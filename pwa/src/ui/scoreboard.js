/**
 * src/ui/scoreboard.js — Dev 5
 * Pure render functions: scoreboard, batsmen/bowler stats, mini scorecard, full scorecard modal.
 * Called by scoring.js after every ball and by scorecard modal trigger.
 */

/**
 * Render ball chips for the current over.
 * @param {Array<{label:string, chipClass:string}>} balls
 */
export function renderThisOver(balls) {
  const container = document.getElementById('this-over-balls');
  if (!container) return;
  container.innerHTML = '';
  balls.forEach((b) => {
    const chip = document.createElement('span');
    chip.className = 'ball-chip ' + (b.chipClass || '');
    chip.textContent = b.label;
    container.appendChild(chip);
  });
}

/**
 * Render the last-over section.
 * @param {{ lastOver: Array, lastOverRuns: number }} inn
 */
export function renderLastOver(inn) {
  const section = document.getElementById('last-over-section');
  if (!section) return;
  if (!inn?.lastOver?.length) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';
  const summary = document.getElementById('last-over-summary');
  if (summary) summary.textContent = `${inn.lastOverRuns} runs`;
  const container = document.getElementById('last-over-balls');
  if (!container) return;
  container.innerHTML = '';
  inn.lastOver.forEach((b) => {
    const chip = document.createElement('span');
    chip.className = 'ball-chip ' + (b.chipClass || '');
    chip.textContent = b.label;
    container.appendChild(chip);
  });
}

/**
 * Update the main scoreboard header and player panels.
 * @param {object} match  — full match state from Dev 2 store
 */
export function updateScoreboard(match) {
  if (!match) return;
  const inn = match.innings[match.currentInnings];
  if (!inn) return;

  const striker    = inn.batsmen[inn.strikerIndex];
  const nonStriker = inn.batsmen[inn.nonStrikerIndex];
  const bowler     = inn.currentBowlerIndex >= 0 ? inn.bowlers[inn.currentBowlerIndex] : null;

  _setText('innings-indicator', match.currentInnings === 0 ? '1st Innings' : '2nd Innings');
  _setText('batting-team-name', inn.battingTeam);
  _setText('total-score', `${inn.totalRuns}/${inn.totalWickets}`);
  _setText('overs-display', `(${_formatOvers(inn.totalBalls)} ov)`);

  // Run rates
  const crr = inn.totalBalls > 0 ? ((inn.totalRuns / inn.totalBalls) * 6).toFixed(2) : '0.00';
  _setText('current-rr', crr);

  const targetInfo = document.getElementById('target-info');
  if (match.currentInnings === 1) {
    const target = match.innings[0].totalRuns + 1;
    const remaining = target - inn.totalRuns;
    const ballsLeft = inn.oversLimit * 6 - inn.totalBalls;
    const rrr = ballsLeft > 0 ? ((remaining / ballsLeft) * 6).toFixed(2) : '0.00';
    targetInfo?.classList.remove('hidden');
    _setText('target-score', String(target));
    _setText('required-rr', rrr);
  } else {
    targetInfo?.classList.add('hidden');
  }

  // Batsmen
  if (striker) {
    _setText('striker-name', striker.name);
    _setText('striker-score', `${striker.runs} (${striker.balls})`);
  }
  if (nonStriker) {
    _setText('non-striker-name', nonStriker.name);
    _setText('non-striker-score', `${nonStriker.runs} (${nonStriker.balls})`);
  }
  document.getElementById('striker-row')?.classList.add('on-strike');
  document.getElementById('non-striker-row')?.classList.remove('on-strike');

  // Bowler
  if (bowler) {
    _setText('bowler-name', bowler.name);
    _setText('bowler-figures', _bowlerFigures(bowler));
  }

  // Extras
  const wd = inn.extras?.wides   || 0;
  const nb = inn.extras?.noBalls  || 0;
  const by = inn.extras?.byes     || 0;
  const lb = inn.extras?.legByes  || 0;
  _setText('extras-total', String(wd + nb + by + lb));
  _setText('extras-breakdown', `(wd ${wd}, nb ${nb}, b ${by}, lb ${lb})`);

  renderThisOver(inn.thisOver || []);
  renderLastOver(inn);
}

/**
 * Build and return the full scorecard HTML for a match.
 * Injected into #scorecard-content.
 * @param {object} match
 * @returns {string} HTML string
 */
export function buildScorecardHTML(match) {
  if (!match?.innings?.length) return '<p>No data.</p>';
  let html = '';

  match.innings.forEach((inn, innIdx) => {
    const innLabel = innIdx === 0 ? '1st Innings' : '2nd Innings';
    html += `<div class="scorecard-innings">
      <div class="scorecard-innings-header">
        <span class="scorecard-team">${_esc(inn.battingTeam)}</span>
        <span class="scorecard-score">${inn.totalRuns}/${inn.totalWickets} (${_formatOvers(inn.totalBalls)} ov)</span>
      </div>`;

    // Batting table
    html += `<table class="scorecard-table">
      <thead><tr>
        <th>Batsman</th><th>Status</th><th>R</th><th>B</th>
        <th>4s</th><th>6s</th><th>SR</th>
      </tr></thead><tbody>`;

    inn.batsmen.forEach((b) => {
      const sr = b.balls > 0 ? ((b.runs / b.balls) * 100).toFixed(1) : '0.0';
      html += `<tr>
        <td class="scorecard-name">${_esc(b.name)}</td>
        <td class="scorecard-dismissal">${_esc(b.dismissal || (b.isOut ? 'out' : 'not out'))}</td>
        <td>${b.runs}</td><td>${b.balls}</td>
        <td>${b.fours || 0}</td><td>${b.sixes || 0}</td><td>${sr}</td>
      </tr>`;
    });

    // Extras row
    const wd = inn.extras?.wides || 0;
    const nb = inn.extras?.noBalls || 0;
    const by = inn.extras?.byes || 0;
    const lb = inn.extras?.legByes || 0;
    html += `</tbody></table>
      <div class="scorecard-extras">Extras: ${wd + nb + by + lb} (wd ${wd}, nb ${nb}, b ${by}, lb ${lb})</div>`;

    // Bowling table
    html += `<table class="scorecard-table">
      <thead><tr>
        <th>Bowler</th><th>O</th><th>M</th><th>R</th><th>W</th><th>Eco</th>
      </tr></thead><tbody>`;

    inn.bowlers.forEach((bw) => {
      const totalBalls = (bw.overs || 0) * 6 + (bw.ballsInOver || 0);
      const eco = totalBalls > 0 ? ((bw.runs / totalBalls) * 6).toFixed(2) : '0.00';
      html += `<tr>
        <td class="scorecard-name">${_esc(bw.name)}</td>
        <td>${bw.overs || 0}.${bw.ballsInOver || 0}</td>
        <td>${bw.maidens || 0}</td>
        <td>${bw.runs || 0}</td>
        <td>${bw.wickets || 0}</td>
        <td>${eco}</td>
      </tr>`;
    });
    html += `</tbody></table></div>`;
  });

  return html;
}

/**
 * Build and return batsman detail HTML.
 * @param {object} batsman  — batsman object from innings
 * @returns {string} HTML
 */
export function buildBatsmanDetailHTML(batsman) {
  if (!batsman) return '';
  const sr = batsman.balls > 0 ? ((batsman.runs / batsman.balls) * 100).toFixed(1) : '0.0';
  let html = `<div class="player-detail-stats">
    <div class="stat-pill"><span>${batsman.runs}</span><label>Runs</label></div>
    <div class="stat-pill"><span>${batsman.balls}</span><label>Balls</label></div>
    <div class="stat-pill"><span>${batsman.fours || 0}</span><label>4s</label></div>
    <div class="stat-pill"><span>${batsman.sixes || 0}</span><label>6s</label></div>
    <div class="stat-pill"><span>${sr}</span><label>SR</label></div>
  </div>`;

  if (batsman.ballHistory?.length) {
    html += `<div class="ball-timeline">`;
    batsman.ballHistory.forEach((b) => {
      html += `<span class="ball-chip ${_esc(b.chipClass)}">${_esc(b.label)}</span>`;
    });
    html += `</div>`;
  }
  return html;
}

/**
 * Build and return bowler detail HTML.
 * @param {object} bowler
 * @returns {string} HTML
 */
export function buildBowlerDetailHTML(bowler) {
  if (!bowler) return '';
  const totalBalls = (bowler.overs || 0) * 6 + (bowler.ballsInOver || 0);
  const eco = totalBalls > 0 ? ((bowler.runs / totalBalls) * 6).toFixed(2) : '0.00';
  let html = `<div class="player-detail-stats">
    <div class="stat-pill"><span>${bowler.overs || 0}.${bowler.ballsInOver || 0}</span><label>Overs</label></div>
    <div class="stat-pill"><span>${bowler.maidens || 0}</span><label>Maidens</label></div>
    <div class="stat-pill"><span>${bowler.runs || 0}</span><label>Runs</label></div>
    <div class="stat-pill"><span>${bowler.wickets || 0}</span><label>Wickets</label></div>
    <div class="stat-pill"><span>${eco}</span><label>Economy</label></div>
  </div>`;

  if (bowler.overHistory?.length) {
    html += `<div class="over-history">`;
    bowler.overHistory.forEach((ov, i) => {
      html += `<div class="over-history-row">
        <span class="over-number">Over ${i + 1}</span>
        <span class="over-runs">${ov.runs} runs</span>
        <span class="over-balls">`;
      (ov.balls || []).forEach((b) => {
        html += `<span class="ball-chip ${_esc(b.chipClass)}">${_esc(b.label)}</span>`;
      });
      html += `</span></div>`;
    });
    html += `</div>`;
  }
  return html;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function _formatOvers(balls) {
  return `${Math.floor(balls / 6)}.${balls % 6}`;
}

function _bowlerFigures(bw) {
  const o = `${bw.overs || 0}.${bw.ballsInOver || 0}`;
  return `${o}-${bw.maidens || 0}-${bw.runs || 0}-${bw.wickets || 0}`;
}

function _esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
