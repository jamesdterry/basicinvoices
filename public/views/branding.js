import { h, state, set } from '/lib/state.js';
import { getJson, patchJson, deleteJson } from '/lib/api.js';

const CSRF_COOKIE = 'bi_csrf';

function readCookie(name) {
  const target = `${name}=`;
  for (const part of (document.cookie || '').split('; ')) {
    if (part.startsWith(target)) return decodeURIComponent(part.slice(target.length));
  }
  return '';
}

async function uploadLogo(file) {
  const fd = new FormData();
  fd.append('logo', file);
  const res = await fetch('/api/branding/logo', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'x-csrf-token': readCookie(CSRF_COOKIE) },
    body: fd,
  });
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error(typeof body === 'string' ? body : body?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

const ERRORS = {
  invalid_color: 'Accent color must be in #RRGGBB hex format.',
  address_too_long: 'Business address must be 500 characters or fewer.',
  name_too_long: 'Name must be 120 characters or fewer.',
  name_required: 'Name cannot be empty.',
  invalid_mime: 'Logo must be PNG, JPEG, or SVG.',
  logo_too_large: 'Logo must be 256 KB or smaller.',
  logo_required: 'Pick a file before uploading.',
  forbidden: 'Branding is editable by super-admins only.',
};

function errorText(err) {
  const code = err?.body?.error || err?.message;
  return ERRORS[code] || code || 'Something went wrong.';
}

export async function branding(_params, mount) {
  const viewer = state.currentUser;
  if (!viewer) return;
  if (viewer.role !== 'super_admin') {
    mount.replaceChildren(
      h('main', { class: 'wide stack' },
        h('h1', {}, 'Branding'),
        h('p', { class: 'muted' }, 'Branding is editable by super-admins only.'),
      ),
    );
    return;
  }

  mount.replaceChildren(
    h('main', { class: 'wide stack' }, h('p', { class: 'muted' }, 'Loading…'))
  );

  let b;
  let previewId = null;
  try {
    const r = await getJson('/api/branding');
    b = r.branding;
  } catch (err) {
    mount.replaceChildren(
      h('main', { class: 'wide stack' },
        h('h1', {}, 'Branding'),
        h('p', { class: 'error' }, errorText(err)),
      ),
    );
    return;
  }
  try {
    const list = await getJson('/api/invoices');
    previewId = list.invoices?.[0]?.id ?? null;
  } catch {}

  let cacheBuster = Date.now();

  function bumpPreview() {
    cacheBuster = Date.now();
  }

  function render() {
    const formError = h('p', { class: 'error', hidden: true });
    const logoError = h('p', { class: 'error', hidden: true });
    const profileError = h('p', { class: 'error', hidden: true });

    // Profile / display_name. Snapshotted into invoice line descriptions
    // (services/invoices.js) at draft time — old invoices keep their old text.
    const displayNameInput = h('input', {
      type: 'text',
      class: 'input',
      maxlength: '120',
      value: state.currentUser?.display_name || '',
      placeholder: 'Jane Smith',
    });
    const profileSaveBtn = h('button', { type: 'submit', class: 'btn' }, 'Save');
    const profileForm = h('form', {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        profileError.hidden = true;
        profileSaveBtn.disabled = true;
        try {
          const me = await patchJson('/api/me', {
            display_name: displayNameInput.value,
          });
          set({ currentUser: me });
          bumpPreview();
          render();
        } catch (err) {
          profileError.textContent = errorText(err);
          profileError.hidden = false;
          profileSaveBtn.disabled = false;
        }
      },
    },
      h('h2', {}, 'Your name on invoices'),
      h('label', { class: 'field' },
        h('span', {}, 'Display name'),
        displayNameInput,
        h('small', { class: 'muted' },
          'Shown next to each time entry on freshly drafted invoices. ' +
          'Existing invoice lines are unchanged.'),
      ),
      h('div', { class: 'row' }, profileSaveBtn, profileError),
    );

    const nameInput = h('input', {
      type: 'text',
      class: 'input',
      maxlength: '120',
      value: b.companyName || '',
      placeholder: 'Acme Consulting',
    });
    const addressInput = h('textarea', {
      class: 'input',
      maxlength: '500',
      rows: '4',
      placeholder: '123 Main St\nAnytown, CA 90210\nUSA',
    });
    addressInput.value = b.businessAddress || '';
    const colorInput = h('input', {
      type: 'color',
      value: b.accentColorHex || '#2a6df4',
    });
    const swatch = h('span', {
      class: 'branding-swatch',
      title: b.accentColorHex,
    });
    swatch.style.background = b.accentColorHex || '#2a6df4';
    colorInput.addEventListener('input', () => {
      swatch.style.background = colorInput.value;
      swatch.title = colorInput.value;
    });

    const saveBtn = h('button', { type: 'submit', class: 'btn' }, 'Save');

    const settingsForm = h('form', {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        formError.hidden = true;
        saveBtn.disabled = true;
        try {
          const r = await patchJson('/api/branding', {
            company_name: nameInput.value,
            business_address: addressInput.value,
            accent_color_hex: colorInput.value,
          });
          b = r.branding;
          bumpPreview();
          render();
        } catch (err) {
          formError.textContent = errorText(err);
          formError.hidden = false;
          saveBtn.disabled = false;
        }
      },
    },
      h('h2', {}, 'Company details'),
      h('label', { class: 'field' },
        h('span', {}, 'Company name'),
        nameInput,
      ),
      h('label', { class: 'field' },
        h('span', {}, 'Business address'),
        addressInput,
        h('small', { class: 'muted' },
          'One line per row — street, city/state/zip, country. Renders on every invoice.'),
      ),
      h('label', { class: 'field' },
        h('span', {}, 'Accent color'),
        h('span', { class: 'row' }, colorInput, swatch),
        h('small', { class: 'muted' },
          'Used for status badges, totals row, and the Pay-online button.'),
      ),
      h('div', { class: 'row' }, saveBtn, formError),
    );

    // Logo block
    const fileInput = h('input', {
      type: 'file',
      accept: 'image/png,image/jpeg,image/svg+xml',
    });
    const uploadBtn = h('button', { type: 'submit', class: 'btn' }, 'Upload logo');
    const removeBtn = h('button', {
      type: 'button',
      class: 'btn danger',
      hidden: !b.hasLogo,
      onclick: async () => {
        logoError.hidden = true;
        removeBtn.disabled = true;
        try {
          const r = await deleteJson('/api/branding/logo');
          b = r.branding;
          bumpPreview();
          render();
        } catch (err) {
          logoError.textContent = errorText(err);
          logoError.hidden = false;
          removeBtn.disabled = false;
        }
      },
    }, 'Remove logo');

    const logoForm = h('form', {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        logoError.hidden = true;
        const file = fileInput.files?.[0];
        if (!file) {
          logoError.textContent = ERRORS.logo_required;
          logoError.hidden = false;
          return;
        }
        uploadBtn.disabled = true;
        try {
          const r = await uploadLogo(file);
          b = r.branding;
          bumpPreview();
          render();
        } catch (err) {
          logoError.textContent = errorText(err);
          logoError.hidden = false;
          uploadBtn.disabled = false;
        }
      },
    },
      h('h2', {}, 'Logo'),
      b.hasLogo
        ? h('img', {
            class: 'branding-thumb',
            src: `/branding/logo?v=${cacheBuster}`,
            alt: 'Current logo',
          })
        : h('p', { class: 'muted' }, 'No logo set.'),
      b.hasLogo && b.logoMime === 'image/webp'
        ? h('p', { class: 'error' },
            'Your logo is WebP. It shows on the web invoice but not on the ' +
            'PDF — re-upload as PNG, JPEG, or SVG to fix.')
        : null,
      h('label', { class: 'field' },
        h('span', {}, 'Image (PNG, JPEG, or SVG, ≤ 256 KB)'),
        fileInput,
      ),
      h('div', { class: 'row' }, uploadBtn, removeBtn, logoError),
    );

    const previewPane = previewId
      ? h('iframe', {
          class: 'branding-preview',
          src: `/api/invoices/${previewId}/preview?v=${cacheBuster}`,
          title: 'Invoice preview',
        })
      : h('p', { class: 'muted' },
          'Create an invoice to see a live preview of these branding changes.');

    mount.replaceChildren(
      h('main', { class: 'wide stack' },
        h('h1', {}, 'Branding'),
        h('p', { class: 'muted' },
          'Settings on this page appear on every invoice (HTML, PDF, and emailed copy).'),
        h('div', { class: 'branding-grid' },
          h('div', { class: 'stack' },
            profileForm,
            settingsForm,
            logoForm,
          ),
          h('div', { class: 'stack' },
            h('h2', {}, 'Live preview'),
            previewPane,
          ),
        ),
      ),
    );
  }

  render();
}
