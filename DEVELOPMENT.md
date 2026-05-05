# Basic Invoices — Build Plan

## Context

Basic Invoices is a brand-new MIT-licensed invoicing app for solo consultants. The repo currently contains only `AGENTS.md` (a lightly-edited copy from a bug-tracker project — needs cleanup), `CLAUDE.md` (which `@AGENTS.md`s), and `WEBAPP_PLAYBOOK.md` (the canonical stack/auth/deploy/backup playbook for these single-machine Node + SQLite + Fly apps). No code, no `package.json`.

The consultant is the super admin; subcontractors log in to enter hours; clients never log in (they receive a PDF invoice + an obfuscated public web link). The playbook governs everything mechanical (auth, CSRF, migrations, Litestream gate, the four frontend primitives, CSP discipline). This plan adds the domain on top.

## Resolved design decisions

- **Roles**: `super_admin` (env `SUPER_ADMIN_EMAIL`) → `subcontractor`. No other tiers. No client login.
- **Subcontractor rates**: one bill rate per (project, sub). Subs **never** see rates — service layer strips the field for non-super-admin callers.
- **Clients**: separate entity. One client → many projects. Schema allows multi-project rollup on a future invoice; v1 UI = one project per invoice.
- **Tax**: none in v1. (Add later via migration if ever needed.)
- **Stripe**: optional, manual. Super-admin pastes a Stripe Payment Link URL onto an invoice; embedded in PDF/web view if present. No API integration, no webhook. Payments are recorded by hand (date, amount, method, reference, note); partial payments allowed.
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

**`invoices`** (Stage 5) — `id`, `number UNIQUE`, `client_id` FK, `status CHECK(IN ('draft','sent','paid','void'))`, `issue_date`, `due_date`, `period_start`, `period_end`, `subtotal_cents`, `total_cents` (= subtotal in v1), `amount_paid_cents DEFAULT 0` (denormalized; recomputed on payment write), `notes`, `stripe_payment_link_url`, `public_token UNIQUE`, `public_token_revoked_at NULL`, `created_by` FK, `sent_at NULL`.

**`invoice_lines`** (Stage 5) — `id`, `invoice_id` FK, `project_id` FK, `kind CHECK(IN ('time','expense','milestone'))`, `source_id` (id in source table; NULL for ad-hoc lines), `description`, `quantity REAL`, `unit_rate_cents` (**snapshotted** at invoice creation), `amount_cents`, `sort_order`, `user_id NULL` FK (which sub did the time, used for grouping in the rendered invoice), `entry_date NULL`. Index `(invoice_id, sort_order)`.

**`payments`** (Stage 7) — `id`, `invoice_id` FK, `received_date`, `amount_cents`, `method` (free text: `stripe`, `ach`, `check`, `wire`, `cash`, `other`), `reference`, `note`, `created_by` FK, `created_at`. Service recomputes `invoices.amount_paid_cents` and flips status to `paid` when `amount_paid >= total` after every mutation.

**`recurring_schedules`** (Stage 8) — `id`, `project_id` FK UNIQUE, `mode CHECK(IN ('time_and_expenses','fixed_milestone'))`, `cadence CHECK(='monthly')`, `day_of_month INTEGER CHECK(BETWEEN 1 AND 28)`, `fixed_amount_cents NULL` (required when `mode='fixed_milestone'`), `fixed_description NULL`, `next_run_date`, `last_run_date NULL`, `last_invoice_id NULL` FK, `paused_at NULL`.

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
      migrations/0001_init.sql … 0008_recurring_schedules.sql
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

### Stage 3 — Time entry
**Scope.** Migration `0004_time_entries.sql`. `services/timeEntries.js` — `create` (caller must be project member or super-admin; super-admin can post on behalf of a sub via `actAsUserId`); `update`/`delete` reject when `invoice_id IS NOT NULL` (locked → 409); `list({ projectId?, userId?, from?, to?, includeLocked? })`. Routes: GET/POST/PATCH/DELETE `/api/time-entries`. View: `timeEntries.js` — sub sees "my hours this week" with quick-add row; super-admin gets project + user filters via `filters.js` (URL ↔ localStorage round-trip).
**Tests.** Cannot edit locked; sub cannot post on a project they aren't a member of; super-admin can post on behalf. E2E: sub logs four entries across the week; super-admin sees them in project view.

### Stage 4 — Expenses + Milestones
**Scope.** Migration `0005_expenses_milestones.sql`. `services/expenses.js`, `services/milestones.js` — super-admin only; same `invoice_id` lock pattern; CRUD. Routes mirror time entries (`/api/expenses`, `/api/milestones`). Project detail page gets two new tabs.
**Tests.** Sub gets 403 on all expense/milestone endpoints; locked rows reject mutation.

### Stage 5 — Manual invoices + public web view
**Scope.** Migration `0006_invoices.sql` (invoices + invoice_lines). `services/invoices.js`:
- `previewDraft(projectId, throughDate)` — read-only.
- `createDraft(projectId, { throughDate, issueDate, dueDate, notes })` — single transaction: pulls all `time_entries`/`expenses`/`milestones` for the project where `invoice_id IS NULL` and `date <= throughDate`; creates invoice (number `YYYY-NNNN` via `MAX+1` per year inside the txn); creates `invoice_lines` with `unit_rate_cents` **snapshotted** from `project_members.bill_rate_cents`; `UPDATE` source rows to set `invoice_id`. Audits.
- `updateDraft(invoiceId, …)` — drafts only; notes, lines, line desc/sort, dates, Stripe link.
- `send(invoiceId)` — `draft → sent`, sets `sent_at`. (Email wired in Stage 6.)
- `void(invoiceId)` — detaches lines (`UPDATE … SET invoice_id = NULL`), status `void`.
- `deleteDraft(invoiceId)` — drafts only; detaches sources, deletes lines + invoice.
- `rotatePublicToken(invoiceId)`.
- `previewHtml(invoiceId)` via `server/views/invoice.html.js` (template-literal module — CSP-clean, no engine).

Routes: full CRUD + `POST /api/invoices/:id/send`, `…/void`, `…/rotate-token`, `GET /api/invoices/:id/preview`. `routes/publicInvoice.js`: `GET /i/:token` server-renders the HTML invoice; rate-limited; `Cache-Control: private, no-store`, `X-Robots-Tag: noindex`; 410 on revoked token; **does not consult the session cookie**. Views: `invoices.js` (filter by status/client/date), `invoiceDetail.js` (preview pane, line editor for drafts).
**Tests.** Snapshot test — change `project_members.bill_rate_cents` after invoice creation, verify `invoice_lines.unit_rate_cents` unchanged. Locking — pulled time entry rejects 409 on edit. Number scheme — year rollover, gap-free. E2E: super-admin creates project, sub logs hours, super-admin previews + creates draft, opens public link in fresh browser context.

### Stage 6 — PDF + email
**Scope.** `services/invoicePdf.js` — launch one Puppeteer browser at boot; `renderInvoicePdf(invoiceId) → Buffer` reuses `previewHtml`; close on SIGTERM. `services/invoiceMail.js` — HTML body + PDF attachment + public link; falls back to stdout in dev. `invoices.send()` calls `invoiceMail.send()`. `GET /i/:token.pdf` renders on demand with a small in-memory LRU keyed by `invoice.updated_at`. "Resend email" action on invoice detail.
**Tests.** PDF buffer starts with `%PDF-`; dev-mode logs structured `dev-email` line including the public link. E2E: send invoice, intercept dev-email log, fetch `.pdf` URL, assert non-empty PDF.

### Stage 7 — Payments
**Scope.** Migration `0007_payments.sql`. `services/payments.js` — `create`, `update`, `delete`. After every mutation, recompute `invoices.amount_paid_cents` and flip status to `paid` when fully covered (no auto-revert from `paid` on partial refund — operator handles). Audit each payment. Add `stripe_payment_link_url` editing on draft + sent flows; invoice template gains "Pay online" button when set. Routes: `GET /api/invoices/:id/payments`, `POST …`, `PATCH /api/payments/:id`, `DELETE /api/payments/:id`. View: `paymentForm.js` modal off invoice detail; status badge updates via `state.js`.
**Tests.** Partial leaves status `sent`; sum flips to `paid`; deleting recomputes correctly. E2E: two partial payments summing to total → status flips, audit entries exist.

### Stage 8 — Recurring billing
**Scope.** Migration `0008_recurring_schedules.sql`. `services/recurring.js` — `setSchedule`, `pause`, `resume`, `runDue(now = new Date())`. For each row where `paused_at IS NULL AND next_run_date <= today`:
- mode `time_and_expenses`: `invoices.createDraft(projectId, { throughDate: today })`.
- mode `fixed_milestone`: insert a `milestones` row with `fixed_amount_cents` + `fixed_description`, then `invoices.createDraft(...)` so the milestone gets pulled in (single code path).
- Update `last_run_date`, `last_invoice_id`, advance `next_run_date` by one calendar month (clamped to `day_of_month` ≤ 28).
- Each row's run wrapped in its own try/catch + transaction — one failure doesn't block siblings; failures land in `error_log` + audit `recurring.run` with `status='error'`.

`server/timers/recurringTick.js` — `setInterval(() => recurring.runDue(), 60 * 60 * 1000)` started from `index.js` (skipped in `NODE_ENV=test`). Routes: `GET/PUT /api/projects/:id/recurring`, `POST .../pause`, `POST .../resume`, `POST /api/admin/recurring/run-now` (manual trigger). View: `recurring.js`.
**Tests.** With frozen `now`, three schedules with various `next_run_date`s: only due ones run; failed row doesn't block others; advance honors `day_of_month` clamp. E2E: super-admin sets up a fixed retainer, "run now", a draft appears.
**Verification.** Drafts (never sent) appear; super-admin reviews and sends manually. Confirm `min_machines_running=1` in prod.

### Stage 9 — Reports + CSV
**Scope.** `services/reports.js` — `paymentsReport({ from, to, groupBy: 'client'|'project' })` returns `[{ key, label, totalCents, count }]` (USD only). Presets: this month, last month, this quarter, this year, last year, custom. Routes: `GET /api/reports/payments?...&format=json|csv` (CSV via small in-house writer). View: `reports.js` with preset chips, custom range picker, group-by toggle, table, "Export CSV".
**Tests.** Aggregation correctness; date-range edge cases (use `issue_date` calendar day, be explicit about local vs UTC). E2E: generate sample data, run "this year by client" report, click CSV, verify download.
**Verification.** Totals reconcile against invoice list filtered to `paid`.

## Critical files

The five files most central to the build; everything else hangs off these:

- `server/db/migrate.js`
- `server/services/invoices.js`
- `server/services/invoicePdf.js`
- `server/views/invoice.html.js`
- `docker-entrypoint.sh`

## End-to-end verification (post-Stage 9)

1. `npm run dev` → log in as super-admin via magic link.
2. Create a client, then a project under it.
3. Create a fake subcontractor user; add them to the project at $X/hr.
4. Log out, log in as the sub via magic link; confirm "my hours" view shows only their projects and no rates anywhere on the page.
5. Sub logs 4 hours over 2 days. Log out.
6. Super-admin adds an expense and a milestone to the project.
7. Preview an invoice "through today" — confirm time + expense + milestone all appear; line rates match `project_members`.
8. Create the draft, change the rate on `project_members` afterwards, confirm the invoice line rate is unchanged.
9. Send the invoice; intercept the dev-email log, open the public link in an incognito window, confirm read-only HTML; fetch the `.pdf` URL.
10. Record two partial payments via different methods; confirm status flips to `paid` after the second.
11. Set up a monthly recurring schedule on the project; hit "run now"; confirm a new draft appears (not sent).
12. Open `/api/reports/payments?from=…&to=…&groupBy=client&format=csv` and download.
13. Run `npm run test` (vitest) and `npm run e2e` (Playwright).
14. `docker build .` then `fly deploy`; smoke `/healthz` against the deployed URL; confirm `min_machines_running = 1` in `fly.toml`.
