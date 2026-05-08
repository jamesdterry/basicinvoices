import { h } from '/lib/state.js';
import { postJson } from '/lib/api.js';

function navLink(href, label, currentHash) {
  const active = currentHash === href;
  return h('a', { href, class: active ? 'active' : '' }, label);
}

export function Nav(user) {
  if (!user) return h('div');
  const currentHash = window.location.hash || '#/';
  const links = [];
  links.push(navLink('#/', 'Home', currentHash));
  if (user.role === 'super_admin') {
    links.push(navLink('#/clients', 'Clients', currentHash));
  }
  links.push(navLink('#/projects', 'Projects', currentHash));
  links.push(navLink('#/time-entries', user.role === 'super_admin' ? 'Time' : 'My hours', currentHash));
  if (user.role === 'super_admin') {
    links.push(navLink('#/invoices', 'Invoices', currentHash));
    links.push(navLink('#/recurring', 'Recurring', currentHash));
    links.push(navLink('#/reports', 'Reports', currentHash));
    links.push(navLink('#/subcontractors', 'Subs', currentHash));
    links.push(navLink('#/branding', 'Branding', currentHash));
  }

  return h('nav', { class: 'row' },
    h('span', { class: 'brand' }, 'Basic Invoices'),
    ...links,
    h('span', { class: 'spacer' }),
    h('span', { class: 'muted' }, user.email),
    h('button', {
      class: 'btn secondary',
      onclick: async () => {
        try { await postJson('/auth/logout'); } catch {}
        window.location.assign('/login.html');
      },
    }, 'Sign out'),
  );
}

export function mountNav(user, host) {
  const render = () => host.replaceChildren(Nav(user));
  render();
  window.addEventListener('hashchange', render);
}
