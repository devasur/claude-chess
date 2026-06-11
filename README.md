# chessai

Play chess against Claude Code. You play white on a clickable browser board; a
background Claude agent plays black, replying to each move with a comment and its
reasoning.

```
 you (white) ──HTTP──▶  node server.cjs  ◀──HTTP──  black-player Agent
                        (state + FEN +              (Claude, spawned by the
   browser board          REST + web UI;             /chess skill: poll → decide
   (click to move)        no intelligence)           → POST, looping)
```

## Architecture

Two pieces, clean split of responsibility:

- **`chessai` (Rust binary)** — *install only*. It embeds the skill files and
  writes them to `~/.claude/skills/chess`. It's purely a **distribution vehicle**
  so you can install the skill without the plugin marketplace. It contains no
  game logic.
- **The `chess` skill (Node)** — the whole game:
  - `tools/server.cjs` — dependency-free Node HTTP server: board state, FEN,
    castling/en-passant/promotion, REST API, serves the web UI. **No chess
    intelligence — pure plumbing.**
  - `tools/board.html` — the clickable board.
  - `SKILL.md` — orchestration: start the server, open the board, and spawn **one
    background Claude agent** that plays black. That agent is the only place moves
    are chosen; its context persists and prompt-caches across moves, so there's no
    per-move cold-start cost.

> Requires **Node.js** on PATH (the server and tools are Node). The Rust binary
> only writes files.

## Install

Any one of (each puts `chessai` on PATH, then runs `chessai install`):

```sh
npx @entelligentsia/chessai install            # npm — builds the tiny Rust installer on first run
cargo install chessai          # cargo  (then: chessai install)
curl -fsSL https://raw.githubusercontent.com/devasur/claude-chess/main/install.sh | sh
```

`chessai install` writes:

```
~/.claude/skills/chess/
  SKILL.md
  tools/server.cjs
  tools/board.html
  tools/chess-api.cjs
```

## Play

Inside Claude Code:

```
/chess
```

The skill starts the Node server, opens the board in your browser, and spawns the
black-player agent. Click a piece then its destination; Claude replies within a
couple of seconds. Commentary appears in the move-list panel.

### Run the board without Claude

```sh
node ~/.claude/skills/chess/tools/server.cjs --port 4577 --open
```

## REST API (`server.cjs`)

| Method | Path          | Notes                                                         |
|--------|---------------|---------------------------------------------------------------|
| GET    | `/`           | clickable web board                                           |
| GET    | `/api/health` | `{ ok, version }`                                             |
| GET    | `/api/state`  | full: `{ fen, turn, status, move_count, last_move, history }`|
| GET    | `/api/turn`   | compact (used by the agent): no growing history              |
| POST   | `/api/move`   | `{ from, to, san?, promotion?, comment?, reasoning?, by? }`  |
| POST   | `/api/reset`  | reset to the starting position                               |
| POST   | `/api/status` | `{ status }` — end the game                                  |

## Notes

- The board model is intentionally permissive (it does not enforce full
  legality) — move *selection* is delegated to Claude.
- Why the agent polls `/api/turn` not `/api/state`: `/state` carries the entire
  move history, which grows every turn; `/turn` is a small flat payload, so the
  long-lived agent's context stays cheap.

## License

MIT
