// Project members service. Mutations are super-admin only (route layer).
// Headline rule: bill_rate_cents is stripped from any payload returned to a
// non-super-admin caller. stripRates() is exported for reuse downstream
// (Stage 3+ services will use it on time-entry / invoice-preview rows too).

import { logAction } from './audit.js';

function nowIso() {
  return new Date().toISOString();
}

function isSuperAdmin(viewer) {
  return viewer?.role === 'super_admin';
}

function rowToMember(row) {
  if (!row) return null;
  return {
    id: row.id,
    project_id: row.project_id,
    user_id: row.user_id,
    user_email: row.user_email ?? null,
    user_display_name: row.user_display_name ?? null,
    bill_rate_cents: row.bill_rate_cents,
    bill_rate_unit: row.bill_rate_unit,
    added_at: row.added_at,
    removed_at: row.removed_at,
  };
}

export function stripRates(rows, viewer) {
  if (isSuperAdmin(viewer)) return rows;
  if (Array.isArray(rows)) return rows.map((r) => stripRates(r, viewer));
  if (!rows || typeof rows !== 'object') return rows;
  const { bill_rate_cents, bill_rate_unit, ...rest } = rows;
  return rest;
}

function formatRate(cents) {
  const dollars = (Number(cents) / 100).toFixed(2);
  return `$${dollars}/hr`;
}

function getRaw(db, id) {
  return db
    .prepare(
      `SELECT pm.*, u.email AS user_email, u.display_name AS user_display_name
         FROM project_members pm
         JOIN users u ON u.id = pm.user_id
        WHERE pm.id = ?`
    )
    .get(id);
}

export function list(db, projectId, viewer) {
  const rows = db
    .prepare(
      `SELECT pm.*, u.email AS user_email, u.display_name AS user_display_name
         FROM project_members pm
         JOIN users u ON u.id = pm.user_id
        WHERE pm.project_id = ? AND pm.removed_at IS NULL
        ORDER BY u.display_name COLLATE NOCASE`
    )
    .all(projectId)
    .map(rowToMember);
  return stripRates(rows, viewer);
}

export function get(db, id, viewer) {
  const row = getRaw(db, id);
  if (!row) return null;
  return stripRates(rowToMember(row), viewer);
}

function projectSummary(db, projectId) {
  return db
    .prepare(
      `SELECT p.name AS project_name, c.name AS client_name
         FROM projects p
         JOIN clients c ON c.id = p.client_id
        WHERE p.id = ?`
    )
    .get(projectId);
}

export function add(db, projectId, input, { actorId, ip } = {}) {
  const userId = Number.parseInt(input?.user_id ?? input?.userId, 10);
  if (!Number.isInteger(userId)) return { ok: false, reason: 'user_required' };
  const billRateCents = Number.parseInt(input?.bill_rate_cents ?? input?.billRateCents, 10);
  if (!Number.isInteger(billRateCents) || billRateCents < 0) {
    return { ok: false, reason: 'invalid_rate' };
  }

  const project = projectSummary(db, projectId);
  if (!project) return { ok: false, reason: 'project_not_found' };

  const user = db.prepare('SELECT id, email, display_name FROM users WHERE id = ?').get(userId);
  if (!user) return { ok: false, reason: 'unknown_user' };

  const existing = db
    .prepare(
      `SELECT id FROM project_members
        WHERE project_id = ? AND user_id = ? AND removed_at IS NULL`
    )
    .get(projectId, userId);
  if (existing) return { ok: false, reason: 'already_member' };

  const at = nowIso();
  const info = db
    .prepare(
      `INSERT INTO project_members
         (project_id, user_id, bill_rate_cents, added_at, added_by)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(projectId, userId, billRateCents, at, actorId ?? null);

  const member = rowToMember(getRaw(db, info.lastInsertRowid));
  logAction(db, {
    actorId,
    action: 'project_member.add',
    targetKind: 'project_member',
    targetId: member.id,
    summary: `Added ${user.display_name} to ${project.client_name} — ${project.project_name} at ${formatRate(billRateCents)}`,
    ip,
  });
  return { ok: true, member };
}

export function updateRate(db, memberId, input, { actorId, ip } = {}) {
  const billRateCents = Number.parseInt(input?.bill_rate_cents ?? input?.billRateCents, 10);
  if (!Number.isInteger(billRateCents) || billRateCents < 0) {
    return { ok: false, reason: 'invalid_rate' };
  }
  const existing = getRaw(db, memberId);
  if (!existing || existing.removed_at) return { ok: false, reason: 'not_found' };
  if (existing.bill_rate_cents === billRateCents) {
    return { ok: true, member: rowToMember(existing) };
  }

  const project = projectSummary(db, existing.project_id);
  db.prepare('UPDATE project_members SET bill_rate_cents = ? WHERE id = ?').run(
    billRateCents,
    memberId
  );
  const after = getRaw(db, memberId);

  logAction(db, {
    actorId,
    action: 'project_member.rate_change',
    targetKind: 'project_member',
    targetId: memberId,
    summary: `Changed rate for ${after.user_display_name} on ${project.client_name} — ${project.project_name} from ${formatRate(existing.bill_rate_cents)} to ${formatRate(billRateCents)}`,
    ip,
    changes: [
      {
        field: 'bill_rate_cents',
        oldValue: formatRate(existing.bill_rate_cents),
        newValue: formatRate(billRateCents),
      },
    ],
  });
  return { ok: true, member: rowToMember(after) };
}

export function remove(db, memberId, { actorId, ip } = {}) {
  const existing = getRaw(db, memberId);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.removed_at) return { ok: true, member: rowToMember(existing) };

  const project = projectSummary(db, existing.project_id);
  const at = nowIso();
  db.prepare('UPDATE project_members SET removed_at = ? WHERE id = ?').run(at, memberId);
  const after = getRaw(db, memberId);

  logAction(db, {
    actorId,
    action: 'project_member.remove',
    targetKind: 'project_member',
    targetId: memberId,
    summary: `Removed ${after.user_display_name} from ${project.client_name} — ${project.project_name}`,
    ip,
  });
  return { ok: true, member: rowToMember(after) };
}
