// Small DOM helpers: el(), modal(), toast(), copy().

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in node && typeof v !== 'object') node[k] = v;
    else node.setAttribute(k, v);
  }
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function modal(title, body, actions = []) {
  const root = document.getElementById('modal-root');
  clear(root);
  const close = () => clear(root);
  const back = el('div', { class: 'modal-backdrop',
    onClick: (e) => { if (e.target === back) close(); },
  });
  const m = el('div', { class: 'modal' });
  m.appendChild(el('h2', {}, title));
  m.appendChild(body);
  const actionsRow = el('div', { class: 'modal-actions' });
  for (const a of actions) {
    actionsRow.appendChild(el('button', {
      class: a.class || 'btn',
      onClick: () => a.onClick(close),
    }, a.label));
  }
  if (actions.length === 0) {
    actionsRow.appendChild(el('button', { class: 'btn btn-secondary', onClick: close }, 'Close'));
  }
  m.appendChild(actionsRow);
  back.appendChild(m);
  root.appendChild(back);
  return { close };
}

export function toast(message, kind = 'success') {
  const root = document.getElementById('toast-root');
  const t = el('div', { class: `toast ${kind}` }, message);
  t.style.pointerEvents = 'auto';
  root.appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity 0.3s';
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 300);
  }, 1500);
}

export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied!');
  } catch {
    // fallback for non-https contexts
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('Copied!'); }
    catch { toast('Copy failed', 'error'); }
    ta.remove();
  }
}

export function fmtDate(d) {
  if (!d) return '';
  const date = new Date(d);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleString();
}
