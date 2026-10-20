import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { instantiateCore, dispatch, handleKeyName, DEFAULT_BINDINGS, DEFAULT_NOTES, APP, getTiles } from '../src/core.mjs';
import { Store } from '../src/telemetry.mjs';
import { parseLogFilter, filterLogs, formatLogLine, drawChart, drawLogs, drawTraces, drawSys, drawFlow, flowModel, fmtVal } from '../web/telemetry-draw.mjs';
import { buildSurface, s3Project } from '../web/surface3d.mjs';
import { surfaceModel } from '../web/telemetry-draw.mjs';
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
// 3D surface tile: data-only op, honest model, geometry inside the view frustum
st.view = 'focus'; if (api.kijo_special_open()) dispatch(api, 'TOGGLESPECIAL'); dispatch(api, 'WORKSPACE', 4);
const cores = new Store(); for (let i = 0; i < 120; i++) for (let k = 0; k < 6; k++) cores.push('cpu.core_pct', (i * 3 + k * 20) % 100, NOW - (120 - i) * 1000, { labels: { core: String(k) } });
const l3 = buildDisplayList(api, st, { ...env, store: cores, anim: (() => { const a = new Anim(); return a; })() });
const op3 = l3.cmds.find(k => k.op === 'scene3d'); assert.ok(op3, 'workspace 5 emits a scene3d op'); assert.equal(op3.rows, 6); assert.equal(op3.vals.length, 6 * op3.cols);
assert.ok(op3.vals.every(v => v >= 0 && v <= 1), 'height values are normalised');
const sm = surfaceModel(cores, [], 300000, NOW); assert.equal(sm.norm, 'percent 0-100'); assert.equal(sm.rows, 6);
const odd = new Store(); for (let i = 0; i < 50; i++) odd.push('queue.depth', i * 10, NOW - (50 - i) * 1000); const so = surfaceModel(odd, [], 300000, NOW); assert.equal(so.norm, 'per-series min-max'); assert.equal(so.rows, 1);
assert.equal(surfaceModel(new Store(), [], 300000, NOW).rows, 0, 'no data -> no rows, no fake surface');
const geo = buildSurface({ ...op3, aspect: 1.6 }); assert.ok(geo.triCount === 5 * 47 * 6 && geo.lineCount > 100);
let inside = 0; for (let i = 0; i < geo.triCount; i++) { const p = s3Project(geo.mvp, geo.tri[i * 7], geo.tri[i * 7 + 1], geo.tri[i * 7 + 2]); if (p && Math.abs(p[0]) <= 1.2 && Math.abs(p[1]) <= 1.2) inside++; }
assert.ok(inside / geo.triCount > 0.95, 'the surface is framed by the default camera');
// key '6' selects flow and the terminal host can opt out of it
const ui = { view: 'focus', notes: {}, events: [], bindings: {} }; handleKeyName(api, ui, '6'); assert.equal(ui.view, 'flow');
const tui = { view: 'focus', flow: false, notes: {}, events: [], bindings: {} }; handleKeyName(api, tui, '6'); assert.equal(tui.view, 'focus');
// closing a chart tile drops its binding
if (api.kijo_special_open()) dispatch(api, 'TOGGLESPECIAL'); dispatch(api, 'WORKSPACE', 2); api.kijo_select(1, 1);
const cu = { view: 'focus', notes: {}, events: [], bindings: { ...DEFAULT_BINDINGS } }; handleKeyName(api, cu, 'x'); assert.equal(cu.bindings[8], undefined);
// ---- log surface: filter language, scrolling, anchoring info, highlight
{
  const L = new Store(); const mk = (lvl, body, src = 'app') => L.log(body, lvl, NOW - 100000 + L.logs.length * 1000, { src });
  for (let i = 0; i < 60; i++) mk(i % 10 === 0 ? 'error' : i % 4 === 0 ? 'warn' : 'info', `request ${i} ${i % 3 === 0 ? 'timeout upstream' : 'ok'}`, i % 2 ? 'api' : 'db');
  assert.equal(filterLogs(L.logs, '').length, 60);
  assert.equal(filterLogs(L.logs, 'timeout').length, 20, 'substring, case-insensitive'); assert.equal(filterLogs(L.logs, 'TIMEOUT upstream').length, 20);
  assert.equal(filterLogs(L.logs, 'timeout -request').length, 0, '-term excludes');
  assert.equal(filterLogs(L.logs, 'level:error').length, 6); assert.equal(filterLogs(L.logs, '>warn').length, 6 + 12, 'minimum level includes everything above');
  assert.equal(filterLogs(L.logs, 'api level:warn').every(l => l.src === 'api' && l.level !== 'info'), true, 'terms match source and level too');
  assert.equal(parseLogFilter('a -b level:warn').min, 2);
  const run = (o) => { const r = rec(); const info = drawLogs(r, measure, T, { x: 0, y: 0, w: 600, h: 170 }, L, NOW, o); return { r, info }; };
  const live = run({}), up = run({ off: 5 });
  assert.equal(live.info.rows, 10); assert.equal(live.info.total, 60);
  const bodies = r => r.ops.filter(o => o.op === 'text' && /^request/.test(o.str)).map(o => o.str);
  assert.equal(bodies(live.r).at(-1), 'request 59 ok', 'live view ends at the newest line'); assert.equal(bodies(up.r).at(-1), 'request 54 timeout upstream', 'scrolled back five lines');
  assert.equal(run({ off: 9999 }).info.off, 50, 'scroll is clamped to the oldest page'); assert.equal(bodies(run({ off: 9999 }).r)[0], 'request 0 timeout upstream');
  const f = run({ q: 'timeout' }); assert.equal(f.info.shown, 20); assert.ok(bodies(f.r).every(b => /timeout/.test(b)), 'only matching lines are drawn');
  assert.ok(f.r.ops.some(o => o.op === 'fill' && o.c[3] > 0.3 && o.c[3] < 0.35), 'matches are highlighted');
  const none = run({ q: 'zzz' }); assert.match(none.r.ops[0].str, /no log line matches/); assert.equal(none.info.shown, 0);
  assert.equal(formatLogLine({ ts: NOW, level: 'warn', body: 'x' }).slice(-7), ' WARN x'.padStart(7), 'copy format: clock, level column, body');
}

// ---- text is drawn as typed: Nordic letters, Greek, Cyrillic, arrows and box drawing pass; emoji and CJK (no wide cells) become '?'
{
  const { glyphOk, drawable } = await import('../web/fonts.mjs');
  assert.equal(drawable('Hyv\u00e4\u00e4 y\u00f6t\u00e4 \u00c4\u00d6\u00c5 \u03bb \u0436 \u2192 \u2514\u2500 \u20ac \u2713'), 'Hyv\u00e4\u00e4 y\u00f6t\u00e4 \u00c4\u00d6\u00c5 \u03bb \u0436 \u2192 \u2514\u2500 \u20ac \u2713');
  assert.equal(drawable('a\u{1F600}b\u4e2d'), 'a?b?', 'emoji and CJK are honest placeholders, one ? per code point');
  assert.equal(glyphOk(0x7f), false); assert.equal(glyphOk(0x0a), false, 'controls never reach the atlas');
}

console.log('PASS — telemetry drawing: bounded ops, gaps, thresholds, logs/traces/sys, flow model, every view x workspace, status injection, bindings, log filter/scroll, Unicode text');
