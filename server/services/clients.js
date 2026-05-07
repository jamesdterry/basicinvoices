// Clients service. Super-admin only — route layer enforces.
// Every mutation writes an admin_audit row (with audit_changes diff for updates).

import { logAction } from './audit.js';

const FIELDS = [
  'name',
  'billing_address',
  'contact_emails',
  'payment_terms_days',
  'notes',
];

const MAX_EMAILS = 10;

function nowIso() {
  return new Date().toISOString();
}

function isValidEmail(s) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s).trim());
}

// Accepts an array of strings (or null/undefined → []). Trims, drops empties,
// validates each with the basic email regex, dedupes case-insensitively
// (preserving the first occurrence's original casing + the user's order),
// and caps at MAX_EMAILS.
function parseEmails(input) {
  if (input == null) return { ok: true, emails: [] };
  if (!Array.isArray(input)) return { ok: false, reason: 'invalid_email' };
  const out = [];
  const seen = new Set();
  for (const raw of input) {
    if (raw == null) continue;
    const v = String(raw).trim();
    if (!v) continue;
    if (!isValidEmail(v)) return { ok: false, reason: 'invalid_email' };
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  if (out.length > MAX_EMAILS) return { ok: false, reason: 'too_many_emails' };
  return { ok: true, emails: out };
}

function rowToClient(row) {
  if (!row) return null;
  let emails = [];
  try {
    const parsed = JSON.parse(row.contact_emails ?? '[]');
    if (Array.isArray(parsed)) emails = parsed;
  } catch {
    emails = [];
  }
  return {
    id: row.id,
    name: row.name,
    billing_address: row.billing_address,
    contact_emails: emails,
    payment_terms_days: row.payment_terms_days,
    notes: row.notes,
    archived_at: row.archived_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function list(db, { includeArchived = false } = {}) {
  const sql = includeArchived
    ? 'SELECT * FROM clients ORDER BY name COLLATE NOCASE'
    : 'SELECT * FROM clients WHERE archived_at IS NULL ORDER BY name COLLATE NOCASE';
  return db.prepare(sql).all().map(rowToClient);
}

export function get(db, id) {
  const row = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  return rowToClient(row);
}

export function create(db, input, { actorId, ip } = {}) {
  const name = (input?.name || '').trim();
  if (!name) return { ok: false, reason: 'name_required' };

  const emailsResult = parseEmails(input?.contact_emails ?? input?.contactEmails);
  if (!emailsResult.ok) return emailsResult;
  const contactEmailsJson = JSON.stringify(emailsResult.emails);

  const billingAddress = (input?.billing_address || input?.billingAddress || '').trim() || null;
  const notes = (input?.notes || '').trim() || null;
  const rawTerms = input?.payment_terms_days ?? input?.paymentTermsDays;
  const paymentTermsDays =
    rawTerms == null || rawTerms === '' ? 14 : Number.parseInt(rawTerms, 10);
  if (!Number.isInteger(paymentTermsDays) || paymentTermsDays < 0 || paymentTermsDays > 365) {
    return { ok: false, reason: 'invalid_payment_terms' };
  }

  const at = nowIso();
  const info = db
    .prepare(
      `INSERT INTO clients
       (name, billing_address, contact_emails, payment_terms_days, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(name, billingAddress, contactEmailsJson, paymentTermsDays, notes, at, at);

  const client = get(db, info.lastInsertRowid);
  logAction(db, {
    actorId,
    action: 'client.create',
    targetKind: 'client',
    targetId: client.id,
    summary: `Created client ${client.name}`,
    ip,
  });
  return { ok: true, client };
}

export function update(db, id, patch, { actorId, ip } = {}) {
  const existing = get(db, id);
  if (!existing) return { ok: false, reason: 'not_found' };

  const next = { ...existing };
  const changes = [];

  if (patch?.name !== undefined) {
    const name = (patch.name || '').trim();
    if (!name) return { ok: false, reason: 'name_required' };
    next.name = name;
  }
  if (patch?.billing_address !== undefined || patch?.billingAddress !== undefined) {
    next.billing_address =
      ((patch.billing_address ?? patch.billingAddress) || '').trim() || null;
  }
  if (patch?.contact_emails !== undefined || patch?.contactEmails !== undefined) {
    const r = parseEmails(patch.contact_emails ?? patch.contactEmails);
    if (!r.ok) return r;
    next.contact_emails = r.emails;
  }
  if (patch?.payment_terms_days !== undefined || patch?.paymentTermsDays !== undefined) {
    const raw = patch.payment_terms_days ?? patch.paymentTermsDays;
    const n = Number.parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 0 || n > 365) {
      return { ok: false, reason: 'invalid_payment_terms' };
    }
    next.payment_terms_days = n;
  }
  if (patch?.notes !== undefined) {
    next.notes = (patch.notes || '').trim() || null;
  }

  for (const f of FIELDS) {
    const before = existing[f];
    const after = next[f];
    if (f === 'contact_emails') {
      const a = JSON.stringify(before ?? []);
      const b = JSON.stringify(after ?? []);
      if (a !== b) {
        changes.push({ field: f, oldValue: a, newValue: b });
      }
      continue;
    }
    if (before !== after) {
      changes.push({ field: f, oldValue: before, newValue: after });
    }
  }
  if (!changes.length) return { ok: true, client: existing };

  const at = nowIso();
  db.prepare(
    `UPDATE clients
       SET name = ?, billing_address = ?, contact_emails = ?,
           payment_terms_days = ?, notes = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    next.name,
    next.billing_address,
    JSON.stringify(next.contact_emails ?? []),
    next.payment_terms_days,
    next.notes,
    at,
    id
  );

  const after = get(db, id);
  logAction(db, {
    actorId,
    action: 'client.update',
    targetKind: 'client',
    targetId: id,
    summary: `Updated client ${after.name}`,
    ip,
    changes,
  });
  return { ok: true, client: after };
}

export function archive(db, id, { actorId, ip } = {}) {
  const existing = get(db, id);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.archived_at) return { ok: true, client: existing };

  const at = nowIso();
  db.prepare('UPDATE clients SET archived_at = ?, updated_at = ? WHERE id = ?').run(at, at, id);
  const after = get(db, id);
  logAction(db, {
    actorId,
    action: 'client.archive',
    targetKind: 'client',
    targetId: id,
    summary: `Archived client ${after.name}`,
    ip,
  });
  return { ok: true, client: after };
}

export function unarchive(db, id, { actorId, ip } = {}) {
  const existing = get(db, id);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (!existing.archived_at) return { ok: true, client: existing };

  const at = nowIso();
  db.prepare('UPDATE clients SET archived_at = NULL, updated_at = ? WHERE id = ?').run(at, id);
  const after = get(db, id);
  logAction(db, {
    actorId,
    action: 'client.unarchive',
    targetKind: 'client',
    targetId: id,
    summary: `Unarchived client ${after.name}`,
    ip,
  });
  return { ok: true, client: after };
}
