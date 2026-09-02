#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
. supabase/tests/lib.sh

test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT
mkdir -p "$test_root/tools" "$test_root/postgres"

for command_name in psql createdb dropdb; do
  printf '#!/usr/bin/env sh\nexit 0\n' > "$test_root/postgres/$command_name"
  chmod +x "$test_root/postgres/$command_name"
done
printf '#!/usr/bin/env sh\nprintf primary-go\n' > "$test_root/tools/go"
printf '#!/usr/bin/env sh\nprintf shadow-go\n' > "$test_root/postgres/go"
chmod +x "$test_root/tools/go" "$test_root/postgres/go"

PATH="$test_root/tools:$test_root/postgres:/usr/bin:/bin"
original_path="$PATH"
INFERSPOOL_PSQL="$test_root/postgres/psql"
inferspool_setup_pg

[ "$PATH" = "$original_path" ] || {
  echo "PostgreSQL setup reordered an existing PATH entry" >&2
  exit 1
}
[ "$(go)" = "primary-go" ] || {
  echo "PostgreSQL setup shadowed an earlier tool" >&2
  exit 1
}

PATH="$test_root/tools:/usr/bin:/bin"
inferspool_setup_pg
case "$PATH" in
  "$test_root/postgres:"*) ;;
  *)
    echo "PostgreSQL setup did not add a missing bin directory" >&2
    exit 1
    ;;
esac
command -v createdb >/dev/null
command -v dropdb >/dev/null

echo "PostgreSQL PATH setup tests passed."
