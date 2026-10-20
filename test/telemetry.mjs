import assert from 'node:assert/strict';
import { Store, parseText, parsePrometheus, otlp, normalizeJson, guessUnit, baseName } from '../src/telemetry.mjs';

// ---- store basics: bounded, ordered, windowed
const s = new Store({ cap: 100 });
for (let i = 0; i < 500; i++) s.push('cpu.util_pct', i % 100, 1_000_000 + i * 1000, { src: 'a' });
assert.ok(s.series.get('cpu.util_pct').ts.length <= 125, 'history is bounded');
assert.equal(s.last('cpu.util_pct').ts, 1_000_000 + 499 * 1000);
const w = s.window('cpu.util_pct', 10_000, 1_000_000 + 499 * 1000);
assert.equal(w.to - w.from, 11, 'window is inclusive of both ends');
assert.equal(s.series.get('cpu.util_pct').unit, '%');
assert.equal(s.push('x', NaN), false); assert.equal(s.push('x', 'abc'), false); assert.equal(s.push('', 1), false);
assert.equal(s.dropped, 3);
s.push('late', 1, 5000); s.push('late', 2, 4000);
assert.deepEqual(s.series.get('late').ts, [4000, 5000], 'out-of-order points are inserted in order');

// ---- series cap protects memory
const cap = new Store(); let accepted = 0;
for (let i = 0; i < 1000; i++) if (cap.push('m' + i, 1)) accepted++;
assert.equal(accepted, 600);

// ---- labels create distinct series; baseName groups them
const l = new Store(); l.push('cpu.core_pct', 10, 1, { labels: { core: '0' } }); l.push('cpu.core_pct', 20, 1, { labels: { core: '1' } });
assert.deepEqual(l.names(), ['cpu.core_pct{core="0"}', 'cpu.core_pct{core="1"}']);
assert.equal(baseName(l.names()[0]), 'cpu.core_pct');

// ---- text injectors
assert.deepEqual(parseText('queue.depth 12\nqueue.age=3.5').map(m => [m.name, m.value]), [['queue.depth', 12], ['queue.age', 3.5]]);
assert.deepEqual(parseText('{"t":"metric","name":"a","value":1}\n{"t":"log","body":"hi"}').map(m => m.t), ['metric', 'log']);
assert.equal(parseText('[{"t":"metric","name":"a","value":1},{"t":"metric","name":"b","value":2}]').length, 2);
const prom = parsePrometheus('# HELP x y\n# TYPE x gauge\nhttp_requests_total{code="200",path="/a b"} 1027 1700000000000\nup 1\nbad line\nnan_metric NaN');
assert.equal(prom.length, 2); assert.deepEqual(prom[0].labels, { code: '200', path: '/a b' }); assert.equal(prom[0].ts, 1700000000000);
assert.deepEqual(parseText('{"t":"status","id":1,"state":"error"}\nremote.queue 99').map(m => m.t), ['status', 'metric'], 'JSON and text lines can share a body');
assert.equal(parseText('garbage in, nothing out').length, 0);
assert.equal(parseText('').length, 0);

// ---- OTLP/HTTP JSON (what an OTel SDK or collector would send)
const metrics = normalizeJson({ resourceMetrics: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'api' } }] }, scopeMetrics: [{ metrics: [
  { name: 'queue.depth', unit: '1', gauge: { dataPoints: [{ timeUnixNano: '1700000000000000000', asInt: '7', attributes: [{ key: 'q', value: { stringValue: 'a' } }] }] } },
  { name: 'http.duration', unit: 'ms', histogram: { dataPoints: [{ count: '4', sum: 100, timeUnixNano: '1700000001000000000' }] } }] }] }] });
assert.equal(metrics.length, 3);
assert.deepEqual(metrics[0].labels, { service: 'api', q: 'a' }); assert.equal(metrics[0].value, 7); assert.equal(metrics[0].ts, 1700000000000);
assert.equal(metrics[1].name, 'http.duration.avg'); assert.equal(metrics[1].value, 25);
const spans = otlp('traces', { resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'api' } }] }, scopeSpans: [{ spans: [
  { traceId: 't1', spanId: 's1', name: 'GET /x', startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000000050000000', status: { code: 2 } }] }] }] });
assert.equal(spans[0].dur, 50); assert.equal(spans[0].status, 'error'); assert.equal(spans[0].name, 'api GET /x');
const logs = otlp('logs', { resourceLogs: [{ scopeLogs: [{ logRecords: [{ severityNumber: 17, body: { stringValue: 'boom' }, timeUnixNano: '1700000000000000000' }] }] }] });
assert.equal(logs[0].level, 17); const st = new Store(); st.ingest(logs[0]); assert.equal(st.logs[0].level, 'error');

// ---- ingest routing, sources and rates
const r = new Store(); const now = 1_000_000_000;
for (let i = 0; i < 20; i++) r.ingest({ t: 'metric', name: 'a', value: i, ts: now + i }, { src: 'curl', via: 'daemon' });
r.ingest({ t: 'log', body: 'x', level: 'warn' }, { src: 'curl' });
r.touch('curl', 'daemon', 'metric', 'a', now); // pin the clock for the rate check
assert.equal(r.sources.get('curl').count, 22);
assert.ok(r.sources.get('curl').types.has('log'));
assert.equal(r.ingest({ t: 'nonsense' }), false); assert.equal(r.ingest(null), false); assert.equal(r.ingest('str'), false);
assert.ok(r.dropped >= 3);

// ---- status injection reaches the runtime hook; bad ids are rejected
const calls = [];
r.onStatus = x => (calls.push(x), true);
assert.equal(r.ingest({ t: 'status', id: 2, state: 'blocked', kind: 'permission', progress: 10 }, { src: 'agent' }), true);
assert.deepEqual(calls[0], { id: 2, state: 2, kind: 1, progress: 10, src: 'agent' });
assert.equal(r.ingest({ t: 'status', id: 'x', state: 'blocked' }), false);
assert.equal(r.ingest({ t: 'status', id: 2, state: 'exploding' }), false);

// ---- clock skew is applied to daemon-sourced timestamps
const k = new Store(); k.ingest({ t: 'metric', name: 'a', value: 1, ts: 10_000 }, { skew: 4_000 });
assert.equal(k.series.get('a').ts[0], 6_000);

// ---- snapshot round trip (what a late-joining browser receives)
const a = new Store(); for (let i = 0; i < 50; i++) a.push('m', i, i * 1000); a.log('hello', 'warn', 1); a.span({ name: 'n', start: 1, dur: 2 }); a.fact('kernel', '6.1');
const b = new Store(); b.load(a.snapshot({ points: 20 }));
assert.equal(b.series.get('m').v.length, 20); assert.equal(b.logs[0].level, 'warn'); assert.equal(b.spans.length, 1); assert.equal(b.facts.get('kernel'), '6.1');
assert.equal(guessUnit('mem.used_pct'), '%'); assert.equal(guessUnit('browser.draw_ms'), 'ms'); assert.equal(guessUnit('queue.depth'), '');

// ---- reconnect replay does not duplicate anything
const rp = new Store(); rp.load(a.snapshot({ points: 20 })); const n0 = rp.series.get('m').ts.length; rp.load(a.snapshot({ points: 20 }), { dedupe: true });
assert.equal(rp.series.get('m').ts.length, n0, 'replayed points collapse'); assert.equal(rp.logs.length, 1, 'replayed logs are skipped'); assert.equal(rp.spans.length, 1, 'replayed spans are skipped');

console.log('PASS — telemetry store: bounded history, ordering, labels, text/Prometheus/OTLP injectors, status hook, skew, snapshots');
