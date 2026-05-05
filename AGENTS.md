# Basic Invoices

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

Open-source invoicing aimed at solo consultants. Vanilla JS/CSS/HTML on a Node + Express server backed by SQLite (`better-sqlite3`). Deploys to fly.io.

## Working with this codebase

- **Only commit when explicitly told to.** `git add` and `git commit` are fine on a direct request from the maintainer for that single commit; do not generalize an approval to subsequent work. Read-only git commands (`status`, `diff`, `log`, `show`, `blame`) are always fine.
- **Never push to a remote.** No `git push` (including `--force`), no `git push --tags`, and no tool action that triggers a push (e.g. `gh pr create` from a not-yet-pushed branch). The maintainer pushes manually.

## Stack & conventions

- **Server:** Node LTS, Express, `better-sqlite3`, bcrypt, nodemailer, helmet.
- **Client:** hand-rolled vanilla ESM modules (`<script type="module">`), single `app.css`. **No build step.**
- **Layout:** `server/{routes,services,db,middleware,timers,views}`, `public/{lib,components,views}/`, `test/`, `e2e/`, `scripts/`.
- **Frontend modules:** `public/lib/state.js` (event emitter + `h()` DOM helper), `public/lib/router.js` (hash router; add routes to its `ROUTES` table, not ad-hoc; query string is parsed into `params.query`), `public/lib/api.js` (`getJson`/`postJson`/`patchJson`/`deleteJson`/`qs` — 401 auto-redirects to `/login.html`; CSRF double-submit reads `bi_csrf` and sends `X-CSRF-Token`), `public/lib/debounce.js`, `public/lib/filters.js` (list-view filter state — URL/`localStorage` round-trip; used by the time-entries view, future stages will reuse for invoices/payments/reports). Future stages will add `public/lib/relativeTime.js`, `public/lib/money.js`. Components are DOM-returning functions in `public/components/`; route views go in `public/views/`.
- **`localStorage`:** namespace user-scoped keys as `basicinvoices.<feature>.${userId}.${scopeId}` (see `filters.js`).
- **CSP:** helmet defaults block inline scripts/styles. No inline event handlers (`onclick=`), no inline `style=`, no `eval`/`new Function`. Bind events with `addEventListener` (or the `on*` keys in `h()`).
- **App shell auth:** `/` and `/index.html` are gated by `loadSessionFromCookie` (exported from `middleware/requireUser.js`); other static assets are public. `/i/<token>` (public invoice view) is also public and **does not consult the session cookie**.
- **Migrations:** append-only `server/db/migrations/*.sql`; never edit a shipped migration.
- **Transactions:** any multi-table write runs inside `db.transaction(...)`.
- **Permissions:** access gates live in middleware (`requireUser`, `requireSuperAdmin`, `requireProjectMember`) and are applied at the route layer. Services own role-aware *filtering* — `services/projects.js#listForUser` narrows by membership, and `services/projectMembers.js#stripRates` removes `bill_rate_cents` from non-super-admin payloads (reused downstream on time entries, invoice previews, etc.).
- **History:** services write to `admin_audit` + `audit_changes` via `services/audit.js#logAction`. Resolve FK ids to display strings (e.g. "Acme — Website") before calling — the audit row is the human-readable record.
- **Money:** stored as integer cents everywhere; rates are `INTEGER`-cents-per-hour; hours are `REAL`. USD only in v1, no currency column.
- **Tests:** vitest + supertest in `test/` (fresh in-memory DB via `test/db.js`); Playwright + chromium in `e2e/` (file-backed `./data/e2e.sqlite` seeded by `scripts/seed-e2e.js`, server on `:8081` via `npm run start:e2e`, authed specs reuse `.auth/super_admin.json` and `.auth/subcontractor.json` storage state). Run e2e with `npm run e2e` (one-time `npm run e2e:install` for the browser).

## Roles

Super admin (env `SUPER_ADMIN_EMAIL`) → subcontractor.

Subs only see projects where they are a member; super-admin sees all. Subs never see rates or invoices anywhere in the UI — the service layer strips `bill_rate_cents` from non-super-admin payloads. Project-membership enforcement lives in `middleware/requireProjectMember.js`.

**User provisioning:** the magic-link flow auto-bootstraps the super-admin email on first login; there is no admin UI for creating subcontractors yet. To add a sub for local dev, insert directly: `sqlite3 data/basicinvoices.sqlite "INSERT INTO users (email, display_name, role, created_at, updated_at) VALUES ('sub@example.com', 'Sub', 'subcontractor', datetime('now'), datetime('now'));"`. The e2e suite's sub user is seeded by `scripts/seed-e2e.js`.

## Domain glossary

- **Client** — a billable entity (one company / person you invoice). Owns many projects. Never logs in.
- **Project** — work performed for a client. Owns time entries, expenses, milestones, and one optional recurring schedule.
- **Project member** — a user (super-admin or subcontractor) attached to a project at a specific bill rate.
- **Time entry** — a sub or super-admin's logged hours on a date for a project. Locked once attached to an invoice.
- **Expense** — super-admin–entered out-of-pocket cost on a project. Locked once invoiced.
- **Milestone** — super-admin–entered fixed-amount line item on a project (retainers, deliverables). Locked once invoiced.
- **Invoice** — bills a client for one project's accumulated/fixed lines. Statuses: `draft` → `sent` → `paid`, plus `void`. Has a public `/i/<token>` view (HTML + PDF).
- **Invoice line** — a row on an invoice, sourced from time/expense/milestone with rates **snapshotted** at creation.
- **Payment** — recorded receipt against an invoice (date, amount, method, reference). Service flips status to `paid` when fully covered.
- **Recurring schedule** — per-project monthly cadence that drops a draft invoice (time-and-expenses or fixed-milestone) for super-admin review. Never auto-sends.

## Reference

`DEVELOPMENT.md` — staged build plan (each stage is independently shippable).
`WEBAPP_PLAYBOOK.md` — portable Node + SQLite + Fly conventions this app inherits.
