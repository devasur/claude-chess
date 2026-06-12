// view.js — everything that touches the DOM lives here.
//
// The view is a (mostly) stateless renderer: app.js hands it a snapshot of the
// game and a set of callbacks, and it paints the board, status pill, capture
// trays, and move log to match. It reaches back into the model only through the
// pure helpers imported from engine.js — it never mutates game state itself.
//
// The lone piece of view-owned state is `prevFen`, used purely to decide whether
// the most recent move should slide into place.

import { FILES, sqName, parseSquare, colorOf, inCheck, findKing } from './engine.js';

// --- display constants (presentation only — the engine has no opinion here) ---
const GLYPH = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' };
const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const START_COUNT = { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cell = (m) => (m.from || '') + (m.to || '');

let prevFen = null;

// board orientation: indices 0..7, reversed when the board is flipped.
const order = (flipped) => { const a = [...Array(8).keys()]; return flipped ? a.slice().reverse() : a; };

// legal moves originating from the currently-selected square.
const legalForSel = ({ sel, legal }) => (sel ? legal.filter((m) => m.from[0] === sel[0] && m.from[1] === sel[1]) : []);

// --------------------------------------------------------------------------
// board
// --------------------------------------------------------------------------
function renderBoard(state, handlers) {
  const { server, pos, sel, flipped } = state;
  const board = $('board');
  board.innerHTML = '';
  const myTurn = pos.turn === 'w' && server.status === 'playing';
  const kingSq = inCheck(pos) ? findKing(pos.b, pos.turn) : null;
  const last = server.last_move;
  const od = order(flipped);

  for (const r of od) for (const c of od) {
    const d = document.createElement('div');
    d.className = 'sq ' + ((r + c) % 2 ? 'dark' : 'light');
    d.dataset.sq = sqName(r, c);
    if (last && last.from === sqName(r, c)) d.classList.add('last');
    if (last && last.to === sqName(r, c)) d.classList.add('last');
    if (sel && sel[0] === r && sel[1] === c) d.classList.add('sel');
    if (kingSq && kingSq.r === r && kingSq.c === c) d.classList.add('check');

    // edge coordinate labels
    if (c === od[0]) { const l = document.createElement('span'); l.className = 'lbl rank'; l.textContent = 8 - r; d.appendChild(l); }
    if (r === od[7]) { const l = document.createElement('span'); l.className = 'lbl file'; l.textContent = FILES[c]; d.appendChild(l); }

    const p = pos.b[r][c];
    if (p) {
      const span = document.createElement('span');
      span.className = 'piece ' + (colorOf(p) === 'w' ? 'piece-w' : 'piece-b');
      span.textContent = GLYPH[p.toLowerCase()];
      d.appendChild(span);
      if (myTurn && colorOf(p) === 'w') d.classList.add('playable');
    }

    // legal-move hint when a piece is selected
    if (sel) {
      const mv = legalForSel(state).find((m) => m.to[0] === r && m.to[1] === c);
      if (mv) {
        const h = document.createElement('div');
        h.className = 'hint' + (p || mv.ep ? ' capture' : '');
        const dot = document.createElement('div'); dot.className = 'dot'; h.appendChild(dot);
        d.appendChild(h);
        d.classList.add('playable');
      }
    }
    d.onclick = () => handlers.onSquare(r, c);
    board.appendChild(d);
  }

  animateLast(state);
  prevFen = server.fen;
}

// --------------------------------------------------------------------------
// status / trays / log
// --------------------------------------------------------------------------
function paintStatus({ server, pos }) {
  const el = $('status'), txt = $('statusText');
  const checked = inCheck(pos);
  const ai = esc(opponentLabel(server.opponent));
  let cls = 'status', label = '';
  if (server.status && server.status !== 'playing') {
    cls += /win/i.test(server.status) ? ' win' : ' over';
    label = `<b>${esc(server.status)}</b>`;
  } else if (pos.turn === 'w') {
    cls += checked ? ' check' : ' you';
    label = checked ? '<b>Check — defend your king</b>' : '<b>Your move</b><small>white to play</small>';
  } else {
    cls += checked ? ' check' : ' ai';
    label = checked ? `<b>You have ${ai} in check</b><small>black to respond</small>` : `<b>${ai} is thinking…</b><small>black to play</small>`;
  }
  el.className = cls; txt.innerHTML = label;
}

function counts(pos, color) {
  const out = { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 };
  for (const row of pos.b) for (const p of row) if (p && colorOf(p) === color) out[p.toLowerCase()]++;
  return out;
}

function paintTrays({ pos }) {
  const w = counts(pos, 'w'), b = counts(pos, 'b');
  const missing = (cnt) => { const m = []; for (const t of ['q', 'r', 'b', 'n', 'p']) for (let i = 0; i < START_COUNT[t] - cnt[t]; i++) m.push(t); return m; };
  const capByYou = missing(b), capByAi = missing(w);     // black pieces you took / white pieces the AI took
  $('capByYou').innerHTML = capByYou.map((t) => `<span class="pb">${GLYPH[t]}</span>`).join('');
  $('capByAi').innerHTML = capByAi.map((t) => `<span class="pw">${GLYPH[t]}</span>`).join('');
  const matW = Object.entries(w).reduce((a, [t, n]) => a + VAL[t] * n, 0);
  const matB = Object.entries(b).reduce((a, [t, n]) => a + VAL[t] * n, 0);
  const diff = matW - matB;
  $('advYou').textContent = diff > 0 ? '+' + diff : '';
  $('advAi').textContent = diff < 0 ? '+' + (-diff) : '';
}

function paintLog({ server }) {
  const log = $('log'); const h = server.history || [];
  if (!h.length) { log.innerHTML = '<div class="empty-state">The first move is yours. Click a piece to begin.</div>'; return; }
  let html = '', i = 0;
  while (i < h.length) {
    const wm = h[i].color === 'w' ? h[i] : null;
    const bm = wm ? (h[i + 1] && h[i + 1].color === 'b' ? h[i + 1] : null) : h[i];
    const no = wm ? wm.number : bm.number;
    html += `<div class="ply"><span class="no">${no}.</span>` +
      `<span class="mv${wm ? '' : ' empty'}">${wm ? esc(wm.san || cell(wm)) : '·'}</span>` +
      `<span class="mv${bm ? '' : ' empty'}">${bm ? esc(bm.san || cell(bm)) : ''}</span>`;
    const note = (bm && bm.by === 'ai' && bm.comment) ? bm : (wm && wm.by === 'ai' && wm.comment) ? wm : null;
    if (note) html += `<span class="note">“${esc(note.comment)}”${note.reasoning ? `<span class="why">${esc(note.reasoning)}</span>` : ''}</span>`;
    html += `</div>`;
    i += wm && bm ? 2 : 1;
  }
  log.innerHTML = html; log.scrollTop = log.scrollHeight;
}

// --------------------------------------------------------------------------
// move animation — slide the just-moved piece from its origin square
// --------------------------------------------------------------------------
function squareXY(r, c, flipped) {
  const cs = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cell'));
  const od = order(flipped); const col = od.indexOf(c), row = od.indexOf(r);
  return { x: col * cs, y: row * cs };
}

function animateLast({ server, flipped }) {
  const last = server.last_move; if (!last || !prevFen || prevFen === server.fen) return;
  const toEl = document.querySelector(`.sq[data-sq="${last.to}"] .piece`); if (!toEl) return;
  const f = parseSquare(last.from), t = parseSquare(last.to);
  const a = squareXY(f.r, f.c, flipped), b = squareXY(t.r, t.c, flipped);
  toEl.classList.add('moving');
  toEl.style.transform = `translate(${a.x - b.x}px, ${a.y - b.y}px)`;
  requestAnimationFrame(() => requestAnimationFrame(() => { toEl.style.transform = 'translate(0,0)'; }));
  setTimeout(() => { toEl.classList.remove('moving'); toEl.style.transform = ''; }, 300);
}

// --------------------------------------------------------------------------
// theme — apply the persisted board skin and reflect it in the swatch picker
// --------------------------------------------------------------------------
export function applyTheme(name) {
  const theme = name || 'midnight';
  document.documentElement.dataset.theme = theme;
  for (const el of document.querySelectorAll('.skin')) el.classList.toggle('active', el.dataset.theme === theme);
}

// --------------------------------------------------------------------------
// game identity — name, opponent, window title
// --------------------------------------------------------------------------
const pretty = (id) => (id ? id.replace(/-/g, ' · ') : '');
// the AI opponent's display name: "<model> Chessai" (e.g. "Sonnet 4.6 Chessai"),
// or just "Chessai" until it reports a model. The vendor prefix is dropped.
const cleanModel = (m) => (m ? m.replace(/^claude\s+/i, '').trim() : '');
const opponentLabel = (o) => {
  const m = o && (o.model || o.name);
  return m ? `${cleanModel(m)} Chessai` : 'Chessai';
};

function paintMeta({ server }) {
  const name = server.name || server.id || '';
  $('gameName').textContent = pretty(name);
  const opp = $('opponent');
  if (opp) {
    opp.textContent = opponentLabel(server.opponent);
    opp.title = server.opponent && server.opponent.harness ? `via ${server.opponent.harness}` : '';
  }
  document.title = name ? `chessai · ${name}` : 'chessai';
}

// --------------------------------------------------------------------------
// relative time — "just now", "20m back", "2 days ago"
// --------------------------------------------------------------------------
function timeAgo(ms) {
  if (!ms) return '';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 1) return `${s}s back`;
  if (m < 60) return `${m}m back`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return d === 1 ? 'yesterday' : `${d} days ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

// --------------------------------------------------------------------------
// games picker — view / open / delete past & parallel games
// --------------------------------------------------------------------------
export function openGames(list, { currentId, onPick, onOpen, onDelete }) {
  const box = $('gamesList');
  box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="empty-state">No games yet. Click “New board” to start one.</div>'; }
  for (const g of list) {
    const current = g.id === currentId;
    const row = document.createElement('div');
    row.className = 'grow' + (current ? ' current' : '');

    const live = g.status === 'playing';
    const dot = !live ? 'done' : g.turn === 'w' ? 'live-you' : 'live-ai';
    const state = !live ? esc(g.status)
      : g.move_count === 0 ? 'new — your move'
      : g.turn === 'w' ? 'your move' : 'Chessai to move';
    const move = g.last_san
      ? `<span class="san">${esc(g.last_san)}</span>${g.last_comment ? ` <span class="cmt">“${esc(g.last_comment)}”</span>` : ''}`
      : `<span class="gstatetag">${state}</span>`;

    const main = document.createElement('button');
    main.className = 'gmain';
    main.disabled = current;
    main.innerHTML =
      `<span class="gtop"><span class="gstate ${dot}"></span>` +
      `<span class="gname">${esc(pretty(g.name))}</span>` +
      `<span class="gtime">${current ? 'this board' : esc(timeAgo(g.updated))}</span></span>` +
      `<span class="gline">${move}</span>`;
    main.onclick = () => onPick(g.id);

    const acts = document.createElement('span');
    acts.className = 'gact';
    const openBtn = document.createElement('button');
    openBtn.className = 'iconbtn open'; openBtn.title = 'Open in its own window'; openBtn.textContent = '⇗';
    openBtn.onclick = () => onOpen(g.id);
    const delBtn = document.createElement('button');
    delBtn.className = 'iconbtn del'; delBtn.title = 'Delete this game'; delBtn.textContent = '✕';
    delBtn.onclick = () => onDelete(g);
    acts.append(openBtn, delBtn);

    row.append(main, acts);
    box.appendChild(row);
  }
  $('gamesVeil').classList.add('show');
}

export function closeGames() { $('gamesVeil').classList.remove('show'); }

// --------------------------------------------------------------------------
// promotion modal
// --------------------------------------------------------------------------
export function openPromo(onPick) {
  const box = $('promoOpts'); box.innerHTML = '';
  for (const pr of ['q', 'r', 'b', 'n']) {
    const b = document.createElement('div'); b.className = 'opt'; b.textContent = GLYPH[pr];
    b.onclick = () => { closePromo(); onPick(pr); };
    box.appendChild(b);
  }
  $('veil').classList.add('show');
}

export function closePromo() { $('veil').classList.remove('show'); }

// --------------------------------------------------------------------------
// public render entry — paint the whole UI from one state snapshot
// --------------------------------------------------------------------------
export function render(state, handlers) {
  applyTheme(state.server.theme);
  paintMeta(state);
  renderBoard(state, handlers);
  paintStatus(state);
  paintTrays(state);
  paintLog(state);
}

// close the games picker when its backdrop is clicked.
document.getElementById('gamesVeil')?.addEventListener('click', (e) => {
  if (e.target.id === 'gamesVeil') closeGames();
});

// connection-lost banner (called by the controller's poll loop on failure).
export function setOffline() {
  $('statusText').innerHTML = '<b>server offline</b>';
  $('status').className = 'status over';
}
