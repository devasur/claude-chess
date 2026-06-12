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
 *   node chess-api.cjs state    <id>                [port]
 *   node chess-api.cjs turn     <id>                [port]
 *   node chess-api.cjs reset    <id>                [port]
 *   node chess-api.cjs delete   <id>                [port]
 *   node chess-api.cjs theme    <id> <name>         [port]   (midnight|ivory|emerald)
 *   node chess-api.cjs opponent <id>                [port]   (--model=.. --harness=.. --name=..)
 *   node chess-api.cjs status   <id> <reason>       [port]
 *   node chess-api.cjs move     <id> <from> <to>    [port]   (--san=.. --by=ai --promo=q --ply=N --model=.. --harness=..)
 *
 * Prints the server's JSON response to stdout.
 */
const http = require('http')

const argv = process.argv.slice(2)
const cmd = argv[0]
const rest = argv.slice(1).filter((a) => !a.startsWith('--'))
const opts = Object.fromEntries(
  argv.filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v === undefined ? true : v]
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
    case 'state':   return request('GET', `/api/games/${gid('state')}`)
    case 'turn':    return request('GET', `/api/games/${gid('turn')}/turn`)
    case 'reset':   return request('POST', `/api/games/${gid('reset')}/reset`)
    case 'delete':  return request('DELETE', `/api/games/${gid('delete')}`)
    case 'theme':   return request('POST', `/api/games/${gid('theme <id> <name>')}/theme`, { theme: rest[1] })
    case 'opponent':return request('POST', `/api/games/${gid('opponent')}/opponent`,
      { model: opts.model, harness: opts.harness, name: opts.name })
    case 'status':  return request('POST', `/api/games/${gid('status <id> <reason>')}/status`, { status: rest[1] || 'over' })
    case 'move': {
      const [id, from, to] = rest
      if (!id || !from || !to) throw new Error('usage: move <id> <from> <to> [port] [--san=..] [--by=ai] [--promo=q] [--ply=N] [--model=..] [--harness=..]')
      const body = { from, to, by: opts.by || 'human' }
      if (opts.san) body.san = opts.san
      if (opts.promo) body.promotion = opts.promo
      if (opts.ply !== undefined) body.expected_ply = parseInt(opts.ply, 10)
      if (opts.model) body.model = opts.model
      if (opts.harness) body.harness = opts.harness
      return request('POST', `/api/games/${id}/move`, body)
    }
    default:
      throw new Error('commands: health | games | new | pending | state <id> | turn <id> | reset <id> | delete <id> | theme <id> <name> | opponent <id> | status <id> <reason> | move <id> <from> <to>')
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
