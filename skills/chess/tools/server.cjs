#!/usr/bin/env node
/*
 * chessai server — the deterministic half of the game, in pure Node (no deps).
 *
 * Holds authoritative game state, applies moves (FEN, castling, en-passant,
 * promotion), serves the clickable web board, and exposes a small REST API used
 * by both the browser and the AI-opponent agent.
 *
 *   node server.cjs [--port 4577] [--open]
 *
 * It deliberately does NOT enforce full legality — move *selection* is delegated
 * to the AI opponent. There is no model intelligence here; this process is dumb plumbing.
 */
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')

const argv = process.argv.slice(2)
const getOpt = (name, def) => {
  const i = argv.indexOf(name)
  if (i >= 0 && argv[i + 1]) return argv[i + 1]
  const eq = argv.find((a) => a.startsWith(name + '='))
  return eq ? eq.split('=')[1] : def
}
const PORT = parseInt(getOpt('--port', process.env.CHESSAI_PORT || '4577'), 10)
const OPEN = argv.includes('--open')
// --open-url <url>: just pop the app window for an already-running server, then
// exit (no second server). Lets a session reuse a shared server but still get its
// own board window.
const OPEN_URL = getOpt('--open-url', null)

// ---------------------------------------------------------------------------
// Board model (port of board.rs). row 0 == rank 8, col 0 == file a.
// ---------------------------------------------------------------------------
function newBoard() {
  const back = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r']
  const sq = Array.from({ length: 8 }, () => Array(8).fill(null))
  for (let c = 0; c < 8; c++) {
    sq[0][c] = back[c]
    sq[1][c] = 'p'
    sq[6][c] = 'P'
    sq[7][c] = back[c].toUpperCase()
  }
  return { sq, side: 'w', castling: 'KQkq', ep: null, half: 0, full: 1 }
}

function parseSq(s) {
  if (!s || s.length < 2) return null
  const file = s.charCodeAt(0) | 0x20 // lowercase
  const rank = s.charCodeAt(1)
  if (file < 97 || file > 104 || rank < 49 || rank > 56) return null
  return { r: 56 - rank, c: file - 97 } // rank8 -> row0
}

function toFen(b) {
  let placement = ''
  for (let r = 0; r < 8; r++) {
    let empty = 0
    for (let c = 0; c < 8; c++) {
      const p = b.sq[r][c]
      if (p) {
        if (empty) { placement += empty; empty = 0 }
        placement += p
      } else empty++
    }
    if (empty) placement += empty
    if (r !== 7) placement += '/'
  }
  const castling = b.castling || '-'
  const ep = b.ep || '-'
  return `${placement} ${b.side} ${castling} ${ep} ${b.half} ${b.full}`
}

function revokeCastling(b, piece, fr, fc) {
  const drop = (ch) => { b.castling = b.castling.replace(ch, '') }
  if (piece === 'K') { drop('K'); drop('Q') }
  else if (piece === 'k') { drop('k'); drop('q') }
  else if (piece === 'R' && fr === 7 && fc === 0) drop('Q')
  else if (piece === 'R' && fr === 7 && fc === 7) drop('K')
  else if (piece === 'r' && fr === 0 && fc === 0) drop('q')
  else if (piece === 'r' && fr === 0 && fc === 7) drop('k')
}

function applyMove(b, from, to, promotion) {
  const f = parseSq(from)
  const t = parseSq(to)
  if (!f) throw new Error(`bad from square: ${from}`)
  if (!t) throw new Error(`bad to square: ${to}`)
  const piece = b.sq[f.r][f.c]
  if (!piece) throw new Error(`no piece on ${from}`)
  const isWhite = piece === piece.toUpperCase()
  const isPawn = piece.toLowerCase() === 'p'
  const isKing = piece.toLowerCase() === 'k'
  const target = b.sq[t.r][t.c]
  let resetHalf = isPawn || !!target

  // en-passant capture
  if (isPawn && f.c !== t.c && !target) {
    b.sq[f.r][t.c] = null
    resetHalf = true
  }

  b.sq[f.r][f.c] = null
  let placed = piece
  if (isPawn && (t.r === 0 || t.r === 7)) {
    const promo = (promotion || 'q').toLowerCase()
    placed = isWhite ? promo.toUpperCase() : promo
  }
  b.sq[t.r][t.c] = placed

  // castling: king moves two files -> shift rook
  if (isKing && Math.abs(f.c - t.c) === 2) {
    if (t.c === 6) { b.sq[f.r][5] = b.sq[f.r][7]; b.sq[f.r][7] = null }
    else if (t.c === 2) { b.sq[f.r][3] = b.sq[f.r][0]; b.sq[f.r][0] = null }
  }

  revokeCastling(b, piece, f.r, f.c)

  b.ep = null
  if (isPawn && Math.abs(f.r - t.r) === 2) {
    const mid = (f.r + t.r) / 2
    const file = String.fromCharCode(97 + f.c)
    const rank = String.fromCharCode(56 - mid)
    b.ep = `${file}${rank}`
  }

  b.half = resetHalf ? 0 : b.half + 1
  if (b.side === 'b') b.full += 1
  b.side = b.side === 'w' ? 'b' : 'w'
}

// ---------------------------------------------------------------------------
// Persistence — one JSON file per game under the data dir, loaded on boot and
// rewritten on every mutation. Dependency-free; the files are small and local.
// Override the location with CHESSAI_DATA_DIR.
// ---------------------------------------------------------------------------
const DATA_DIR = process.env.CHESSAI_DATA_DIR || path.join(os.homedir(), '.chessai', 'games')
try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch {}

// Human-friendly, unique game ids: three random words, e.g. "amber-brave-falcon".
// The id IS the name and the filename, so the alphabet is deliberately a-z only.
const ADJ = ['amber', 'brave', 'calm', 'dapper', 'eager', 'fabled', 'gilded', 'hidden', 'ivory', 'jolly', 'keen', 'lucid', 'mellow', 'noble', 'opal', 'proud', 'quiet', 'ruby', 'silver', 'tidal', 'umber', 'velvet', 'wily', 'zephyr']
const TONE = ['ash', 'birch', 'cobalt', 'dusk', 'ember', 'frost', 'glow', 'haze', 'indigo', 'jade', 'kelp', 'lunar', 'moss', 'night', 'ochre', 'pearl', 'quartz', 'rust', 'slate', 'teal']
const NOUN = ['falcon', 'gambit', 'harbor', 'isle', 'jaguar', 'kestrel', 'lattice', 'meadow', 'nimbus', 'otter', 'pawn', 'quill', 'raven', 'sparrow', 'thicket', 'umbra', 'vesper', 'willow', 'yarrow', 'zenith', 'anvil', 'beacon', 'cipher', 'delta', 'echo', 'fjord', 'grove', 'hollow']
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
function newName(taken) {
  for (let i = 0; i < 500; i++) {
    const name = `${pick(ADJ)}-${pick(TONE)}-${pick(NOUN)}`
    if (!taken.has(name)) return name
  }
  let n = 2, base = `${pick(ADJ)}-${pick(NOUN)}`            // pathological fallback
  while (taken.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}
const VALID_ID = /^[a-z]+(?:-[a-z0-9]+)+$/                   // also guards against path traversal

// Board skins the client can render; the choice is stored per game so a recalled
// board opens in the theme it was last played in.
const THEMES = new Set(['midnight', 'marble', 'emerald'])
const DEFAULT_THEME = 'midnight'

// ---------------------------------------------------------------------------
// Game state — a map of id -> game, persisted to disk.
// ---------------------------------------------------------------------------
const games = new Map()
const gamePath = (id) => path.join(DATA_DIR, `${id}.json`)

// ---- long-poll: agents block on GET /api/pending?wait=1 until black has work ----
// A "parked" waiter is just a held-open response (no thread; the event loop keeps
// serving everyone else). When a move creates black work we wake every parked
// waiter together, COALESCE_MS later, so moves made across boards in quick
// succession land in one batch. lastBlackPollAt + the parked count also tell us
// whether a chessai agent is currently serving black — so a second session that
// reuses this server can skip spawning its own agent.
const blackWaiters = []                 // { res, all, timeout }
let coalesceTimer = null
let lastBlackPollAt = 0
const COALESCE_MS = 10000               // tumbling window to batch near-simultaneous moves
const WAIT_MS = 8 * 60 * 1000           // park ceiling; the agent's curl uses a slightly larger --max-time
const ACTIVE_WINDOW_MS = 30000          // a black poll this recent ⇒ an agent is mid-batch, still alive

function chessaiAgentActive() {
  return blackWaiters.length > 0 || Date.now() - lastBlackPollAt < ACTIVE_WINDOW_MS
}
// Called from touch() on every state change. Schedules a single coalesced wake
// when black has work and someone is waiting; a no-op otherwise.
function maybeWakeBlack() {
  if (blackWaiters.length === 0 || coalesceTimer) return
  if (pendingAllFor('b').length === 0) return
  coalesceTimer = setTimeout(() => { flushBlackWaiters().catch((e) => console.error(`flush failed: ${e.message}`)) }, COALESCE_MS)
}
async function flushBlackWaiters() {
  coalesceTimer = null
  const ready = pendingAllFor('b')
  if (ready.length === 0) return        // nothing to send yet; keep them parked
  const arr = await pendingPayload(ready)
  while (blackWaiters.length) {
    const w = blackWaiters.shift()
    clearTimeout(w.timeout)
    try {
      w.res.writeHead(200, { 'Content-Type': 'application/json' })
      w.res.end(JSON.stringify(w.all ? arr : arr[0]))
    } catch {}
  }
}
function parkBlackWaiter(req, res, all) {
  const w = { res, all, timeout: null }
  w.timeout = setTimeout(() => {
    const i = blackWaiters.indexOf(w)
    if (i >= 0) blackWaiters.splice(i, 1)
    try { sendJson(res, 200, all ? [] : { id: null }) } catch {}   // timed out: empty, mirrors the no-wait shape
  }, WAIT_MS)
  req.on('close', () => {                                          // client gave up / died: drop it
    const i = blackWaiters.indexOf(w)
    if (i >= 0) { blackWaiters.splice(i, 1); clearTimeout(w.timeout) }
  })
  blackWaiters.push(w)
}

function persist(game) {
  try { fs.writeFileSync(gamePath(game.id), JSON.stringify(game)) }
  catch (e) { console.error(`persist ${game.id} failed: ${e.message}`) }
}
function touch(game) { game.updated = Date.now(); persist(game); maybeWakeBlack(); return game }

function loadAll() {
  let files = []
  try { files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json')) } catch { return }
  for (const f of files) {
    try {
      const g = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'))
      if (g && g.id && g.board) {
        if (g.theme === 'ivory') g.theme = 'marble'              // retired skin → its replacement
        if (!THEMES.has(g.theme)) g.theme = DEFAULT_THEME        // migrate pre-theme saves
        if (g.opponent === undefined) g.opponent = null
        games.set(g.id, g)
      }
    } catch (e) { console.error(`skip ${f}: ${e.message}`) }
  }
}
loadAll()

function createGame() {
  const id = newName(new Set(games.keys()))
  const now = Date.now()
  const game = { id, name: id, board: newBoard(), history: [], status: 'playing', theme: DEFAULT_THEME, opponent: null, created: now, updated: now }
  games.set(id, game)
  persist(game)
  return game
}
function resetGame(game) {
  game.board = newBoard(); game.history = []; game.status = 'playing'
  return touch(game)
}

// Combine a new identity payload over the existing one, keeping known fields.
function mergeOpponent(prev, body) {
  const p = prev || {}
  return {
    name: body.opponent || body.name || p.name || null,
    harness: body.harness || p.harness || null,
    model: body.model || p.model || null,
  }
}

// Every live game where it is `side`'s turn, oldest activity first. This is what
// lets ONE stateless agent serve every parallel game: it asks "what needs me?"
// and never tracks games itself. The batching agent fetches the whole list at
// once; the single-board form just returns the head.
function pendingAllFor(side) {
  return [...games.values()]
    .filter((g) => g.status === 'playing' && g.board.side === side)
    .sort((a, b) => a.updated - b.updated)
}

// ---- response shapes ----
function fullState(game) {
  return {
    id: game.id, name: game.name,
    fen: toFen(game.board), turn: game.board.side, status: game.status,
    theme: game.theme, opponent: game.opponent || null,
    move_count: game.history.length,
    last_move: game.history[game.history.length - 1] || null,
    history: game.history,
    created: game.created, updated: game.updated,
  }
}
function turnState(game) {
  const last = game.history[game.history.length - 1] || {}
  return {
    id: game.id, name: game.name,
    fen: toFen(game.board), turn: game.board.side, status: game.status,
    move_count: game.history.length,
    last_san: last.san || '', last_from: last.from || '', last_to: last.to || '',
  }
}
function indexEntry(game) {
  const last = game.history[game.history.length - 1] || {}
  return {
    id: game.id, name: game.name,
    fen: toFen(game.board), turn: game.board.side, status: game.status,
    theme: game.theme, opponent: game.opponent || null,
    move_count: game.history.length,
    last_san: last.san || '', last_comment: last.comment || null, last_by: last.by || null,
    created: game.created, updated: game.updated,
  }
}

// ---------------------------------------------------------------------------
// Legality — the server is the authority. We reuse the SAME perft-validated
// rules engine the browser uses (web/engine.js, pure ESM) via dynamic import,
// so an LLM opponent cannot submit an illegal move (e.g. its king into check).
// ---------------------------------------------------------------------------
let _engine = null
async function engine() {
  if (!_engine) {
    const { pathToFileURL } = require('url')
    _engine = await import(pathToFileURL(path.join(__dirname, 'web', 'engine.js')).href)
  }
  return _engine
}
const sqOf = ([r, c]) => 'abcdefgh'[c] + (8 - r)

// Legal moves for a board, as the engine sees it.
async function legalFor(board) {
  const E = await engine()
  const pos = E.parseFEN(toFen(board))
  return { E, pos, legal: E.legalMoves(pos) }
}
// Compact legal moves for the agent: a single space-joined SAN string (promotion
// is encoded in the SAN itself, e.g. "e8=Q", so there is no separate field). This
// is the smallest faithful encoding — the agent submits the SAN it picks. ~5 B per
// move vs ~35 B for the old {from,to,san} objects.
function legalSans(E, pos, legal) {
  return legal.map((mv) => E.toSAN(pos, mv, legal)).join(' ')
}
// Resolve a submitted SAN back to its legal move. Exact match first, then a
// check/checkmate-suffix-agnostic match (so "Qh5" matches "Qh5+").
function matchSan(E, pos, legal, san) {
  const norm = (s) => String(s).replace(/[+#]+$/, '')
  const want = norm(san)
  return legal.find((mv) => norm(E.toSAN(pos, mv, legal)) === want) || null
}

const PVAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }

// A plain-text board so the model doesn't have to reconstruct the position from
// FEN in its head (the #1 cause of its blunders). Ranks 8→1, white uppercase.
function asciiBoard(b) {
  const rows = []
  for (let r = 0; r < 8; r++) {
    let line = (8 - r) + ' '
    for (let c = 0; c < 8; c++) line += (b[r][c] || '.') + ' '
    rows.push(line.trimEnd())
  }
  rows.push('  a b c d e f g h')
  return rows.join('\n')
}

// Capture-safety hints: for every legal capture, is the target defended, and what
// is the 1-ply material result if the opponent recaptures? Uses legalMoves on the
// resulting position, so pinned "defenders" are correctly ignored. This is a
// single-exchange heuristic (not full SEE), but it catches hanging-piece blunders
// like "queen takes a defended knight". Format: "Qxb5:LOSES(-6) Nxe5:safe(+1)".
function captureHints(E, pos, legal) {
  const out = []
  for (const m of legal) {
    if (!m.cap) continue
    const [tr, tc] = m.to
    const gain = m.ep ? 1 : (PVAL[String(pos.b[tr][tc]).toLowerCase()] || 0)
    const mover = PVAL[String(m.piece).toLowerCase()] || 0
    const n = E.makeMove(pos, m)
    const defended = E.legalMoves(n).some((x) => x.to[0] === tr && x.to[1] === tc)
    const san = E.toSAN(pos, m, legal)
    let tag
    if (!defended) tag = `safe(+${gain})`
    else { const net = gain - mover; tag = net > 0 ? `ok(+${net})` : net === 0 ? 'even' : `LOSES(${net})` }
    out.push(`${san}:${tag}`)
  }
  return out.join(' ')
}
// Is from/to(/promo) a legal move? Promotion requires the named piece (default q).
function isLegalMove(legal, from, to, promo) {
  const cands = legal.filter((mv) => sqOf(mv.from) === from && sqOf(mv.to) === to)
  if (!cands.length) return false
  if (cands[0].promo) return cands.some((mv) => mv.promo === (promo || 'q'))
  return true
}
// Per-board payload for the agent: what it needs to reason and submit — id, fen, a
// rendered board (so it doesn't misread FEN), the ply to stamp, what white just
// played, the check flag, the legal replies (compact SAN), and capture-safety hints
// that flag hanging-piece blunders. Omits turnState's name/turn/status/last_from/
// last_to (redundant). The browser uses fullState, not this, so this stays lean.
async function pendingPayload(list) {
  const out = []
  for (const g of list) {
    const { E, pos, legal } = await legalFor(g.board)
    const last = g.history[g.history.length - 1] || {}
    out.push({
      id: g.id,
      fen: toFen(g.board),
      board: asciiBoard(pos.b),
      move_count: g.history.length,
      last_san: last.san || '',
      in_check: E.inCheck(pos),
      legal: legalSans(E, pos, legal),
      captures: captureHints(E, pos, legal),
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const BOARD_HTML = (() => {
  try { return fs.readFileSync(path.join(__dirname, 'board.html'), 'utf8') }
  catch { return '<h1>board.html missing</h1>' }
})()

// Static assets for the web board (CSS + ES modules) live in ./web. Served
// fresh from disk per request (no caching) so edits show up on reload.
const WEB_DIR = path.join(__dirname, 'web')
const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}
function serveWeb(res, urlPath) {
  const rel = decodeURIComponent(urlPath.replace(/^\/web\//, ''))
  const full = path.join(WEB_DIR, rel)
  if (full !== WEB_DIR && !full.startsWith(WEB_DIR + path.sep)) { // path-traversal guard
    return sendJson(res, 403, { error: 'forbidden' })
  }
  fs.readFile(full, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not found' })
    const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' })
    res.end(data)
  })
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(body)
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = ''
    req.on('data', (c) => (d += c))
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}) } catch { resolve(null) } })
  })
}

const server = http.createServer(async (req, res) => {
  const [rawPath, query] = (req.url || '/').split('?')
  const url = rawPath
  const m = req.method
  const parts = url.split('/').filter(Boolean)            // e.g. ['api','games','amber-..','move']

  // ---- shell + static assets ----
  if (m === 'GET' && (url === '/' || url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(BOARD_HTML)
  }
  if (m === 'GET' && url.startsWith('/web/')) return serveWeb(res, url)
  if (m === 'GET' && url === '/api/health') return sendJson(res, 200, { ok: true, service: 'chessai', version: '0.4.0', games: games.size, chessai_agent_active: chessaiAgentActive() })

  // ---- agent: position(s) that need a move (default black) ----
  // ?all=1 returns EVERY pending board as an array (the batching agent fetches
  // the whole set in one shot); otherwise just the next one.
  if (m === 'GET' && url === '/api/pending') {
    const side = /(^|&)side=w(&|$)/.test(query || '') ? 'w' : 'b'
    const all = /(^|&)all=1(&|$)/.test(query || '')
    const wait = /(^|&)wait=1(&|$)/.test(query || '')
    if (side === 'b') lastBlackPollAt = Date.now()
    const ready = pendingAllFor(side)
    // wait=1 (black only): if nothing's pending, hold the connection open instead
    // of returning [] — woken in a coalesced batch when a move creates work.
    if (ready.length === 0 && wait && side === 'b') return parkBlackWaiter(req, res, all)
    const payload = await pendingPayload(ready)
    if (all) return sendJson(res, 200, payload)
    return sendJson(res, 200, payload[0] || { id: null })
  }

  // ---- games collection ----
  if (m === 'GET' && url === '/api/games') {
    const list = [...games.values()].sort((a, b) => b.updated - a.updated).map(indexEntry)
    return sendJson(res, 200, list)
  }
  if (m === 'POST' && url === '/api/games') return sendJson(res, 200, fullState(createGame()))

  // ---- a single game: /api/games/:id[/action] ----
  if (parts[0] === 'api' && parts[1] === 'games' && parts[2]) {
    const id = parts[2], action = parts[3] || ''
    if (!VALID_ID.test(id)) return sendJson(res, 400, { error: 'bad game id' })
    const game = games.get(id)
    if (!game) return sendJson(res, 404, { error: 'no such game' })

    if (m === 'GET' && !action) return sendJson(res, 200, fullState(game))
    if (m === 'GET' && action === 'turn') return sendJson(res, 200, turnState(game))
    if (m === 'POST' && action === 'reset') return sendJson(res, 200, fullState(resetGame(game)))

    if (m === 'DELETE' && !action) {
      games.delete(id)
      try { fs.unlinkSync(gamePath(id)) } catch {}
      return sendJson(res, 200, { ok: true, id })
    }

    if (m === 'POST' && action === 'status') {
      const body = await readBody(req)
      if (body && typeof body.status === 'string') { game.status = body.status; touch(game) }
      return sendJson(res, 200, fullState(game))
    }

    if (m === 'POST' && action === 'theme') {
      const body = await readBody(req)
      if (!body || !THEMES.has(body.theme)) return sendJson(res, 400, { error: 'unknown theme' })
      game.theme = body.theme; touch(game)
      return sendJson(res, 200, fullState(game))
    }

    // Record who the opponent is (the black agent's harness/model). Lets the
    // board show "who am I playing?" instead of a generic label.
    if (m === 'POST' && action === 'opponent') {
      const body = await readBody(req) || {}
      game.opponent = mergeOpponent(game.opponent, body); touch(game)
      return sendJson(res, 200, fullState(game))
    }

    if (m === 'POST' && action === 'move') {
      const body = await readBody(req)
      if (!body || (!body.san && !(body.from && body.to))) return sendJson(res, 400, { error: 'need san or from + to' })
      // Compare-and-swap guard: reject a move computed against a stale position
      // (the agent passes the move_count it reasoned from). Keeps a multiplexed
      // agent from double-moving without it tracking any per-game state.
      if (body.expected_ply != null && body.expected_ply !== game.history.length) {
        return sendJson(res, 409, { error: 'stale move', move_count: game.history.length })
      }
      // Legality gate: the server is the authority. The agent submits a SAN (picked
      // from the legal list it was given); the browser submits from/to. Either way
      // we resolve to a concrete move and reject anything not in the legal set,
      // returning the legal SANs so the caller can correct.
      let from, to, promotion, san
      {
        const { E, pos, legal } = await legalFor(game.board)
        if (body.san) {
          const mv = matchSan(E, pos, legal, body.san)
          if (!mv) return sendJson(res, 400, { error: 'illegal move', in_check: E.inCheck(pos), legal: legalSans(E, pos, legal) })
          from = sqOf(mv.from); to = sqOf(mv.to); promotion = mv.promo || null; san = E.toSAN(pos, mv, legal)
        } else {
          if (!isLegalMove(legal, body.from, body.to, (body.promotion || '').toLowerCase())) {
            return sendJson(res, 400, { error: 'illegal move', in_check: E.inCheck(pos), legal: legalSans(E, pos, legal) })
          }
          from = body.from; to = body.to; promotion = body.promotion || null
          const mv = legal.find((x) => sqOf(x.from) === from && sqOf(x.to) === to && (!x.promo || x.promo === (promotion || 'q')))
          san = body.san || (mv ? E.toSAN(pos, mv, legal) : null)
        }
      }
      const color = game.board.side
      const number = game.board.full
      try {
        applyMove(game.board, from, to, promotion)
      } catch (e) {
        return sendJson(res, 400, { error: e.message })
      }
      game.history.push({
        number, color,
        from, to,
        san: san || null,
        promotion: promotion || null,
        comment: body.comment || null,
        reasoning: body.reasoning || null,
        by: body.by || 'human',
        fen: toFen(game.board),
      })
      // an AI move may carry the opponent's identity — record it as we see it.
      const isAi = (body.by || 'human') === 'ai'
      if (isAi && (body.model || body.harness || body.opponent)) {
        game.opponent = mergeOpponent(game.opponent, body)
      }
      touch(game)
      // The browser drives its whole UI off fullState (history, theme, opponent), so
      // it gets the full snapshot. The AI agent only needs to know the move landed —
      // echoing the ever-growing history back to it is the single biggest source of
      // its context growth (quadratic over a game). Give it a flat ~80 B ack instead.
      if (isAi) return sendJson(res, 200, { ok: true, id: game.id, move_count: game.history.length, san, status: game.status })
      return sendJson(res, 200, fullState(game))
    }
  }

  sendJson(res, 404, { error: 'not found' })
})

// Try to open a chromeless "app" window (no address bar / tabs) sized like a
// board and floated near the top-left, on top of the terminal. Falls back to
// the default browser (with chrome) if no Chromium-family browser is found.
// Size/position are overridable: CHESSAI_WIN_SIZE="W,H", CHESSAI_WIN_POS="X,Y".
function appArgsFor(url) {
  const size = process.env.CHESSAI_WIN_SIZE || '980,840'
  const pos = process.env.CHESSAI_WIN_POS || '120,80'
  // A dedicated profile dir guarantees a fresh, standalone, correctly-sized app
  // window even when the user already has the browser open (otherwise the flags
  // get handed to the running instance and ignored). It also keeps the chess
  // window out of their normal browsing session.
  const profile = path.join(os.homedir(), '.chessai', 'browser')
  try { fs.mkdirSync(profile, { recursive: true }) } catch {}
  return [
    `--app=${url}`,
    `--window-size=${size}`,
    `--window-position=${pos}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
  ]
}

function launchAppWindow(url) {
  const plat = process.platform
  const args = appArgsFor(url)
  const detach = { detached: true, stdio: 'ignore' }

  if (plat === 'darwin') {
    const apps = [
      ['Google Chrome', '/Applications/Google Chrome.app'],
      ['Chromium', '/Applications/Chromium.app'],
      ['Brave Browser', '/Applications/Brave Browser.app'],
      ['Microsoft Edge', '/Applications/Microsoft Edge.app'],
    ]
    for (const [name, p] of apps) {
      if (fs.existsSync(p)) {
        try { spawn('open', ['-na', name, '--args', ...args], detach).unref(); return true } catch {}
      }
    }
    return false
  }

  if (plat === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files'
    const pfx = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const candidates = ['chrome', 'msedge', 'brave']
    for (const c of candidates) {
      if (spawnSync('where', [c]).status === 0) {
        try { spawn(c, args, detach).unref(); return true } catch {}
      }
    }
    const paths = [
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pfx}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pfx}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ]
    for (const p of paths) {
      if (fs.existsSync(p)) {
        try { spawn(p, args, detach).unref(); return true } catch {}
      }
    }
    return false
  }

  // linux / other unix
  const bins = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser', 'microsoft-edge']
  for (const c of bins) {
    if (spawnSync('which', [c]).status === 0) {
      try { spawn(c, args, detach).unref(); return true } catch {}
    }
  }
  return false
}

function openBrowser(url) {
  if (launchAppWindow(url)) return
  // Fallback: system default browser (will have an address bar).
  const plat = process.platform
  const cmd = plat === 'darwin' ? 'open' : plat === 'win32' ? 'cmd' : 'xdg-open'
  const args = plat === 'win32' ? ['/c', 'start', '', url] : [url]
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref() } catch {}
}

if (OPEN_URL) {
  // Open-only mode: spawn the (detached) browser, give it a beat to launch, exit.
  openBrowser(OPEN_URL)
  setTimeout(() => process.exit(0), 800)
  return
}

server.on('error', (e) => {
  console.error(`chessai server error: ${e.code === 'EADDRINUSE' ? `port ${PORT} in use` : e.message}`)
  process.exit(1)
})
server.listen(PORT, '127.0.0.1', () => {
  const base = `http://127.0.0.1:${PORT}`
  console.log(`chessai server listening on ${base}`)
  console.log(`  web board : ${base}/`)
  console.log(`  pending   : ${base}/api/pending  (next position needing black)`)
  console.log(`  games dir : ${DATA_DIR}  (${games.size} saved)`)
  if (OPEN) openBrowser(base + '/')
})
