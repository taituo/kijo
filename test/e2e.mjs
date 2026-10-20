let chromium; try { ({ chromium } = await import('playwright')); } catch { console.log('SKIP e2e: playwright not installed (npm i -D playwright)'); process.exit(0); }
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { bundle } from '../src/bundle.mjs';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'kijo-e2e-')); writeFileSync(join(dir, 'kijo.html'), bundle());
const BUNDLE = 'file://' + join(dir, 'kijo.html');
const browser = await chromium.launch({ executablePath: process.env.KIJO_CHROME, args: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = []; page.on('console', m => m.type() === 'error' && errs.push(m.text())); page.on('pageerror', e => errs.push(String(e)));
await page.goto(BUNDLE + '?renderer=2d&fresh');
await page.waitForFunction(() => globalThis.__kijo?.frames > 5, null, { timeout: 15000 });
const q = fn => page.evaluate(fn);
const sel = () => q(() => [__kijo.api.kijo_sel_x(), __kijo.api.kijo_sel_y(), __kijo.api.kijo_ws(), __kijo.st.view]);
assert.deepEqual(await sel(), [2, 2, 0, 'focus']);
await page.keyboard.press('ArrowLeft'); assert.deepEqual((await sel()).slice(0, 2), [1, 2]);
await page.keyboard.press('ArrowUp'); await page.keyboard.press('n');             // promote ghost at (1,1)
assert.equal(await q(() => __kijo.api.kijo_node_count() > 0), true);
assert.equal(await q(() => Object.keys(__kijo.st.notes).includes('100')), true, 'note created by promoting a ghost');
await page.keyboard.press('e'); await page.keyboard.type('Hello board'); await page.keyboard.press('Enter'); await page.keyboard.type('line two '); for (const ch of '\u00e4\u00f6\u00e5\u00c4\u00d6\u00c5') await page.evaluate(k => dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })), ch); await page.keyboard.press('Escape'); // (ä etc.: keydown with key='ä', as a Finnish keyboard sends it)
assert.equal(await q(() => __kijo.st.notes[100]), 'Hello board\nline two \u00e4\u00f6\u00e5\u00c4\u00d6\u00c5');
// workspaces via Alt+digit and clicks on the bar pills
await page.keyboard.press('Alt+Digit2'); assert.equal((await sel())[2], 1);
await page.mouse.click(67, 19); assert.equal((await sel())[2], 0, 'clicking pill 1 switches workspace');
// palette search finds the note and jumps to it
await page.keyboard.press('/'); await page.keyboard.type('hello');
assert.equal(await q(() => __kijo.st.palette.items[0].title.startsWith('Hello board')), true);
await page.keyboard.press('Enter');
assert.deepEqual((await sel()).slice(0, 2), [1, 1]); assert.equal(await q(() => __kijo.st.palette), null);
// views, close with ghost cascade, persistence across reload
await page.keyboard.press('3'); assert.equal((await sel())[3], 'back');
await page.keyboard.press('1');
await page.keyboard.press('Alt+Shift+Digit3');
assert.equal(await q(() => __kijo.api.kijo_ws()), 0);
await page.reload(); await page.waitForFunction(() => globalThis.__kijo?.frames > 5);
assert.equal(await q(() => __kijo.st.notes[100]), undefined, 'fresh param ignores saved state');
await page.goto('' + BUNDLE + '?renderer=2d'); await page.waitForFunction(() => globalThis.__kijo?.frames > 5);
assert.equal(await q(() => __kijo.st.notes[100]), 'Hello board\nline two \u00e4\u00f6\u00e5\u00c4\u00d6\u00c5', 'notes persisted in localStorage');
assert.equal(await q(() => [...document.querySelectorAll('body > *')].filter(e => e.tagName !== 'SCRIPT').map(e => e.tagName).join()), 'CANVAS', 'DOM contains only the canvas');

// ---- telemetry: the browser alone is a complete runtime (no relay, nothing installed)
await page.goto(BUNDLE + '?renderer=2d&fresh'); await page.waitForFunction(() => globalThis.__kijo?.frames > 5);
await q(() => { const now = Date.now(); for (let i = 60; i >= 0; i--) kijo.inject(`queue.depth ${10 + (i % 9)}`, 'e2e'); kijo.inject('{"t":"metric","name":"jobs","value":4}', 'e2e'); kijo.inject('{"t":"log","level":"error","body":"boom from e2e"}', 'e2e'); });
assert.equal(await q(() => __kijo.store.series.has('queue.depth') && __kijo.store.logs.some(l => l.body === 'boom from e2e')), true, 'window.kijo.inject feeds the store');
assert.equal(await q(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'pasted.metric 7'); const ev = new ClipboardEvent('paste', { clipboardData: dt, cancelable: true }); dispatchEvent(ev); return ev.defaultPrevented && __kijo.store.series.has('pasted.metric'); }), true, 'paste injects');
assert.equal(await q(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'just some words'); const ev = new ClipboardEvent('paste', { clipboardData: dt, cancelable: true }); dispatchEvent(ev); return ev.defaultPrevented; }), false, 'ordinary pastes are left alone');
// status injection drives the real core
await q(() => kijo.inject('{"t":"status","id":1,"state":"blocked","kind":"permission"}', 'agent-x'));
assert.equal(await q(() => __kijo.tiles(0).find(t => t.id === 1).status), 2, 'status injected through the store reaches the WASM tile (blocked)');
await page.keyboard.press('/'); await page.keyboard.type('pin chart: queue'); await page.keyboard.press('Enter');
assert.equal(await q(() => Object.values(__kijo.st.bindings).includes('queue.depth')), true, 'palette pins an injected series as a chart tile');
await page.keyboard.press('6'); assert.equal((await sel())[3], 'flow');
assert.equal(await q(() => __kijo.store.sources.has('e2e') && __kijo.store.sources.has('browser')), true, 'sources are tracked per injector');
await page.keyboard.press('Escape'); assert.equal((await sel())[3], 'focus');
// persistence of bindings
await page.goto(BUNDLE + '?renderer=2d'); await page.waitForFunction(() => globalThis.__kijo?.frames > 5);
assert.equal(await q(() => Object.values(__kijo.st.bindings).includes('queue.depth')), true, 'bindings survive reload');

// ---- 3D surface tile: renders (2D fallback path here), orbits on drag, no errors
await page.goto(BUNDLE + '?renderer=2d&fresh'); await page.waitForFunction(() => globalThis.__kijo?.frames > 5);
await q(() => { const now = Date.now(); for (let i = 60; i >= 0; i--) for (let k = 0; k < 4; k++) kijo.inject(JSON.stringify({ t: 'metric', name: 'cpu.core_pct', value: (i * 7 + k * 25) % 100, unit: '%', labels: { core: String(k) }, ts: now - i * 1000 }), 'e2e-3d'); });
await page.keyboard.press('Alt+Digit5'); await page.waitForTimeout(900);
assert.equal(await q(() => __kijo.tiles(4).some(t => t.kind === 1 && t.app === 11)), true, 'workspace 5 holds a 3D tile');
await page.mouse.move(300, 250); await page.mouse.down(); await page.mouse.move(380, 280, { steps: 4 }); await page.mouse.up();
assert.equal(await q(() => __kijo.st.cam.manual === true && Math.abs(__kijo.st.cam.yaw - 0.6) > 0.05), true, 'dragging the tile orbits the camera');
await page.keyboard.press('/'); await page.keyboard.type('pin 3d'); await page.keyboard.press('Enter');
assert.equal(await q(() => __kijo.tiles(4).filter(t => t.kind === 1 && t.app === 11).length), 2, 'palette pins another 3D surface');

// ---- selectable, copyable text: drag over a logs tile, Ctrl+C puts the text (not pixels) on the clipboard
await page.goto(BUNDLE + '?renderer=2d&fresh'); await page.waitForFunction(() => globalThis.__kijo?.frames > 5);
await q(() => { kijo.inject('{"t":"log","level":"warn","body":"copy me: disk almost full"}', 'e2e-sel'); kijo.inject('{"t":"log","level":"info","body":"second line to copy"}', 'e2e-sel'); });
await page.keyboard.press('Alt+Digit5'); await page.waitForTimeout(900);
await q(() => { globalThis.__copied = null; addEventListener('copy', e => { globalThis.__copied = e.clipboardData.getData('text/plain'); }); });
await page.mouse.move(660, 110); await page.mouse.down(); await page.mouse.move(1100, 445, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(300);
const picked = await q(() => __kijo.selectedText());
assert.match(picked, /copy me: disk almost full/); assert.match(picked, /second line to copy/);
await page.keyboard.press('Control+c'); await page.waitForTimeout(200);
assert.match(await q(() => globalThis.__copied), /copy me: disk almost full/, 'Ctrl+C copies the selected text');
await page.keyboard.press('Escape'); assert.equal(await q(() => __kijo.st.sel), null, 'Escape clears the selection');
await page.keyboard.press('Control+a'); await page.waitForTimeout(200); assert.match(await q(() => __kijo.selectedText()), /second line to copy/, 'Ctrl+A selects the focused tile');

// ---- optional relay: same page, remote injector, token only in the fragment
const { startDaemon } = await import('../src/kijod.mjs');
const d = await startDaemon({ port: 0, token: 'e2e-token', collect: true, ui: bundle(), quiet: true });
const page2 = await browser.newPage({ viewport: { width: 1280, height: 800 } }); page2.on('pageerror', e => errs.push(String(e)));
await page2.goto(`http://127.0.0.1:${d.port}/?renderer=2d&fresh#token=e2e-token`);
await page2.waitForFunction(() => globalThis.__kijo?.store?.series.has('cpu.util_pct'), null, { timeout: 15000 });
assert.equal(await page2.evaluate(() => location.hash), '', 'token removed from the address bar');
await fetch(`http://127.0.0.1:${d.port}/ingest`, { method: 'POST', headers: { authorization: 'Bearer e2e-token', 'x-kijo-source': 'vps-agent' }, body: '{"t":"status","id":1,"state":"error"}\nremote.queue 99' });
await page2.waitForFunction(() => __kijo.store.series.has('remote.queue') && __kijo.store.sources.has('vps-agent'), null, { timeout: 8000 });
assert.equal(await page2.evaluate(() => __kijo.tiles(0).find(t => t.id === 1).status), 3, 'status injected on the VPS reaches the tile in this browser (error)');
await page2.keyboard.press('ArrowLeft'); await page2.waitForTimeout(1200);
assert.ok((await (await fetch(`http://127.0.0.1:${d.port}/api/session/default`, { headers: { authorization: 'Bearer e2e-token' } })).json()).version === 2, 'layout syncs to the relay');
await d.close();
console.log('E2E OK; console errors:', errs.filter(e => !/404/.test(e)));
await browser.close();
