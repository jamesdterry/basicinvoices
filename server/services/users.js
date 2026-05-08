// Users service. Read-only listing for the "add member" picker plus the
// super-admin subcontractor admin page (invite / rename / disable).

import { logAction } from './audit.js';

const ALLOWED_ROLES = new Set(['super_admin', 'subcontractor']);
const DISPLAY_NAME_MAX = 120;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function nowIso() {
  return new Date().toISOString();
}

function rowToSub(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    role: row.role,
    disabled_at: row.disabled_at,
    last_seen_at: row.last_seen_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listByRole(db, role) {
  if (!ALLOWED_ROLES.has(role)) return [];
  return db
    .prepare(
      `SELECT id, email, display_name, role, disabled_at
         FROM users
        WHERE role = ? AND disabled_at IS NULL
        ORDER BY display_name COLLATE NOCASE`
    )
    .all(role);
}

// All subcontractors, active first then disabled, each group alphabetised.
export function listAll(db) {
  return db
    .prepare(
      `SELECT id, email, display_name, role, disabled_at, last_seen_at, created_at, updated_at
         FROM users
        WHERE role = 'subcontractor'
        ORDER BY (disabled_at IS NULL) DESC, display_name COLLATE NOCASE`
    )
    .all()
    .map(rowToSub);
}

export function getById(db, id) {
  const row = db
    .prepare(
      `SELECT id, email, display_name, role, disabled_at, last_seen_at, created_at, updated_at
         FROM users
        WHERE id = ? AND role = 'subcontractor'`
    )
    .get(id);
  return rowToSub(row);
}

// display_name is snapshotted into invoice_lines.description at draft
// creation (services/invoices.js), so changes here only affect invoices
// drafted afterward — existing line text is frozen.
export function updateProfile(db, userId, patch = {}, { actor, ip } = {}) {
  if (!actor || actor.id !== userId) return { ok: false, reason: 'forbidden' };

  const existing = db
    .prepare('SELECT id, email, display_name FROM users WHERE id = ?')
    .get(userId);
  if (!existing) return { ok: false, reason: 'not_found' };

  const next = { displayName: existing.display_name };

  if (patch.display_name !== undefined || patch.displayName !== undefined) {
    const raw = String(patch.display_name ?? patch.displayName ?? '').trim();
    if (!raw) return { ok: false, reason: 'name_required' };
    if (raw.length > DISPLAY_NAME_MAX) return { ok: false, reason: 'name_too_long' };
    next.displayName = raw;
  }

  if (next.displayName === existing.display_name) {
    return { ok: true, user: existing };
  }

  const at = new Date().toISOString();
  const run = db.transaction(() => {
    db.prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?')
      .run(next.displayName, at, userId);

    logAction(db, {
      actorId: actor.id,
      action: 'user.update_profile',
      targetKind: 'user',
      targetId: userId,
      summary: `Updated profile for ${existing.email}`,
      ip,
      changes: [
        {
          field: 'display_name',
          oldValue: existing.display_name,
          newValue: next.displayName,
        },
      ],
    });
  });
  run();

  return {
    ok: true,
    user: { id: existing.id, email: existing.email, display_name: next.displayName },
  };
}

export function createSubcontractor(db, input = {}, { actor, ip } = {}) {
  if (!actor || actor.role !== 'super_admin') return { ok: false, reason: 'forbidden' };

  const email = String(input.email ?? '').trim();
  if (!email) return { ok: false, reason: 'email_required' };
  if (!EMAIL_RE.test(email)) return { ok: false, reason: 'invalid_email' };

  const displayName = String(input.display_name ?? input.displayName ?? '').trim();
  if (!displayName) return { ok: false, reason: 'name_required' };
  if (displayName.length > DISPLAY_NAME_MAX) return { ok: false, reason: 'name_too_long' };

  const existing = db
    .prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE')
    .get(email);
  if (existing) return { ok: false, reason: 'email_taken' };

  const at = nowIso();
  let userId;
  db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO users (email, display_name, role, created_at, updated_at)
         VALUES (?, ?, 'subcontractor', ?, ?)`
      )
      .run(email, displayName, at, at);
    userId = Number(info.lastInsertRowid);

    logAction(db, {
      actorId: actor.id,
      action: 'user.create',
      targetKind: 'user',
      targetId: userId,
      summary: `Invited subcontractor ${email}`,
      ip,
    });
  })();

  return { ok: true, user: getById(db, userId) };
}

export function updateSubcontractor(db, id, patch = {}, { actor, ip } = {}) {
  if (!actor || actor.role !== 'super_admin') return { ok: false, reason: 'forbidden' };

  const existing = getById(db, id);
  if (!existing) return { ok: false, reason: 'not_found' };

  let nextName = existing.display_name;
  if (patch.display_name !== undefined || patch.displayName !== undefined) {
    const raw = String(patch.display_name ?? patch.displayName ?? '').trim();
    if (!raw) return { ok: false, reason: 'name_required' };
    if (raw.length > DISPLAY_NAME_MAX) return { ok: false, reason: 'name_too_long' };
    nextName = raw;
  }

  if (nextName === existing.display_name) {
    return { ok: true, user: existing };
  }

  const at = nowIso();
  db.transaction(() => {
    db.prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?')
      .run(nextName, at, id);

    logAction(db, {
      actorId: actor.id,
      action: 'user.update',
      targetKind: 'user',
      targetId: id,
      summary: `Updated subcontractor ${existing.email}`,
      ip,
      changes: [
        { field: 'display_name', oldValue: existing.display_name, newValue: nextName },
      ],
    });
  })();

  return { ok: true, user: getById(db, id) };
}

export function setDisabled(db, id, disabled, { actor, ip } = {}) {
  if (!actor || actor.role !== 'super_admin') return { ok: false, reason: 'forbidden' };

  const existing = getById(db, id);
  if (!existing) return { ok: false, reason: 'not_found' };

  const wantDisabled = !!disabled;
  const isDisabled = !!existing.disabled_at;
  if (wantDisabled === isDisabled) return { ok: true, user: existing, noop: true };

  const at = nowIso();
  db.transaction(() => {
    if (wantDisabled) {
      db.prepare('UPDATE users SET disabled_at = ?, updated_at = ? WHERE id = ?')
        .run(at, at, id);
      // Drop any active sessions so the disable takes effect immediately.
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    } else {
      db.prepare('UPDATE users SET disabled_at = NULL, updated_at = ? WHERE id = ?')
        .run(at, id);
    }

    logAction(db, {
      actorId: actor.id,
      action: wantDisabled ? 'user.disable' : 'user.enable',
      targetKind: 'user',
      targetId: id,
      summary: `${wantDisabled ? 'Disabled' : 'Enabled'} subcontractor ${existing.email}`,
      ip,
    });
  })();

  return { ok: true, user: getById(db, id) };
}
