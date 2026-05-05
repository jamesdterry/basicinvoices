# Basic Invoices

Open-source invoicing aimed at consultants. Vanilla JS/CSS/HTML on a Node + Express server backed by SQLite (`better-sqlite3`). Deploys to fly.io.

## Working with this codebase

- **Only commit when explicitly told to.** `git add` and `git commit` are fine on a direct request from the maintainer for that single commit; do not generalize an approval to subsequent work. Read-only git commands (`status`, `diff`, `log`, `show`, `blame`) are always fine.
- **Never push to a remote.** No `git push` (including `--force`), no `git push --tags`, and no tool action that triggers a push (e.g. `gh pr create` from a not-yet-pushed branch). The maintainer pushes manually.

## Stack & conventions

- **Server:** Node LTS, Express, `better-sqlite3`, bcrypt, nodemailer, helmet.
- **Client:** hand-rolled vanilla ESM modules (`<script type="module">`), single `app.css`. **No build step.**
- **Layout:** `server/{routes,services,db,middleware}`, `public/{lib,components,views}/`, `test/`, `e2e/`, `scripts/`.
- **Frontend modules:** `public/lib/state.js` (event emitter + `h()` DOM helper), `public/lib/router.js` (hash router; add routes to its table, not ad-hoc; query string is parsed into `params.query`), `public/lib/api.js` (`getJson`/`postJson`/etc — 401 auto-redirects to `/login.html`; `qs(obj)` builds a query string), `public/lib/filters.js` (issue-list filter state + URL/`localStorage` round-trip), `public/lib/debounce.js`, `public/lib/relativeTime.js` (DB-date parsing + `formatRelative`/`formatAbsolute`). Components are DOM-returning functions in `public/components/`; route views go in `public/views/`.
- **`localStorage`:** namespace user-scoped keys as `basicbugs.<feature>.${userId}.${projectId}` (see `filters.js`).
- **CSP:** helmet defaults block inline scripts/styles. No inline event handlers (`onclick=`), no inline `style=`, no `eval`/`new Function`. Bind events with `addEventListener` (or the `on*` keys in `h()`).
- **App shell auth:** `/` and `/index.html` are gated by `loadSessionFromCookie` (exported from `middleware/requireUser.js`); other static assets are public.
- **Migrations:** append-only `server/db/migrations/*.sql`; never edit a shipped migration.
- **Transactions:** any multi-table write runs inside `db.transaction(...)`.
- **Permissions:** enforced in services (not routes) so bulk/API paths reuse them.
- **History:** services resolve FK ids to display strings before writing `issue_history_changes`.
- **Tests:** vitest + supertest in `test/` (fresh in-memory DB via `test/db.js`); Playwright + chromium in `e2e/` (file-backed `./data/e2e.sqlite` seeded by `scripts/seed-e2e.js`, server on `:8081` via `npm run start:e2e`, authed specs reuse `.auth/developer.json` storage state). Run e2e with `npm run e2e` (one-time `npm run e2e:install` for the browser).

## Roles

Super admin (env `SUPER_ADMIN_EMAIL`) → developer → user → viewer.

`/api/projects` returns `role: 'super_admin'` for super-admin rows; server middleware collapses it to `'developer'` for project access (`requireProjectRole.js`). Client-side role checks must accept `super_admin` as developer-equivalent (see `public/components/IssueFields.js`).

## Reference

`DEVELOPMENT.md` — staged build plan (each stage is independently shippable).
`db.sql` — source schema (becomes `migrations/0001_initial.sql`).
