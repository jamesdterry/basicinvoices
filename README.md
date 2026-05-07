# Basic Invoices

Open-source invoicing for solo consultants. Track time (yours and your subcontractors'), expenses, and milestones; generate PDF invoices; collect payments; ship a monthly recurring schedule that drops drafts in your inbox for review.

## Why another invoicing app

Most invoicing tools are SaaS subscriptions priced for agencies. Basic Invoices is a single-binary app you self-host on a [Fly.io](https://fly.io) machine for a few dollars a month, owns your data in a single SQLite file, and is small enough to read end to end.

- **One super admin** (you, the consultant) plus optional **subcontractors** who log hours.
- **Clients never log in.** They get a PDF + an obfuscated public link at `/i/<token>`.
- **USD only**, **no tax**, **no public API** — deliberate scope cuts.
- **Stripe Payment Links** are optional. Set `STRIPE_SECRET_KEY` and one click on a draft generates a hosted Payment Link; without a key, paste a URL manually and it appears on the invoice.
- **Recurring billing** drops monthly drafts (time-and-expenses or fixed-milestone). Optional `auto_send` mails the draft as soon as it's generated.
- **Branding.** Set company name, multi-line address, accent color, and logo once; every invoice (HTML + PDF + email) picks them up.

## What's shipped

Stages 0–10 are complete: auth + magic links, clients/projects/members, time entries, expenses + milestones, invoices (draft → sent → paid → void) with public `/i/<token>` HTML + PDF, Stripe Payment Links, payments + auto-status, recurring schedules with TOTP-pinged cron, payments reports (JSON + CSV), and invoice branding.

## Stack

- **Server:** Node 22 LTS, Express, [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3), bcrypt, nodemailer, helmet (strict CSP), pino, [`stripe`](https://github.com/stripe/stripe-node) (optional), busboy.
- **Client:** vanilla ESM modules, single `app.css`, **no build step**.
- **PDF:** `puppeteer-core` + `@sparticuz/chromium`, sharing one HTML template with the public web view.
- **Storage:** SQLite on a Fly volume; back up by snapshotting the volume or replicating to S3-compatible object storage with [Litestream](https://litestream.io).
- **Tests:** [vitest](https://vitest.dev) + supertest for unit/integration; [Playwright](https://playwright.dev) for end-to-end.

## Quickstart

```bash
git clone https://github.com/jamesdterry/basicinvoices.git
cd basicinvoices
npm install
cp .env.example .env          # fill in SUPER_ADMIN_EMAIL at minimum
npm run migrate
npm run dev
```

Open <http://localhost:8080>, enter your super-admin email, and follow the magic-link URL printed to the terminal (no SMTP required for local dev).

### Required environment

| Var                  | Notes                                                     |
| -------------------- | --------------------------------------------------------- |
| `SUPER_ADMIN_EMAIL`  | The one email that auto-creates a super-admin on first login. |
| `SESSION_SECRET`     | Long random string. Rotate to invalidate every session.   |
| `BASE_URL`           | Public origin, e.g. `https://invoices.example.com`.       |
| `DB_PATH`            | Path to the SQLite file (e.g. `/data/basicinvoices.sqlite`). |

### Optional

- `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` — outbound email. Omit in dev and emails log to stdout.
- `STRIPE_SECRET_KEY` — enables the Generate-link button on draft and sent invoices. Without it, manual paste of a Payment Link URL is the fallback.
- `RECURRING_TICK_SECRET` — TOTP shared secret for the GitHub Actions cron that wakes a stopped Fly machine to fire recurring schedules. Without it, recurring still runs on wake-on-activity (any super-admin app load triggers a tick). See [`DEPLOY.md`](./DEPLOY.md).
- Litestream credentials (`BUCKET_NAME`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION`) for streaming SQLite to object storage.

## Tests

```bash
npm test               # vitest + supertest, in-memory SQLite per test
npm run e2e:install    # one-time: install Playwright's chromium
npm run e2e            # Playwright against a file-backed test DB on :8081
```

## Deploying to Fly.io

```bash
fly launch --no-deploy            # accept the generated fly.toml
fly volumes create data --size 1
fly secrets set SUPER_ADMIN_EMAIL=you@example.com \
                SESSION_SECRET=$(openssl rand -hex 32) \
                BASE_URL=https://<app>.fly.dev
fly deploy
```

Recurring billing is driven by three convergent triggers (in-process timer, wake-on-activity from `/api/me`, and a daily TOTP-pinged GitHub Action against `/cron/recurring-tick`), so the app runs happily with `auto_stop_machines = "stop"` + `min_machines_running = 0`. The full production runbook — fly secrets, GitHub Actions setup, TOTP rotation, and recovery — lives in [`DEPLOY.md`](./DEPLOY.md).

## Documentation

- [`DEPLOY.md`](./DEPLOY.md) — production deploy runbook (fly secrets, GitHub secrets, rotation, recovery).
- [`DEVELOPMENT.md`](./DEVELOPMENT.md) — staged build plan, schema, design decisions.
- [`AGENTS.md`](./AGENTS.md) — repo-specific notes for AI coding assistants.
- [`WEBAPP_PLAYBOOK.md`](./WEBAPP_PLAYBOOK.md) — the portable Node + SQLite + Fly conventions this app inherits from (auth, CSRF, migrations, backup/restore).

## Contributing

Issues and pull requests are welcome. Please keep changes aligned with the stage plan in `DEVELOPMENT.md` and the no-build / no-inline-anything constraints in `WEBAPP_PLAYBOOK.md`.

## License

[MIT](./LICENSE) © James Terry
