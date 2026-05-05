// Audit service. Writes admin_audit + audit_changes children atomically.
// Callers MUST resolve FK ids to display strings before calling — per AGENTS.md
// "services resolve FK ids to display strings before writing audit_changes".

function nowIso() {
  return new Date().toISOString();
}

export function logAction(
  db,
  { actorId, action, targetKind, targetId, summary, ip, meta, changes }
) {
  if (!action || !summary) {
    throw new Error('audit_missing_required');
  }
  const at = nowIso();
  const metaJson = meta == null ? null : JSON.stringify(meta);

  const insertParent = db.prepare(
    `INSERT INTO admin_audit (actor_id, action, target_kind, target_id, summary, at, ip, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertChange = db.prepare(
    `INSERT INTO audit_changes (audit_id, field, old_value, new_value)
     VALUES (?, ?, ?, ?)`
  );

  return db.transaction(() => {
    const info = insertParent.run(
      actorId ?? null,
      action,
      targetKind ?? null,
      targetId ?? null,
      summary,
      at,
      ip ?? null,
      metaJson
    );
    const auditId = info.lastInsertRowid;
    if (Array.isArray(changes) && changes.length) {
      for (const c of changes) {
        insertChange.run(
          auditId,
          c.field,
          c.oldValue == null ? null : String(c.oldValue),
          c.newValue == null ? null : String(c.newValue)
        );
      }
    }
    return auditId;
  })();
}
