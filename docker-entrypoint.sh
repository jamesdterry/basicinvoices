#!/bin/sh
# Fail-closed Litestream restore gate. Implements WEBAPP_PLAYBOOK.md §7 verbatim.
#
# | DB on /data | sentinel /data/.allow-restore | bucket creds | action                                       |
# |-------------|-------------------------------|--------------|----------------------------------------------|
# | present     | n/a                           | any          | litestream replicate -exec node              |
# | missing     | absent                        | set          | log FATAL, sleep forever (operator unblocks) |
# | missing     | present                       | set          | restore, delete sentinel, replicate -exec    |
# | any         | any                           | unset        | exec node directly                           |

set -eu

DB_PATH="${DB_PATH:-/data/basicinvoices.sqlite}"
SENTINEL="/data/.allow-restore"
APP_CMD='node server/index.js'

log() { echo "[entrypoint] $*"; }

has_creds() {
  [ -n "${BUCKET_NAME:-}" ] && [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ]
}

if ! has_creds; then
  log "no Litestream creds — running node directly (dev/local)"
  exec sh -c "$APP_CMD"
fi

if [ -f "$DB_PATH" ]; then
  log "DB present at $DB_PATH — replicate + exec"
  exec litestream replicate -exec "$APP_CMD"
fi

if [ ! -f "$SENTINEL" ]; then
  log "FATAL: DB missing at $DB_PATH and no $SENTINEL sentinel."
  log "FATAL: refusing to auto-restore. Operator must:"
  log "FATAL:   fly ssh console -a <app> -C 'touch $SENTINEL' && restart"
  log "FATAL: sleeping forever; healthz will fail until intervention."
  while true; do sleep 3600; done
fi

log "DB missing + sentinel present + creds set — restoring from Litestream"
litestream restore -if-replica-exists -o "$DB_PATH" "$DB_PATH"

if [ ! -f "$DB_PATH" ]; then
  log "FATAL: restore did not produce $DB_PATH"
  while true; do sleep 3600; done
fi

log "restore complete; consuming sentinel"
rm -f "$SENTINEL"

exec litestream replicate -exec "$APP_CMD"
