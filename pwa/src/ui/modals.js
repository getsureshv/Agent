/**
 * src/ui/modals.js — Dev 5
 * Re-exports showModal/hideModal from modal.js + wires all modal-specific listeners
 * that don't belong to individual screen modules.
 * Per ARCHITECTURE.md §4 file tree naming.
 */

export { showModal, hideModal, hideAllModals, initModals } from './modal.js';
