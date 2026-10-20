import { drawable } from './fonts.mjs';
// Terminal surface: draws a VT cell grid (src/vt.mjs) through the same text/fill ops as everything
// else, so terminal output is selectable and copyable through the semantic text model (web/textsel.mjs)
// exactly like a note or a log. Names are prefixed tm* because the bundler shares one scope.
const TM_BASE = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5', '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'];
const TM_LIGHT = { 7: '#4b4a46', 15: '#1b1b1a', 3: '#8a6d00', 11: '#8a6d00', 10: '#0a7f55', 2: '#0a7f55', 14: '#08779a', 6: '#08779a', 0: '#1b1b1a', 8: '#6d6a64' };
const tmHex = h => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255, 1];
const TM_CUBE = [0, 95, 135, 175, 215, 255];

// xterm colour index -> [r,g,b,a]; >=256 is 24-bit (256 + rgb). null means "terminal default".
function tmColor(v, light) {
  if (v < 0) return null;
  if (v >= 256) { const n = v - 256; return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255, 1]; }
  if (v < 16) return tmHex(light && TM_LIGHT[v] ? TM_LIGHT[v] : TM_BASE[v]);
  if (v < 232) { const i = v - 16; return [TM_CUBE[Math.floor(i / 36)] / 255, TM_CUBE[Math.floor(i / 6) % 6] / 255, TM_CUBE[i % 6] / 255, 1]; }
  const g = (8 + (v - 232) * 10) / 255; return [g, g, g, 1];
}

const tmGlyph = ch => (ch >= ' ' && ch <= '~' ? ch : drawable(ch));

const TM_FONT = 13, TM_LH = 17;

// Draw the grid into rect r with helper set `c` (display-list drawing helpers). Returns the size in cells
// the rectangle can hold, so the owner can resize the VT and tell the PTY.
export function drawTerm(c, measure, T, r, term, { captured = false } = {}) {
  const cw = measure('MMMMMMMMMM', TM_FONT, 'mono', 400) / 10, cols = Math.max(10, Math.min(500, Math.floor(r.w / cw))), rows = Math.max(2, Math.min(200, Math.floor(r.h / TM_LH)));
  const vt = term.vt, light = T.name === 'light', view = vt.g === vt.main ? term.view : 0, lines = vt.viewRows(view);
  const defFg = T.ink, n = Math.min(cols, vt.cols);
  // pass 1: backgrounds and cursor under the glyphs
  const runs = [];
  lines.forEach((row, ry) => {
    const y = r.y + ry * TM_LH; if (y + TM_LH > r.y + r.h + 1) return;
    let j = 0;
    while (j < n) {
      const a = row[j]; let k = j + 1;
      while (k < n && row[k].fg === a.fg && row[k].bg === a.bg && row[k].fl === a.fl) k++;
      let fg = tmColor(a.fg, light), bg = tmColor(a.bg, light);
      if (a.fl & 16) { const f = fg || defFg; fg = bg || T.onAccent; bg = f; } // inverse: swap, default background reads as the dark accent colour
      if (bg) c.fill(r.x + j * cw, y, (k - j) * cw, TM_LH, bg);
      runs.push({ x: r.x + j * cw, y, row, j, k, fg: fg || defFg, bg, fl: a.fl });
      j = k;
    }
  });
  if (view === 0 && vt.cursorVisible && vt.y < rows && vt.x < cols) {
    const cx = r.x + vt.x * cw, cy = r.y + vt.y * TM_LH;
    if (captured) c.fill(cx, cy, cw, TM_LH, T.blue); else c.stroke(cx, cy, cw, TM_LH, T.dim, 1);
  }
  // pass 2: glyphs (and underline), tagged by the caller's surface so selection and copy work
  for (const u of runs) {
    let str = ''; for (let i = u.j; i < u.k; i++) str += tmGlyph(u.row[i].ch);
    if (!u.bg) str = str.replace(/\s+$/, ''); if (!str.trim() && !u.bg) continue;
    const fg = u.fl & 2 ? [u.fg[0], u.fg[1], u.fg[2], (u.fg[3] ?? 1) * 0.6] : u.fg;
    if (str.trim()) c.text(u.x, u.y + 1, str, TM_FONT, fg, { f: 'mono', w: u.fl & 1 ? 700 : 400, term: true });
    if (u.fl & 8 && str.trim()) c.fill(u.x, u.y + TM_LH - 2, str.length * cw, 1, fg);
  }
  return { cols, rows, x: r.x, y: r.y, cw, lh: TM_LH };
}
