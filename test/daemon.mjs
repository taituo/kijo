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

ac.abort(); await d.close();
console.log('PASS — kijod: auth, DNS-rebinding guard, text/Prometheus/OTLP ingest, request tracing, SSE snapshot+live, collector, sessions');
