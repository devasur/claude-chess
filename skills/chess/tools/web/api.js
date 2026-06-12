// api.js — the only module that talks to the chessai server.
//
// Every game-scoped call takes a game id (the three-word name the server
// assigned). Each function is a thin wrapper over one REST endpoint and returns
// the parsed JSON payload (which may itself carry an `error` field — callers
// decide how to react). Network failures reject; that is the controller's cue to
// fall back to a state poll. Keeping all I/O here means the rest of the app is
// offline-pure.

const json = (res) => res.json();
const post = (url, body) =>
  fetch(url, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }).then(json);

// --- games collection ---
export function listGames() { return fetch('/api/games').then(json); }
export function createGame() { return post('/api/games'); }

// --- a single game ---
export function getGame(id) { return fetch(`/api/games/${id}`).then(json); }
export function sendMove(id, body) { return post(`/api/games/${id}/move`, body); }
export function resetGame(id) { return post(`/api/games/${id}/reset`); }
export function setStatus(id, status) { return post(`/api/games/${id}/status`, { status }); }
export function setTheme(id, theme) { return post(`/api/games/${id}/theme`, { theme }); }
export function deleteGame(id) { return fetch(`/api/games/${id}`, { method: 'DELETE' }).then(json); }
