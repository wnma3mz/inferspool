#!/usr/bin/env sh
set -eu

repo="${INFERSPOOL_GITHUB_REPO:-@GITHUB_REPOSITORY@}"
[ "$repo" != "@GITHUB_REPOSITORY@" ] || {
  echo "source installer has no repository; set INFERSPOOL_GITHUB_REPO=owner/repo or use the installer attached to a release" >&2
  exit 1
}
base="${INFERSPOOL_RELEASE_URL:-https://github.com/$repo/releases/latest/download}"
install_dir="${INFERSPOOL_INSTALL_DIR:-/usr/local/bin}"
os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$arch" in x86_64|amd64) arch=amd64;; arm64|aarch64) arch=arm64;; *) echo "unsupported architecture: $arch" >&2; exit 1;; esac
case "$os" in darwin|linux) ;; *) echo "unsupported operating system: $os" >&2; exit 1;; esac
artifact="inferspool-$os-$arch"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
curl -fsSL "$base/$artifact" -o "$tmp/$artifact"
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"
(cd "$tmp" && grep "  $artifact\$" SHA256SUMS > CHECKSUM)
if command -v sha256sum >/dev/null 2>&1; then (cd "$tmp" && sha256sum -c CHECKSUM); else (cd "$tmp" && shasum -a 256 -c CHECKSUM); fi
if command -v cosign >/dev/null 2>&1; then
  curl -fsSL "$base/SHA256SUMS.bundle" -o "$tmp/SHA256SUMS.bundle"
  cosign verify-blob "$tmp/SHA256SUMS" --bundle "$tmp/SHA256SUMS.bundle" \
    --certificate-identity-regexp "https://github.com/$repo/.github/workflows/release.yml@refs/tags/" \
    --certificate-oidc-issuer "https://token.actions.githubusercontent.com" >/dev/null
fi
chmod 755 "$tmp/$artifact"
if [ -w "$install_dir" ]; then install "$tmp/$artifact" "$install_dir/inferspool"; else sudo install "$tmp/$artifact" "$install_dir/inferspool"; fi
echo "installed $install_dir/inferspool"
