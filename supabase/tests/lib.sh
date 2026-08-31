#!/usr/bin/env bash
# Shared shell helpers: locate psql without assuming a Homebrew install.

inferspool_find_psql() {
  if [ -n "${INFERSPOOL_PSQL:-}" ]; then
    echo "$INFERSPOOL_PSQL"; return 0
  fi
  if command -v psql > /dev/null 2>&1; then
    command -v psql; return 0
  fi
  for dir in \
      /opt/homebrew/opt/postgresql@16/bin \
      /usr/local/opt/postgresql@16/bin \
      /Applications/Postgres.app/Contents/Versions/latest/bin \
      /usr/lib/postgresql/16/bin \
      /usr/lib/postgresql/15/bin; do
    if [ -x "$dir/psql" ]; then
      echo "$dir/psql"; return 0
    fi
  done
  echo "psql not found. Install PostgreSQL, add it to PATH, or set" >&2
  echo "INFERSPOOL_PSQL=/path/to/psql" >&2
  return 1
}

# Put the discovered install first on PATH, so createdb/dropdb resolve too.
inferspool_setup_pg() {
  local psql_path
  psql_path="$(inferspool_find_psql)" || return 1
  export PATH="$(dirname "$psql_path"):$PATH"
}
