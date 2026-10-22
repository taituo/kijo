// Scene graph -> display list. Pure function: no DOM, no GPU.
// Positions come from WASM nodes (0..SCALE); this file maps them to CSS pixels, animates
// them, and decides glyphs/colors. It never invents occupancy, selection or status.
//
// Visual language: Bauhaus wireframe, but built like an OS shell: a layer bar with an exclusive
// zone, workspace pills with attention marks, proportional type for titles, mono for data,
// tokens for radius/gap so theming later changes values, not code.
import { NODE, FLAG, STATUS, BLOCKED_KIND, APP, SCALE, EVENT, KIND, Q16, LINK_KIND, getScene, getTiles, getEvents, getCanvasNodes, label, tag, selectedTile, selectedNode } from '../src/core.mjs';
import { toWorld, toScreen, canvasBounds } from '../src/canvas.mjs';
import { drawStat, drawGauge, drawBars, drawStatus, drawChart, drawSpark, drawLogs, drawTraces, drawSys, drawFlow, surfaceModel, fmtVal, windowLabel, shortName } from './telemetry-draw.mjs';
import { baseName } from '../src/telemetry.mjs';
import { selection } from './textsel.mjs';
import { drawable } from './fonts.mjs';
import { drawTerm } from './terminal.mjs';

const rgb = h => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255, 1];
const base = { radius: 6, gap: 10, bar: 38, hint: 28 };
export const THEMES = {
  dark: { ...base, name: 'dark', bg: rgb('#0e0e0d'), barBg: rgb('#141413'), panel: rgb('#171715'), raised: rgb('#1e1e1c'), ink: rgb('#ebe8e2'), dim: rgb('#8a8780'),
    faint: rgb('#2a2a27'), line: rgb('#46453f'), green: rgb('#5fbf6a'), red: rgb('#e5513c'), yellow: rgb('#f2c21b'), blue: rgb('#4b7bff'), onAccent: rgb('#0e0e0d'), scrim: [0, 0, 0, 0.6] },
  light: { ...base, name: 'light', bg: rgb('#f1efea'), barBg: rgb('#e9e6df'), panel: rgb('#fbfaf7'), raised: rgb('#ffffff'), ink: rgb('#141413'), dim: rgb('#6d6a64'),
    faint: rgb('#dcd9d2'), line: rgb('#a8a59d'), green: rgb('#1f8a3a'), red: rgb('#c4321f'), yellow: rgb('#e0ad00'), blue: rgb('#2350d4'), onAccent: rgb('#fbfaf7'), scrim: [0.1, 0.1, 0.09, 0.45] },
};
export const WALLPAPERS = [{ name: 'aurora', hue: 0, seed: 0 }, { name: 'saffron', hue: 2.5, seed: 1 }, { name: 'lagoon', hue: -1.2, seed: 2 }, { name: 'orchid', hue: 0.9, seed: 3 }, { name: 'meadow', hue: -2.3, seed: 4 }];
const white = [1, 1, 1, 1];
// "glass": translucent panels over a procedural wallpaper (shader modes 4 and 5). Tokens keep the same
// names as the other themes; panel/raised are markers that the helpers turn into glass.
THEMES.glass = { ...base, name: 'glass', glass: true, radius: 16, gap: 14, bar: 46, wall: { hue: 0, seed: 0 },
  bg: rgb('#0a0c24'), barBg: white, panel: white, raised: [1, 1, 1, 1], ink: [1, 1, 1, 1], dim: [1, 1, 1, 0.66], faint: [1, 1, 1, 0.16], line: [1, 1, 1, 0.40],
  green: rgb('#7ee0a0'), red: rgb('#ff6b5e'), yellow: rgb('#ffd25a'), blue: rgb('#7db2ff'), onAccent: rgb('#0b1030'), scrim: [0.02, 0.02, 0.08, 0.45] };
export const A = (c, a) => (a === 1 ? c : [c[0], c[1], c[2], (c[3] ?? 1) * a]);
export const statusColor = (T, s) => [T.dim, T.blue, T.yellow, T.red, T.ink][s] ?? T.dim;
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, 1];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Frame-rate independent exponential smoothing keyed by slot. Tiles that exist in two views
// (focus <-> overview) glide between their rectangles: the zoom IS the transition.
export class Anim {
  constructor() { this.cur = new Map(); this.seen = new Set(); this.k = 16; this.moving = false; }
  begin() { this.seen = new Set(); this.moving = false; }
  rect(key, t, dt) {
    let c = this.cur.get(key);
    if (!c) { c = { ...t, a: dt >= 1 ? 1 : 0 }; this.cur.set(key, c); }
    else {
      const f = 1 - Math.exp(-Math.min(dt, 1) * this.k);
      c.x += (t.x - c.x) * f; c.y += (t.y - c.y) * f; c.w += (t.w - c.w) * f; c.h += (t.h - c.h) * f;
      c.a = Math.min(1, c.a + Math.min(dt, 1) * 7);
    }
    const off = Math.abs(c.x - t.x) + Math.abs(c.y - t.y) + Math.abs(c.w - t.w) + Math.abs(c.h - t.h);
    if (off < 0.5) { c.x = t.x; c.y = t.y; c.w = t.w; c.h = t.h; } else this.moving = true;
    if (c.a < 1) this.moving = true;
    this.seen.add(key);
    return { x: c.x, y: c.y, w: c.w, h: c.h, a: c.a, off, settle: clamp(1 - off / 90, 0, 1) };
  }
  end() { for (const k of [...this.cur.keys()]) if (!this.seen.has(k)) this.cur.delete(k); }
}

const ago = ms => (ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`);

// st:  { view, ghosts, notes, events, editing:{id,text}|null, palette:{q,items,sel}|null, message }
// env: { width, height, time, dt, theme, backend, clock, date, metrics, measure(str,size,font,weight), anim, dpr }
export function buildDisplayList(api, st, env) {
  const termSizes = {}, logInfo = {};
  let curSurf = 0; // text drawn while this is set belongs to one selectable surface (a tile)
  const T = env.theme, cmds = [], hits = [], dt = env.dt ?? 1 / 60, W = env.width, H = env.height;
  const anim = env.anim || new Anim(); anim.begin();
  const measure = (s, size, f = 'mono', w = 400) => env.measure(s, size, f, w);
  const compact = W < 700;

  // Drawing helpers carry an alpha so a tile can fade as one unit.
  const mk = (al = 1) => {
    const o = {
      glass: (x, y, w, h, c = white, r = 0, k = 0.1, m = 26) => cmds.push({ op: 'glass', x, y, w, h, c: A(c, al), r, k, m }),
      fill: (x, y, w, h, c, r = 0) => (T.glass && (c === T.panel || c === T.raised) ? cmds.push({ op: 'glass', x, y, w, h, c: A(white, al * (c === T.raised ? 0.97 : 1)), r: r || 8, k: c === T.raised ? 0.18 : 0.1, m: Math.min(26, Math.max(6, Math.round(Math.min(w, h) * 0.3))) }) : cmds.push({ op: 'fill', x, y, w, h, c: A(c, al), r })),
      stroke: (x, y, w, h, c, t = 1, r = 0) => cmds.push({ op: 'stroke', x, y, w, h, c: A(c, al), t, r }),
      dash: (x, y, w, h, c, t = 1, d = 8, r = 0) => cmds.push({ op: 'dash', x, y, w, h, c: A(c, al), t, d, r }),
      heat: (x, y, w, h, act = 1) => cmds.push({ op: 'heat', x, y, w, h, activity: act * al }),
      text(x, y, str, size, c, { f = 'mono', w = 400, max = Infinity, term = false } = {}) {
        str = drawable(str);
        if (measure(str, size, f, w) > max) {
          let lo = 0, hi = str.length;
          while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (measure(str.slice(0, mid) + '..', size, f, w) <= max) lo = mid; else hi = mid - 1; }
          str = lo > 0 ? str.slice(0, lo) + '..' : '';
        }
        if (str) cmds.push({ op: 'text', x, y, s: size, c: A(c, al), str, f, w, surf: curSurf || undefined, ...(term ? { term: true } : {}) });
        return measure(str, size, f, w);
      },
      wrap(x, y, str, size, c, maxW, maxLines, lh, opts = {}) {
        const lines = []; let line = '';
        for (const para of String(str).split('\n')) {
          line = '';
          for (const word of para.split(' ')) {
            const test = line ? line + ' ' + word : word;
            if (line && measure(test, size, opts.f, opts.w) > maxW) { lines.push(line); line = word; } else line = test;
          }
          lines.push(line);
        }
        lines.slice(0, maxLines).forEach((l, i) => o.text(x, y + i * lh, i === maxLines - 1 && lines.length > maxLines ? l + '..' : l, size, c, { ...opts, max: maxW }));
        return Math.min(lines.length, maxLines) * lh;
      },
    };
    return o;
  };
  const g = mk(1);

  const tilesNow = getTiles(api);
  const wsNodes = getScene(api, 'workspaces');
  const scene = st.view === 'flow' ? [] : getScene(api, st.view);
  const store = env.store, now = env.now ?? Date.now(), winMs = st.window || 300000, bindings = st.bindings || {};
  // A binding may name a base series ('cpu.core_pct'); resolve it to concrete keys that exist.
  // 3D surface op: data only (the renderer builds geometry). The camera auto-orbits until the user drags.
  const cam = st.cam || {}, yaw = (cam.yaw ?? 0.6) + (cam.manual ? 0 : (env.time || 0) * 0.15);
  const surface = (id, r, settle) => {
    if (!store || settle < 0.95 || r.w < 24 || r.h < 24) return null;
    const m = surfaceModel(store, [].concat(bindings[id] ?? []), winMs, now);
    if (m.rows) cmds.push({ op: 'scene3d', x: r.x, y: r.y, w: r.w, h: r.h, rows: m.rows, cols: m.cols, vals: m.vals, yaw, pitch: cam.pitch ?? 0.5, dist: cam.dist ?? 2.7, ramp: [T.blue, T.yellow, T.red].map(c => c.slice(0, 3)) });
    return m;
  };
  const keysFor = id => [].concat(bindings[id] ?? []).flatMap(b => !store ? [] : store.series.has(b) ? [b] : [...store.series.keys()].filter(k => baseName(k) === b).slice(0, 1));
  // A bar gauge shows every series of the bound base name (one bar per core), not just the first.
  const barKeys = id => [].concat(bindings[id] ?? []).flatMap(b => !store ? [] : store.series.has(b) ? [b] : [...store.series.keys()].filter(k => baseName(k) === b).sort());
  const cur = api.kijo_special_open() ? -1 : api.kijo_ws();
  const wsIndex = api.kijo_special_open() ? 9 : api.kijo_ws();
  const onCanvas = st.view === 'canvas';
  const sel = onCanvas ? selectedNode(api) ?? { kind: 0, app: 0 } : selectedTile(api);

  // Attention across every workspace, straight from the core's tile tables.
  const count = { blocked: 0, error: 0, working: 0, done: 0 };
  for (let w = 0; w < 10; w++) for (const t of getTiles(api, w)) if (t.kind === 1) {
    if (t.status === 2) count.blocked++; else if (t.status === 3) count.error++; else if (t.status === 1) count.working++; else if (t.status === 4) count.done++;
  }

  if (T.glass) cmds.push({ op: 'wall' }); else g.fill(0, 0, W, H, T.bg);
  // The canvas fills everything between the bar and the hint line; both are drawn on top of it.
  const canvasArea = onCanvas ? { x: 0, y: T.bar, w: W, h: H - T.hint - T.bar } : null;
  let canvasInfo = '', canvasMoving = false;
  if (onCanvas) drawCanvas(canvasArea);

  // ---------------------------------------------------------------- bar (layer, exclusive zone)
  const B = T.bar, pad = Math.round(clamp(W * 0.015, 10, 26));
  if (T.glass) g.glass(8, 5, W - 16, B - 10, white, (B - 10) / 2, 0.09, 14); else { g.fill(0, 0, W, B, T.barBg); g.fill(0, B - 1, W, 1, T.faint); }
  const cy = (B - 14) / 2 - 1;
  g.fill(pad, B / 2 - 8, 5, 16, T.red); g.fill(pad + 7, B / 2 - 8, 5, 16, T.yellow); g.fill(pad + 14, B / 2 - 8, 5, 16, T.blue);
  let bx = pad + 34;
  const pillW = compact ? 24 : 28, pillH = 24;
  for (const n of wsNodes) {
    const active = n.meta === cur, used = n.id + n.group > 0, py = (B - pillH) / 2;
    if (compact && !active && !used) continue; // phone: only workspaces that matter
    const hot = n.status !== 0 && n.id > 0;
    if (active) g.fill(bx, py, pillW, pillH, T.ink, T.radius);
    else if (hot && (n.status === 2 || n.status === 3)) g.fill(bx, py, pillW, pillH, statusColor(T, n.status), T.radius);
    else g.stroke(bx, py, pillW, pillH, used ? T.line : T.faint, 1, T.radius);
    const fg = active || (hot && (n.status === 2 || n.status === 3)) ? T.onAccent : used ? T.ink : T.dim;
    const lbl = String(n.meta + 1);
    g.text(bx + (pillW - measure(lbl, 13, 'mono', 600)) / 2, py + 4, lbl, 13, fg, { f: 'mono', w: 600 });
    if (n.status === 1 && n.id > 0 && !active) g.fill(bx + pillW - 7, py + 3, 4, 4, T.blue, 2);
    if (n.status === 4 && n.id > 0 && !active) g.fill(bx + pillW - 7, py + 3, 4, 4, T.ink, 2);
    hits.push({ kind: 'ws', ws: n.meta, x: bx, y: py, w: pillW, h: pillH });
    bx += pillW + 4;
  }
  // Special workspace (scratchpad) toggle.
  if (!compact) {
    const on = api.kijo_special_open(), py = (B - pillH) / 2;
    if (on) g.fill(bx + 4, py, pillW, pillH, T.blue, T.radius); else g.stroke(bx + 4, py, pillW, pillH, T.faint, 1, T.radius);
    g.text(bx + 4 + (pillW - measure('S', 13, 'mono', 600)) / 2, py + 4, 'S', 13, on ? T.onAccent : T.dim, { f: 'mono', w: 600 });
    hits.push({ kind: 'special', x: bx + 4, y: py, w: pillW, h: pillH });
    bx += pillW + 14;
  }
  // Right side modules, laid out right-to-left. Only real values; no invented numbers.
  const M = env.metrics || {};
  let rx = W - pad;
  const mod = (labelText, value, color = T.ink) => {
    const vw = measure(value, 12, 'mono', 600), lw = labelText ? measure(labelText + ' ', 11, 'mono') : 0, w = vw + lw;
    rx -= w; g.text(rx, cy + 1, labelText ? labelText + ' ' : '', 11, T.dim); g.text(rx + lw, cy, value, 12, color, { f: 'mono', w: 600 }); rx -= 16; return w;
  };
  const clockW = measure(env.clock, 13, 'mono', 600);
  rx -= clockW; g.text(rx, cy, env.clock, 13, T.ink, { f: 'mono', w: 600 }); rx -= 6;
  if (!compact) { const dw = measure(env.date, 11, 'mono'); rx -= dw; g.text(rx, cy + 1, env.date, 11, T.dim); }
  rx -= 18;
  if (!compact) {
    if (M.battery != null) mod('bat', `${M.battery}%${M.charging ? '+' : ''}`, M.battery < 20 && !M.charging ? T.red : T.ink);
    if (M.ram != null) mod('ram', `${M.ram}%`);
    else if (M.memory) mod('mem', M.memory);
    if (M.cpu != null) mod('cpu', `${M.cpu}%`);
    else if (M.cores) mod('cores', String(M.cores));
    if (M.net) mod('net', M.net, M.net === 'offline' ? T.red : T.ink);
    if (store) { const live = [...store.sources.values()].filter(s => now - s.last < 15000).length; mod('inj', String(live), live ? T.ink : T.dim); }
    if (env.daemon) mod('kijod', env.daemon.state, env.daemon.state === 'connected' ? T.ink : T.yellow);
    g.fill(rx + 8, 9, 1, B - 18, T.faint); rx -= 8;
  }
  // Attention: the module that answers "what needs me?".
  let chips = 0;
  const chip = (txt, bg, fg) => { if (compact && chips++) return; const w = measure(txt, 12, 'mono', 600) + 16; rx -= w; g.fill(rx, (B - 22) / 2, w, 22, bg, T.radius); g.text(rx + 8, cy + 1, txt, 12, fg, { f: 'mono', w: 600 }); rx -= 6; };
  if (count.done) chip(`${count.done} done`, T.faint, T.ink);
  if (count.working) chip(`${count.working} working`, mix(T.barBg, T.blue, 0.35), T.ink);
  if (count.error) chip(`${count.error} error`, T.red, T.onAccent);
  if (count.blocked) chip(`${count.blocked} blocked`, T.yellow, T.onAccent);
  if (!(count.done + count.working + count.error + count.blocked)) { rx -= measure('all idle', 12) ; g.text(rx, cy + 1, 'all idle', 12, T.dim); rx -= 8; }
  // Center: what is selected, with its real state.
  if (!compact) {
    const space = rx - bx - 20;
    let title, sub = '', subColor = T.dim;
    if (sel.kind === 1) { title = label(sel, st.notes, bindings); sub = STATUS[sel.status] + (sel.status === 2 && sel.blockedKind ? ': ' + BLOCKED_KIND[sel.blockedKind] : '') + (sel.progress ? ` ${sel.progress}%` : ''); subColor = statusColor(T, sel.status); }
    else if (sel.kind === 2 && onCanvas) { const o = sel.owner ? getCanvasNodes(api).find(c => c.id === sel.owner) : null; title = o ? 'ghost - reserved by ' + label(o, st.notes, bindings) : 'ghost - reserved space'; }
    else if (sel.kind === 2) { title = `ghost - reserved by #${sel.owner}`; }
    else title = onCanvas ? 'canvas' : 'empty slot';
    const tw = measure(title, 13, 'sans', 600), sw = sub ? measure(sub, 12) + 12 : 0;
    if (tw + sw < space) {
      const x = bx + (space - tw - sw) / 2 + 10;
      g.text(x, cy, title, 13, T.ink, { f: 'sans', w: 600 });
      if (sub) { g.fill(x + tw + 10, B / 2 - 3, 6, 6, subColor); g.text(x + tw + 20, cy + 1, sub, 12, subColor); }
    }
  }

  // ---------------------------------------------------------------- content area
  const hintY = H - T.hint;
  const area = { x: pad, y: B + pad * 0.7, w: W - pad * 2, h: hintY - B - pad * 1.2 };
  // Cells are square: the grid lives in the largest centred square of the area (a 1x1 tile is a square,
  // a 2x2 footprint is a bigger square). Z zooms the selected tile to fill the whole area instead.
  const side = Math.floor(Math.min(area.w, area.h)), box = { x: area.x + Math.floor((area.w - side) / 2), y: area.y + Math.floor((area.h - side) / 2), w: side, h: side };
  const mapNode = n => ({ x: box.x + n.x / SCALE * box.w, y: box.y + n.y / SCALE * box.h, w: n.w / SCALE * box.w, h: n.h / SCALE * box.h });

  // One tile card; `r` is the animated rectangle, `mode` 'focus' | 'cell'.
  // opt (canvas): { tile, hit: hit kind keyed by id, gap, canvas: no grid bookkeeping lines }
  function tileCard(n, r, mode, key, opt = {}) {
    const t = opt.tile ?? tilesNow[n.meta], selected = !!(n.flags & FLAG.SELECTED), a = mk(r.a), focus = mode === 'focus';
    const gap = opt.gap ?? (focus ? T.gap : 4), x = Math.round(r.x + gap / 2), y = Math.round(r.y + gap / 2), w = Math.round(r.w - gap), h = Math.round(r.h - gap);
    if (w < 4 || h < 4) return;
    hits.push(opt.hit ? { kind: opt.hit, id: t.id, x, y, w, h } : { kind: 'tile', meta: n.meta, x, y, w, h });
    const rad = focus ? T.radius : Math.min(T.radius, 4), ip = focus ? clamp(w * 0.045, 12, 22) : 7;
    const show = clamp(r.settle, 0, 1), c = mk(r.a * show); // content fades in as the glide settles
    const ring = () => { if (selected) { a.stroke(x - 3, y - 3, w + 6, h + 6, st.capture === t.id ? T.blue : T.ink, st.capture === t.id ? 3 : 2, rad + 3); } };

    if (n.kind === NODE.TILE) {
      const sc = statusColor(T, n.status), isNote = t.app === APP.NOTE;
      let fill = T.panel, fg = T.ink, sub = T.dim;
      if (!focus) {
        if (n.status === 2) { fill = T.yellow; fg = T.onAccent; sub = T.onAccent; }
        else if (n.status === 3) { fill = T.red; fg = T.onAccent; sub = T.onAccent; }
        else if (n.status === 4) { fill = T.ink; fg = T.onAccent; sub = T.onAccent; }
        else if (n.status === 1) fill = mix(T.panel, T.blue, 0.16);
        else if (isNote) fill = mix(T.panel, T.yellow, 0.1);
      }
      if (T.glass) { // status-coloured cells become tinted glass; the rest is plain glass
        const solid = !focus && (n.status >= 2), strong = solid ? 0.82 : 0, tintc = solid ? fill : !focus && n.status === 1 ? T.blue : isNote && !focus ? T.yellow : white;
        a.glass(x, y, w, h, white.map((v, i) => (i < 3 ? tintc[i] : 1)), rad, solid ? strong : tintc === white ? 0.10 : 0.30, focus ? Math.min(26, Math.max(6, Math.round(Math.min(w, h) * 0.3))) : 8);
      } else a.fill(x, y, w, h, fill, rad);
      if (n.shader === 1) a.heat(x, y, w, h, 1);
      a.stroke(x, y, w, h, focus || n.status === 0 || n.status === 1 ? T.line : fill, 1, rad);
      if (isNote) a.fill(x, y, focus ? 4 : 3, h, T.yellow);
      if (focus) {
        // header: app badge + title + state
        const bs = 20;
        a.fill(x + ip, y + ip, bs, bs, sc === T.dim ? T.faint : sc, 3);
        const ch = tag(t)[0] || '?';
        c.text(x + ip + (bs - measure(ch, 12, 'mono', 700)) / 2, y + ip + 3, ch, 12, sc === T.dim ? T.ink : T.onAccent, { f: 'mono', w: 700 });
        const editing = st.editing && st.editing.id === t.id;
        const title = isNote ? (editing ? 'editing note' : opt.canvas ? 'NOTE' + (st.cids?.[t.id] ? '  ' + st.cids[t.id] : '') : 'NOTE ' + t.id) : label(t, st.notes, bindings);
        c.text(x + ip + bs + 10, y + ip + 1, title, 15, editing ? T.blue : fg, { f: 'sans', w: 600, max: w - ip * 2 - bs - 110 });
        const stm = t.app === APP.SHELL ? st.terms?.get(t.id) : null, capt = st.capture === t.id, lgv = t.app === APP.LOGS ? st.logv?.[t.id] : null;
        const state = lgv && (lgv.edit || lgv.q || lgv.off) ? (lgv.edit ? 'find: ' + lgv.q + (Math.floor(env.time * 2) % 2 ? '|' : ' ') : (lgv.q ? lgv.q + '  ' : '') + (lgv.off ? '-' + lgv.off + '  End = live' : 'filtered')) : stm ? (capt ? 'keys > shell  ^] release' : stm.exited !== null ? 'exited ' + stm.exited : stm.view > 0 ? 'scrollback -' + stm.view : 'live') : t.app >= APP.SYS ? (t.app === APP.SERIES || t.app === APP.SCENE3D ? windowLabel(winMs) : 'live') : STATUS[t.status] + (t.status === 2 && t.blockedKind ? ': ' + BLOCKED_KIND[t.blockedKind] : '');
        const sw = Math.min(measure(state, 12) + 14, Math.max(110, w * 0.45));
        c.fill(x + w - ip - sw + 0, y + ip + 6, 6, 6, sc);
        c.text(x + w - ip - sw + 12 - 0, y + ip + 3, state, 12, sc === T.dim ? T.dim : sc, { max: sw });
        const by = y + ip + bs + 16, bw = w - ip * 2, M2 = env.metrics || {};
        curSurf = t.id; // content below the header is the selectable surface
        if (t.progress > 0 || t.status === 1) {
          c.fill(x + ip, y + h - ip - 4, bw, 4, T.faint, 2);
          if (t.progress > 0) c.fill(x + ip, y + h - ip - 4, bw * t.progress / 100, 4, T.blue, 2);
        }
        if (isNote) {
          const text = editing ? st.editing.text + (Math.floor(env.time * 2) % 2 ? '|' : ' ') : (st.notes[t.id] ?? '');
          c.wrap(x + ip, by, text || 'empty note - press E to write', clamp(w * 0.06, 16, 26), editing ? T.ink : text ? T.ink : T.dim, bw, Math.max(1, Math.floor((h - (by - y) - ip * 2) / clamp(w * 0.06 * 1.35, 22, 34))), clamp(w * 0.06 * 1.35, 22, 34), { f: 'sans', w: 500 });
          const foot = y + h - ip - (t.progress > 0 || t.status === 1 ? 26 : 14) - (h > 230 ? 18 : 0);
          if (!editing) c.text(x + ip, foot, '[E] write   [X] close', 11, T.dim, { max: bw });
          else c.text(x + ip, foot, 'esc saves   enter = new line', 11, T.blue, { max: bw });
        } else if (t.app === APP.SHELL) {
          const tm = st.terms?.get(t.id), dm = env.daemon;
          if (tm?.vt) {
            const cr = { x: x + ip, y: by - 6, w: bw, h: Math.max(20, h - (by - 6 - y) - ip - (t.progress > 0 || t.status === 1 ? 10 : 2) - (h > 230 ? 18 : 0)) };
            if (r.settle > 0.95) termSizes[t.id] = drawTerm(c, measure, T, cr, tm, { captured: st.capture === t.id });
          } else if (dm && dm.state === 'connected' && dm.shell) {
            c.text(x + ip, by, 'shell ready on ' + (dm.host || 'kijod'), 13, fg, { f: 'sans', w: 500 });
            c.text(x + ip, by + 22, 'press Enter to open it; keys then go to the shell, Ctrl+] gives them back', 12, sub, { max: bw });
          } else if (dm && dm.state === 'connected') {
            c.text(x + ip, by, 'shell access is off on this kijod', 13, fg, { f: 'sans', w: 500 });
            c.text(x + ip, by + 22, 'restart it with  --allow-shell  (anyone with the token can then run commands)', 12, sub, { max: bw });
          } else {
            c.text(x + ip, by, 'no PTY attached', 13, fg, { f: 'sans', w: 500 });
            c.text(x + ip, by + 22, 'on the host:  node src/kijod.mjs --allow-shell', 12, sub, { max: bw });
            c.text(x + ip, by + 42, 'then palette:  kijod <url> <token>', 12, sub, { max: bw });
            c.text(x + ip, by + 62, 'terminal host:  node src/host.mjs  [P]', 12, sub, { max: bw });
          }
        } else if (t.app === APP.AGENT) {
          c.text(x + ip, by, 'simulated agent', 13, fg, { f: 'sans', w: 500 });
          c.text(x + ip, by + 22, 'not running - state is set locally', 12, sub, { max: bw });
          c.text(x + ip, by + 42, '[T] cycle idle / working / blocked / error / done', 12, sub, { max: bw });
        } else if (t.app === APP.METRICS) {
          const rows = [['cores', M2.cores], ['memory', M2.memory], ['frame rate', M2.fps != null ? M2.fps + ' fps' : null], ['renderer', M2.gpu], ['cpu load', M2.cpu != null ? M2.cpu + '%' : 'needs kijod'], ['ram used', M2.ram != null ? M2.ram + '%' : 'needs kijod']];
          rows.forEach(([k, v], i) => { c.text(x + ip, by + i * 20, k, 12, T.dim); c.text(x + ip + 100, by + i * 20, String(v ?? '-'), 12, fg, { w: 600, max: bw - 100 }); });
        } else if (t.app === APP.SCENE3D) {
          const cr = { x: x + ip, y: y + ip + bs + 10, w: bw, h: Math.max(20, h - (ip * 2 + bs + 10) - 34) };
          const m = surface(t.id, cr, r.settle);
          if (!store) c.text(cr.x, cr.y, 'no telemetry store in this host', 12, sub);
          else if (m && !m.rows) { c.text(cr.x, cr.y, 'no series to plot', 13, fg, { f: 'sans', w: 500 }); c.text(cr.x, cr.y + 22, 'inject metrics, or run kijod (host cores)', 12, sub, { max: bw }); }
          if (m && m.rows) {
            const bases = [...new Set(m.keys.map(shortName))], rl = k => (k.match(/\{(.*)\}/)?.[1] || k).replace(/"/g, '').replace(/=/g, ' ');
            c.text(x + ip, y + h - ip - 28, 'rows: ' + (bases.length === 1 ? bases[0] + '  ' + m.keys.map(rl).join('  ') : m.keys.map(shortName).join('  ')), 11, sub, { max: bw });
            c.text(x + ip, y + h - ip - 12, `x time -${windowLabel(winMs)}..now   y ${m.norm}   drag to orbit, double-click to spin`, 10, T.dim, { max: bw });
          }
        } else if (t.app >= APP.SYS) {
          const cr = { x: x + ip, y: y + ip + bs + 12, w: bw, h: Math.max(20, h - (ip * 2 + bs + 12)) };
          if (!store) c.text(cr.x, cr.y, 'no telemetry store in this host', 12, sub);
          else if (t.app === APP.SERIES) {
            const ks = keysFor(t.id);
            if (!ks.length) { c.text(cr.x, cr.y, 'unbound chart', 13, fg, { f: 'sans', w: 500 }); c.text(cr.x, cr.y + 22, 'press / and choose "Pin chart: <series>"', 12, sub, { max: bw }); c.text(cr.x, cr.y + 42, 'or inject:  queue.depth 12', 12, sub, { max: bw }); }
            else { const vz = st.viz?.[t.id]; if (vz === 'stat') drawStat(c, measure, T, cr, store, ks, winMs, now); else if (vz === 'gauge') drawGauge(c, measure, T, cr, store, ks, winMs, now); else if (vz === 'status') drawStatus(c, measure, T, cr, store, ks, winMs, now); else if (vz === 'bars') drawBars(c, measure, T, cr, store, barKeys(t.id), winMs, now); else drawChart(c, measure, T, cr, store, ks, winMs, now, { mini: false }); }
          } else if (t.app === APP.LOGS) { const lv = st.logv?.[t.id] || {}; logInfo[t.id] = drawLogs(c, measure, T, cr, store, now, { off: lv.off, q: lv.q }); }
          else if (t.app === APP.TRACES) drawTraces(c, measure, T, cr, store, now);
          else drawSys(c, measure, T, cr, store, now, { windowMs: winMs });
        } else if (t.app === APP.REMOTE) {
          c.text(x + ip, by, 'no remote configured', 13, fg, { f: 'sans', w: 500 });
          c.text(x + ip, by + 22, 'SSH and Herdr attach through kijod', 12, sub, { max: bw });
        } else c.text(x + ip, by, tag(t), 12, sub);
        if (h > 230 && t.app < APP.SYS && !opt.canvas) c.text(x + ip, y + h - ip - (t.progress > 0 || t.status === 1 ? 26 : 14), `#${t.id}  group ${t.group}  tx ${t.tx}`, 11, T.dim, { max: bw });
      } else {
        // heatmap cell: glanceable, status-first
        const small = h < 44 || w < 56;
        if (!small) {
          c.text(x + ip, y + 6, `${tag(t)} ${t.id}`, 11, fg, { w: 600, max: w - ip * 2 });
          if (t.app >= APP.SYS && store) {
            const cr = { x: x + ip, y: y + 22, w: w - ip * 2, h: h - 28 };
            if (t.app === APP.SCENE3D) surface(t.id, cr, r.settle); else
            if (t.app === APP.SERIES) { const k = keysFor(t.id)[0]; if (k && cr.h > 10) { if (cr.h > 26) c.text(x + ip + measure(`${tag(t)} ${t.id}  `, 11, 'mono', 600), y + 6, shortName(k), 10, sub, { max: w - ip * 2 - 40 }); drawSpark(c, measure, T, cr, store, k, winMs, now); } else if (!k) c.text(cr.x, cr.y, 'unbound', 10, sub); }
            else if (t.app === APP.LOGS && cr.h > 12) drawLogs(c, measure, T, cr, store, now, { mini: true });
            else if (t.app === APP.TRACES && cr.h > 12) drawTraces(c, measure, T, cr, store, now, { mini: true });
            else if (t.app === APP.SYS && cr.h > 12) drawSys(c, measure, T, cr, store, now, { mini: true });
          } else if (h > 48) c.text(x + ip, y + 22, STATUS[t.status], 11, sub, { max: w - ip * 2 });
          if (isNote && h > 66) c.wrap(x + ip, y + 38, st.notes[t.id] ?? '', h > 150 ? 13 : 11, fg, w - ip * 2, Math.max(1, Math.floor((h - 52) / (h > 150 ? 17 : 14))), h > 150 ? 17 : 14, { f: 'sans' });
        }
        if (t.progress > 0) { a.fill(x + 6, y + h - 8, w - 12, 3, T.faint, 2); a.fill(x + 6, y + h - 8, (w - 12) * t.progress / 100, 3, T.blue, 2); }
      }
    } else if (n.kind === NODE.GHOST) {
      // Ghosts are transparent in presentation mode; [G] reveals them, and the selected one always shows.
      if (st.ghosts || selected || !focus) {
        a.dash(x, y, w, h, T.line, 1, focus ? 10 : 6, rad);
        if (focus) {
          c.text(x + ip, y + ip, `reserved by #${n.owner}`, 12, T.dim, { f: 'sans', max: w - ip * 2 });
          c.text(x + ip, y + ip + 18, `group ${n.group}   no content`, 11, T.line, { max: w - ip * 2 });
          if (selected) c.text(x + ip, y + h - ip - 14, '[N] promote to note', 12, T.ink, { max: w - ip * 2 });
        } else c.text(x + 6, y + 5, `#${n.owner}`, 10, T.dim, { max: w - 12 });
      }
    } else {
      a.stroke(x, y, w, h, selected ? T.ink : T.line, selected ? 2 : 1, rad); // the square cell stays visible so the 2x2 window reads as a grid
      if (focus && (st.ghosts || selected)) {
        c.text(x + ip, y + ip, 'empty slot', 12, T.dim, { f: 'sans' });
        if (selected) { c.text(x + ip, y + h - ip - 30, '[N] note   [F] 2x2 reservation', 12, T.ink, { max: w - ip * 2 }); c.text(x + ip, y + h - ip - 14, 'fills only what you reserve', 11, T.dim, { max: w - ip * 2 }); }
      } else if (!focus && selected) c.text(x + w / 2 - 3, y + h / 2 - 8, '+', 14, T.dim);
    }
    curSurf = 0;
    ring();
    if (!focus && (n.flags & FLAG.IN_VIEWPORT) && n.kind !== NODE.TILE) a.fill(x + w - 9, y + 5, 4, 4, T.blue, 2);
  }

  let info = '';
  if (onCanvas) info = canvasInfo;
  else if (st.view === 'focus' || st.view === 'overview') {
    const mode = st.view === 'focus' ? 'focus' : 'cell';
    // Phone / narrow window: a 2x2 would be unreadable, so the selected tile fills the area
    // (Hyprland's fullscreen). Same WASM scene, same keys; only the mapping differs.
    const fullOne = (compact || st.zoom) && mode === 'focus';
    for (const n of scene) {
      if (fullOne && !(n.flags & FLAG.SELECTED)) continue;
      const target = fullOne ? { x: area.x, y: area.y, w: area.w, h: area.h } : mapNode(n);
      const r = anim.rect(`${wsIndex}:${n.meta}`, target, dt);
      tileCard(n, r, mode);
    }
    if (mode === 'cell') {
      // The viewport Enter will land on: the WASM-owned 2x2 window.
      const fx = api.kijo_focus_x(), fy = api.kijo_focus_y(), vw = box.w / 6, vh = box.h / 6;
      g.dash(Math.round(box.x + fx * vw) - 1, Math.round(box.y + fy * vh) - 1, Math.round(vw * 2) + 2, Math.round(vh * 2) + 2, T.blue, 2, 12, T.radius + 2);
      info = `6x6   ${tilesNow.filter(t => t.kind === 1).length} tiles   ${tilesNow.filter(t => t.kind === 2).length} reserved   viewport ${fx},${fy}`;
    } else info = `workspace ${wsIndex === 9 ? 'special' : wsIndex + 1}   viewport ${api.kijo_focus_x()},${api.kijo_focus_y()}   selected ${api.kijo_sel_x()},${api.kijo_sel_y()}`;
  } else if (st.view === 'workspaces') {
    const gapW = Math.max(10, T.gap), cw = (area.w - gapW * 2) / 3, ch = (area.h - gapW * 2) / 3;
    for (const n of scene) {
      const r = anim.rect(`ws:${n.meta}`, { x: area.x + (n.meta % 3) * (cw + gapW), y: area.y + Math.floor(n.meta / 3) * (ch + gapW), w: cw, h: ch }, dt);
      const a = mk(r.a), x = Math.round(r.x), y = Math.round(r.y), w = Math.round(r.w), h = Math.round(r.h), active = !!(n.flags & FLAG.ACTIVE_WS);
      hits.push({ kind: 'ws-card', ws: n.meta, x, y, w, h });
      a.fill(x, y, w, h, T.panel, T.radius);
      if (n.status === 2 && n.id) a.fill(x, y, w, 4, T.yellow); else if (n.status === 3 && n.id) a.fill(x, y, w, 4, T.red); else if (n.status === 1 && n.id) a.fill(x, y, w, 4, T.blue);
      a.stroke(x, y, w, h, active ? T.ink : T.line, active ? 2 : 1, T.radius);
      a.text(x + 14, y + 10, String(n.meta + 1), 26, active ? T.ink : T.dim, { f: 'sans', w: 600 });
      a.text(x + 48, y + 14, n.id || n.group ? `${n.id} tiles   ${n.group} reserved` : 'empty', 12, T.dim, { max: w - 62 });
      if (n.id) a.text(x + 48, y + 30, STATUS[n.status] + (n.progress ? ` ${n.progress}%` : ''), 12, statusColor(T, n.status), { max: w - 62 });
      // The real 6x6 occupancy of that workspace, drawn from its tile table.
      const mini = getTiles(api, n.meta), top = y + 56, side = Math.min((w - 28) / 6, (h - 70) / 6), mx = x + (w - side * 6) / 2;
      mini.forEach((t, i) => {
        const cx = mx + (i % 6) * side, cyy = top + Math.floor(i / 6) * side, s = Math.max(2, side - 3);
        if (t.kind === 1) {
          const col = t.status === 0 ? (t.app === APP.NOTE ? T.yellow : T.ink) : statusColor(T, t.status);
          a.fill(cx, cyy, s, s, t.status === 0 ? A(col, t.app === APP.NOTE ? 0.9 : 0.55) : col, Math.min(3, s / 3));
        } else if (t.kind === 2) a.dash(cx, cyy, s, s, T.line, 1, 4, 2); else a.fill(cx + s / 2 - 1, cyy + s / 2 - 1, 2, 2, T.faint);
      });
    }
    info = `workspace ${wsIndex === 9 ? 'special' : wsIndex + 1} of 9`;
  } else if (st.view === 'back') {
    g.text(area.x, area.y, 'RENDER TREE', 12, T.ink, { w: 700 });
    g.text(area.x + 100, area.y, 'WebAssembly scene nodes - ghost --owner--> tile', 12, T.dim);
    const sub = { x: area.x, y: area.y + 28, w: area.w, h: area.h - 28 }, side = Math.min(sub.w, sub.h);
    const box = { x: sub.x + (sub.w - side) / 2, y: sub.y, w: side, h: side };
    const r = n => ({ x: box.x + n.x / SCALE * box.w, y: box.y + n.y / SCALE * box.h, w: n.w / SCALE * box.w, h: n.h / SCALE * box.h });
    for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) g.fill(Math.round(box.x + i * box.w / 6) - 1, Math.round(box.y + j * box.h / 6) - 1, 2, 2, T.faint);
    const owners = new Map(scene.filter(n => n.kind === NODE.TILE).map(n => [n.id, r(n)]));
    for (const n of scene.filter(n => n.kind === NODE.LINK)) {
      const gh = r(n), o = owners.get(n.owner); if (!o) continue;
      const gx = gh.x + gh.w / 2, gy = gh.y + gh.h / 2, ox = o.x + o.w / 2, oy = o.y + o.h / 2;
      g.fill(Math.min(gx, ox), gy - 1, Math.abs(ox - gx) + 1, 2, T.blue); g.fill(ox - 1, Math.min(gy, oy), 2, Math.abs(oy - gy) + 1, T.blue);
    }
    for (const n of scene) {
      const gh = r(n), inset = gh.w * 0.16, x = Math.round(gh.x + inset), y = Math.round(gh.y + inset), w = Math.round(gh.w - inset * 2), h = Math.round(gh.h - inset * 2), t = tilesNow[n.meta];
      hits.push({ kind: 'tile', meta: n.meta, x, y, w, h });
      if (n.kind === NODE.TILE) { g.fill(x, y, w, h, T.panel, 3); g.stroke(x, y, w, h, T.ink, 1, 3); g.fill(x + 4, y + 4, 6, 6, statusColor(T, n.status)); g.text(x + 4, y + h - 16, `${tag(t)} ${t.id}`, 11, T.ink, { max: w - 8 }); }
      else { g.dash(x, y, w, h, T.blue, 1, 6, 3); g.text(x + 4, y + 4, `${n.meta}`, 11, T.dim, { max: w - 8 }); }
      if (n.flags & FLAG.SELECTED) g.stroke(x - 3, y - 3, w + 6, h + 6, T.ink, 2, 6);
    }
    info = `${scene.filter(n => n.kind === NODE.TILE).length} tiles   ${scene.filter(n => n.kind === NODE.LINK).length} owned ghosts`;
  } else if (st.view === 'timeline') {
    g.text(area.x, area.y, 'EVENT LOG', 12, T.ink, { w: 700 });
    g.text(area.x + 84, area.y, 'WASM event ring + host events', 12, T.dim);
    const rowH = 30, top = area.y + 28;
    scene.forEach((n, i) => {
      const y = top + i * (rowH + 4), t = tilesNow[n.meta];
      g.fill(area.x, y, area.w, rowH, T.panel, T.radius); g.fill(area.x, y, 4, rowH, statusColor(T, n.status));
      hits.push({ kind: 'tile', meta: n.meta, x: area.x, y, w: area.w, h: rowH });
      g.text(area.x + 16, y + 8, `#${n.id}`.padEnd(6) + STATUS[n.status].padEnd(9) + `group ${n.group}`.padEnd(11) + label(t, st.notes, bindings), 12, T.ink, { max: area.w - 28 });
      if (n.flags & FLAG.SELECTED) g.stroke(area.x - 2, y - 2, area.w + 4, rowH + 4, T.ink, 2, T.radius);
    });
    let ey = top + scene.length * (rowH + 4) + 18;
    g.fill(area.x, ey - 10, area.w, 1, T.faint);
    const room = Math.max(0, Math.floor((area.y + area.h - ey) / 18));
    const core = getEvents(api).map(e => `core #${String(e.seq).padStart(3)}  ${EVENT[e.op].padEnd(9)} tile ${e.id}  ${e.a},${e.b}`);
    const all = [...core, ...st.events].slice(-room);
    if (!all.length) g.text(area.x, ey, 'no events yet', 12, T.dim);
    all.forEach((e, i) => g.text(area.x, ey + i * 18, e, 12, T.dim, { max: area.w }));
    info = `${scene.length} live tiles   ${core.length} core events`;
  } else if (st.view === 'flow') {
    // Where the data comes from and where it is shown. Every row is read from the store and the
    // core's tile tables; a moving packet means a message really arrived on that cable recently.
    if (!store) g.text(area.x, area.y, 'no telemetry store in this host', 12, T.dim);
    else {
      const all = []; for (let w = 0; w < 10; w++) for (const t of getTiles(api, w)) all.push({ ...t, ws: w });
      const model = drawFlow(g, g, measure, T, area, store, all, bindings, now, env.time, hits, new Set(Object.values(bindings).flat().map(baseName)));
      info = `${model.sources.length} injectors   ${model.groups.length} series   ${store.logs.length} logs   ${store.spans.length} spans   window ${windowLabel(winMs)}`;
    }
  }
  anim.end();

  // ---------------------------------------------------------------- hint line
  const ctxHint = (() => {
    if (st.zoom && st.view === 'focus') return 'zoomed: Z or esc back to the grid   arrows pick another tile';
    if (st.editing) return 'writing   esc save   enter newline   backspace delete';
    if (onCanvas) return api.kijo_canvas_marked() ? 'link: move to the target and press L   L on the same node cancels' : sel.kind === 2 ? 'N fill with a note   X release   drag moves   arrows move' : 'drag pans   wheel zooms   arrows move   enter flies   esc fits   N note   F reserve   L link   E write   X close';
    if (st.capture) return 'keys go to the shell   ctrl+] release   ctrl+shift+c copy   ctrl+shift+v paste   wheel / shift+pgup scroll';
    if (sel.app === APP.SHELL && st.terms?.has(sel.id)) return 'enter or click captures keys   drag selects text   wheel scrolls   X close';
    if (st.view === 'workspaces') return 'click or , . to switch   enter opens   S scratchpad   M move tile on';
    if (st.view === 'back' || st.view === 'timeline') return 'arrows move   1-6 views   / search';
    if (st.view === 'flow') return 'click a series to pin a chart   click a tile to go there   paste data to inject';
    if (sel.kind === 2) return 'N promote to note   F 2x2 reservation   X close owner';
    if (sel.kind === 0) return 'N note   F 2x2 reservation';
    if (sel.app === APP.NOTE) return 'E write   X close   shift+arrows swap   M to next ws';
    if (sel.app === APP.LOGS) return 'ctrl+f find (level:warn  -noise)   pgup/pgdn or wheel scroll   end live   drag selects   X close';
    if (sel.app >= APP.SYS) return 'X close   / pin series   shift+arrows swap   paste data to inject';
    return 'T state   X close   shift+arrows swap   M to next ws';
  })();
  const keys = onCanvas ? '   |   1-7 views   / search   R reset' : '   |   1-7 views   , . workspace   [ ] window   / search   R reset';
  if (onCanvas) g.fill(0, hintY, W, H - hintY, T.glass ? [T.bg[0], T.bg[1], T.bg[2], 0.86] : T.bg);
  g.fill(0, hintY, W, 1, T.faint);
  const room = compact ? W - pad * 2 : W - pad * 2 - measure(info, 11) - 28;
  const full = ctxHint + keys;
  g.text(pad, hintY + 7, st.message || (!compact && measure(full, 11) <= room ? full : ctxHint), 11, st.message ? T.blue : T.dim, { max: st.message ? W - pad * 2 : Math.max(60, room) });
  if (!st.message && !compact) g.text(W - pad - measure(info, 11), hintY + 7, info, 11, T.dim);

  // ---------------------------------------------------------------- palette (Spotlight)
  if (st.palette) {
    const p = st.palette, pw = Math.min(620, W - 32), px = (W - pw) / 2, py = Math.max(B + 24, H * 0.14);
    g.fill(0, 0, W, H, T.scrim);
    const rowH = 36, shown = p.items.slice(0, 9), ph = 56 + shown.length * rowH + 12;
    g.fill(px, py, pw, ph, T.raised, T.radius + 4); g.stroke(px, py, pw, ph, T.line, 1, T.radius + 4);
    g.text(px + 20, py + 18, '>', 16, T.blue, { w: 700 });
    const q = p.q + (Math.floor(env.time * 2) % 2 ? '|' : ' ');
    g.text(px + 42, py + 16, p.q ? q : 'search tiles, notes, commands' + (Math.floor(env.time * 2) % 2 ? '|' : ''), 16, p.q ? T.ink : T.dim, { f: 'sans', max: pw - 64 });
    g.fill(px, py + 52, pw, 1, T.faint);
    shown.forEach((it, i) => {
      const y = py + 56 + i * rowH, on = i === p.sel;
      if (on) g.fill(px + 8, y, pw - 16, rowH - 4, T.ink, T.radius);
      hits.push({ kind: 'palette', index: i, x: px + 8, y, w: pw - 16, h: rowH - 4 });
      g.text(px + 22, y + 8, it.title, 14, on ? T.onAccent : T.ink, { f: 'sans', w: 500, max: pw - 190 });
      if (it.hint) g.text(px + pw - 22 - measure(it.hint, 11), y + 10, it.hint, 11, on ? T.onAccent : T.dim);
    });
    if (!shown.length) g.text(px + 22, py + 68, 'nothing matches', 14, T.dim, { f: 'sans' });
  }
  // Selection highlight goes under the selected surface's text; the text itself is handed back for copy.
  let selectionText = '';
  if (st.sel && !st.palette) {
    const r = selection(cmds, st.sel, measure); selectionText = r.text;
    const at = cmds.findIndex(k => k.op === 'text' && k.surf === st.sel.surf);
    if (at >= 0) cmds.splice(at, 0, ...r.rects.map(q => ({ op: 'fill', x: q.x, y: q.y, w: q.w, h: q.h, c: A(T.blue, 0.38), r: 2 })));
  }
  return { cmds, hits, animating: anim.moving || canvasMoving, selectionText, termSizes, logInfo, canvasArea };

  // ------------------------------------------------------------------ canvas (view 7)
  // The core emits screen rectangles (viewport px), level of detail and links; this draws them.
  function drawCanvas(CA) {
    api.kijo_canvas_viewport(Math.round(CA.w), Math.round(CA.h));
    canvasMoving = !!api.kijo_canvas_step(Math.round(Math.min(1000, dt * 1000)));
    const z = api.kijo_canvas_zoom() / Q16, table = getCanvasNodes(api), scene = getScene(api, 'canvas');
    // dot grid: world spacing that stays at least 22 px apart on screen
    let sp = 32; while (sp * z < 22) sp *= 4;
    const [wx0, wy0] = toWorld(api, 0, 0), gx0 = Math.floor(wx0 / sp) * sp, gy0 = Math.floor(wy0 / sp) * sp, [s0x, s0y] = toScreen(api, gx0, gy0), step = sp * z;
    const cols = Math.ceil(CA.w / step) + 2, rows = Math.ceil(CA.h / step) + 2, dot = A(T.line, T.glass ? 0.45 : 0.5);
    if (cols * rows <= 5000) for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const x = Math.round(CA.x + s0x + i * step), y = Math.round(CA.y + s0y + j * step);
      if (x >= CA.x && x < CA.x + CA.w && y >= CA.y && y < CA.y + CA.h) g.fill(x - 1, y - 1, 2, 2, dot);
    }
    const R = n => ({ x: CA.x + n.x, y: CA.y + n.y, w: n.w, h: n.h, a: 1, settle: 1, off: 0 });
    const rects = new Map(); for (const n of scene) if (n.kind === NODE.TILE || n.kind === NODE.GHOST) rects.set(n.id, R(n));
    const text = t => (t.app === APP.NOTE || t.app === APP.GROUP ? (st.editing?.id === t.id ? st.editing.text + (Math.floor(env.time * 2) % 2 ? '|' : ' ') : st.notes[t.id] ?? '') : label(t, st.notes, bindings));
    let tiles = 0, links = 0;
    for (const n of scene) {
      const t = table[n.meta], r = rects.get(n.id);
      if (n.kind === NODE.LINK) { links++; connector(n, rects.get(n.owner), rects.get(n.group)); continue; }
      if (!t || !r) continue;
      tiles++;
      if (n.kind === NODE.TILE && t.app === APP.GROUP) group(n, t, r);
      else if (n.kind === NODE.GHOST) ghost(n, t, r);
      else if (n.material === 2) tileCard(n, r, 'focus', null, { tile: t, hit: 'cnode', gap: 0, canvas: true });
      else if (n.material === 1) titleCard(n, t, r);
      else dotNode(n, t, r);
      if (n.flags & FLAG.LINK_FROM) g.dash(Math.round(r.x) - 6, Math.round(r.y) - 6, Math.round(r.w) + 12, Math.round(r.h) + 12, T.blue, 2, 10, T.radius + 6);
    }
    minimap(CA);
    const sid = api.kijo_canvas_sel();
    canvasInfo = `canvas   zoom ${Math.round(z * 100)}%   ${api.kijo_canvas_node_count()} nodes   ${api.kijo_canvas_edge_count()} links   ${tiles} drawn` + (sid ? `   selected ${st.cids?.[sid] ?? '#' + sid}` : '');

    function group(n, t, r) {
      const x = Math.round(r.x), y = Math.round(r.y), w = Math.round(r.w), h = Math.round(r.h), on = !!(n.flags & FLAG.SELECTED);
      const rad = Math.max(4, Math.min(18, Math.round(14 * z)));
      g.fill(x, y, w, h, A(T.ink, T.glass ? 0.05 : 0.035), rad);
      g.stroke(x, y, w, h, on ? T.ink : A(T.line, 0.9), on ? 2 : 1, rad);
      const size = Math.max(11, Math.min(26, Math.round(17 * z))), lbl = text(t) || 'group';
      if (w > 40 && h > size + 8) g.text(x + Math.max(8, 14 * z), y + Math.max(6, 12 * z), lbl, size, st.editing?.id === t.id ? T.blue : T.ink, { f: 'sans', w: 600, max: w - 20 });
      hits.push({ kind: 'cnode', id: t.id, x, y, w, h: Math.min(h, size + Math.max(12, 24 * z)) });
    }
    function ghost(n, t, r) {
      const x = Math.round(r.x), y = Math.round(r.y), w = Math.round(r.w), h = Math.round(r.h), on = !!(n.flags & FLAG.SELECTED);
      if (w < 3 || h < 3) return;
      const rad = n.material ? T.radius : 2;
      g.fill(x, y, w, h, A(T.blue, 0.06), rad);
      g.dash(x, y, w, h, A(T.blue, on ? 1 : 0.7), on ? 2 : 1, n.material === 2 ? 10 : 6, rad);
      hits.push({ kind: 'cnode', id: t.id, x, y, w, h });
      if (n.material >= 1) {
        const owner = t.owner ? table.find(o => o.id === t.owner) : null, ip = n.material === 2 ? 14 : 6;
        g.text(x + ip, y + ip, owner ? 'reserved by ' + label(owner, st.notes, bindings) : 'reserved', n.material === 2 ? 12 : 10, T.blue, { f: 'sans', max: w - ip * 2 });
        if (n.material === 2) g.text(x + ip, y + ip + 18, 'room for work that is not here yet', 11, T.dim, { max: w - ip * 2 });
        if (on && h > 60) g.text(x + ip, y + h - ip - 14, '[N] fill with a note', 12, T.ink, { max: w - ip * 2 });
      }
    }
    function titleCard(n, t, r) {
      const x = Math.round(r.x), y = Math.round(r.y), w = Math.round(r.w), h = Math.round(r.h), on = !!(n.flags & FLAG.SELECTED), isNote = t.app === APP.NOTE;
      let fill = T.panel, fg = T.ink;
      if (n.status === 2) { fill = T.yellow; fg = T.onAccent; } else if (n.status === 3) { fill = T.red; fg = T.onAccent; }
      else if (n.status === 1) fill = mix(T.panel, T.blue, 0.16); else if (isNote) fill = mix(T.panel, T.yellow, 0.1);
      if (T.glass) g.glass(x, y, w, h, n.status >= 2 ? fill : white, Math.min(T.radius, 8), n.status >= 2 ? 0.82 : n.status === 1 || isNote ? 0.2 : 0.1, 8);
      else g.fill(x, y, w, h, fill, Math.min(T.radius, 4));
      g.stroke(x, y, w, h, n.status >= 2 ? fill : T.line, 1, Math.min(T.radius, 4));
      if (isNote) g.fill(x, y, 3, h, T.yellow);
      hits.push({ kind: 'cnode', id: t.id, x, y, w, h });
      const size = Math.max(9, Math.min(15, Math.round(h * 0.16))), ip = Math.max(5, Math.round(size * 0.6));
      if (!isNote) g.text(x + ip, y + ip, tag(t), Math.max(8, size - 3), n.status >= 2 ? fg : T.dim, { w: 600, max: w - ip * 2 });
      const top = isNote ? y + ip : y + ip + size + 2, lines = Math.max(1, Math.floor((y + h - ip - top) / (size * 1.3)));
      if (lines >= 1 && h > size + ip * 2) g.wrap(x + ip, top, text(t) || (isNote ? 'empty note' : ''), size, fg, w - ip * 2, lines, Math.round(size * 1.3), { f: 'sans', w: isNote ? 500 : 600 });
      if (t.progress > 0 && h > 30) { g.fill(x + 4, y + h - 6, w - 8, 3, T.faint, 2); g.fill(x + 4, y + h - 6, (w - 8) * t.progress / 100, 3, T.blue, 2); }
      if (on) g.stroke(x - 3, y - 3, w + 6, h + 6, T.ink, 2, Math.min(T.radius, 4) + 3);
    }
    function dotNode(n, t, r) {
      const s = Math.max(4, Math.round(Math.min(r.w, r.h))), w = Math.max(4, Math.round(r.w)), h = Math.max(4, Math.round(r.h)), x = Math.round(r.x), y = Math.round(r.y);
      const c = n.status ? statusColor(T, n.status) : t.app === APP.NOTE ? T.yellow : A(T.ink, 0.6);
      g.fill(x, y, w, h, c, Math.min(3, s / 3));
      if (n.flags & FLAG.SELECTED) g.stroke(x - 3, y - 3, w + 6, h + 6, T.ink, 2, 4);
      hits.push({ kind: 'cnode', id: t.id, x: x - 4, y: y - 4, w: w + 8, h: h + 8 });
    }
    // Orthogonal connector between two node rectangles (falls back to centres when an end is off screen).
    function connector(n, ra, rb) {
      const own = n.material === LINK_KIND.OWNER, on = !!(n.flags & FLAG.SELECTED);
      if (own && !(st.ghosts || on || z >= 0.35)) return;
      const c = own ? A(T.blue, on ? 0.9 : 0.55) : on ? T.ink : A(T.dim, 0.9), th = own || z < 0.5 ? 1 : 2;
      const a = { x: CA.x + n.x, y: CA.y + n.y }, b = { x: CA.x + n.w, y: CA.y + n.h }, horiz = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
      const seg = (x0, y0, x1, y1) => { // axis-aligned; dashed for ownership
        const len = Math.abs(x1 - x0) + Math.abs(y1 - y0), dx = Math.sign(x1 - x0), dy = Math.sign(y1 - y0);
        if (!own) return g.fill(Math.round(Math.min(x0, x1) - th / 2), Math.round(Math.min(y0, y1) - th / 2), Math.round(Math.abs(x1 - x0) + th), Math.round(Math.abs(y1 - y0) + th), c);
        for (let d = 0; d < len; d += 10) { const e = Math.min(len, d + 6); g.fill(Math.round(Math.min(x0 + dx * d, x0 + dx * e) - th / 2), Math.round(Math.min(y0 + dy * d, y0 + dy * e) - th / 2), Math.round(Math.abs(dx) * (e - d) + th), Math.round(Math.abs(dy) * (e - d) + th), c); }
      };
      let p0, p1;
      if (horiz) {
        const d = Math.sign(b.x - a.x) || 1;
        p0 = { x: ra ? (d > 0 ? ra.x + ra.w : ra.x) : a.x, y: a.y }; p1 = { x: rb ? (d > 0 ? rb.x : rb.x + rb.w) : b.x, y: b.y };
        const mx = (p0.x + p1.x) / 2; seg(p0.x, p0.y, mx, p0.y); seg(mx, p0.y, mx, p1.y); seg(mx, p1.y, p1.x, p1.y);
        if (!own) g.fill(Math.round(p1.x - (d > 0 ? 7 : 0)), Math.round(p1.y - 3.5), 7, 7, c, 2);
      } else {
        const d = Math.sign(b.y - a.y) || 1;
        p0 = { x: a.x, y: ra ? (d > 0 ? ra.y + ra.h : ra.y) : a.y }; p1 = { x: b.x, y: rb ? (d > 0 ? rb.y : rb.y + rb.h) : b.y };
        const my = (p0.y + p1.y) / 2; seg(p0.x, p0.y, p0.x, my); seg(p0.x, my, p1.x, my); seg(p1.x, my, p1.x, p1.y);
        if (!own) g.fill(Math.round(p1.x - 3.5), Math.round(p1.y - (d > 0 ? 7 : 0)), 7, 7, c, 2);
      }
      const lbl = !own && st.emeta?.[n.id]?.label;
      if (lbl && z >= 0.45) { const s = 11, lw = measure(lbl, s) + 10, mx = (p0.x + p1.x) / 2 - lw / 2, my = (p0.y + p1.y) / 2 - 9; g.fill(mx, my, lw, 18, T.bg, 4); g.text(mx + 5, my + 3, lbl, s, T.dim); }
    }
    function minimap(CA) {
      if (compact || !api.kijo_canvas_node_count()) return;
      // Everything already in view: a minimap would only cover part of it (Esc frames into the full area).
      const bb = canvasBounds(api), [ax, ay] = toScreen(api, bb[0], bb[1]), [bx1, by1] = toScreen(api, bb[0] + bb[2], bb[1] + bb[3]);
      if (ax >= 0 && ay >= 0 && bx1 <= CA.w && by1 <= CA.h) return;
      const mm = getScene(api, 'minimap'), frame = mm[0]; if (!frame || frame.w <= 0 || frame.h <= 0) return;
      const k = Math.min(210 / frame.w, 140 / frame.h), bw = Math.round(frame.w * k), bh = Math.round(frame.h * k);
      const bx = Math.round(CA.x + CA.w - bw - 18), by = Math.round(CA.y + CA.h - bh - 16);
      if (T.glass) g.glass(bx - 8, by - 8, bw + 16, bh + 16, white, 10, 0.14, 12); else { g.fill(bx - 8, by - 8, bw + 16, bh + 16, A(T.raised, 0.94), 8); g.stroke(bx - 8, by - 8, bw + 16, bh + 16, T.faint, 1, 8); }
      for (const n of mm.slice(1)) {
        const x = bx + n.x * k, y = by + n.y * k, w = Math.max(1.5, n.w * k), h = Math.max(1.5, n.h * k);
        if (n.kind === NODE.VIEWPORT) g.stroke(Math.round(x), Math.round(y), Math.max(4, Math.round(w)), Math.max(4, Math.round(h)), T.blue, 1.5, 2);
        else if (n.app === APP.GROUP) g.stroke(x, y, w, h, A(T.line, 0.8), 1, 2);
        else if (n.kind === NODE.GHOST) g.fill(x, y, w, h, A(T.blue, 0.35), 1);
        else g.fill(x, y, w, h, n.flags & FLAG.SELECTED ? T.ink : n.status ? statusColor(T, n.status) : n.app === APP.NOTE ? A(T.yellow, 0.8) : A(T.ink, 0.45), 1);
      }
      hits.push({ kind: 'minimap', x: bx, y: by, w: bw, h: bh, fw: frame.w, fh: frame.h });
    }
  }
}
