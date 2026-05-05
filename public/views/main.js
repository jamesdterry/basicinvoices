import { h } from '/lib/state.js';
import { startRouter } from '/lib/router.js';

const handlers = {
  home(_params, mount) {
    mount.replaceChildren(
      h('main', { class: 'stack' },
        h('h1', {}, 'Basic Invoices'),
        h('p', { class: 'muted' }, 'Stage 0 scaffold. Auth lands in Stage 1.')
      )
    );
  },
};

const mount = document.getElementById('app');
startRouter(handlers, mount);
