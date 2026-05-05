// Milestones service. Super-admin only — fixed-amount line items
// (retainers, deliverables) entered against a project. A milestone is
// "locked" once its invoice_id is set — update/remove return 'locked'
// (409) for those rows.

import { logAction } from './audit.js';

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;
const PATCHABLE = ['milestone_date', 'description', 'amount_cents'];

function nowIso() {
  return new Date().toISOString();
}

function isSuperAdmin(actor) {
  return actor?.role === 'super_admin';
}

function formatMoney(cents) {
  const n = Number(cents) / 100;
  return `$${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/, ',')}`;
}

function rowToEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    project_id: row.project_id,
    created_by: row.created_by,
    created_by_display_name: row.created_by_display_name ?? null,
    project_name: row.project_name ?? null,
    client_name: row.client_name ?? null,
    milestone_date: row.milestone_date,
    description: row.description,
    amount_cents: row.amount_cents,
    invoice_id: row.invoice_id,
    locked: row.invoice_id != null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function getRaw(db, id) {
  return db
    .prepare(
      `SELECT m.*,
              u.display_name AS created_by_display_name,
              p.name         AS project_name,
              c.name         AS client_name
         FROM milestones m
         JOIN users u    ON u.id = m.created_by
         JOIN projects p ON p.id = m.project_id
         JOIN clients c  ON c.id = p.client_id
        WHERE m.id = ?`
    )
    .get(id);
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

function parseAmount(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

export function create(db, input, { actor, ip } = {}) {
  if (!actor) return { ok: false, reason: 'unauthorized' };
  if (!isSuperAdmin(actor)) return { ok: false, reason: 'forbidden' };

  const projectId = Number.parseInt(input?.project_id ?? input?.projectId, 10);
  if (!Number.isInteger(projectId)) return { ok: false, reason: 'project_required' };

  const milestoneDate = String(input?.milestone_date ?? input?.milestoneDate ?? '').trim();
  if (!DATE_RX.test(milestoneDate)) return { ok: false, reason: 'invalid_date' };

  const description = String(input?.description ?? '').trim();
  if (!description) return { ok: false, reason: 'description_required' };

  const amountCents = parseAmount(input?.amount_cents ?? input?.amountCents);
  if (amountCents === null) return { ok: false, reason: 'invalid_amount' };

  const project = projectSummary(db, projectId);
  if (!project) return { ok: false, reason: 'project_not_found' };

  const at = nowIso();
  const info = db
    .prepare(
      `INSERT INTO milestones
         (project_id, created_by, milestone_date, description, amount_cents,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(projectId, actor.id, milestoneDate, description, amountCents, at, at);

  const entry = rowToEntry(getRaw(db, info.lastInsertRowid));
  logAction(db, {
    actorId: actor.id,
    action: 'milestone.create',
    targetKind: 'milestone',
    targetId: entry.id,
    summary: `Milestone added: ${project.client_name} — ${project.project_name}: ${description} (${formatMoney(amountCents)}) on ${milestoneDate}`,
    ip,
  });
  return { ok: true, entry };
}

export function update(db, id, patch, { actor, ip } = {}) {
  if (!actor) return { ok: false, reason: 'unauthorized' };
  if (!isSuperAdmin(actor)) return { ok: false, reason: 'forbidden' };

  const existing = getRaw(db, id);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.invoice_id != null) return { ok: false, reason: 'locked' };

  const next = { ...existing };
  if (patch?.milestone_date !== undefined || patch?.milestoneDate !== undefined) {
    const md = String(patch.milestone_date ?? patch.milestoneDate ?? '').trim();
    if (!DATE_RX.test(md)) return { ok: false, reason: 'invalid_date' };
    next.milestone_date = md;
  }
  if (patch?.description !== undefined) {
    const d = String(patch.description ?? '').trim();
    if (!d) return { ok: false, reason: 'description_required' };
    next.description = d;
  }
  if (patch?.amount_cents !== undefined || patch?.amountCents !== undefined) {
    const a = parseAmount(patch.amount_cents ?? patch.amountCents);
    if (a === null) return { ok: false, reason: 'invalid_amount' };
    next.amount_cents = a;
  }

  const changes = PATCHABLE.filter((f) => existing[f] !== next[f]).map((f) => ({
    field: f,
    oldValue: existing[f],
    newValue: next[f],
  }));
  if (!changes.length) return { ok: true, entry: rowToEntry(existing) };

  const at = nowIso();
  db.prepare(
    `UPDATE milestones
        SET milestone_date = ?, description = ?, amount_cents = ?, updated_at = ?
      WHERE id = ?`
  ).run(next.milestone_date, next.description, next.amount_cents, at, id);

  const after = getRaw(db, id);
  logAction(db, {
    actorId: actor.id,
    action: 'milestone.update',
    targetKind: 'milestone',
    targetId: id,
    summary: `Updated milestone: ${after.client_name} — ${after.project_name}: ${after.description} (${formatMoney(after.amount_cents)}) on ${after.milestone_date}`,
    ip,
    changes,
  });
  return { ok: true, entry: rowToEntry(after) };
}

export function remove(db, id, { actor, ip } = {}) {
  if (!actor) return { ok: false, reason: 'unauthorized' };
  if (!isSuperAdmin(actor)) return { ok: false, reason: 'forbidden' };

  const existing = getRaw(db, id);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.invoice_id != null) return { ok: false, reason: 'locked' };

  db.prepare('DELETE FROM milestones WHERE id = ?').run(id);

  logAction(db, {
    actorId: actor.id,
    action: 'milestone.delete',
    targetKind: 'milestone',
    targetId: id,
    summary: `Deleted milestone: ${existing.client_name} — ${existing.project_name}: ${existing.description} (${formatMoney(existing.amount_cents)}) on ${existing.milestone_date}`,
    ip,
  });
  return { ok: true, entry: rowToEntry(existing) };
}

export function list(
  db,
  { projectId, from, to, includeLocked = false } = {},
  viewer
) {
  if (!isSuperAdmin(viewer)) return [];

  const filters = [];
  const params = [];

  if (projectId != null && projectId !== '') {
    const pid = Number.parseInt(projectId, 10);
    if (Number.isInteger(pid)) {
      filters.push('m.project_id = ?');
      params.push(pid);
    }
  }
  if (from && DATE_RX.test(String(from))) {
    filters.push('m.milestone_date >= ?');
    params.push(String(from));
  }
  if (to && DATE_RX.test(String(to))) {
    filters.push('m.milestone_date <= ?');
    params.push(String(to));
  }
  if (!includeLocked) {
    filters.push('m.invoice_id IS NULL');
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  return db
    .prepare(
      `SELECT m.*,
              u.display_name AS created_by_display_name,
              p.name         AS project_name,
              c.name         AS client_name
         FROM milestones m
         JOIN users u    ON u.id = m.created_by
         JOIN projects p ON p.id = m.project_id
         JOIN clients c  ON c.id = p.client_id
         ${where}
         ORDER BY m.milestone_date DESC, m.id DESC`
    )
    .all(...params)
    .map(rowToEntry);
}

export function get(db, id, viewer) {
  if (!isSuperAdmin(viewer)) return null;
  const row = getRaw(db, id);
  return row ? rowToEntry(row) : null;
}
