#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d)
server_pid=
trap 'test -z "$server_pid" || kill "$server_pid" 2>/dev/null || true; rm -rf "$tmp"' EXIT INT TERM

os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$(uname -m)" in x86_64|amd64) arch=amd64;; arm64|aarch64) arch=arm64;; *) echo "unsupported test architecture"; exit 0;; esac
artifact="inferspool-$os-$arch"
mkdir -p "$tmp/release" "$tmp/bin"
printf '#!/bin/sh\necho installed-fixture\n' > "$tmp/release/$artifact"
chmod 755 "$tmp/release/$artifact"
(cd "$tmp/release" && shasum -a 256 "$artifact" > SHA256SUMS)

port=$((30000 + $$ % 20000))
"$root/.venv/bin/python" -m http.server "$port" --bind 127.0.0.1 --directory "$tmp/release" >"$tmp/server.log" 2>&1 &
server_pid=$!
for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$port/SHA256SUMS" >/dev/null 2>&1 && break; sleep 0.1; done

INFERSPOOL_RELEASE_URL="http://127.0.0.1:$port" INFERSPOOL_INSTALL_DIR="$tmp/bin" \
  INFERSPOOL_GITHUB_REPO="fixture/repo" sh "$root/scripts/install.sh" >/dev/null
test "$("$tmp/bin/inferspool")" = installed-fixture

printf 'tampered\n' >> "$tmp/release/$artifact"
if INFERSPOOL_RELEASE_URL="http://127.0.0.1:$port" INFERSPOOL_INSTALL_DIR="$tmp/bin" \
  INFERSPOOL_GITHUB_REPO="fixture/repo" sh "$root/scripts/install.sh" >"$tmp/tamper.log" 2>&1; then
  echo "installer accepted a tampered binary" >&2
  exit 1
fi
grep -qE 'FAILED|did NOT match|checksum' "$tmp/tamper.log"
echo "Installer checksum tests passed."
