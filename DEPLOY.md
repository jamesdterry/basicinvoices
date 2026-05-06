# Deploy

Operational runbook for the production deploy on Fly.io. Pairs with `WEBAPP_PLAYBOOK.md` (stack conventions) and `AGENTS.md` (project conventions). The README's "Quickstart" covers local dev — this file is the production checklist.

## TL;DR — routine deploy

```bash
fly deploy
curl -sf https://basicinvoices.fly.dev/healthz   # smoke-test
```

Migrations apply on boot. The recurring tick fires automatically (see "Trigger paths" below).

---

## First-time setup

### 1. Fly app + volume

```bash
fly launch --no-deploy            # creates the app from fly.toml; pick region near you
fly volumes create data --size 1  # 1 GB SQLite volume; fly.toml mounts it at /data
```

### 2. Required server secrets

Fail-fast in production — the app refuses to boot without these (`server/config.js`).

| Secret | How to set | Notes |
| --- | --- | --- |
| `SUPER_ADMIN_EMAIL` | `fly secrets set SUPER_ADMIN_EMAIL=you@example.com` | Auto-creates the super-admin user on first magic-link login. |
| `SESSION_SECRET` | `fly secrets set SESSION_SECRET=$(openssl rand -hex 32)` | Rotate to invalidate every session. |
| `BASE_URL` | `fly secrets set BASE_URL=https://basicinvoices.fly.dev` | Public origin; used in invoice email bodies. |
| `DB_PATH` | already `/data/basicinvoices.sqlite` via `fly.toml [env]` | Path on the mounted volume. |

### 3. Optional server secrets

Skip any block you don't need; the app degrades gracefully (no SMTP → emails go to stdout `dev-email` log; no Stripe key → Generate-link button hidden; no tick secret → cron route returns 503).

**SMTP (so invoices and magic-link emails actually deliver):**

```bash
fly secrets set \
  SMTP_HOST=... SMTP_PORT=587 SMTP_SECURE=true \
  SMTP_USER=... SMTP_PASS=... \
  SMTP_FROM='Basic Invoices <invoices@example.com>'
```

**Stripe Payment Links (Stage 7A):**

```bash
fly secrets set STRIPE_SECRET_KEY=sk_live_...
```

`/api/me` flips `stripe_enabled: true`; the SPA shows the Generate / Regenerate buttons. Without this set, manual paste of a Payment Link URL still works.

**Recurring-tick TOTP secret (Stage 8.5) — required for the GitHub Action trigger:**

```bash
SECRET=$(openssl rand -hex 20)        # 20 bytes is the RFC 6238 default
fly secrets set RECURRING_TICK_SECRET="$SECRET"
echo "$SECRET"                         # save — also goes in GitHub repo secrets below
```

The route returns 503 `'tick_disabled'` until this is set. Without it, the daily GH Action fails and the recurring tick relies entirely on wake-on-activity (`/api/me`).

**Litestream replication** (continuous SQLite backup to S3-compatible storage; see `WEBAPP_PLAYBOOK.md §6`):

```bash
fly secrets set \
  BUCKET_NAME=basicinvoices-backups \
  AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
  AWS_ENDPOINT_URL_S3=https://... AWS_REGION=auto
```

Without these, the app boots without replication. The fail-closed restore-gate in `docker-entrypoint.sh` only triggers when both creds AND a sentinel file are present.

### 4. GitHub Actions repo secrets

Used by `.github/workflows/recurring-tick.yml` to ping `/cron/recurring-tick` daily at 13:00 UTC. Set under repo **Settings → Secrets and variables → Actions → New repository secret**.

| Secret | Value |
| --- | --- |
| `RECURRING_TICK_SECRET` | Same value as the fly secret above. The Action computes a TOTP code from this and POSTs it as `X-Recurring-Tick`. |
| `RECURRING_TICK_URL` | `https://basicinvoices.fly.dev/cron/recurring-tick` |

After adding both, trigger the workflow manually once from the **Actions** tab to verify (`Recurring tick → Run workflow`). A successful run prints a JSON `{"results":[...]}` body.

### 5. First deploy

```bash
fly deploy
fly logs                                     # watch boot + first migration apply
curl -sf https://basicinvoices.fly.dev/healthz
```

Then visit `https://basicinvoices.fly.dev/` in a browser, enter the `SUPER_ADMIN_EMAIL` value, and follow the magic-link flow. (If SMTP isn't set, grep `fly logs` for `dev-email` and paste the URL into a browser.)

---

## Operational env (set in `fly.toml [env]`, not secrets)

| Var | Value | Notes |
| --- | --- | --- |
| `PORT` | `8080` | Internal port; `[http_service]` proxies 443 → 8080. |
| `DB_PATH` | `/data/basicinvoices.sqlite` | On the volume mounted at `/data`. |
| `NODE_ENV` | `production` | Triggers fail-fast in `config.js`. |

---

## Trigger paths (recurring billing)

Three paths converge on `services/recurring.js#maybeRunDue` (atomic claim against `_recurring_meta` prevents double-runs). With `auto_stop_machines = "stop"` and `min_machines_running = 0`, only paths (2) and (3) realistically fire in production:

1. **In-process timer** (`server/timers/recurringTick.js`) — only useful when the machine happens to be up for other reasons. Hourly while alive.
2. **Wake-on-activity** (`server/routes/me.js`) — `setImmediate(maybeRunDue)` after every `/api/me` response. Throttled to once per hour by the atomic claim. Fires when the consultant uses the app.
3. **TOTP cron** (`POST /cron/recurring-tick`) — the GitHub Action fires this daily at 13:00 UTC; the inbound HTTP request itself wakes the stopped machine via `auto_start_machines = true`.

If the GH Action stops working you'll find out via failed-workflow emails (and the consultant noticing draft invoices aren't appearing). To debug:

```bash
fly logs                                     # search for 'cron tick'
gh workflow view "Recurring tick" --repo <owner>/basicinvoices
gh run list --workflow recurring-tick.yml
```

To trigger manually from a laptop with the secret in hand:

```bash
CODE=$(node scripts/totp-code.js "$RECURRING_TICK_SECRET")
curl -sf -X POST https://basicinvoices.fly.dev/cron/recurring-tick \
  -H "X-Recurring-Tick: $CODE"
```

---

## Routine ops

### Logs

```bash
fly logs                       # live tail
fly logs --since 1h            # backfill
```

Search terms worth knowing: `recurring tick ran`, `cron tick`, `dev-email`, `stripe paymentLinks`, `migration applied`.

### Database access

```bash
fly ssh console
sqlite3 /data/basicinvoices.sqlite
```

Audit history lives in `admin_audit` + `audit_changes`. Recurring-tick failures land in `error_log`.

### View recurring-tick history

```sql
SELECT a.at, a.summary, a.meta_json
  FROM admin_audit a
 WHERE a.action = 'recurring.run'
 ORDER BY a.id DESC
 LIMIT 20;
```

`meta_json.status` is one of `success | partial | skipped | error`.

---

## Secret rotation

| Secret | Effect of rotating |
| --- | --- |
| `SESSION_SECRET` | Invalidates every active session — everyone has to re-login via magic link. |
| `SUPER_ADMIN_EMAIL` | Effective on next deploy (config is read at boot). The `users` row stays put; the role override moves to whichever email matches the new value. |
| `STRIPE_SECRET_KEY` | Existing Payment Links remain active in Stripe; new Generate calls go through the new key. |
| `RECURRING_TICK_SECRET` | Update **both** the fly secret AND the GitHub repo secret in the same window — the GH Action will start failing the moment the values diverge. |

`fly secrets set X=Y` triggers a rolling deploy automatically.

---

## Disaster recovery

Restore from Litestream backup is **operator-armed** (fail-closed) per `WEBAPP_PLAYBOOK.md §7`. To restore:

1. SSH in: `fly ssh console`.
2. Confirm the volume is wiped or the file is missing.
3. Create the sentinel: `touch /data/RESTORE_FROM_REPLICA`.
4. Restart: `fly machine restart <id>`.
5. `docker-entrypoint.sh` runs `litestream restore` and removes the sentinel.

Never auto-restore. The sentinel is the explicit "yes, replace what's on disk" gate.

---

## Adding a new operational secret to this app

When a future feature adds a new optional integration (e.g. a webhook secret), update **all four** locations in lockstep so this doc stays the source of truth:

1. `server/config.js` — read it from `process.env`, expose it via `config.<name>`.
2. `.env.example` — add a commented stub.
3. `DEPLOY.md` (this file) — add it to the relevant secrets table with a `fly secrets set` example.
4. The relevant `AGENTS.md` bullet — describe the gating behavior when unset.
