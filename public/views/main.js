import { h, set, state } from '/lib/state.js';
import { startRouter } from '/lib/router.js';
import { getJson, postJson } from '/lib/api.js';

const handlers = {
  home(_params, mount) {
    const user = state.currentUser;
    mount.replaceChildren(
      h('main', { class: 'stack' },
        h('h1', {}, 'Basic Invoices'),
        user
          ? h('p', { class: 'muted' },
              `Signed in as ${user.display_name} (${user.email}) — role: ${user.role}.`
            )
          : h('p', { class: 'muted' }, 'Loading…'),
        h('button', {
          class: 'btn',
          onclick: async () => {
            await postJson('/auth/logout');
            window.location.assign('/login.html');
          },
        }, 'Sign out')
      )
    );
  },
};

const mount = document.getElementById('app');

(async () => {
  try {
    const me = await getJson('/api/me');
    set({ currentUser: me });
  } catch {
    // 401 path is handled inside api.js (redirect to /login.html).
    return;
  }
  startRouter(handlers, mount);
})();
