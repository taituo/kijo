// Telemetry drawing. Pure functions over a `Store`: they emit fill/text ops through the same
// helpers the tiles use (`c.fill`, `c.text`), so the WebGPU and Canvas2D renderers need nothing new.
// Charts are column-rasterised: one thin rect per pixel column, which keeps the op count bounded
// by the pixel width, however many points the store holds.
import { baseName } from '../src/telemetry.mjs';

const tdClamp = (v, a, b) => Math.max(a, Math.min(b, v));
const tdAlpha = (c, a) => [c[0], c[1], c[2], (c[3] ?? 1) * a];
const tdMix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, 1];

export const WINDOWS = [60_000, 300_000, 900_000, 1_800_000];
export const windowLabel = ms => (ms < 120_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`);

export function fmtVal(v, unit = '') {
  if (v == null || !Number.isFinite(v)) return '-';
  const a = Math.abs(v);
  let s = a >= 1e9 ? (v / 1e9).toFixed(1) + 'G' : a >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : a >= 1e4 ? (v / 1e3).toFixed(1) + 'k' : a >= 100 ? String(Math.round(v)) : a >= 10 ? v.toFixed(1) : a === 0 ? '0' : v.toFixed(2);
  s = s.replace(/\.0+(?=[A-Za-z]|$)/, '').replace(/(\.\d*?)0+(?=[A-Za-z]|$)/, '$1');
  return unit === '%' ? s + '%' : unit && unit !== '1' ? s + ' ' + unit : s;
}
const tdClock = ts => { const d = new Date(ts); return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':'); };

// Threshold colour for percent-like series: calm blue, yellow from 80, red from 95.
export const levelColor = (T, v, unit) => (unit === '%' ? (v >= 95 ? T.red : v >= 80 ? T.yellow : T.blue) : T.blue);

function tdNice(v) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

// Value of a series at each pixel column; null where there is no data (gap or outside history).
function tdColumns(store, key, windowMs, now, cols) {
  const win = store.window(key, windowMs, now); if (!win) return null;
  const { ts, v, to } = win; let from = Math.max(0, win.from - 1);
  const out = new Array(cols).fill(null);
  if (to - from < 1) return { out, unit: win.unit, min: 0, max: 0, n: 0 };
  // Gap threshold: three times the typical spacing, never less than 2 s.
  const sp = []; for (let i = Math.max(from + 1, to - 40); i < to; i++) sp.push(ts[i] - ts[i - 1]); sp.sort((a, b) => a - b);
  const gap = Math.max(2000, (sp[sp.length >> 1] || 1000) * 3.5);
  const t0 = now - windowMs; let i = from, min = Infinity, max = -Infinity;
  for (let k = 0; k < cols; k++) {
    const t = t0 + ((k + 0.5) / cols) * windowMs;
    while (i + 1 < to && ts[i + 1] <= t) i++;
    if (ts[i] <= t && t - ts[i] <= gap && ts[i] >= t0 - gap) { out[k] = v[i]; if (v[i] < min) min = v[i]; if (v[i] > max) max = v[i]; }
  }
  return { out, unit: win.unit, min: Number.isFinite(min) ? min : 0, max: Number.isFinite(max) ? max : 0, n: to - from };
}

const TD_SERIES = T => [T.blue, T.yellow, T.ink];

// Time series chart. keys: one to three series keys. opts: { mini, title, windowMs }
export function drawChart(c, measure, T, r, store, keys, windowMs, now, opts = {}) {
  const { x, y, w, h } = r, mini = !!opts.mini;
  const cols = keys.map(k => tdColumns(store, k, windowMs, now, 1)).filter(Boolean); // cheap probe for presence/unit
  const unit = cols[0]?.unit ?? '';
  if (!keys.length || !store.series.has(keys[0])) {
    c.text(x, y, keys.length ? 'no data for ' + keys[0] : 'unbound', mini ? 10 : 12, T.dim, { max: w });
    return;
  }
  // Young history: zoom to what exists instead of drawing a sliver at the right edge.
  let first = Infinity; for (const k of keys) { const sr = store.series.get(k); if (sr?.ts.length) first = Math.min(first, sr.ts[Math.max(0, store.window(k, windowMs, now).from)]); }
  if (Number.isFinite(first) && now - first < windowMs * 0.8) windowMs = Math.min(windowMs, Math.max(20000, Math.ceil((now - first) * 1.08 / 5000) * 5000));
  const padL = mini ? 0 : Math.min(46, w * 0.18), padB = mini ? 0 : 16, padT = 0;
  const px = x + padL, pw = Math.max(8, w - padL), py = y + padT, ph = Math.max(8, h - padB - padT);
  const step = mini ? 3 : 2, n = Math.max(2, Math.floor(pw / step));
  const data = keys.slice(0, 3).map(k => tdColumns(store, k, windowMs, now, n)).filter(Boolean);
  let min = Infinity, max = -Infinity; for (const d of data) { if (d.n && d.min < min) min = d.min; if (d.n && d.max > max) max = d.max; }
  if (!Number.isFinite(min)) { min = 0; max = 1; }
  let lo, hi;
  if (unit === '%') { lo = Math.min(0, min); hi = Math.max(100, max); }
  else if (min >= 0 && min <= max * 0.6) { lo = 0; hi = tdNice(max); }
  else { const span = max - min || Math.abs(max) || 1; lo = min - span * 0.15; hi = max + span * 0.15; }
  const sy = v => py + ph - tdClamp((v - lo) / (hi - lo || 1), 0, 1) * ph;
  // grid
  if (!mini) {
    for (const f of [0, 0.5, 1]) {
      const gy = Math.round(py + ph - f * ph), val = lo + (hi - lo) * f;
      c.fill(px, Math.min(gy, py + ph - 1), pw, 1, tdAlpha(T.faint, f === 0 ? 1 : 0.7));
      c.text(x, tdClamp(gy - 6, py - 2, py + ph - 12), fmtVal(val, unit === '%' ? '%' : ''), 10, T.dim, { max: padL - 6 });
    }
    c.text(px, y + h - 12, '-' + windowLabel(windowMs), 10, T.dim);
    const nw = measure('now', 10); c.text(px + pw - nw, y + h - 12, 'now', 10, T.dim);
  } else c.fill(px, py + ph - 1, pw, 1, T.faint);
  const colors = TD_SERIES(T);
  data.forEach((d, si) => {
    let prev = null;
    for (let k = 0; k < n; k++) {
      const val = d.out[k]; if (val == null) { prev = null; continue; }
      const col = data.length === 1 ? levelColor(T, val, unit) : colors[si], cx = Math.round(px + (k / n) * pw), yy = Math.round(sy(val));
      if (data.length === 1) c.fill(cx, yy, step, py + ph - yy, tdAlpha(col, 0.16));
      const y0 = prev == null ? yy : Math.min(yy, prev), y1 = prev == null ? yy : Math.max(yy, prev);
      c.fill(cx, y0, step, Math.max(mini ? 1 : 2, y1 - y0 + (mini ? 1 : 2)), col);
      prev = yy;
    }
  });
  // legend + latest value
  if (!mini) {
    let lx = px + 4;
    keys.slice(0, 3).forEach((k, si) => {
      const lastv = store.last(k); if (!lastv) return;
      const txt = `${shortName(k)} ${fmtVal(lastv.v, store.series.get(k)?.unit)}`;
      if (data.length > 1) c.fill(lx, py + 5, 8, 8, colors[si], 2);
      lx += (data.length > 1 ? 12 : 0) + c.text(lx + (data.length > 1 ? 12 : 0), py + 3, txt, 11, data.length > 1 ? T.ink : T.dim, { max: pw - (lx - px) - 4 }) + 12;
    });
  }
}

// Height-field model for the 3D surface tile: rows = series, columns = time, values 0..1.
// Percent series use their natural 0..100 scale; everything else is min-max normalised per series,
// and the model says which, so the tile can state it instead of implying a shared axis.
export function surfaceModel(store, keys, windowMs, now, cols = 48) {
  let ks = keys.filter(k => store.series.has(k));
  if (!ks.length) {
    const names = store.names(), cores = names.filter(n => n.startsWith('cpu.core_pct{')), pct = names.filter(n => store.series.get(n).unit === '%' && !n.startsWith('cpu.core_pct{'));
    ks = (cores.length >= 2 ? cores : cores.concat(pct)).slice(0, 16);
    if (!ks.length) ks = names.filter(n => !n.startsWith('kijod.')).slice(0, 10);
  }
  const vals = new Float32Array(ks.length * cols); let allPct = true;
  ks.forEach((k, r) => {
    const col = tdColumns(store, k, windowMs, now, cols), unit = store.series.get(k).unit; if (unit !== '%') allPct = false;
    if (!col) return;
    let prev = null, lo = Infinity, hi = -Infinity; for (const v of col.out) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    for (let i = 0; i < cols; i++) { const v = col.out[i] ?? prev; prev = v; vals[r * cols + i] = v == null ? 0 : unit === '%' ? v / 100 : (v - lo) / (hi - lo || 1); }
  });
  return { keys: ks, rows: ks.length, cols, vals, norm: ks.length && allPct ? 'percent 0-100' : 'per-series min-max' };
}

export const shortName = key => key.replace(/\{.*\}$/, '');

// Compact sparkline + big number, for overview cells.
export function drawSpark(c, measure, T, r, store, key, windowMs, now) {
  const { x, y, w, h } = r; const last = key && store.last(key);
  if (!last) return;
  const unit = store.series.get(key).unit;
  if (h > 34) drawChart(c, measure, T, { x, y: y + 16, w, h: h - 16 }, store, [key], windowMs, now, { mini: true });
  c.text(x, y, fmtVal(last.v, unit), h > 34 ? 13 : 11, levelColor(T, last.v, unit) === T.blue ? T.ink : levelColor(T, last.v, unit), { w: 600, max: w });
}

// ------------------------------------------------------------------ logs
const TD_LEVEL = (T, l) => (l === 'error' ? T.red : l === 'warn' ? T.yellow : l === 'debug' ? T.faint : T.dim);
// Log filter: space-separated terms, all must match (case-insensitive) against "level src body"; -term excludes;
// `level:warn` (or `>warn`) sets a minimum level. Pure, so the tile, the tests and "copy logs" share one definition.
const TD_LEVELS = ['debug', 'info', 'warn', 'error'];
export function parseLogFilter(q) {
  const f = { terms: [], not: [], min: 0 };
  for (const raw of String(q || '').toLowerCase().split(/\s+/).filter(Boolean)) {
    const lv = raw.match(/^(?:level:|>=?)(debug|info|warn|error)$/);
    if (lv) f.min = TD_LEVELS.indexOf(lv[1]); else if (raw[0] === '-' && raw.length > 1) f.not.push(raw.slice(1)); else f.terms.push(raw);
  }
  return f;
}
export function filterLogs(logs, q) {
  const f = typeof q === 'object' && q ? q : parseLogFilter(q);
  if (!f.terms.length && !f.not.length && !f.min) return logs;
  return logs.filter(l => {
    if (TD_LEVELS.indexOf(l.level) < f.min) return false;
    const hay = (l.level + ' ' + (l.src || '') + ' ' + l.body).toLowerCase();
    return f.terms.every(t => hay.includes(t)) && !f.not.some(t => hay.includes(t));
  });
}
export const formatLogLine = l => `${tdClock(l.ts)} ${l.level === 'info' ? '    ' : l.level.toUpperCase().slice(0, 4).padEnd(4)} ${l.body}`;

// opts: mini, off (rows scrolled back from the newest), q (filter). Returns { total, shown, rows, off } for the header and scroll anchoring.
export function drawLogs(c, measure, T, r, store, now, opts = {}) {
  const { x, y, w, h } = r, rowH = opts.mini ? 14 : 17, size = opts.mini ? 10 : 11, rows = Math.max(1, Math.floor(h / rowH));
  const filt = parseLogFilter(opts.q), all = filterLogs(store.logs, filt), total = store.logs.length;
  const off = Math.max(0, Math.min(opts.off || 0, Math.max(0, all.length - rows))), end = all.length - off, list = all.slice(Math.max(0, end - rows), end);
  const info = { total, shown: all.length, rows, off };
  if (!list.length) {
    if (total && all.length === 0) { c.text(x, y, 'no log line matches', 12, T.dim, { max: w }); c.text(x, y + 18, `${total} lines hidden by the filter; Esc clears it`, 11, T.dim, { max: w }); }
    else { c.text(x, y, 'no logs yet', 12, T.dim, { max: w }); c.text(x, y + 18, 'inject:  {"t":"log","level":"warn","body":"..."}', 11, T.dim, { max: w }); }
    return info;
  }
  const top = y + h - list.length * rowH, tw = measure('00:00:00 ', size);
  list.forEach((l, i) => {
    const yy = top + i * rowH, col = TD_LEVEL(T, l.level);
    c.fill(x, yy + 1, 2, rowH - 3, col);
    let cx = x + 8;
    if (!opts.mini) { c.text(cx, yy, tdClock(l.ts), size, T.dim); cx += tw; }
    const tag = l.level === 'info' ? '' : l.level.toUpperCase().slice(0, 4) + ' ';
    if (tag) cx += c.text(cx, yy, tag, size, l.level === 'debug' ? T.dim : col, { w: 700 });
    if (!opts.mini) for (const t of filt.terms) { // highlight matches in the body, under the glyphs
      const lo = l.body.toLowerCase(); let k = lo.indexOf(t);
      while (k >= 0 && k < 200) { const hx = cx + measure(l.body.slice(0, k), size), hw = measure(t, size); if (hx + hw <= x + w) c.fill(hx, yy, hw, rowH - 2, T.yellow.slice(0, 3).concat(0.32)); k = lo.indexOf(t, k + t.length); }
    }
    c.text(cx, yy, l.body, size, l.level === 'error' ? T.ink : tdAlpha(T.ink, l.level === 'debug' ? 0.55 : 0.9), { max: x + w - cx });
  });
  return info;
}

// ------------------------------------------------------------------ traces
export function recentTraces(store, count) {
  const roots = [];
  for (let i = store.spans.length - 1; i >= 0 && roots.length < count; i--) if (!store.spans[i].parent) roots.push(store.spans[i]);
  return roots.reverse();
}
export function drawTraces(c, measure, T, r, store, now, opts = {}) {
  const { x, y, w, h } = r; const mini = !!opts.mini;
  const roots = recentTraces(store, Math.max(8, Math.floor(w / 6)));
  if (!roots.length) { c.text(x, y, 'no spans yet', 12, T.dim, { max: w }); c.text(x, y + 18, 'POST /v1/traces (OTLP JSON) or {"t":"span",...}', 11, T.dim, { max: w }); return; }
  // top strip: recent request durations, error in red
  const stripH = mini ? Math.min(h, 40) : Math.min(Math.max(26, h * 0.28), 90);
  const maxDur = Math.max(1, ...roots.map(s => s.dur)), bw = Math.max(2, Math.min(8, Math.floor(w / roots.length) - 1));
  roots.forEach((s, i) => {
    const bh = Math.max(2, Math.round((s.dur / maxDur) * (stripH - 4))), bx = x + w - (roots.length - i) * (bw + 1);
    if (bx >= x) c.fill(bx, y + stripH - bh, bw, bh, s.status === 'error' ? T.red : T.blue);
  });
  c.fill(x, y + stripH, w, 1, T.faint);
  if (!mini) c.text(x, y, `${roots.length} recent   max ${fmtVal(maxDur, 'ms')}`, 10, T.dim, { max: w });
  if (mini || h < stripH + 40) return;
  // waterfall of the latest trace
  const root = roots[roots.length - 1], spans = [];
  for (let i = store.spans.length - 1; i >= 0 && spans.length < 40; i--) if (store.spans[i].trace === root.trace) spans.push(store.spans[i]);
  spans.sort((a, b) => a.start - b.start);
  const t0 = Math.min(...spans.map(s => s.start)), t1 = Math.max(root.start + root.dur, ...spans.map(s => s.start + s.dur)), span = Math.max(1, t1 - t0);
  const wy = y + stripH + 10, rowH = 17, rows = Math.max(1, Math.floor((y + h - wy - 14) / rowH)), labelW = Math.min(w * 0.38, 190);
  c.text(x, wy - 1, `trace ${String(root.trace).slice(0, 8)}   ${fmtVal(root.dur, 'ms')}`, 10, T.dim, { max: w });
  spans.slice(0, rows).forEach((s, i) => {
    const yy = wy + 14 + i * rowH, depth = s.parent ? 1 : 0, bx = x + labelW + ((s.start - t0) / span) * (w - labelW - 4), bw2 = Math.max(2, (s.dur / span) * (w - labelW - 4));
    c.text(x + depth * 10, yy, s.name, 11, s.parent ? T.dim : T.ink, { max: labelW - 14 - depth * 10, w: s.parent ? 400 : 600 });
    c.fill(bx, yy + 2, bw2, 9, s.status === 'error' ? T.red : s.parent ? tdMix(T.blue, T.ink, 0.25) : T.blue, 2);
    if (bw2 > 40) c.text(bx + 4, yy, fmtVal(s.dur, 'ms'), 10, T.onAccent, { max: bw2 - 6 });
  });
}

// ------------------------------------------------------------------ system (neofetch + htop)
function tdSegBar(c, T, x, y, w, h, pct, label, valueText, measure) {
  const cell = 4, n = Math.max(4, Math.floor(w / cell)), on = Math.round(tdClamp(pct, 0, 100) / 100 * n), col = pct >= 95 ? T.red : pct >= 80 ? T.yellow : T.blue;
  for (let i = 0; i < n; i++) c.fill(x + i * cell, y, cell - 1, h, i < on ? col : T.faint);
  if (label) c.text(x - measure(label + ' ', 11) , y - 1, label, 11, T.dim);
  if (valueText) c.text(x + w + 6, y - 1, valueText, 11, T.ink, { w: 600 });
}

export function drawSys(c, measure, T, r, store, now, opts = {}) {
  const { x, y, w, h } = r, mini = !!opts.mini, f = k => store.facts.get(k);
  const has = store.series.has('cpu.util_pct');
  const cores = store.names().filter(n => n.startsWith('cpu.core_pct{')).sort((a, b) => parseInt(a.match(/"(\d+)"/)?.[1] ?? 0) - parseInt(b.match(/"(\d+)"/)?.[1] ?? 0));
  const wide = w >= 560 && !mini;
  let cx = x, colW = w;
  if (wide) {
    // neofetch column: logo blocks + facts + palette strip
    const lw = Math.min(250, w * 0.42); colW = w - lw - 20;
    const logo = [T.red, T.yellow, T.blue]; logo.forEach((col, i) => c.fill(x, y + i * 22, 62 - i * 14, 18, col));
    c.text(x + 78, y + 2, has ? (f('host') || 'host') : 'this browser', 15, T.ink, { f: 'sans', w: 700, max: lw - 78 });
    c.text(x + 78, y + 24, has ? 'via kijod' : 'no relay connected', 11, T.dim, { max: lw - 78 });
    const rows = has
      ? [['os', f('os')], ['arch', f('arch')], ['cpu', f('cpu')], ['cores', f('cores')], ['mem', f('mem_total_mb') && f('mem_total_mb') + ' MB'], ['uptime', store.last('sys.uptime_s') && tdUptime(store.last('sys.uptime_s').v)], ['kijod', f('kijod')]]
      : [['agent', f('browser.agent')], ['cores', f('browser.cores')], ['memory', f('browser.memory_gb') && f('browser.memory_gb') + ' GB'], ['screen', f('browser.screen')], ['gpu', f('browser.gpu')], ['tz', f('browser.tz')]];
    let ry = y + 72;
    for (const [k, v] of rows) { if (!v || ry + 16 > y + h - 24) continue; c.text(x, ry, k, 11, T.blue, { w: 700 }); c.text(x + 64, ry, String(v), 11, T.ink, { max: lw - 64 }); ry += 16; }
    const pal = [T.red, T.yellow, T.blue, T.ink, T.dim, T.line, T.faint, T.bg]; pal.forEach((col, i) => c.fill(x + i * 22, y + h - 18, 20, 12, col));
    cx = x + lw + 20;
  }
  // htop column
  let ry = y;
  const bar = (label, pct, text) => { if (ry + 14 > y + h) return; tdSegBar(c, T, cx + 34, ry + 2, colW - 34 - 64, 10, pct, '', text, measure); c.text(cx, ry, label, 11, T.dim, { max: 32 }); ry += 17; };
  if (has) {
    const u = store.last('cpu.util_pct').v;
    bar('cpu', u, u.toFixed(0) + '%');
    const reserve = mini ? 2 : 4; // rows kept for mem / load / net
    const room = Math.max(0, Math.floor((y + h - ry) / 17) - reserve), cc = cores.length > room ? cores.slice(0, Math.max(0, room)) : cores;
    for (const k of cc) { const l = store.last(k); if (l) bar(k.match(/"(.*)"/)?.[1] ?? '', l.v, l.v.toFixed(0) + '%'); }
    const m = store.last('mem.used_pct'); if (m) bar('mem', m.v, m.v.toFixed(0) + '%');
    const ld = store.last('cpu.load1'); if (ld && ry + 14 <= y + h) { c.text(cx, ry, 'load', 11, T.dim); c.text(cx + 34, ry, ld.v.toFixed(2), 11, T.ink, { w: 600 }); ry += 17; }
    const rx = store.last('net.rx_kbps'), tx = store.last('net.tx_kbps');
    if (rx && ry + 14 <= y + h) { c.text(cx, ry, 'net', 11, T.dim); c.text(cx + 34, ry, `rx ${fmtVal(rx.v, 'kb/s')}   tx ${fmtVal(tx?.v, 'kb/s')}`, 11, T.ink, { w: 600, max: colW - 34 }); ry += 17; }
    // A live history strip under the bars: the same store, the same chart code.
    if (!mini && y + h - ry > 70) { c.text(cx, ry + 6, 'cpu history', 10, T.dim); drawChart(c, measure, T, { x: cx, y: ry + 22, w: colW, h: Math.min(150, y + h - ry - 30) }, store, ['cpu.util_pct'], opts.windowMs || 300000, now, { mini: true }); }
  } else {
    // No host source: show the page itself, which is real, and say how to get the host.
    const pairs = [['fps', 'browser.fps', 60], ['draw', 'browser.draw_ms', 16], ['lag', 'browser.loop_lag_ms', 50], ['heap', 'browser.heap_mb', null]];
    for (const [lb, k, scale] of pairs) { const l = store.last(k); if (l) bar(lb, scale ? tdClamp(lb === 'fps' ? l.v / scale * 100 : l.v / scale * 100, 0, 100) : 30, fmtVal(l.v, store.series.get(k).unit)); }
    if (ry + 28 <= y + h) {
      c.text(cx, ry + 6, 'host metrics need a relay:', 11, T.dim, { max: colW });
      c.text(cx, ry + 22, 'ssh host node --input-type=module - < kijod.mjs', 10, T.dim, { max: colW });
    }
  }
}
const tdUptime = s => { const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d}d ${hh}h` : hh ? `${hh}h ${m}m` : `${m}m`; };

// ------------------------------------------------------------------ flow: injectors -> series -> tiles
// Layout is a pure function of the store and the tile bindings, so tests can check it without drawing.
export function flowModel(store, tiles, bindings, now) {
  const sources = [...store.sources.values()].map(s => ({ name: s.name, via: s.via, rate: store.rate(s.name, now), age: now - s.last, count: s.count, types: [...s.types], series: [...s.series] }))
    .sort((a, b) => b.rate - a.rate || a.name.localeCompare(b.name));
  const groups = new Map();
  for (const [key, s] of store.series) {
    const g = groups.get(s.name) || { name: s.name, keys: [], unit: s.unit, srcs: new Set() }; g.keys.push(key); groups.set(s.name, g);
  }
  for (const s of sources) for (const k of s.series) { const g = groups.get(baseName(k)); if (g) g.srcs.add(s.name); }
  const list = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  // logs and spans are not series, but they are data paths too: show them as their own rows
  const pseudo = (name, label, n, type) => { if (n) list.push({ name, label, keys: [], unit: '', count: n, pseudo: true, srcs: new Set(sources.filter(s => s.types.includes(type)).map(s => s.name)) }); };
  pseudo('@logs', 'logs', store.logs.length, 'log'); pseudo('@spans', 'spans', store.spans.length, 'span');
  const sinks = tiles.filter(t => t.kind === 1 && t.app >= 7).map(t => ({ id: t.id, app: t.app, ws: t.ws, bound: [].concat(bindings?.[t.id] ?? []).map(baseName) }));
  return { sources, groups: list, sinks };
}

export function drawFlow(c, g, measure, T, r, store, tiles, bindings, now, time, hits, pinned) {
  const { x, y, w, h } = r, model = flowModel(store, tiles, bindings, now);
  const colW = tdClamp(w * 0.26, 150, 280), rowH = 26, maxRows = Math.max(3, Math.floor((h - 28) / rowH));
  const xs = x, xg = x + (w - colW) / 2, xt = x + w - colW;
  const head = (cx, t, n) => { c.text(cx, y, t, 11, T.ink, { w: 700 }); c.text(cx + measure(t + '  ', 11, 'mono', 700), y, String(n), 11, T.dim); };
  head(xs, 'INJECTORS', model.sources.length); head(xg, 'SERIES', model.groups.length); head(xt, 'TILES', model.sinks.length);
  const top = y + 24, pos = (i, n) => top + i * rowH + 11;
  const srcRows = model.sources.slice(0, maxRows), grpRows = model.groups.slice(0, maxRows), sinkRows = model.sinks.slice(0, maxRows);
  const sy = new Map(srcRows.map((s, i) => [s.name, pos(i)])), gy = new Map(grpRows.map((s, i) => [s.name, pos(i)]));
  const cable = (x0, y0, x1, y1, col, active, seed) => {
    const mx = Math.round(Math.min(x1 - 8, x0 + 12 + seed * Math.max(4, Math.min(11, (x1 - x0 - 24) / 14))));
    g.fill(x0, Math.round(y0), mx - x0, 1, col); g.fill(mx, Math.min(Math.round(y0), Math.round(y1)), 1, Math.abs(Math.round(y1) - Math.round(y0)) + 1, col); g.fill(mx, Math.round(y1), x1 - mx, 1, col);
    if (active) { // a packet travels along the cable: motion here means data really arrived recently
      const L = (mx - x0) + Math.abs(y1 - y0) + (x1 - mx), p = (time * 70 + seed * 37) % (L + 30);
      let d = p, px = x0, py = y0;
      if (d <= mx - x0) px = x0 + d; else { d -= mx - x0; px = mx; if (d <= Math.abs(y1 - y0)) py = y0 + Math.sign(y1 - y0) * d; else { py = y1; px = mx + (d - Math.abs(y1 - y0)); } }
      if (px <= x1) g.fill(Math.round(px) - 2, Math.round(py) - 2, 5, 5, T.yellow, 1);
    }
  };
  // cables first, so rows sit on top
  srcRows.forEach((s, i) => { for (const gr of grpRows) if (gr.srcs.has(s.name)) cable(xs + colW, pos(i), xg, gy.get(gr.name), s.age < 15000 ? tdAlpha(T.blue, 0.55) : T.faint, s.age < 6000 && s.rate > 0, i); });
  sinkRows.forEach((s, i) => {
    const names = s.app === 8 ? s.bound : s.app === 9 ? ['@logs'] : s.app === 10 ? ['@spans'] : ['cpu.util_pct', 'mem.used_pct', 'cpu.load1', 'cpu.core_pct'];
    for (const gr of grpRows) if (names.includes(gr.name)) cable(xg + colW, gy.get(gr.name), xt, pos(i), tdAlpha(T.blue, 0.55), (gr.pseudo ? (gr.name === '@logs' ? store.logs.at(-1)?.ts : store.spans.at(-1)?.start) ?? 0 : store.last(gr.keys[0])?.ts ?? 0) > now - 6000, i);
  });
  srcRows.forEach((s, i) => {
    const yy = top + i * rowH, live = s.age < 6000;
    g.fill(xs, yy, colW, rowH - 4, T.panel, 4); g.fill(xs, yy, 3, rowH - 4, live ? T.blue : T.faint);
    c.text(xs + 10, yy + 4, s.name, 12, T.ink, { w: 600, max: colW * 0.55 });
    c.text(xs + colW - 6 - measure(`${s.rate.toFixed(1)}/s`, 11), yy + 5, `${s.rate.toFixed(1)}/s`, 11, live ? T.ink : T.dim);
    c.text(xs + 10 + Math.min(colW * 0.55, measure(s.name, 12, 'mono', 600)) + 8, yy + 5, s.via || '', 10, T.dim, { max: colW * 0.2 });
  });
  grpRows.forEach((gr, i) => {
    const yy = top + i * rowH, on = pinned?.has(gr.name);
    g.fill(xg, yy, colW, rowH - 4, on ? tdMix(T.panel, T.blue, 0.25) : T.raised, 4); g.stroke(xg, yy, colW, rowH - 4, on ? T.blue : T.faint, 1, 4);
    const last = store.last(gr.keys[0]);
    c.text(xg + 8, yy + 4, (gr.label || gr.name) + (gr.keys.length > 1 ? ` x${gr.keys.length}` : ''), 12, gr.pseudo ? T.dim : T.ink, { max: colW - 80 });
    if (gr.pseudo) c.text(xg + colW - 6 - measure(String(gr.count), 11), yy + 5, String(gr.count), 11, T.dim);
    else if (last) c.text(xg + colW - 6 - measure(fmtVal(last.v, gr.unit), 11), yy + 5, fmtVal(last.v, gr.unit), 11, T.dim);
    if (!gr.pseudo) hits.push({ kind: 'series', name: gr.name, key: gr.keys[0], x: xg, y: yy, w: colW, h: rowH - 4 });
  });
  sinkRows.forEach((s, i) => {
    const yy = top + i * rowH, nm = s.app === 8 ? 'chart' : s.app === 9 ? 'logs' : s.app === 10 ? 'traces' : 'system';
    g.fill(xt, yy, colW, rowH - 4, T.panel, 4); g.fill(xt + colW - 3, yy, 3, rowH - 4, T.ink);
    c.text(xt + 8, yy + 4, `${nm} #${s.id}`, 12, T.ink, { w: 600 });
    c.text(xt + 8 + measure(`${nm} #${s.id}  `, 12, 'mono', 600), yy + 5, `ws ${s.ws + 1}`, 10, T.dim);
    hits.push({ kind: 'tile-id', id: s.id, ws: s.ws, x: xt, y: yy, w: colW, h: rowH - 4 });
  });
  const more = (model.sources.length - srcRows.length) + (model.groups.length - grpRows.length);
  if (more > 0) c.text(x, y + h - 14, `+${more} more not shown - widen the window`, 10, T.dim);
  if (!model.sources.length) c.text(xs, top, 'nothing injected yet', 12, T.dim);
  return model;
}
