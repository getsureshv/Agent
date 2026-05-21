import { auth } from '/shared/auth.js';
import { el, clear } from '/shared/ui.js';

export function renderLogin(view, ctx, opts = {}) {
  let mode = 'login';
  const container = el('div', { class: 'auth-container card' });

  function render() {
    clear(container);
    container.appendChild(el('div', { class: 'tabs' }, [
      el('button', {
        class: 'tab' + (mode === 'login' ? ' active' : ''),
        onClick: () => { mode = 'login'; render(); },
      }, 'Sign in'),
      el('button', {
        class: 'tab' + (mode === 'signup' ? ' active' : ''),
        onClick: () => { mode = 'signup'; render(); },
      }, 'Create account'),
    ]));

    const errBox = el('div', { class: 'err' });
    const emailInput = el('input', { type: 'email', required: true,
      autocomplete: 'email', value: opts.email || '' });
    const passwordInput = el('input', { type: 'password', required: true,
      autocomplete: mode === 'login' ? 'current-password' : 'new-password' });
    const nameInput = el('input', { type: 'text', autocomplete: 'name' });

    const fields = [];
    fields.push(el('label', {}, 'Email'), emailInput);
    if (mode === 'signup') fields.push(el('label', {}, 'Name'), nameInput);
    fields.push(el('label', {}, 'Password'), passwordInput);
    fields.push(errBox);

    const submitBtn = el('button', { type: 'submit', class: 'btn' },
      mode === 'login' ? 'Sign in' : 'Create account');
    fields.push(submitBtn);

    const form = el('form', {
      onSubmit: async (e) => {
        e.preventDefault();
        errBox.textContent = '';
        submitBtn.disabled = true;
        try {
          if (mode === 'login') {
            await auth.login(emailInput.value.trim(), passwordInput.value);
          } else {
            await auth.signup(emailInput.value.trim(), passwordInput.value, nameInput.value.trim());
          }
          await ctx.refreshMe();
          if (opts.onSuccess) return opts.onSuccess();
          ctx.navigate('#/dashboard');
        } catch (err) {
          errBox.textContent = err.message || 'Login failed';
          submitBtn.disabled = false;
        }
      },
    }, fields);
    container.appendChild(form);

    if (opts.subtitle) {
      container.appendChild(el('p', { class: 'muted', style: 'margin-top: 12px; font-size: 0.85rem;' }, opts.subtitle));
    }
  }

  render();
  view.appendChild(container);
}
