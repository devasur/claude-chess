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

- **`chessai` (Rust binary)** — *install only*. Embeds the skill files and writes
  them under `~/.claude`. A pure **distribution vehicle**; no game logic.
- **`tools/server.cjs` (Node)** — authoritative state for every game (FEN,
  castling, en passant, promotion, persistence), the REST API, and the web UI.
  **No chess intelligence — pure plumbing.**
- **The browser** (`tools/web/*`, `board.html`) — the clickable UI *and* the
  human's legal-move engine; also detects and posts the game result.
- **The `chess-ai` agent** (`~/.claude/agents/chess-ai.md`) — **the brain.**
  Restricted to the `Bash` tool, holds **no game state**. It polls the server for
  boards needing black, picks moves, and POSTs them.

The web layer is modular ES modules: `engine.js` (pure rules), `api.js` (REST
client), `view.js` (DOM), `app.js` (controller), `theme.css` + `board.css`.

> Requires **Node.js** on PATH. The Rust binary only writes files.

## Optimized for Claude Code subscription — forkable to any harness

This design is tuned for **Claude Code subscription users**: the AI opponent is a
Claude *subagent*, so inference is covered by your existing subscription — **no API
key, no metered per-move billing.** The expensive part of any LLM game loop is
context, so the whole architecture is built to keep the model's context tiny (see
[Token economics](#token-economics)).

But nothing about the *game* is Claude-specific. The server and browser are plain
Node/JS with **zero Claude dependency**. The brain is **~one function** against a
three-call contract:

```
1. GET  /api/pending?all=1          → [{ id, fen, move_count }, …]   boards needing black
2. choose a move per board from its FEN
3. POST /api/games/<id>/move          { from, to, san, by:"ai", expected_ply:move_count, … }
```

To fork to **any** harness (a Python script, a cron job, a different model, the
Anthropic API directly), replace `~/.claude/agents/chess-ai.md` with your own
loop implementing those three calls. Nothing else changes. The `?all=1` batch
endpoint and the `expected_ply` compare-and-swap guard mean your driver can be
**stateless** — it never has to track games itself.

## Token economics

The AI opponent is the only thing that spends tokens, and **the cost is context,
not cleverness.** Two design choices keep it minimal, both measured from real
transcripts:

**1. Strip the tool belt.** A generic agent carries the JSON schema of every tool
(Bash, Read, Write, Edit, Grep, Glob, …) in *every* call. `chess-ai` is
restricted to `tools: [Bash]`, so it carries one schema, not a dozen.

```
Floor carried on every model call (tokens):
  generic agent   ████████████   12.2k   (full tool belt + game history)
  chess-ai        █████▌           5.6k   (Bash only, no history)      −54%
```

**2. Hold no state.** The server is the source of truth, so the agent never
accumulates a growing transcript. Context stays flat instead of climbing every
move:

```
Per-move tokens processed (active play, one board):
  long-lived inline  ████████████████████████████████  ~81k / move
  chess-ai           ██████████████▌                   ~37k / move      −55%
```

### Scenarios (projected from measured transcripts)

**Playing one board** — ~3 model calls per move (poll → decide → post), each
carrying ~6–12k of context. **≈ 37k tokens per move.**

**Playing multiple boards** — the agent fetches *all* pending boards in one poll
and reasons over them in a single pass, so the ~6–12k floor is paid **once per
wake, not once per board**. Tokens per move fall as boards share the wake:

```
Tokens per move, by boards moving together:
  1 board    ██████████████▌   ~37k
  2 boards   ██████████        ~27k
  3 boards   █████████         ~24k
```

**Leaving boards unattended** — when you walk away, every board waits on *white*,
so the agent has nothing to do. It polls in ~8-minute blocking windows (free — pure
`curl`), and **after ~24 minutes idle it stops itself.**

```
Tokens while idle:
  no self-stop (old)  ██████████████████████  ~300k / hour — forever
  chess-ai            ▌                       ~25k total, then 0  (stops ~24 min)
```

This is the bigger real-world win: idle drain happens exactly when you're not
watching. A forgotten game costs a one-time ~25k tokens, then nothing — instead of
bleeding ~300k tokens/hour indefinitely.

> Numbers are grounded in real session transcripts (the `tools: [Bash]` floor and
> per-move throughput are measured; the idle-stop and multi-board batching are
> projected from the same floors). $-cost falls even further than raw tokens
> because most of the context is cache reads, not writes.

## Install

Any one of (each puts `chessai` on PATH, then runs `chessai install`):

```sh
# npm — builds the tiny Rust installer on first run
npx @entelligentsia/chessai install

# cargo — builds from the git repo (the crates.io name `chessai` is an unrelated crate)
cargo install --git https://github.com/devasur/chessai chessai && chessai install

# curl | sh
curl -fsSL https://raw.githubusercontent.com/devasur/chessai/main/install.sh | sh
```

`chessai install` writes:

```
~/.claude/skills/chess/
  SKILL.md
  tools/server.cjs
  tools/board.html
  tools/chess-api.cjs
  tools/web/{theme.css,board.css,engine.js,api.js,view.js,app.js}
~/.claude/agents/
  chess-ai.md          # the AI-opponent brain (plays black)
```

## Play

Inside Claude Code:

```
/chess
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

```sh
node ~/.claude/skills/chess/tools/server.cjs --port 4577 --open
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
| GET | `/api/health` | `{ ok, version, games }` |
| GET | `/api/games` | list every game (id, name, fen, turn, status, theme, opponent, last move…) |
| POST | `/api/games` | create a game (server assigns the three-word id) |
| GET | `/api/pending?all=1` | **array** of every board needing black — the agent's source |
| GET | `/api/games/<id>` | full state incl. history |
| POST | `/api/games/<id>/move` | `{ from, to, san?, promotion?, by?, expected_ply?, harness?, model?, comment?, reasoning? }` |
| POST | `/api/games/<id>/reset` | reset to the starting position |
| POST | `/api/games/<id>/status` | `{ status }` — end the game |
| POST | `/api/games/<id>/theme` | `{ theme }` — `midnight \| ivory \| emerald` |
| POST | `/api/games/<id>/opponent` | `{ harness?, model?, name? }` — who plays black |
| DELETE | `/api/games/<id>` | delete the game and its saved file |

CLI wrapper: `node ~/.claude/skills/chess/tools/chess-api.cjs games 4577`.

## Notes

- **Where the rules live:** the *server* board model is intentionally permissive
  (applies any well-formed move) — keeping it dumb. Legality is enforced by the
  *browser* engine for the human, while the agent chooses its own legal moves for
  black. The client detects and posts the result (checkmate, stalemate, fifty-move).
- **Statelessness by design:** the `expected_ply` compare-and-swap guard lets the
  agent (or any forked driver) submit a move without tracking games — the server
  rejects a move computed against a stale position, so a single driver can serve
  every parallel board safely.
- **Upgrades:** the npm launcher stamps the built binary with its version and
  rebuilds when it changes, so `npx @entelligentsia/chessai@latest install` always
  lays down the current skill and agent.

## License

MIT
