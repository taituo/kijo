let chromium; try { ({ chromium } = await import('playwright')); } catch { console.log('SKIP e2e-logs: playwright not installed (npm i -D playwright)'); process.exit(0); }
import assert from 'node:assert/strict';
import { bundle } from '../src/bundle.mjs';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The log tile in a real Chrome: find, scroll, stay put while new lines arrive, copy only what is shown.
const dir = mkdtempSync(join(tmpdir(), 'kijo-e2e-logs-')); writeFileSync(join(dir, 'kijo.html'), bundle());
const browser = await chromium.launch({ executablePath: process.env.KIJO_CHROME, args: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage(); const errs = []; page.on('console', m => m.type() === 'error' && errs.push(m.text())); page.on('pageerror', e => errs.push(String(e)));
await page.goto('file://' + join(dir, 'kijo.html') + '?renderer=2d&fresh'); await page.waitForFunction(() => globalThis.__kijo?.frames > 5, null, { timeout: 15000 });
const q = fn => page.evaluate(fn), until = (fn, arg, ms = 6000) => page.waitForFunction(fn, arg, { timeout: ms });
await page.keyboard.press('Alt+Digit5');                       // workspace 5: logs tile (id 19) at 2,1
await q(() => { __kijo.api.kijo_select(2, 1); for (let i = 0; i < 200; i++) __kijo.store.log(`job ${i} ${i % 5 === 0 ? 'timeout upstream' : 'ok'}`, i % 25 === 0 ? 'error' : 'info', Date.now() - (200 - i) * 500); });
await until(() => __kijo.api.kijo_sel_x() === 2); await page.keyboard.press('Control+a'); await until(() => /job 199/.test(__kijo.selectedText()));
await page.keyboard.press('Escape');
// scroll back with PageUp; the view stays put while new lines arrive
await page.keyboard.press('PageUp'); await until(() => __kijo.st.logv[19]?.off > 0);
await page.keyboard.press('Control+a'); await until(() => /job 1\d\d/.test(__kijo.selectedText()) && !/job 199/.test(__kijo.selectedText()));
await page.keyboard.press('Escape');
const before = await q(() => __kijo.st.logv[19].off);
await q(() => { for (let i = 0; i < 7; i++) __kijo.store.log('late arrival ' + i, 'info'); });
await until(b => __kijo.st.logv[19].off === b + 7, before, 4000);
await page.keyboard.press('End'); await until(() => __kijo.st.logv[19].off === 0);
// find: only matching lines are shown and copied
await page.keyboard.press('Control+f'); await page.keyboard.type('timeout -error'); await page.keyboard.press('Enter');
await until(() => __kijo.st.logv[19].q === 'timeout -error' && !__kijo.st.logv[19].edit);
await page.keyboard.press('Control+a');
await until(() => /timeout upstream/.test(__kijo.selectedText()));
const t = await q(() => __kijo.selectedText()); assert.ok(t.split('\n').every(l => /timeout/.test(l) && !/ERRO/.test(l)), 'only matching lines: ' + t.slice(0, 160));
await page.keyboard.press('Control+c'); await page.waitForTimeout(150);
assert.match(await page.evaluate(() => navigator.clipboard.readText()), /timeout upstream/);
await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await until(() => __kijo.st.logv[19].q === '');   // Esc clears selection, then the filter
// the palette can copy the whole (filtered) buffer, not just the visible rows
await page.keyboard.press('/'); await page.keyboard.type('copy all lines'); await page.keyboard.press('Enter'); await page.waitForTimeout(200);
const all = await page.evaluate(() => navigator.clipboard.readText()); assert.ok(all.split('\n').length >= 200 && /job 0 /.test(all), 'copy-all has every line, got ' + all.split('\n').length);
console.log('E2E logs OK; console errors:', errs.filter(e => !/404/.test(e)));
await browser.close();
