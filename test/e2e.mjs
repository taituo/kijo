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
await page.keyboard.press('e'); await page.keyboard.type('Hello board'); await page.keyboard.press('Enter'); await page.keyboard.type('line two'); await page.keyboard.press('Escape');
assert.equal(await q(() => __kijo.st.notes[100]), 'Hello board\nline two');
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
assert.equal(await q(() => __kijo.st.notes[100]), 'Hello board\nline two', 'notes persisted in localStorage');
assert.equal(await q(() => [...document.querySelectorAll('body > *')].filter(e => e.tagName !== 'SCRIPT').map(e => e.tagName).join()), 'CANVAS', 'DOM contains only the canvas');
console.log('E2E OK; console errors:', errs.filter(e => !/404/.test(e)));
await browser.close();
