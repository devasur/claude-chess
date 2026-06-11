#!/usr/bin/env node
/*
 * chess-api.cjs — tiny convenience wrapper around the chessai server REST API.
 * Usable by agents/skill without remembering curl syntax.
 *
 *   node chess-api.cjs state            [port]
 *   node chess-api.cjs turn             [port]
 *   node chess-api.cjs health           [port]
 *   node chess-api.cjs reset            [port]
 *   node chess-api.cjs status <reason>  [port]
 *   node chess-api.cjs move <from> <to> [port]   (optional: --san=.. --by=ai --promo=q)
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
    case 'state':  return request('GET', '/api/state')
    case 'turn':   return request('GET', '/api/turn')
    case 'health': return request('GET', '/api/health')
    case 'reset':  return request('POST', '/api/reset')
    case 'status': return request('POST', '/api/status', { status: rest[0] || 'over' })
    case 'move': {
      const [from, to] = rest
      if (!from || !to) throw new Error('usage: move <from> <to> [port] [--san=..] [--by=ai] [--promo=q]')
      const body = { from, to, by: opts.by || 'human' }
      if (opts.san) body.san = opts.san
      if (opts.promo) body.promotion = opts.promo
      return request('POST', '/api/move', body)
    }
    default:
      throw new Error('commands: state | turn | health | reset | status <reason> | move <from> <to>')
  }
}

main()
  .then((out) => { process.stdout.write(out + '\n') })
  .catch((e) => { console.error('chess-api error:', e.message); process.exit(1) })
