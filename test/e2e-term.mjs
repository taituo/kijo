let chromium; try { ({ chromium } = await import('playwright')); } catch { console.log('SKIP e2e-term: playwright not installed (npm i -D playwright)'); process.exit(0); }
import assert from 'node:assert/strict';
import { bundle } from '../src/bundle.mjs';
import { startDaemon } from '../src/kijod.mjs';
// A real kijod with shell access ON (opt-in), a real Chrome, a real PTY: type into the terminal tile, read it back, copy it.
const d = await startDaemon({ port: 0, token: 'tok-e2e', collect: false, quiet: true, shell: true, ui: bundle() });
const browser = await chromium.launch({ executablePath: process.env.KIJO_CHROME, args: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage();
const errs = []; page.on('console', m => m.type() === 'error' && errs.push(m.text())); page.on('pageerror', e => errs.push(String(e)));
await page.goto(`http://127.0.0.1:${d.port}/?renderer=2d#token=tok-e2e`);
await page.waitForFunction(() => globalThis.__kijo?.frames > 5, null, { timeout: 15000 });
const q = fn => page.evaluate(fn), until = (fn, arg, ms = 8000) => page.waitForFunction(fn, arg, { timeout: ms });
await until(() => __kijo.st.view === 'focus' && document.title !== '');
// shell tile is selected by default (ws1, 2,2); daemon advertises shell
await until(() => __kijo.api.kijo_sel_x() === 2);
await page.waitForTimeout(800);
await page.keyboard.press('Enter');
await until(() => __kijo.st.capture === 1);
await until(() => __kijo.term().length === 1 && __kijo.term()[0].text.length > 0, null, 10000);
// size follows the tile
await page.waitForTimeout(700);
const dims = await q(() => __kijo.term()[0]); console.log('grid', dims.cols, dims.rows); assert.ok(dims.cols > 30 && dims.rows > 5);
await page.keyboard.type('echo hello_$((6*7)); stty size');
await page.keyboard.press('Enter');
await until(() => /hello_42/.test(__kijo.term()[0].text));
await until(d => new RegExp(`\\n${d.rows} ${d.cols}\\b`).test(__kijo.term()[0].text), dims, 5000);
console.log('resize ok: stty reports', dims.rows, dims.cols);
// colours + status (OSC 7501) + alt screen key encoding (arrow up repeats history)
await page.keyboard.type("printf '\\033[1;31mRED\\033[0m ok\\n\\033]7501;state=blocked;kind=permission\\007'"); await page.keyboard.press('Enter');
await until(() => __kijo.tiles(0).find(t => t.id === 1)?.status === 2, null, 5000);
console.log('OSC 7501 -> tile status blocked');
await page.keyboard.type("printf '\\033]7501;state=idle\\007'"); await page.keyboard.press('Enter');
await until(() => __kijo.tiles(0).find(t => t.id === 1)?.status === 0);
// Ctrl+C inside the shell is SIGINT, not a Kijo copy
await page.keyboard.type('sleep 30'); await page.keyboard.press('Enter'); await page.waitForTimeout(300);
await page.keyboard.press('Control+c'); await page.keyboard.type('echo after_int'); await page.keyboard.press('Enter');
await until(() => /after_int/.test(__kijo.term()[0].text));
// release, select all, copy as text
await page.keyboard.press('Control+]'); await until(() => __kijo.st.capture === null);
await page.keyboard.press('Control+a'); await until(() => /hello_42/.test(__kijo.selectedText()));
const sel = await q(() => __kijo.selectedText()); assert.match(sel, /hello_42/); assert.ok(!/TERMINAL|SHELL/.test(sel.split('\n')[0]) , 'header is chrome');
await page.keyboard.press('Control+c'); await page.waitForTimeout(200);
const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => '')); console.log('clipboard has hello_42:', /hello_42/.test(clip));
assert.match(clip, /hello_42/);
// click a terminal tile captures again, Esc clears selection... then move away releases
await page.keyboard.press('Escape');
await page.keyboard.press('Enter'); await until(() => __kijo.st.capture === 1);
await page.keyboard.press('Control+]');
// paste goes to the shell
await page.keyboard.press('Enter'); await until(() => __kijo.st.capture === 1);
await page.evaluate(() => navigator.clipboard.writeText('echo pasted_$((1+1))'));
await page.keyboard.press('Control+Shift+v'); await page.waitForTimeout(200); await page.keyboard.press('Enter');
await until(() => /pasted_2/.test(__kijo.term()[0].text), null, 5000);
assert.ok(![...await q(() => [...__kijo.store.series.keys()])].some(k => /pasted/.test(k)), 'pasted shell text is not injected as telemetry');
// mouse reporting: an app that asks for the mouse gets xterm SGR sequences; Shift would bypass
await page.keyboard.type("printf '\\033[?1000h\\033[?1006h'; cat -v"); await page.keyboard.press('Enter');
await until(() => __kijo.term()[0].text.includes('cat -v'), null, 3000); await page.waitForTimeout(300);
const g = await q(() => __kijo.termGeo()[1]); assert.ok(g && g.cw > 3, 'terminal geometry is exposed');
await page.mouse.click(g.x + 10 * g.cw + 2, g.y + 3 * g.lh + 2);
await until(() => /\^\[\[<0;11;4M/.test(__kijo.term()[0].text) && /\^\[\[<0;11;4m/.test(__kijo.term()[0].text), null, 4000);
await page.mouse.move(g.x + 5 * g.cw + 2, g.y + 2 * g.lh + 2); await page.mouse.wheel(0, -120);
await until(() => /\^\[\[<64;6;3M/.test(__kijo.term()[0].text), null, 4000);
await page.keyboard.press('Control+c'); await page.waitForTimeout(200);
await page.keyboard.type("printf '\\033[?1000l\\033[?1006l'"); await page.keyboard.press('Enter'); await page.waitForTimeout(300);
console.log('mouse reporting ok');
// a second shell tile from the palette; closing it closes its PTY
const ptyCount = async () => { const r = await fetch(`http://127.0.0.1:${d.port}/events`, { headers: { authorization: 'Bearer tok-e2e' } }); const rd = r.body.getReader(); const t = new TextDecoder().decode((await rd.read()).value); rd.cancel(); return JSON.parse(t.match(/^data: (.*)$/m)[1]).ptys.length; };
assert.equal(await ptyCount(), 1);
await page.keyboard.press('Control+]'); await until(() => __kijo.st.capture === null);
await page.keyboard.press('/'); await page.keyboard.type('new shell'); await page.keyboard.press('Enter');
await until(() => __kijo.st.terms.size === 2 && __kijo.st.capture !== null && __kijo.st.capture !== 1, null, 6000);
await until(() => __kijo.term().some(t => t.tile !== 1 && /\w@\S+[$#]/.test(t.text)), null, 6000); // wait for its prompt
await page.keyboard.type('echo second_$((3*3))'); await page.keyboard.press('Enter');
await until(() => __kijo.term().some(t => t.tile !== 1 && /second_9/.test(t.text)), null, 5000);
assert.equal(await ptyCount(), 2);
await page.keyboard.press('Control+]'); await page.keyboard.press('x');
await until(() => __kijo.st.terms.size === 1, null, 6000); await page.waitForTimeout(500);
assert.equal(await ptyCount(), 1, 'closing the tile closed its shell');
console.log('second shell opened and closed ok');
await q(() => { __kijo.api.kijo_select(2, 2); }); await page.keyboard.press('Enter'); await until(() => __kijo.st.capture === 1);
// exit -> status line, Enter restarts
await page.keyboard.type('exit 5'); await page.keyboard.press('Enter');
await until(() => __kijo.term()[0].exited === 5);
await page.keyboard.press('Enter'); await until(() => __kijo.term()[0].exited === null, null, 6000);
console.log('E2E terminal OK; console errors:', errs.filter(e => !/404/.test(e)));
await browser.close(); await d.close();
