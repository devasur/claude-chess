#!/bin/sh
# chessai installer — curl -fsSL <url>/install.sh | sh
#
# Installs the `chessai` binary into ~/.chessai/bin (added to PATH via your
# shell rc), then runs `chessai install` to lay down the Claude skill + workflow.
#
# Order of preference for obtaining the binary:
#   1. Download a prebuilt release for your OS/arch (if available).
#   2. cargo install from the git repo.
#   3. git clone + cargo build from source.

set -eu

REPO_USER="devasur"
REPO_NAME="claude-chess"
REPO="https://github.com/${REPO_USER}/${REPO_NAME}"
RAW="https://raw.githubusercontent.com/${REPO_USER}/${REPO_NAME}/main"
INSTALL_DIR="${CHESSAI_HOME:-$HOME/.chessai}/bin"
BIN="$INSTALL_DIR/chessai"

say() { printf '\033[1;32mchessai\033[0m %s\n' "$*"; }
err() { printf '\033[1;31mchessai\033[0m %s\n' "$*" >&2; }

detect_target() {
  os="$(uname -s)"; arch="$(uname -m)"
  case "$os" in
    Linux)  os_t="unknown-linux-gnu" ;;
    Darwin) os_t="apple-darwin" ;;
    *)      os_t="" ;;
  esac
  case "$arch" in
    x86_64|amd64) arch_t="x86_64" ;;
    arm64|aarch64) arch_t="aarch64" ;;
    *) arch_t="" ;;
  esac
  [ -n "$os_t" ] && [ -n "$arch_t" ] && echo "${arch_t}-${os_t}" || echo ""
}

download_prebuilt() {
  target="$(detect_target)"
  [ -z "$target" ] && return 1
  url="${REPO}/releases/latest/download/chessai-${target}"
  say "trying prebuilt: $url"
  mkdir -p "$INSTALL_DIR"
  if curl -fsSL "$url" -o "$BIN" 2>/dev/null; then
    chmod +x "$BIN"; return 0
  fi
  rm -f "$BIN"; return 1
}

install_with_cargo() {
  command -v cargo >/dev/null 2>&1 || return 1
  say "installing via cargo from $REPO"
  cargo install --git "$REPO" chessai --root "${CHESSAI_HOME:-$HOME/.chessai}" --force
}

build_from_source() {
  command -v cargo >/dev/null 2>&1 || return 1
  command -v git >/dev/null 2>&1 || return 1
  tmp="$(mktemp -d)"
  say "cloning + building from source in $tmp"
  git clone --depth 1 "$REPO" "$tmp/src"
  ( cd "$tmp/src" && cargo build --release )
  mkdir -p "$INSTALL_DIR"
  cp "$tmp/src/target/release/chessai" "$BIN"
  chmod +x "$BIN"
  rm -rf "$tmp"
}

add_to_path() {
  case ":$PATH:" in
    *":$INSTALL_DIR:"*) return 0 ;;
  esac
  for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
    [ -f "$rc" ] || continue
    if ! grep -q 'chessai/bin' "$rc" 2>/dev/null; then
      printf '\n# chessai\nexport PATH="%s:$PATH"\n' "$INSTALL_DIR" >>"$rc"
      say "added $INSTALL_DIR to PATH in $rc"
    fi
  done
}

main() {
  say "installing into $INSTALL_DIR"
  if download_prebuilt; then
    say "installed prebuilt binary"
  elif install_with_cargo; then
    say "installed via cargo"
  elif build_from_source; then
    say "built from source"
  else
    err "could not install: need either a prebuilt release, or cargo (+git)."
    err "install Rust from https://rustup.rs and re-run."
    exit 1
  fi

  add_to_path
  export PATH="$INSTALL_DIR:$PATH"

  say "installing Claude chess skill"
  "$BIN" install

  command -v node >/dev/null 2>&1 || \
    err "note: Node.js was not found — the chess skill's server/tools need it (https://nodejs.org)."

  say "done!"
  say "open a new shell (or 'export PATH=\"$INSTALL_DIR:\$PATH\"'), then run: chessai --help"
  say "inside Claude Code, start a game with: /chess"
}

main "$@"
