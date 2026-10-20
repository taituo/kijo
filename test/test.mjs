import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCore, render, persist, restore, handleKey, barText } from '../src/host.mjs';
import { getTiles, getScene, getEvents, selectedTile, dispatch, APP, KIND, NODE, FLAG, STATUS, DEFAULT_NOTES, SIDE } from '../src/core.mjs';

const api = await loadCore();
const at = (x, y, ws) => getTiles(api, ws)[y * SIDE + x];
const select = (x, y) => api.kijo_select(x, y);

// ---- ABI & scenes
assert.equal(api.kijo_version(), 2);
assert.equal(getScene(api, 'focus').length, 4);
assert.equal(getScene(api, 'overview').length, 36);
assert.equal(getScene(api, 'workspaces').length, 9);
let tiles = getTiles(api);
assert.equal(tiles.filter(t => t.kind === KIND.GHOST).length, 3);
assert.equal(at(2, 2).id, 1);
assert.match(render(api, { view: 'focus' }), /GHOST/);
assert.match(render(api, { view: 'overview' }), /AGENT/);
assert.match(render(api, { view: 'workspaces' }), /WORKSPACE 2/);

// ---- ghost ownership (the original invariant, now on selection-driven ops)
select(1, 1);
const id = api.kijo_promote_ghost(1, 1);
assert.equal(id, 100);
assert.equal(at(1, 1).kind, KIND.REAL); assert.equal(at(1, 1).owner, 0);
assert.equal(api.kijo_close(1), 1);
assert.equal(at(1, 1).id, 100, 'independently promoted tile must survive close');
assert.equal(at(2, 1).kind, KIND.EMPTY, 'owned ghost cleaned'); assert.equal(at(1, 2).kind, KIND.EMPTY, 'owned ghost cleaned');
assert.equal(at(4, 0).id, 2, 'unrelated tile preserved');
assert.equal(api.kijo_close(1), 0, 'cannot close same tile twice');
assert.equal(api.kijo_status(id, 3), 1); assert.equal(at(1, 1).status, 3);

// ---- footprint spawn: 2x2 reservation, visible tile in the chosen corner
api.kijo_reset();
select(3, 3);
const fp = api.kijo_spawn(APP.NOTE, 2, 2, 0);
assert.ok(fp > 0);
assert.equal(at(3, 3).id, fp); for (const [x, y] of [[4, 3], [3, 4], [4, 4]]) { assert.equal(at(x, y).kind, KIND.GHOST); assert.equal(at(x, y).owner, fp); }
select(4, 4); assert.equal(api.kijo_spawn(APP.NOTE, 1, 1, 0), 0, 'cannot spawn onto a reservation');
select(5, 3); assert.equal(api.kijo_spawn(APP.NOTE, 2, 2, 0), 0, 'footprint must fit in the grid');
select(2, 3); assert.equal(api.kijo_spawn(APP.NOTE, 2, 2, 0), 0, 'footprint must not overlap a reservation');
const pid = (select(4, 4), api.kijo_promote_ghost(4, 4));
assert.ok(pid > 0);
assert.equal(api.kijo_close(fp), 1);
assert.equal(at(4, 4).id, pid, 'promoted slot survives owner close');
assert.equal(at(4, 3).kind, KIND.EMPTY); assert.equal(at(3, 4).kind, KIND.EMPTY);

// ---- dispatchers
api.kijo_reset();
assert.equal(dispatch(api, 'MOVEFOCUS', 0), 1); assert.equal(api.kijo_sel_x(), 1);
select(0, 0); assert.equal(dispatch(api, 'MOVEFOCUS', 0), 0, 'cannot leave the grid');
select(2, 2); assert.equal(dispatch(api, 'JUMPFOCUS', 1), 0, 'no real tile to the right in row 2');
select(1, 4); assert.equal(dispatch(api, 'JUMPFOCUS', 2), 0, 'nothing above (1,4) in column 1 except ghosts');
select(0, 4); assert.equal(dispatch(api, 'JUMPFOCUS', 1), 0);
select(5, 4); assert.equal(dispatch(api, 'JUMPFOCUS', 3), 1, 'jump down to the remote tile'); assert.equal(api.kijo_sel_y(), 5);
select(2, 2); assert.equal(dispatch(api, 'SWAP', 3), 1); assert.equal(at(2, 3).id, 1); assert.equal(api.kijo_sel_y(), 3);
assert.equal(at(2, 3).app, APP.SHELL);
select(2, 3); assert.equal(dispatch(api, 'MOVETOWORKSPACE', 2), 1, 'move to ws 3');
assert.equal(getTiles(api, 2)[0].id, 1); assert.equal(getTiles(api, 2)[0].owner, 0);
assert.equal(getTiles(api).filter(t => t.kind === KIND.GHOST).length, 0, 'owned ghosts left behind are cleaned');
assert.equal(dispatch(api, 'WORKSPACE', 2), 1); assert.equal(api.kijo_ws(), 2);
assert.equal(dispatch(api, 'CYCLEWORKSPACE', -1), 1); assert.equal(api.kijo_ws(), 1);
assert.equal(dispatch(api, 'TOGGLESPECIAL'), 1); assert.equal(api.kijo_special_open(), 1);
assert.equal(getTiles(api).filter(t => t.kind === KIND.REAL).length, 0, 'special workspace starts empty');
assert.equal(dispatch(api, 'TOGGLESPECIAL'), 1); assert.equal(dispatch(api, 'WORKSPACE', 9), 0);

// ---- OSC 7501 vocabulary: state, blocked kind, progress
api.kijo_reset();
assert.equal(api.kijo_report(2, 1, 0, 40), 1);
assert.equal(at(4, 0).status, 1); assert.equal(at(4, 0).progress, 40);
assert.equal(api.kijo_report(2, 2, 1, -1), 1);
assert.equal(at(4, 0).status, 2); assert.equal(at(4, 0).blockedKind, 1); assert.equal(at(4, 0).progress, 0, 'progress only while working');
assert.equal(api.kijo_report(2, 0, 0, -1), 1); assert.equal(at(4, 0).blockedKind, 0);
assert.equal(api.kijo_report(2, 9, 0, 0), 0, 'unknown state rejected'); assert.equal(api.kijo_report(999, 1, 0, 0), 0, 'unknown tile rejected');
api.kijo_report(2, 2, 3, -1);
const ws0 = getScene(api, 'workspaces')[0];
assert.equal(STATUS[ws0.status], 'blocked', 'workspace summary surfaces the most urgent state');
assert.match(barText(api), /1!/);

// ---- core event ring
const ev = getEvents(api);
assert.ok(ev.some(e => e.op === 4), 'status transitions recorded');
assert.equal(getEvents(api, api.kijo_event_total()).length, 0);

// ---- handleKey drives the same core ops
const opts = { view: 'focus', ghosts: true, notes: { ...DEFAULT_NOTES }, events: [] };
api.kijo_reset();
await handleKey(api, opts, '\x1b[A'); assert.equal(api.kijo_sel_y(), 1);
await handleKey(api, opts, 'n'); assert.ok(opts.notes[100], 'n on a ghost promotes it to a note'); assert.equal(selectedTile(api).app, APP.NOTE);
await handleKey(api, opts, 'x'); assert.equal(selectedTile(api).kind, KIND.EMPTY);
await handleKey(api, opts, '3'); assert.equal(opts.view, 'back');

// ---- persistence round trip (schema v2, includes every workspace, selection, notes)
const temp = mkdtempSync(join(tmpdir(), 'kijo-'));
const file = join(temp, 'state.json');
api.kijo_reset(); select(1, 1); const nid = api.kijo_promote_ghost(1, 1); dispatch(api, 'WORKSPACE', 1); select(5, 5);
persist(api, { [nid]: 'Permanent research note' }, file);
api.kijo_reset();
assert.equal(at(1, 1).kind, KIND.GHOST); assert.equal(api.kijo_ws(), 0);
const notes = restore(api, file);
assert.equal(at(1, 1, 0).id, nid); assert.equal(notes[nid], 'Permanent research note');
assert.equal(api.kijo_ws(), 1); assert.equal(api.kijo_sel_x(), 5);
assert.equal(getTiles(api, 1).filter(t => t.kind === KIND.REAL).length, 3, 'other workspaces restored');
rmSync(temp, { recursive: true, force: true });

// ---- fuzz: random operations never create orphan ghosts or hide the selection
let seed = 20261020;
const rnd = n => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
api.kijo_reset();
for (let step = 0; step < 4000; step++) {
  const r = rnd(10);
  if (r < 3) dispatch(api, 'MOVEFOCUS', rnd(4));
  else if (r === 3) api.kijo_spawn(1 + rnd(6), 1 + rnd(3), 1 + rnd(3), rnd(4));
  else if (r === 4) api.kijo_promote_ghost(api.kijo_sel_x(), api.kijo_sel_y());
  else if (r === 5) dispatch(api, 'KILLACTIVE');
  else if (r === 6) dispatch(api, 'SWAP', rnd(4));
  else if (r === 7) dispatch(api, 'MOVETOWORKSPACE', rnd(9));
  else if (r === 8) dispatch(api, rnd(2) ? 'CYCLEWORKSPACE' : 'TOGGLESPECIAL', rnd(2) ? 1 : -1);
  else api.kijo_select(rnd(6), rnd(6));
  for (let w = 0; w < 10; w++) {
    const ts = getTiles(api, w);
    for (const g of ts.filter(t => t.kind === KIND.GHOST)) {
      const owner = ts.find(t => t.kind === KIND.REAL && t.id === g.owner);
      assert.ok(owner, `orphan ghost in ws ${w} after step ${step}`);
      assert.equal(owner.group, g.group); assert.equal(owner.tx, g.tx);
    }
    const ids = ts.filter(t => t.kind === KIND.REAL).map(t => t.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate real ids');
  }
  const [vx, vy, sx, sy] = [api.kijo_focus_x(), api.kijo_focus_y(), api.kijo_sel_x(), api.kijo_sel_y()];
  assert.ok(sx >= vx && sx < vx + 2 && sy >= vy && sy < vy + 2, `selection outside focus viewport at step ${step}`);
}
console.log('PASS — WASM v2: workspaces, dispatchers, ghost ownership + footprints, OSC 7501 status, events, persistence, fuzz');
