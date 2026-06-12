# chessai

Play chess against Claude Code. You play white on a clickable browser board; a
background Claude agent plays black, replying to each move with a comment and its
reasoning. The server hosts **many parallel games** at once, each with a
three-word name, persisted to disk.

![The chessai board — "midnight study" theme](docs/board.png)

```
 you (white)            node server.cjs                 chess-ai agent
 browser board  ◀─HTTP─▶ multi-game state + FEN  ◀─HTTP─▶ (Claude subagent, Bash-only:
 (legal-move engine)     REST + web UI; no brain          poll /pending?all=1 → pick
                                                          moves → POST; batched,
                                                          backs off, self-stops)
```

## The board

A dark **"Midnight Study"** theme (plus **Ivory** and **Emerald** skins) —
inlaid board, brass accents, grain + vignette, and a full **legal-move engine in
the browser**: you can only make legal moves, with reachable squares highlighted
(dots for quiet moves, rings for captures). Castling, en passant, promotion,
check, checkmate and stalemate are all handled, and the client declares the
result.

![Selecting a piece shows its legal moves and captures](docs/legal-moves.png)

The engine is validated with **perft** against standard positions (startpos,
Kiwipete, en-passant and promotion positions all match known node counts), so
move generation — including pins and through-check castling — is correct.

## Architecture

Three clean layers, one rule: **the only thing that needs an LLM is choosing a
move.** Everything else is deterministic.

- **The plugin** (`.claude-plugin/plugin.json`) — *packaging only*. Bundles the
  skill, its Node tools, and the agent so Claude Code discovers them on install.
  No game logic.
- **`skills/chess/tools/server.cjs` (Node)** — authoritative state for every game (FEN,
  castling, en passant, promotion, persistence), the REST API, and the web UI.
  **No chess intelligence — pure plumbing.**
- **The browser** (`tools/web/*`, `board.html`) — the clickable UI *and* the
  human's legal-move engine; also detects and posts the game result.
- **The `chess-ai` agent** (`agents/chess-ai.md`) — **the brain.**
  Restricted to the `Bash` tool, holds **no game state**. It polls the server for
  boards needing black, picks moves, and POSTs them.

The web layer is modular ES modules: `engine.js` (pure rules), `api.js` (REST
client), `view.js` (DOM), `app.js` (controller), `theme.css` + `board.css`.

> Requires **Node.js** on PATH (the server and tools are Node). The plugin only
> bundles files — there is no build step and no other runtime.

## Optimized for Claude Code subscription — forkable to any harness

This design is tuned for **Claude Code subscription users**: the AI opponent is a
Claude *subagent*, so inference is covered by your existing subscription — **no API
key, no metered per-move billing.** The expensive part of any LLM game loop is
context, so the whole architecture is built to keep the model's context tiny (see
[Token usage](#token-usage)).

But nothing about the *game* is Claude-specific. The server and browser are plain
Node/JS with **zero Claude dependency**. The brain is **~one function** against a
three-call contract:

```
1. GET  /api/pending?all=1&wait=1    → [{ id, fen, move_count }, …]   blocks until boards need black
2. choose a move per board from its FEN
3. POST /api/games/<id>/move          { from, to, san, by:"ai", expected_ply:move_count, … }
```

To fork to **any** harness (a Python script, a cron job, a different model, the
Anthropic API directly), replace `agents/chess-ai.md` with your own
loop implementing those three calls. Nothing else changes. The `&wait=1`
long-poll lets your loop block on one call instead of busy-polling; the `?all=1`
batch endpoint and the `expected_ply` compare-and-swap guard mean your driver can
be **stateless** — it never has to track games itself. One server backs every
session: `/api/health` reports `chessai_agent_active`, so a second launcher can
reuse the running server and skip starting a duplicate driver.

## Token usage

The AI opponent is the only part that spends tokens. It's built to stay light: it
carries only the `Bash` tool and keeps no game history, so a move is a small,
roughly fixed cost (~5–6k tokens of context per model call) instead of a context
that grows as the game goes on.

Rough mileage, to eyeball against your plan's rates:

| Activity | Token cost |
|---|---|
| Engine start | ~5–6k tokens once, when the agent first loads — then cached |
| Per move, one board | ~a few thousand new tokens; most of each call is cached context re-read cheaply |
| Per move, multiple boards | shared — one wake plays every pending board at once |
| Idle / walked away | ≈ nothing (polling is plain `curl`), then it **stops itself after ~24 min** |

Each model call re-sends the position, but the unchanged part (rules + prior
context) is served from cache, so a move's real cost is just the small new bit.
The model only runs when there's actually a move to make — waiting for your move is
a token-free `curl` loop — so leaving a game sitting costs almost nothing, and a
forgotten game shuts itself off rather than draining tokens in the background.

> Numbers are from recent games on Sonnet; actual cost scales with the model you
> set in the agent's `agents/chess-ai.md` frontmatter.

## Install

It's a Claude Code **plugin** — no installer, no build step. Add this repo as a
marketplace, then install (inside Claude Code):

```
/plugin marketplace add devasur/chessai
/plugin install chessai
```

(For local development, skip the marketplace and launch with
`claude --plugin-dir /path/to/chessai`.)

That registers the skill **`/chessai:chess`** and the agent **`chessai:chess-ai`**.
The plugin bundles:

```
.claude-plugin/plugin.json     # manifest
skills/chess/
  SKILL.md
  tools/{server.cjs, board.html, chess-api.cjs, web/*}
agents/chess-ai.md             # the AI-opponent brain (plays black)
```

Requires **Node.js** on PATH.

## Play

Inside Claude Code:

```
/chessai:chess
```

The skill starts the Node server, opens the board in a chromeless app-style window
(Chromium-family browsers; falls back to your default browser), and spawns the
AI-opponent agent. Click a piece then its destination; the AI opponent replies
within a couple of seconds. Commentary and reasoning appear in the move-list panel.

- **New board** opens another game in its own window for side-by-side play.
- **Games** lists every board — switch to one, open it in a new window, or delete it.
- The **skin swatches** switch theme (saved per game).
- Window size/position: `CHESSAI_WIN_SIZE="W,H"`, `CHESSAI_WIN_POS="X,Y"`.

### Run the board without Claude

From a clone of this repo:

```sh
node skills/chess/tools/server.cjs --port 4577 --open
```

## Stopping

- **Stop the whole session** — in Claude Code, stop the **server** background task
  and the **`chess-ai`** agent task (both were started with
  `run_in_background`). The board window can be closed normally.
- **Pause only the AI** — stop just the `chess-ai` agent task; the server and
  boards stay up, so you can resume by relaunching the agent.
- **The agent stops itself** after ~24 minutes idle. To resume, make a move and ask
  Claude to relaunch the AI opponent.
- **Free the port** — if `server.cjs` reports the port is in use, the previous
  server is still running; stop that task (or `pkill -f server.cjs`).

Games survive all of this: they persist to `~/.chessai/games/<id>.json` (override
with `CHESSAI_DATA_DIR`) and reload when the server restarts.

## REST API (`server.cjs`)

| Method | Path | Notes |
|--------|------|-------|
| GET | `/` | clickable web board |
| GET | `/api/health` | `{ ok, service:"chessai", version, games, chessai_agent_active }` |
| GET | `/api/games` | list every game (id, name, fen, turn, status, theme, opponent, last move…) |
| POST | `/api/games` | create a game (server assigns the three-word id) |
| GET | `/api/pending?all=1` | **array** of every board needing black — the agent's source |
| GET | `/api/pending?all=1&wait=1` | same, but **long-polls**: holds the connection open until a board needs black (coalescing near-simultaneous moves into one batch), or ~8 min → `[]` |
| GET | `/api/games/<id>` | full state incl. history |
| POST | `/api/games/<id>/move` | `{ from, to, san?, promotion?, by?, expected_ply?, harness?, model?, comment?, reasoning? }` |
| POST | `/api/games/<id>/reset` | reset to the starting position |
| POST | `/api/games/<id>/status` | `{ status }` — end the game |
| POST | `/api/games/<id>/theme` | `{ theme }` — `midnight \| marble \| emerald` |
| POST | `/api/games/<id>/opponent` | `{ harness?, model?, name? }` — who plays black |
| DELETE | `/api/games/<id>` | delete the game and its saved file |

CLI wrapper (from a clone of this repo): `node skills/chess/tools/chess-api.cjs games 4577`.

## Notes

- **Where the rules live:** the *server* board model is intentionally permissive
  (applies any well-formed move) — keeping it dumb. Legality is enforced by the
  *browser* engine for the human, while the agent chooses its own legal moves for
  black. The client detects and posts the result (checkmate, stalemate, fifty-move).
- **Statelessness by design:** the `expected_ply` compare-and-swap guard lets the
  agent (or any forked driver) submit a move without tracking games — the server
  rejects a move computed against a stale position, so a single driver can serve
  every parallel board safely.
- **Upgrades:** `/plugin update chessai` pulls the latest skill and agent. The
  `version` in `.claude-plugin/plugin.json` drives update detection (bump it per
  release); refresh the catalog first with `/plugin marketplace update chessai`.

## License

MIT
