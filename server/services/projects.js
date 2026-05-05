// Projects service. Mutations are super-admin only (route layer).
// Visibility is role-aware: super-admin sees all; subs see only projects
// where they have an active membership.

import { logAction } from './audit.js';

const FIELDS = ['client_id', 'name', 'code'];

function nowIso() {
  return new Date().toISOString();
}

function rowToProject(row) {
  if (!row) return null;
  return {
    id: row.id,
    client_id: row.client_id,
    client_name: row.client_name ?? null,
    name: row.name,
    code: row.code,
    archived_at: row.archived_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function isSuperAdmin(user) {
  return user?.role === 'super_admin';
}

export function listForUser(db, user, { includeArchived = false, clientId } = {}) {
  const filters = [];
  const params = [];
  if (!includeArchived) filters.push('p.archived_at IS NULL');
  if (clientId) {
    filters.push('p.client_id = ?');
    params.push(clientId);
  }

  if (isSuperAdmin(user)) {
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    return db
      .prepare(
        `SELECT p.*, c.name AS client_name
           FROM projects p
           JOIN clients c ON c.id = p.client_id
           ${where}
           ORDER BY c.name COLLATE NOCASE, p.name COLLATE NOCASE`
      )
      .all(...params)
      .map(rowToProject);
  }

  filters.unshift('pm.user_id = ?', 'pm.removed_at IS NULL');
  const where = `WHERE ${filters.join(' AND ')}`;
  return db
    .prepare(
      `SELECT DISTINCT p.*, c.name AS client_name
         FROM projects p
         JOIN clients c ON c.id = p.client_id
         JOIN project_members pm ON pm.project_id = p.id
         ${where}
         ORDER BY c.name COLLATE NOCASE, p.name COLLATE NOCASE`
    )
    .all(user.id, ...params)
    .map(rowToProject);
}

export function get(db, projectId, user) {
  const row = db
    .prepare(
      `SELECT p.*, c.name AS client_name
         FROM projects p
         JOIN clients c ON c.id = p.client_id
        WHERE p.id = ?`
    )
    .get(projectId);
  if (!row) return null;
  if (isSuperAdmin(user)) return rowToProject(row);

  const member = db
    .prepare(
      `SELECT id FROM project_members
        WHERE project_id = ? AND user_id = ? AND removed_at IS NULL
        LIMIT 1`
    )
    .get(projectId, user.id);
  if (!member) return null;
  return rowToProject(row);
}

function getRaw(db, id) {
  return db
    .prepare(
      `SELECT p.*, c.name AS client_name
         FROM projects p
         JOIN clients c ON c.id = p.client_id
        WHERE p.id = ?`
    )
    .get(id);
}

export function create(db, input, { actorId, ip } = {}) {
  const clientId = Number.parseInt(input?.client_id ?? input?.clientId, 10);
  if (!Number.isInteger(clientId)) return { ok: false, reason: 'client_required' };
  const name = (input?.name || '').trim();
  if (!name) return { ok: false, reason: 'name_required' };
  const code = (input?.code || '').trim() || null;

  const client = db.prepare('SELECT id, name, archived_at FROM clients WHERE id = ?').get(clientId);
  if (!client) return { ok: false, reason: 'client_not_found' };
  if (client.archived_at) return { ok: false, reason: 'client_archived' };

  const dupe = db
    .prepare('SELECT id FROM projects WHERE client_id = ? AND name = ? COLLATE NOCASE')
    .get(clientId, name);
  if (dupe) return { ok: false, reason: 'duplicate' };

  const at = nowIso();
  const info = db
    .prepare(
      `INSERT INTO projects (client_id, name, code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(clientId, name, code, at, at);

  const project = rowToProject(getRaw(db, info.lastInsertRowid));
  logAction(db, {
    actorId,
    action: 'project.create',
    targetKind: 'project',
    targetId: project.id,
    summary: `Created project ${client.name} — ${project.name}`,
    ip,
  });
  return { ok: true, project };
}

export function update(db, id, patch, { actorId, ip } = {}) {
  const existing = getRaw(db, id);
  if (!existing) return { ok: false, reason: 'not_found' };

  const next = { ...existing };
  if (patch?.name !== undefined) {
    const name = (patch.name || '').trim();
    if (!name) return { ok: false, reason: 'name_required' };
    next.name = name;
  }
  if (patch?.code !== undefined) {
    next.code = (patch.code || '').trim() || null;
  }
  if (patch?.client_id !== undefined || patch?.clientId !== undefined) {
    const cid = Number.parseInt(patch.client_id ?? patch.clientId, 10);
    if (!Number.isInteger(cid)) return { ok: false, reason: 'client_required' };
    const c = db.prepare('SELECT id, archived_at FROM clients WHERE id = ?').get(cid);
    if (!c) return { ok: false, reason: 'client_not_found' };
    if (c.archived_at) return { ok: false, reason: 'client_archived' };
    next.client_id = cid;
  }

  if (next.name !== existing.name || next.client_id !== existing.client_id) {
    const dupe = db
      .prepare(
        'SELECT id FROM projects WHERE client_id = ? AND name = ? COLLATE NOCASE AND id <> ?'
      )
      .get(next.client_id, next.name, id);
    if (dupe) return { ok: false, reason: 'duplicate' };
  }

  const changes = FIELDS.filter((f) => existing[f] !== next[f]).map((f) => ({
    field: f,
    oldValue: existing[f],
    newValue: next[f],
  }));
  if (!changes.length) return { ok: true, project: rowToProject(existing) };

  const at = nowIso();
  db.prepare(
    'UPDATE projects SET client_id = ?, name = ?, code = ?, updated_at = ? WHERE id = ?'
  ).run(next.client_id, next.name, next.code, at, id);

  const after = getRaw(db, id);
  logAction(db, {
    actorId,
    action: 'project.update',
    targetKind: 'project',
    targetId: id,
    summary: `Updated project ${after.client_name} — ${after.name}`,
    ip,
    changes,
  });
  return { ok: true, project: rowToProject(after) };
}

export function archive(db, id, { actorId, ip } = {}) {
  const existing = getRaw(db, id);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.archived_at) return { ok: true, project: rowToProject(existing) };

  const at = nowIso();
  db.prepare('UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?').run(at, at, id);
  const after = getRaw(db, id);
  logAction(db, {
    actorId,
    action: 'project.archive',
    targetKind: 'project',
    targetId: id,
    summary: `Archived project ${after.client_name} — ${after.name}`,
    ip,
  });
  return { ok: true, project: rowToProject(after) };
}

export function unarchive(db, id, { actorId, ip } = {}) {
  const existing = getRaw(db, id);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (!existing.archived_at) return { ok: true, project: rowToProject(existing) };

  const at = nowIso();
  db.prepare('UPDATE projects SET archived_at = NULL, updated_at = ? WHERE id = ?').run(at, id);
  const after = getRaw(db, id);
  logAction(db, {
    actorId,
    action: 'project.unarchive',
    targetKind: 'project',
    targetId: id,
    summary: `Unarchived project ${after.client_name} — ${after.name}`,
    ip,
  });
  return { ok: true, project: rowToProject(after) };
}
