/**
 * src/ui/scorecard.js — Dev 5
 * Scorecard modal content builder and batsman/bowler detail modals.
 * Thin wiring layer over scoreboard.js pure render functions.
 */

import { showModal, hideModal } from './modal.js';
import { buildScorecardHTML, buildBatsmanDetailHTML, buildBowlerDetailHTML } from './scoreboard.js';

async function getStore() {
  try { return await import('../state/store.js'); }
  catch (_) { return { match: null }; }
}

export function initScorecard() {
  // Scorecard modal open
  document.getElementById('scorecard-btn')?.addEventListener('click', _openScorecard);
  document.getElementById('close-scorecard')?.addEventListener('click', () =>
    hideModal('scorecard-modal')
  );

  // Batsman detail — tapping batsman score row
  document.getElementById('striker-score')?.addEventListener('click', () => _openBatsmanDetail('striker'));
  document.getElementById('non-striker-score')?.addEventListener('click', () => _openBatsmanDetail('non-striker'));
  document.getElementById('close-batsman-detail')?.addEventListener('click', () =>
    hideModal('batsman-detail-modal')
  );

  // Bowler detail
  document.getElementById('bowler-figures')?.addEventListener('click', _openBowlerDetail);
  document.getElementById('close-bowler-detail')?.addEventListener('click', () =>
    hideModal('bowler-detail-modal')
  );
}

async function _openScorecard() {
  const store = await getStore();
  const content = document.getElementById('scorecard-content');
  if (content) content.innerHTML = buildScorecardHTML(store.match);
  showModal('scorecard-modal');
}

async function _openBatsmanDetail(role) {
  const store = await getStore();
  const match = store.match;
  if (!match) return;
  const inn = match.innings[match.currentInnings];
  if (!inn) return;
  const idx = role === 'striker' ? inn.strikerIndex : inn.nonStrikerIndex;
  const batsman = inn.batsmen[idx];
  if (!batsman) return;

  const nameEl = document.getElementById('batsman-detail-name');
  if (nameEl) nameEl.textContent = batsman.name;

  const figuresEl = document.getElementById('batsman-detail-figures');
  const timelineEl = document.getElementById('batsman-ball-timeline');
  if (figuresEl) figuresEl.innerHTML = buildBatsmanDetailHTML(batsman);
  if (timelineEl) timelineEl.innerHTML = '';

  showModal('batsman-detail-modal');
}

async function _openBowlerDetail() {
  const store = await getStore();
  const match = store.match;
  if (!match) return;
  const inn = match.innings[match.currentInnings];
  if (!inn || inn.currentBowlerIndex < 0) return;
  const bowler = inn.bowlers[inn.currentBowlerIndex];
  if (!bowler) return;

  const nameEl = document.getElementById('bowler-detail-name');
  if (nameEl) nameEl.textContent = bowler.name;

  const figuresEl = document.getElementById('bowler-detail-figures');
  const historyEl = document.getElementById('bowler-over-history');
  if (figuresEl) figuresEl.innerHTML = buildBowlerDetailHTML(bowler);
  if (historyEl) historyEl.innerHTML = '';

  showModal('bowler-detail-modal');
}
