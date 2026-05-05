# Basic Invoices

Open-source invoicing for solo consultants. Track time (yours and your subcontractors'), expenses, and milestones; generate PDF invoices; collect payments; ship a monthly recurring schedule that drops drafts in your inbox for review.

> **Status: pre-alpha.** The repo currently contains design docs only. Build is staged in [`DEVELOPMENT.md`](./DEVELOPMENT.md); each stage is independently shippable. The commands below describe the target shape — they will start working as Stage 0 lands.

## Why another invoicing app

Most invoicing tools are SaaS subscriptions priced for agencies. Basic Invoices is a single-binary app you self-host on a [Fly.io](https://fly.io) machine for a few dollars a month, owns your data in a single SQLite file, and is small enough to read end to end.

- **One super admin** (you, the consultant) plus optional **subcontractors** who log hours.
- **Clients never log in.** They get a PDF + an obfuscated public link.
- **USD only**, **no tax**, **no public API** in v1 — deliberate scope cuts.
- **Stripe** support is one field: paste a Payment Link URL and it appears on the invoice.

## Stack

- **Server:** Node 22 LTS, Express, [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3), bcrypt, nodemailer, helmet (strict CSP), pino.
- **Client:** vanilla ESM modules, single `app.css`, **no build step**.
- **PDF:** `puppeteer-core` + `@sparticuz/chromium`, sharing one HTML template with the public web view.
- **Storage:** SQLite on a Fly volume, replicated continuously via [Litestream](https://litestream.io) to S3-compatible object storage.
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

`SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` for outbound email (omit in dev — emails log to stdout). S3 credentials (`BUCKET_NAME`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION`) for Litestream replication.

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

`min_machines_running = 1` is required so the in-process recurring-billing timer fires hourly. See [`WEBAPP_PLAYBOOK.md`](./WEBAPP_PLAYBOOK.md) §6–7 for the full deploy + Litestream restore-gate model.

## Documentation

- [`DEVELOPMENT.md`](./DEVELOPMENT.md) — staged build plan, schema, design decisions.
- [`WEBAPP_PLAYBOOK.md`](./WEBAPP_PLAYBOOK.md) — the portable Node + SQLite + Fly conventions this app inherits from (auth, CSRF, migrations, backup/restore).
- [`AGENTS.md`](./AGENTS.md) — repo-specific notes for AI coding assistants.

## Contributing

Issues and pull requests are welcome. Please keep changes aligned with the stage plan in `DEVELOPMENT.md` and the no-build / no-inline-anything constraints in `WEBAPP_PLAYBOOK.md`.

## License

[MIT](./LICENSE) © James Terry
