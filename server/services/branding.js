// Branding service. Singleton row in `branding` table — get is unauthenticated
// (the public invoice template needs it from inside the /i/<token> render
// path, which has no session). Mutations are super-admin only.
//
// Address normalization: CRLF → LF, leading/trailing blank lines stripped,
// interior preserved. The template renders \n → <br /> via the same
// esc()+replace pattern already used for client.billing_address.
//
// Logo bytes are stored in SQLite. 256 KB cap at the service layer keeps PDF
// bloat bounded; the schema only enforces the allowed mime list.

import { logAction } from './audit.js';

const HEX_RX = /^#[0-9A-Fa-f]{6}$/;
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']);
const NAME_MAX = 120;
const ADDRESS_MAX = 500;
export const LOGO_MAX_BYTES = 256 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function isSuperAdmin(actor) {
  return actor?.role === 'super_admin';
}

function normalizeAddress(s) {
  if (s == null) return '';
  return String(s)
    .replace(/\r\n?/g, '\n')
    .replace(/^\s*\n+/, '')
    .replace(/\n+\s*$/, '');
}

function escapeForAudit(s) {
  if (s == null) return s;
  // Keep audit_changes single-line scannable.
  return String(s).replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

export function get(db) {
  const row = db
    .prepare(
      `SELECT company_name, business_address, accent_color_hex,
              logo_filename, logo_mime, updated_at,
              (logo_bytes IS NOT NULL) AS has_logo
         FROM branding WHERE id = 1`
    )
    .get();
  if (!row) {
    return {
      companyName: '',
      businessAddress: '',
      accentColorHex: '#2a6df4',
      hasLogo: false,
      logoFilename: null,
      logoMime: null,
      updatedAt: '1970-01-01T00:00:00.000Z',
    };
  }
  return {
    companyName: row.company_name,
    businessAddress: row.business_address,
    accentColorHex: row.accent_color_hex,
    hasLogo: !!row.has_logo,
    logoFilename: row.logo_filename,
    logoMime: row.logo_mime,
    updatedAt: row.updated_at,
  };
}

export function getLogo(db) {
  const row = db
    .prepare(
      `SELECT logo_filename AS filename, logo_mime AS mime,
              logo_bytes    AS bytes,    updated_at
         FROM branding WHERE id = 1`
    )
    .get();
  if (!row || !row.bytes) return null;
  return row;
}

export function update(db, patch = {}, { actor, ip } = {}) {
  if (!isSuperAdmin(actor)) return { ok: false, reason: 'forbidden' };

  const existing = get(db);
  const next = {
    companyName: existing.companyName,
    businessAddress: existing.businessAddress,
    accentColorHex: existing.accentColorHex,
  };

  if (patch.company_name !== undefined || patch.companyName !== undefined) {
    const raw = String(patch.company_name ?? patch.companyName ?? '').trim();
    if (raw.length > NAME_MAX) return { ok: false, reason: 'name_too_long' };
    next.companyName = raw;
  }
  if (patch.business_address !== undefined || patch.businessAddress !== undefined) {
    const normalized = normalizeAddress(patch.business_address ?? patch.businessAddress);
    if (normalized.length > ADDRESS_MAX) return { ok: false, reason: 'address_too_long' };
    next.businessAddress = normalized;
  }
  if (patch.accent_color_hex !== undefined || patch.accentColorHex !== undefined) {
    const raw = String(patch.accent_color_hex ?? patch.accentColorHex ?? '').trim();
    if (!HEX_RX.test(raw)) return { ok: false, reason: 'invalid_color' };
    next.accentColorHex = raw;
  }

  const changes = [];
  if (existing.companyName !== next.companyName) {
    changes.push({
      field: 'company_name',
      oldValue: existing.companyName,
      newValue: next.companyName,
    });
  }
  if (existing.businessAddress !== next.businessAddress) {
    changes.push({
      field: 'business_address',
      oldValue: escapeForAudit(existing.businessAddress),
      newValue: escapeForAudit(next.businessAddress),
    });
  }
  if (existing.accentColorHex !== next.accentColorHex) {
    changes.push({
      field: 'accent_color_hex',
      oldValue: existing.accentColorHex,
      newValue: next.accentColorHex,
    });
  }

  if (!changes.length) return { ok: true, branding: existing };

  const at = nowIso();
  const run = db.transaction(() => {
    db.prepare(
      `UPDATE branding
          SET company_name = ?, business_address = ?, accent_color_hex = ?, updated_at = ?
        WHERE id = 1`
    ).run(next.companyName, next.businessAddress, next.accentColorHex, at);

    logAction(db, {
      actorId: actor.id,
      action: 'branding.update',
      targetKind: 'branding',
      targetId: 1,
      summary: 'Updated invoice branding',
      ip,
      changes,
    });
  });
  run();

  return { ok: true, branding: get(db) };
}

export function setLogo(db, { filename, mime, bytes } = {}, { actor, ip } = {}) {
  if (!isSuperAdmin(actor)) return { ok: false, reason: 'forbidden' };
  if (!mime || !ALLOWED_MIME.has(mime)) return { ok: false, reason: 'invalid_mime' };
  if (!bytes || bytes.length === 0) return { ok: false, reason: 'logo_required' };
  if (bytes.length > LOGO_MAX_BYTES) return { ok: false, reason: 'logo_too_large' };

  const cleanedName =
    filename == null ? null : String(filename).trim().slice(0, 200) || null;

  const at = nowIso();
  const run = db.transaction(() => {
    db.prepare(
      `UPDATE branding
          SET logo_filename = ?, logo_mime = ?, logo_bytes = ?, updated_at = ?
        WHERE id = 1`
    ).run(cleanedName, mime, bytes, at);

    logAction(db, {
      actorId: actor.id,
      action: 'branding.set_logo',
      targetKind: 'branding',
      targetId: 1,
      summary: `Uploaded invoice logo (${mime}, ${bytes.length} bytes)`,
      ip,
      meta: { filename: cleanedName, mime, bytes: bytes.length },
    });
  });
  run();

  return { ok: true, branding: get(db) };
}

export function clearLogo(db, { actor, ip } = {}) {
  if (!isSuperAdmin(actor)) return { ok: false, reason: 'forbidden' };
  const existing = get(db);
  if (!existing.hasLogo) return { ok: true, branding: existing };

  const at = nowIso();
  const run = db.transaction(() => {
    db.prepare(
      `UPDATE branding
          SET logo_filename = NULL, logo_mime = NULL, logo_bytes = NULL, updated_at = ?
        WHERE id = 1`
    ).run(at);

    logAction(db, {
      actorId: actor.id,
      action: 'branding.clear_logo',
      targetKind: 'branding',
      targetId: 1,
      summary: 'Removed invoice logo',
      ip,
    });
  });
  run();

  return { ok: true, branding: get(db) };
}
