// Semantic text selection over a display list. The renderer draws glyphs; this module is the text
// model that makes them selectable and copyable, so selection never depends on how pixels are drawn
// (WebGPU, Canvas2D, a future native host all share it). Pure functions, no DOM.
//
// A "surface" is a tile (or any group) whose text ops carry the same `surf` id. Selection is linear in
// reading order inside one surface: lines top to bottom, runs left to right.

const LINE_TOL = 0.55; // runs whose y differs by less than this * size share a line

export function surfaceLines(cmds, surf) {
  const runs = []; for (const k of cmds) if (k.op === 'text' && k.surf === surf && k.str) runs.push(k);
  runs.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const r of runs) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(r.y - last.y) < Math.max(r.s, 8) * LINE_TOL) { last.runs.push(r); last.y = Math.min(last.y, r.y); } else lines.push({ y: r.y, size: r.s, runs: [r] });
  }
  for (const l of lines) { l.runs.sort((a, b) => a.x - b.x); l.size = Math.max(...l.runs.map(r => r.s)); }
  return lines;
}

// (x, y) -> { line, col } where col is a character index into the joined line text.
function locate(lines, x, y, m) {
  if (!lines.length) return null;
  let li = 0, best = Infinity;
  lines.forEach((l, i) => { const d = y < l.y ? l.y - y : y > l.y + l.size * 1.3 ? y - l.y - l.size * 1.3 : 0; if (d < best) { best = d; li = i; } });
  const L = lines[li]; let col = 0, picked = null;
  for (const r of L.runs) {
    if (x >= r.x) { picked = r; col = 0; }
    else break;
  }
  const joined = joinLine(L, m);
  if (!picked) return { line: li, col: 0, joined };
  const w = m(picked.str, picked.s, picked.f, picked.w), off = joined.starts.get(picked);
  if (x >= picked.x + w) return { line: li, col: off + picked.str.length, joined, past: true };
  let c = 0; while (c < picked.str.length && picked.x + m(picked.str.slice(0, c + 1), picked.s, picked.f, picked.w) - m(picked.str[c], picked.s, picked.f, picked.w) / 2 < x) c++;
  return { line: li, col: off + c, joined };
}

// Join runs of one line; the gap between runs becomes spaces (columns survive in a paste).
function joinLine(L, m) {
  let text = '', prevEnd = null; const starts = new Map();
  for (const r of L.runs) {
    if (prevEnd != null) { const cw = Math.max(1, m('M', r.s, r.f, r.w)), gap = Math.round((r.x - prevEnd) / cw); text += ' '.repeat(r.term ? Math.max(0, Math.min(500, gap)) : Math.max(1, Math.min(8, gap))); }
    starts.set(r, text.length); text += r.str; prevEnd = r.x + m(r.str, r.s, r.f, r.w);
  }
  return { text, starts };
}
const xAt = (L, joined, col, m) => { // x position of character index `col` within the line
  let best = L.runs[0].x;
  for (const r of L.runs) { const o = joined.starts.get(r); if (col >= o) best = r.x + m(r.str.slice(0, Math.min(col - o, r.str.length)), r.s, r.f, r.w); else break; }
  return best;
};

// sel: { surf, ax, ay, bx, by } or { surf, all: true }. Returns { text, rects } (empty when nothing selected).
export function selection(cmds, sel, m) {
  if (!sel) return { text: '', rects: [] };
  const lines = surfaceLines(cmds, sel.surf); if (!lines.length) return { text: '', rects: [] };
  let a, b;
  if (sel.all) { a = { line: 0, col: 0 }; const last = lines[lines.length - 1], j = joinLine(last, m); b = { line: lines.length - 1, col: j.text.length }; }
  else {
    a = locate(lines, sel.ax, sel.ay, m); b = locate(lines, sel.bx, sel.by, m);
    if (!a || !b) return { text: '', rects: [] };
    if (a.line > b.line || (a.line === b.line && a.col > b.col)) [a, b] = [b, a];
  }
  const out = [], rects = [];
  for (let i = a.line; i <= b.line; i++) {
    const L = lines[i], j = joinLine(L, m), from = i === a.line ? a.col : 0, to = i === b.line ? b.col : j.text.length;
    if (to <= from && i !== a.line) { out.push(''); continue; }
    if (to > from) { out.push(j.text.slice(from, to).replace(/\s+$/, '')); const x0 = xAt(L, j, from, m), x1 = xAt(L, j, to, m); rects.push({ x: x0, y: L.y - 1, w: Math.max(2, x1 - x0), h: L.size * 1.25 + 2 }); }
    else out.push('');
  }
  return { text: out.join('\n'), rects };
}
