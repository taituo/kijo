import assert from 'node:assert/strict';
import http from 'node:http';
import { startDaemon } from '../src/kijod.mjs';

const d = await startDaemon({ port: 0, token: 'secret-token', collect: true, ui: '<!doctype html><title>kijo</title>', quiet: true });
const base = `http://127.0.0.1:${d.port}`, H = { authorization: 'Bearer secret-token' };
const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', body, headers: { ...H, ...headers } });

// ---- auth: static page open, everything else needs the bearer token
const page = await fetch(base + '/'); assert.equal(page.status, 200);
assert.match(page.headers.get('content-security-policy'), /wasm-unsafe-eval/, 'the WASM core must be allowed to compile under the page CSP');
assert.equal((await fetch(base + '/healthz')).status, 200);
assert.equal((await fetch(base + '/events')).status, 401);
assert.equal((await post('/ingest', 'a 1', { authorization: 'Bearer wrong' })).status, 401);
assert.equal((await fetch(base + '/ingest', { method: 'POST', body: 'a 1' })).status, 401);
const rawGet = (hostHeader) => new Promise((ok, fail) => http.get({ host: '127.0.0.1', port: d.port, path: '/', headers: { host: hostHeader } }, r => { r.resume(); ok(r.statusCode); }).on('error', fail));
assert.equal(await rawGet('evil.example'), 421, 'DNS rebinding host is refused');
assert.equal(await rawGet('localhost:' + d.port), 200, 'localhost is fine');

// ---- injectors: text, JSON, Prometheus, NDJSON, OTLP
let r = await post('/ingest', 'queue.depth 12\nqueue.age=3.5', { 'x-kijo-source': 'shell-loop' });
assert.deepEqual(await r.json(), { accepted: 2, rejected: 0 });
r = await post('/ingest', '{"t":"log","level":"warn","body":"disk almost full"}\n{"t":"metric","name":"jobs","value":3}');
assert.equal((await r.json()).accepted, 2);
r = await post('/ingest', '# TYPE http_total counter\nhttp_total{code="200"} 5\nhttp_total{code="500"} 1');
assert.equal((await r.json()).accepted, 2);
r = await post('/v1/metrics', JSON.stringify({ resourceMetrics: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'api' } }] }, scopeMetrics: [{ metrics: [{ name: 'rps', gauge: { dataPoints: [{ asDouble: 42.5 }] } }] }] }] }));
assert.equal(r.status, 200);
assert.equal((await post('/v1/metrics', '{}', { 'content-type': 'application/x-protobuf' })).status, 415, 'protobuf is refused honestly');
assert.equal((await post('/v1/nonsense', '{}')).status, 404);
assert.equal((await post('/ingest', 'x'.repeat(1_100_000))).status, 413, 'body size is capped');

assert.ok(d.store.series.has('queue.depth')); assert.ok(d.store.series.has('http_total{code="500"}')); assert.ok(d.store.series.has('rps{service="api"}'));
assert.equal(d.store.sources.get('shell-loop').count >= 2, true, 'injector attributed by header');
assert.ok(d.store.sources.has('otlp:api'));
assert.ok(d.store.logs.some(l => l.body === 'disk almost full' && l.level === 'warn'));

// ---- own request tracing produces real parent/child spans
const roots = d.store.spans.filter(s => s.name === 'POST /ingest' && !s.parent);
assert.ok(roots.length >= 3);
const kids = d.store.spans.filter(s => s.parent === roots[0].id); assert.deepEqual(kids.map(k => k.name), ['read body', 'parse', 'apply']);
assert.ok(kids.every(k => k.dur >= 0 && k.start >= roots[0].start - 1));

// ---- SSE: snapshot for late joiners, then live batches
const ac = new AbortController();
const res = await fetch(base + '/events', { headers: H, signal: ac.signal });
assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /event-stream/);
const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '';
const frame = async () => { for (;;) { const i = buf.indexOf('\n\n'); if (i >= 0) { const f = buf.slice(0, i); buf = buf.slice(i + 2); if (f.startsWith(':')) continue; return { ev: f.match(/^event: (.*)$/m)?.[1], data: JSON.parse(f.match(/^data: (.*)$/m)[1]) }; } const { value, done } = await reader.read(); if (done) throw new Error('closed'); buf += dec.decode(value, { stream: true }); } };
const snap = await frame();
assert.equal(snap.ev, 'snapshot'); assert.ok(Math.abs(snap.data.now - Date.now()) < 5000);
assert.ok(snap.data.series.some(s => s.name === 'queue.depth')); assert.ok(snap.data.logs.length > 0); assert.ok(snap.data.spans.length > 0);
assert.equal(snap.data.facts.host.length > 0, true, 'collector facts present');
await post('/ingest', '{"t":"status","id":2,"state":"blocked","kind":"permission"}', { 'x-kijo-source': 'agent-1' });
let live; for (let i = 0; i < 20 && !live; i++) { const f = await frame(); if (f.ev === 'm') live = f.data.find(m => m.t === 'status'); }
assert.deepEqual([live.id, live.state, live.kind, live.src], [2, 'blocked', 'permission', 'agent-1'], 'status injected into the runtime stream');

// ---- collector produces real host numbers
await new Promise(ok => setTimeout(ok, 1300));
for (const name of ['cpu.util_pct', 'mem.used_pct', 'cpu.load1']) assert.ok(d.store.series.has(name), name + ' collected');
const mem = d.store.last('mem.used_pct').v; assert.ok(mem > 0 && mem <= 100);
assert.ok(d.store.names().some(n => n.startsWith('cpu.core_pct{core=')));

// ---- sessions (layout handed from one device to the next)
assert.equal((await fetch(base + '/api/session/default', { headers: H })).status, 404);
assert.equal((await fetch(base + '/api/session/default', { method: 'PUT', headers: H, body: '{"version":2}' })).status, 200);
assert.equal((await (await fetch(base + '/api/session/default', { headers: H })).json()).version, 2);
assert.equal((await fetch(base + '/api/session/..%2Fetc', { method: 'PUT', headers: H, body: '{}' })).status, 404, 'session names are validated');
assert.equal((await fetch(base + '/api/session/x', { method: 'PUT', headers: H, body: 'not json' })).status, 400);

// ---- CORS only reflects when asked, and OPTIONS preflight works
const pre = await fetch(base + '/ingest', { method: 'OPTIONS', headers: { origin: 'null' } }); assert.equal(pre.status, 204);
assert.equal(pre.headers.get('access-control-allow-origin'), 'null');

// ---- PTY: refused by default (shell access is opt-in) ...
assert.equal((await post('/pty/open', '{}')).status, 403, 'no shell unless the operator enabled it');
ac.abort(); await d.close();

// ---- ... and a real shell when enabled
const ds = await startDaemon({ port: 0, token: 'tok2', collect: false, ui: '<!doctype html>', quiet: true, shell: true });
{
  const b2 = `http://127.0.0.1:${ds.port}`, H2 = { authorization: 'Bearer tok2' };
  const sse = new AbortController(), res = await fetch(b2 + '/events', { headers: H2, signal: sse.signal });
  const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '', out = '', snap = null, exit = null;
  (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i;
    while ((i = buf.indexOf('\n\n')) >= 0) { const f = buf.slice(0, i); buf = buf.slice(i + 2); const ev = f.match(/^event: (.*)$/m)?.[1], dj = f.match(/^data: (.*)$/m)?.[1]; if (!dj) continue;
      const j = JSON.parse(dj); if (ev === 'snapshot') snap = j; if (ev === 'pty') { if (j.d) out += Buffer.from(j.d, 'base64').toString('latin1'); if ('exit' in j) exit = j.exit; } } } } catch {} })();
  const until = async (fn, ms = 6000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout; out=' + JSON.stringify(out.slice(-200))); await new Promise(r => setTimeout(r, 25)); } };
  await until(() => snap); assert.equal(snap.shell, true, 'snapshot advertises shell capability');
  const p2 = (path, body) => fetch(b2 + path, { method: 'POST', body, headers: H2 });
  assert.equal((await fetch(b2 + '/pty/open', { method: 'POST', body: '{}' })).status, 401);
  const { id } = await (await p2('/pty/open', JSON.stringify({ cols: 100, rows: 30 }))).json(); assert.ok(id > 0);
  assert.equal((await p2(`/pty/${id}/in`, 'x'.repeat(70000))).status, 413, 'input size is capped');
  assert.equal((await p2('/pty/999/in', 'x')).status, 404);
  await p2(`/pty/${id}/in`, 'stty size; echo KIJO_$((6*7))_OK\n');
  await until(() => /KIJO_42_OK/.test(out));
  assert.match(out, /30 100/, 'the shell sees the requested size');
  await p2(`/pty/${id}/resize`, JSON.stringify({ cols: 90, rows: 20 })); await p2(`/pty/${id}/in`, 'stty size\n');
  await until(() => /20 90/.test(out));
  assert.match(out, /\x1b|\$|#|%/, 'raw terminal bytes, prompt included');
  await p2(`/pty/${id}/in`, 'exit 3\n'); await until(() => exit !== null); assert.equal(exit, 3, 'exit status is reported');
  // a second client attaching mid-session gets the replay buffer
  const { id: id2 } = await (await p2('/pty/open', '{}')).json(); await p2(`/pty/${id2}/in`, 'echo REPLAY_MARK\n'); await until(() => /REPLAY_MARK/.test(out));
  const r2 = await fetch(b2 + '/events', { headers: H2 }), rd2 = r2.body.getReader(); const first = new TextDecoder().decode((await rd2.read()).value);
  const sj = JSON.parse(first.match(/^data: (.*)$/m)[1]); assert.equal(sj.ptys.length, 1); assert.match(Buffer.from(sj.ptys[0].d, 'base64').toString(), /REPLAY_MARK/); rd2.cancel();
  // no attached browser -> shells are reaped
  sse.abort(); await new Promise(r => setTimeout(r, 100));
  await ds.close();
}

console.log('PASS — kijod: auth, DNS-rebinding guard, text/Prometheus/OTLP ingest, request tracing, SSE snapshot+live, collector, sessions, PTY opt-in (403 by default; real shell, size, resize, exit, replay, input cap)');
