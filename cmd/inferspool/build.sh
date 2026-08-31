#!/usr/bin/env bash
# Cross-compile inferspool for the platforms your friends are likely to have.
# Static binaries with no runtime dependency: hand someone the file and it runs.
set -euo pipefail

cd "$(dirname "$0")"

VERSION="${1:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}"
OUT=dist
mkdir -p "$OUT"

# -s -w strips the symbol table and DWARF info: ~30% smaller, and nothing here
# is ever debugged from a shipped binary.
LDFLAGS="-s -w -X main.version=$VERSION"
[ -n "${INFERSPOOL_BUILD_URL:-}" ] && LDFLAGS="$LDFLAGS -X main.defaultServerURL=$INFERSPOOL_BUILD_URL"
[ -n "${INFERSPOOL_BUILD_GATEWAY_KEY:-}" ] && LDFLAGS="$LDFLAGS -X main.defaultGatewayKey=$INFERSPOOL_BUILD_GATEWAY_KEY"
[ -n "${INFERSPOOL_BUILD_RELEASE_URL:-}" ] && LDFLAGS="$LDFLAGS -X main.defaultReleaseBase=$INFERSPOOL_BUILD_RELEASE_URL"

targets=(
  "darwin arm64"    # Apple silicon
  "darwin amd64"    # Intel macs
  "linux amd64"
  "linux arm64"
  "windows amd64"
  "windows arm64"
)

echo "building inferspool $VERSION"
for target in "${targets[@]}"; do
  read -r goos goarch <<< "$target"
  name="inferspool-$goos-$goarch"
  [ "$goos" = "windows" ] && name="$name.exe"

  CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
    go build -trimpath -ldflags "$LDFLAGS" -o "$OUT/$name" .

  size=$(du -h "$OUT/$name" | cut -f1)
  printf '  %-26s %s\n' "$name" "$size"
done

# Checksums, so recipients can verify what they downloaded. sha256sum is the
# native tool on Linux; macOS ships shasum instead.
if command -v sha256sum > /dev/null 2>&1; then
  (cd "$OUT" && sha256sum inferspool-* > SHA256SUMS)
else
  (cd "$OUT" && shasum -a 256 inferspool-* > SHA256SUMS)
fi

echo
echo "binaries in $OUT/ — install with:"
echo "  chmod +x $OUT/inferspool-<os>-<arch> && mv $OUT/inferspool-<os>-<arch> /usr/local/bin/inferspool"
