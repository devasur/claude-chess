---
name: chess
description: Play chess against an AI opponent. Starts a local Node server (board state + REST + web UI), opens a clickable board in the browser, and spawns one background agent that plays black and replies to each of your moves. Use when the user runs /chess or asks to play chess.
---

# Chess (`/chess`)

The human plays **white** on a browser board; a background **`chess-ai`** agent
(the AI opponent) plays **black**. Your job is small: **start the server, spawn the
agent, and answer the player's questions.** All rules and state live in the server;
every move choice lives in the agent.

> Architecture, REST API, token usage and forking notes are in the repo
> `README.md` — you don't need any of it to run a game. Don't restate it here.

## Start a game

Use `PORT=4577` (override if busy).

1. **Start the server** (Bash tool, `run_in_background: true`):
   ```
   node ~/.claude/skills/chess/tools/server.cjs --port 4577 --open
   ```
   Then poll `curl -s http://127.0.0.1:4577/api/health` until `{"ok":true}`.
   `port in use` → pick another port and reuse it everywhere. (Headless? drop
   `--open`; the user opens `http://127.0.0.1:4577/`.)

2. **Spawn the AI opponent.** Agent tool, `subagent_type: "chess-ai"`,
   `run_in_background: true`, prompt = the server URL:
   > Play black on the chess server at `http://127.0.0.1:4577`.

   It plays black on every game, polls in batches, backs off when idle, and stops
   itself after ~24 min idle. Relaunch it the same way to resume.

3. **Tell the user** it's their move (white first). They click a piece then its
   destination. *New board* opens a parallel game, *Games* lists every board, and
   the skin swatches switch theme — the agent answers all of them.

## Stop

- **End the session:** stop the server background task **and** the `chess-ai`
  agent task.
- **Pause the AI only:** stop the agent task; the server and boards stay up.

## Answer questions

Game state lives in the server — list every board with:
```
node ~/.claude/skills/chess/tools/chess-api.cjs games 4577
```
(Full REST API is in the README.)
