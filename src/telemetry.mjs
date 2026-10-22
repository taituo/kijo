// Kijo telemetry store + injector parsers. Environment neutral (browser, Node, kijod).
// Nothing here touches the DOM, the network or the filesystem: injectors hand in text or
// objects, the store keeps bounded history, and renderers read it. Zero install by design:
// the browser page owns a Store; a relay (kijod) is optional and only forwards messages.
//
// Message schema (all fields optional unless marked):
//   {t:'metric', name*, value*, ts, unit, labels:{}}
//   {t:'log',    body*, level, ts, attrs:{}}
//   {t:'span',   name*, start*, dur*, trace, id, parent, status:'ok'|'error'}
//   {t:'status', id*, state*, kind, progress}      -> drives a tile via kijo_report (OSC 7501 vocabulary)
//   {t:'fact',   key*, value*}                     -> static facts (kernel, cpu model, ...)
// Any message may carry {src:'name'} to attribute it to an injector.

const MAX_NAME = 160, MAX_BODY = 2000;
export const STATE_NAMES = { idle: 0, working: 1, blocked: 2, error: 3, done: 4, complete: 4 };
export const KIND_NAMES = { permission: 1, question: 2, auth: 3 };

const num = v => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const str = (v, n = MAX_BODY) => String(v ?? '').slice(0, n);
export const labelKey = l => {
  const k = Object.keys(l || {}).sort();
  return k.length ? '{' + k.map(x => `${x}="${str(l[x], 60)}"`).join(',') + '}' : '';
};
export const baseName = key => key.replace(/\{.*$/, '');

export class Store {
  constructor({ cap = 1800, logCap = 600, spanCap = 2500 } = {}) {
    this.cap = cap; this.logCap = logCap; this.spanCap = spanCap;
    this.series = new Map(); this.logs = []; this.spans = []; this.facts = new Map(); this.sources = new Map();
    this.version = 0; this.dropped = 0; this.onStatus = null; this.onNewSeries = null;
  }

  // ---- sources (the Back/flow view reads these; they are real, not decorative)
  touch(src, via, type, series, now = Date.now()) {
    let s = this.sources.get(src);
    if (!s) { s = { name: src, via: via || '', first: now, last: now, count: 0, slots: new Array(10).fill(0), slotSec: new Array(10).fill(0), series: new Set(), types: new Set() }; this.sources.set(src, s); }
    s.last = now; s.count++; s.types.add(type); if (series) s.series.add(series);
    const sec = Math.floor(now / 1000), i = sec % 10;
    if (s.slotSec[i] !== sec) { s.slotSec[i] = sec; s.slots[i] = 0; }
    s.slots[i]++;
    return s;
  }
  rate(src, now = Date.now()) {
    const s = this.sources.get(src); if (!s) return 0;
    const sec = Math.floor(now / 1000); let n = 0;
    for (let i = 0; i < 10; i++) if (sec - s.slotSec[i] < 10 && sec - s.slotSec[i] >= 0) n += s.slots[i];
    return n / 10;
  }

  // ---- writes
  push(name, value, ts = Date.now(), { src = 'api', via = '', unit = '', labels } = {}) {
    value = num(value);
    if (!Number.isFinite(value) || !name) { this.dropped++; return false; }
    name = str(name, MAX_NAME);
    const key = name + labelKey(labels);
    let s = this.series.get(key);
    if (!s) {
      if (this.series.size >= 600) { this.dropped++; return false; } // hard cap: an injector cannot grow memory without bound
      s = { key, name, unit: unit || guessUnit(name), labels: labels || {}, src, ts: [], v: [] };
      this.series.set(key, s);
      this.onNewSeries?.(key);
    }
    const n = s.ts.length;
    if (n && ts === s.ts[n - 1]) s.v[n - 1] = value; // same instant: replace (snapshot replays after a reconnect)
    else if (n && ts < s.ts[n - 1]) { // out-of-order: insert (rare), keep sorted
      let i = n; while (i > 0 && s.ts[i - 1] > ts) i--;
      if (i > 0 && s.ts[i - 1] === ts) s.v[i - 1] = value; else { s.ts.splice(i, 0, ts); s.v.splice(i, 0, value); }
    } else { s.ts.push(ts); s.v.push(value); }
    if (s.ts.length > this.cap * 1.25) { s.ts.splice(0, s.ts.length - this.cap); s.v.splice(0, s.v.length - this.cap); }
    s.src = src; this.touch(src, via, 'metric', key); this.version++;
    return true;
  }
  log(body, level = 'info', ts = Date.now(), { src = 'api', via = '', attrs } = {}) {
    body = str(body); if (!body) return false;
    this.logs.push({ ts, level: normLevel(level), body, src, attrs: attrs || {} });
    if (this.logs.length > this.logCap * 1.25) this.logs.splice(0, this.logs.length - this.logCap);
    this.touch(src, via, 'log'); this.version++; return true;
  }
  span(sp, { src = 'api', via = '' } = {}) {
    const start = num(sp.start), dur = num(sp.dur);
    if (!Number.isFinite(start) || !Number.isFinite(dur) || dur < 0 || !sp.name) { this.dropped++; return false; }
    this.spans.push({ trace: str(sp.trace || sp.id || start, 64), id: str(sp.id || this.spans.length, 64), parent: sp.parent ? str(sp.parent, 64) : '',
      name: str(sp.name, 120), start, dur, status: sp.status === 'error' || sp.status === 2 ? 'error' : 'ok', src });
    if (this.spans.length > this.spanCap * 1.25) this.spans.splice(0, this.spans.length - this.spanCap);
    this.touch(src, via, 'span'); this.version++; return true;
  }
  fact(key, value, src = 'api', via = '') { this.facts.set(str(key, 80), str(value, 300)); this.touch(src, via, 'fact'); this.version++; }

  // Apply one message. Returns true when something was stored/applied.
  ingest(m, { src = 'api', via = '', skew = 0 } = {}) {
    if (!m || typeof m !== 'object') { this.dropped++; return false; }
    const s = str(m.src || src, 60), ts = Number.isFinite(num(m.ts)) ? num(m.ts) - skew : Date.now();
    switch (m.t) {
      case 'metric': return this.push(m.name, m.value, ts, { src: s, via, unit: m.unit, labels: m.labels });
      case 'log': return this.log(m.body, m.level, ts, { src: s, via, attrs: m.attrs });
      case 'span': return this.span({ ...m, start: num(m.start) - skew }, { src: s, via });
      case 'fact': this.fact(m.key, m.value, s, via); return true;
      case 'status': {
        const state = typeof m.state === 'number' ? m.state : STATE_NAMES[String(m.state).toLowerCase()];
        if (state === undefined || !Number.isInteger(num(m.id))) { this.dropped++; return false; }
        this.touch(s, via, 'status');
        return !!this.onStatus?.({ id: num(m.id), state, kind: KIND_NAMES[m.kind] || 0, progress: Number.isFinite(num(m.progress)) ? num(m.progress) : -1, src: s });
      }
      case 'canvas': { // spatial ops for agents (src/canvas.mjs applies them to the core; a relay only forwards)
        if (!canvasOk(m)) { this.dropped++; return false; }
        this.touch(s, via, 'canvas');
        return !!this.onCanvas?.(m, s);
      }
    }
    this.dropped++; return false;
  }
  ingestMany(list, opts) { let n = 0; for (const m of list) if (this.ingest(m, opts)) n++; return n; }

  // ---- reads
  names() { return [...this.series.keys()].sort(); }
  last(key) { const s = this.series.get(key); return s && s.v.length ? { ts: s.ts[s.ts.length - 1], v: s.v[s.v.length - 1] } : null; }
  // Points with ts >= now - windowMs, as parallel arrays (no copies of the whole history).
  window(key, windowMs, now = Date.now()) {
    const s = this.series.get(key); if (!s) return null;
    const lo = now - windowMs; let a = 0, b = s.ts.length;
    while (a < b) { const mid = (a + b) >> 1; if (s.ts[mid] < lo) a = mid + 1; else b = mid; }
    return { ts: s.ts, v: s.v, from: a, to: s.ts.length, unit: s.unit };
  }
  snapshot({ points = 300, logs = 120, spans = 400 } = {}) {
    return {
      series: [...this.series.values()].map(s => ({ name: s.name, unit: s.unit, labels: s.labels, src: s.src, ts: s.ts.slice(-points), v: s.v.slice(-points) })),
      logs: this.logs.slice(-logs), spans: this.spans.slice(-spans), facts: Object.fromEntries(this.facts),
    };
  }
  load(snap, { src = 'daemon', via = 'daemon', skew = 0, dedupe = false } = {}) {
    for (const s of snap.series || []) for (let i = 0; i < s.ts.length; i++) this.push(s.name, s.v[i], s.ts[i] - skew, { src: s.src || src, via, unit: s.unit, labels: s.labels });
    // logs and spans arrive in time order: on a replay, skip what we already have
    const lastLog = dedupe && this.logs.length ? this.logs[this.logs.length - 1].ts : -Infinity, lastSpan = dedupe && this.spans.length ? this.spans[this.spans.length - 1].start : -Infinity;
    for (const l of snap.logs || []) if (l.ts - skew > lastLog) this.log(l.body, l.level, l.ts - skew, { src: l.src || src, via, attrs: l.attrs });
    for (const sp of snap.spans || []) if (sp.start - skew > lastSpan) this.span({ ...sp, start: sp.start - skew }, { src: sp.src || src, via });
    for (const [k, v] of Object.entries(snap.facts || {})) this.fact(k, v, src, via);
  }
}

const LEVELS = { trace: 'debug', debug: 'debug', info: 'info', notice: 'info', warn: 'warn', warning: 'warn', error: 'error', err: 'error', fatal: 'error', critical: 'error', crit: 'error' };
export const normLevel = l => (typeof l === 'number' ? (l >= 17 ? 'error' : l >= 13 ? 'warn' : l >= 9 ? 'info' : 'debug') : LEVELS[String(l || 'info').toLowerCase()] || 'info');
const UNITS = [[/_pct$|\.pct$|util_pct|used_pct/, '%'], [/_ms$|\.ms$/, 'ms'], [/_mb$/, 'MB'], [/_kbps$/, 'kb/s'], [/fps$/, 'fps'], [/_s$|seconds$/, 's'], [/_bytes$|\.bytes$/, 'B']];
export const guessUnit = name => { for (const [re, u] of UNITS) if (re.test(name)) return u; return ''; };

// ---------------------------------------------------------------- text injectors (paste / drop / curl)

// One line of Prometheus exposition text: `name{l="v"} 12.5 [ts_ms]`.
function promLine(line) {
  const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:.]*)(\{[^}]*\})?\s+([^\s]+)(?:\s+(\d+))?$/);
  if (!m) return null;
  const labels = {};
  if (m[2]) for (const kv of m[2].slice(1, -1).matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) labels[kv[1]] = kv[2];
  const value = m[3] === '+Inf' ? Infinity : m[3] === 'NaN' ? NaN : Number(m[3]);
  if (!Number.isFinite(value)) return null;
  return { t: 'metric', name: m[1], value, labels, ...(m[4] ? { ts: Number(m[4]) } : {}) };
}
export function parsePrometheus(text) {
  const out = [];
  for (const raw of String(text).split('\n')) { const line = raw.trim(); if (!line || line[0] === '#') continue; const m = promLine(line); if (m) out.push(m); }
  return out;
}
// `name=value [ts]` (ts in seconds or ms).
function kvLine(line) {
  const m = line.match(/^([a-zA-Z_][\w.:-]*)\s*=\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)(?:\s+(\d{10,13}))?$/i);
  return m ? { t: 'metric', name: m[1], value: Number(m[2]), ...(m[3] ? { ts: m[3].length === 10 ? Number(m[3]) * 1000 : Number(m[3]) } : {}) } : null;
}

// One entry point for "text a human pasted or a script piped": JSON / NDJSON / OTLP first, then
// line by line (Prometheus exposition, `name value`, `name=value`). Unrecognised lines are skipped.
export function parseText(text) {
  text = String(text).trim(); if (!text) return [];
  if (text[0] === '{' || text[0] === '[') {
    try { return normalizeJson(JSON.parse(text)); } catch { /* maybe NDJSON */ }
    const msgs = []; let ok = true;
    for (const line of text.split('\n')) { if (!line.trim()) continue; try { msgs.push(...normalizeJson(JSON.parse(line))); } catch { ok = false; break; } }
    if (ok && msgs.length) return msgs;
  }
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim(); if (!line || line[0] === '#') continue;
    if (line[0] === '{') { try { out.push(...normalizeJson(JSON.parse(line))); continue; } catch { /* not JSON: fall through to line formats */ } } // mixed bodies: JSON lines still count
    const m = kvLine(line) || promLine(line);
    if (m) out.push(m);
  }
  return out;
}

// Shape check for {t:'canvas', op, ...} messages, shared by the page and the relay. Bounded, no nesting surprises.
export const CANVAS_OPS = ['add', 'note', 'reserve', 'fill', 'text', 'status', 'move', 'link', 'unlink', 'close', 'select', 'fly', 'fit', 'group'];
export function canvasOk(m) {
  if (!m || typeof m !== 'object' || !CANVAS_OPS.includes(m.op)) return false;
  const refOk = v => v === undefined || (typeof v === 'string' && v.length <= 64) || Number.isInteger(v);
  if (![m.id, m.near, m.owner, m.from, m.to].every(refOk)) return false;
  if (m.text !== undefined && (typeof m.text !== 'string' || m.text.length > 4000)) return false;
  if (m.of !== undefined && (!Array.isArray(m.of) || m.of.length > 256 || !m.of.every(refOk))) return false;
  return JSON.stringify(m).length <= 8192;
}

export function normalizeJson(j) {
  if (Array.isArray(j)) return j.flatMap(normalizeJson);
  if (!j || typeof j !== 'object') return [];
  if (j.resourceMetrics) return otlp('metrics', j);
  if (j.resourceSpans) return otlp('traces', j);
  if (j.resourceLogs) return otlp('logs', j);
  if (j.t) return [j];
  return [];
}

// ---------------------------------------------------------------- OTLP/HTTP JSON (OTel SDKs and collectors can export here)
const kv = arr => { const o = {}; for (const a of arr || []) { const v = a.value || {}; o[a.key] = v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue ?? ''; } return o; };
const nanoMs = n => { try { return Number(BigInt(n) / 1000000n); } catch { return Number(n) / 1e6; } };
const pointValue = p => num(p.asDouble ?? p.asInt ?? NaN);
const unitOf = u => (u === 'ms' || u === 's' || u === '%' || u === 'By' ? (u === 'By' ? 'B' : u) : '');

export function otlp(kind, j) {
  const out = [];
  if (kind === 'metrics') for (const rm of j.resourceMetrics || []) {
    const res = kv(rm.resource?.attributes), svc = res['service.name'];
    for (const sm of rm.scopeMetrics || []) for (const m of sm.metrics || []) {
      const mk = (name, p, value) => ({ t: 'metric', name, value, unit: unitOf(m.unit), ts: p.timeUnixNano ? nanoMs(p.timeUnixNano) : undefined,
        labels: { ...(svc ? { service: svc } : {}), ...kv(p.attributes) }, src: svc ? `otlp:${svc}` : 'otlp' });
      for (const p of (m.gauge || m.sum || {}).dataPoints || []) { const v = pointValue(p); if (Number.isFinite(v)) out.push(mk(m.name, p, v)); }
      for (const p of m.histogram?.dataPoints || []) {
        const c = num(p.count), s = num(p.sum);
        if (c > 0 && Number.isFinite(s)) { out.push(mk(m.name + '.avg', p, s / c)); out.push(mk(m.name + '.count', p, c)); }
      }
    }
  }
  if (kind === 'traces') for (const rs of j.resourceSpans || []) {
    const svc = kv(rs.resource?.attributes)['service.name'];
    for (const ss of rs.scopeSpans || []) for (const s of ss.spans || []) {
      const start = nanoMs(s.startTimeUnixNano), end = nanoMs(s.endTimeUnixNano);
      out.push({ t: 'span', name: (svc ? svc + ' ' : '') + s.name, trace: s.traceId, id: s.spanId, parent: s.parentSpanId, start, dur: Math.max(0, end - start), status: s.status?.code === 2 ? 'error' : 'ok', src: svc ? `otlp:${svc}` : 'otlp' });
    }
  }
  if (kind === 'logs') for (const rl of j.resourceLogs || []) {
    const svc = kv(rl.resource?.attributes)['service.name'];
    for (const sl of rl.scopeLogs || []) for (const r of sl.logRecords || []) {
      const b = r.body || {};
      out.push({ t: 'log', level: r.severityText || r.severityNumber || 'info', body: b.stringValue ?? JSON.stringify(b), ts: r.timeUnixNano ? nanoMs(r.timeUnixNano) : undefined, attrs: { ...(svc ? { service: svc } : {}), ...kv(r.attributes) }, src: svc ? `otlp:${svc}` : 'otlp' });
    }
  }
  return out;
}
