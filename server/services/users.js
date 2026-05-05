// Users service. Stage 2 only needs read-only listing for the "add member"
// picker. Sub creation comes in a later stage.

const ALLOWED_ROLES = new Set(['super_admin', 'subcontractor']);

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
