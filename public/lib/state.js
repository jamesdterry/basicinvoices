// Shared app state + tiny event emitter + h() DOM helper.
// Lifted from WEBAPP_PLAYBOOK.md §3.

export const state = {
  currentUser: null,
};

const listeners = new Map();

export function on(key, fn) {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(fn);
  return () => listeners.get(key)?.delete(fn);
}

export function emit(key, value) {
  const set = listeners.get(key);
  if (!set) return;
  for (const fn of set) fn(value);
}

export function set(patch) {
  Object.assign(state, patch);
  for (const k of Object.keys(patch)) emit(k, state[k]);
}

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k in el && typeof v !== 'string') {
      el[k] = v;
    } else {
      el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
