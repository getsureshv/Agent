/**
 * src/ui/modal.js — Dev 5
 * Shared modal show/hide utilities.
 * Replaces inline showModal/hideModal from app.js.
 */

/**
 * Show a modal overlay by id.
 * @param {string} id  — element id of the modal div (has class "modal")
 */
export function showModal(id) {
  const el = document.getElementById(id);
  if (!el) {
    console.warn(`[modal] showModal: unknown id "${id}"`);
    return;
  }
  el.classList.remove('hidden');
  // Trap focus inside modal for accessibility
  const focusable = el.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  if (focusable.length) focusable[0].focus();

  // Prevent scroll behind modal
  document.body.classList.add('modal-open');
}

/**
 * Hide a modal overlay by id.
 * @param {string} id
 */
export function hideModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('hidden');
  document.body.classList.remove('modal-open');
}

/**
 * Hide all currently visible modals.
 */
export function hideAllModals() {
  document.querySelectorAll('.modal:not(.hidden)').forEach((m) => {
    m.classList.add('hidden');
  });
  document.body.classList.remove('modal-open');
}

/**
 * Wire up close-on-backdrop-click for all modals.
 * Call once during init.
 */
export function initModals() {
  document.addEventListener('click', (e) => {
    // Click directly on the modal backdrop (not on modal-content)
    if (e.target.classList.contains('modal') && !e.target.classList.contains('hidden')) {
      hideModal(e.target.id);
    }
  });

  // ESC key closes topmost modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const visible = document.querySelector('.modal:not(.hidden)');
      if (visible) hideModal(visible.id);
    }
  });

  // Wire up all .modal-close buttons
  document.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('.modal-close');
    if (closeBtn) {
      const modal = closeBtn.closest('.modal');
      if (modal) hideModal(modal.id);
    }
  });
}
