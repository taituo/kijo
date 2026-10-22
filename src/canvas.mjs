// Kijo canvas, the host-side half: spatial queries, agent operations and JSON Canvas import/export.
// Environment neutral (Node 22+, Chrome). The document itself (nodes, edges, z-order, camera) lives in
// the WASM core; this file only calls its exports and keeps host state the core never needs:
//   ui.notes   text per tile id (as for grid notes)       ui.bindings  series per chart tile
//   ui.cids    string id per core id (agent keys, JSON Canvas ids)
//   ui.cmeta   JSON Canvas extras per node (type, url, file, color)   ui.emeta  per edge (label, sides, color)
import { APP, KIND, CANVAS_ID0, getCanvasNodes, getCanvasEdges, canvasNode, cqRead } from './core.mjs';

export const CANVAS_DIRS = { left: 0, right: 1, up: 2, down: 3, any: -1 };
const APP_BY_NAME = { note: APP.NOTE, text: APP.NOTE, agent: APP.AGENT, chart: APP.SERIES, series: APP.SERIES, logs: APP.LOGS, traces: APP.TRACES,
  system: APP.SYS, sys: APP.SYS, '3d': APP.SCENE3D, scene3d: APP.SCENE3D, group: APP.GROUP, shell: APP.SHELL, remote: APP.REMOTE, herdr: APP.HERDR, metrics: APP.METRICS };
const APP_NAME = Object.fromEntries(Object.entries(APP_BY_NAME).reverse().map(([k, v]) => [v, k]));
const SIZE_BY_APP = { [APP.NOTE]: [260, 170], [APP.GROUP]: [640, 420], [APP.SERIES]: [420, 250], [APP.LOGS]: [420, 220], [APP.TRACES]: [480, 260], [APP.SYS]: [420, 300], [APP.SCENE3D]: [420, 300] };
const STATE_BY_NAME = { idle: 0, working: 1, blocked: 2, error: 3, done: 4 };
const BLOCK_BY_NAME = { permission: 1, question: 2, auth: 3 };

// ---- spatial queries (world units; results are core ids)
export const canvasQuery = (api, x, y, w, h) => cqRead(api, api.kijo_canvas_query(x | 0, y | 0, w | 0, h | 0));
export const canvasNear = (api, id, k = 5) => cqRead(api, api.kijo_canvas_near(id, k));
export const canvasContains = (api, id) => cqRead(api, api.kijo_canvas_contains(id));
export const canvasFree = (api, near, dir, w, h, gap = 40) => (api.kijo_canvas_free(near | 0, dir | 0, w | 0, h | 0, gap | 0) ? cqRead(api, 2) : null);
export const canvasBounds = api => (api.kijo_canvas_bounds() ? cqRead(api, 4) : null);
export const toWorld = (api, sx, sy) => (api.kijo_canvas_to_world(Math.round(sx), Math.round(sy)), cqRead(api, 2));
export const toScreen = (api, x, y) => (api.kijo_canvas_to_screen(Math.round(x), Math.round(y)), cqRead(api, 2));

// ---- string ids: agents and JSON Canvas name nodes with strings; the core uses integers
export function canvasRef(api, ui, ref) {
  if (ref === undefined || ref === null || ref === '') return 0;
  if (ref === '@selected') return api.kijo_canvas_sel();
  if (Number.isInteger(ref)) return canvasNode(api, ref) ? ref : 0;
  for (const [id, name] of Object.entries(ui.cids || {})) if (name === ref) return canvasNode(api, +id) ? +id : 0;
  return /^\d+$/.test(ref) && canvasNode(api, +ref) ? +ref : 0;
}
export const canvasName = (ui, id) => ui.cids?.[id] ?? String(id);
// A name no live node answers to yet (neither a string id nor a core id): base, base-2, base-3 ...
function freeName(api, ui, base, self = 0) { const taken = k => { const r = canvasRef(api, ui, k); return r && r !== self; }; let k = base; for (let i = 2; taken(k); i++) k = base + '-' + i; return k; }
const forget = (ui, id) => { for (const k of ['notes', 'bindings', 'viz', 'cids', 'cmeta']) if (ui[k]) delete ui[k][id]; };

// ---- operations: the same verbs for keys, the page API (kijo.canvas.apply), pasted NDJSON and agents
// posting {t:'canvas', ...} to kijod. Returns { ok, id } or { ok: false, error }.
//   note/add  {id?, text?, app?, x?, y? | near?, dir?, w?, h?, series?, state?, select?, focus?}
//   reserve   {id?, owner?, near?, dir?, x?, y?, w?, h?}     fill {id, app?, text?, series?}
//   text {id, text}   status {id, state, kind?, progress?}   move {id, x, y | near, dir}
//   link {from, to, label?}   unlink {from, to}   close {id}   select/fly {id}   fit {}
//   group {id?, text?, of: [ids] | x, y, w, h}
export function applyCanvasOp(api, ui, m) {
  for (const k of ['notes', 'bindings', 'cids', 'cmeta', 'emeta']) ui[k] ??= {};
  const ok = id => ({ ok: true, id }), fail = error => ({ ok: false, error });
  const ref = r => canvasRef(api, ui, r), name = typeof m.id === 'string' && m.id ? m.id.slice(0, 64) : null;
  const dir = CANVAS_DIRS[m.dir] ?? (Number.isInteger(m.dir) ? m.dir : -1);
  const dim = (v, d) => (Number.isFinite(+v) && v !== null && v !== '' ? Math.max(8, Math.min(1 << 20, Math.round(+v))) : d);
  const at = () => Number.isFinite(+m.x) && Number.isFinite(+m.y) && m.x !== null && m.y !== null;
  const content = id => {
    if (name) ui.cids[id] = name;
    if (typeof m.text === 'string') ui.notes[id] = m.text.slice(0, 4000);
    if (typeof m.series === 'string' || Array.isArray(m.series)) ui.bindings[id] = [].concat(m.series).slice(0, 3).map(String);
    if (m.state !== undefined) status(id);
    if (m.select || m.focus) api.kijo_canvas_select(id);
    if (m.focus) api.kijo_canvas_fly(id);
    return ok(id);
  };
  const status = id => api.kijo_report(id, STATE_BY_NAME[m.state] ?? (Number.isInteger(m.state) ? m.state : -1), BLOCK_BY_NAME[m.kind] ?? 0, Number.isFinite(+m.progress) ? +m.progress : -1) === 1;
  const target = () => ref(m.id);
  switch (m.op) {
    case 'add': case 'note': case 'group': {
      const app = m.op === 'group' ? APP.GROUP : APP_BY_NAME[String(m.app ?? 'note').toLowerCase()];
      if (!app) return fail('unknown app ' + m.app);
      const existing = name && ref(name); if (existing) return content(existing); // retries are idempotent
      const [dw, dh] = SIZE_BY_APP[app] || [300, 220];
      let id = 0;
      if (m.op === 'group' && Array.isArray(m.of)) { // a region around existing nodes, with room for its label
        const ns = m.of.map(ref).filter(Boolean).map(i => canvasNode(api, i)); if (!ns.length) return fail('group of nothing');
        const x0 = Math.min(...ns.map(n => n.x)) - 40, y0 = Math.min(...ns.map(n => n.y)) - 80, x1 = Math.max(...ns.map(n => n.x + n.w)) + 40, y1 = Math.max(...ns.map(n => n.y + n.h)) + 40;
        id = api.kijo_canvas_add(APP.GROUP, x0, y0, x1 - x0, y1 - y0);
      } else if (at()) id = api.kijo_canvas_add(app, Math.round(+m.x), Math.round(+m.y), dim(m.w, dw), dim(m.h, dh));
      else {
        const near = m.near !== undefined ? ref(m.near) : api.kijo_canvas_sel();
        if (m.near !== undefined && !near) return fail('unknown near ' + m.near);
        id = api.kijo_canvas_place(app, near, dir, dim(m.w, dw), dim(m.h, dh));
      }
      if (!id) return fail('no room on the canvas');
      if (app === APP.NOTE && typeof m.text !== 'string') ui.notes[id] ??= `Note ${id}`;
      return content(id);
    }
    case 'reserve': {
      const existing = name && ref(name); if (existing) return ok(existing);
      const owner = m.owner !== undefined ? ref(m.owner) : 0; if (m.owner !== undefined && !owner) return fail('unknown owner ' + m.owner);
      const near = m.near !== undefined ? ref(m.near) : owner; if (m.near !== undefined && !near) return fail('unknown near ' + m.near);
      const on = owner ? canvasNode(api, owner) : null, w = dim(m.w, on?.w ?? 260), h = dim(m.h, on?.h ?? 170);
      const id = at() ? api.kijo_canvas_reserve(owner, Math.round(+m.x), Math.round(+m.y), w, h) : api.kijo_canvas_reserve_near(owner, near, dir, w, h);
      if (!id) return fail('cannot reserve there');
      if (name) ui.cids[id] = name;
      return ok(id);
    }
    case 'fill': {
      const id = target(), app = APP_BY_NAME[String(m.app ?? 'note').toLowerCase()];
      if (!id || !app || !api.kijo_canvas_fill(id, app)) return fail('nothing reserved under ' + m.id);
      if (app === APP.NOTE && typeof m.text !== 'string') ui.notes[id] ??= `Note ${id}`;
      return content(id);
    }
    case 'text': { const id = target(); if (!id) return fail('unknown id ' + m.id); ui.notes[id] = String(m.text ?? '').slice(0, 4000); return ok(id); }
    case 'status': { const id = target(); return id && status(id) ? ok(id) : fail('bad status'); }
    case 'move': {
      const id = target(), n = canvasNode(api, id); if (!n) return fail('unknown id ' + m.id);
      if (at()) api.kijo_canvas_move(id, Math.round(+m.x), Math.round(+m.y));
      else { const near = ref(m.near), p = near && near !== id ? canvasFree(api, near, dir, n.w, n.h) : null; if (!p) return fail('no room there'); api.kijo_canvas_move(id, p[0], p[1]); }
      return ok(id);
    }
    case 'link': {
      const e = api.kijo_canvas_link(ref(m.from), ref(m.to)); if (!e) return fail('cannot link');
      if (typeof m.label === 'string') ui.emeta[e] = { ...ui.emeta[e], label: m.label.slice(0, 200) };
      return ok(e);
    }
    case 'unlink': { const a = ref(m.from), b = ref(m.to), e = getCanvasEdges(api).find(x => x.from === a && x.to === b); return e && api.kijo_canvas_unlink(e.id) ? ok(e.id) : fail('no such link'); }
    case 'close': { const id = target(); if (!id || !api.kijo_close(id)) return fail('unknown id ' + m.id); forget(ui, id); return ok(id); }
    case 'select': case 'fly': { const id = target(); if (!id) return fail('unknown id ' + m.id); api.kijo_canvas_select(id); if (m.op === 'fly') api.kijo_canvas_fly(id); return ok(id); }
    case 'fit': api.kijo_canvas_fit(); return ok(0);
  }
  return fail('unknown op ' + m.op);
}

// ---- JSON Canvas 1.0 (jsoncanvas.org): nodes are text/file/link/group, array order is z-order,
// edges join node ids. Kijo tiles that are not notes export as text nodes with a `kijo` field.
export function isJsonCanvas(j) {
  return !!j && typeof j === 'object' && !Array.isArray(j) && Array.isArray(j.nodes) && !j.t &&
    j.nodes.every(n => n && typeof n.id === 'string' && ['text', 'file', 'link', 'group'].includes(n.type) && [n.x, n.y, n.width, n.height].every(Number.isFinite));
}
export function toJsonCanvas(api, ui = {}, { ghosts = false } = {}) {
  const notes = ui.notes || {}, meta = ui.cmeta || {}, nodes = [], ids = new Set();
  for (const n of getCanvasNodes(api)) {
    if (n.kind === KIND.GHOST && !ghosts) continue;
    const m = meta[n.id] || {}, o = { id: canvasName(ui, n.id), x: n.x, y: n.y, width: n.w, height: n.h };
    if (n.app === APP.GROUP) Object.assign(o, { type: 'group', label: notes[n.id] ?? '' });
    else if (n.app === APP.NOTE && m.type === 'link') Object.assign(o, { type: 'link', url: m.url ?? notes[n.id] ?? '' });
    else if (n.app === APP.NOTE && m.type === 'file') Object.assign(o, { type: 'file', file: m.file ?? notes[n.id] ?? '' });
    else if (n.app === APP.NOTE) Object.assign(o, { type: 'text', text: notes[n.id] ?? '' });
    else Object.assign(o, { type: 'text', text: notes[n.id] ?? (n.kind === KIND.GHOST ? 'reserved' : APP_NAME[n.app] ?? 'tile'), kijo: { app: n.kind === KIND.GHOST ? 'ghost' : APP_NAME[n.app], ...(ui.bindings?.[n.id] ? { series: [].concat(ui.bindings[n.id]) } : {}) } });
    if (m.color) o.color = m.color;
    nodes.push(o); ids.add(n.id);
  }
  // JSON Canvas edge ids must be unique. Ids that came from a document keep their name; generated ones step aside.
  const all = getCanvasEdges(api).filter(e => ids.has(e.from) && ids.has(e.to)), used = new Set();
  const named = new Map(all.map(e => [e.id, (ui.emeta || {})[e.id]?.cid]).filter(([, c]) => c && !used.has(c) && used.add(c)));
  const edgeId = (cid, id) => { if (named.get(id) === cid && cid) return cid; let k = 'e' + id; for (let i = 2; used.has(k); i++) k = 'e' + id + '-' + i; used.add(k); return k; };
  const edges = all.map(e => {
    const m = (ui.emeta || {})[e.id] || {};
    return { id: edgeId(m.cid, e.id), fromNode: canvasName(ui, e.from), toNode: canvasName(ui, e.to), ...(m.fromSide ? { fromSide: m.fromSide } : {}), ...(m.toSide ? { toSide: m.toSide } : {}), ...(m.label ? { label: m.label } : {}), ...(m.color ? { color: m.color } : {}) };
  });
  return { nodes, edges };
}
// Adds a JSON Canvas document to the current canvas. `place: 'free'` (default) puts it to the right of
// everything already there; 'origin' keeps its coordinates. Returns { nodes, edges, ids }.
export function fromJsonCanvas(api, ui, doc, { place = 'free' } = {}) {
  if (!isJsonCanvas(doc)) throw new Error('not a JSON Canvas document');
  for (const k of ['notes', 'bindings', 'cids', 'cmeta', 'emeta']) ui[k] ??= {};
  let dx = 0, dy = 0;
  const b = place === 'free' ? api.kijo_canvas_bounds() && cqRead(api, 4) : null;
  if (b && doc.nodes.length) { dx = b[0] + b[2] + 200 - Math.min(...doc.nodes.map(n => n.x)); dy = b[1] - Math.min(...doc.nodes.map(n => n.y)); }
  const map = new Map(); let edges = 0;
  for (const n of doc.nodes) {
    const app = n.type === 'group' ? APP.GROUP : APP_BY_NAME[n.kijo?.app] && n.kijo.app !== 'ghost' ? APP_BY_NAME[n.kijo.app] : APP.NOTE;
    const id = api.kijo_canvas_add(app, Math.round(n.x + dx), Math.round(n.y + dy), Math.round(n.width), Math.round(n.height));
    if (!id) break; // canvas full: what fitted is kept
    map.set(n.id, id); ui.cids[id] = freeName(api, ui, String(n.id).slice(0, 60), id); // importing twice must not create two nodes called 'a'
    const text = n.type === 'group' ? n.label : n.type === 'link' ? n.url : n.type === 'file' ? n.file + (n.subpath || '') : n.text;
    ui.notes[id] = String(text ?? '').slice(0, 4000);
    ui.cmeta[id] = { type: n.type, ...(n.url ? { url: n.url } : {}), ...(n.file ? { file: n.file } : {}), ...(n.color ? { color: n.color } : {}) };
    if (n.kijo?.series) ui.bindings[id] = [].concat(n.kijo.series).map(String);
  }
  for (const e of doc.edges || []) {
    const id = api.kijo_canvas_link(map.get(e.fromNode) ?? 0, map.get(e.toNode) ?? 0);
    if (!id) continue; edges++;
    ui.emeta[id] = { cid: String(e.id ?? ''), ...(e.label ? { label: String(e.label).slice(0, 200) } : {}), ...(e.fromSide ? { fromSide: e.fromSide } : {}), ...(e.toSide ? { toSide: e.toSide } : {}), ...(e.color ? { color: e.color } : {}) };
  }
  return { nodes: map.size, edges, ids: [...map.values()] };
}

// What a tile on the canvas is, in one line, for agents and the terminal host.
export function describeNode(api, ui, id) {
  const n = canvasNode(api, id); if (!n) return null;
  return { id, name: canvasName(ui, id), app: n.kind === KIND.GHOST ? 'ghost' : APP_NAME[n.app] ?? 'tile', x: n.x, y: n.y, w: n.w, h: n.h,
    owner: n.owner || undefined, text: ui.notes?.[id], status: ['idle', 'working', 'blocked', 'error', 'done'][n.status] };
}
export const isCanvasId = id => Number.isInteger(id) && id >= CANVAS_ID0;
