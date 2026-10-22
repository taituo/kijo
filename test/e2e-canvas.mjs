let chromium; try { ({ chromium } = await import('playwright')); } catch { console.log('SKIP e2e-canvas: playwright not installed (npm i -D playwright)'); process.exit(0); }
import assert from 'node:assert/strict';
import { bundle } from '../src/bundle.mjs';
import { startDaemon } from '../src/kijod.mjs';
import { mkdirSync } from 'node:fs';
// The canvas in a real Chrome behind a real kijod: wheel zoom about the pointer, drag to pan, drag a node,
// the minimap, double-click to write, keys, an agent posting {t:'canvas'} to kijod, JSON Canvas paste, reload.
// KIJO_SHOTS=dir saves screenshots of each stage.
const SHOTS = process.env.KIJO_SHOTS; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const d = await startDaemon({ port: 0, token: 'tok-canvas', collect: false, quiet: true, ui: bundle() });
const browser = await chromium.launch({ executablePath: process.env.KIJO_CHROME, args: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage(); const errs = []; const bad = []; page.on('response', r => r.status() >= 400 && !(r.status() === 404 && /\/api\/session\/default$/.test(r.url())) && bad.push(r.status() + ' ' + r.url())); // 404 there means 'no saved layout yet' page.on('console', m => m.type() === 'error' && errs.push(m.text())); page.on('pageerror', e => errs.push(String(e)));
const base = `http://127.0.0.1:${d.port}/?renderer=${process.env.KIJO_RENDERER || '2d'}`;
await page.goto(base + '&fresh#token=tok-canvas'); await page.waitForFunction(() => globalThis.__kijo?.frames > 5, null, { timeout: 15000 });
const q = (fn, a) => page.evaluate(fn, a), until = (fn, arg, ms = 6000) => page.waitForFunction(fn, arg, { timeout: ms });
const shot = async name => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };
const settle = () => until(() => !__kijo.api.kijo_canvas_step(0) && __kijo.frames > 0).then(() => page.waitForTimeout(120));
const cam = () => q(() => ({ x: __kijo.api.kijo_canvas_cam_x(), y: __kijo.api.kijo_canvas_cam_y(), z: __kijo.api.kijo_canvas_zoom() / 65536 }));
const node = id => q(i => __kijo.api && globalThis.kijo.canvas.nodes().find(n => n.id === i), id);
const area = () => q(() => __kijo.lastArea ?? null);
await until(() => __kijo.st.view === 'focus');

// ---- key 7 opens the canvas; the demo region is framed
await page.keyboard.press('7'); await until(() => __kijo.st.view === 'canvas'); await settle(); await shot('1-canvas');
const nodes0 = await q(() => kijo.canvas.nodes()); assert.equal(nodes0.length, 10);
const sel0 = await q(() => __kijo.api.kijo_canvas_sel()); assert.equal(sel0, 1000001);

// ---- wheel zooms about the pointer: the world point under the cursor stays put
const at = (x, y) => q(([x, y]) => { const a = __kijo.area(); __kijo.api.kijo_canvas_to_world(Math.round(x - a.x), Math.round(y - a.y)); return Array.from(new Int32Array(__kijo.api.memory.buffer, __kijo.api.kijo_canvas_qbuf_ptr(), 2)); }, [x, y]);
const w0 = await at(300, 300), z0 = (await cam()).z;
await page.mouse.move(300, 300); await page.mouse.wheel(0, -240); await page.waitForTimeout(150);
const z1 = (await cam()).z, w1 = await at(300, 300);
assert.ok(z1 > z0 * 1.2, `wheel up zooms in: ${z0} -> ${z1}`);
assert.ok(Math.abs(w1[0] - w0[0]) <= 2 && Math.abs(w1[1] - w0[1]) <= 2, `zoom keeps the point under the pointer: ${w0} vs ${w1}`);
await shot('2-zoomed');

// ---- drag on empty space pans by exactly the drag
await page.keyboard.press('Escape'); await settle();
const c0 = await cam();
const empty = await q(() => { const a = __kijo.area(); for (let y = a.y + 30; y < a.y + a.h - 30; y += 20) for (let x = a.x + 30; x < a.x + 500; x += 20) if (!__kijo.hitAt(x, y)) return [x, y]; return null; });
assert.ok(empty, 'some empty canvas to grab');
await page.mouse.move(...empty); await page.mouse.down(); await page.mouse.move(empty[0] + 120, empty[1] + 60, { steps: 6 }); await page.mouse.up();
const c1 = await cam();
assert.ok(Math.abs((c0.x - c1.x) * c0.z - 120) <= 2 && Math.abs((c0.y - c1.y) * c0.z - 60) <= 2, `pan follows the pointer: ${JSON.stringify([c0, c1])}`);

// ---- drag a node moves it (and only it); dragging its group takes what the group contains
await page.keyboard.press('Escape'); await settle();
const hitOf = id => q(i => __kijo.hits().find(h => h.kind === 'cnode' && h.id === i), id);
let h = await hitOf(1000002); assert.ok(h, 'note 1000002 is on screen and clickable');
const before = await node(1000002), z = (await cam()).z;
await page.mouse.move(h.x + h.w / 2, h.y + h.h / 2); await page.mouse.down(); await page.mouse.move(h.x + h.w / 2 + 50, h.y + h.h / 2 + 30, { steps: 5 }); await page.mouse.up();
const after = await node(1000002);
assert.ok(Math.abs(after.x - before.x - 50 / z) <= 2 && Math.abs(after.y - before.y - 30 / z) <= 2, `node follows the pointer: ${before.x},${before.y} -> ${after.x},${after.y}`);
assert.equal(await q(() => __kijo.api.kijo_canvas_sel()), 1000002, 'and is selected');
h = await hitOf(1000000); const g0 = await node(1000000), inner0 = await node(1000005);
await page.mouse.move(h.x + 8, h.y + 6); await page.mouse.down(); await page.mouse.move(h.x + 8 - 40, h.y + 6 - 20, { steps: 4 }); await page.mouse.up();
const g1 = await node(1000000), inner1 = await node(1000005);
assert.ok(g1.x < g0.x && Math.abs((g1.x - g0.x) - (inner1.x - inner0.x)) <= 1 && Math.abs((g1.y - g0.y) - (inner1.y - inner0.y)) <= 1, 'a group carries its contents');
await shot('3-dragged');

// ---- the minimap: hidden while everything is in view, shown once something is off screen; a click jumps there
await page.keyboard.press('Escape'); await settle(); assert.equal(await q(() => __kijo.hits().some(x => x.kind === 'minimap')), false, 'no minimap when it would only cover content');
await q(() => __kijo.api.kijo_canvas_select(1000001)); await page.keyboard.press('Enter'); await settle();
const mm = await q(() => __kijo.hits().find(x => x.kind === 'minimap')); assert.ok(mm, 'minimap drawn');
await page.mouse.click(mm.x + mm.w - 4, mm.y + mm.h - 4); await settle();
const cfar = await cam(); assert.ok(cfar.x > 2500 && cfar.y > 1500, `minimap corner jumps to the far region: ${JSON.stringify(cfar)}`);
await shot('4-minimap-jump');

// ---- keys: Esc frames everything; arrows walk; Enter flies; + zooms
await page.keyboard.press('Escape'); await settle();
assert.ok((await q(() => __kijo.hits().filter(x => x.kind === 'cnode').length)) >= 10, 'everything is in view');
await q(() => __kijo.api.kijo_canvas_select(1000001));
await page.keyboard.press('ArrowRight'); assert.equal(await q(() => __kijo.api.kijo_canvas_sel()), 1000002);
await page.keyboard.press('Enter'); await settle(); assert.ok((await cam()).z > 1.5, 'Enter flies close to the selection');
await shot('5-flown');
await page.keyboard.press('Escape'); await settle();

// ---- double-click empty space: a new note right there, already in edit mode
const e2 = await q(() => { const a = __kijo.area(); for (let y = a.y + a.h - 120; y > a.y + 100; y -= 20) for (let x = a.x + 200; x < a.x + 700; x += 20) if (!__kijo.hitAt(x, y) && !__kijo.hitAt(x - 140, y - 90) && !__kijo.hitAt(x + 140, y + 90)) return [x, y]; return null; });
assert.ok(e2, 'room for a note');
const count0 = await q(() => __kijo.api.kijo_canvas_node_count());
await page.mouse.dblclick(...e2); await until(() => !!__kijo.st.editing);
await page.keyboard.type('Written on the canvas '); for (const ch of 'äö') await q(k => dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })), ch); // a Finnish keyboard sends key='ä'
await page.keyboard.press('Escape');
assert.equal(await q(() => __kijo.api.kijo_canvas_node_count()), count0 + 1);
const nid = await q(() => __kijo.api.kijo_canvas_sel()); assert.equal(await q(i => __kijo.st.notes[i], nid), 'Written on the canvas äö');
await settle(); await shot('6-written');

// ---- an agent talks to kijod; the page's core applies it next to what it relates to
const post = body => fetch(`http://127.0.0.1:${d.port}/ingest`, { method: 'POST', headers: { authorization: 'Bearer tok-canvas', 'x-kijo-source': 'agent-1' }, body }).then(r => r.json());
let r = await post(JSON.stringify({ t: 'canvas', op: 'reserve', id: 'agent-out', owner: 1000003, dir: 'down' }));
assert.equal(r.accepted, 1);
await until(() => kijo.canvas.nodes().some(n => n.name === 'agent-out' && n.app === 'ghost'), null, 8000);
r = await post([
  JSON.stringify({ t: 'canvas', op: 'status', id: 1000003, state: 'working', progress: 80 }),
  JSON.stringify({ t: 'canvas', op: 'fill', id: 'agent-out', app: 'note', text: 'Agent result: the p95 regression starts at deploy 41.' }),
  JSON.stringify({ t: 'canvas', op: 'link', from: 1000003, to: 'agent-out', label: 'wrote' }),
].join('\n'));
assert.equal(r.accepted, 3);
await until(() => kijo.canvas.nodes().some(n => n.name === 'agent-out' && n.app === 'note' && /deploy 41/.test(n.text || '')), null, 8000);
const out = await q(() => kijo.canvas.nodes().find(n => n.name === 'agent-out')), ag = await node(1000003);
assert.ok(out.y >= ag.y + ag.h, 'the agent put its work below itself');
assert.equal((await post(JSON.stringify({ t: 'canvas', op: 'shell', cmd: 'rm -rf /' }))).accepted, 0, 'the relay rejects unknown canvas ops');
await page.keyboard.press('Escape'); await settle(); await shot('7-agent');

// ---- pasting a JSON Canvas document imports it beside what is there
const doc = { nodes: [{ id: 'p1', type: 'text', text: 'Pasted from Obsidian', x: 0, y: 0, width: 260, height: 120 }, { id: 'p2', type: 'link', url: 'https://jsoncanvas.org', x: 320, y: 0, width: 260, height: 120 }], edges: [{ id: 'pe', fromNode: 'p1', toNode: 'p2' }] };
await q(j => navigator.clipboard.writeText(j), JSON.stringify(doc));
await page.keyboard.press('Control+v');
await until(() => kijo.canvas.nodes().some(n => n.name === 'p1') && kijo.canvas.nodes().some(n => n.name === 'p2'));
const exp = await q(() => kijo.canvas.export());
assert.ok(exp.edges.some(e => e.fromNode === 'p1' && e.toNode === 'p2'), 'the edge came along');
assert.ok(exp.nodes.find(n => n.id === 'p2').type === 'link', 'and the node types');
await settle(); await shot('8-pasted');

// ---- persistence: everything is back after a reload
await page.waitForTimeout(500);
await page.goto(base + '#token=tok-canvas'); await page.waitForFunction(() => globalThis.__kijo?.frames > 5, null, { timeout: 15000 });
await page.keyboard.press('7'); await until(() => __kijo.st.view === 'canvas');
const names = await q(() => kijo.canvas.nodes().map(n => n.name));
for (const n of ['agent-out', 'p1', 'p2']) assert.ok(names.includes(n), 'reload keeps ' + n);
assert.equal(await q(i => __kijo.st.notes[i], nid), 'Written on the canvas äö');
await settle(); await shot('9-reloaded');

const real = errs.filter(e => !(bad.length === 0 && /status of 404/.test(e)));
console.log('E2E canvas OK; console errors:', JSON.stringify(real)); assert.deepEqual(real, []); assert.deepEqual(bad, [], 'no failed requests besides the empty session');
await browser.close(); await d.close();
