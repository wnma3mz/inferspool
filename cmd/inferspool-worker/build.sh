#!/usr/bin/env bash
# Build static worker binaries for the platforms used by GPU hosts.
set -euo pipefail

cd "$(dirname "$0")"

VERSION="${1:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}"
OUT=dist
mkdir -p "$OUT"
LDFLAGS="-s -w -X main.version=$VERSION"
[ -n "${INFERSPOOL_BUILD_URL:-}" ] && LDFLAGS="$LDFLAGS -X main.defaultServerURL=$INFERSPOOL_BUILD_URL"
[ -n "${INFERSPOOL_BUILD_GATEWAY_KEY:-}" ] && LDFLAGS="$LDFLAGS -X main.defaultGatewayKey=$INFERSPOOL_BUILD_GATEWAY_KEY"

targets=(
  "darwin arm64"
  "darwin amd64"
  "linux amd64"
  "linux arm64"
  "windows amd64"
  "windows arm64"
)

echo "building inferspool-worker $VERSION"
for target in "${targets[@]}"; do
  read -r goos goarch <<< "$target"
  name="inferspool-worker-$goos-$goarch"
  [ "$goos" = "windows" ] && name="$name.exe"
  CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
    go build -trimpath -ldflags "$LDFLAGS" -o "$OUT/$name" .
  size=$(du -h "$OUT/$name" | cut -f1)
  printf '  %-33s %s\n' "$name" "$size"
done

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$OUT" && sha256sum inferspool-worker-* > SHA256SUMS)
else
  (cd "$OUT" && shasum -a 256 inferspool-worker-* > SHA256SUMS)
fi

echo "binaries in $OUT/"
