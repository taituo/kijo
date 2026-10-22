// Kijo shared core adapter — environment neutral (Node 22+, Chrome).
// No fs, no DOM. Hosts hand in WASM bytes and get typed scene access back.
// Layout, workspaces, selection, ownership and scene generation stay in WASM;
// this file only decodes ABI v2 structs and the persisted state schema.
export const KIND = { EMPTY: 0, REAL: 1, GHOST: 2 };
export const NODE = { SLOT: 1, TILE: 2, GHOST: 3, LINK: 4, EVENT: 5, WORKSPACE: 6, VIEWPORT: 7 };
// Same vocabulary as OSC 7501 (done = COMPLETE).
export const STATUS = ['idle', 'working', 'blocked', 'error', 'done'];
export const BLOCKED_KIND = ['', 'permission', 'question', 'auth'];
export const APP = { NONE: 0, SHELL: 1, AGENT: 2, METRICS: 3, REMOTE: 4, NOTE: 5, HERDR: 6, SYS: 7, SERIES: 8, LOGS: 9, TRACES: 10, SCENE3D: 11, GROUP: 12 };
export const VIEWS = ['focus', 'overview', 'back', 'timeline', 'workspaces'];
// Scene modes the core can build. The grid views come first (keys 1-5); 'canvas' is key 7, 'minimap' is an overlay.
export const SCENES = [...VIEWS, 'canvas', 'minimap'];
export const FLAG = { SELECTED: 1, IN_VIEWPORT: 2, ACTIVE_WS: 4, LOD_TITLE: 8, LOD_FULL: 16, LINK_FROM: 32 };
export const OP = { MOVEFOCUS: 1, WORKSPACE: 2, MOVETOWORKSPACE: 3, KILLACTIVE: 4, TOGGLESPECIAL: 5, SWAP: 6, JUMPFOCUS: 7, CYCLEWORKSPACE: 8 };
export const DIR = { left: 0, right: 1, up: 2, down: 3 };
export const EVENT = ['', 'spawn', 'close', 'promote', 'status', 'workspace', 'move', 'reset'];
export const SIDE = 6, SCALE = 6000, SPECIAL = 9;
const TILE_SIZE = 10, NODE_SIZE = 15, EVENT_SIZE = 5;
const TILE_FIELDS = ['id', 'kind', 'status', 'owner', 'group', 'tx', 'flags', 'app', 'progress', 'blockedKind'];
const NODE_FIELDS = ['kind', 'id', 'x', 'y', 'w', 'h', 'status', 'owner', 'group', 'flags', 'material', 'shader', 'meta', 'app', 'progress'];
const EVENT_FIELDS = ['seq', 'op', 'id', 'a', 'b'];

export async function instantiateCore(bytes) {
  const { instance } = await WebAssembly.instantiate(bytes);
  const api = instance.exports;
  if (api.kijo_version() !== 2) throw new Error('Unsupported Kijo scene ABI');
  api.kijo_reset();
  return api;
}

const ints = (api, pointer, count) => new Int32Array(api.memory.buffer, pointer, count);
function decode(raw, size, fields, count) {
  return Array.from({ length: count }, (_, i) => Object.fromEntries(fields.map((k, j) => [k, raw[i * size + j]])));
}
// ws omitted = the active workspace (0..8, 9 = special scratchpad).
export const activeWs = api => (api.kijo_special_open() ? SPECIAL : api.kijo_ws());
export function getTiles(api, ws) {
  const n = api.kijo_tile_count();
  const ptr = ws === undefined ? api.kijo_tile_ptr() : api.kijo_ws_tile_ptr(ws);
  return decode(ints(api, ptr, n * TILE_SIZE), TILE_SIZE, TILE_FIELDS, n);
}
export function getScene(api, view) {
  const mode = typeof view === 'string' ? SCENES.indexOf(view) : view;
  if (mode < 0 || mode >= SCENES.length) throw new Error('Unknown view: ' + view);
  api.kijo_build_scene(mode);
  const n = api.kijo_node_count();
  return decode(ints(api, api.kijo_node_ptr(), n * NODE_SIZE), NODE_SIZE, NODE_FIELDS, n);
}
export const selectedTile = api => getTiles(api)[api.kijo_sel_y() * SIDE + api.kijo_sel_x()];
// The core's own event ring, oldest first. `since` = last seq seen + 1.
export function getEvents(api, since = 0) {
  const total = api.kijo_event_total(), cap = api.kijo_event_capacity();
  const from = Math.max(since, total - cap), raw = ints(api, api.kijo_event_ptr(), cap * EVENT_SIZE), out = [];
  for (let s = from; s < total; s++) {
    const o = (s % cap) * EVENT_SIZE;
    out.push(Object.fromEntries(EVENT_FIELDS.map((k, j) => [k, raw[o + j]])));
  }
  return out;
}
export const dispatch = (api, op, a = 0, b = 0) => api.kijo_dispatch(OP[String(op).toUpperCase()] ?? op, a, b);

// ---- canvas tables (core/canvas.c). A canvas node is a tile (same fields) plus a world rectangle;
// table order is z-order. Ids start at CANVAS_ID0, so status/close by id work for both.
export const CANVAS_ID0 = 1000000, Q16 = 65536;
export const LOD = { DOT: 0, TITLE: 1, FULL: 2 };
export const LINK_KIND = { EDGE: 1, OWNER: 2 };
const CNODE_SIZE = 14, CEDGE_SIZE = 4;
const CNODE_FIELDS = [...TILE_FIELDS, 'x', 'y', 'w', 'h'], CEDGE_FIELDS = ['id', 'from', 'to', 'flags'];
export const getCanvasNodes = api => decode(ints(api, api.kijo_canvas_node_ptr(), api.kijo_canvas_node_count() * CNODE_SIZE), CNODE_SIZE, CNODE_FIELDS, api.kijo_canvas_node_count());
export const getCanvasEdges = api => decode(ints(api, api.kijo_canvas_edge_ptr(), api.kijo_canvas_edge_count() * CEDGE_SIZE), CEDGE_SIZE, CEDGE_FIELDS, api.kijo_canvas_edge_count());
export const canvasNode = (api, id) => (id ? getCanvasNodes(api).find(n => n.id === id) ?? null : null);
export const selectedNode = api => canvasNode(api, api.kijo_canvas_sel());
export const cqRead = (api, n) => Array.from(ints(api, api.kijo_canvas_qbuf_ptr(), Math.max(0, n)));
export function serializeCanvas(api) {
  return { nodes: getCanvasNodes(api), edges: getCanvasEdges(api), cam: { x: api.kijo_canvas_cam_x(), y: api.kijo_canvas_cam_y(), z: api.kijo_canvas_zoom() }, sel: api.kijo_canvas_sel() };
}
// Call after kijo_clear. Without a saved canvas the demo document is seeded instead.
export function restoreCanvas(api, c) {
  if (!c || !Array.isArray(c.nodes)) { api.kijo_canvas_seed(); return false; }
  for (const n of c.nodes) api.kijo_canvas_restore_node(n.id, n.kind, n.status, n.owner, n.group, n.tx, n.flags, n.app, n.progress, n.blockedKind, n.x, n.y, n.w, n.h);
  for (const e of c.edges || []) api.kijo_canvas_restore_edge(e.id, e.from, e.to, e.flags);
  if (c.cam) api.kijo_canvas_look(c.cam.x | 0, c.cam.y | 0, c.cam.z | 0, 1);
  if (c.sel) api.kijo_canvas_select(c.sel);
  return true;
}

// Persisted schema v2 is identical for terminal, browser and daemon hosts.
// Notes (free text) live outside the core, keyed by tile id.
export function serializeState(api, notes = {}, extra = {}) {
  const ws = Array.from({ length: 10 }, (_, w) => ({ tiles: getTiles(api, w) }));
  const saved = { active: api.kijo_ws(), special: api.kijo_special_open() };
  const views = ws.map((_, w) => w); // selection is read per active ws, see below
  const sel = [];
  const wasW = api.kijo_ws(), wasS = api.kijo_special_open();
  for (const w of views) {
    api.kijo_restore_active(w === SPECIAL ? wasW : w, w === SPECIAL ? 1 : 0);
    sel.push([api.kijo_sel_x(), api.kijo_sel_y()]);
  }
  api.kijo_restore_active(wasW, wasS);
  ws.forEach((w, i) => (w.sel = sel[i]));
  return { version: 2, ...saved, workspaces: ws, notes, canvas: serializeCanvas(api), ...extra };
}
export function applyState(api, state) {
  if (!state || state.version !== 2 || !Array.isArray(state.workspaces) || state.workspaces.length !== 10) throw new Error('Wrong schema');
  api.kijo_clear();
  state.workspaces.forEach((w, ws) => {
    if (!Array.isArray(w.tiles) || w.tiles.length !== SIDE * SIDE) throw new Error('Wrong schema');
    w.tiles.forEach((t, i) => api.kijo_restore_tile(ws, i, t.id, t.kind, t.status, t.owner, t.group, t.tx, t.flags, t.app, t.progress, t.blockedKind));
    api.kijo_restore_view(ws, ...(w.sel || [2, 2]));
  });
  api.kijo_restore_active(state.active, state.special);
  // Saved before the canvas existed: keep the grid as it was and seed the demo canvas next to it.
  return restoreCanvas(api, state.canvas) ? state.notes || {} : { ...CANVAS_NOTES, ...(state.notes || {}) };
}

// Demo text for the fixed bulletin-board tiles created by kijo_reset.
// Which series a chart tile shows (string or up to 3 names). Tiles without an entry are unbound.
export const CANVAS_BINDINGS = { 1000005: 'browser.fps' };
export const DEFAULT_BINDINGS = {
  8: 'browser.fps', 9: 'browser.draw_ms', 10: 'browser.loop_lag_ms', 11: 'browser.cmds',
  13: 'cpu.util_pct', 14: 'mem.used_pct', 15: ['net.rx_kbps', 'net.tx_kbps'], 20: 'cpu.util_pct', 21: ['browser.draw_ms', 'browser.loop_lag_ms'],
  ...CANVAS_BINDINGS,
};
// Put a new tile on the empty slot nearest the selection (same workspace) and select it.
export function placeTile(api, app) {
  const ts = getTiles(api), sx = api.kijo_sel_x(), sy = api.kijo_sel_y();
  let best = -1, bd = 99;
  ts.forEach((t, i) => { if (t.kind !== KIND.EMPTY) return; const d = Math.abs(i % SIDE - sx) + Math.abs(Math.floor(i / SIDE) - sy); if (d < bd) { bd = d; best = i; } });
  if (best < 0) return 0;
  api.kijo_select(best % SIDE, Math.floor(best / SIDE));
  return api.kijo_spawn(app, 1, 1, 0);
}
// Text of the demo canvas (kijo_canvas_seed): group labels and notes, keyed by the seeded ids.
export const CANVAS_NOTES = {
  1000000: 'Canvas: the same tiles, in continuous space',
  1000001: 'The 6x6 grid was one layout. Here the same tiles, ghosts and status live on an unbounded canvas.',
  1000002: 'Zoom out and cards become titles, then dots. The core decides the level of detail; hosts only draw.',
  1000007: 'Agents put work next to what it relates to: near, right of, below. A dashed ghost is room an agent has reserved.',
  1000008: 'Far away',
  1000009: 'Still the same canvas. Esc frames everything, Enter flies to the selection.',
};
export const DEFAULT_NOTES = { 5: 'Problem: tiling managers stretch neighbours', 6: 'Idea: ghosts reserve space, owners clean up', 7: 'Pin anything. No agent needed.', ...CANVAS_NOTES };

// Semantic naming of tiles by app type. Hosts may override per adapter.
export function label(t, notes = {}, bindings = {}) {
  if (t.app === APP.SHELL) return 'LOCAL SHELL';
  if (t.app === APP.AGENT) return 'AGENT / demo';
  if (t.app === APP.METRICS) return 'HOST METRICS';
  if (t.app === APP.REMOTE) return 'REMOTE / unset';
  if (t.app === APP.HERDR) return 'HERDR SESSION';
  if (t.app === APP.SYS) return 'SYSTEM';
  if (t.app === APP.SERIES) { const b = bindings[t.id]; return b ? [].concat(b)[0].replace(/\{.*$/, '') : 'CHART / unbound'; }
  if (t.app === APP.LOGS) return 'LOGS';
  if (t.app === APP.TRACES) return 'TRACES';
  if (t.app === APP.SCENE3D) return '3D SURFACE';
  if (t.app === APP.GROUP) return String(notes[t.id] ?? 'GROUP').slice(0, 60);
  return String(notes[t.id] ?? `NOTE ${t.id}`).slice(0, 40);
}
export const tag = t => ['', 'SHELL', 'AGENT', 'HOST', 'SSH', 'NOTE', 'HERDR', 'SYS', 'CHART', 'LOGS', 'TRACE', '3D', 'GROUP'][t.app] || '';

// ---------------------------------------------------------------------------
// Host-independent key handling. Every host maps its raw input to these names:
//   digits 1-5 views, arrows, shift+arrows (swap), enter, comma/period, etc.
// Shell takeover (p/o) is host specific and stays in the host.
// ui = { view, ghosts, notes, events }.  Returns true when the key was consumed.
export function handleKeyName(api, ui, key) {
  ui.bindings ??= {};
  const t = selectedTile(api);
  const log = e => ui.events.push(e);
  if (key === '7') { ui.view = 'canvas'; return true; }
  if (ui.view === 'canvas' && canvasKey(api, ui, key, log)) return true;
  const arrows = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
  const swaps = { 'Shift+ArrowLeft': 'left', 'Shift+ArrowRight': 'right', 'Shift+ArrowUp': 'up', 'Shift+ArrowDown': 'down' };
  if (['1', '2', '3', '4', '5'].includes(key)) ui.view = VIEWS[Number(key) - 1];
  else if (key === '6' && ui.flow !== false) ui.view = 'flow'; // host-only view (no WASM scene): injectors -> series -> tiles
  else if (arrows[key]) {
    if (ui.view === 'workspaces') { if (key === 'ArrowRight') dispatch(api, 'CYCLEWORKSPACE', 1); else if (key === 'ArrowLeft') dispatch(api, 'CYCLEWORKSPACE', -1); else if (key === 'ArrowDown') dispatch(api, 'CYCLEWORKSPACE', 1); else dispatch(api, 'CYCLEWORKSPACE', -1); }
    else dispatch(api, 'MOVEFOCUS', DIR[arrows[key]]);
  } else if (swaps[key]) dispatch(api, 'SWAP', DIR[swaps[key]]);
  else if (key === 'Enter') ui.view = ui.view === 'workspaces' ? 'overview' : ui.view === 'overview' ? 'focus' : ui.view;
  else if (key === 'Escape') { if (ui.zoom) ui.zoom = false; else ui.view = ui.view === 'focus' ? 'overview' : ui.view === 'overview' ? 'workspaces' : ui.view; }
  else if (key === 'z') ui.zoom = !ui.zoom;
  else if (key === ',' || key === '.') dispatch(api, 'CYCLEWORKSPACE', key === '.' ? 1 : -1);
  else if (key === 's') dispatch(api, 'TOGGLESPECIAL');
  else if (key === 'm') { const to = (api.kijo_ws() + 1) % 9; if (dispatch(api, 'MOVETOWORKSPACE', to)) log(`Moved tile #${t.id} to workspace ${to + 1}`); }
  else if (key === 'g') ui.ghosts = !ui.ghosts;
  else if (key === 'r') { api.kijo_reset(); ui.notes = { ...DEFAULT_NOTES }; ui.bindings = { ...DEFAULT_BINDINGS }; ui.viz = {}; ui.cids = {}; ui.cmeta = {}; ui.emeta = {}; log('Reset'); }
  else if (key === 'n') {
    const id = t.kind === KIND.GHOST ? api.kijo_promote_ghost(api.kijo_sel_x(), api.kijo_sel_y()) : t.kind === KIND.EMPTY ? api.kijo_spawn(APP.NOTE, 1, 1, 0) : 0;
    if (id) { ui.notes[id] = `Note ${id}`; log(`New note #${id} at ${api.kijo_sel_x()},${api.kijo_sel_y()}`); }
  } else if (key === 'f') {
    for (const corner of [0, 1, 2, 3]) {
      const id = api.kijo_spawn(APP.NOTE, 2, 2, corner);
      if (id) { ui.notes[id] = `Note ${id}`; log(`New 2x2 footprint note #${id}`); break; }
    }
  } else if (key === 'x') { if (t.kind === KIND.REAL && dispatch(api, 'KILLACTIVE')) { log(`Closed tile #${t.id}; owned ghosts cleaned`); delete ui.notes[t.id]; delete ui.bindings[t.id]; if (ui.viz) delete ui.viz[t.id]; } }
  else if (key === 't') { if (t.kind === KIND.REAL) { api.kijo_report(t.id, (t.status + 1) % 5, 1, 40); log(`Demo status change for tile #${t.id}`); } }
  else return false;
  return true;
}

// Canvas keys: the same verbs as the grid, in continuous space. Arrows pick the nearest node in that
// direction, Enter flies to it, Esc frames everything; N, F, X, T, E mean what they mean on the grid.
const NOTE_W = 260, NOTE_H = 170;
function canvasKey(api, ui, key, log) {
  const id = api.kijo_canvas_sel(), n = canvasNode(api, id);
  const arrows = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
  const nudge = { 'Shift+ArrowLeft': [-1, 0], 'Shift+ArrowRight': [1, 0], 'Shift+ArrowUp': [0, -1], 'Shift+ArrowDown': [0, 1] };
  if (arrows[key]) { api.kijo_canvas_focus(DIR[arrows[key]]); return true; }
  if (nudge[key]) { if (n) api.kijo_canvas_move(id, n.x + nudge[key][0] * 40, n.y + nudge[key][1] * 40); return true; }
  if (key === 'Enter') { if (id) api.kijo_canvas_fly(id); return true; }
  if (key === 'Escape' || key === '0') { api.kijo_canvas_fit(); return true; }
  if (key === '+' || key === '=' || key === '-') { api.kijo_canvas_zoom_at(-1, -1, key === '-' ? Q16 * 4 / 5 : Q16 * 5 / 4); return true; }
  if (key === 'n') {
    const nid = n && n.kind === KIND.GHOST ? api.kijo_canvas_fill(id, APP.NOTE) : api.kijo_canvas_place(APP.NOTE, n ? id : 0, -1, NOTE_W, NOTE_H);
    if (nid) { ui.notes[nid] = `Note ${nid}`; api.kijo_canvas_select(nid); log(`New note #${nid} on the canvas`); }
    return true;
  }
  if (key === 'f') { // reserve room next to the selection, owned by it (the grid's footprint, in space)
    const gid = n && n.kind === KIND.REAL ? api.kijo_canvas_reserve_near(id, id, -1, n.w, n.h) : api.kijo_canvas_reserve_near(0, n ? id : 0, -1, NOTE_W, NOTE_H);
    if (gid) { api.kijo_canvas_select(gid); log(`Reserved #${gid}${n && n.kind === KIND.REAL ? ' for #' + id : ''}`); }
    return true;
  }
  if (key === 'x') { if (id && api.kijo_close(id)) { log(`Closed #${id}; owned ghosts and links removed`); delete ui.notes[id]; delete ui.bindings[id]; if (ui.viz) delete ui.viz[id]; } return true; }
  if (key === 't') { if (n && n.kind === KIND.REAL) api.kijo_report(id, (n.status + 1) % 5, 1, 40); return true; }
  if (key === 'l') { // link: mark the source, move, press L again on the target
    const from = api.kijo_canvas_marked();
    if (!from && id) api.kijo_canvas_mark(id);
    else if (from && id && from !== id) { if (api.kijo_canvas_link(from, id)) log(`Linked #${from} -> #${id}`); api.kijo_canvas_mark(0); }
    else api.kijo_canvas_mark(0);
    return true;
  }
  return false;
}
