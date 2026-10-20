// Browser-side injectors. Everything here runs in the page: no install, no relay needed.
//   - browser probe     real numbers about this page and renderer (fps, draw time, event-loop lag, ...)
//   - window.kijo       console / bookmarklet / devtools API:  kijo.inject('queue.depth 12')
//   - BroadcastChannel  other same-origin tabs:  new BroadcastChannel('kijo').postMessage({t:'metric',...})
//   - paste and drop    NDJSON, OTLP JSON, Prometheus text, `name value` lines, vmstat-style output you format
//   - pull URL          the page fetches a CORS-enabled endpoint every few seconds (Prometheus /metrics, JSON)
//   - websocket         the page connects straight to any ws(s):// endpoint that emits the same formats
// Every path ends in store.ingest(), so what you see is exactly what was injected.
import { parseText } from '../src/telemetry.mjs';

const MAX_PASTE = 2_000_000;

export function injectInto(store, input, src, onResult) {
  let msgs;
  if (typeof input === 'string') msgs = parseText(input);
  else msgs = Array.isArray(input) ? input : input ? [input] : [];
  const before = store.series.size; let n = 0;
  for (const m of msgs.slice(0, 5000)) if (store.ingest(m, { src })) n++;
  onResult?.({ accepted: n, rejected: msgs.length - n, newSeries: store.series.size - before, src });
  return n;
}

// Page + renderer telemetry. `probe` supplies counters owned by the render loop.
export function startBrowserInjector(store, probe) {
  const src = 'browser';
  const facts = { agent: navigator.userAgent.replace(/\s+/g, ' ').slice(0, 120), cores: navigator.hardwareConcurrency, memory_gb: navigator.deviceMemory, screen: `${screen.width}x${screen.height}@${devicePixelRatio}x`, lang: navigator.language, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, gpu: probe.gpu?.() };
  for (const [k, v] of Object.entries(facts)) if (v !== undefined && v !== '') store.fact('browser.' + k, v, src);
  // Event-loop lag: how late a 100 ms timer fires. Real jank, measured.
  let lagMax = 0, expected = performance.now() + 100;
  const lagTimer = setInterval(() => { const now = performance.now(); lagMax = Math.max(lagMax, now - expected); expected = now + 100; }, 100);
  const tick = () => {
    const p = probe.sample(); if (!p) return;
    store.push('browser.fps', p.fps, Date.now(), { src, unit: 'fps' });
    store.push('browser.draw_ms', p.drawMs, Date.now(), { src, unit: 'ms' });
    store.push('browser.cmds', p.cmds, Date.now(), { src });
    store.push('browser.loop_lag_ms', Math.round(lagMax * 10) / 10, Date.now(), { src, unit: 'ms' }); lagMax = 0;
    const mem = performance.memory?.usedJSHeapSize; if (mem) store.push('browser.heap_mb', Math.round(mem / 1048576), Date.now(), { src, unit: 'MB' });
  };
  const t = setInterval(tick, 1000);
  return () => { clearInterval(t); clearInterval(lagTimer); };
}

// window.kijo + BroadcastChannel + paste/drop. `notify(msg)` shows feedback to the user.
export function installInjectors(store, { notify, canPaste }) {
  const report = r => notify?.(r.accepted ? `injected ${r.accepted} from ${r.src}${r.newSeries ? `, ${r.newSeries} new series (press / to pin)` : ''}` : `nothing recognised in ${r.src} (formats: NDJSON, OTLP JSON, Prometheus, "name value")`);
  const api = { version: 1, store, inject: (input, src = 'console') => injectInto(store, input, src, report) };
  globalThis.kijo = Object.assign(globalThis.kijo || {}, api);
  let bc = null;
  try { bc = new BroadcastChannel('kijo'); bc.onmessage = e => injectInto(store, e.data, 'tab', report); } catch {}
  const onPaste = e => {
    if (!canPaste()) return;
    const text = e.clipboardData?.getData('text/plain') || ''; if (!text || text.length > MAX_PASTE) return;
    if (!parseText(text).length) return; // let ordinary pastes (e.g. into note editing) fall through untouched
    e.preventDefault(); injectInto(store, text, 'paste', report);
  };
  const onDrop = async e => {
    e.preventDefault(); const files = [...(e.dataTransfer?.files || [])];
    for (const f of files.slice(0, 5)) { if (f.size > MAX_PASTE) { notify?.(`${f.name}: too large (max 2 MB)`); continue; } injectInto(store, await f.text(), f.name.slice(0, 30), report); }
    const txt = e.dataTransfer?.getData('text/plain'); if (txt && !files.length) injectInto(store, txt, 'drop', report);
  };
  addEventListener('paste', onPaste); addEventListener('dragover', e => e.preventDefault()); addEventListener('drop', onDrop);
  return () => { removeEventListener('paste', onPaste); removeEventListener('drop', onDrop); bc?.close(); };
}

// ---- pull / websocket sources the page opens by itself (no relay)
export class Sources {
  constructor(store, notify) { this.store = store; this.notify = notify; this.items = new Map(); }
  list() { return [...this.items.values()].map(s => ({ kind: s.kind, url: s.url, state: s.state })); }
  pull(url, every = 5000) {
    const u = new URL(url); if (!/^https?:$/.test(u.protocol)) throw new Error('only http(s) URLs');
    if (this.items.has('pull:' + url)) return; const src = 'pull:' + u.host, item = { kind: 'pull', url, state: 'connecting', stop: false };
    const run = async () => {
      try {
        const res = await fetch(url, { cache: 'no-store' }); if (!res.ok) throw new Error('HTTP ' + res.status);
        const n = injectInto(this.store, (await res.text()).slice(0, MAX_PASTE), src); item.state = n ? 'ok' : 'no data recognised';
      } catch (e) {
        const msg = e instanceof TypeError ? 'blocked (network or CORS: the endpoint must allow this origin)' : e.message;
        if (item.state !== msg) this.store.log(`pull ${u.host}: ${msg}`, 'warn', Date.now(), { src: 'page' });
        item.state = msg;
      }
      if (!item.stop) item.timer = setTimeout(run, every);
    };
    item.close = () => { item.stop = true; clearTimeout(item.timer); }; this.items.set('pull:' + url, item); run();
  }
  websocket(url) {
    const u = new URL(url); if (!/^wss?:$/.test(u.protocol)) throw new Error('only ws(s) URLs');
    if (this.items.has('ws:' + url)) return; const src = 'ws:' + u.host, item = { kind: 'ws', url, state: 'connecting', stop: false };
    const open = () => {
      const ws = new WebSocket(url); item.ws = ws;
      ws.onopen = () => (item.state = 'ok'); ws.onmessage = e => typeof e.data === 'string' && injectInto(this.store, e.data, src);
      ws.onclose = () => { item.state = 'reconnecting'; if (!item.stop) item.timer = setTimeout(open, 3000); }; ws.onerror = () => (item.state = 'error');
    };
    item.close = () => { item.stop = true; clearTimeout(item.timer); item.ws?.close(); }; this.items.set('ws:' + url, item); open();
  }
  remove(key) { this.items.get(key)?.close(); this.items.delete(key); }
}
