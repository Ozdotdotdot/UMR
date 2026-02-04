#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-ozdotdotdot/UMR}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
BINARY_NAME="${BINARY_NAME:-remoted}"
VERSION="${1:-latest}"

log() {
  printf '[install] %s\n' "$1"
}

fail() {
  printf '[install] error: %s\n' "$1" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

if [[ "$(uname -s)" != "Linux" ]]; then
  fail "only Linux is supported by this installer"
fi

arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) asset_arch="amd64" ;;
  aarch64|arm64) asset_arch="arm64" ;;
  *) fail "unsupported architecture: $arch (expected amd64 or arm64)" ;;
esac

asset="remoted-linux-${asset_arch}.tar.gz"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
archive="$tmpdir/$asset"

if [[ "$VERSION" == "latest" ]]; then
  url="https://github.com/${REPO}/releases/latest/download/${asset}"
else
  url="https://github.com/${REPO}/releases/download/${VERSION}/${asset}"
fi

log "downloading ${url}"
if need_cmd curl; then
  curl -fsSL "$url" -o "$archive"
elif need_cmd wget; then
  wget -qO "$archive" "$url"
else
  fail "curl or wget is required"
fi

log "extracting ${asset}"
tar -xzf "$archive" -C "$tmpdir"

src="$tmpdir/remoted-linux-${asset_arch}"
[[ -f "$src" ]] || fail "expected binary not found in archive"

mkdir -p "$INSTALL_DIR"
install -m 755 "$src" "$INSTALL_DIR/$BINARY_NAME"

log "installed $BINARY_NAME to $INSTALL_DIR/$BINARY_NAME"
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
  log "note: $INSTALL_DIR is not currently on PATH"
fi

log "run '$BINARY_NAME -v' to verify"
