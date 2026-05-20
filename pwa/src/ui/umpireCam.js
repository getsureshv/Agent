/**
 * src/ui/umpireCam.js — Dev 5
 * Camera tile + debug panel.
 * Calls Dev 3's initUmpirePose / stopUmpirePose.
 * Handles landscape layout (CSS companion: mobile.css).
 */

import { showScreen } from './screens.js';

// ── Dev 3 lazy import ─────────────────────────────────────────────────────────
async function getUmpirePose() {
  try {
    return await import('../vendor/umpirePose.js');
  } catch (_) {
    return {
      initUmpirePose: (v, c, cb) => console.warn('[umpireCam] umpirePose stub'),
      stopUmpirePose: () => {},
      isUmpirePoseActive: () => false,
    };
  }
}

// ── State ─────────────────────────────────────────────────────────────────────
let _camActive = false;
let _pendingCmd = null;
let _debugFrameCount = 0;
const DEBUG_MAX_LINES = 120;

/** Wire all umpire cam event handlers. */
export function initUmpireCam() {
  const toggleBtn = document.getElementById('umpire-cam-toggle');
  const closeBtn  = document.getElementById('umpire-cam-close');
  const confirmYes = document.getElementById('umpire-confirm-yes');
  const confirmNo  = document.getElementById('umpire-confirm-no');

  if (!toggleBtn) return; // Not on scoring screen

  toggleBtn.addEventListener('click', () => {
    _camActive ? _stopCam() : _startCam();
  });

  closeBtn?.addEventListener('click', _stopCam);

  confirmYes?.addEventListener('click', async () => {
    if (_pendingCmd) {
      await _applySignal(_pendingCmd);
      _pendingCmd = null;
      _hideConfirm();
    }
  });

  confirmNo?.addEventListener('click', () => {
    _pendingCmd = null;
    _hideConfirm();
    _setSignalStatus('Signal dismissed — watching for next', '#78909c');
  });

  // Debug toggle checkbox
  document.getElementById('umpire-debug-toggle-cb')?.addEventListener('change', (e) => {
    const entries = document.getElementById('umpire-debug-entries');
    if (entries) entries.style.display = e.target.checked ? '' : 'none';
  });
}

// ── Camera lifecycle ──────────────────────────────────────────────────────────

async function _startCam() {
  const panel     = document.getElementById('umpire-cam-panel');
  const toggleBtn = document.getElementById('umpire-cam-toggle');
  const video     = document.getElementById('umpire-video');
  const canvas    = document.getElementById('umpire-canvas');

  panel?.classList.remove('hidden');
  _camActive = true;
  _debugFrameCount = 0;

  const entries = document.getElementById('umpire-debug-entries');
  if (entries) entries.innerHTML = '';

  if (toggleBtn) toggleBtn.textContent = 'Stop Umpire Cam';
  _setSignalStatus('Starting camera…', '#78909c');
  _dbg('Initialising MediaPipe Pose…');

  const umpirePose = await getUmpirePose();

  if (!video || !canvas) {
    _dbg('ERROR: video/canvas elements not found', 'dbg-error');
    return;
  }

  try {
    umpirePose.initUmpirePose(video, canvas, _onSignalDetected);
    _setSignalStatus('Point camera at umpire and watch for signals');
    _dbg('Camera ready. Watching for signals.', 'dbg-ok');
  } catch (err) {
    _setSignalStatus('Camera error: ' + err.message, '#ef5350');
    _dbg('ERROR: ' + err.message, 'dbg-error');
    _camActive = false;
    if (toggleBtn) toggleBtn.textContent = 'Umpire Cam';
    panel?.classList.add('hidden');
  }
}

async function _stopCam() {
  const panel     = document.getElementById('umpire-cam-panel');
  const toggleBtn = document.getElementById('umpire-cam-toggle');

  panel?.classList.add('hidden');
  _camActive = false;

  if (toggleBtn) {
    toggleBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="23 7 16 12 23 17 23 7"/>
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
    </svg> Umpire Cam`;
  }

  const umpirePose = await getUmpirePose();
  umpirePose.stopUmpirePose();
  _dbg('Camera stopped.');
}

// ── Signal handling ───────────────────────────────────────────────────────────

/**
 * Called by Dev 3's initUmpirePose onSignal callback.
 * @param {{ action: string, type?: string, runs?: number }} cmd
 */
function _onSignalDetected(cmd) {
  if (!cmd) return;
  _pendingCmd = cmd;
  _dbg(`Signal detected: ${_describeCmd(cmd)}`, 'dbg-ok');
  _setSignalStatus('Signal: ' + _describeCmd(cmd));

  const overlay = document.getElementById('umpire-signal-overlay');
  const label   = document.getElementById('umpire-signal-label');
  if (overlay && label) {
    label.textContent = _describeCmd(cmd);
    overlay.classList.remove('hidden');
    setTimeout(() => overlay.classList.add('hidden'), 2000);
  }

  const confirmEl = document.getElementById('umpire-confirm');
  const confirmText = document.getElementById('umpire-confirm-text');
  if (confirmEl && confirmText) {
    confirmText.textContent = `Apply signal: ${_describeCmd(cmd)}?`;
    confirmEl.classList.remove('hidden');
  }
}

async function _applySignal(cmd) {
  // Re-use scoring.js executeVoiceCommand by dispatching an event
  window.dispatchEvent(new CustomEvent('scoring:executeCommand', { detail: cmd }));
  _setSignalStatus(`Applied: ${_describeCmd(cmd)}`, '#a5d6a7');
  _dbg(`Applied: ${_describeCmd(cmd)}`, 'dbg-ok');
}

function _hideConfirm() {
  document.getElementById('umpire-confirm')?.classList.add('hidden');
}

// ── Debug log ─────────────────────────────────────────────────────────────────

function _dbg(html, cssClass) {
  const entries = document.getElementById('umpire-debug-entries');
  const toggleCb = document.getElementById('umpire-debug-toggle-cb');
  if (!entries || (toggleCb && !toggleCb.checked)) return;

  _debugFrameCount++;
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const line = document.createElement('div');
  line.className = cssClass || '';
  line.innerHTML = `<span class="dbg-frame">[${ts}]</span> ${html}`;
  entries.appendChild(line);

  // Trim old lines
  while (entries.childElementCount > DEBUG_MAX_LINES) {
    entries.removeChild(entries.firstChild);
  }
  entries.scrollTop = entries.scrollHeight;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _setSignalStatus(text, color) {
  const el = document.getElementById('umpire-signal-status');
  if (!el) return;
  el.textContent = text;
  if (color) el.style.color = color;
}

function _describeCmd(cmd) {
  if (!cmd) return 'Unknown';
  const wNames = { bowled: 'Bowled', caught: 'Caught', lbw: 'LBW', runout: 'Run Out', stumped: 'Stumped' };
  switch (cmd.action) {
    case 'runs':  return `${cmd.runs} runs`;
    case 'extra': return cmd.type === 'wide' ? 'Wide' : cmd.type === 'noball' ? 'No Ball' : cmd.type;
    case 'wicket': return 'Wicket — ' + (wNames[cmd.type] || cmd.type);
    default: return cmd.action;
  }
}
