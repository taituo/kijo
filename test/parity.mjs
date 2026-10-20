// Two hosts, one core: the JS host (src/core.mjs) and the native host (native/, Rust + wasmi) run the same
// scripted scenario against the same core/scene.wasm and must end in byte-identical observable state:
// return values, selection, every workspace's tiles, every view's scene nodes, the event ring.
// Needs a Rust toolchain; skips (with a message) without one. KIJO_NATIVE=/path/to/kijo-native skips the build.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { instantiateCore, VIEWS } from '../src/core.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wasm = readFileSync(join(root, 'core/scene.wasm'));

// ---- scenario: a hand-written session, then a seeded random walk over every mutating export
const rnd = (seed => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32))(20260101);
const pick = a => a[Math.floor(rnd() * a.length)], int = n => Math.floor(rnd() * n);
const steps = [['kijo_reset'], ['kijo_select', 1, 1], ['kijo_dispatch', 2, 3, 0], ['kijo_dispatch', 7, 2, 2], ['kijo_spawn', 5, 2, 2, 0], ['kijo_report', 1, 2, 1, -1], ['kijo_report', 1, 1, 0, 60], ['kijo_dispatch', 6, 1, 0], ['kijo_dispatch', 5, 0, 0], ['kijo_dispatch', 5, 0, 0], ['kijo_dispatch', 3, 4, 0]];
for (let i = 0; i < 400; i++) {
  const r = rnd();
  if (r < 0.25) steps.push(['kijo_dispatch', 1, int(4), 0]);                         // movefocus
  else if (r < 0.35) steps.push(['kijo_dispatch', 2, int(9), 0]);                    // workspace
  else if (r < 0.43) steps.push(['kijo_dispatch', 3, int(9), 0]);                    // movetoworkspace
  else if (r < 0.48) steps.push(['kijo_dispatch', 4, 0, 0]);                         // killactive
  else if (r < 0.52) steps.push(['kijo_dispatch', 5, 0, 0]);                         // togglespecial
  else if (r < 0.60) steps.push(['kijo_dispatch', 6, int(4), 0]);                    // swap
  else if (r < 0.64) steps.push(['kijo_dispatch', 8, pick([-1, 1]), 0]);            // cycleworkspace
  else if (r < 0.74) steps.push(['kijo_select', int(6), int(6)]);
  else if (r < 0.84) steps.push(['kijo_spawn', 1 + int(11), 1 + int(2), 1 + int(2), int(4)]);
  else if (r < 0.89) steps.push(['kijo_promote_ghost', int(6), int(6)]);
  else if (r < 0.97) steps.push(['kijo_report', 1 + int(30), int(5), int(4), int(110) - 5]);
  else steps.push(['kijo_close', 1 + int(30)]);
}
const scenario = { steps };

// ---- JS host
const api = await instantiateCore(wasm);
const SIDE = 6, ints = (ptr, n) => Array.from(new Int32Array(api.memory.buffer, ptr, n));
const call = (n, a) => { const r = api[n](...a); return typeof r === 'number' ? r : 0; };
const ret = steps.map(([n, ...a]) => call(n, a));
const tiles = ws => { const n = api.kijo_tile_count(); return ints(ws == null ? api.kijo_tile_ptr() : api.kijo_ws_tile_ptr(ws), n * 10); };
const js = {
  ret,
  head: ['kijo_ws', 'kijo_special_open', 'kijo_sel_x', 'kijo_sel_y', 'kijo_focus_x', 'kijo_focus_y', 'kijo_tile_count', 'kijo_workspace_count'].map(n => api[n]()),
  active: tiles(), ws: Array.from({ length: 10 }, (_, w) => tiles(w)),
  views: VIEWS.map((_, v) => { api.kijo_build_scene(v); return ints(api.kijo_node_ptr(), api.kijo_node_count() * 15); }),
  events: { total: api.kijo_event_total(), ring: ints(api.kijo_event_ptr(), api.kijo_event_capacity() * 5) },
};
assert.ok(js.views[0].length > 0 && js.events.total > 100, 'the scenario actually did things: ' + js.events.total + ' events');

// ---- native host
let bin = process.env.KIJO_NATIVE;
if (!bin) {
  if (spawnSync('cargo', ['--version']).status !== 0) { console.log('SKIP parity: no Rust toolchain (the JS half passed; set KIJO_NATIVE or install cargo)'); process.exit(0); }
  execFileSync('cargo', ['build', '--release', '--quiet', '--manifest-path', join(root, 'native/Cargo.toml')], { stdio: 'inherit' });
  bin = join(root, 'native/target/release/kijo-native');
}
assert.ok(existsSync(bin), 'native binary at ' + bin);
const dir = mkdtempSync(join(tmpdir(), 'kijo-parity-')), file = join(dir, 'scenario.json'); writeFileSync(file, JSON.stringify(scenario));
const native = JSON.parse(execFileSync(bin, ['parity', file], { maxBuffer: 1 << 28 }).toString());
for (const k of ['ret', 'head', 'active', 'ws', 'views', 'events']) assert.deepEqual(native[k], js[k], `native and JS hosts disagree on ${k}`);
console.log(`PASS — parity: JS and native (wasmi) hosts agree on ${steps.length} calls, ${js.events.total} events, 10 workspaces x tiles, ${VIEWS.length} views of scene nodes`);
