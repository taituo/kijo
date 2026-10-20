import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { instantiateCore, dispatch, handleKeyName, DEFAULT_BINDINGS, DEFAULT_NOTES, APP, getTiles } from '../src/core.mjs';
import { Store } from '../src/telemetry.mjs';
import { drawChart, drawLogs, drawTraces, drawSys, drawFlow, flowModel, fmtVal } from '../web/telemetry-draw.mjs';
import { buildDisplayList, THEMES, Anim } from '../web/displaylist.mjs';

const measure = (s, z) => String(s).length * z * 0.6;
const T = THEMES.dark;
const rec = () => { const ops = []; return { ops, fill: (x, y, w, h, c) => ops.push({ op: 'fill', x, y, w, h, c }), stroke() {}, text(x, y, str) { ops.push({ op: 'text', x, y, str: String(str) }); return measure(str, 11); } }; };
const NOW = 2_000_000_000_000;

// ---- number formatting
assert.equal(fmtVal(12.3456, ''), '12.3'); assert.equal(fmtVal(1500000, ''), '1.5M'); assert.equal(fmtVal(42, '%'), '42%'); assert.equal(fmtVal(NaN), '-'); assert.equal(fmtVal(0.5, 'ms'), '0.5 ms');

// ---- charts: bounded op count, no drawing outside the rectangle, honest about missing data
const s = new Store(); for (let i = 0; i < 1800; i++) s.push('cpu.util_pct', 50 + 40 * Math.sin(i / 20), NOW - (1800 - i) * 1000);
const c1 = rec(); drawChart(c1, measure, T, { x: 100, y: 50, w: 600, h: 300 }, s, ['cpu.util_pct'], 300000, NOW);
assert.ok(c1.ops.length > 50 && c1.ops.length < 1200, 'op count follows pixel width, not history: ' + c1.ops.length);
for (const o of c1.ops.filter(o => o.op === 'fill')) assert.ok(o.x >= 100 - 1 && o.x + o.w <= 701 && o.y >= 50 - 1 && o.y + o.h <= 351, 'fill inside the chart rect');
const miss = rec(); drawChart(miss, measure, T, { x: 0, y: 0, w: 300, h: 100 }, s, ['nope'], 300000, NOW); assert.match(miss.ops[0].str, /no data/);
const un = rec(); drawChart(un, measure, T, { x: 0, y: 0, w: 300, h: 100 }, s, [], 300000, NOW); assert.equal(un.ops[0].str, 'unbound');
// a gap in the data is a gap in the line, not an interpolated bridge
const gp = new Store(); for (let i = 0; i < 30; i++) { gp.push('g', 10, NOW - 290_000 + i * 1000); gp.push('g', 10, NOW - 100_000 + i * 1000); }
const g1 = rec(); drawChart(g1, measure, T, { x: 0, y: 0, w: 600, h: 200 }, gp, ['g'], 300000, NOW, { mini: true });
const xs = g1.ops.filter(o => o.op === 'fill' && o.h >= 1).map(o => o.x); assert.ok(!xs.some(x => x > 140 && x < 230), 'no line across the gap');
// threshold colours: >=95 red on percent series
const hot = new Store(); for (let i = 0; i < 20; i++) hot.push('x_pct', 97, NOW - (20 - i) * 1000);
const hc = rec(); drawChart(hc, measure, T, { x: 0, y: 0, w: 300, h: 100 }, hot, ['x_pct'], 60000, NOW); assert.ok(hc.ops.some(o => o.c === T.red), 'critical value drawn red');

// ---- logs, traces, system never throw on empty or odd stores, and say what they need
for (const st of [new Store(), s]) for (const f of [drawLogs, drawTraces, drawSys]) for (const mini of [false, true]) { const r = rec(); f(r, measure, T, { x: 0, y: 0, w: mini ? 120 : 700, h: mini ? 40 : 400 }, st, NOW, { mini }); }
const lg = new Store(); lg.log('a', 'info', NOW - 3000); lg.log('boom', 'error', NOW - 1000); const lr = rec(); drawLogs(lr, measure, T, { x: 0, y: 0, w: 500, h: 100 }, lg, NOW);
assert.ok(lr.ops.some(o => o.str === 'boom') && lr.ops.some(o => o.c === T.red), 'error line is visible and red');
const tr = new Store(); tr.span({ trace: 't', id: 'r', name: 'GET /', start: NOW - 100, dur: 80 }); tr.span({ trace: 't', id: 'c', parent: 'r', name: 'db', start: NOW - 95, dur: 40 });
const tw = rec(); drawTraces(tw, measure, T, { x: 0, y: 0, w: 600, h: 300 }, tr, NOW); assert.ok(tw.ops.some(o => o.str === 'db') && tw.ops.some(o => o.str === 'GET /'), 'waterfall labels both spans');

// ---- system card: host data when present, browser facts otherwise, never invented numbers
const nohost = new Store(); nohost.fact('browser.cores', 8); nohost.push('browser.fps', 60, NOW);
const sh = rec(); drawSys(sh, measure, T, { x: 0, y: 0, w: 700, h: 400 }, nohost, NOW); assert.ok(sh.ops.some(o => /relay/.test(o.str || '')) && !sh.ops.some(o => /cpu history/.test(o.str || '')));
const host = new Store(); host.fact('host', 'atlas'); for (let k = 0; k < 4; k++) host.push('cpu.core_pct', 10 * k, NOW, { labels: { core: String(k) } }); host.push('cpu.util_pct', 20, NOW);
const hh = rec(); drawSys(hh, measure, T, { x: 0, y: 0, w: 700, h: 400 }, host, NOW); assert.ok(hh.ops.some(o => o.str === 'atlas'));

// ---- flow model is derived, not decorative
const fl = new Store(); fl.ingest({ t: 'metric', name: 'queue.depth', value: 3, ts: NOW }, { src: 'worker' }); fl.ingest({ t: 'log', body: 'x' }, { src: 'worker' }); fl.ingest({ t: 'metric', name: 'q2', value: 1, ts: NOW }, { src: 'other' });
const fm = flowModel(fl, [{ id: 8, kind: 1, app: APP.SERIES, ws: 2 }, { id: 5, kind: 1, app: APP.NOTE, ws: 0 }], { 8: 'queue.depth' }, NOW);
assert.deepEqual(fm.sources.map(x => x.name).sort(), ['other', 'worker']); assert.deepEqual(fm.sinks.map(x => x.id), [8], 'notes are not data sinks');
assert.ok(fm.groups.find(g => g.name === 'queue.depth').srcs.has('worker')); assert.ok(fm.groups.find(g => g.name === '@logs').srcs.has('worker'));
assert.ok(!fm.groups.find(g => g.name === 'queue.depth').srcs.has('other'));

// ---- whole display list, every view, with and without telemetry, after real status injection
const api = await instantiateCore(readFileSync(new URL('../core/scene.wasm', import.meta.url)));
api.kijo_reset();
const big = new Store(); big.onStatus = m => api.kijo_report(m.id, m.state, m.kind, m.progress) === 1;
for (let i = 0; i < 200; i++) { big.push('cpu.util_pct', 40 + (i % 50), NOW - (200 - i) * 1000); big.push('browser.fps', 60, NOW - (200 - i) * 1000); }
assert.equal(big.ingest({ t: 'status', id: 1, state: 'blocked', kind: 'permission' }), true); assert.equal(big.ingest({ t: 'status', id: 9999, state: 'blocked' }), false, 'unknown tile id is rejected by the core');
const st = { view: 'focus', ghosts: false, notes: { ...DEFAULT_NOTES }, bindings: { ...DEFAULT_BINDINGS }, window: 300000, events: [], editing: null, palette: null, message: '' };
const env = { width: 1280, height: 800, dpr: 1, time: 1, dt: Infinity, theme: T, anim: new Anim(), backend: 'T', clock: '12:00', date: 'x', metrics: {}, measure, store: big, now: NOW, daemon: { state: 'connected' } };
for (const withStore of [true, false]) for (const view of ['focus', 'overview', 'workspaces', 'back', 'timeline', 'flow']) for (const w of [0, 1, 2, 3, 9]) {
  if (w === 9) { if (!api.kijo_special_open()) dispatch(api, 'TOGGLESPECIAL'); } else { if (api.kijo_special_open()) dispatch(api, 'TOGGLESPECIAL'); dispatch(api, 'WORKSPACE', w); }
  st.view = view; const e2 = { ...env, anim: new Anim(), store: withStore ? big : undefined };
  const list = buildDisplayList(api, st, e2); assert.ok(list.cmds.length > 5, `${view} ws${w} draws`);
  for (const k of list.cmds) assert.ok([k.x, k.y, k.w, k.h].every(Number.isFinite) || k.op === 'text', `finite geometry in ${view}`);
  if (view === 'flow' && withStore && w === 0) assert.ok(list.hits.some(h => h.kind === 'series') && list.hits.some(h => h.kind === 'tile-id'), 'flow rows are clickable');
}
// glass theme: wallpaper first, panels become glass ops with finite geometry, nothing else changes
for (const view of ['focus', 'overview', 'flow', 'workspaces']) {
  st.view = view; if (api.kijo_special_open()) dispatch(api, 'TOGGLESPECIAL'); dispatch(api, 'WORKSPACE', 3);
  const gl = buildDisplayList(api, st, { ...env, theme: THEMES.glass, anim: new Anim() });
  assert.equal(gl.cmds[0].op, 'wall', 'wallpaper is the first op'); assert.ok(gl.cmds.some(k => k.op === 'glass'), view + ' has glass panels');
  for (const k of gl.cmds.filter(k => k.op === 'glass')) assert.ok([k.x, k.y, k.w, k.h, k.r, k.k, k.m].every(Number.isFinite) && k.w > 0 && k.h > 0);
  assert.ok(!buildDisplayList(api, st, env).cmds.some(k => k.op === 'glass' || k.op === 'wall'), 'dark theme emits neither');
}
// key '6' selects flow and the terminal host can opt out of it
const ui = { view: 'focus', notes: {}, events: [], bindings: {} }; handleKeyName(api, ui, '6'); assert.equal(ui.view, 'flow');
const tui = { view: 'focus', flow: false, notes: {}, events: [], bindings: {} }; handleKeyName(api, tui, '6'); assert.equal(tui.view, 'focus');
// closing a chart tile drops its binding
if (api.kijo_special_open()) dispatch(api, 'TOGGLESPECIAL'); dispatch(api, 'WORKSPACE', 2); api.kijo_select(1, 1);
const cu = { view: 'focus', notes: {}, events: [], bindings: { ...DEFAULT_BINDINGS } }; handleKeyName(api, cu, 'x'); assert.equal(cu.bindings[8], undefined);
console.log('PASS — telemetry drawing: bounded ops, gaps, thresholds, logs/traces/sys, flow model, every view x workspace, status injection, bindings');
