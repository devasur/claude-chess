// engine.js — pure, DOM-free chess logic (validated with perft).
//
// This module knows the *rules* of chess and nothing about the screen, the
// server, or the game in progress. Every function is a pure transformation of
// the immutable state shape produced by parseFEN():
//
//   { b: string[8][8] | null, turn: 'w'|'b', cr: castling-rights, ep: {r,c}|null }
//
// Keep it that way: no fetch, no document, no globals. That is what makes it
// trivially testable (see perft) and reusable.

export const FILES = 'abcdefgh';
export const inb = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
export const sqName = (r, c) => FILES[c] + (8 - r);
export const parseSquare = (s) => ({ c: FILES.indexOf(s[0]), r: 8 - parseInt(s[1], 10) });
export const colorOf = (p) => (p ? (p === p.toUpperCase() ? 'w' : 'b') : null);
export const other = (c) => (c === 'w' ? 'b' : 'w');

export function parseFEN(fen) {
  const [place, turn, cr, ep] = fen.split(' ');
  const b = place.split('/').map((row) => {
    const out = [];
    for (const ch of row) { if (/\d/.test(ch)) for (let i = 0; i < +ch; i++) out.push(null); else out.push(ch); }
    return out;
  });
  return { b, turn, cr: cr === '-' ? '' : cr, ep: ep && ep !== '-' ? parseSquare(ep) : null };
}

export function cloneState(s) {
  return { b: s.b.map((r) => r.slice()), turn: s.turn, cr: s.cr, ep: s.ep ? { ...s.ep } : null };
}

const KN = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
const KG = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const ORTH = [[-1, 0], [1, 0], [0, -1], [0, 1]];

export function attacked(b, r, c, by) {
  // pawns
  if (by === 'w') { if ((inb(r + 1, c - 1) && b[r + 1][c - 1] === 'P') || (inb(r + 1, c + 1) && b[r + 1][c + 1] === 'P')) return true; }
  else { if ((inb(r - 1, c - 1) && b[r - 1][c - 1] === 'p') || (inb(r - 1, c + 1) && b[r - 1][c + 1] === 'p')) return true; }
  // knights
  for (const [dr, dc] of KN) { const rr = r + dr, cc = c + dc; if (inb(rr, cc)) { const p = b[rr][cc]; if (p && colorOf(p) === by && p.toLowerCase() === 'n') return true; } }
  // king
  for (const [dr, dc] of KG) { const rr = r + dr, cc = c + dc; if (inb(rr, cc)) { const p = b[rr][cc]; if (p && colorOf(p) === by && p.toLowerCase() === 'k') return true; } }
  // sliders
  const slide = (dirs, types) => {
    for (const [dr, dc] of dirs) {
      let rr = r + dr, cc = c + dc;
      while (inb(rr, cc)) {
        const p = b[rr][cc];
        if (p) { if (colorOf(p) === by && types.includes(p.toLowerCase())) return true; break; }
        rr += dr; cc += dc;
      }
    }
    return false;
  };
  if (slide(DIAG, ['b', 'q'])) return true;
  if (slide(ORTH, ['r', 'q'])) return true;
  return false;
}

export function findKing(b, color) {
  const k = color === 'w' ? 'K' : 'k';
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (b[r][c] === k) return { r, c };
  return null;
}

export function inCheck(s) { const k = findKing(s.b, s.turn); return k ? attacked(s.b, k.r, k.c, other(s.turn)) : false; }

export function genPseudo(s) {
  const { b, turn, ep } = s, moves = [];
  const add = (fr, fc, tr, tc, opt = {}) => moves.push({ from: [fr, fc], to: [tr, tc], piece: b[fr][fc], ...opt });
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = b[r][c]; if (!p || colorOf(p) !== turn) continue;
    const t = p.toLowerCase();
    if (t === 'p') {
      const dir = turn === 'w' ? -1 : 1, start = turn === 'w' ? 6 : 1, promoRow = turn === 'w' ? 0 : 7;
      const one = r + dir;
      if (inb(one, c) && !b[one][c]) {
        if (one === promoRow) for (const pr of ['q', 'r', 'b', 'n']) add(r, c, one, c, { promo: pr });
        else { add(r, c, one, c); if (r === start && !b[r + 2 * dir][c]) add(r, c, r + 2 * dir, c, { dbl: true }); }
      }
      for (const dc of [-1, 1]) {
        const cc = c + dc, rr = r + dir; if (!inb(rr, cc)) continue;
        const tp = b[rr][cc];
        if (tp && colorOf(tp) !== turn) { if (rr === promoRow) for (const pr of ['q', 'r', 'b', 'n']) add(r, c, rr, cc, { promo: pr, cap: true }); else add(r, c, rr, cc, { cap: true }); }
        else if (ep && ep.r === rr && ep.c === cc) add(r, c, rr, cc, { ep: true, cap: true });
      }
    } else if (t === 'n') {
      for (const [dr, dc] of KN) { const rr = r + dr, cc = c + dc; if (!inb(rr, cc)) continue; const tp = b[rr][cc]; if (!tp || colorOf(tp) !== turn) add(r, c, rr, cc, { cap: !!tp }); }
    } else if (t === 'k') {
      for (const [dr, dc] of KG) { const rr = r + dr, cc = c + dc; if (!inb(rr, cc)) continue; const tp = b[rr][cc]; if (!tp || colorOf(tp) !== turn) add(r, c, rr, cc, { cap: !!tp }); }
      // castling
      const rights = s.cr, row = turn === 'w' ? 7 : 0, opp = other(turn);
      const kSide = turn === 'w' ? 'K' : 'k', qSide = turn === 'w' ? 'Q' : 'q';
      if (rights.includes(kSide) && !b[row][5] && !b[row][6] &&
          !attacked(b, row, 4, opp) && !attacked(b, row, 5, opp) && !attacked(b, row, 6, opp))
        add(r, c, row, 6, { castle: 'K' });
      if (rights.includes(qSide) && !b[row][1] && !b[row][2] && !b[row][3] &&
          !attacked(b, row, 4, opp) && !attacked(b, row, 3, opp) && !attacked(b, row, 2, opp))
        add(r, c, row, 2, { castle: 'Q' });
    } else {
      const dirs = t === 'b' ? DIAG : t === 'r' ? ORTH : DIAG.concat(ORTH);
      for (const [dr, dc] of dirs) {
        let rr = r + dr, cc = c + dc;
        while (inb(rr, cc)) { const tp = b[rr][cc]; if (!tp) { add(r, c, rr, cc); } else { if (colorOf(tp) !== turn) add(r, c, rr, cc, { cap: true }); break; } rr += dr; cc += dc; }
      }
    }
  }
  return moves;
}

export function makeMove(s, m) {
  const n = cloneState(s);
  const [fr, fc] = m.from, [tr, tc] = m.to, p = n.b[fr][fc], color = colorOf(p);
  n.b[fr][fc] = null;
  if (m.ep) n.b[fr][tc] = null;                              // en-passant captured pawn
  let placed = p;
  if (m.promo) placed = color === 'w' ? m.promo.toUpperCase() : m.promo;
  n.b[tr][tc] = placed;
  if (m.castle) { const row = fr; if (m.castle === 'K') { n.b[row][5] = n.b[row][7]; n.b[row][7] = null; } else { n.b[row][3] = n.b[row][0]; n.b[row][0] = null; } }
  // castling rights
  let cr = n.cr;
  if (p === 'K') cr = cr.replace('K', '').replace('Q', '');
  if (p === 'k') cr = cr.replace('k', '').replace('q', '');
  const strip = (r, c) => {
    if (r === 7 && c === 0) cr = cr.replace('Q', ''); else if (r === 7 && c === 7) cr = cr.replace('K', '');
    else if (r === 0 && c === 0) cr = cr.replace('q', ''); else if (r === 0 && c === 7) cr = cr.replace('k', '');
  };
  if (p.toLowerCase() === 'r') strip(fr, fc);
  strip(tr, tc); // rook captured on home square
  n.cr = cr;
  n.ep = m.dbl ? { r: (fr + tr) / 2, c: fc } : null;
  n.turn = other(color);
  return n;
}

export function legalMoves(s) {
  const out = [];
  for (const m of genPseudo(s)) { const n = makeMove(s, m); const k = findKing(n.b, s.turn); if (k && !attacked(n.b, k.r, k.c, n.turn)) out.push(m); }
  return out;
}

export function toSAN(s, m, legal) {
  if (m.castle) { const san = m.castle === 'K' ? 'O-O' : 'O-O-O'; return san + checkSuffix(s, m); }
  const t = m.piece.toLowerCase(), dest = sqName(m.to[0], m.to[1]);
  let san;
  if (t === 'p') {
    san = m.cap ? FILES[m.from[1]] + 'x' + dest : dest;
    if (m.promo) san += '=' + m.promo.toUpperCase();
  } else {
    let dis = '';
    const peers = legal.filter((x) => x.piece === m.piece && x.to[0] === m.to[0] && x.to[1] === m.to[1] && !(x.from[0] === m.from[0] && x.from[1] === m.from[1]));
    if (peers.length) {
      const sameFile = peers.some((x) => x.from[1] === m.from[1]);
      const sameRank = peers.some((x) => x.from[0] === m.from[0]);
      dis = !sameFile ? FILES[m.from[1]] : !sameRank ? String(8 - m.from[0]) : sqName(m.from[0], m.from[1]);
    }
    san = m.piece.toUpperCase() + dis + (m.cap ? 'x' : '') + dest;
  }
  return san + checkSuffix(s, m);
}

export function checkSuffix(s, m) { const n = makeMove(s, m); if (!inCheck(n)) return ''; return legalMoves(n).length ? '+' : '#'; }

export function perft(s, depth) { if (depth === 0) return 1; let n = 0; for (const m of legalMoves(s)) n += perft(makeMove(s, m), depth - 1); return n; }
