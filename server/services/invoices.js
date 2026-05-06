// Invoices service. Super-admin only — subs never see invoices anywhere.
//
// Stage 5 manual flow:
//   - previewDraft  — read-only; lists what *would* be pulled into a draft.
//   - createDraft   — single transaction: snapshot rates from project_members
//                     into invoice_lines.unit_rate_cents, set invoice_id on
//                     every source row (locks them), assign the next
//                     YYYY-NNNN number, mint a 32-char public_token.
//   - updateDraft   — drafts only; notes / dates / Stripe link / line desc /
//                     line sort_order / line description.
//   - send          — draft → sent; email is wired in Stage 6.
//   - voidInvoice   — detaches all source rows; sets status 'void'.
//   - deleteDraft   — drafts only; detach + cascade-delete lines + invoice.
//   - rotatePublicToken — replaces public_token with a fresh 32-char value;
//                     clears any prior public_token_revoked_at.
//   - revokePublicLink  — sets public_token_revoked_at; the public route
//                     surfaces 410 for revoked tokens.
//
// `invoice_lines.unit_rate_cents` is **snapshotted** at draft creation. After
// that, mutating `project_members.bill_rate_cents` cannot change historical
// invoice lines (Stage 5 spec — see test "snapshots unit_rate_cents").

import crypto from 'node:crypto';
import { logAction } from './audit.js';

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN_BYTES = 24;                                  // → 32-char base64url

function nowIso() {
  return new Date().toISOString();
}

function isSuperAdmin(actor) {
  return actor?.role === 'super_admin';
}

function mintToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function formatMoney(cents) {
  const n = Number(cents) / 100;
  return `$${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/, ',')}`;
}

function projectSummary(db, projectId) {
  return db
    .prepare(
      `SELECT p.id, p.client_id, p.name AS project_name, c.name AS client_name,
              c.payment_terms_days
         FROM projects p
         JOIN clients c ON c.id = p.client_id
        WHERE p.id = ?`
    )
    .get(projectId);
}

function rowToInvoice(row) {
  if (!row) return null;
  return {
    id: row.id,
    number: row.number,
    client_id: row.client_id,
    project_id: row.project_id,
    client_name: row.client_name ?? null,
    project_name: row.project_name ?? null,
    status: row.status,
    issue_date: row.issue_date,
    due_date: row.due_date,
    period_start: row.period_start,
    period_end: row.period_end,
    subtotal_cents: row.subtotal_cents,
    total_cents: row.total_cents,
    amount_paid_cents: row.amount_paid_cents,
    notes: row.notes,
    stripe_payment_link_url: row.stripe_payment_link_url,
    public_token: row.public_token,
    public_token_revoked_at: row.public_token_revoked_at,
    created_by: row.created_by,
    sent_at: row.sent_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToLine(row) {
  if (!row) return null;
  return {
    id: row.id,
    invoice_id: row.invoice_id,
    project_id: row.project_id,
    kind: row.kind,
    source_id: row.source_id,
    description: row.description,
    quantity: row.quantity,
    unit_rate_cents: row.unit_rate_cents,
    amount_cents: row.amount_cents,
    sort_order: row.sort_order,
    user_id: row.user_id,
    user_display_name: row.user_display_name ?? null,
    entry_date: row.entry_date,
    created_at: row.created_at,
  };
}

function getInvoiceRow(db, id) {
  return db
    .prepare(
      `SELECT i.*, c.name AS client_name, p.name AS project_name
         FROM invoices i
         JOIN clients c  ON c.id = i.client_id
         JOIN projects p ON p.id = i.project_id
        WHERE i.id = ?`
    )
    .get(id);
}

function getLines(db, invoiceId) {
  return db
    .prepare(
      `SELECT il.*, u.display_name AS user_display_name
         FROM invoice_lines il
    LEFT JOIN users u ON u.id = il.user_id
        WHERE il.invoice_id = ?
        ORDER BY il.sort_order ASC, il.id ASC`
    )
    .all(invoiceId)
    .map(rowToLine);
}

// Pulls everything currently unbilled on a project up to and including
// `throughDate` and returns it as proposed lines (rates snapshotted from the
// active project_members row). Used by previewDraft and createDraft.
function gatherSources(db, projectId, throughDate) {
  const timeRows = db
    .prepare(
      `SELECT te.id, te.entry_date, te.hours, te.description, te.user_id,
              u.display_name AS user_display_name,
              pm.bill_rate_cents
         FROM time_entries te
         JOIN users u ON u.id = te.user_id
    LEFT JOIN project_members pm
           ON pm.project_id = te.project_id
          AND pm.user_id    = te.user_id
          AND pm.removed_at IS NULL
        WHERE te.project_id = ?
          AND te.invoice_id IS NULL
          AND te.entry_date <= ?
        ORDER BY te.entry_date ASC, te.id ASC`
    )
    .all(projectId, throughDate);

  const expenseRows = db
    .prepare(
      `SELECT id, expense_date, description, amount_cents
         FROM expenses
        WHERE project_id = ? AND invoice_id IS NULL AND expense_date <= ?
        ORDER BY expense_date ASC, id ASC`
    )
    .all(projectId, throughDate);

  const milestoneRows = db
    .prepare(
      `SELECT id, milestone_date, description, amount_cents
         FROM milestones
        WHERE project_id = ? AND invoice_id IS NULL AND milestone_date <= ?
        ORDER BY milestone_date ASC, id ASC`
    )
    .all(projectId, throughDate);

  const lines = [];
  let sortOrder = 0;
  for (const t of timeRows) {
    const rate = t.bill_rate_cents ?? 0;
    const amount = Math.round(rate * t.hours);
    lines.push({
      kind: 'time',
      source_id: t.id,
      description: `${t.entry_date} — ${t.user_display_name}: ${t.description}`,
      quantity: t.hours,
      unit_rate_cents: rate,
      amount_cents: amount,
      sort_order: sortOrder++,
      user_id: t.user_id,
      user_display_name: t.user_display_name,
      entry_date: t.entry_date,
    });
  }
  for (const e of expenseRows) {
    lines.push({
      kind: 'expense',
      source_id: e.id,
      description: `${e.expense_date} — ${e.description}`,
      quantity: 1,
      unit_rate_cents: e.amount_cents,
      amount_cents: e.amount_cents,
      sort_order: sortOrder++,
      user_id: null,
      user_display_name: null,
      entry_date: e.expense_date,
    });
  }
  for (const m of milestoneRows) {
    lines.push({
      kind: 'milestone',
      source_id: m.id,
      description: `${m.milestone_date} — ${m.description}`,
      quantity: 1,
      unit_rate_cents: m.amount_cents,
      amount_cents: m.amount_cents,
      sort_order: sortOrder++,
      user_id: null,
      user_display_name: null,
      entry_date: m.milestone_date,
    });
  }

  const subtotal = lines.reduce((s, l) => s + l.amount_cents, 0);
  return { lines, subtotal_cents: subtotal };
}

function nextInvoiceNumber(db, year) {
  const prefix = `${year}-`;
  const row = db
    .prepare(
      `SELECT MAX(CAST(SUBSTR(number, 6) AS INTEGER)) AS max_seq
         FROM invoices
        WHERE number LIKE ?`
    )
    .get(`${prefix}%`);
  const next = (row?.max_seq ?? 0) + 1;
  return `${prefix}${String(next).padStart(4, '0')}`;
}

export function previewDraft(db, input, viewer) {
  if (!isSuperAdmin(viewer)) return { ok: false, reason: 'forbidden' };

  const projectId = Number.parseInt(input?.project_id ?? input?.projectId, 10);
  if (!Number.isInteger(projectId)) return { ok: false, reason: 'project_required' };

  const throughDate = String(input?.through_date ?? input?.throughDate ?? '').trim();
  if (!DATE_RX.test(throughDate)) return { ok: false, reason: 'invalid_date' };

  const project = projectSummary(db, projectId);
  if (!project) return { ok: false, reason: 'project_not_found' };

  const { lines, subtotal_cents } = gatherSources(db, projectId, throughDate);
  return {
    ok: true,
    project: {
      id: project.id,
      project_name: project.project_name,
      client_id: project.client_id,
      client_name: project.client_name,
      payment_terms_days: project.payment_terms_days,
    },
    through_date: throughDate,
    lines,
    subtotal_cents,
  };
}

export function createDraft(db, input, { actor, ip } = {}) {
  if (!actor) return { ok: false, reason: 'unauthorized' };
  if (!isSuperAdmin(actor)) return { ok: false, reason: 'forbidden' };

  const projectId = Number.parseInt(input?.project_id ?? input?.projectId, 10);
  if (!Number.isInteger(projectId)) return { ok: false, reason: 'project_required' };

  const throughDate = String(input?.through_date ?? input?.throughDate ?? '').trim();
  if (!DATE_RX.test(throughDate)) return { ok: false, reason: 'invalid_date' };

  const issueDate = String(input?.issue_date ?? input?.issueDate ?? '').trim();
  if (!DATE_RX.test(issueDate)) return { ok: false, reason: 'invalid_issue_date' };

  const dueDate = String(input?.due_date ?? input?.dueDate ?? '').trim();
  if (!DATE_RX.test(dueDate)) return { ok: false, reason: 'invalid_due_date' };

  const notes = input?.notes != null ? String(input.notes) : null;

  const project = projectSummary(db, projectId);
  if (!project) return { ok: false, reason: 'project_not_found' };

  const at = nowIso();
  const year = issueDate.slice(0, 4);

  const result = db.transaction(() => {
    const { lines, subtotal_cents } = gatherSources(db, projectId, throughDate);
    if (lines.length === 0) return { ok: false, reason: 'no_lines' };

    const number = nextInvoiceNumber(db, year);
    const token = mintToken();

    const info = db
      .prepare(
        `INSERT INTO invoices
           (number, client_id, project_id, status, issue_date, due_date,
            subtotal_cents, total_cents, amount_paid_cents, notes,
            public_token, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
      )
      .run(
        number,
        project.client_id,
        project.id,
        issueDate,
        dueDate,
        subtotal_cents,
        subtotal_cents,
        notes,
        token,
        actor.id,
        at,
        at
      );
    const invoiceId = Number(info.lastInsertRowid);

    const insertLine = db.prepare(
      `INSERT INTO invoice_lines
         (invoice_id, project_id, kind, source_id, description,
          quantity, unit_rate_cents, amount_cents, sort_order,
          user_id, entry_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const updateTime      = db.prepare('UPDATE time_entries SET invoice_id = ? WHERE id = ?');
    const updateExpense   = db.prepare('UPDATE expenses     SET invoice_id = ? WHERE id = ?');
    const updateMilestone = db.prepare('UPDATE milestones   SET invoice_id = ? WHERE id = ?');

    for (const l of lines) {
      insertLine.run(
        invoiceId,
        project.id,
        l.kind,
        l.source_id,
        l.description,
        l.quantity,
        l.unit_rate_cents,
        l.amount_cents,
        l.sort_order,
        l.user_id,
        l.entry_date,
        at
      );
      if (l.kind === 'time')      updateTime.run(invoiceId, l.source_id);
      if (l.kind === 'expense')   updateExpense.run(invoiceId, l.source_id);
      if (l.kind === 'milestone') updateMilestone.run(invoiceId, l.source_id);
    }

    return { ok: true, invoiceId, number, subtotal_cents };
  })();

  if (!result.ok) return result;

  logAction(db, {
    actorId: actor.id,
    action: 'invoice.create',
    targetKind: 'invoice',
    targetId: result.invoiceId,
    summary: `Drafted invoice ${result.number} for ${project.client_name} — ${project.project_name} (${formatMoney(result.subtotal_cents)})`,
    ip,
  });

  const row = getInvoiceRow(db, result.invoiceId);
  return { ok: true, invoice: rowToInvoice(row), lines: getLines(db, result.invoiceId) };
}

export function updateDraft(db, id, patch, { actor, ip } = {}) {
  if (!actor) return { ok: false, reason: 'unauthorized' };
  if (!isSuperAdmin(actor)) return { ok: false, reason: 'forbidden' };

  const existing = getInvoiceRow(db, id);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.status !== 'draft') return { ok: false, reason: 'wrong_status' };

  const next = { ...existing };
  const changes = [];

  if (patch?.issue_date !== undefined || patch?.issueDate !== undefined) {
    const v = String(patch.issue_date ?? patch.issueDate ?? '').trim();
    if (!DATE_RX.test(v)) return { ok: false, reason: 'invalid_issue_date' };
    if (v !== existing.issue_date) {
      changes.push({ field: 'issue_date', oldValue: existing.issue_date, newValue: v });
      next.issue_date = v;
    }
  }
  if (patch?.due_date !== undefined || patch?.dueDate !== undefined) {
    const v = String(patch.due_date ?? patch.dueDate ?? '').trim();
    if (!DATE_RX.test(v)) return { ok: false, reason: 'invalid_due_date' };
    if (v !== existing.due_date) {
      changes.push({ field: 'due_date', oldValue: existing.due_date, newValue: v });
      next.due_date = v;
    }
  }
  if (patch?.notes !== undefined) {
    const v = patch.notes == null ? null : String(patch.notes);
    if (v !== existing.notes) {
      changes.push({ field: 'notes', oldValue: existing.notes, newValue: v });
      next.notes = v;
    }
  }
  if (patch?.stripe_payment_link_url !== undefined || patch?.stripePaymentLinkUrl !== undefined) {
    const raw = patch.stripe_payment_link_url ?? patch.stripePaymentLinkUrl;
    const v = raw == null || raw === '' ? null : String(raw).trim();
    if (v && !/^https?:\/\//i.test(v)) return { ok: false, reason: 'invalid_stripe_url' };
    if (v !== existing.stripe_payment_link_url) {
      changes.push({
        field: 'stripe_payment_link_url',
        oldValue: existing.stripe_payment_link_url,
        newValue: v,
      });
      next.stripe_payment_link_url = v;
    }
  }

  // Optional: update individual lines (description / sort_order). Accepts an
  // array of { id, description?, sort_order? } objects; only those fields
  // change. Anything else on the line is read-only.
  const lineUpdates = Array.isArray(patch?.lines) ? patch.lines : [];
  if (lineUpdates.length) {
    const owned = db.prepare('SELECT id FROM invoice_lines WHERE id = ? AND invoice_id = ?');
    for (const u of lineUpdates) {
      const lineId = Number.parseInt(u?.id, 10);
      if (!Number.isInteger(lineId)) return { ok: false, reason: 'invalid_line' };
      if (!owned.get(lineId, id)) return { ok: false, reason: 'line_not_found' };
    }
  }

  if (!changes.length && !lineUpdates.length) {
    return { ok: true, invoice: rowToInvoice(existing), lines: getLines(db, id) };
  }

  const at = nowIso();
  db.transaction(() => {
    if (changes.length) {
      db.prepare(
        `UPDATE invoices
            SET issue_date = ?, due_date = ?, notes = ?,
                stripe_payment_link_url = ?, updated_at = ?
          WHERE id = ?`
      ).run(next.issue_date, next.due_date, next.notes, next.stripe_payment_link_url, at, id);
    }
    if (lineUpdates.length) {
      const updateDescription = db.prepare(
        'UPDATE invoice_lines SET description = ? WHERE id = ?'
      );
      const updateSortOrder = db.prepare(
        'UPDATE invoice_lines SET sort_order = ? WHERE id = ?'
      );
      for (const u of lineUpdates) {
        if (u.description !== undefined) {
          updateDescription.run(String(u.description ?? '').trim(), u.id);
        }
        if (u.sort_order !== undefined || u.sortOrder !== undefined) {
          const so = Number.parseInt(u.sort_order ?? u.sortOrder, 10);
          if (Number.isInteger(so)) updateSortOrder.run(so, u.id);
        }
      }
    }
  })();

  if (changes.length) {
    logAction(db, {
      actorId: actor.id,
      action: 'invoice.update',
      targetKind: 'invoice',
      targetId: id,
      summary: `Updated draft invoice ${existing.number} for ${existing.client_name} — ${existing.project_name}`,
      ip,
      changes,
    });
  }
  if (lineUpdates.length) {
    logAction(db, {
      actorId: actor.id,
      action: 'invoice.line_update',
      targetKind: 'invoice',
      targetId: id,
      summary: `Updated ${lineUpdates.length} line(s) on invoice ${existing.number}`,
      ip,
    });
  }

  const row = getInvoiceRow(db, id);
  return { ok: true, invoice: rowToInvoice(row), lines: getLines(db, id) };
}

export function send(db, id, { actor, ip } = {}) {
  if (!actor) return { ok: false, reason: 'unauthorized' };
  if (!isSuperAdmin(actor)) return { ok: false, reason: 'forbidden' };

  const existing = getInvoiceRow(db, id);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.status !== 'draft') return { ok: false, reason: 'wrong_status' };

  const at = nowIso();
  db.prepare(
    "UPDATE invoices SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?"
  ).run(at, at, id);

  logAction(db, {
    actorId: actor.id,
    action: 'invoice.send',
    targetKind: 'invoice',
    targetId: id,
    summary: `Sent invoice ${existing.number} to ${existing.client_name} (${formatMoney(existing.total_cents)})`,
    ip,
  });

  return { ok: true, invoice: rowToInvoice(getInvoiceRow(db, id)) };
}

function detachAllSources(db, invoiceId) {
  db.prepare('UPDATE time_entries SET invoice_id = NULL WHERE invoice_id = ?').run(invoiceId);
  db.prepare('UPDATE expenses     SET invoice_id = NULL WHERE invoice_id = ?').run(invoiceId);
  db.prepare('UPDATE milestones   SET invoice_id = NULL WHERE invoice_id = ?').run(invoiceId);
}

export function voidInvoice(db, id, { actor, ip } = {}) {
  if (!actor) return { ok: false, reason: 'unauthorized' };
  if (!isSuperAdmin(actor)) return { ok: false, reason: 'forbidden' };

  const existing = getInvoiceRow(db, id);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.status === 'void') return { ok: false, reason: 'wrong_status' };

  const at = nowIso();
  db.transaction(() => {
    detachAllSources(db, id);
    db.prepare(
      "UPDATE invoices SET status = 'void', updated_at = ? WHERE id = ?"
    ).run(at, id);
  })();

  logAction(db, {
    actorId: actor.id,
    action: 'invoice.void',
    targetKind: 'invoice',
    targetId: id,
    summary: `Voided invoice ${existing.number} for ${existing.client_name} — ${existing.project_name}`,
    ip,
  });

  return { ok: true, invoice: rowToInvoice(getInvoiceRow(db, id)) };
}

export function deleteDraft(db, id, { actor, ip } = {}) {
  if (!actor) return { ok: false, reason: 'unauthorized' };
  if (!isSuperAdmin(actor)) return { ok: false, reason: 'forbidden' };

  const existing = getInvoiceRow(db, id);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.status !== 'draft') return { ok: false, reason: 'wrong_status' };

  db.transaction(() => {
    detachAllSources(db, id);
    db.prepare('DELETE FROM invoice_lines WHERE invoice_id = ?').run(id);
    db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
  })();

  logAction(db, {
    actorId: actor.id,
    action: 'invoice.delete',
    targetKind: 'invoice',
    targetId: id,
    summary: `Deleted draft invoice ${existing.number} for ${existing.client_name} — ${existing.project_name}`,
    ip,
  });

  return { ok: true };
}

export function rotatePublicToken(db, id, { actor, ip } = {}) {
  if (!actor) return { ok: false, reason: 'unauthorized' };
  if (!isSuperAdmin(actor)) return { ok: false, reason: 'forbidden' };

  const existing = getInvoiceRow(db, id);
  if (!existing) return { ok: false, reason: 'not_found' };

  const token = mintToken();
  const at = nowIso();
  db.prepare(
    `UPDATE invoices
        SET public_token = ?, public_token_revoked_at = NULL, updated_at = ?
      WHERE id = ?`
  ).run(token, at, id);

  logAction(db, {
    actorId: actor.id,
    action: 'invoice.rotate_token',
    targetKind: 'invoice',
    targetId: id,
    summary: `Rotated public token for invoice ${existing.number}`,
    ip,
  });

  return { ok: true, invoice: rowToInvoice(getInvoiceRow(db, id)) };
}

export function revokePublicLink(db, id, { actor, ip } = {}) {
  if (!actor) return { ok: false, reason: 'unauthorized' };
  if (!isSuperAdmin(actor)) return { ok: false, reason: 'forbidden' };

  const existing = getInvoiceRow(db, id);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.public_token_revoked_at) {
    return { ok: true, invoice: rowToInvoice(existing) };
  }

  const at = nowIso();
  db.prepare(
    'UPDATE invoices SET public_token_revoked_at = ?, updated_at = ? WHERE id = ?'
  ).run(at, at, id);

  logAction(db, {
    actorId: actor.id,
    action: 'invoice.revoke_link',
    targetKind: 'invoice',
    targetId: id,
    summary: `Revoked public link for invoice ${existing.number}`,
    ip,
  });

  return { ok: true, invoice: rowToInvoice(getInvoiceRow(db, id)) };
}

export function list(db, filters = {}, viewer) {
  if (!isSuperAdmin(viewer)) return [];

  const conds = [];
  const params = [];
  if (filters.status) {
    conds.push('i.status = ?');
    params.push(String(filters.status));
  }
  if (filters.clientId != null && filters.clientId !== '') {
    const cid = Number.parseInt(filters.clientId, 10);
    if (Number.isInteger(cid)) {
      conds.push('i.client_id = ?');
      params.push(cid);
    }
  }
  if (filters.projectId != null && filters.projectId !== '') {
    const pid = Number.parseInt(filters.projectId, 10);
    if (Number.isInteger(pid)) {
      conds.push('i.project_id = ?');
      params.push(pid);
    }
  }
  if (filters.from && DATE_RX.test(String(filters.from))) {
    conds.push('i.issue_date >= ?');
    params.push(String(filters.from));
  }
  if (filters.to && DATE_RX.test(String(filters.to))) {
    conds.push('i.issue_date <= ?');
    params.push(String(filters.to));
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  return db
    .prepare(
      `SELECT i.*, c.name AS client_name, p.name AS project_name
         FROM invoices i
         JOIN clients c  ON c.id = i.client_id
         JOIN projects p ON p.id = i.project_id
         ${where}
         ORDER BY i.issue_date DESC, i.id DESC`
    )
    .all(...params)
    .map(rowToInvoice);
}

export function get(db, id, viewer) {
  if (!isSuperAdmin(viewer)) return null;
  const row = getInvoiceRow(db, id);
  if (!row) return null;
  return { invoice: rowToInvoice(row), lines: getLines(db, id) };
}

// Public-route lookup. No auth, no session. Returns null for unknown tokens or
// for revoked links — the caller (routes/publicInvoice.js) maps those to 404
// vs 410 by separately checking public_token_revoked_at.
export function getByPublicToken(db, token) {
  if (typeof token !== 'string' || !token) return null;
  const row = db
    .prepare(
      `SELECT i.*, c.name AS client_name, c.billing_address AS client_billing_address,
              c.contact_email AS client_contact_email, c.payment_terms_days,
              p.name AS project_name
         FROM invoices i
         JOIN clients c  ON c.id = i.client_id
         JOIN projects p ON p.id = i.project_id
        WHERE i.public_token = ?`
    )
    .get(token);
  if (!row) return null;
  return {
    invoice: rowToInvoice(row),
    lines: getLines(db, row.id),
    client: {
      id: row.client_id,
      name: row.client_name,
      billing_address: row.client_billing_address,
      contact_email: row.client_contact_email,
      payment_terms_days: row.payment_terms_days,
    },
    project: {
      id: row.project_id,
      name: row.project_name,
    },
    revoked: row.public_token_revoked_at != null,
  };
}
