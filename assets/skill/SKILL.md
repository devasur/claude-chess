---
name: chess
description: Play chess against Claude. Starts a local Node server (board state + REST + web UI), opens a clickable board in the browser, and spawns one background agent that plays black and replies to each of your moves. Use when the user runs /chess or asks to play chess.
---

# Chess (`/chess`)

You set up an interactive chess game. The human plays **white** on a browser
board; **you spawn one background agent that plays black** and answers each move.

Architecture:
- `tools/server.cjs` — a dependency-free Node server. Holds the authoritative
  board (FEN, castling, en-passant, promotion), serves the web UI, and exposes a
  REST API. **It has no chess intelligence** — it is pure plumbing.
- The **black player is a Claude agent** you launch below. That is the only place
  moves are chosen.

The tool files live in this skill's `tools/` directory:
`~/.claude/skills/chess/tools/` (`server.cjs`, `board.html`, `chess-api.cjs`).

## Steps to start a game

Use `PORT=4577` (override if busy). Let `DIR=~/.claude/skills/chess/tools`.

1. **Start the server** in the background (Bash tool, `run_in_background: true`):

   ```
   node ~/.claude/skills/chess/tools/server.cjs --port 4577 --open
   ```

   `--open` also opens the clickable board in the user's browser. Then poll
   `curl -s http://127.0.0.1:4577/api/health` until it returns `{"ok":true}`.
   If you see `port 4577 in use`, pick another port and reuse it everywhere.

   (Headless? Skip `--open`; the user can browse to `http://127.0.0.1:4577/`.)

2. **Spawn the black-player agent.** Use the **Agent tool** with
   `run_in_background: true`. This single long-lived agent IS the orchestrator —
   its context (board history) persists and prompt-caches across moves, so there
   is no per-move cold-start cost. Give it this prompt (substitute the port):

   > You are Claude playing the **black** pieces in a friendly game of chess
   > against a human (white). The game lives on a local server at
   > `http://127.0.0.1:4577`. Loop until the game ends:
   >
   > 1. **Wait for the human's move.** Run this bash until-loop (Bash tool); it
   >    returns as soon as it is black's turn with a new move, or the game ends:
   >    ```
   >    LAST=0
   >    for i in $(seq 1 150); do
   >      S=$(curl -s http://127.0.0.1:4577/api/turn)
   >      TURN=$(printf '%s' "$S" | sed -n 's/.*"turn":"\([wb]\)".*/\1/p')
   >      CNT=$(printf '%s' "$S" | grep -o '"move_count":[0-9]*' | grep -o '[0-9]*')
   >      STAT=$(printf '%s' "$S" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')
   >      if [ "$STAT" != "playing" ]; then break; fi
   >      if [ "$TURN" = "b" ]; then break; fi
   >      sleep 2
   >    done
   >    printf '%s' "$S"
   >    ```
   >    (Track the `move_count` yourself between iterations so you only act on a
   >    genuinely new white move.)
   > 2. If `status` is not `playing`, stop.
   > 3. **Choose black's reply** from the FEN in the response. Pick a strong,
   >    sound move.
   > 4. **Submit it** (Bash tool), with a short friendly comment and one-sentence
   >    reasoning:
   >    ```
   >    curl -s -X POST http://127.0.0.1:4577/api/move \
   >      -H 'Content-Type: application/json' \
   >      -d '{"from":"e7","to":"e5","san":"e5","by":"ai","comment":"...","reasoning":"..."}'
   >    ```
   >    Use `"promotion":"q"` (or r/b/n) when a pawn promotes.
   > 5. Go back to step 1.
   >
   > Keep going move after move without asking for confirmation. Your final
   > message should summarize the finished game.

3. **Tell the user** the board is open and it's their move (white first). They
   click a piece then its destination; you (black) reply within a couple seconds.
   Commentary and reasoning show in the move-list panel.

## Managing the game

- **New game**: the user clicks *New game* on the board, or `POST /api/reset`.
- **Stop Claude's side**: stop the background black-player agent task.
- **Declare over**: `POST /api/status` with `{"status":"checkmate"}` etc.

## REST API (served by `server.cjs`)

- `GET  /api/state` → `{ fen, turn, status, move_count, last_move, history }`
- `GET  /api/turn`  → compact: `{ fen, turn, status, move_count, last_san, last_from, last_to }`
- `POST /api/move`  → `{ from, to, san?, promotion?, comment?, reasoning?, by? }`
- `POST /api/reset` → reset to the starting position
- `POST /api/status`→ `{ status }` to end the game
- `GET  /api/health`→ `{ ok, version }`

The black-player agent should poll `/api/turn` (small, flat payload), not
`/api/state` (which carries the full, growing history).

Convenience CLI wrapper: `node ~/.claude/skills/chess/tools/chess-api.cjs state 4577`.
