import { h, set, state } from '/lib/state.js';
import { startRouter } from '/lib/router.js';
import { getJson } from '/lib/api.js';
import { mountNav } from '/components/nav.js';
import { clients } from '/views/clients.js';
import { clientDetail } from '/views/clientDetail.js';
import { projects } from '/views/projects.js';
import { projectDetail } from '/views/projectDetail.js';
import { timeEntries } from '/views/timeEntries.js';
import { invoices } from '/views/invoices.js';
import { invoiceDetail } from '/views/invoiceDetail.js';
import { recurring } from '/views/recurring.js';
import { reports } from '/views/reports.js';
import { branding } from '/views/branding.js';
import { subcontractors } from '/views/subcontractors.js';
import { subcontractorDetail } from '/views/subcontractorDetail.js';

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
        h('p', {},
          user?.role === 'super_admin'
            ? h('a', { href: '#/clients' }, 'Manage clients →')
            : h('a', { href: '#/projects' }, 'Your projects →'),
        ),
      ),
    );
  },
  clients,
  clientDetail,
  projects,
  projectDetail,
  timeEntries,
  invoices,
  invoiceDetail,
  recurring,
  reports,
  branding,
  subcontractors,
  subcontractorDetail,
};

const navHost = document.getElementById('nav');
const mount = document.getElementById('app');

(async () => {
  try {
    const me = await getJson('/api/me');
    set({ currentUser: me });
  } catch {
    return;
  }
  mountNav(state.currentUser, navHost);
  startRouter(handlers, mount);
})();
