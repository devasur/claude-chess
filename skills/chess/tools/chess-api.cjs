#!/usr/bin/env node
/*
 * chess-api.cjs — tiny convenience wrapper around the chessai server REST API.
 * Usable by agents/skill without remembering curl syntax. The server hosts many
 * games at once, each keyed by a three-word id (e.g. "amber-brave-falcon").
 *
 *   node chess-api.cjs health                      [port]
 *   node chess-api.cjs games                        [port]   list all games
 *   node chess-api.cjs new                          [port]   create a game, prints its id
 *   node chess-api.cjs pending                      [port]   next position needing black (--side=w; --all for every board)
 *   node chess-api.cjs wait                         [port]   BLOCK until a board needs black; prints the batch JSON or EMPTY
 *                                                            (--deadline=480 secs, --poll=60 per-request secs, --side=b)
 *   node chess-api.cjs state    <id>                [port]
 *   node chess-api.cjs turn     <id>                [port]
 *   node chess-api.cjs reset    <id>                [port]
 *   node chess-api.cjs delete   <id>                [port]
 *   node chess-api.cjs theme    <id> <name>         [port]   (midnight|marble|emerald)
 *   node chess-api.cjs opponent <id>                [port]   (--model=.. --harness=.. --name=..)
 *   node chess-api.cjs status   <id> <reason>       [port]
 *   node chess-api.cjs move     <id> <san>           [port]   (--by=ai --ply=N --model=.. --harness=.. --comment=.. --reasoning=..; promotion is in the SAN, e.g. e8=Q)
 *                                                            legacy: move <id> <from> <to> [--promo=q]
 *
 * Prints the server's JSON response to stdout.
 */
const http = require('http')

const argv = process.argv.slice(2)
const cmd = argv[0]
const rest = argv.slice(1).filter((a) => !a.startsWith('--'))
const opts = Object.fromEntries(
  argv.filter((a) => a.startsWith('--')).map((a) => {
    const body = a.replace(/^--/, '')
    const i = body.indexOf('=')                  // split on the FIRST '=' so values may contain '='
    return i < 0 ? [body, true] : [body.slice(0, i), body.slice(i + 1)]
  })
)

// Port is the last bare numeric argument, else 4577.
let port = 4577
for (let i = rest.length - 1; i >= 0; i--) {
  if (/^\d+$/.test(rest[i])) { port = parseInt(rest[i], 10); rest.splice(i, 1); break }
}

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const req = http.request(
      { host: '127.0.0.1', port, path, method,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
      (res) => {
        let out = ''
        res.on('data', (c) => (out += c))
        res.on('end', () => resolve(out))
      }
    )
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// One GET that may long-poll; resolves to the raw body, or '' on timeout/error.
// Never rejects — waitForBlack() loops until its own deadline.
function longPoll(path, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let out = ''
      res.on('data', (c) => (out += c))
      res.on('end', () => resolve(out))
    })
    req.on('error', () => resolve(''))
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve('') })
    req.end()
  })
}

// Block until a board needs black (return the batch JSON) or the deadline passes
// (return 'EMPTY'). Owns the whole wait so the agent runs ONE deterministic
// command — no fragile shell loop. A partial/garbled body fails JSON.parse and is
// treated as "keep waiting", never mistaken for a board list. Paces on early
// returns so a server without long-poll (or a refused connection) can't hot-spin.
async function waitForBlack() {
  const deadlineMs = (opts.deadline ? parseInt(opts.deadline, 10) : 480) * 1000
  const perReqMs = (opts.poll ? parseInt(opts.poll, 10) : 60) * 1000
  const side = opts.side ? `&side=${opts.side}` : ''
  const PACE_MS = 2000
  const start = Date.now()
  while (Date.now() - start < deadlineMs) {
    const t0 = Date.now()
    const body = await longPoll(`/api/pending?all=1&wait=1${side}`, perReqMs)
    let arr = null
    try { const j = JSON.parse(body); if (Array.isArray(j)) arr = j } catch {}
    if (arr && arr.length) return JSON.stringify(arr)
    if (Date.now() - t0 < PACE_MS) await sleep(PACE_MS)   // returned early ⇒ pace, don't hot-spin
  }
  return 'EMPTY'
}

async function main() {
  switch (cmd) {
    case 'health':  return request('GET', '/api/health')
    case 'games':   return request('GET', '/api/games')
    case 'new':     return request('POST', '/api/games')
    case 'pending': {
      const q = []
      if (opts.side) q.push(`side=${opts.side}`)
      if (opts.all) q.push('all=1')
      return request('GET', '/api/pending' + (q.length ? `?${q.join('&')}` : ''))
    }
    case 'wait':    return waitForBlack()
    case 'state':   return request('GET', `/api/games/${gid('state')}`)
    case 'turn':    return request('GET', `/api/games/${gid('turn')}/turn`)
    case 'reset':   return request('POST', `/api/games/${gid('reset')}/reset`)
    case 'delete':  return request('DELETE', `/api/games/${gid('delete')}`)
    case 'theme':   return request('POST', `/api/games/${gid('theme <id> <name>')}/theme`, { theme: rest[1] })
    case 'opponent':return request('POST', `/api/games/${gid('opponent')}/opponent`,
      { model: opts.model, harness: opts.harness, name: opts.name })
    case 'status':  return request('POST', `/api/games/${gid('status <id> <reason>')}/status`, { status: rest[1] || 'over' })
    case 'move': {
      // Two forms: `move <id> <san>` (preferred — promotion encoded as e8=Q) or the
      // legacy `move <id> <from> <to>` used by other callers. One bare arg after the
      // id ⇒ SAN; two ⇒ from/to.
      const [id, a, b] = rest
      if (!id || !a) throw new Error('usage: move <id> <san> [port] [--by=ai] [--ply=N] [--model=..] [--harness=..] [--comment=..] [--reasoning=..]  (or legacy: move <id> <from> <to> [--promo=q])')
      const body = { by: opts.by || 'human' }
      if (b) { body.from = a; body.to = b; if (opts.promo) body.promotion = opts.promo; if (opts.san) body.san = opts.san }
      else { body.san = a }
      if (opts.ply !== undefined) body.expected_ply = parseInt(opts.ply, 10)
      if (opts.model) body.model = opts.model
      if (opts.harness) body.harness = opts.harness
      if (opts.comment) body.comment = opts.comment
      if (opts.reasoning) body.reasoning = opts.reasoning
      return request('POST', `/api/games/${id}/move`, body)
    }
    default:
      throw new Error('commands: health | games | new | pending | wait | state <id> | turn <id> | reset <id> | delete <id> | theme <id> <name> | opponent <id> | status <id> <reason> | move <id> <san>')
  }
}

// require + return the game id (first bare arg) for game-scoped commands.
function gid(usage) {
  if (!rest[0]) throw new Error(`usage: ${usage.includes('<id>') ? usage : cmd + ' <id>'} [port]`)
  return rest[0]
}

main()
  .then((out) => { process.stdout.write(out + '\n') })
  .catch((e) => { console.error('chess-api error:', e.message); process.exit(1) })
