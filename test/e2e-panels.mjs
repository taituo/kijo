let chromium; try { ({ chromium } = await import('playwright')); } catch { console.log('SKIP e2e-panels: playwright not installed (npm i -D playwright)'); process.exit(0); }
import assert from 'node:assert/strict';
import { bundle } from '../src/bundle.mjs';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Panels and square cells in a real Chrome: pin a stat/gauge/bars/status through the palette, zoom with Z, survive a reload.
const dir = mkdtempSync(join(tmpdir(), 'kijo-e2e-panels-')); writeFileSync(join(dir, 'kijo.html'), bundle());
const browser = await chromium.launch({ executablePath: process.env.KIJO_CHROME, args: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage(); const errs = []; page.on('console', m => m.type() === 'error' && errs.push(m.text())); page.on('pageerror', e => errs.push(String(e)));
const url = 'file://' + join(dir, 'kijo.html') + '?renderer=2d&fresh';
await page.goto(url); await page.waitForFunction(() => globalThis.__kijo?.frames > 5, null, { timeout: 15000 });
const q = fn => page.evaluate(fn), until = (fn, arg, ms = 6000) => page.waitForFunction(fn, arg, { timeout: ms });
await page.keyboard.press('Alt+Digit8');                         // an empty workspace
await q(() => { for (let i = 0; i < 30; i++) { __kijo.store.push('probe.load_pct', 20 + i, Date.now() - (30 - i) * 1000, { unit: '%' }); for (let k = 0; k < 3; k++) __kijo.store.push('probe.core_pct', 10 + k * 30, Date.now() - (30 - i) * 1000, { unit: '%', labels: { core: String(k) } }); } });
for (const [kind, name] of [['stat', 'probe.load_pct'], ['gauge', 'probe.load_pct'], ['bars', 'probe.core_pct'], ['status', 'probe.load_pct']]) {
  await page.keyboard.press('Control+k'); await page.keyboard.type(`Pin ${kind}: ${name}`); await until(() => document.activeElement !== null);
  await page.keyboard.press('Enter');
}
const viz = await q(() => Object.values(__kijo.st.viz)); assert.deepEqual(viz.sort(), ['bars', 'gauge', 'stat', 'status']);
// zoom: the selected tile fills the area, and Esc leaves zoom before leaving the view
await page.keyboard.press('z'); await until(() => __kijo.st.zoom === true);
await page.keyboard.press('Escape'); await until(() => __kijo.st.zoom === false); assert.equal(await q(() => __kijo.st.view), 'focus');
// persistence: the looks come back after a reload (same origin, no ?fresh)
await page.waitForTimeout(400);
await page.goto(url.replace('&fresh', '')); await page.waitForFunction(() => globalThis.__kijo?.frames > 5, null, { timeout: 15000 });
assert.deepEqual((await q(() => Object.values(__kijo.st.viz))).sort(), ['bars', 'gauge', 'stat', 'status']);
console.log('E2E panels OK; console errors:', JSON.stringify(errs)); assert.deepEqual(errs, []);
await browser.close();
