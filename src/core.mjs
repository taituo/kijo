// Kijo shared core adapter — environment neutral (Node 22+, Chrome).
// No fs, no DOM. Hosts hand in WASM bytes and get typed scene access back.
// Layout, workspaces, selection, ownership and scene generation stay in WASM;
// this file only decodes ABI v2 structs and the persisted state schema.
export const KIND = { EMPTY: 0, REAL: 1, GHOST: 2 };
export const NODE = { SLOT: 1, TILE: 2, GHOST: 3, LINK: 4, EVENT: 5, WORKSPACE: 6 };
// Same vocabulary as OSC 7501 (done = COMPLETE).
export const STATUS = ['idle', 'working', 'blocked', 'error', 'done'];
export const BLOCKED_KIND = ['', 'permission', 'question', 'auth'];
export const APP = { NONE: 0, SHELL: 1, AGENT: 2, METRICS: 3, REMOTE: 4, NOTE: 5, HERDR: 6, SYS: 7, SERIES: 8, LOGS: 9, TRACES: 10 };
export const VIEWS = ['focus', 'overview', 'back', 'timeline', 'workspaces'];
export const FLAG = { SELECTED: 1, IN_VIEWPORT: 2, ACTIVE_WS: 4 };
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
  const mode = typeof view === 'string' ? VIEWS.indexOf(view) : view;
  if (mode < 0 || mode >= VIEWS.length) throw new Error('Unknown view: ' + view);
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
  return { version: 2, ...saved, workspaces: ws, notes, ...extra };
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
  return state.notes || {};
}

// Demo text for the fixed bulletin-board tiles created by kijo_reset.
// Which series a chart tile shows (string or up to 3 names). Tiles without an entry are unbound.
export const DEFAULT_BINDINGS = {
  8: 'browser.fps', 9: 'browser.draw_ms', 10: 'browser.loop_lag_ms', 11: 'browser.cmds',
  13: 'cpu.util_pct', 14: 'mem.used_pct', 15: ['net.rx_kbps', 'net.tx_kbps'],
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
export const DEFAULT_NOTES = { 5: 'Problem: tiling managers stretch neighbours', 6: 'Idea: ghosts reserve space, owners clean up', 7: 'Pin anything. No agent needed.' };

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
  return String(notes[t.id] ?? `NOTE ${t.id}`).slice(0, 40);
}
export const tag = t => ['', 'SHELL', 'AGENT', 'HOST', 'SSH', 'NOTE', 'HERDR', 'SYS', 'CHART', 'LOGS', 'TRACE'][t.app] || '';

// ---------------------------------------------------------------------------
// Host-independent key handling. Every host maps its raw input to these names:
//   digits 1-5 views, arrows, shift+arrows (swap), enter, comma/period, etc.
// Shell takeover (p/o) is host specific and stays in the host.
// ui = { view, ghosts, notes, events }.  Returns true when the key was consumed.
export function handleKeyName(api, ui, key) {
  ui.bindings ??= {};
  const t = selectedTile(api);
  const log = e => ui.events.push(e);
  const arrows = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
  const swaps = { 'Shift+ArrowLeft': 'left', 'Shift+ArrowRight': 'right', 'Shift+ArrowUp': 'up', 'Shift+ArrowDown': 'down' };
  if (['1', '2', '3', '4', '5'].includes(key)) ui.view = VIEWS[Number(key) - 1];
  else if (key === '6' && ui.flow !== false) ui.view = 'flow'; // host-only view (no WASM scene): injectors -> series -> tiles
  else if (arrows[key]) {
    if (ui.view === 'workspaces') { if (key === 'ArrowRight') dispatch(api, 'CYCLEWORKSPACE', 1); else if (key === 'ArrowLeft') dispatch(api, 'CYCLEWORKSPACE', -1); else if (key === 'ArrowDown') dispatch(api, 'CYCLEWORKSPACE', 1); else dispatch(api, 'CYCLEWORKSPACE', -1); }
    else dispatch(api, 'MOVEFOCUS', DIR[arrows[key]]);
  } else if (swaps[key]) dispatch(api, 'SWAP', DIR[swaps[key]]);
  else if (key === 'Enter') ui.view = ui.view === 'workspaces' ? 'overview' : ui.view === 'overview' ? 'focus' : ui.view;
  else if (key === 'Escape') ui.view = ui.view === 'focus' ? 'overview' : ui.view === 'overview' ? 'workspaces' : ui.view;
  else if (key === ',' || key === '.') dispatch(api, 'CYCLEWORKSPACE', key === '.' ? 1 : -1);
  else if (key === 's') dispatch(api, 'TOGGLESPECIAL');
  else if (key === 'm') { const to = (api.kijo_ws() + 1) % 9; if (dispatch(api, 'MOVETOWORKSPACE', to)) log(`Moved tile #${t.id} to workspace ${to + 1}`); }
  else if (key === 'g') ui.ghosts = !ui.ghosts;
  else if (key === 'r') { api.kijo_reset(); ui.notes = { ...DEFAULT_NOTES }; ui.bindings = { ...DEFAULT_BINDINGS }; log('Reset'); }
  else if (key === 'n') {
    const id = t.kind === KIND.GHOST ? api.kijo_promote_ghost(api.kijo_sel_x(), api.kijo_sel_y()) : t.kind === KIND.EMPTY ? api.kijo_spawn(APP.NOTE, 1, 1, 0) : 0;
    if (id) { ui.notes[id] = `Note ${id}`; log(`New note #${id} at ${api.kijo_sel_x()},${api.kijo_sel_y()}`); }
  } else if (key === 'f') {
    for (const corner of [0, 1, 2, 3]) {
      const id = api.kijo_spawn(APP.NOTE, 2, 2, corner);
      if (id) { ui.notes[id] = `Note ${id}`; log(`New 2x2 footprint note #${id}`); break; }
    }
  } else if (key === 'x') { if (t.kind === KIND.REAL && dispatch(api, 'KILLACTIVE')) { log(`Closed tile #${t.id}; owned ghosts cleaned`); delete ui.notes[t.id]; delete ui.bindings[t.id]; } }
  else if (key === 't') { if (t.kind === KIND.REAL) { api.kijo_report(t.id, (t.status + 1) % 5, 1, 40); log(`Demo status change for tile #${t.id}`); } }
  else return false;
  return true;
}
