// Time entries service. Decimal hours, one row per (project, user, date, log).
// A time entry is "locked" once its invoice_id is set — update/remove return
// 'locked' (409) for those rows. Subs can only act on their own rows; super-
// admin can act on any, and may post on behalf of a sub via act_as_user_id.

import { logAction } from './audit.js';

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;
const PATCHABLE = ['entry_date', 'hours', 'description'];

function nowIso() {
  return new Date().toISOString();
}

function isSuperAdmin(actor) {
  return actor?.role === 'super_admin';
}

function rowToEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    project_id: row.project_id,
    user_id: row.user_id,
    user_display_name: row.user_display_name ?? null,
    user_email: row.user_email ?? null,
    project_name: row.project_name ?? null,
    client_name: row.client_name ?? null,
    entry_date: row.entry_date,
    hours: row.hours,
    description: row.description,
    invoice_id: row.invoice_id,
    locked: row.invoice_id != null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function getRaw(db, id) {
  return db
    .prepare(
      `SELECT te.*,
              u.display_name AS user_display_name,
              u.email        AS user_email,
              p.name         AS project_name,
              c.name         AS client_name
         FROM time_entries te
         JOIN users u    ON u.id = te.user_id
         JOIN projects p ON p.id = te.project_id
         JOIN clients c  ON c.id = p.client_id
        WHERE te.id = ?`
    )
    .get(id);
}

function findActiveMember(db, projectId, userId) {
  return db
    .prepare(
      `SELECT id FROM project_members
        WHERE project_id = ? AND user_id = ? AND removed_at IS NULL
        LIMIT 1`
    )
    .get(projectId, userId);
}

function projectSummary(db, projectId) {
  return db
    .prepare(
      `SELECT p.id, p.name AS project_name, c.name AS client_name
         FROM projects p
         JOIN clients c ON c.id = p.client_id
        WHERE p.id = ?`
    )
    .get(projectId);
}

function userSummary(db, userId) {
  return db
    .prepare('SELECT id, display_name, email FROM users WHERE id = ?')
    .get(userId);
}

function formatHours(hours) {
  return Number(hours).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

export function create(db, input, { actor, ip } = {}) {
  if (!actor) return { ok: false, reason: 'unauthorized' };

  const projectId = Number.parseInt(input?.project_id ?? input?.projectId, 10);
  if (!Number.isInteger(projectId)) return { ok: false, reason: 'project_required' };

  const entryDate = String(input?.entry_date ?? input?.entryDate ?? '').trim();
  if (!DATE_RX.test(entryDate)) return { ok: false, reason: 'invalid_date' };

  const hoursNum = Number(input?.hours);
  if (!Number.isFinite(hoursNum) || hoursNum <= 0) {
    return { ok: false, reason: 'invalid_hours' };
  }

  const description = String(input?.description ?? '').trim();
  if (!description) return { ok: false, reason: 'description_required' };

  let effectiveUserId = actor.id;
  const actAs = input?.act_as_user_id ?? input?.actAsUserId;
  if (actAs != null && actAs !== '') {
    const asId = Number.parseInt(actAs, 10);
    if (!Number.isInteger(asId)) return { ok: false, reason: 'invalid_act_as' };
    if (!isSuperAdmin(actor) && asId !== actor.id) {
      return { ok: false, reason: 'forbidden' };
    }
    effectiveUserId = asId;
  }

  const project = projectSummary(db, projectId);
  if (!project) return { ok: false, reason: 'project_not_found' };

  if (!findActiveMember(db, projectId, effectiveUserId)) {
    return { ok: false, reason: 'not_member' };
  }

  const user = userSummary(db, effectiveUserId);
  if (!user) return { ok: false, reason: 'unknown_user' };

  const at = nowIso();
  const info = db
    .prepare(
      `INSERT INTO time_entries
         (project_id, user_id, entry_date, hours, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(projectId, effectiveUserId, entryDate, hoursNum, description, at, at);

  const entry = rowToEntry(getRaw(db, info.lastInsertRowid));
  logAction(db, {
    actorId: actor.id,
    action: 'time_entry.create',
    targetKind: 'time_entry',
    targetId: entry.id,
    summary: `${user.display_name} logged ${formatHours(hoursNum)}h on ${project.client_name} — ${project.project_name} (${entryDate})`,
    ip,
  });
  return { ok: true, entry };
}

export function update(db, id, patch, { actor, ip } = {}) {
  if (!actor) return { ok: false, reason: 'unauthorized' };

  const existing = getRaw(db, id);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.invoice_id != null) return { ok: false, reason: 'locked' };
  if (!isSuperAdmin(actor) && existing.user_id !== actor.id) {
    return { ok: false, reason: 'forbidden' };
  }

  const next = { ...existing };
  if (patch?.entry_date !== undefined || patch?.entryDate !== undefined) {
    const ed = String(patch.entry_date ?? patch.entryDate ?? '').trim();
    if (!DATE_RX.test(ed)) return { ok: false, reason: 'invalid_date' };
    next.entry_date = ed;
  }
  if (patch?.hours !== undefined) {
    const hn = Number(patch.hours);
    if (!Number.isFinite(hn) || hn <= 0) return { ok: false, reason: 'invalid_hours' };
    next.hours = hn;
  }
  if (patch?.description !== undefined) {
    const d = String(patch.description ?? '').trim();
    if (!d) return { ok: false, reason: 'description_required' };
    next.description = d;
  }

  const changes = PATCHABLE.filter((f) => existing[f] !== next[f]).map((f) => ({
    field: f,
    oldValue: existing[f],
    newValue: next[f],
  }));
  if (!changes.length) return { ok: true, entry: rowToEntry(existing) };

  const at = nowIso();
  db.prepare(
    `UPDATE time_entries
        SET entry_date = ?, hours = ?, description = ?, updated_at = ?
      WHERE id = ?`
  ).run(next.entry_date, next.hours, next.description, at, id);

  const after = getRaw(db, id);
  logAction(db, {
    actorId: actor.id,
    action: 'time_entry.update',
    targetKind: 'time_entry',
    targetId: id,
    summary: `Updated time entry: ${after.user_display_name} on ${after.client_name} — ${after.project_name} (${after.entry_date})`,
    ip,
    changes,
  });
  return { ok: true, entry: rowToEntry(after) };
}

export function remove(db, id, { actor, ip } = {}) {
  if (!actor) return { ok: false, reason: 'unauthorized' };

  const existing = getRaw(db, id);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.invoice_id != null) return { ok: false, reason: 'locked' };
  if (!isSuperAdmin(actor) && existing.user_id !== actor.id) {
    return { ok: false, reason: 'forbidden' };
  }

  db.prepare('DELETE FROM time_entries WHERE id = ?').run(id);

  logAction(db, {
    actorId: actor.id,
    action: 'time_entry.delete',
    targetKind: 'time_entry',
    targetId: id,
    summary: `Deleted time entry: ${existing.user_display_name} logged ${formatHours(existing.hours)}h on ${existing.client_name} — ${existing.project_name} (${existing.entry_date})`,
    ip,
  });
  return { ok: true, entry: rowToEntry(existing) };
}

export function list(
  db,
  { projectId, userId, from, to, includeLocked = false } = {},
  viewer
) {
  const filters = [];
  const params = [];

  if (!isSuperAdmin(viewer)) {
    // Subs see only their own rows, regardless of any userId param.
    filters.push('te.user_id = ?');
    params.push(viewer.id);
    // …and only on projects where they have an active membership.
    filters.push(
      `EXISTS (SELECT 1 FROM project_members pm
                 WHERE pm.project_id = te.project_id
                   AND pm.user_id = ?
                   AND pm.removed_at IS NULL)`
    );
    params.push(viewer.id);
  } else if (userId != null && userId !== '') {
    const uid = Number.parseInt(userId, 10);
    if (Number.isInteger(uid)) {
      filters.push('te.user_id = ?');
      params.push(uid);
    }
  }

  if (projectId != null && projectId !== '') {
    const pid = Number.parseInt(projectId, 10);
    if (Number.isInteger(pid)) {
      filters.push('te.project_id = ?');
      params.push(pid);
    }
  }
  if (from && DATE_RX.test(String(from))) {
    filters.push('te.entry_date >= ?');
    params.push(String(from));
  }
  if (to && DATE_RX.test(String(to))) {
    filters.push('te.entry_date <= ?');
    params.push(String(to));
  }
  if (!includeLocked) {
    filters.push('te.invoice_id IS NULL');
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  return db
    .prepare(
      `SELECT te.*,
              u.display_name AS user_display_name,
              u.email        AS user_email,
              p.name         AS project_name,
              c.name         AS client_name
         FROM time_entries te
         JOIN users u    ON u.id = te.user_id
         JOIN projects p ON p.id = te.project_id
         JOIN clients c  ON c.id = p.client_id
         ${where}
         ORDER BY te.entry_date DESC, te.id DESC`
    )
    .all(...params)
    .map(rowToEntry);
}

export function get(db, id, viewer) {
  const row = getRaw(db, id);
  if (!row) return null;
  if (!isSuperAdmin(viewer) && row.user_id !== viewer.id) return null;
  return rowToEntry(row);
}
