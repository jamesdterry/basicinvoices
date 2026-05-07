-- 0012_branding.sql — Stage 10: invoice branding singleton.
--
-- The rendered invoice (HTML + PDF + email attachment) needs a company name,
-- a multi-line mailing address, an accent color, and an optional logo. This
-- is config, not domain data, so a singleton row works the same way as
-- _health and _recurring_meta. The seed row exists so services/branding.js
-- can always SELECT it back without a NULL guard.
--
-- accent_color_hex matches the existing public/invoice.css `--accent` default
-- so an unconfigured install renders identically to the pre-Stage-10 invoice.
--
-- Logo bytes live in SQLite (Litestream covers replication, ops parity with
-- the rest of the schema). Service-level cap at 256 KB keeps PDF bloat
-- bounded; the schema only enforces the allowed mime list.

CREATE TABLE IF NOT EXISTS branding (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  company_name      TEXT    NOT NULL DEFAULT '',
  business_address  TEXT    NOT NULL DEFAULT '',
  accent_color_hex  TEXT    NOT NULL DEFAULT '#2a6df4'
                    CHECK (accent_color_hex GLOB
                      '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
  logo_filename     TEXT,
  logo_mime         TEXT
                    CHECK (logo_mime IN
                      ('image/png','image/jpeg','image/webp','image/svg+xml')),
  logo_bytes        BLOB,
  updated_at        TEXT    NOT NULL
);

INSERT OR IGNORE INTO branding (id, accent_color_hex, updated_at)
  VALUES (1, '#2a6df4', '1970-01-01T00:00:00.000Z');
