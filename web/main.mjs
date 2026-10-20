// Kijo Chrome host. One <canvas>, no DOM UI: every pixel comes from the display list,
// which comes from the WASM scene. Same ABI, same state schema (localStorage here,
// ~/.local/state in the terminal host). Input is mapped to the same dispatcher ops.
import { instantiateCore, getTiles, serializeState, applyState, selectedTile, dispatch, handleKeyName, label, tag, placeTile, APP, DEFAULT_NOTES, DEFAULT_BINDINGS, VIEWS, SIDE } from '../src/core.mjs';
import { Store, baseName } from '../src/telemetry.mjs';
import { startBrowserInjector, installInjectors, Sources, injectInto } from './injectors.mjs';
import { connectDaemon } from './daemon.mjs';
import { VT, encodeKey } from '../src/vt.mjs';
import { WINDOWS, windowLabel } from './telemetry-draw.mjs';
import { buildDisplayList, THEMES, Anim, WALLPAPERS } from './displaylist.mjs';
import { createGpuRenderer } from './gpu.mjs';
import { createCanvasRenderer } from './canvas2d.mjs';

const STORE = 'kijo.state.v3';
const params = new URLSearchParams(location.search);
const embedded = globalThis.KIJO_EMBED || {};
const source = async path => embedded[path] ?? (await fetch(new URL('../' + path, import.meta.url))).text();

async function boot() {
  const canvas = document.getElementById('kijo');
  const b64 = (await source('core/scene.wasm.b64')).trim();
  const api = await instantiateCore(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));

  let renderer = null;
  if (params.get('renderer') !== '2d') {
    try { renderer = await createGpuRenderer(canvas, { sceneWGSL: await source('shaders/scene.wgsl'), heatWGSL: await source('shaders/heatmap.wgsl'), surfaceWGSL: await source('shaders/surface.wgsl') }); }
    catch (err) { console.warn('WebGPU unavailable, falling back to Canvas2D:', err); }
  }
  if (!renderer) renderer = createCanvasRenderer(canvas);

  let restored = false;
  const st = { view: 'focus', ghosts: false, notes: { ...DEFAULT_NOTES }, bindings: { ...DEFAULT_BINDINGS }, window: 300000, cam: { manual: false, yaw: 0.6, pitch: 0.5, dist: 2.7 }, events: [], editing: null, palette: null, message: '' };
  // Everything shown by telemetry tiles comes from this store; injectors are the only writers.
  const store = new Store();
  store.onStatus = m => m.id > 0 && api.kijo_report(m.id, m.state, m.kind, m.progress) === 1;
  const log = e => { st.events.push(`${new Date().toLocaleTimeString('en-GB', { hour12: false })}  ${e}`); if (st.events.length > 200) st.events.shift(); };
  const say = m => { st.message = m; clearTimeout(say.t); say.t = setTimeout(() => (st.message = ''), 3500); };
  if (!params.has('fresh')) {
    try {
      const raw = localStorage.getItem(STORE);
      if (raw) { const j = JSON.parse(raw); st.notes = applyState(api, j); st.bindings = j.bindings ?? { ...DEFAULT_BINDINGS }; if (WINDOWS.includes(j.window)) st.window = j.window; restored = true; log('Restored saved workspace'); }
    }
    catch (err) { console.warn('Ignoring saved state:', err.message); }
  }
  if (VIEWS.includes(params.get('view'))) st.view = params.get('view');
  let syncTimer = 0, daemon = null;
  const snapshotState = () => serializeState(api, st.notes, { bindings: st.bindings, window: st.window });
  const save = () => {
    try { localStorage.setItem(STORE, JSON.stringify(snapshotState())); } catch {}
    if (daemon) { clearTimeout(syncTimer); syncTimer = setTimeout(() => daemon?.saveSession(snapshotState()), 800); } // layout follows you to the next device
  };

  const media = matchMedia('(prefers-color-scheme: light)');
  const pref = k => { try { return localStorage.getItem(k); } catch { return null; } }, setPref = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  let themeName = params.get('theme') || pref('kijo.theme') || '', wallIx = Number(params.get('wall') ?? pref('kijo.wall') ?? 0) || 0;
  const applyWall = () => { wallIx = ((wallIx % WALLPAPERS.length) + WALLPAPERS.length) % WALLPAPERS.length; THEMES.glass.wall = { hue: WALLPAPERS[wallIx].hue, seed: WALLPAPERS[wallIx].seed }; setPref('kijo.wall', wallIx); };
  applyWall();
  const theme = () => THEMES[themeName] || THEMES[media.matches ? 'light' : 'dark'];
  // Real values only. Anything the browser cannot know is left undefined and the bar omits it.
  const metrics = { cores: navigator.hardwareConcurrency, memory: navigator.deviceMemory ? navigator.deviceMemory + 'GB' : undefined, fps: 0,
    gpu: renderer.name + (renderer.gpu !== 'none' ? ' ' + renderer.gpu : ''), net: navigator.onLine ? 'online' : 'offline' };
  addEventListener('online', () => (metrics.net = 'online')); addEventListener('offline', () => (metrics.net = 'offline'));
  navigator.getBattery?.().then(b => {
    const upd = () => { metrics.battery = Math.round(b.level * 100); metrics.charging = b.charging; };
    upd(); b.addEventListener('levelchange', upd); b.addEventListener('chargingchange', upd);
  }).catch(() => {});

  // ---- injectors: the browser alone is a complete runtime. A relay (kijod) only adds remote data.
  let drawAcc = 0, drawN = 0, lastCmds = 0;
  const probe = { gpu: () => metrics.gpu, sample: () => { const o = { fps: metrics.fps, drawMs: drawN ? Math.round(drawAcc / drawN * 100) / 100 : 0, cmds: lastCmds }; drawAcc = 0; drawN = 0; return o; } };
  startBrowserInjector(store, probe);
  installInjectors(store, { notify: say, canPaste: () => !st.editing && !st.palette && !st.capture });
  const sources = new Sources(store, say);
  addEventListener('paste', e => { if (!st.palette) return; const t = (e.clipboardData?.getData('text/plain') || '').split('\n')[0].slice(0, 300); if (t) { st.palette.q += t; refresh(); e.preventDefault(); } });
  const dstate = { state: 'off' };
  function connect(url, token) {
    daemon?.close(); url = url.replace(/\/$/, '');
    try { sessionStorage.setItem('kijo.daemon', JSON.stringify({ url, token })); } catch {}
    let first = true;
    daemon = connectDaemon({ url, token, store, onState: s => { dstate.state = s; if (s === 'connected' && first) { first = false; log('kijod connected ' + url); if (!restored) daemon.loadSession().then(j => { if (j && j.version === 2) { try { st.notes = applyState(api, j); st.bindings = j.bindings ?? st.bindings; say('layout loaded from kijod'); } catch {} } }); } if (s === 'unauthorized') say('kijod: wrong token'); }, onInfo: i => { dstate.host = i.host; dstate.shell = i.shell; }, onPty: onPty });
  }
  function disconnect() { daemon?.close(); daemon = null; dstate.state = 'off'; dstate.shell = false; try { sessionStorage.removeItem('kijo.daemon'); } catch {} }
  // Same-origin relay: kijod prints  http://host:port/#token=...  - read it once, then drop it from the address bar.
  {
    let creds = null; const m = location.hash.match(/token=([^&]+)/);
    if (m && /^https?:$/.test(location.protocol)) { creds = { url: params.get('daemon') || location.origin, token: decodeURIComponent(m[1]) }; history.replaceState(null, '', location.pathname + location.search); }
    else if (m && params.get('daemon')) { creds = { url: params.get('daemon'), token: decodeURIComponent(m[1]) }; history.replaceState(null, '', location.pathname + location.search); }
    else { try { creds = JSON.parse(sessionStorage.getItem('kijo.daemon') || 'null'); } catch {} }
    if (creds) connect(creds.url, creds.token);
  }

  // ---- palette: one search box over commands, views, workspaces and every note/tile
  const goTo = (ws, x, y) => {
    if (ws === 9) { if (!api.kijo_special_open()) dispatch(api, 'TOGGLESPECIAL'); } else dispatch(api, 'WORKSPACE', ws);
    api.kijo_select(x, y); st.view = 'focus';
  };
  function paletteItems(q) {
    const items = [];
    [...VIEWS, 'flow'].forEach((v, i) => items.push({ title: `View: ${v}`, hint: String(i + 1), run: () => (st.view = v) }));
    // Telemetry: pin what was injected. Names come from the live store, nothing is hard-coded.
    const pin = (app, name) => { const id = placeTile(api, app); if (!id) return say('No free slot in this workspace'); if (name) st.bindings[id] = name; st.view = 'focus'; log(`Pinned ${name || tag({ app })} as #${id}`); };
    const groups = [...new Set([...store.series.keys()].map(baseName))].sort();
    for (const g of groups) items.push({ title: `Pin chart: ${g}`, hint: 'chart', run: () => pin(APP.SERIES, g) });
    items.push({ title: 'Pin logs', hint: 'tile', run: () => pin(APP.LOGS) }, { title: 'Pin traces', hint: 'tile', run: () => pin(APP.TRACES) }, { title: 'Pin system', hint: 'tile', run: () => pin(APP.SYS) }, { title: 'Pin 3D surface', hint: 'tile', run: () => pin(APP.SCENE3D) });
    for (const ms of WINDOWS) items.push({ title: `Time window: ${windowLabel(ms)}`, hint: '[ ]', run: () => (st.window = ms) });
    const q0 = q.trim(), mm = q0.match(/^(pull|ws|kijod)\s+(\S+)(?:\s+(\S+))?/i);
    if (mm) {
      const [, cmd, arg, tok] = mm, safe = f => () => { try { f(); } catch (e) { say(e.message); } };
      if (/^pull$/i.test(cmd)) items.unshift({ title: `Pull ${arg} every 5s`, hint: 'source', run: safe(() => (sources.pull(arg), say('pulling ' + arg))) });
      else if (/^ws$/i.test(cmd)) items.unshift({ title: `Connect websocket ${arg}`, hint: 'source', run: safe(() => (sources.websocket(arg), say('connecting ' + arg))) });
      else items.unshift({ title: tok ? `Connect kijod ${arg}` : `kijod ${arg} <token> - paste the token after the URL`, hint: 'relay', run: safe(() => { if (!tok) throw new Error('token missing'); connect(arg, tok); }) });
    }
    if (daemon) items.push({ title: 'Disconnect kijod', hint: 'relay', run: disconnect });
    for (const it of sources.list()) items.push({ title: `Source ${it.kind}: ${it.url}`, hint: it.state, run: () => { sources.remove(it.kind === 'pull' ? 'pull:' + it.url : 'ws:' + it.url); say('source removed'); } });
    for (let w = 0; w < 9; w++) items.push({ title: `Go to workspace ${w + 1}`, hint: 'alt+' + (w + 1), run: () => dispatch(api, 'WORKSPACE', w) });
    for (let w = 0; w < 9; w++) items.push({ title: `Move selected tile to workspace ${w + 1}`, hint: 'alt+shift+' + (w + 1), run: () => { if (dispatch(api, 'MOVETOWORKSPACE', w)) log(`Moved tile to workspace ${w + 1}`); else say('Nothing to move, or the workspace is full'); } });
    for (const n of ['glass', 'dark', 'light']) items.push({ title: `Theme: ${n}`, hint: n === 'glass' ? 'W wallpaper' : '', run: () => { themeName = n; setPref('kijo.theme', n); } });
    WALLPAPERS.forEach((w, i) => items.push({ title: `Wallpaper: ${w.name}`, hint: 'glass', run: () => { themeName = 'glass'; setPref('kijo.theme', 'glass'); wallIx = i; applyWall(); } }));
    if (dstate.shell) items.push({ title: 'Terminal: open shell', hint: 'kijod', run: () => { const e = shellTiles().find(x => !st.terms.has(x.t.id) || st.terms.get(x.t.id).exited !== null) || shellTiles()[0]; if (!e) return say('no shell tile (Reset demo workspace restores one)'); goTo(e.w, e.i % SIDE, Math.floor(e.i / SIDE)); enterTerm(e.t); } });
    items.push({ title: 'New note here', hint: 'N', run: () => handleKeyName(api, st, 'n') });
    items.push({ title: 'Reserve a 2x2 footprint here', hint: 'F', run: () => handleKeyName(api, st, 'f') });
    items.push({ title: 'Close selected tile', hint: 'X', run: () => handleKeyName(api, st, 'x') });
    items.push({ title: 'Toggle scratchpad workspace', hint: 'S', run: () => dispatch(api, 'TOGGLESPECIAL') });
    items.push({ title: 'Show / hide ghost outlines', hint: 'G', run: () => (st.ghosts = !st.ghosts) });
    items.push({ title: 'Reset demo workspace', hint: 'R', run: () => handleKeyName(api, st, 'r') });
    for (let w = 0; w < 10; w++) getTiles(api, w).forEach((t, i) => {
      if (t.kind !== 1) return;
      const text = t.app === APP.NOTE ? (st.notes[t.id] ?? `Note ${t.id}`).replace(/\s+/g, ' ') : label(t, st.notes, st.bindings);
      items.push({ title: text, hint: `${tag(t).toLowerCase()} - ws ${w === 9 ? 's' : w + 1} ${i % SIDE},${Math.floor(i / SIDE)}`, run: () => goTo(w, i % SIDE, Math.floor(i / SIDE)), tile: true });
    });
    const needle = mm ? '' : q.trim().toLowerCase();
    if (mm) return items.slice(0, 1);
    if (!needle) return [...items.filter(i => i.tile), ...items].slice(0, 9);
    const score = it => { const t = (it.title + ' ' + (it.hint || '')).toLowerCase(), k = t.indexOf(needle); return k < 0 ? -1 : (k === 0 ? 2 : 1) + (it.tile ? 0.5 : 0); };
    return items.map(it => [score(it), it]).filter(([s]) => s >= 0).sort((a, b) => b[0] - a[0]).map(([, it]) => it).slice(0, 9);
  }
  const openPalette = () => { st.palette = { q: '', sel: 0, items: paletteItems('') }; };
  const refresh = () => { st.palette.items = paletteItems(st.palette.q); st.palette.sel = Math.min(st.palette.sel, Math.max(0, st.palette.items.length - 1)); };
  const runPalette = i => { const it = st.palette.items[i ?? st.palette.sel]; st.palette = null; if (it) { it.run(); save(); } };

  const clampI = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---- terminal tiles: a shell tile owns a VT grid fed by a kijod PTY (kijod must run with --allow-shell)
  const termById = new Map(), orphans = new Map(); let opening = 0;
  st.terms = new Map(); st.capture = null;
  const unb64 = d => Uint8Array.from(atob(d), ch => ch.charCodeAt(0));
  function makeTerm(tileId, id, cols, rows) {
    const tm = { tile: tileId, id, view: 0, exited: null, want: null, wantAt: 0, vt: null, title: '' };
    tm.vt = new VT({ cols, rows, onReply: reply => daemon?.ptyIn(id, reply), onTitle: t => (tm.title = t), onStatus: m => { api.kijo_report(tileId, m.state, m.kind, m.progress); } }); // OSC 7501 drives the tile status
    st.terms.set(tileId, tm); termById.set(id, tm);
    for (const m of orphans.get(id) || []) feedTerm(tm, m); orphans.delete(id);
    return tm;
  }
  function feedTerm(tm, m) {
    if (m.d) tm.vt.write(unb64(m.d));
    if ('exit' in m) { tm.exited = m.exit; tm.vt.write(`\r\n[shell exited with status ${m.exit} - press Enter to start a new one]\r\n`); }
  }
  const shellTiles = () => { const out = []; for (let w = 0; w < 10; w++) getTiles(api, w).forEach((t, i) => { if (t.kind === 1 && t.app === APP.SHELL) out.push({ w, i, t }); }); return out; };
  function onPty(m) {
    if (m.snapshot) { // (re)connect: shells that outlived the page come back with their recent output
      for (const p of m.snapshot) {
        let tm = termById.get(p.id);
        if (!tm) { const free = shellTiles().find(e => !st.terms.has(e.t.id)); if (!free) continue; tm = makeTerm(free.t.id, p.id, p.cols, p.rows); }
        else { tm.vt.reset(); tm.vt.resize(p.cols, p.rows); }
        if (p.d) tm.vt.write(unb64(p.d));
      }
      return;
    }
    const tm = termById.get(m.id);
    if (tm) feedTerm(tm, m); else if (opening) { const l = orphans.get(m.id) || []; l.push(m); orphans.set(m.id, l); } // output raced ahead of the open() reply
  }
  async function enterTerm(t) {
    const tm = st.terms.get(t.id);
    if (tm && tm.exited === null) { st.capture = t.id; say('keys go to the shell; Ctrl+] gives them back'); return; }
    if (!daemon || dstate.state !== 'connected') return say('no kijod attached: run  node src/kijod.mjs --allow-shell  and connect it (palette: kijod <url> <token>)');
    if (!dstate.shell) return say('shell access is off on this kijod: restart it with --allow-shell');
    opening++;
    try {
      const r = await daemon.ptyOpen(80, 24);
      if (tm) { termById.delete(tm.id); st.terms.delete(t.id); }
      makeTerm(t.id, r.id, 80, 24); st.capture = t.id; say('shell open; Ctrl+] gives the keys back');
    } catch (e) { say('cannot open shell: ' + e.message); }
    finally { opening--; }
  }
  const sendTerm = (tm, text) => { if (tm.exited === null) daemon?.ptyIn(tm.id, text); };
  function captureKey(ev) {
    const tm = st.terms.get(st.capture); if (!tm) { st.capture = null; return undefined; }
    if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.key === ']') { st.capture = null; say('keys back to Kijo'); return true; }
    const low = ev.key.length === 1 ? ev.key.toLowerCase() : '', cmd = ev.metaKey || (ev.ctrlKey && ev.shiftKey);
    if (cmd && low === 'c') { if (st.sel && lastText) copySelection(); return true; }
    if (cmd && low === 'v') return false; // the browser fires 'paste' for us
    if (ev.metaKey) return false;
    if (ev.shiftKey && (ev.key === 'PageUp' || ev.key === 'PageDown')) { tm.view = clampI(tm.view + (ev.key === 'PageUp' ? 1 : -1) * Math.max(1, tm.vt.rows - 1), 0, tm.vt.back.length); return true; }
    if (tm.exited !== null) { if (ev.key === 'Enter') { const t = getTiles(api).find(x => x.id === st.capture); if (t) enterTerm(t); return true; } return false; }
    const bytes = encodeKey(ev, tm.vt); if (!bytes) return false;
    tm.view = 0; sendTerm(tm, bytes); return true;
  }
  addEventListener('paste', e => {
    if (!st.capture || st.palette) return; const tm = st.terms.get(st.capture); if (!tm || tm.exited !== null) return;
    const text = (e.clipboardData?.getData('text/plain') || '').replace(/\x1b/g, '').replace(/\r?\n/g, '\r'); if (!text) return;
    sendTerm(tm, tm.vt.bracketed ? `\x1b[200~${text}\x1b[201~` : text); tm.view = 0; e.preventDefault();
  });
  // keep the PTY the size of its tile (debounced: tiles glide when layout changes)
  function syncTerms(sizes, now) {
    for (const [tileId, tm] of st.terms) {
      const w = sizes[tileId]; if (!w || tm.exited !== null) continue;
      if (w.cols === tm.vt.cols && w.rows === tm.vt.rows) { tm.want = null; continue; }
      if (!tm.want || tm.want.cols !== w.cols || tm.want.rows !== w.rows) { tm.want = w; tm.wantAt = now; continue; }
      if (now - tm.wantAt > 150) { tm.vt.resize(w.cols, w.rows); daemon?.ptyResize(tm.id, w.cols, w.rows); tm.want = null; }
    }
  }
  function act(ev) {
    const key = (ev.shiftKey && ev.key.startsWith('Arrow') ? 'Shift+' : '') + ev.key;
    if (st.capture) { const r = captureKey(ev); if (r !== undefined) return r; }
    if (st.palette) {
      if (ev.key === 'Escape') st.palette = null;
      else if (ev.key === 'Enter') runPalette();
      else if (ev.key === 'ArrowDown') st.palette.sel = Math.min(st.palette.items.length - 1, st.palette.sel + 1);
      else if (ev.key === 'ArrowUp') st.palette.sel = Math.max(0, st.palette.sel - 1);
      else if (ev.key === 'Backspace') { st.palette.q = st.palette.q.slice(0, -1); refresh(); }
      else if (ev.key.length === 1) { st.palette.q += ev.key; refresh(); }
      return true;
    }
    if (st.editing) {
      const e = st.editing;
      if (ev.key === 'Escape') { st.notes[e.id] = e.text.trim() || `Note ${e.id}`; log(`Edited note #${e.id}`); st.editing = null; save(); }
      else if (ev.key === 'Enter') e.text += '\n';
      else if (ev.key === 'Backspace') e.text = e.text.slice(0, -1);
      else if (ev.key.length === 1 && /[\x20-\x7e]/.test(ev.key) && e.text.length < 600) e.text += ev.key;
      return true;
    }
    if (ev.key === '/' || ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k')) { openPalette(); return true; }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'c' && st.sel && lastText) { copySelection(); return true; }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'a' && st.view === 'focus') { const t = selectedTile(api); if (t.kind === 1 && t.app !== APP.SCENE3D) { st.sel = { surf: t.id, all: true, key: selKey() }; return true; } }
    if (ev.key === 'Escape' && st.sel) { st.sel = null; return true; }
    if (ev.ctrlKey || ev.metaKey) return false;
    // Hyprland-style: Alt+1..9 workspace, Alt+Shift+1..9 move the selected tile there.
    if (ev.altKey && /^Digit[1-9]$/.test(ev.code || '')) {
      const w = Number(ev.code.slice(5)) - 1;
      if (ev.shiftKey) { if (dispatch(api, 'MOVETOWORKSPACE', w)) log(`Moved tile to workspace ${w + 1}`); else say('Nothing to move, or the workspace is full'); }
      else dispatch(api, 'WORKSPACE', w);
      save(); return true;
    }
    if (ev.altKey) return false;
    if (ev.key === 'e') {
      const t = selectedTile(api);
      if (t.kind === 1 && t.app === APP.NOTE) { st.view = 'focus'; const cur = st.notes[t.id] ?? ''; st.editing = { id: t.id, text: cur === `Note ${t.id}` ? '' : cur }; } // auto-named notes start blank else say('[E] writes in a note tile');
      return true;
    }
    if (ev.key === 'w' && themeName === 'glass') { wallIx++; applyWall(); say('wallpaper: ' + WALLPAPERS[wallIx].name); return true; }
    if (ev.key === '[' || ev.key === ']') { const i = WINDOWS.indexOf(st.window); st.window = WINDOWS[clampI(i + (ev.key === ']' ? 1 : -1), 0, WINDOWS.length - 1)]; say('window ' + windowLabel(st.window)); save(); return true; }
    if (st.view === 'flow' && ev.key === 'Escape') { st.view = 'focus'; return true; }
    if (ev.key === 'Enter' && st.view === 'focus') { const t = selectedTile(api); if (t.kind === 1 && t.app === APP.SHELL) { enterTerm(t); return true; } }
    if (ev.key === 'p' || ev.key === 'o') { say('select the shell tile and press Enter (needs kijod --allow-shell; terminal host: node src/host.mjs)'); return true; }
    const used = handleKeyName(api, st, key);
    if (used) save();
    return used;
  }
  addEventListener('keydown', ev => { if (act(ev)) ev.preventDefault(); });

  // Copy: the text comes from the semantic text model (web/textsel.mjs), never from pixels.
  function copySelection() {
    const text = lastText; if (!text) return;
    try { navigator.clipboard?.writeText(text).catch(() => {}); } catch {}
    try { document.execCommand('copy'); } catch {}
    say(`copied ${text.length} characters`);
  }
  addEventListener('copy', e => { if (st.sel && lastText) { e.clipboardData.setData('text/plain', lastText); e.preventDefault(); } });
  let hits = [];
  const hitAt = ev => { for (let i = hits.length - 1; i >= 0; i--) { const h = hits[i]; if (ev.clientX >= h.x && ev.clientX < h.x + h.w && ev.clientY >= h.y && ev.clientY < h.y + h.h) return h; } return null; };
  function activate(h, double) {
    if (!h) { if (st.palette) st.palette = null; return; }
    if (h.kind === 'palette') runPalette(h.index);
    else if (st.palette) st.palette = null;
    else if (h.kind === 'ws') { dispatch(api, 'WORKSPACE', h.ws); save(); }
    else if (h.kind === 'special') { dispatch(api, 'TOGGLESPECIAL'); save(); }
    else if (h.kind === 'ws-card') { dispatch(api, 'WORKSPACE', h.ws); st.view = double ? 'focus' : 'overview'; save(); }
    else if (h.kind === 'series') {
      const id = placeTile(api, APP.SERIES);
      if (!id) say('No free slot in this workspace'); else { st.bindings[id] = h.name; say(`pinned ${h.name} on workspace ${api.kijo_special_open() ? 's' : api.kijo_ws() + 1}`); log(`Pinned ${h.name} as #${id}`); save(); }
    }
    else if (h.kind === 'tile-id') {
      for (let w = 0; w < 10; w++) { const i = getTiles(api, w).findIndex(t => t.id === h.id && t.kind === 1); if (i >= 0) { goTo(w, i % SIDE, Math.floor(i / SIDE)); save(); break; } }
    }
    else if (h.kind === 'tile' && !st.editing) {
      api.kijo_select(h.meta % SIDE, Math.floor(h.meta / SIDE));
      if (double) {
        const t = selectedTile(api);
        if (st.view !== 'focus') st.view = 'focus';
        else if (t.kind !== 1) handleKeyName(api, st, 'n');
        else if (t.app === APP.NOTE) act({ key: 'e' });
        else handleKeyName(api, st, 't');
      }
      save();
    }
  }
  // 3D surface tiles: drag to orbit (yaw/pitch live in st.cam, the display list just reads them).
  let drag = null, selDrag = null, lastText = '';
  const selKey = () => st.view + ':' + (api.kijo_special_open() ? 's' : api.kijo_ws());
  canvas.addEventListener('pointerdown', ev => {
    const h = hitAt(ev); activate(h, false); st.sel = null;
    const tt = h?.kind === 'tile' && st.view === 'focus' && !st.palette && !st.editing ? getTiles(api)[h.meta] : null;
    if (tt && tt.app !== APP.SCENE3D) selDrag = { surf: tt.id, ax: ev.clientX, ay: ev.clientY, key: selKey() };
    if (h?.kind === 'tile' && getTiles(api)[h.meta]?.app === APP.SCENE3D) { drag = { x: ev.clientX, y: ev.clientY, yaw: st.cam.manual ? st.cam.yaw : st.cam.yaw + (performance.now() - t0) / 1000 * 0.15, pitch: st.cam.pitch }; canvas.setPointerCapture?.(ev.pointerId); }
  });
  canvas.addEventListener('pointermove', ev => {
    if (selDrag && (Math.hypot(ev.clientX - selDrag.ax, ev.clientY - selDrag.ay) > 4 || st.sel)) st.sel = { surf: selDrag.surf, ax: selDrag.ax, ay: selDrag.ay, bx: ev.clientX, by: ev.clientY, key: selDrag.key };
    if (!drag) return; st.cam.manual = true; st.cam.yaw = drag.yaw - (ev.clientX - drag.x) * 0.008; st.cam.pitch = Math.max(0.08, Math.min(1.45, drag.pitch + (ev.clientY - drag.y) * 0.006)); });
  const endDrag = () => {
    const sd = selDrag; drag = null; selDrag = null; if (st.sel && !lastText) st.sel = null;
    if (sd && !st.sel && st.view === 'focus' && st.terms.has(sd.surf) && getTiles(api).some(t => t.id === sd.surf && t.app === APP.SHELL)) { const tm = st.terms.get(sd.surf); if (tm.exited === null) st.capture = sd.surf; } // a click (not a drag) on a live terminal captures keys
  };
  canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('dblclick', ev => { const h = hitAt(ev); { const ht = h?.kind === 'tile' ? getTiles(api)[h.meta] : null; if (ht?.app === APP.SHELL && st.view === 'focus') { enterTerm(ht); return; } } if (h?.kind === 'tile' && getTiles(api)[h.meta]?.app === APP.SCENE3D) { st.cam.manual = false; return; } activate(h, true); });
  let wheel = 0;
  canvas.addEventListener('wheel', ev => {
    ev.preventDefault(); if (st.palette) return;
    { const h = hitAt(ev), ht = h?.kind === 'tile' && st.view === 'focus' ? getTiles(api)[h.meta] : null, tm = ht && st.terms.get(ht.id); // wheel over a terminal scrolls its history
      if (tm) { tm.view = clampI(tm.view + (ev.deltaY < 0 ? 3 : -3), 0, tm.vt.g === tm.vt.main ? tm.vt.back.length : 0); wheel = 0; return; } }
    wheel += ev.deltaY;
    if (wheel > 120) { st.view = st.view === 'focus' ? 'overview' : st.view === 'overview' ? 'workspaces' : st.view; wheel = 0; }
    else if (wheel < -120) { st.view = st.view === 'workspaces' ? 'overview' : st.view === 'overview' ? 'focus' : st.view; wheel = 0; }
  }, { passive: false });

  let size = { w: 0, h: 0, dpr: 1 };
  function resize() {
    const dpr = Math.min(3, devicePixelRatio || 1), w = innerWidth, h = innerHeight;
    if (w === size.w && h === size.h && dpr === size.dpr) return;
    size = { w, h, dpr };
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    renderer.setDpr(dpr);
  }
  addEventListener('resize', resize);

  const anim = new Anim(), t0 = performance.now(); let frames = 0, fpsAt = t0, last = t0;
  function frame(now) {
    resize();
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    frames++; if (now - fpsAt > 1000) { metrics.fps = Math.round(frames * 1000 / (now - fpsAt)); frames = 0; fpsAt = now; }
    const d = new Date();
    const env = { width: size.w, height: size.h, dpr: size.dpr, time: (now - t0) / 1000, dt, theme: theme(), anim,
      backend: renderer.name.toUpperCase(), clock: d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      date: d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }), metrics,
      measure: (s, z, f, w) => renderer.measure(s, z, f, w) };
    const wall = Date.now(), c0 = store.last('cpu.util_pct'), r0 = store.last('mem.used_pct');
    metrics.cpu = c0 && wall - c0.ts < 15000 ? Math.round(c0.v) : undefined; metrics.ram = r0 && wall - r0.ts < 15000 ? Math.round(r0.v) : undefined;
    env.store = store; env.now = wall; env.daemon = dstate.state === 'off' ? null : dstate;
    const p0 = performance.now();
    const list = buildDisplayList(api, st, env);
    hits = list.hits; lastText = list.selectionText || '';
    syncTerms(list.termSizes || {}, now);
    if (st.capture && (st.view !== 'focus' || selectedTile(api).id !== st.capture)) st.capture = null; // leaving the tile releases the keys
    if (st.sel && st.sel.key !== selKey()) { st.sel = null; lastText = ''; }
    renderer.draw(list, env);
    drawAcc += performance.now() - p0; drawN++; lastCmds = list.cmds.length;
    globalThis.__kijo = { api, st, store, anim, act, sources, connect, tiles: w => getTiles(api, w), selectedText: () => lastText, renderer: renderer.name, rendererObj: renderer, term: () => [...st.terms.values()].map(t => ({ tile: t.tile, id: t.id, text: t.vt.text(), cols: t.vt.cols, rows: t.vt.rows, exited: t.exited, title: t.title })), frames: (globalThis.__kijo?.frames || 0) + 1 };
    requestAnimationFrame(frame);
  }
  log(`Kijo started / ${renderer.name}${renderer.gpu !== 'none' ? ' / ' + renderer.gpu : ''}`);
  requestAnimationFrame(frame);
}
boot().catch(err => {
  console.error(err);
  globalThis.__kijo = { error: String(err) };
  document.title = 'Kijo / failed: ' + err.message;
});
