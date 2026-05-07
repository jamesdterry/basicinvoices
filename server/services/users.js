// Users service. Stage 2 only needs read-only listing for the "add member"
// picker. Sub creation comes in a later stage.

import { logAction } from './audit.js';

const ALLOWED_ROLES = new Set(['super_admin', 'subcontractor']);
const DISPLAY_NAME_MAX = 120;

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
