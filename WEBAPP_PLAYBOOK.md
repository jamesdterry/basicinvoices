# Webapp Playbook

Portable conventions for small Node + SQLite + Fly.io apps with vanilla-JS frontends. Drop this file into the root of each new repo (or copy its contents into that repo's `AGENTS.md`). It covers stack choices, deploy/backup model, and non-negotiables — not domain modelling.

## Per-project header (fill in)

```
App name:           <e.g. invoicing>
Super-admin env:    SUPER_ADMIN_EMAIL=<...>
Public origin:      BASE_URL=<https://...>
Roles (high → low): <e.g. super_admin → developer → user → viewer>
Cookie prefix:      <e.g. inv_> (replaces bb_ in examples below)
Departures:         <list anything that intentionally diverges from this doc>
```

## 1. Stack & why

- **Node 22 LTS, ESM (`"type": "module"`), Express 4.** LTS predictability; ESM is the default.
- **`better-sqlite3`** — synchronous, fast, single-process. *No horizontal scale without redesigning replication.*
- **Vanilla JS / CSS / HTML, no build step** — zero toolchain rot, CSP-clean by default, longer code is the trade.
- **Helmet strict CSP** — no inline scripts, styles, handlers, or `eval`. Fix at source; don't relax.
- **bcrypt** for passwords, **nodemailer** (stdout fallback in dev) for SMTP, **pino** for structured logs, **cookie-parser**, **compression**, **busboy** for uploads.
- **Fly.io** single machine + persistent volume; **Litestream** → S3-compatible bucket (e.g. Tigris) for replication.
- **Why this combo**: one box, one file, one process. Operationally cheap. Recovery is "restore one file."

## 2. Project layout

```
server/
  routes/        HTTP handlers — thin; auth + parsing only.
  services/      Business logic + permission enforcement. Reused by routes, CLI, tests.
  db/            connection.js, migrate.js, migrations/NNNN_*.sql, per-table query modules.
  middleware/    requireUser, csrf, rateLimit, requireProjectRole, requireSuperAdmin.
public/
  lib/           state.js, router.js, api.js, debounce.js, relativeTime.js, filters helper.
  components/    DOM-returning functions: render(props) → HTMLElement.
  views/         Route view modules — one per top-level hash route.
test/            vitest + supertest, in-memory SQLite per test.
e2e/             Playwright specs.
scripts/         migrate, seed-e2e, backup, restore, sync-attachments, etc.
```

`package.json` scripts to keep: `start`, `dev` (`node --watch`), `start:e2e` (port 8081, file-backed DB, `SMTP_HOST=` blank, `E2E_EMAIL_LOG=...`), `test`, `e2e`, `e2e:install`, `lint`, `format`, `migrate`, `db:reset`, `backup`, `restore`.

## 3. Frontend non-negotiables

- **No inline anything.** No `<script>` body, no `<style>` body, no `style="..."` attribute, no `onclick=`. Bind events with `addEventListener` or `h()`'s `on*` keys. Set styles via classes.
- **ESM only.** `<script type="module" src="/lib/main.js"></script>`. One global `app.css`.
- **Four primitives every app re-implements** (vanilla — no framework):

  ```js
  // lib/state.js — event emitter + h() DOM helper
  export const state = { currentUser: null, projects: [] };
  export function set(patch) { Object.assign(state, patch); for (const k of Object.keys(patch)) emit(k, state[k]); }
  export function on(key, fn) { /* subscribe; returns unsubscribe */ }
  export function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  ```

  ```js
  // lib/router.js — hash router
  // Single ROUTES table: [{ name, match: (parts) => params|null }, ...]
  // parseHash(hash) → { name, params, query }; query is parsed URLSearchParams as plain object.
  // startRouter(handlers, mountEl) calls handlers[name](params, mountEl) on hashchange.
  ```

  ```js
  // lib/api.js
  export async function getJson(url) { /* fetch, throw on non-2xx, redirect to /login.html on 401 */ }
  export async function postJson(url, body) {
    const csrf = readCookie('<prefix>_csrf');  // double-submit
    return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(body) }).then(handle);
  }
  export function qs(obj) { /* build ?a=1&b=2 from a plain object, skipping null/undefined */ }
  ```

  ```js
  // lib/debounce.js, lib/relativeTime.js — small utilities
  ```

- **`localStorage` namespace**: `<app>.<feature>.${userId}.${scopeId}` (e.g. `invoicing.invoiceFilters.42.7`). User-scoped keeps multi-account dev sane; scope-id-suffixed keeps per-project state isolated.
- **Filters/list state**: round-trip through URL (canonical) ↔ `localStorage` (sticky default) ↔ DOM. URL wins on entry; localStorage falls back; system defaults if neither.

## 4. Backend conventions

- **Append-only migrations.** `server/db/migrations/NNNN_name.sql`. Runner records applied set in a meta table. **Never edit a shipped migration** — write a new one.
- **DB connection** opens with: `journal_mode = WAL` (Litestream prerequisite), `foreign_keys = ON`, `busy_timeout = 5000`.
- **Multi-table writes** wrapped in `db.transaction(() => { ... })`.
- **Permissions enforced in services, not routes.** Bulk paths, CLI tools, and any future API surface reuse them. Routes handle parsing + 401/403 mapping only.
- **History/audit pattern**: parent event row + N child change rows (`kind`, `old_value`, `new_value`, `actor_id`, `at`). Resolve FK ids to display strings *before* writing change rows so the log survives renames.
- **`config.js` fails fast in production**: throws if any required env var is missing. Dev gets sensible no-op defaults (e.g. ephemeral `SESSION_SECRET` with a warning).

## 5. Auth model

- **Signed `HttpOnly` `SameSite=Lax` session cookie.** 30-day TTL, `last_seen_at` refreshed (throttled) on every authenticated request. `Secure` in production. **No JWT.**
- **Magic-link primary, password secondary.** Tokens stored as SHA-256 hashes; one-time use; expire on first redemption.
- **First-login bootstrap**: when an unknown email matching `SUPER_ADMIN_EMAIL` requests a magic link, the route auto-creates the user. No separate "create admin" flow.
- **CSRF double-submit**:
  - Mint a non-`HttpOnly` `<prefix>_csrf` cookie on the first response from any endpoint.
  - On `/api/*` POST/PATCH/PUT/DELETE with a session cookie present, require `X-CSRF-Token` header equal to cookie. Reply `403 {"error":"csrf"}` on mismatch.
  - Auth routes (`/auth/*`) are pre-session and exempt.
  - GET/HEAD/OPTIONS are always exempt.
- **Rate limiter**: in-memory token bucket keyed by IP or email; LRU evicts at ~10k buckets. Doesn't survive restart and assumes a single machine — both fine for this stack.

## 6. Deploy model (Fly.io)

- **Single machine**, `auto_stop_machines = 'stop'`, `min_machines_running = 0`. Persistent volume mounted at `/data`.
- **Migrations run on the live app machine** via the Docker entrypoint — not via `release_command`. Fly's release machine doesn't reliably mount the persistent volume, so a `release_command` migration would create the DB on ephemeral fs and lose it on machine destroy.
- **`/healthz` performs a tiny DB *write*** (bumps a `_health` row). Failing means the volume detached or DB went read-only — better than a static 200.
- **Required prod env vars**: `SESSION_SECRET`, `SUPER_ADMIN_EMAIL`, `BASE_URL`, `DB_PATH`, `ATTACHMENTS_DIR`. Production refuses to boot without them.
- **Optional**: `PORT` (default 8080), `LOG_LEVEL`, `SMTP_HOST/PORT/SECURE/USER/PASS/FROM` (unset → emails log to stdout, password login still works), `BUCKET_NAME`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION`, `BACKUP_SNAPSHOT_RETENTION_DAYS` (default 30).
- **Dockerfile**: pin Litestream version (e.g. `v0.3.13`); use `linux-amd64` for standard Fly machines (`linux-arm64` if scheduling on ARM). Don't drop to a non-root user — Fly's volume is root-owned and dropping breaks migrations + writes. Use `CMD ["/app/docker-entrypoint.sh"]` (not `ENTRYPOINT`) so a release command can override for one-off jobs.

## 7. Backup & disaster recovery

- **Litestream** replicates the SQLite file continuously to an S3-compatible bucket. Target RPO ~1s, retention 168h (7 days). Wire credentials via env (e.g. from `fly storage create`); never inline them in `litestream.yml`.
- **Daily `VACUUM INTO` snapshots** uploaded to `snapshots/` in the same bucket. Single-file, human-browseable, easy to download. Schedule from a **GitHub Actions cron** that calls `flyctl ssh console -a <app> -C 'node /app/scripts/backup.js'` — runs in-process on the live machine, avoiding the single-volume mount conflict a Fly scheduled-machine cron would hit.
- **Attachments** (if the app has them) write through to the same bucket under `attachments/<...>` synchronously after the local volume write + DB row insert. Best-effort; a `sync-attachments.js` reconcile script catches gaps.
- **Fail-closed restore gate.** The Docker entrypoint is PID 1 and decides on boot:

  | DB on `/data` | sentinel `/data/.allow-restore` | bucket creds | action |
  |---|---|---|---|
  | present     | n/a     | any   | `litestream replicate -exec "node server/index.js"` |
  | missing     | absent  | set   | log FATAL, sleep forever, healthz fails — operator intervenes |
  | missing     | present | set   | `litestream restore`, delete sentinel (single-use), then replicate + exec node |
  | any         | any     | unset | exec node directly (local `docker run` / dev) |

  Why operator-armed: auto-restore would (a) silently self-heal a wrong-volume mount, masking incidents, and (b) on a first-ever deploy where the replica is also empty, let Node start a new generation on top of what might be a real replica.

- **Operator alerts**: best-effort SMTP email on `gate-fired` and `restore-complete`. Reuses existing `SMTP_*` config. Never load-bearing — entrypoint logs are the source of truth.
- **Restore drill**: quarterly, **staging only**. Create a marker row, kill `litestream` cleanly, delete the DB + WAL + SHM files, verify the gate fires, arm + reboot, verify the marker row returned and the sentinel was consumed.
- **Disaster recovery (prod)**: `fly scale count 0` → fresh volume if needed → `fly scale count 1` → SSH + `touch /data/.allow-restore` → restart → run `restore-attachments.js`. Optional point-in-time: `litestream restore -timestamp <iso>` instead of restart-driven restore.
- **Restore from a daily snapshot** (when Litestream replica was corrupted by post-incident writes, or you want "yesterday morning"): `node /app/scripts/restore.js --key=snapshots/<file>.sqlite --out=/data/<db> --force` then restart so Litestream re-bases.

## 8. Testing

- **Unit/integration**: vitest + supertest. A `test/db.js` helper builds a fresh in-memory SQLite per test (or per file) and runs migrations against it. Pino silenced (`level: 'silent'`).
- **E2E**: Playwright + chromium. File-backed `./data/e2e.sqlite` seeded by `scripts/seed-e2e.js`. Server on `:8081` via `npm run start:e2e` (Playwright's `webServer` spawns it). Multi-project config (setup → authed, admin-setup → admin-authed, unauthed); authed specs reuse `.auth/<role>.json` storage state. **15s `expect` timeout** to absorb SQLite contention.
- **Don't mock the DB.** Real SQLite, fresh per test. Mocked tests pass while migrations break in prod.

## 9. Operational practices

- **In-app error log + admin audit log** in dedicated tables (`error_log`, `admin_audit`). Errors auto-pruned to 30 days by an in-process timer; audit has no retention cap. Surfaced under `#/admin/errors` and `#/admin/audit`.
- **Rotate `SESSION_SECRET`** to invalidate every session at once.
- **Super admin is identified by env var, not a DB flag.** Rotation = `fly secrets set SUPER_ADMIN_EMAIL=...` + redeploy. The user row stays put.
- **Locked-out admin recovery** (in order of preference):
  1. Set `SUPER_ADMIN_EMAIL` to a temporary recovery address; magic-link auto-creates the user; fix the original from the admin UI.
  2. `fly secrets unset SMTP_HOST` + redeploy → request magic link → grep `dev-email` in `fly logs` → paste URL into browser → re-set `SMTP_HOST`.
  3. SSH + `sqlite3` to inspect `users` table (read-only). Never edit `users.email` directly — breaks audit FKs.
- **Logging**: pino, JSON in production, pretty in dev, silenced in tests. Sanitize query strings (token, code, password, email) before they hit the request log.

## 10. Avoid

- Inline `<script>`, `<style>`, `style=`, `onclick=`, `eval`, `new Function` — fix at source, never relax CSP.
- Editing a shipped migration (write a new one).
- `litestream replicate` from two machines against the same bucket path (silent corruption).
- Inlining S3 credentials in `litestream.yml` (breaks rotation).
- Auto-restore — always operator-armed via `/data/.allow-restore`.
- Horizontal scale without redesigning replication.
- Mocking the DB in tests.
- `release_command` for migrations (volume not mounted).
- Dropping to a non-root user in the Dockerfile (Fly volume is root-owned).
- `git push` from Claude — maintainer pushes manually.
