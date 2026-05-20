/**
 * src/ui/settings.js — Dev 5
 * Settings screen: Download offline voice, sign-in nag, app info.
 * Sign-in screen: email field → Dev 4's auth.signIn(email).
 */

import { showScreen } from './screens.js';
import { showModal, hideModal } from './modal.js';

// Dev 3 lazy imports
async function getVoice() {
  try { return await import('../voice/voiceAdapter.js'); }
  catch (_) {
    return {
      isVoskReady: () => false,
      downloadVoskModel: async (cb) => { throw new Error('stub'); },
    };
  }
}
// Dev 4 lazy imports — device-token auth (no magic link)
async function getAuth() {
  try {
    return await import('../sync/auth.js');
  } catch (_) { return null; }
}
async function getOutbox() {
  try { return await import('../sync/outbox.js'); }
  catch (_) { return { getPendingCount: async () => 0 }; }
}

export function initSettings() {
  _initSettingsScreen();
  _initSignInScreen();
}

// ── Settings Screen ───────────────────────────────────────────────────────────

function _initSettingsScreen() {
  document.getElementById('settings-back-btn')?.addEventListener('click', () =>
    showScreen('home-screen', { clearStack: true })
  );

  const downloadBtn  = document.getElementById('download-voice-btn');
  const progressBar  = document.getElementById('voice-download-progress');
  const progressFill = document.getElementById('voice-download-fill');
  const progressText = document.getElementById('voice-download-text');
  const sizeInfo     = document.getElementById('voice-model-size');

  // Check if Vosk already ready
  getVoice().then((voice) => {
    if (voice.isVoskReady()) {
      if (downloadBtn) downloadBtn.textContent = 'Voice: Ready (offline)';
      if (downloadBtn) downloadBtn.disabled = true;
      if (sizeInfo) sizeInfo.textContent = 'Offline voice model: ~44 MB installed';
    }
  });

  downloadBtn?.addEventListener('click', async () => {
    const voice = await getVoice();
    if (voice.isVoskReady()) return;

    downloadBtn.disabled = true;
    downloadBtn.textContent = 'Downloading…';
    if (progressBar) progressBar.style.display = '';

    try {
      await voice.downloadVoskModel((pct) => {
        if (progressFill) progressFill.style.width = `${pct}%`;
        if (progressText) progressText.textContent = `${Math.round(pct)}%`;
      });
      downloadBtn.textContent = 'Voice: Ready (offline)';
      if (progressBar) progressBar.style.display = 'none';
      if (sizeInfo) sizeInfo.textContent = 'Offline voice model: ~44 MB installed';
    } catch (err) {
      downloadBtn.disabled = false;
      downloadBtn.textContent = 'Download Offline Voice';
      if (progressBar) progressBar.style.display = 'none';
      if (err.message !== 'ALREADY_DOWNLOADED') {
        alert('Download failed: ' + err.message);
      }
    }
  });

  // Sign-in navigation
  document.getElementById('settings-signin-btn')?.addEventListener('click', () =>
    showScreen('signin-screen')
  );

  // Check pending count for sign-in nag
  _checkSignInNag();
}

async function _checkSignInNag() {
  const outbox = await getOutbox();
  const count = await outbox.getPendingCount().catch(() => 0);
  const nagEl = document.getElementById('signin-nag');
  if (nagEl && count > 10) {
    nagEl.style.display = '';
    nagEl.textContent = `${count} changes pending. Sign in to sync them.`;
    nagEl.addEventListener('click', () => showScreen('signin-screen'), { once: true });
  }
}

// ── Sign-In Screen ────────────────────────────────────────────────────────────

function _initSignInScreen() {
  document.getElementById('signin-back-btn')?.addEventListener('click', () =>
    showScreen('settings-screen')
  );

  document.getElementById('signin-submit-btn')?.addEventListener('click', _submitSignIn);
  document.getElementById('signin-email-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') _submitSignIn();
  });

  document.getElementById('signin-anon-btn')?.addEventListener('click', () => {
    showScreen('home-screen', { clearStack: true });
  });
}

async function _submitSignIn() {
  const emailInput = document.getElementById('signin-email-input');
  const email = emailInput?.value.trim();
  const statusEl = document.getElementById('signin-status');

  if (!email || !email.includes('@')) {
    if (statusEl) { statusEl.textContent = 'Please enter a valid email address.'; statusEl.className = 'signin-status error'; }
    return;
  }

  if (statusEl) { statusEl.textContent = 'Sending sign-in link…'; statusEl.className = 'signin-status'; }

  const auth = await getAuth();
  if (!auth) {
    if (statusEl) { statusEl.textContent = 'Auth not available — using anonymous mode.'; statusEl.className = 'signin-status'; }
    setTimeout(() => showScreen('home-screen', { clearStack: true }), 1500);
    return;
  }

  try {
    // Device-token auth — auto-register this device
    const token = await auth.getDeviceToken();
    if (statusEl) {
      statusEl.textContent = `Device registered. Token stored. Sync is active.`;
      statusEl.className = 'signin-status success';
    }
    setTimeout(() => showScreen('home-screen', { clearStack: true }), 1500);
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = 'Registration error: ' + err.message;
      statusEl.className = 'signin-status error';
    }
  }
}
