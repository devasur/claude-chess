#!/usr/bin/env node
/*
 * npx/npm launcher for the chessai Rust binary.
 *
 * Strategy:
 *   1. If a cached native binary built from THIS package version exists
 *      (~/.chessai/bin/chessai[.exe]), exec it.
 *   2. Otherwise build it from the Rust sources bundled in this npm package
 *      using the local `cargo` toolchain, cache it (stamping the version), then
 *      exec it.
 *
 * The version stamp is essential: without it an old cached binary would be
 * reused after an upgrade, so `npx chessai install` would lay down a stale skill.
 *
 * All CLI args are forwarded to the native binary, so `npx chessai install`,
 * `npx chessai --server`, etc. all work transparently.
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const PKG_VERSION = require('../package.json').version
const PKG_ROOT = path.resolve(__dirname, '..')
const BIN_DIR = path.join(os.homedir(), '.chessai', 'bin')
const EXE = process.platform === 'win32' ? 'chessai.exe' : 'chessai'
const BIN_PATH = path.join(BIN_DIR, EXE)
const STAMP_PATH = path.join(BIN_DIR, '.version')

function have(cmd) {
  const probe = spawnSync(cmd, ['--version'], { stdio: 'ignore' })
  return !probe.error && probe.status === 0
}

function buildFromSource() {
  if (!have('cargo')) {
    console.error(
      '\nchessai: no prebuilt binary and `cargo` was not found on PATH.\n' +
        'Install the Rust toolchain (https://rustup.rs) and re-run, or use the\n' +
        'curl installer:  curl -fsSL https://raw.githubusercontent.com/devasur/chessai/main/install.sh | sh\n'
    )
    process.exit(1)
  }
  console.error('chessai: building native binary from source (first run only)…')
  const build = spawnSync('cargo', ['build', '--release'], {
    cwd: PKG_ROOT,
    stdio: 'inherit',
  })
  if (build.status !== 0) {
    console.error('chessai: cargo build failed.')
    process.exit(build.status || 1)
  }
  const built = path.join(PKG_ROOT, 'target', 'release', EXE)
  fs.mkdirSync(BIN_DIR, { recursive: true })
  fs.copyFileSync(built, BIN_PATH)
  if (process.platform !== 'win32') fs.chmodSync(BIN_PATH, 0o755)
  fs.writeFileSync(STAMP_PATH, PKG_VERSION)
  console.error(`chessai: installed v${PKG_VERSION} -> ${BIN_PATH}`)
}

function cachedVersion() {
  try { return fs.readFileSync(STAMP_PATH, 'utf8').trim() } catch { return null }
}

function ensureBinary() {
  // Rebuild whenever the binary is missing or was built from a different
  // package version — otherwise an upgrade would keep running a stale binary.
  if (fs.existsSync(BIN_PATH) && cachedVersion() === PKG_VERSION) return
  buildFromSource()
}

function main() {
  const args = process.argv.slice(2)

  // postinstall hook: build but don't run a mode.
  if (args.length === 1 && args[0] === '--build-only') {
    try {
      ensureBinary()
    } catch (e) {
      console.error('chessai: postinstall build skipped:', e.message)
    }
    return
  }

  ensureBinary()
  const res = spawnSync(BIN_PATH, args, { stdio: 'inherit' })
  process.exit(res.status === null ? 1 : res.status)
}

main()
