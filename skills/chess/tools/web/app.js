// app.js — the controller and entry point.
//
// It owns the mutable UI state, resolves which game this window is showing,
// wires up user input and the control buttons, runs the poll loop against the
// server, and is the rules authority for game-over detection. It composes the
// three pure-ish layers:
//
//   engine  — what moves are legal / how a move reads
//   api     — how to read & write the server
//   view    — how to paint the current state
//
// Each browser window plays ONE game, identified by ?game=<id> in the URL. Open
// a second window (the "New board" button) to play a parallel game; a single
// background agent serves every game via /api/pending.

import { parseFEN, legalMoves, toSAN, inCheck, sqName } from './engine.js';
import * as api from './api.js';
import * as view from './view.js';

// --- which game is this window? -------------------------------------------
let gameId = new URLSearchParams(location.search).get('game');

function adoptGame(g) {
  gameId = g.id;
  history.replaceState(null, '', `${location.pathname}?game=${gameId}`);
  ui.server = g;
  render();
}

// --- UI state --------------------------------------------------------------
const ui = {
  server: null,        // last server payload for this game
  pos: null,           // parsed engine state from server FEN
  legal: [],           // legal moves for the side to move
  sel: null,           // selected [r,c]
  flipped: false,
  endPosted: null,     // fen for which we've posted a game-over status
  pendingPromo: null,  // { from, to } awaiting promotion choice
  agentActive: null,   // is a chessai agent serving black? null = not yet known
};

const snapshot = () => ({ server: ui.server, pos: ui.pos, legal: ui.legal, sel: ui.sel, flipped: ui.flipped, agentActive: ui.agentActive });
const handlers = { onSquare };

// --- render orchestration --------------------------------------------------
function render() {
  if (!ui.server) return;
  ui.pos = parseFEN(ui.server.fen);
  ui.legal = ui.server.status === 'playing' ? legalMoves(ui.pos) : [];
  view.render(snapshot(), handlers);
  detectEnd();
}

const legalForSel = () => (ui.sel ? ui.legal.filter((m) => m.from[0] === ui.sel[0] && m.from[1] === ui.sel[1]) : []);

// --- input -----------------------------------------------------------------
function onSquare(r, c) {
  if (!ui.pos || ui.pos.turn !== 'w' || ui.server.status !== 'playing') return;
  const p = ui.pos.b[r][c];
  if (ui.sel) {
    const mv = legalForSel().find((m) => m.to[0] === r && m.to[1] === c);
    if (mv) {
      const promos = legalForSel().filter((m) => m.to[0] === r && m.to[1] === c && m.promo);
      if (promos.length) { ui.pendingPromo = { from: ui.sel, to: [r, c] }; openPromo(); return; }
      ui.sel = null; submitMove(mv); return;
    }
  }
  if (p && p === p.toUpperCase()) { ui.sel = (ui.sel && ui.sel[0] === r && ui.sel[1] === c) ? null : [r, c]; render(); }
  else { ui.sel = null; render(); }
}

const buildMove = (from, to, promo) =>
  ui.legal.find((m) => m.from[0] === from[0] && m.from[1] === from[1] && m.to[0] === to[0] && m.to[1] === to[1] && (promo ? m.promo === promo : !m.promo));

async function submitMove(mv) {
  const san = toSAN(ui.pos, mv, ui.legal);
  const body = { from: sqName(mv.from[0], mv.from[1]), to: sqName(mv.to[0], mv.to[1]), san, by: 'human', expected_ply: ui.server.move_count };
  if (mv.promo) body.promotion = mv.promo;
  try {
    const next = await api.sendMove(gameId, body);
    if (next.error) { await poll(); return; }
    ui.server = next; render();
  } catch (e) { await poll(); }
}

// --- promotion -------------------------------------------------------------
function openPromo() {
  view.openPromo((pr) => {
    const mv = buildMove(ui.pendingPromo.from, ui.pendingPromo.to, pr);
    ui.sel = null; ui.pendingPromo = null;
    if (mv) submitMove(mv);
  });
}

// --- game-over detection (the client is the rules authority) ---------------
function detectEnd() {
  if (ui.server.status !== 'playing' || ui.endPosted === ui.server.fen) return;
  if (ui.legal.length === 0) {
    const checked = inCheck(ui.pos);
    let status;
    if (checked) status = ui.pos.turn === 'w' ? 'Checkmate — Chessai wins' : 'Checkmate — you win';
    else status = 'Stalemate — draw';
    ui.endPosted = ui.server.fen; postStatus(status);
  } else if (parseInt(ui.server.fen.split(' ')[4] || '0', 10) >= 100) {
    ui.endPosted = ui.server.fen; postStatus('Draw — fifty-move rule');
  }
}

async function postStatus(status) {
  try { ui.server = await api.setStatus(gameId, status); view.render(snapshot(), handlers); } catch (e) {}
}

// --- controls --------------------------------------------------------------
function newBoard() {
  // open a fresh window with no ?game — it will create a new parallel game.
  window.open(location.pathname, '_blank', 'width=980,height=840');
}
function openInWindow(id) {
  window.open(`${location.pathname}?game=${id}`, '_blank', 'width=980,height=840');
}
async function refreshGames() {
  const list = await api.listGames();
  view.openGames(list, {
    currentId: gameId,
    onPick: (id) => { location.search = `?game=${id}`; },   // switch this window
    onOpen: openInWindow,                                   // side-by-side window
    onDelete: async (g) => {
      if (!confirm(`Delete game “${g.name}”? This cannot be undone.`)) return;
      await api.deleteGame(g.id);
      if (g.id === gameId) { view.closeGames(); return adoptGame(await api.createGame()); }
      refreshGames();                                       // re-render the list in place
    },
  });
}
async function setTheme(theme) {
  view.applyTheme(theme);                                   // optimistic
  if (ui.server) { ui.server = await api.setTheme(gameId, theme); render(); }
}
function flip() { ui.flipped = !ui.flipped; render(); }
async function resign() { if (ui.server && ui.server.status === 'playing') { ui.endPosted = 'resign'; await postStatus('You resigned — Chessai wins'); } }

// --- poll loop -------------------------------------------------------------
async function poll() {
  try {
    const next = await api.getGame(gameId);
    if (next.error) { return adoptGame(await api.createGame()); } // game gone — start fresh
    if (!ui.server || next.move_count >= (ui.server.move_count || 0)) { ui.server = next; render(); }
  } catch (e) { view.setOffline(); }
}

// --- opponent health poll ---------------------------------------------------
// Independent of the game poll: tells the board whether a chessai agent is
// actually serving black yet, so we don't imply "ready" during the gap between
// the board opening and the agent's first poll.
async function pollHealth() {
  try {
    const h = await api.health();
    const active = !!h.chessai_agent_active;
    if (active !== ui.agentActive) { ui.agentActive = active; if (ui.server) render(); } // refresh status pill
    view.setOpponentStatus(ui.agentActive);
  } catch (e) {
    if (ui.agentActive !== null) { ui.agentActive = null; if (ui.server) render(); }
    view.setOpponentStatus(null);
  }
}

// --- boot ------------------------------------------------------------------
document.getElementById('btnNew').addEventListener('click', newBoard);
document.getElementById('btnGames').addEventListener('click', refreshGames);
document.getElementById('btnFlip').addEventListener('click', flip);
document.getElementById('btnResign').addEventListener('click', resign);
for (const el of document.querySelectorAll('.skin')) {
  el.addEventListener('click', () => setTheme(el.dataset.theme));
}

async function boot() {
  if (!gameId) adoptGame(await api.createGame()); // no game in URL → create one for this window
  poll();
  setInterval(poll, 1500);
  pollHealth();
  setInterval(pollHealth, 2000);
}
boot();
