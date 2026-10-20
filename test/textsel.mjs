import assert from 'node:assert/strict';
import { selection, surfaceLines } from '../web/textsel.mjs';
import { instantiateCore, DEFAULT_NOTES, DEFAULT_BINDINGS } from '../src/core.mjs';
import { readFileSync } from 'node:fs';
import { buildDisplayList, THEMES, Anim } from '../web/displaylist.mjs';
import { Store } from '../src/telemetry.mjs';
import { VT } from '../src/vt.mjs';

const m = (s, z) => String(s).length * z * 0.6; // fixed-pitch fake font: 6 px per char at size 10
const t = (x, y, str, surf = 1, s = 10) => ({ op: 'text', x, y, s, str, f: 'mono', w: 400, surf });
const cmds = [t(10, 10, 'alpha beta'), t(10, 24, 'gamma'), t(100, 24, 'delta'), t(10, 38, 'last line'), t(10, 10, 'OTHER SURFACE', 2), t(300, 10, 'ignored', 0)];

// ---- reading order and joining: runs on one line keep their column gap
const lines = surfaceLines(cmds, 1);
assert.equal(lines.length, 3); assert.deepEqual(lines.map(l => l.runs.length), [1, 2, 1]);
assert.equal(selection(cmds, { surf: 1, all: true }, m).text, 'alpha beta\ngamma' + ' '.repeat(8) + 'delta\nlast line', 'gaps become spaces, capped at 8');
assert.equal(selection(cmds, { surf: 2, all: true }, m).text, 'OTHER SURFACE', 'surfaces never leak into each other');

// ---- drag selection: partial first and last lines, direction does not matter
const down = selection(cmds, { surf: 1, ax: 10 + 6 * 6, ay: 12, bx: 10 + 6 * 3, by: 40 }, m); // from "beta"[0] on line 1 back to "las"... on line 3
assert.equal(down.text, 'beta\ngamma' + ' '.repeat(8) + 'delta\nlas');
const up = selection(cmds, { surf: 1, ax: 10 + 6 * 3, ay: 40, bx: 10 + 6 * 6, by: 12 }, m); assert.equal(up.text, down.text, 'selecting backwards gives the same text');
assert.equal(selection(cmds, { surf: 1, ax: 10 + 6 * 2, ay: 12, bx: 10 + 6 * 7, by: 12 }, m).text, 'pha b', 'within one run, character precise');
assert.equal(selection(cmds, { surf: 9, all: true }, m).text, '', 'empty surface selects nothing');
assert.equal(selection(cmds, null, m).text, '');
// highlight rectangles cover exactly the selected characters
const r1 = selection(cmds, { surf: 1, ax: 10 + 6 * 2, ay: 12, bx: 10 + 6 * 7, by: 12 }, m).rects; assert.equal(r1.length, 1); assert.ok(Math.abs(r1[0].x - 22) < 1.5 && Math.abs(r1[0].w - 30) < 1.5);

// ---- real display list: a logs tile is selectable and copyable as text, not pixels
const api = await instantiateCore(readFileSync(new URL('../core/scene.wasm', import.meta.url))); api.kijo_reset(); api.kijo_dispatch(2, 3, 0); // workspace 4
const store = new Store(); const NOW = 2e12; store.log('first entry', 'info', NOW - 2000); store.log('disk almost full', 'warn', NOW - 1000);
const T = THEMES.dark, env = { width: 1280, height: 800, dpr: 1, time: 1, dt: Infinity, theme: T, anim: new Anim(), backend: 'T', clock: '12:00', date: 'x', metrics: {}, measure: m, store, now: NOW };
const st = { view: 'focus', ghosts: false, notes: { ...DEFAULT_NOTES }, bindings: { ...DEFAULT_BINDINGS }, window: 300000, events: [], editing: null, palette: null, message: '' };
api.kijo_dispatch(2, 4, 0); api.kijo_select(2, 1); // workspace 5 (logs tile at 2,1)
let list = buildDisplayList(api, st, env); const logTile = api.kijo_sel_x() + ',' + api.kijo_sel_y();
const surfs = new Set(list.cmds.filter(k => k.op === 'text' && k.surf).map(k => k.surf)); assert.ok(surfs.has(19), 'logs tile text carries its surface id: ' + [...surfs]);
st.sel = { surf: 19, all: true, key: 'x' }; list = buildDisplayList(api, st, { ...env, anim: new Anim() });
assert.ok(!/LOGS/.test(list.selectionText), 'tile header is chrome, not content'); assert.match(list.selectionText, /first entry/); assert.match(list.selectionText, /WARN\s+disk almost full/, 'level tag and body are copied as text');
assert.ok(list.cmds.some(k => k.op === 'fill' && Math.abs(k.c[3] - 0.38) < 1e-6), 'a highlight is drawn under the selection');
st.sel = null; list = buildDisplayList(api, st, { ...env, anim: new Anim() }); assert.equal(list.selectionText, '');
// ---- terminal tile: a VT grid drawn through the same ops, selectable and copyable; colours and cursor included
{
  api.kijo_reset(); api.kijo_dispatch(2, 0, 0); // workspace 1 holds the shell tile (id 1) at 2,2
  const vt = new VT({ cols: 40, rows: 8 });
  vt.write('\x1b[1;32muser@kijo\x1b[0m:~$ ls\r\n\x1b[34mdocs\x1b[0m   README.md   \x1b[7mtotal\x1b[0m 3\r\ncol1' + ' '.repeat(14) + 'col2\r\n┌─┐ box \u00e4\u00f6\u00e5 \u{1F600} \u4e2d');
  const tm = { tile: 1, id: 7, view: 0, exited: null, vt };
  const tst = { ...st, terms: new Map([[1, tm]]), capture: 1, sel: null }; api.kijo_select(2, 2);
  let tl = buildDisplayList(api, tst, { ...env, anim: new Anim(), dt: Infinity });
  const sz = tl.termSizes[1]; assert.ok(sz && sz.cols >= 10 && sz.rows >= 2, 'the tile reports how many cells it can hold');
  const ts = tl.cmds.filter(k => k.op === 'text' && k.surf === 1 && k.term); assert.ok(ts.length >= 5, 'terminal runs are surface-tagged text ops');
  assert.ok(ts.some(k => k.w === 700 && /user@kijo/.test(k.str)), 'bold run keeps its weight');
  assert.ok(ts.some(k => /^docs/.test(k.str)) && ts.some(k => k.c[2] > 0.7 && /docs/.test(k.str)), 'ANSI blue is drawn blue');
  tst.sel = { surf: 1, all: true, key: 'x' }; tl = buildDisplayList(api, tst, { ...env, anim: new Anim(), dt: Infinity });
  const lines = tl.selectionText.split('\n');
  assert.equal(lines[0], 'user@kijo:~$ ls'); assert.equal(lines[1], 'docs   README.md   total 3', 'column gaps survive copy');
  assert.equal(lines[2], 'col1' + ' '.repeat(14) + 'col2', 'wide gaps are not capped for terminal text');
  assert.equal(lines[3], '\u250c\u2500\u2510 box \u00e4\u00f6\u00e5 ? ?', 'box drawing and Nordic letters are drawn and copied as themselves; emoji and CJK (no wide cells yet) show as ?');
  assert.ok(tl.cmds.some(k => k.op === 'fill' && k.c[0] === T.blue[0] && k.c[2] === T.blue[2] && k.h === 17), 'captured cursor block is drawn');
  const exited = { ...tm, exited: 0 }; const tl2 = buildDisplayList(api, { ...tst, terms: new Map([[1, exited]]), capture: null, sel: null }, { ...env, anim: new Anim(), dt: Infinity });
  assert.ok(tl2.cmds.some(k => k.op === 'text' && k.str === 'exited 0'), 'header says when the shell has exited');
}

console.log('PASS — text selection: reading order, column gaps, partial lines, both directions, surfaces isolated, real tiles copy as text, terminal tile');
