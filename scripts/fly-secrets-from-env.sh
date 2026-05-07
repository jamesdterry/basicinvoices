#!/usr/bin/env bash
# Push the contents of .env.production (or another env file) into fly.io as
# secrets, in a single rolling deploy. Uses `fly secrets import` so all keys
# are staged together — N keys = 1 redeploy, not N.
#
# Usage:
#   scripts/fly-secrets-from-env.sh                # defaults to .env.production
#   scripts/fly-secrets-from-env.sh .env.staging   # any env file
#   scripts/fly-secrets-from-env.sh -a my-app      # override fly app name
#
# Skips comment lines (`# ...`) and blank lines. Strips an optional `export `
# prefix. Skips lines whose value is empty so a commented-out optional var
# doesn't accidentally clear an existing fly secret.
#
# Secret values are NEVER echoed; only the key names are shown for confirmation.

set -euo pipefail

ENV_FILE=".env.production"
FLY_APP_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    -a|--app)
      FLY_APP_ARGS+=("--app" "$2")
      shift 2
      ;;
    -h|--help)
      sed -n '2,16p' "$0"
      exit 0
      ;;
    -*)
      echo "unknown flag: $1" >&2
      exit 2
      ;;
    *)
      ENV_FILE="$1"
      shift
      ;;
  esac
done

if [ ! -f "$ENV_FILE" ]; then
  echo "error: $ENV_FILE not found" >&2
  exit 1
fi

if ! command -v fly >/dev/null 2>&1; then
  echo "error: fly CLI not found in PATH" >&2
  exit 1
fi

# Build the filtered KEY=VALUE stream once so we can both preview keys and
# pipe into fly. Strip CR (in case the file was edited on Windows), strip
# `export `, skip comments / blank lines / empty-value lines.
filtered="$(
  sed -e 's/\r$//' \
      -e 's/^[[:space:]]*export[[:space:]]\+//' \
      "$ENV_FILE" \
    | awk '
        /^[[:space:]]*#/ { next }
        /^[[:space:]]*$/ { next }
        # require KEY=... ; require non-empty value after the =
        /^[A-Za-z_][A-Za-z0-9_]*=/ {
          eq = index($0, "=")
          val = substr($0, eq + 1)
          if (val == "") next
          print
        }
      '
)"

if [ -z "$filtered" ]; then
  echo "error: no settable keys found in $ENV_FILE" >&2
  exit 1
fi

echo "About to set the following fly secrets from $ENV_FILE:"
echo "$filtered" | awk -F= '{ print "  - " $1 }'
echo
echo "This triggers ONE rolling deploy of the fly app."
read -r -p "Continue? [y/N] " reply
case "$reply" in
  y|Y|yes|YES) ;;
  *) echo "aborted."; exit 1 ;;
esac

printf '%s\n' "$filtered" | fly secrets import ${FLY_APP_ARGS[@]+"${FLY_APP_ARGS[@]}"}

echo
echo "done. Verify with: fly secrets list ${FLY_APP_ARGS[@]+${FLY_APP_ARGS[*]}}"
