# Basic Invoices — Build Plan

## Context

Basic Invoices is a brand-new MIT-licensed invoicing app for solo consultants. The repo currently contains only `AGENTS.md` (a lightly-edited copy from a bug-tracker project — needs cleanup), `CLAUDE.md` (which `@AGENTS.md`s), and `WEBAPP_PLAYBOOK.md` (the canonical stack/auth/deploy/backup playbook for these single-machine Node + SQLite + Fly apps). No code, no `package.json`.

The consultant is the super admin; subcontractors log in to enter hours; clients never log in (they receive a PDF invoice + an obfuscated public web link). The playbook governs everything mechanical (auth, CSRF, migrations, Litestream gate, the four frontend primitives, CSP discipline). This plan adds the domain on top.

## Resolved design decisions

- **Roles**: `super_admin` (env `SUPER_ADMIN_EMAIL`) → `subcontractor`. No other tiers. No client login.
- **Subcontractor rates**: one bill rate per (project, sub). Subs **never** see rates — service layer strips the field for non-super-admin callers.
- **Clients**: separate entity. One client → many projects. Schema allows multi-project rollup on a future invoice; v1 UI = one project per invoice.
- **Tax**: none in v1. (Add later via migration if ever needed.)
- **Stripe**: optional. Two paths land on the same `invoices.stripe_payment_link_url` field:
  - **Manual (Stage 7).** When `STRIPE_SECRET_KEY` is unset, the super-admin pastes a Stripe Payment Link URL by hand. Zero Stripe-account-setup friction; works fully offline.
  - **Programmatic (Stage 7A).** When `STRIPE_SECRET_KEY` is set, the app calls Stripe's [Payment Links API](https://stripe.com/payments/payment-links) to mint a link for the invoice's `total_cents` and persist it on the row. Stage 8 recurring schedules opt in via a per-project `auto_stripe_link` flag so accumulated/fixed drafts drop already paid-link-ready.
  - Either way, **payments are still recorded by hand in v1** (date, amount, method, reference, note); partial payments allowed. A Stripe webhook that auto-records receipts (`checkout.session.completed`) is a follow-up — Stage 7B / future, deliberately not in 7A so the Stage 8 deadline isn't blocked on webhook reachability + signature verification.
- **Time entry**: manual only, no live timer. Decimal hours.
- **Expenses & milestones**: super-admin only. Mirror the time-entry "accumulate then roll into next invoice" pattern.
- **Recurring billing**: per-project monthly. Two modes — accumulated time+expenses, or fixed milestone amount. Generated invoices land as **drafts** for review (never auto-send).
- **Invoice rendering**: server renders one HTML template (`server/views/invoice.html.js`); same template is used for the web view and the PDF (single source of truth).
- **Currency**: **USD only in v1.** No currency column anywhere; all amounts assumed USD. Multi-currency is a future enhancement (additive migration when needed).
- **No public API in v1.** The `/api/*` routes are internal endpoints consumed only by the SPA in `public/`. They are not versioned, not documented as an external surface, and there is no auth flow for third-party consumers. (CSRF double-submit assumes browser SPA usage.)

## Key technology decisions

- **PDF**: `puppeteer-core` + `@sparticuz/chromium`. Same HTML template renders both web view and PDF, which is the only way to get true visual parity. Trade-off: ~150MB image growth and a warm browser process; mitigated by launching one browser at boot and reusing it. Alternatives (`pdfkit` = hand-drawn, drift inevitable; `@react-pdf/renderer` = needs a build step, violates the no-build rule) don't fit.
- **Invoice numbering**: `YYYY-NNNN`, zero-padded, sequential per calendar year, global. UNIQUE catches the rare race; `MAX+1` inside the create transaction. Per-client numbering would tidy one client's view but leak total invoice count; global is audit-friendly.
- **Public invoice link**: 32-char base64url token (`crypto.randomBytes(24).toString('base64url')`), stored as `invoices.public_token`, with `public_token_revoked_at` for rotation. `Cache-Control: private, no-store`, `X-Robots-Tag: noindex`. Rate-limited per IP. Logged-out only — `/i/*` does not consult the session cookie.
- **Recurring timer**: in-process `setInterval` (hourly tick), reading `recurring_schedules.next_run_date`. Requires `min_machines_running = 1` in `fly.toml` so the machine doesn't sleep. This is a deliberate departure from the playbook's default; cost is negligible for one consultant and removes "cron didn't fire" failure modes.
- **Audit log**: standard playbook pattern (`admin_audit` parent + `audit_changes` children). Resolve FK ids to display strings before writing. Log every client/project/member/invoice/payment/recurring mutation, including `project_member.rate_change` (old/new in `audit_changes`).
- **Money**: stored as integer cents everywhere; rates as `INTEGER`-cents-per-hour. Hours stored as `REAL`.
- **Stripe SDK**: server-side `stripe` (Node), Payment Links API only — no Checkout Sessions (24h expiry doesn't fit invoice life cycle), no Stripe Customers, no Stripe Invoices (richer but pulls in tax/customer/product setup we don't want). One inline `price_data` line item per Payment Link, currency hardcoded `'usd'` (matches v1). The link's `plink_xxx` id is persisted on the invoice row so we can deactivate it on void. `STRIPE_SECRET_KEY` is **optional** — `services/stripeLinks.isEnabled()` returns `false` when unset and the route returns 503; `config.js` does not fail-fast on it. **No webhook handler in v1** (Stage 7B).

## Schema (table by table)

Common columns: integer PK `id`, ISO-8601 `created_at`/`updated_at` unless noted.

**`_health`** (Stage 0) — `id INTEGER PK CHECK(id=1)`, `bumped_at`. `/healthz` writes here.

**`error_log`** (Stage 0) — `id`, `at`, `level`, `message`, `stack`, `route`, `user_id`, `meta_json`. Auto-pruned >30d.

**`users`** (Stage 1) — `id`, `email TEXT UNIQUE COLLATE NOCASE`, `display_name`, `password_hash NULL`, `role CHECK(role IN ('super_admin','subcontractor'))`, `disabled_at NULL`, `last_seen_at`. (Super-admin status is **also** validated against `SUPER_ADMIN_EMAIL` at request time per playbook §9.)

**`magic_link_tokens`** (Stage 1) — `id`, `email COLLATE NOCASE`, `token_hash UNIQUE` (sha256), `purpose CHECK(IN ('login','password_reset'))`, `expires_at`, `used_at NULL`, `requested_ip`.

**`sessions`** (Stage 1) — `id TEXT PK` (random 32B base64url), `user_id` FK, `created_at`, `last_seen_at`, `user_agent`, `ip`.

**`admin_audit`** (Stage 1, used from Stage 2+) — `id`, `actor_id` FK NULL, `action` (e.g. `project_member.rate_change`), `target_kind`, `target_id`, `summary` (resolved display strings), `at`, `ip`, `meta_json`.

**`audit_changes`** (Stage 1) — `id`, `audit_id` FK, `field`, `old_value`, `new_value`.

**`clients`** (Stage 2) — `id`, `name`, `billing_address`, `contact_email`, `payment_terms_days INTEGER DEFAULT 14`, `notes`, `archived_at NULL`.

**`projects`** (Stage 2) — `id`, `client_id` FK, `name`, `code` (optional short prefix), `archived_at NULL`. UNIQUE `(client_id, name)`.

**`project_members`** (Stage 2) — `id`, `project_id` FK, `user_id` FK, `bill_rate_cents`, `bill_rate_unit DEFAULT 'hour' CHECK('hour')`, `added_at`, `added_by` FK, `removed_at NULL`. UNIQUE `(project_id, user_id) WHERE removed_at IS NULL`. **Service strips `bill_rate_cents` from sub responses.**

**`time_entries`** (Stage 3) — `id`, `project_id` FK, `user_id` FK, `entry_date` (YYYY-MM-DD), `hours REAL CHECK(>0)`, `description`, `invoice_id NULL` FK (locks the row when set). Indexes on `(project_id, entry_date)`, `(user_id, entry_date)`, `(project_id, invoice_id)`.

**`expenses`** (Stage 4) — `id`, `project_id` FK, `created_by` FK, `expense_date`, `description`, `amount_cents`, `invoice_id NULL` FK.

**`milestones`** (Stage 4) — `id`, `project_id` FK, `created_by` FK, `milestone_date`, `description`, `amount_cents`, `invoice_id NULL` FK.

**`invoices`** (Stage 5) — `id`, `number UNIQUE`, `client_id` FK, `status CHECK(IN ('draft','sent','paid','void'))`, `issue_date`, `due_date`, `period_start`, `period_end`, `subtotal_cents`, `total_cents` (= subtotal in v1), `amount_paid_cents DEFAULT 0` (denormalized; recomputed on payment write), `notes`, `stripe_payment_link_url`, `stripe_payment_link_id NULL` (Stage 7A — Stripe's `plink_xxx`, persisted so we can deactivate on void), `public_token UNIQUE`, `public_token_revoked_at NULL`, `created_by` FK, `sent_at NULL`.

**`invoice_lines`** (Stage 5) — `id`, `invoice_id` FK, `project_id` FK, `kind CHECK(IN ('time','expense','milestone'))`, `source_id` (id in source table; NULL for ad-hoc lines), `description`, `quantity REAL`, `unit_rate_cents` (**snapshotted** at invoice creation), `amount_cents`, `sort_order`, `user_id NULL` FK (which sub did the time, used for grouping in the rendered invoice), `entry_date NULL`. Index `(invoice_id, sort_order)`.

**`payments`** (Stage 7) — `id`, `invoice_id` FK, `received_date`, `amount_cents`, `method` (free text: `stripe`, `ach`, `check`, `wire`, `cash`, `other`), `reference`, `note`, `created_by` FK, `created_at`. Service recomputes `invoices.amount_paid_cents` and flips status to `paid` when `amount_paid >= total` after every mutation.

**`recurring_schedules`** (Stage 8) — `id`, `project_id` FK UNIQUE, `mode CHECK(IN ('time_and_expenses','fixed_milestone'))`, `cadence CHECK(='monthly')`, `day_of_month INTEGER CHECK(BETWEEN 1 AND 28)`, `fixed_amount_cents NULL` (required when `mode='fixed_milestone'`), `fixed_description NULL`, `auto_stripe_link INTEGER NOT NULL DEFAULT 0` (when 1, the recurring tick calls `stripeLinks.generate` after `createDraft`; failures land in `error_log` but don't block the draft), `next_run_date`, `last_run_date NULL`, `last_invoice_id NULL` FK, `paused_at NULL`.

## Project layout

```
basicinvoices/
  AGENTS.md                          (cleaned up — see "AGENTS.md cleanup" below)
  CLAUDE.md                          (unchanged: @AGENTS.md)
  WEBAPP_PLAYBOOK.md                 (unchanged reference)
  DEVELOPMENT.md                     (this plan)
  README.md                          (MIT, quickstart, fly deploy)
  LICENSE                            (MIT)
  package.json
  Dockerfile, docker-entrypoint.sh, fly.toml, litestream.yml
  vitest.config.js, playwright.config.js
  server/
    index.js                         (Express bootstrap, route mounting, error handler)
    config.js                        (env parsing + fail-fast in prod)
    logger.js                        (pino)
    db/
      connection.js                  (PRAGMA WAL/foreign_keys/busy_timeout)
      migrate.js                     (runner + meta table)
      migrations/0001_init.sql … 0009_recurring_schedules.sql
      queries/                       (per-table query modules)
    services/                        (auth, clients, projects, projectMembers,
                                      timeEntries, expenses, milestones,
                                      invoices, invoicePdf, invoiceMail,
                                      payments, recurring, reports, audit, email)
    middleware/                      (requireUser, requireSuperAdmin,
                                      requireProjectMember, csrf, rateLimit, errorHandler)
    routes/                          (auth, me, clients, projects, timeEntries,
                                      expenses, milestones, invoices,
                                      publicInvoice, payments, recurring, reports,
                                      admin, health)
    views/
      invoice.html.js                (single-source-of-truth invoice template)
      emailInvoice.html.js
    timers/                          (pruneErrors, recurringTick)
  public/
    index.html                       (gated app shell)
    login.html                       (public)
    i.html                           (public invoice viewer skeleton)
    app.css
    lib/                             (state, router, api, debounce, relativeTime,
                                      filters, money — verbatim from playbook §3
                                      where applicable)
    components/                      (nav, modal, toast, form, clientForm,
                                      projectForm, memberRow, timeEntryForm/List,
                                      expenseForm, milestoneForm, invoiceLineRow,
                                      invoiceSummary, paymentForm, recurringForm,
                                      reportFilters)
    views/                           (home, clients, clientDetail, projects,
                                      projectDetail, timeEntries, invoices,
                                      invoiceDetail, payments, recurring, reports,
                                      adminAudit, adminErrors, login)
  test/                              (vitest + supertest; in-memory DB per test
                                      via test/db.js)
  e2e/                               (Playwright; .auth/super_admin.json &
                                      .auth/subcontractor.json storage state)
  scripts/                           (migrate, seed-e2e, backup, restore)
  data/                              (gitignored)
```

## Per-project header (for cleaned-up AGENTS.md)

```
App name:           Basic Invoices (basicinvoices)
Super-admin env:    SUPER_ADMIN_EMAIL=<consultant's email>
Public origin:      BASE_URL=https://basicinvoices.fly.dev
Roles (high → low): super_admin → subcontractor
Cookie prefix:      bi_   (bi_session, bi_csrf)
Departures:
  - Two roles only; no per-project role tiers.
  - Subs never see rates or invoices; their UI is "log my hours".
  - Public unauthenticated invoice view at /i/<token> (HTML + PDF).
  - Daily in-process recurring-billing timer; min_machines_running = 1 in prod.
  - USD only in v1; no currency column anywhere.
  - No public API; /api/* routes are internal SPA endpoints only.
```

## AGENTS.md cleanup (Stage 0)

The current file still references the bug-tracker it was copied from. Replacements:

| Current | Becomes |
|---|---|
| `basicbugs.<feature>.${userId}.${projectId}` | `basicinvoices.<feature>.${userId}.${scopeId}` |
| `issue_history_changes` history paragraph | "services resolve FK ids to display strings before writing `audit_changes`" |
| Roles `super_admin → developer → user → viewer` | `super_admin → subcontractor` |
| `/api/projects` "collapses super_admin to developer" paragraph | "subs only see projects where they are a member; super-admin sees all." |
| `public/components/IssueFields.js` | Remove |
| `requireProjectRole.js` | `requireProjectMember.js` |
| `.auth/developer.json` | `.auth/super_admin.json`, `.auth/subcontractor.json` |
| `db.sql` reference | Remove (schema lives only in migrations) |
| `public/lib/filters.js` "issue-list filter" | "list-view filter state (time entries, invoices, payments)" |

Also fill in the per-project header block at the top, and add a one-paragraph "Domain glossary" (client, project, project member, time entry, expense, milestone, invoice draft/sent/paid, invoice line, payment, recurring schedule).

## Verbatim reuse from the playbook

These should be lifted into Stage 0 with minimal edits:

- **`public/lib/state.js`** — `set` / `on` / `emit` / `h()` from playbook §3 verbatim.
- **`public/lib/router.js`** — `ROUTES` table + `parseHash` + `startRouter` from playbook §3.
- **`public/lib/api.js`** — `getJson`, `postJson` (cookie name `bi_csrf`, header `X-CSRF-Token`), `qs(obj)`.
- **`public/lib/debounce.js`** — small util.
- **`docker-entrypoint.sh`** — fail-closed restore-gate decision table from playbook §7 implemented exactly (present-DB → replicate+exec; missing+sentinel+creds → restore+delete sentinel+replicate+exec; missing+no-sentinel+creds → log FATAL + sleep forever; no creds → exec node).
- **`litestream.yml`** — env-driven creds; pin Litestream `v0.3.13` in Dockerfile.
- **Magic-link flow** — `crypto.randomBytes(32).toString('base64url')`, store SHA-256 in `magic_link_tokens.token_hash`, one-shot redemption setting `used_at`, 30-min expiry, super-admin first-login bootstrap (playbook §5).
- **CSRF middleware** — double-submit per playbook §5 with cookie `bi_csrf` and header `X-CSRF-Token`.
- **`/healthz`** — DB-write health check (playbook §6).
- **`config.js` fail-fast** — playbook §4 wording.

## Stages

Each stage is independently shippable. After each stage: deploy to fly, smoke `/healthz`, run e2e suite.

### Stage 0 — DONE Scaffold + ops
**Scope.** `package.json` (express, better-sqlite3, bcrypt, cookie-parser, helmet, compression, pino + pino-pretty dev, nodemailer, busboy, puppeteer-core, @sparticuz/chromium; dev: vitest, supertest, @playwright/test, eslint, prettier). `server/config.js` fail-fast in prod. `db/connection.js` + `migrate.js` + `0001_init.sql` (creates `_health`, `error_log`, `_meta`). `server/index.js` with helmet strict CSP, compression, cookie-parser, JSON parser, mounts `/healthz` and serves `public/`. `server/timers/pruneErrors.js`. `Dockerfile` + `docker-entrypoint.sh` (verbatim playbook §7 gate) + `fly.toml` (`min_machines_running = 1`) + `litestream.yml`. `public/` shell + `login.html` stub + the four primitives. Vitest/Playwright skeletons. `test/db.js` helper. AGENTS.md cleanup. README + LICENSE.
**Migrations.** `0001_init.sql`.
**Verification.** `npm run dev` boots; `/healthz` returns 200 and bumps `_health.bumped_at`; `docker build .` succeeds; CSP headers present; manual `fly deploy` against a throwaway app works.

### Stage 1 — DONE Auth
**Scope.** Migration `0002_users_sessions_auth.sql` (users, sessions, magic_link_tokens, admin_audit, audit_changes). `services/auth.js` (request/redeem magic link, password login/set, session create/revoke; super-admin bootstrap auto-creates the user when an unknown email matches `SUPER_ADMIN_EMAIL`; unknown emails on `requestMagicLink` silently no-op). `services/email.js` (nodemailer wrapper; `dev-email` stdout when `SMTP_HOST` unset). Middleware: `requireUser` (with `loadSessionFromCookie`), `requireSuperAdmin`, `csrf`, `rateLimit`. Routes: `POST /auth/magic-link`, `GET /auth/redeem`, `POST /auth/password`, `POST /auth/logout`, `GET /api/me`. `public/login.html` + `public/views/login.js`. `public/index.html` gated, hash router stub home view.
**Tests.** Bootstrap creates super-admin; magic-link token is one-shot and SHA-256 hashed; CSRF rejects mismatched header; rate limiter trips. E2E `auth.spec.js` — request magic link, follow stdout-logged URL via `E2E_EMAIL_LOG`.
**Verification.** Magic-link login as super-admin works; CSRF cookie set; `/api/me` returns role.

### Stage 2 — DONE Clients, Projects, Members
**Scope.** Migration `0003_clients_projects.sql`. `services/clients.js` (CRUD + archive, super-admin only). `services/projects.js` (CRUD; subs see only their memberships). `services/projectMembers.js` (`add`, `updateRate` writes `audit_changes` with old/new + display names, `remove` soft-deletes; **strips `bill_rate_cents` from non-super-admin payloads**). `middleware/requireProjectMember.js`. Routes: `/api/clients`, `/api/projects`, nested `/api/projects/:id/members`. Frontend views: `clients`, `clientDetail`, `projects`, `projectDetail` (members tab — only super-admin sees the rate column). `nav.js` shows different links per role.
**Tests.** Sub cannot create a client; sub `GET /api/projects` returns only their memberships; rate field stripped from sub responses; rate change writes audit. E2E: super-admin creates client + project + adds a sub at $X/hr; logs in as sub, sees project but no rate.

### Stage 3 — DONE Time entry
**Scope.** Migration `0004_time_entries.sql`. `services/timeEntries.js` — `create` (caller must be project member or super-admin; super-admin can post on behalf of a sub via `actAsUserId`); `update`/`delete` reject when `invoice_id IS NOT NULL` (locked → 409); `list({ projectId?, userId?, from?, to?, includeLocked? })`. Routes: GET/POST/PATCH/DELETE `/api/time-entries`. View: `timeEntries.js` — sub sees "my hours this week" with quick-add row; super-admin gets project + user filters via `filters.js` (URL ↔ localStorage round-trip).
**Tests.** Cannot edit locked; sub cannot post on a project they aren't a member of; super-admin can post on behalf. E2E: sub logs four entries across the week; super-admin sees them in project view.

### Stage 4 — DONE Expenses + Milestones
**Scope.** Migration `0005_expenses_milestones.sql`. `services/expenses.js`, `services/milestones.js` — super-admin only; same `invoice_id` lock pattern as `services/timeEntries.js` (NULL column declared without FK; rebuilt to add the real FK in Stage 5 alongside `time_entries`). CRUD. Routes mirror time entries (`/api/expenses`, `/api/milestones`), guarded by `requireSuperAdmin`. Project detail page gets two new stacked sections (Expenses, Milestones) below Members; subs see only Details + Members. Reused `formatMoney(cents) → '$1,234.56'` is local to each service for audit summaries; the `public/lib/money.js` helper mentioned in the playbook lands in a later stage.
**Tests.** Sub gets 403 on all expense/milestone endpoints; locked rows reject mutation.

### Stage 5 — DONE Manual invoices + public web view
**Scope.** Migration `0006_invoices.sql` — creates `invoices` + `invoice_lines`, then does a table-rebuild on `time_entries` (and on Stage 4's `expenses` + `milestones`) to add the real `invoice_id` FK with `ON DELETE SET NULL`. The 12-step rebuild dance per SQLite docs: `PRAGMA foreign_keys = OFF` → `BEGIN` → create new table with FK → copy rows → drop old → rename → recreate indexes → `PRAGMA foreign_key_check` → `COMMIT` → `PRAGMA foreign_keys = ON`. (Stages 3 and 4 declared the column without an FK because SQLite refuses INSERTs on a child whose declared parent table doesn't exist yet, even with NULL FK values.) `services/invoices.js`:
- `previewDraft(projectId, throughDate)` — read-only.
- `createDraft(projectId, { throughDate, issueDate, dueDate, notes })` — single transaction: pulls all `time_entries`/`expenses`/`milestones` for the project where `invoice_id IS NULL` and `date <= throughDate`; creates invoice (number `YYYY-NNNN` via `MAX+1` per year inside the txn); creates `invoice_lines` with `unit_rate_cents` **snapshotted** from `project_members.bill_rate_cents` for the row's `user_id`; `UPDATE` source rows to set `invoice_id`. Audits. (Note: every billable time entry has a corresponding active `project_members` row by Stage 3 invariant, so the rate join is always satisfied.)
- `updateDraft(invoiceId, …)` — drafts only; notes, lines, line desc/sort, dates, Stripe link.
- `send(invoiceId)` — `draft → sent`, sets `sent_at`. (Email wired in Stage 6.)
- `void(invoiceId)` — detaches lines (`UPDATE … SET invoice_id = NULL`), status `void`.
- `deleteDraft(invoiceId)` — drafts only; detaches sources, deletes lines + invoice.
- `rotatePublicToken(invoiceId)`.
- `previewHtml(invoiceId)` via `server/views/invoice.html.js` (template-literal module — CSP-clean, no engine).

Routes: full CRUD + `POST /api/invoices/:id/send`, `…/void`, `…/rotate-token`, `GET /api/invoices/:id/preview`. `routes/publicInvoice.js`: `GET /i/:token` server-renders the HTML invoice; rate-limited; `Cache-Control: private, no-store`, `X-Robots-Tag: noindex`; 410 on revoked token; **does not consult the session cookie**. Views: `invoices.js` (filter by status/client/date), `invoiceDetail.js` (preview pane, line editor for drafts).
**Tests.** Snapshot test — change `project_members.bill_rate_cents` after invoice creation, verify `invoice_lines.unit_rate_cents` unchanged. Locking — pulled time entry rejects 409 on edit. Number scheme — year rollover, gap-free. E2E: super-admin creates project, sub logs hours, super-admin previews + creates draft, opens public link in fresh browser context.

### Stage 6 — DONE PDF + email
**Scope.** `services/invoicePdf.js` — launch one Puppeteer browser at boot; `renderInvoicePdf(invoiceId) → Buffer` reuses `previewHtml`; close on SIGTERM. `services/invoiceMail.js` — HTML body + PDF attachment + public link; falls back to stdout in dev. `invoices.send()` calls `invoiceMail.send()`. `GET /i/:token.pdf` renders on demand with a small in-memory LRU keyed by `invoice.updated_at`. "Resend email" action on invoice detail.
**Tests.** PDF buffer starts with `%PDF-`; dev-mode logs structured `dev-email` line including the public link. E2E: send invoice, intercept dev-email log, fetch `.pdf` URL, assert non-empty PDF.

### Stage 7 — DONE Payments
**Scope.** Migration `0007_payments.sql`. `services/payments.js` — `create`, `update`, `delete`. After every mutation, recompute `invoices.amount_paid_cents` and flip status to `paid` when fully covered (no auto-revert from `paid` on partial refund — operator handles). Audit each payment. Add `stripe_payment_link_url` editing on draft + sent flows; invoice template gains "Pay online" button when set. Routes: `GET /api/invoices/:id/payments`, `POST …`, `PATCH /api/payments/:id`, `DELETE /api/payments/:id`. View: `paymentForm.js` modal off invoice detail; status badge updates via `state.js`.
**Tests.** Partial leaves status `sent`; sum flips to `paid`; deleting recomputes correctly. E2E: two partial payments summing to total → status flips, audit entries exist.

### Stage 7A — DONE Programmatic Stripe Payment Links
Wraps Stripe's Payment Links API behind a service so the operator can mint a link from the invoice detail UI in one click and so Stage 8 recurring drafts can ship with a link already attached. Manual paste-the-URL stays supported for shops that never set a `STRIPE_SECRET_KEY`.

**Scope.**
- Add the official `stripe` npm package; pin the major version. Add `STRIPE_SECRET_KEY` to `config.js` as **optional** (no fail-fast). Document in README.
- Migration `0008_invoices_stripe_link_id.sql` — `ALTER TABLE invoices ADD COLUMN stripe_payment_link_id TEXT` (nullable, no FK/CHECK; no table-rebuild needed for additive nullable columns in SQLite). This pushes recurring's migration to `0009_recurring_schedules.sql`; renumbering pre-Stage-8 is fine since 8 is unbuilt.
- `services/stripeLinks.js`:
  - `isEnabled()` → `Boolean(config.stripeSecretKey)`. The Stripe client is lazily constructed on first call (avoids importing `stripe` at boot when the key is unset).
  - `generate(db, invoiceId, { actor, ip, force = false })` — super-admin only; allowed when `status IN ('draft','sent')` (else `'wrong_status'`); returns `'stripe_disabled'` when `!isEnabled()`. If `stripe_payment_link_id` is already set and `!force`, no-op + return existing row (idempotent — protects against double-clicks). Otherwise calls `stripe.paymentLinks.create({ line_items: [{ price_data: { currency: 'usd', unit_amount: invoice.total_cents, product_data: { name: \`Invoice ${number} — ${client_name} — ${project_name}\` } }, quantity: 1 }], metadata: { invoice_id, invoice_number } })`, persists `stripe_payment_link_url` + `stripe_payment_link_id` + `updated_at`, audits `'invoice.generate_stripe_link'` with a `changes` array. Stripe SDK errors are caught and surface as `'stripe_failure'` (502) — never thrown; the error message is logged via `logger.error` and stored in `error_log` for ops review.
  - `deactivate(db, invoiceId)` — best-effort; called from `invoices.voidInvoice` after the void succeeds. Looks up `stripe_payment_link_id`; if set and `isEnabled()`, fires `stripe.paymentLinks.update(id, { active: false })`. Failures are logged but do **not** roll back the void — the local `void` status is the source of truth, and the operator can deactivate manually in the dashboard if needed.
- `voidInvoice` integration: after the existing transaction succeeds, fire-and-forget `stripeLinks.deactivate`. Audit row already exists from `'invoice.void'`; no extra audit needed.
- Routes (`server/routes/invoices.js`): `POST /api/invoices/:id/stripe-link/generate` → super-admin, statusFor adds `'stripe_disabled' → 503`, `'stripe_failure' → 502`. Returns `{ invoice }` on success.
- `/api/me` gains `stripe_enabled: boolean` so the SPA can show/hide the Generate button without round-tripping. (Cheap to compute; consumed by `state.currentUser.stripe_enabled` on the frontend.)
- Frontend (`public/views/invoiceDetail.js`): the existing Stripe-link row gets a "Generate Stripe link" button next to "Edit Stripe link", visible only when `stripe_enabled && status IN ('draft','sent')`. If `stripe_payment_link_url` is already set, the button label switches to "Regenerate" and confirms before overwriting (the operator may have a manual link they want to keep). Errors render inline via the existing `error` div pattern.
- The rendered invoice template (`server/views/invoice.html.js`) is unchanged — it already shows the "Pay online" button when `stripe_payment_link_url` is set.

**Tests.**
- Vitest with `vi.mock('stripe')` injecting a fake client. Cases: (1) happy path persists URL + id and audits with `changes`; (2) idempotency — second call without `force` is a no-op (Stripe mock not called again); (3) `force: true` re-creates and audits the URL change; (4) `'stripe_disabled'` when no key configured (importing `services/stripeLinks.js` must work without the key); (5) `'stripe_failure'` when Stripe mock throws; (6) `wrong_status` on `paid`/`void`; (7) `forbidden` for sub actors; (8) `voidInvoice` calls `deactivate` (Stripe mock asserted) and survives a Stripe failure without rolling back the void.
- E2E: only the disabled path (default e2e env doesn't set `STRIPE_SECRET_KEY`) — assert `POST /stripe-link/generate` returns 503 + `/api/me` exposes `stripe_enabled: false` + the "Generate" button is absent in the DOM. The "happy" path is left to the manual smoke step below; running e2e against the real Stripe API would require a sandbox account in CI and add flake.

**Verification.**
1. With **no** `STRIPE_SECRET_KEY`: existing manual flow still works; Generate button is hidden; the route returns 503.
2. Export `STRIPE_SECRET_KEY=sk_test_...` from a Stripe test-mode account, restart the server, log in as super-admin, draft an invoice, click "Generate Stripe link". Confirm `https://buy.stripe.com/...` appears, `sqlite3 data/basicinvoices.sqlite "SELECT stripe_payment_link_id FROM invoices WHERE id = N"` returns a `plink_...` id, and the rendered invoice shows the "Pay online" button. Clicking through hits the test-mode checkout in Stripe.
3. Void the invoice; confirm in the Stripe dashboard that the Payment Link is no longer active.
4. Click "Regenerate" on a sent invoice with an existing link; confirm the URL/id changes, audit row written with `changes`.

### Stage 8 — DONE Recurring billing
**Scope.** Migration `0009_recurring_schedules.sql` (renumbered post-7A). `services/recurring.js` — `setSchedule`, `pause`, `resume`, `runDue(now = new Date())`. The `runDue` actor is a synthetic system user (`{ id: null, role: 'super_admin' }`) so audit rows attribute correctly; `services/timeEntries.js` and friends accept `actorId == null` (admin_audit row stores NULL). For each row where `paused_at IS NULL AND next_run_date <= today`:
- mode `time_and_expenses`: `invoices.createDraft(projectId, { throughDate: today })`.
- mode `fixed_milestone`: insert a `milestones` row with `fixed_amount_cents` + `fixed_description`, then `invoices.createDraft(...)` so the milestone gets pulled in (single code path).
- If `auto_stripe_link = 1` and `stripeLinks.isEnabled()`: best-effort call to `stripeLinks.generate(db, draftId, { actor, ip: null })` after the draft transaction commits. Stripe failures land in `error_log` + audit `'recurring.run'` with `status='partial'` but the draft still drops as-is for the operator to handle.
- Update `last_run_date`, `last_invoice_id`, advance `next_run_date` by one calendar month (clamped to `day_of_month` ≤ 28).
- Each row's run wrapped in its own try/catch + transaction — one failure doesn't block siblings; failures land in `error_log` + audit `recurring.run` with `status='error'`.

`server/timers/recurringTick.js` — `setInterval(() => recurring.runDue(), 60 * 60 * 1000)` started from `index.js` (skipped in `NODE_ENV=test`). Routes: `GET/PUT /api/projects/:id/recurring`, `POST .../pause`, `POST .../resume`, `POST /api/admin/recurring/run-now` (manual trigger). View: `recurring.js` — schedule form includes an "Auto-generate Stripe Payment Link" checkbox (disabled + greyed when `!stripe_enabled`).
**Tests.** With frozen `now`, three schedules with various `next_run_date`s: only due ones run; failed row doesn't block others; advance honors `day_of_month` clamp. With `auto_stripe_link=1` + a mocked Stripe client, the generated draft has `stripe_payment_link_url` populated; with the same flag but `!isEnabled()`, the draft drops without a URL and recurring doesn't error. E2E: super-admin sets up a fixed retainer, "run now", a draft appears.
**Verification.** Drafts (never sent) appear; super-admin reviews and sends manually. Confirm `min_machines_running=1` in prod.

### Stage 8.5 — DONE Production triggers (wake-on-activity + TOTP cron)

With fly running `auto_stop_machines = "stop"` and `min_machines_running = 0`, the in-process recurring timer can't be relied on to fire. This stage wires three convergent triggers that all flow through `services/recurring.js#maybeRunDue`'s atomic `_recurring_meta` claim so concurrent fires can't double-process schedules:

- **In-process timer** — legacy; harmless redundancy while the machine happens to be up for other reasons.
- **Wake-on-activity** — `routes/me.js` fires `setImmediate(() => maybeRunDue(db))` after the response so the consultant's app-shell load drives the tick. The 1-hour `_recurring_meta` interval throttles repeat fires.
- **TOTP-gated cron** — `POST /cron/recurring-tick` (mounted before `csrf`, parallel to `/i/`). Authenticated by a 30-second TOTP code (RFC 6238, HMAC-SHA1, ±1 step skew) computed from `RECURRING_TICK_SECRET`. Daily fire from `.github/workflows/recurring-tick.yml` at 13:00 UTC. The HTTP request itself wakes a stopped fly machine via `auto_start_machines = true`; rate-limited 6 req/min/IP.

`_recurring_meta` is a single-row table that holds the last tick timestamp; `tryClaimTick` does an atomic `UPDATE WHERE last_tick_at < cutoff`. Only the first writer in a window wins; concurrent triggers either succeed or no-op cleanly. Schedules become due at midnight UTC and stay due all day, so a "skip because someone else just ran" is always safe.

Migration `0010_recurring_meta.sql`. New: `server/lib/totp.js`, `server/routes/cron.js`, `scripts/totp-code.js`, `.github/workflows/recurring-tick.yml`. `fly.toml` dropped `min_machines_running` to 0.

### Stage 8.6 — Auto-send recurring drafts

Adds an opt-in `auto_send` flag on `recurring_schedules` so a recurring tick can both **generate and send** an invoice without super-admin review. Pairs with `auto_stripe_link` — when both are on, the auto-generated Stripe Payment Link rides along in the auto-sent email body just like a manually-sent invoice.

This is consequential: once sent, an invoice can't be unsent; rate or hour mistakes go out the door without review. The flag defaults to `0` and the UI surfaces it with a warning.

**Scope.**
- Migration `0011_recurring_auto_send.sql` — `ALTER TABLE recurring_schedules ADD COLUMN auto_send INTEGER NOT NULL DEFAULT 0 CHECK (auto_send IN (0, 1))`. Additive; no table rebuild.
- `services/recurring.js`:
  - `validateSetInput` parses `auto_send` (boolean / 0|1) using the same coercion as `auto_stripe_link`.
  - `setSchedule` persists it + emits an `auto_send` `changes` entry when toggled.
  - `rowToSchedule` exposes `auto_send: boolean` to the SPA.
  - `runOne` gains a third post-transaction step **after** the existing `auto_stripe_link` branch (so the email body sees the Payment Link URL) and **before** the `recurring.run` audit. When `schedule.auto_send === 1 && invoiceId != null && outcome !== 'error'`, fire `invoices.send(db, invoiceId, { actor, ip })`:
    - `{ ok: true }` → keep `outcome` as-is; record `meta.send = 'success'`.
    - `{ ok: false, reason: 'no_client_email' | … }` → flip `outcome` to `'partial'`, record `meta.send = <reason>`, write `error_log`.
    - thrown error (SMTP failure) → flip to `'partial'`, log + `error_log`, record `meta.send = 'failure'`.
  - Audit summary adapts: a fully-successful auto-send reads "Recurring tick sent invoice 2026-0007 to Acme — Website ($500.00 retainer)"; failures still mention drafting + which step failed.
- `public/components/recurringForm.js` — new "Auto-send invoice on each run" checkbox below `auto_stripe_link`, with a one-line warning ("Skips the draft-review step — make sure rates and dates are correct before enabling"). No precondition check on `clients.contact_email` at form-save time; the runtime check inside `runOne` is the gate (operator can configure auto_send before adding the email; tick will surface the missing-email outcome via audit `'partial'`).
- No new route reasons; `runOne` handles all auto_send failures internally and surfaces them via the audit row.

**Failure-mode matrix** (status, audit-status):

| stripe-link | auto-send | stripe outcome | send outcome | invoice status | audit `meta.status` |
|---|---|---|---|---|---|
| 0 | 0 | n/a | n/a | draft | success |
| 1 | 0 | success | n/a | draft (with link) | success |
| 1 | 0 | fail | n/a | draft (no link) | partial |
| 0 | 1 | n/a | success | sent | success |
| 0 | 1 | n/a | fail | draft | partial |
| 1 | 1 | success | success | sent (with link) | success |
| 1 | 1 | success | fail | draft (with link) | partial |
| 1 | 1 | fail | success | sent (no link) | partial |
| 1 | 1 | fail | fail | draft (no link) | partial |

**Tests.** New `describe('runDue — auto_send', …)` in `test/recurring.test.js`:
- `auto_send = 1` + non-null `contact_email` → invoice status `'sent'`, audit `meta.send = 'success'`.
- `auto_send = 1` + null `contact_email` → invoice stays `'draft'`, audit `meta.send = 'no_client_email'`, `meta.status = 'partial'`.
- `auto_send = 1` + email service throws → invoice stays `'draft'`, `error_log` row written.
- `auto_send = 1` + `auto_stripe_link = 1` (both on) → `'sent'` status, `stripe_payment_link_url` set; verify the Stripe link path runs BEFORE `send` so the email sees the URL.
- `auto_send = 0` (default) → existing behavior, invoice stays `'draft'`.

E2E (`e2e/recurring.spec.js`): one new test that sets `auto_send: true` via PUT, calls run-now, asserts `invoice.status === 'sent'` and that the dev-email log captured the dispatch (mirrors the pattern in `e2e/payments.spec.js`).

**Verification.** Configure auto_send on a fixed-milestone schedule, set the client's `contact_email`, click Run now: confirm the invoice is in `sent` status and the dev-email log records the dispatch. Then unset the contact email and run again: confirm the next draft stays `draft` with audit `meta.send = 'no_client_email'` and an `error_log` row.

### Stage 9 — DONE Reports + CSV
**Scope.** `services/reports.js` — `paymentsReport({ from, to, groupBy: 'client'|'project' })` returns `[{ key, label, totalCents, count }]` (USD only). Date range is inclusive on both ends, filtered against `payments.received_date` (cash basis — chosen over `invoices.issue_date` so totals match the consultant's bank deposits and reconcile against invoices filtered to `paid`). Presets: this month, last month, this quarter, this year, last year, custom — non-custom presets recompute their range on every load so "this month" rolls forward across days. Routes: `GET /api/reports/payments?from&to&groupBy&format=json|csv` (super-admin only; CSV via `server/lib/csv.js`, RFC-4180 quoting, CRLF). CSV columns: `key, label, total_cents, total_dollars, payment_count`. View: `public/views/reports.js` with preset chips, custom range picker, group-by toggle, table, "Export CSV" anchor (`<a download>`; GET-only so no CSRF token needed).
**Tests.** Aggregation correctness, range bounds (inclusive on both ends), `groupBy='project'` labels as `Client — Project`, NOCASE sort, role gating (sub→403), `invalid_range` when `to < from`. E2E (`e2e/reports.spec.js`): super-admin seeds two clients × two projects × two paid invoices, hits JSON + CSV endpoints, sub gets 403.
**Verification.** Totals reconcile against invoice list filtered to `paid`.

### Stage 10 — Invoice branding (company name, logo, accent color)

The rendered invoice (HTML + PDF) currently shows nothing about the consultant's business — no company name in the header, no business address (so the bill literally doesn't say where to mail a check), no logo, no color treatment. Stage 10 adds four pieces of light branding the super-admin can edit once and have flow through every invoice (manual + recurring), the public `/i/<token>` view, and the PDF.

Why "light": one company name, one mailing address, one logo, one accent color. No multi-tenant theming, no per-client overrides, no font picker, no template variants. The design constraint is the existing CSP (`styleSrc: ["'self'"]`, `imgSrc: ["'self'", 'data:']`) — branding has to be reachable via same-origin URLs, not inline styles or external image hosts.

**Schema.** Migration `0012_branding.sql` — singleton `branding` table:
- `id INTEGER PRIMARY KEY CHECK (id = 1)` (matches the `_health` / `_recurring_meta` pattern).
- `company_name TEXT NOT NULL DEFAULT ''` (empty until set; the template falls back to "" + a muted "Set your company name in Branding settings" hint when blank).
- `business_address TEXT NOT NULL DEFAULT ''` — multi-line free-form (street, city/state/zip, country, etc.). Newlines are significant: stored as `\n`-separated text, rendered as `<br>` in the template (each line HTML-escaped). 500-char cap at the service layer so a runaway paste doesn't bloat every PDF.
- `accent_color_hex TEXT NOT NULL DEFAULT '#1f6feb' CHECK (accent_color_hex GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]')` — the existing `app.css`'s `--accent` shade as the default so unconfigured installs still look reasonable.
- `logo_filename TEXT` (NULL when no logo).
- `logo_mime TEXT CHECK (logo_mime IN ('image/png','image/jpeg','image/webp','image/svg+xml'))`.
- `logo_bytes BLOB` (NULL when no logo).
- `updated_at TEXT NOT NULL`.
- A migration-time seed `INSERT OR IGNORE INTO branding (id, accent_color_hex, updated_at) VALUES (1, '#1f6feb', '<at>')` so `services/branding.js#get` can always return a row.

Logo bytes live in SQLite (Litestream covers it; ops parity with the rest of the schema). Hard cap: **256 KB** decoded; checked at upload before the INSERT. PDF bloat is the main concern.

**Service.** `services/branding.js`:
- `get(db)` → `{ companyName, businessAddress, accentColorHex, hasLogo, logoMime, updatedAt }` (never returns `logo_bytes` — callers that need bytes use `getLogo`). Read-only; no auth gate (the rendered invoice template needs to call this from inside the public `/i/<token>` route, which has no session).
- `update(db, { companyName?, businessAddress?, accentColorHex? }, { actor, ip })` — super-admin only. Validates hex format (strict `#RRGGBB`, six digits, case-insensitive); trims/length-caps `companyName` at 120 chars; `businessAddress` is normalized to `\n` line endings (`\r\n` → `\n`), trimmed of leading/trailing blank lines, and length-capped at 500 chars (else `'address_too_long'`). Writes `audit_changes` for whichever fields changed; audit action `'branding.update'`. The address change row records old/new with newlines escaped to `\\n` so the audit log stays single-line scannable.
- `setLogo(db, { filename, mime, bytes }, { actor, ip })` — super-admin only. Validates `mime` against the schema's CHECK, validates `bytes.length <= 256 * 1024` (else `'logo_too_large'`), stores name + mime + bytes. Audit action `'branding.set_logo'` with a `meta_json` carrying `{ filename, mime, bytes: <length> }` so the audit summary stays human-readable without dumping binary.
- `clearLogo(db, { actor, ip })` — super-admin only; nulls all three logo columns. Audit `'branding.clear_logo'`.
- `getLogo(db)` → `{ filename, mime, bytes } | null` — used by the logo route below.

Reasons returned: `'forbidden'`, `'invalid_color'`, `'address_too_long'`, `'invalid_mime'`, `'logo_too_large'`, `'logo_required'` (clear when no logo set is a no-op success, not an error — `'logo_required'` is for a future "delete logo" guard if needed; reserve the name).

**Routes.** `server/routes/branding.js`:
- `GET /api/branding` — super-admin only; returns `services/branding.js#get` plus a derived `logo_url` (`'/branding/logo'` when `hasLogo`, else null) so the SPA can `<img src>` directly.
- `PATCH /api/branding` — super-admin; calls `update`.
- `POST /api/branding/logo` — super-admin; multipart via `busboy` (already in deps from Stage 6 / earlier; verify before Stage 10 implementation). Stream-cap at 256 KB + 1 byte and reject early on overflow. Single field name `logo`. Returns `200 { branding }` on success.
- `DELETE /api/branding/logo` — super-admin; calls `clearLogo`.
- `statusFor` mapping: `forbidden→403`, `logo_too_large→413`, others (`invalid_color`, `address_too_long`, `invalid_mime`)→400.

`server/routes/brandingPublic.js` (mounted alongside `/i/`, before `csrf` + `loadSessionFromCookie`, so it works in browsers with no relationship to the app):
- `GET /branding/logo` — serves `getLogo`'s bytes with `Content-Type: <mime>`, `Cache-Control: public, max-age=300, must-revalidate`, `ETag: "<sha256-of-bytes-prefix-16chars>"` (computed once and held in module-scope memo keyed on `branding.updated_at`). Returns 404 when no logo is set. Same rate-limit middleware as `/i/`.
- `GET /branding/style.css` — serves a one-property stylesheet (`:root { --invoice-accent: #abcdef; }`) so the invoice template can pull the accent color through CSP without inline styles. Same caching strategy. The literal hex is re-validated against the same regex before being interpolated into the CSS, defense-in-depth against any future write that sneaks past the CHECK.

**Template wiring.** `server/views/invoice.html.js` already includes `<link rel="stylesheet" href="/invoice.css" />`; add a second `<link rel="stylesheet" href="/branding/style.css?v=<updated_at>" />` so the cache-busts when the operator changes the color. Add `<img src="/branding/logo" />` to the invoice header (only when `hasLogo`). Add `<h1>` / header bar showing `companyName`, with the multi-line `businessAddress` rendered immediately below as a small block (each line HTML-escaped, joined by `<br>`; rely on the existing `escape()` helper in the template — never inject the raw address). Update `public/invoice.css` to pull the accent through `var(--invoice-accent, #1f6feb)` on whatever currently uses the brand-ish color (status badges, totals row underline, "Pay online" button border).

**SPA view.** `public/views/branding.js` at hash `#/branding`, super-admin only. Form fields:
- Company name — text input, 120-char `maxlength`.
- Business address — `<textarea rows="4">`, 500-char `maxlength`, with helper text "One line per row — street, city/state/zip, country".
- Accent color — `<input type="color">` plus a small swatch preview.
- Logo — file input + thumbnail of the current logo + "Remove logo" button when set.
- Save button calls `PATCH /api/branding`; logo upload is its own `<form>` submitted to `POST /api/branding/logo` via `fetch` with `FormData` (manual CSRF header — bypass `public/lib/api.js` since it's JSON-only).
- Below the form, a small "Live preview" pane that fetches `/api/invoices` (most recent), grabs an id, and embeds `<iframe src="/i/<token>">` so the operator sees their changes immediately. (Cheaper alternative: render a static "sample invoice" iframe instead — TBD during implementation.)

Add nav link in `public/components/nav.js` inside the existing `super_admin` block: `#/branding` → "Branding".

**Recurring + auto-send.** No code changes — both already render through `services/invoiceMail.js#sendInvoiceEmail` → `renderInvoiceHtml` → branded template. Adding a test that recurring auto-send picks up a fresh logo is enough.

**Migrations.** `0012_branding.sql`.

**Tests.** Vitest:
- `services/branding.js` happy-paths for `get` / `update` / `setLogo` / `clearLogo`; audit rows + `audit_changes` for color / name / address change; `logo_too_large` at exactly 256 KB + 1; `invalid_color` for short / non-hex / 8-digit input; `address_too_long` at 501 chars; address normalization (CRLF → LF, leading/trailing blank lines stripped, interior blank lines preserved); `forbidden` for sub actor on every mutation.
- `routes/brandingPublic.js`: `/branding/logo` 404 when none, 200 with correct `Content-Type` + cache headers when set, `If-None-Match` with the served ETag returns 304. `/branding/style.css` includes the configured hex literal and a fallback for the `--invoice-accent` custom property.
- `routes/branding.js`: PATCH validation surfaces `400 invalid_color`, multipart upload of an oversized payload returns `413 logo_too_large` and writes nothing.

Playwright (`e2e/branding.spec.js`):
- Super-admin: PATCH name + multi-line address + color, upload a tiny PNG, hit `/api/branding`, confirm `logo_url` is set and `business_address` round-trips with newlines preserved; fetch `/branding/style.css`, confirm it contains the configured hex; fetch a public `/i/<token>` page, confirm the company name, each address line (joined by `<br>`), and `<img src="/branding/logo">` appear in the HTML.
- Sub: GET / PATCH / POST / DELETE on `/api/branding*` all 403; `/branding/logo` and `/branding/style.css` are public so they 200 even unauthenticated.

**Verification.**
1. `npm run dev`; log in as super-admin; navigate to `#/branding`; type a company name, paste a 3-line mailing address, pick an accent color, upload a small PNG.
2. Open an existing invoice's public link in an incognito window; confirm the header shows the company name with the address stacked beneath it (one line per row), the logo renders, and accent-coloured elements use the picked hue.
3. Fetch the `.pdf` URL on the same invoice; confirm the PDF has the same branding (Puppeteer renders the same template).
4. Configure a recurring schedule with `auto_send=1` and a `contact_email`; "Run now"; confirm the dev-email log records the dispatch and the attached PDF is branded.
5. Sub-account smoke: log in as sub, hit `#/branding` → "Reports are visible to super-admins only"-style gate; `/branding/logo` still serves (it's public).

## Critical files

The five files most central to the build; everything else hangs off these:

- `server/db/migrate.js`
- `server/services/invoices.js`
- `server/services/invoicePdf.js`
- `server/views/invoice.html.js`
- `docker-entrypoint.sh`

## End-to-end verification (post-Stage 9)

1. `npm run dev` (loads `.env` via `--env-file-if-exists`) → log in as super-admin via magic link (printed as a `dev-email` JSON line on stdout when `SMTP_HOST` is unset).
2. Create a client, then a project under it.
3. Add the seeded sub (`scripts/seed-e2e.js` for e2e; in dev, insert one via the `sqlite3` snippet in AGENTS.md) to the project at $X/hr. Optionally add the super-admin to the same project at their own rate to verify self-bill.
4. Log out, log in as the sub via magic link; confirm "my hours" view shows only their projects and no rates anywhere on the page.
5. Sub logs 4 hours over 2 days. Log out.
6. Super-admin adds an expense and a milestone to the project.
7. Preview an invoice "through today" — confirm time + expense + milestone all appear; line rates match `project_members`.
8. Create the draft, change the rate on `project_members` afterwards, confirm the invoice line rate is unchanged.
9. Send the invoice; intercept the dev-email log, open the public link in an incognito window, confirm read-only HTML; fetch the `.pdf` URL.
10. With `STRIPE_SECRET_KEY=sk_test_...` exported, click "Generate Stripe link" on the invoice; confirm `stripe_payment_link_url` is set and the "Pay online" button renders. Without a key set, confirm the button is hidden.
11. Record two partial payments via different methods; confirm status flips to `paid` after the second.
12. Set up a monthly recurring schedule on the project with "Auto-generate Stripe Payment Link" checked; hit "run now"; confirm a new draft appears with a Payment Link already attached. Untick the box on a second project and confirm its draft drops without a link.
13. Open `/api/reports/payments?from=…&to=…&groupBy=client&format=csv` and download.
14. Run `npm run test` (vitest) and `npm run e2e` (Playwright).
15. `docker build .` then `fly deploy`; smoke `/healthz` against the deployed URL; confirm `min_machines_running = 1` in `fly.toml`.
