// Canvas core (core/canvas.c) and its host half (src/canvas.mjs): camera math, level of detail,
// culling, spatial queries, reservations, agent ops, JSON Canvas, persistence, drawing, fuzz.
import assert from 'node:assert/strict';
import { loadCore, render } from '../src/host.mjs';
import {
  getCanvasNodes, getCanvasEdges, canvasNode, getScene, serializeState, applyState, handleKeyName, cqRead,
  APP, KIND, NODE, FLAG, STATUS, Q16, CANVAS_ID0, LINK_KIND, DEFAULT_NOTES, DEFAULT_BINDINGS,
} from '../src/core.mjs';
import { applyCanvasOp, toJsonCanvas, fromJsonCanvas, isJsonCanvas, canvasQuery, canvasNear, canvasContains, canvasFree, canvasBounds, toWorld, toScreen, describeNode } from '../src/canvas.mjs';
import { Store, canvasOk } from '../src/telemetry.mjs';
import { buildDisplayList, THEMES, Anim } from '../web/displaylist.mjs';

const api = await loadCore();
const nodes = () => getCanvasNodes(api);
const node = id => canvasNode(api, id);
const overlap = (a, b, gap = 0) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
const fresh = () => { api.kijo_reset(); api.kijo_canvas_viewport(1280, 800); api.kijo_canvas_step(1000); return { notes: { ...DEFAULT_NOTES }, bindings: { ...DEFAULT_BINDINGS }, events: [] }; };

// ---- ABI and the demo document
fresh();
assert.equal(api.kijo_canvas_version(), 1);
assert.equal(api.kijo_canvas_node_count(), 10); assert.equal(api.kijo_canvas_edge_count(), 3);
assert.equal(nodes()[0].id, CANVAS_ID0, 'canvas ids start at CANVAS_ID0');
assert.ok(nodes().every(n => n.id >= CANVAS_ID0), 'and never collide with grid ids');
const [GROUP, N1, N2, AGENT, GHOST, CHART, LOGS, N3, FAR, FARNOTE] = nodes().map(n => n.id);
assert.equal(node(GHOST).kind, KIND.GHOST); assert.equal(node(GHOST).owner, AGENT, 'the seeded agent owns a reservation');
assert.equal(node(GROUP).app, APP.GROUP); assert.equal(node(AGENT).status, 1);
assert.equal(api.kijo_canvas_sel(), N1);
assert.equal(api.kijo_canvas_zoom(), Math.floor(1280 * Q16 * 9 / (1500 * 10)), 'a fresh canvas frames its first region (90% of the width, never past 1x)');

// ---- camera: screen <-> world, zoom about a point, pan, easing
for (const z of [Q16, Q16 / 4, Q16 * 3]) {
  api.kijo_canvas_look(123, -456, z, 1);
  for (const [wx, wy] of [[0, 0], [123, -456], [-5000, 7000], [999, 1]]) {
    const [sx, sy] = toScreen(api, wx, wy), [bx, by] = toWorld(api, sx, sy);
    assert.ok(Math.abs(bx - wx) <= Math.ceil(Q16 / z) && Math.abs(by - wy) <= Math.ceil(Q16 / z), `world -> screen -> world at zoom ${z / Q16}`);
  }
  assert.deepEqual(toScreen(api, 123, -456), [640, 400], 'the camera centre is the viewport centre');
}
api.kijo_canvas_look(0, 0, Q16, 1);
const before = toWorld(api, 200, 150);
api.kijo_canvas_zoom_at(200, 150, Q16 * 2);
assert.equal(api.kijo_canvas_zoom(), Q16 * 2);
const after = toWorld(api, 200, 150);
assert.ok(Math.abs(after[0] - before[0]) <= 1 && Math.abs(after[1] - before[1]) <= 1, 'zoom keeps the point under the pointer still');
for (let i = 0; i < 40; i++) api.kijo_canvas_zoom_at(-1, -1, Q16 * 4);
assert.equal(api.kijo_canvas_zoom(), 16 * Q16, 'zoom is clamped at 16x');
for (let i = 0; i < 40; i++) api.kijo_canvas_zoom_at(-1, -1, Q16 / 4);
assert.equal(api.kijo_canvas_zoom(), 2048, 'and at 1/32');
api.kijo_canvas_look(0, 0, Q16, 1);
api.kijo_canvas_pan(100, -40);
assert.deepEqual([api.kijo_canvas_cam_x(), api.kijo_canvas_cam_y()], [-100, 40], 'dragging moves the content with the pointer');
api.kijo_canvas_look(1000, 0, Q16, 0);
assert.equal(api.kijo_canvas_step(16), 1, 'a flight takes several frames');
let frames = 1; while (api.kijo_canvas_step(16) && frames < 400) frames++;
assert.ok(frames > 5 && frames < 400, 'and lands: ' + frames);
assert.equal(api.kijo_canvas_cam_x(), 1000);
api.kijo_canvas_look(500, 0, Q16, 0); assert.equal(api.kijo_canvas_step(0), 1, 'dt 0 reports a flight'); assert.equal(api.kijo_canvas_cam_x(), 1000, 'without moving the camera');
api.kijo_canvas_look(0, 0, Q16, 0); assert.equal(api.kijo_canvas_step(1000), 0, 'dt >= 1 s snaps'); assert.equal(api.kijo_canvas_cam_x(), 0);

// ---- scene: screen rectangles, culling and semantic zoom are the core's decisions
const lodOf = id => getScene(api, 'canvas').find(n => n.id === id && n.kind !== NODE.LINK);
fresh();
api.kijo_canvas_look(150, 95, Q16, 1); // N1 is 300x190 at (0,0)
let s = lodOf(N1); assert.deepEqual([s.x, s.y, s.w, s.h], [640 - 150, 400 - 95, 300, 190]); assert.equal(s.material, 2, '1x: full card');
assert.ok(s.flags & FLAG.LOD_FULL); assert.ok(s.flags & FLAG.SELECTED);
api.kijo_canvas_look(150, 95, Q16 / 4, 1); s = lodOf(N1); assert.equal(s.material, 1, '1/4: title only'); assert.ok(s.flags & FLAG.LOD_TITLE);
api.kijo_canvas_look(150, 95, Q16 / 16, 1); s = lodOf(N1); assert.equal(s.material, 0, '1/16: a dot');
api.kijo_canvas_look(150, 95, Q16, 1);
assert.equal(lodOf(FARNOTE), undefined, 'a node far off screen is culled');
api.kijo_canvas_fit(); api.kijo_canvas_step(1000);
assert.ok(lodOf(FARNOTE) && lodOf(N1), 'framing everything shows both regions');
const sc = getScene(api, 'canvas');
assert.ok(sc.findIndex(n => n.id === GROUP) < sc.findIndex(n => n.id === N1), 'regions draw behind their content');
assert.equal(sc.filter(n => n.kind === NODE.LINK && n.material === LINK_KIND.EDGE).length, 3);
assert.equal(sc.filter(n => n.kind === NODE.LINK && n.material === LINK_KIND.OWNER).length, 1, 'ownership is drawn as a link, never stored as one');
const mm = getScene(api, 'minimap');
assert.equal(mm[0].kind, NODE.SLOT); assert.equal(mm.at(-1).kind, NODE.VIEWPORT); assert.equal(mm.length, 12);
for (const n of mm.slice(1)) assert.ok(n.x >= 0 && n.y >= 0 && n.x + n.w <= mm[0].w + 1 && n.y + n.h <= mm[0].h + 1, 'minimap nodes stay inside its frame');
api.kijo_canvas_minimap_to_world(mm.at(-1).x + mm.at(-1).w / 2 | 0, mm.at(-1).y + mm.at(-1).h / 2 | 0);
const mc = cqRead(api, 2); assert.ok(Math.abs(mc[0] - api.kijo_canvas_cam_x()) < 40 && Math.abs(mc[1] - api.kijo_canvas_cam_y()) < 40, 'minimap viewport centre maps back to the camera');

// ---- spatial queries (what agents ask)
fresh();
assert.deepEqual(canvasQuery(api, 0, 0, 10, 10).sort(), [GROUP, N1].sort());
assert.deepEqual(canvasContains(api, GROUP).sort(), [N1, N2, AGENT, GHOST, CHART, LOGS, N3].sort(), 'a group contains what lies inside it');
const near = canvasNear(api, N1, 3);
assert.equal(near.length, 3); assert.ok(near.includes(N2) && near.includes(AGENT)); assert.ok(!near.includes(GROUP), 'groups are not neighbours');
assert.equal(canvasNear(api, N1, 50).at(-1), FARNOTE, 'nearest first, farthest last');
assert.equal(api.kijo_canvas_at(10, 10), N1); assert.equal(api.kijo_canvas_at(-30, -80), GROUP, 'a group only where nothing else is'); assert.equal(api.kijo_canvas_at(-9999, 9999), 0);
for (const dir of [-1, 0, 1, 2, 3]) {
  const p = canvasFree(api, N2, dir, 300, 190); assert.ok(p, 'room found, dir ' + dir);
  const r = { x: p[0], y: p[1], w: 300, h: 190 };
  for (const n of nodes()) if (n.app !== APP.GROUP) assert.ok(!overlap(r, n, 39), `free space keeps the gap (dir ${dir}, #${n.id})`);
}
const right = canvasFree(api, N1, 1, 100, 100); assert.ok(right[0] > node(N3).x, 'marching right steps past every card in the row');
const below = canvasFree(api, N1, 3, 100, 100); assert.ok(below[1] >= node(AGENT).y + node(AGENT).h + 40, 'and down past the agent');

// ---- reservations: ghosts are space that is taken before its content exists
fresh();
const g2 = api.kijo_canvas_reserve_near(AGENT, AGENT, 3, 300, 250);
assert.ok(g2 && node(g2).kind === KIND.GHOST && node(g2).owner === AGENT);
assert.equal(api.kijo_canvas_reserve(424242, 0, 0, 10, 10), 0, 'an owner must exist');
assert.equal(api.kijo_canvas_fill(N1, APP.NOTE), 0, 'only a reservation can be filled');
assert.equal(api.kijo_canvas_fill(g2, APP.NOTE), g2, 'filling keeps the id');
assert.equal(node(g2).owner, 0, 'and detaches ownership');
assert.equal(api.kijo_close(AGENT), 1, 'kijo_close works for canvas ids');
assert.equal(node(GHOST), null, 'the owner took its remaining reservation with it');
assert.ok(node(g2), 'the filled one survives');
assert.ok(!getCanvasEdges(api).some(e => e.from === AGENT || e.to === AGENT), 'links to a closed node go too');
assert.equal(api.kijo_close(AGENT), 0, 'cannot close twice');

// ---- status: OSC 7501 / injected status reach canvas tiles by id
fresh();
assert.equal(api.kijo_report(CHART, 2, 1, -1), 1); assert.equal(node(CHART).status, 2); assert.equal(node(CHART).blockedKind, 1);
assert.equal(api.kijo_report(GHOST, 1, 0, 10), 0, 'a ghost has no status');
const store = new Store(); store.onStatus = m => api.kijo_report(m.id, m.state, m.kind, m.progress) === 1;
assert.equal(store.ingest({ t: 'status', id: AGENT, state: 'working', progress: 70 }), true); assert.equal(node(AGENT).progress, 70);

// ---- keyboard on the canvas: same verbs as the grid
let ui = fresh(); ui.view = 'focus';
handleKeyName(api, ui, '7'); assert.equal(ui.view, 'canvas');
api.kijo_canvas_select(N1);
handleKeyName(api, ui, 'ArrowRight'); assert.equal(api.kijo_canvas_sel(), N2);
handleKeyName(api, ui, 'ArrowDown'); assert.equal(api.kijo_canvas_sel(), GHOST, 'arrows pick the nearest node in that cone');
handleKeyName(api, ui, 'n'); assert.equal(node(GHOST).kind, KIND.REAL, 'N on a reservation fills it'); assert.equal(api.kijo_canvas_sel(), GHOST);
api.kijo_canvas_select(N3); const count0 = api.kijo_canvas_node_count();
handleKeyName(api, ui, 'n'); const made = api.kijo_canvas_sel(); assert.equal(api.kijo_canvas_node_count(), count0 + 1); assert.ok(made !== N3 && ui.notes[made]);
for (const n of nodes()) if (n.id !== made && n.app !== APP.GROUP) assert.ok(!overlap(node(made), n), 'a new note lands in free space');
handleKeyName(api, ui, 'f'); const res = api.kijo_canvas_sel(); assert.equal(node(res).owner, made, 'F reserves room owned by the selection');
api.kijo_canvas_select(made); handleKeyName(api, ui, 'x'); assert.equal(node(made), null); assert.equal(node(res), null, 'X closes the owner and its reservation');
api.kijo_canvas_select(N1); handleKeyName(api, ui, 'l'); assert.equal(api.kijo_canvas_marked(), N1);
api.kijo_canvas_select(CHART); handleKeyName(api, ui, 'l'); assert.equal(api.kijo_canvas_marked(), 0); assert.ok(getCanvasEdges(api).some(e => e.from === N1 && e.to === CHART), 'L, move, L links');
const nx = node(CHART).x; handleKeyName(api, ui, 'Shift+ArrowRight'); assert.equal(node(CHART).x, nx + 40);
handleKeyName(api, ui, '-'); assert.ok(api.kijo_canvas_zoom() < Q16);
handleKeyName(api, ui, 'Escape'); api.kijo_canvas_step(1000); assert.ok(getScene(api, 'canvas').some(n => n.id === FARNOTE), 'Esc frames everything');
handleKeyName(api, ui, '1'); assert.equal(ui.view, 'focus', 'number keys still leave the canvas');

// ---- agent operations ({t:'canvas', ...} from kijod, kijo.canvas.apply, pasted NDJSON)
ui = fresh();
let r = applyCanvasOp(api, ui, { op: 'note', id: 'findings', text: 'p95 doubled after deploy', near: N3, dir: 'right' });
assert.ok(r.ok); const F = r.id; assert.equal(ui.notes[F], 'p95 doubled after deploy'); assert.ok(node(F).x > node(N3).x, 'placed to the right of what it relates to');
assert.equal(applyCanvasOp(api, ui, { op: 'note', id: 'findings', text: 'retry' }).id, F, 'a retried op with the same id is idempotent');
assert.equal(ui.notes[F], 'retry'); assert.equal(api.kijo_canvas_node_count(), 11);
r = applyCanvasOp(api, ui, { op: 'reserve', id: 'next', owner: 'findings', dir: 'down' }); assert.ok(r.ok); const NX = r.id;
assert.equal(node(NX).owner, F); assert.ok(node(NX).y > node(F).y);
assert.ok(applyCanvasOp(api, ui, { op: 'status', id: 'findings', state: 'working', progress: 30 }).ok); assert.equal(node(F).status, 1);
assert.ok(applyCanvasOp(api, ui, { op: 'fill', id: 'next', app: 'chart', series: 'http.p95_ms' }).ok); assert.equal(node(NX).app, APP.SERIES); assert.deepEqual(ui.bindings[NX], ['http.p95_ms']);
assert.ok(applyCanvasOp(api, ui, { op: 'link', from: 'findings', to: 'next', label: 'evidence' }).ok);
r = applyCanvasOp(api, ui, { op: 'group', id: 'incident', text: 'Incident', of: ['findings', 'next'] }); assert.ok(r.ok);
assert.deepEqual(canvasContains(api, r.id).sort(), [F, NX].sort(), 'a group wraps exactly what it was made of');
assert.ok(applyCanvasOp(api, ui, { op: 'move', id: 'findings', x: 5000, y: 5000 }).ok); assert.equal(node(F).x, 5000);
assert.equal(describeNode(api, ui, F).name, 'findings'); assert.equal(describeNode(api, ui, F).status, 'working');
for (const bad of [{ op: 'note', near: 'nobody' }, { op: 'fill', id: 'findings' }, { op: 'link', from: 'findings', to: 'nope' }, { op: 'text', id: 'nope' }, { op: 'close', id: 'nope' }, { op: 'what' }, { op: 'add', app: 'toaster' }, { op: 'group', of: [] }]) {
  const b = applyCanvasOp(api, ui, bad); assert.equal(b.ok, false, JSON.stringify(bad)); assert.equal(typeof b.error, 'string');
}
assert.ok(applyCanvasOp(api, ui, { op: 'close', id: 'findings' }).ok); assert.equal(ui.notes[F], undefined, 'closing forgets host state'); assert.equal(ui.cids[F], undefined);
// the shape check the relay and the page share
assert.equal(canvasOk({ t: 'canvas', op: 'note', text: 'x' }), true);
for (const bad of [null, { op: 'rm -rf' }, { op: 'note', text: 7 }, { op: 'note', id: {} }, { op: 'note', text: 'x'.repeat(5000) }, { op: 'group', of: 'a' }, { op: 'group', of: Array(300).fill(1) }]) assert.equal(canvasOk(bad), false, JSON.stringify(bad));
const s2 = new Store(); let seen = 0; s2.onCanvas = m => (applyCanvasOp(api, ui, m).ok && ++seen);
assert.equal(s2.ingest({ t: 'canvas', op: 'note', text: 'via the store' }), true); assert.equal(seen, 1);
assert.equal(s2.ingest({ t: 'canvas', op: 'nope' }), false);

// ---- JSON Canvas 1.0 (jsoncanvas.org) in and out
const doc = {
  nodes: [
    { id: 'g', type: 'group', label: 'Imported', x: 0, y: 0, width: 800, height: 400 },
    { id: 'a', type: 'text', text: '# Hello', x: 40, y: 80, width: 250, height: 140, color: '4' },
    { id: 'b', type: 'link', url: 'https://jsoncanvas.org', x: 360, y: 80, width: 250, height: 140 },
    { id: 'c', type: 'file', file: 'notes/plan.md', subpath: '#Goals', x: 40, y: 260, width: 250, height: 100 },
  ],
  edges: [{ id: 'e1', fromNode: 'a', toNode: 'b', fromSide: 'right', toSide: 'left', label: 'see' }, { id: 'e2', fromNode: 'a', toNode: 'missing' }],
};
assert.equal(isJsonCanvas(doc), true); assert.equal(isJsonCanvas({ t: 'metric' }), false); assert.equal(isJsonCanvas({ nodes: [{ id: 'x', type: 'blob', x: 0, y: 0, width: 1, height: 1 }] }), false);
ui = fresh();
const imp = fromJsonCanvas(api, ui, doc);
assert.equal(imp.nodes, 4); assert.equal(imp.edges, 1, 'an edge to a missing node is dropped, not invented');
const ia = imp.ids[1]; assert.ok(node(ia).x > 1500, 'imported next to what is already there, not on top of it');
assert.equal(ui.notes[imp.ids[3]], 'notes/plan.md#Goals');
const out = toJsonCanvas(api, ui);
assert.equal(isJsonCanvas(out), true);
const oa = out.nodes.find(n => n.id === 'a'), ob = out.nodes.find(n => n.id === 'b');
assert.equal(oa.type, 'text'); assert.equal(oa.text, '# Hello'); assert.equal(oa.color, '4'); assert.equal(ob.type, 'link'); assert.equal(ob.url, 'https://jsoncanvas.org');
assert.equal(out.nodes.find(n => n.id === 'g').type, 'group');
assert.equal(out.edges.find(e => e.id === 'e1').label, 'see'); assert.equal(out.edges.find(e => e.id === 'e1').fromSide, 'right');
assert.ok(!out.nodes.some(n => n.text === 'reserved'), 'ghosts are not exported by default');
const chartOut = out.nodes.find(n => n.kijo?.app === 'chart'); assert.deepEqual(chartOut.kijo.series, ['browser.fps'], 'kijo tiles keep their binding in a kijo field');
// round trip through a clean core: same nodes, same geometry, same edges
const api2 = await loadCore(); api2.kijo_clear(); const ui2 = {};
fromJsonCanvas(api2, ui2, out, { place: 'origin' });
const back = toJsonCanvas(api2, ui2);
assert.deepEqual(back.nodes.map(n => [n.id, n.type, n.x, n.y, n.width, n.height]), out.nodes.map(n => [n.id, n.type, n.x, n.y, n.width, n.height]));
assert.deepEqual(back.edges.map(e => [e.fromNode, e.toNode]), out.edges.map(e => [e.fromNode, e.toNode]));
// importing the same document twice keeps every id unique, and links stay inside their own copy
fromJsonCanvas(api2, ui2, doc); const twice = toJsonCanvas(api2, ui2);
assert.equal(new Set(twice.nodes.map(n => n.id)).size, twice.nodes.length, 'node ids unique'); assert.equal(new Set(twice.edges.map(e => e.id)).size, twice.edges.length, 'edge ids unique');
assert.ok(twice.edges.some(e => e.fromNode === 'a-2' && e.toNode === 'b-2'));

// ---- persistence: canvas travels in schema v2; old saves get the demo canvas
ui = fresh();
applyCanvasOp(api, ui, { op: 'note', id: 'keep', text: 'persist me', x: -800, y: 300 });
api.kijo_canvas_look(77, 88, Q16 * 2, 1);
const saved = JSON.parse(JSON.stringify(serializeState(api, ui.notes)));
assert.equal(saved.canvas.nodes.length, 11);
api.kijo_reset(); api.kijo_clear();
const notes2 = applyState(api, saved);
assert.equal(api.kijo_canvas_node_count(), 11); assert.deepEqual(nodes().map(n => [n.id, n.kind, n.owner, n.x, n.y, n.w, n.h]), saved.canvas.nodes.map(n => [n.id, n.kind, n.owner, n.x, n.y, n.w, n.h]));
assert.equal(api.kijo_canvas_cam_x(), 77); assert.equal(api.kijo_canvas_zoom(), Q16 * 2);
assert.equal(Object.values(notes2).includes('persist me'), true);
const nid = applyCanvasOp(api, ui, { op: 'note', text: 'after restore' }).id; assert.ok(nid > Math.max(...saved.canvas.nodes.map(n => n.id)), 'ids keep counting after a restore');
api.kijo_close(AGENT); assert.equal(node(GHOST), null, 'ownership survives a save and restore');
const old = { ...saved }; delete old.canvas; api.kijo_clear();
const notes3 = applyState(api, old); assert.equal(api.kijo_canvas_node_count(), 10, 'a pre-canvas save gets the demo canvas'); assert.ok(notes3[CANVAS_ID0]);

// ---- terminal host: the same scene as text
ui = fresh();
render(api, { view: 'canvas', cols: 120, rows: 40, notes: ui.notes }); // the first frame tells the core the terminal's size
handleKeyName(api, { ...ui, view: 'canvas' }, 'Escape'); // Esc: the flight lands before the next frame is drawn
const txt = render(api, { view: 'canvas', cols: 120, rows: 40, notes: ui.notes });
assert.match(txt, /Stil/, 'the far region is in view after framing everything');
assert.match(txt, /canvas {2}zoom \d+%/); assert.match(txt, /rese/); assert.match(txt, /# \* Th/, 'the selection is marked');
assert.equal(txt.split('\n').length, 40); assert.ok(txt.split('\n').every(l => l.length <= 120));

// ---- display list: bounded, finite, hit targets for every drawn node and the minimap
const T = THEMES.dark, measure = (str, z) => String(str).length * z * 0.6;
for (const theme of [THEMES.dark, THEMES.glass]) for (const zoom of [Q16 / 32, Q16 / 8, Q16 / 2, Q16, Q16 * 4]) {
  ui = fresh(); Object.assign(ui, { view: 'canvas', ghosts: false, window: 300000, editing: null, palette: null, message: '', viz: {}, cids: {}, cmeta: {}, emeta: {} });
  api.kijo_canvas_look(600, 200, zoom, 1);
  const env = { width: 1280, height: 800, dpr: 1, time: 1, dt: 0.016, theme, anim: new Anim(), clock: '12:00', date: 'x', metrics: {}, measure, store: new Store(), now: 2e12 };
  const list = buildDisplayList(api, ui, env);
  assert.ok(list.canvasArea && list.canvasArea.w === 1280, 'the canvas fills the width');
  for (const k of list.cmds) assert.ok(k.op === 'text' || k.op === 'wall' || [k.x, k.y, k.w, k.h].every(Number.isFinite), `finite geometry at zoom ${zoom / Q16}: ${JSON.stringify(k)}`);
  assert.ok(list.cmds.length < 9000, 'op count is bounded: ' + list.cmds.length);
  const drawn = getScene(api, 'canvas').filter(n => n.kind !== NODE.LINK).map(n => n.id);
  const hit = new Set(list.hits.filter(h => h.kind === 'cnode').map(h => h.id));
  for (const id of drawn) assert.ok(hit.has(id), `#${id} drawn and clickable at zoom ${zoom / Q16}`);
  const all = getScene(api, 'canvas').filter(n => n.kind !== NODE.LINK).length === api.kijo_canvas_node_count();
  const b = canvasBounds(api), [sx0, sy0] = toScreen(api, b[0], b[1]), [sx1, sy1] = toScreen(api, b[0] + b[2], b[1] + b[3]);
  const inView = all && sx0 >= 0 && sy0 >= 0 && sx1 <= list.canvasArea.w && sy1 <= list.canvasArea.h;
  assert.equal(list.hits.some(h => h.kind === 'minimap'), !inView, `minimap only when something is off screen (zoom ${zoom / Q16})`);
}
void T;

// ---- fuzz: random agent and key traffic never breaks the document's invariants
ui = fresh(); ui.view = 'canvas';
let seed = 7; const rnd = n => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
const ops = ['note', 'reserve', 'fill', 'move', 'link', 'unlink', 'close', 'status', 'group', 'text', 'fly', 'fit'];
let okOps = 0;
const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'n', 'f', 'x', 'l', 't', '+', '-', 'Escape', 'Enter', 'Shift+ArrowUp'];
for (let i = 0; i < 3000; i++) {
  const ids = nodes().map(n => n.id), pick = () => (ids.length ? ids[rnd(ids.length)] : 0);
  if (rnd(3) === 0) handleKeyName(api, ui, keys[rnd(keys.length)]);
  else if (applyCanvasOp(api, ui, { op: ops[rnd(ops.length)], id: rnd(4) ? pick() : 'k' + rnd(30), near: pick(), owner: pick(), from: pick(), to: pick(), of: [pick(), pick()], x: rnd(40000) - 20000, y: rnd(40000) - 20000, w: rnd(900), h: rnd(900), dir: ['left', 'right', 'up', 'down', 'any'][rnd(5)], state: STATUS[rnd(5)], text: 't' + i, app: ['note', 'chart', 'logs', 'agent'][rnd(4)] }).ok) okOps++;
  if (rnd(5) === 0) { api.kijo_canvas_pan(rnd(400) - 200, rnd(400) - 200); api.kijo_canvas_zoom_at(rnd(1280), rnd(800), Q16 / 2 + rnd(Q16)); api.kijo_canvas_step(rnd(100)); }
  if (i % 100 === 0) {
    const all = nodes(), byId = new Map(all.map(n => [n.id, n]));
    assert.equal(byId.size, all.length, 'ids are unique');
    for (const n of all) {
      assert.ok(n.w >= 8 && n.h >= 8 && Math.abs(n.x) <= 1 << 30 && Math.abs(n.y) <= 1 << 30, 'geometry in bounds');
      if (n.kind === KIND.GHOST && n.owner) assert.equal(byId.get(n.owner)?.kind, KIND.REAL, 'no reservation outlives its owner');
    }
    for (const e of getCanvasEdges(api)) assert.ok(byId.has(e.from) && byId.has(e.to), 'no dangling links');
    const z = api.kijo_canvas_zoom(); assert.ok(z >= 2048 && z <= 16 * Q16);
    const sc2 = getScene(api, 'canvas'); assert.ok(sc2.length <= 1280);
    for (const n of sc2) assert.ok([n.x, n.y, n.w, n.h].every(Number.isFinite));
  }
}
assert.ok(api.kijo_canvas_node_count() <= 512);
assert.ok(okOps > 600, 'the fuzz mostly ran real operations, not rejected ones: ' + okOps);

console.log('PASS — canvas: camera math, zoom about a point, easing, semantic zoom + culling, minimap, spatial queries, free space, reservations + ownership, status by id, keys, agent ops, JSON Canvas round trip, persistence, terminal + display list, fuzz');
