#!/usr/bin/env bash
# Full local suite: schema, queue semantics, security, concurrency, worker,
# CLI, recovery. Everything runs against real Postgres and real HTTP — no
# mocked database, no GPU, no cloud.
#
# Needs: PostgreSQL (any recent version), Python 3.11+, the Go version in
# cmd/inferspool-worker/go.mod, and pnpm.
# Set INFERSPOOL_PSQL if psql is not on PATH.
set -uo pipefail

cd "$(dirname "$0")"
. supabase/tests/lib.sh
inferspool_setup_pg || exit 1

DB="${INFERSPOOL_TEST_DB:-inferspool_test}"
PY=.venv/bin/python
fails=0

section() { printf '\n== %s ==\n' "$1"; }
run() {  # run <label> <command...>
  if ! "${@:2}"; then
    echo "FAILED: $1"
    fails=$((fails + 1))
  fi
}

command -v uv >/dev/null || { echo "uv is required (https://docs.astral.sh/uv/)"; exit 1; }
uv sync --frozen --quiet || exit 1

section "resetting $DB"
dropdb --if-exists "$DB"
createdb "$DB"
# shim: Supabase-provided pieces (auth.uid, realtime) faked locally.
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f supabase/tests/shim.sql > /dev/null
for migration in supabase/migrations/*.sql; do
  migration_log=$(mktemp)
  if ! psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$migration" >"$migration_log" 2>&1; then
    cat "$migration_log"
    exit 1
  fi
  grep -v 'NOTICE' "$migration_log" || true
done
# helpers call shipped functions, so they load after the schema.
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f supabase/tests/helpers.sql > /dev/null

section "queue semantics"
run "queue" psql -q -v ON_ERROR_STOP=1 -d "$DB" -f supabase/tests/queue_test.sql

section "api keys and batch claim"
run "batch-sql" psql -q -v ON_ERROR_STOP=1 -d "$DB" -f supabase/tests/batch_test.sql

section "service registry"
run "services-sql" psql -q -v ON_ERROR_STOP=1 -d "$DB" -f supabase/tests/services_test.sql

section "product foundation"
run "product-sql" psql -q -v ON_ERROR_STOP=1 -d "$DB" -f supabase/tests/product_test.sql

section "security and RLS"
# Runs as a real `authenticated` role. The suites above run as the table owner,
# which bypasses RLS, so these checks live separately.
run "security" psql -q -v ON_ERROR_STOP=1 -d "$DB" -f supabase/tests/security_test.sql

section "concurrency"
# security_test leaves RLS forced on; the remaining suites run as owner.
psql -q -d "$DB" -c "alter table jobs no force row level security" > /dev/null
run "concurrency" ./supabase/tests/concurrency_test.sh "$DB"
run "product-concurrency" ./supabase/tests/product_concurrency_test.sh "$DB"

section "worker unit"
run "worker-unit" bash -c 'cd cmd/inferspool-worker && go vet ./... && go test -race ./...'

section "worker end-to-end"
run "worker-e2e" "$PY" cmd/inferspool-worker/tests/test_worker.py

section "worker recovery"
run "worker-recovery" "$PY" cmd/inferspool-worker/tests/test_recovery.py

section "cli unit"
# Each command is its own Go module, so tests run from its directory.
run "cli-unit" bash -c 'cd cmd/inferspool && go vet ./... && go test ./...'
run "installer" ./scripts/tests/install_test.sh

section "cli end-to-end"
run "cli-e2e" ./cmd/inferspool/tests/e2e.sh

section "web build"
run "web" bash -c 'cd web && pnpm run build 2>&1 | grep -qE "Compiled successfully"'
run "web-types" bash -c 'cd web && ./node_modules/.bin/tsc --noEmit'

section "browser end-to-end"
run "web-e2e" bash -c 'cd web && pnpm test:e2e'

printf '\n'
if [ "$fails" -gt 0 ]; then
  echo "$fails SUITE(S) FAILED"
  exit 1
fi
echo "All suites passed."
