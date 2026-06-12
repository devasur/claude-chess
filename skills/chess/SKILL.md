---
name: chess
description: Play chess against an AI opponent. Starts a local Node server (board state + REST + web UI), opens a clickable board in the browser, and spawns one background agent that plays black and replies to each of your moves. Use when the user runs /chessai:chess or asks to play chess.
---

# Chess (`/chessai:chess`)

The human plays **white** on a browser board; a background **`chess-ai`** agent
(the AI opponent) plays **black**. Your job is small: **start the server, spawn the
agent, and answer the player's questions.** All rules and state live in the server;
every move choice lives in the agent.

> Architecture, REST API, token usage and forking notes are in the repo
> `README.md` — you don't need any of it to run a game. Don't restate it here.

## Start a game

Use `PORT=4577` (override only if it's taken by something that isn't chessai).

1. **Find or start the server — check health first.** One server backs every
   session, so look before you launch: probing health first means you reuse a
   running server cleanly instead of spawning a second one that dies on the port.

   a. `curl -s http://127.0.0.1:4577/api/health`:
      - `{"ok":true,"service":"chessai",...}` → **reuse it.** Don't start a server.
        Pop this session's own board window (the running server is untouched):
        ```
        node ${CLAUDE_PLUGIN_ROOT}/skills/chess/tools/server.cjs --open-url http://127.0.0.1:4577/
        ```
      - A response that isn't chessai (no `service:"chessai"`) → pick another port
        and use it everywhere below.
      - No response (connection refused) → nothing's there; start one (step b).

   b. Start it (Bash tool, `run_in_background: true`):
      ```
      node ${CLAUDE_PLUGIN_ROOT}/skills/chess/tools/server.cjs --port 4577 --open
      ```
      Poll `curl -s http://127.0.0.1:4577/api/health` until `{"ok":true,...}`. If it
      instead logs `port in use` (another session won a start race), go back to (a)
      and reuse that server. (Headless? drop `--open`; the user opens the URL.)

2. **Spawn the AI opponent — only if one isn't already serving.** The health
   payload carries `chessai_agent_active`. One agent plays black for *every* board
   on the server, across all sessions, so don't add a second.
   - `chessai_agent_active: true` → an agent is already answering black (yours
     included). **Skip this step.**
   - `false` → spawn one. Agent tool, `subagent_type: "chessai:chess-ai"`,
     `run_in_background: true`, prompt = the server URL:
     > Play black on the chess server at `http://127.0.0.1:4577`.

   It plays black on every game, blocks on one long-poll between moves, backs off
   when idle, and stops itself after ~24 min idle. If `chessai_agent_active` is
   `false` later (the previous one self-stopped), relaunch it the same way.

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
node ${CLAUDE_PLUGIN_ROOT}/skills/chess/tools/chess-api.cjs games 4577
```
(Full REST API is in the README.)
