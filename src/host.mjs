#!/usr/bin/env node
// Kijo Native Terminal Host — no DOM, Canvas, or browser dependencies.
// Layout, workspaces, selection and ownership live in WASM (core.mjs decodes it).
// This host interprets the scene graph for ANSI/SSH; the Chrome/WebGPU host reads the same scene.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, hostname, uptime, freemem, totalmem, loadavg, platform, arch } from 'node:os';
import { spawn } from 'node:child_process';
import process from 'node:process';
import {
  instantiateCore, getTiles, getScene, getEvents, serializeState, applyState, selectedTile, dispatch, handleKeyName,
  label, tag, KIND, NODE, STATUS, BLOCKED_KIND, VIEWS, APP, FLAG, SIDE, DIR, OP, DEFAULT_NOTES, getCanvasNodes,
} from './core.mjs';
export { getTiles, getScene, KIND, STATUS, VIEWS };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wasmPath = resolve(root, 'core/scene.wasm');
const rawFile = process.env.KIJO_STATE_FILE || resolve(process.env.XDG_STATE_HOME || resolve(homedir(), '.local/state'), 'kijo/state.json');

export async function loadCore() {
  // Binary locally or portable base64 artifact committed to GitHub.
  const bytes = existsSync(wasmPath) ? readFileSync(wasmPath) : Buffer.from(readFileSync(wasmPath + '.b64', 'utf8').trim(), 'base64');
  return instantiateCore(bytes);
}
export function persist(api, notes = {}, stateFile = rawFile) {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(serializeState(api, notes), null, 2));
}
export function restore(api, stateFile = rawFile) {
  if (!existsSync(stateFile)) return { ...DEFAULT_NOTES };
  try { return applyState(api, JSON.parse(readFileSync(stateFile, 'utf8'))); }
  catch (err) { console.error('Ignoring invalid saved state:', err.message); return { ...DEFAULT_NOTES }; }
}

const clean = s => String(s).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/[^\x20-\x7e]/g, '?');
const MARK = { idle: '.', working: '*', blocked: '!', error: 'x', done: '+' };
class Surface {
  constructor(w, h) { this.w = w; this.h = h; this.rows = Array.from({ length: h }, () => Array(w).fill(' ')); }
  put(x, y, s) { if (y < 0 || y >= this.h) return; [...clean(s)].forEach((c, j) => { if (x + j >= 0 && x + j < this.w) this.rows[y][x + j] = c; }); }
  box(x, y, w, h, selected = false, ghost = false) {
    const ch = ghost ? '.' : '-', side = selected ? '#' : '|';
    if (w < 3 || h < 2) return;
    this.put(x, y, '+' + ch.repeat(w - 2) + '+'); this.put(x, y + h - 1, '+' + ch.repeat(w - 2) + '+');
    for (let row = y + 1; row < y + h - 1; row++) { this.put(x, row, side); this.put(x + w - 1, row, side); }
  }
  toString() { return this.rows.map(r => r.join('').trimEnd()).join('\n'); }
}

// Workspace pills for the bar: [1]* 2 3! ... attention mark comes from the core's own summary.
export function barText(api) {
  const ws = getScene(api, 'workspaces');
  const cur = api.kijo_special_open() ? -1 : api.kijo_ws();
  return ws.map(n => `${n.meta === cur ? '[' : ' '}${n.meta + 1}${n.id || n.group ? MARK[STATUS[n.status]] : ' '}${n.meta === cur ? ']' : ' '}`).join('') +
    (api.kijo_special_open() ? ' [special]' : '');
}

export function render(api, { view = 'focus', cols = 106, rows = 35, ghosts = true, notes = {}, events = [], connected = false } = {}) {
  cols = Math.max(52, Math.min(240, cols)); rows = Math.max(18, Math.min(80, rows));
  const surf = new Surface(cols, rows);
  // Canvas: the core lays out a viewport of cells x 8 by cells x 16 "pixels"; one character is one cell.
  // No animation in a terminal: land on the camera target before the scene is built.
  if (view === 'canvas') { api.kijo_canvas_viewport((cols - 4) * 8, (rows - 9) * 16); api.kijo_canvas_step(1000); }
  const scene = getScene(api, view), tiles = getTiles(api);
  const now = new Date().toLocaleTimeString('en-GB', { hour12: false });
  surf.put(1, 0, `KIJO ${barText(api)}`);
  surf.put(Math.max(1, cols - 44), 0, `${view.toUpperCase()}  ${connected ? 'REMOTE' : 'LOCAL'}  ABI 2  ${now}`);
  surf.put(1, 1, '='.repeat(cols - 2));
  const x0 = 2, y0 = 3, maxW = cols - 4, maxH = rows - 9;
  const sx = api.kijo_sel_x(), sy = api.kijo_sel_y();
  const metrics = `${hostname()}  ${platform()}/${arch()}  uptime ${Math.floor(uptime() / 60)}m  RAM ${Math.round((1 - freemem() / totalmem()) * 100)}%  load ${loadavg()[0].toFixed(2)}`;
  const detail = (x, y, t) => {
    if (t.app === APP.SHELL) { surf.put(x, y, 'Native shell adapter'); surf.put(x, y + 1, '[P] open actual local shell'); }
    else if (t.app === APP.AGENT) { surf.put(x, y, 'SIMULATED agent / not running'); surf.put(x, y + 1, '[T] change test state'); }
    else if (t.app === APP.METRICS) { surf.put(x, y, `Host CPU load: ${loadavg()[0].toFixed(2)}`); surf.put(x, y + 1, `System memory: ${Math.round((1 - freemem() / totalmem()) * 100)}%`); }
    else if (t.app === APP.REMOTE) { surf.put(x, y, 'SSH target not configured'); surf.put(x, y + 1, 'KIJO_SSH_HOST=host  [O] attach'); }
    else if (t.app >= APP.SYS) { surf.put(x, y, `${tag(t).toLowerCase()} tile`); surf.put(x, y + 1, 'drawn by the browser host (open kijo.html)'); }
    else surf.put(x, y, 'Pinned note / saved to state file');
  };
  if (view === 'focus') {
    const gap = 2, cw = Math.floor((maxW - gap) / 2), ch = Math.floor((maxH - gap) / 2);
    for (const n of scene) {
      const x = x0 + Math.floor(n.x / 3000) * (cw + gap), y = y0 + Math.floor(n.y / 3000) * (ch + gap), sel = !!(n.flags & FLAG.SELECTED), t = tiles[n.meta];
      surf.box(x, y, cw, ch, sel, n.kind === NODE.GHOST && ghosts);
      if (n.kind === NODE.GHOST && ghosts) {
        surf.put(x + 2, y + 1, `GHOST   / reserved by #${n.owner}`); surf.put(x + 2, y + 3, `group ${n.group} / no visual payload`); surf.put(x + 2, y + 5, '[N] promote to independent note');
      } else if (n.kind === NODE.TILE) {
        surf.put(x + 2, y + 1, `${sel ? '* ' : ''}${label(t, notes)}`);
        const blocked = t.status === 2 && t.blockedKind ? ` (${BLOCKED_KIND[t.blockedKind]})` : '', prog = t.progress ? ` ${t.progress}%` : '';
        surf.put(x + 2, y + 3, `state / ${STATUS[t.status]}${blocked}${prog}`);
        detail(x + 2, y + 5, t);
      } else if (n.kind === NODE.SLOT && ghosts) surf.put(x + 2, y + 1, `${sel ? '* ' : ''}EMPTY SLOT  [N] note  [F] 2x2 footprint`);
    }
    surf.put(2, rows - 6, `ws ${api.kijo_ws() + 1}  viewport (${api.kijo_focus_x()},${api.kijo_focus_y()}) / 2x2  selected (${sx},${sy})`);
  } else if (view === 'overview') {
    const gap = 1, cw = Math.floor((maxW - 5 * gap) / 6), ch = Math.max(3, Math.floor((maxH - 5 * gap) / 6));
    for (const n of scene) {
      const tx = n.meta % 6, ty = Math.floor(n.meta / 6), x = x0 + tx * (cw + gap), y = y0 + ty * (ch + gap), t = tiles[n.meta];
      surf.box(x, y, cw, ch, !!(n.flags & FLAG.SELECTED), n.kind === NODE.GHOST && ghosts);
      if (n.kind === NODE.TILE) {
        surf.put(x + 1, y + 1, `${tag(t)} ${t.id}`.slice(0, cw - 2));
        if (ch > 3) surf.put(x + 1, y + 2, STATUS[t.status].slice(0, cw - 2));
      } else if (n.kind === NODE.GHOST && ghosts) surf.put(x + 1, y + 1, `g:${n.owner}`);
      if ((n.flags & FLAG.IN_VIEWPORT) && n.kind !== NODE.TILE) surf.put(x + cw - 2, y, '~');
    }
    surf.put(2, rows - 6, `6x6 / real ${tiles.filter(t => t.kind === 1).length}  ghost ${tiles.filter(t => t.kind === 2).length}  select ${sx},${sy}  [ENTER] focus`);
  } else if (view === 'workspaces') {
    const gap = 2, cw = Math.floor((maxW - 2 * gap) / 3), ch = Math.floor((maxH - 2 * gap) / 3);
    for (const n of scene) {
      const x = x0 + (n.meta % 3) * (cw + gap), y = y0 + Math.floor(n.meta / 3) * (ch + gap), cur = !!(n.flags & FLAG.ACTIVE_WS);
      surf.box(x, y, cw, ch, cur);
      surf.put(x + 2, y + 1, `WORKSPACE ${n.meta + 1}${cur ? '  (active)' : ''}`);
      surf.put(x + 2, y + 2, `${n.id} tiles  ${n.group} ghosts  ${STATUS[n.status]}${n.progress ? ' ' + n.progress + '%' : ''}`);
      // mini heatmap of the real 6x6 layout of that workspace
      const mini = getTiles(api, n.meta);
      for (let r = 0; r < 6 && y + 4 + r < y + ch - 1; r++)
        surf.put(x + 2, y + 4 + r, mini.slice(r * 6, r * 6 + 6).map(t => (t.kind === 1 ? MARK[STATUS[t.status]] === '.' ? '#' : MARK[STATUS[t.status]] : t.kind === 2 ? ':' : '.')).join(' '));
    }
    surf.put(2, rows - 6, '[arrows] none  [,][.] switch workspace  [m] move tile to next ws  [s] special  [ENTER] open');
  } else if (view === 'back') {
    surf.put(3, 4, 'RENDER TREE / actual WebAssembly scene nodes');
    surf.put(3, 6, 'SOURCE                    CONNECTION                  SINK');
    surf.put(3, 7, '-----------------------------------------------------------------');
    let offset = 8;
    for (const n of scene.filter(n => n.kind === NODE.TILE)) surf.put(3, offset++, `${label(tiles[n.meta], notes).padEnd(25)}  -->  ${`group ${n.group}`.padEnd(22)}${STATUS[n.status]}`);
    offset += 2;
    for (const n of scene.filter(n => n.kind === NODE.LINK).slice(0, 8)) surf.put(3, offset++, `GHOST SLOT ${String(n.meta).padStart(2)}             --owner--> TILE #${n.owner} / group ${n.group}`);
    surf.put(3, rows - 6, 'Connector graph: structured/inspectable. Actual backend integration not connected.');
  } else if (view === 'timeline') {
    surf.put(3, 4, 'EVENT LOG / WASM event ring + host events');
    surf.put(3, 5, '-------------------------------------------------------');
    const core = getEvents(api).map(e => `#${String(e.seq).padStart(3)} ${['', 'spawn', 'close', 'promote', 'status', 'workspace', 'move', 'reset'][e.op].padEnd(9)} tile ${e.id} a=${e.a} b=${e.b}`);
    const live = scene.map(n => `Tile #${n.id}   state ${STATUS[n.status]}  tx-group ${n.group}`);
    [...core, ...events, ...live].slice(-Math.max(1, rows - 14)).forEach((e, i) => surf.put(3, 7 + i, e));
  } else if (view === 'canvas') {
    const table = getCanvasNodes(api), cell = n => ({ x: x0 + Math.round(n.x / 8), y: y0 + Math.round(n.y / 16), w: Math.round(n.w / 8), h: Math.round(n.h / 16) });
    const inside = (x, y) => x >= x0 && x < x0 + maxW && y >= y0 && y < y0 + maxH;
    const clip = (x, y, s) => { [...s].forEach((c, j) => { if (inside(x + j, y)) surf.put(x + j, y, c); }); };
    for (const n of scene) {
      const t = table[n.meta], r = cell(n);
      if (n.kind === NODE.LINK || !t) continue;
      const sel = !!(n.flags & FLAG.SELECTED), ghost = n.kind === NODE.GHOST;
      if (r.w >= 3 && r.h >= 2) {
        const top = '+' + (ghost ? '.' : '-').repeat(r.w - 2) + '+', side = sel ? '#' : t.app === APP.GROUP ? ':' : '|';
        clip(r.x, r.y, top); clip(r.x, r.y + r.h - 1, top);
        for (let yy = r.y + 1; yy < r.y + r.h - 1; yy++) { clip(r.x, yy, side); clip(r.x + r.w - 1, yy, side); }
        const title = ghost ? 'reserved' : t.app === APP.NOTE || t.app === APP.GROUP ? String(notes[t.id] ?? '') : label(t, notes);
        if (r.h >= 3) clip(r.x + 2, r.y + 1, (sel ? '* ' : '') + title.slice(0, Math.max(0, r.w - 4 - (sel ? 2 : 0))));
        if (r.h >= 4 && t.app !== APP.GROUP && !ghost) clip(r.x + 2, r.y + 2, `${tag(t)} ${STATUS[t.status]}`.slice(0, Math.max(0, r.w - 4)));
      } else clip(r.x, r.y, sel ? '#' : ghost ? ':' : MARK[STATUS[t.status]] === '.' ? 'o' : MARK[STATUS[t.status]]);
    }
    surf.put(2, rows - 6, `canvas  zoom ${Math.round(api.kijo_canvas_zoom() / 655.36)}%  ${table.length} nodes  arrows move  enter fly  esc fit  + - zoom  n note  f reserve  l link`);
  }
  surf.put(1, rows - 4, '-'.repeat(cols - 2));
  surf.put(2, rows - 3, metrics.slice(0, cols - 4));
  surf.put(2, rows - 2, '[1-5,7] views  [arrows] move  [shift+arrows] swap  [,][.] ws  [n] note  [f] 2x2  [x] close  [m] to ws  [s] special  [t] state  [g] ghosts  [r] reset  [q] quit'.slice(0, cols - 4));
  return surf.toString();
}

async function shellTakeover(command, args, context) {
  if (!process.stdin.isTTY) return;
  process.stdin.setRawMode(false); process.stdin.pause();
  process.stdout.write('\x1b[?1049l\x1b[0m');
  await new Promise(done => {
    const child = spawn(command, args, { stdio: 'inherit', env: process.env });
    child.on('error', e => { console.error(e.message); done(); }); child.on('exit', done);
  });
  process.stdin.setRawMode(true); process.stdin.resume();
  process.stdout.write('\x1b[?1049h');
  context.events.push(`${new Date().toISOString()} Returned from ${command}`);
}

const NAMES = { '\x1b[A': 'ArrowUp', '\x1b[B': 'ArrowDown', '\x1b[C': 'ArrowRight', '\x1b[D': 'ArrowLeft',
  '\x1b[1;2A': 'Shift+ArrowUp', '\x1b[1;2B': 'Shift+ArrowDown', '\x1b[1;2C': 'Shift+ArrowRight', '\x1b[1;2D': 'Shift+ArrowLeft', '\r': 'Enter', '\x1b': 'Escape' };

// Terminal keys map to the shared key names; only shell takeover is terminal specific.
export async function handleKey(api, opts, key) {
  const t = selectedTile(api);
  if (key === 'p' && t.app === APP.SHELL) await shellTakeover(process.env.SHELL || '/bin/sh', [], opts);
  else if (key === 'o' && t.app === APP.REMOTE && process.env.KIJO_SSH_HOST) await shellTakeover('ssh', ['-t', process.env.KIJO_SSH_HOST], opts);
  else handleKeyName(api, opts, NAMES[key] || key);
}

export async function main(argv = process.argv.slice(2)) {
  const api = await loadCore();
  const opts = { view: 'focus', flow: false, ghosts: true, notes: { ...DEFAULT_NOTES }, events: [] };
  if (!argv.includes('--fresh')) opts.notes = restore(api);
  const viewArg = argv.indexOf('--view'); if (viewArg >= 0 && (VIEWS.includes(argv[viewArg + 1]) || argv[viewArg + 1] === 'canvas')) opts.view = argv[viewArg + 1];
  if (argv.includes('--once') || !process.stdin.isTTY) { console.log(render(api, { ...opts, cols: process.stdout.columns || 106, rows: process.stdout.rows || 35 })); return; }
  const redraw = () => process.stdout.write('\x1b[H\x1b[2J' + render(api, { ...opts, cols: process.stdout.columns, rows: process.stdout.rows }));
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  redraw();
  const quit = () => { persist(api, opts.notes); process.stdin.setRawMode(false); process.stdout.write('\x1b[?25h\x1b[?1049l'); process.exit(0); };
  process.on('SIGTERM', quit);
  process.stdin.on('data', async key => {
    if (key === '\u0003' || key === 'q') { quit(); return; }
    await handleKey(api, opts, key);
    persist(api, opts.notes); redraw();
  });
  process.stdout.on('resize', redraw);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e); process.exitCode = 1; });
