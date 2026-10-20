#!/usr/bin/env node
// kijod - the optional relay. NOT an installed service: one self-contained file (see `npm run bundle`)
// you run over the SSH session you already have, and it dies with the connection:
//
//   ssh -L 7501:127.0.0.1:7501 vps 'node --input-type=module -' < dist/kijod.mjs
//   -> prints  http://127.0.0.1:7501/#token=...   open that in any browser. Nothing is written to disk.
//
// It does four things and nothing else:
//   1. serves the UI (embedded in the bundle)           GET  /
//   2. collects real host metrics (cpu, mem, net, load)  built-in injector, --no-collect to disable
//   3. accepts injectors: JSON / NDJSON / Prometheus text / `name value` lines  POST /ingest
//      and OTLP/HTTP JSON from OTel SDKs and collectors                         POST /v1/{metrics,traces,logs}
//   4. fans everything out to attached browsers as one SSE stream               GET  /events
// The browser keeps the layout; kijod holds only recent telemetry for late joiners.
// Security: a random bearer token is always required for everything except the static page;
// binds 127.0.0.1 unless KIJOD_BIND says otherwise; Host/Origin are checked against DNS rebinding.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Store, parseText, normalizeJson, otlp } from './telemetry.mjs';

const VERSION = '0.5.0';
const BODY_LIMIT = 1_000_000, BATCH_LIMIT = 5000, MAX_CLIENTS = 16, MAX_PTYS = 4, PTY_IN_LIMIT = 65_536, PTY_REPLAY = 65_536;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const rid = n => randomBytes(n).toString('hex');
const sha = s => createHash('sha256').update(String(s)).digest();
const sameSecret = (a, b) => timingSafeEqual(sha(a), sha(b));

// ---- PTY helper: python3 is the one thing every Linux/macOS host has that can allocate a pty without a native addon.
// stdin = bytes for the shell, stdout = bytes from it, fd 3 = "cols rows\n" resize requests. Exits with the shell.
const PTY_HELPER = `
exec('import os, pty, sys, select, struct, fcntl, termios, signal')  # (exec keeps the single-file bundler from mistaking this for a JS import)
cols, rows = int(sys.argv[1]), int(sys.argv[2])
shell = os.environ.get('SHELL') or '/bin/sh'
pid, fd = pty.fork()
if pid == 0:
    os.environ['TERM'] = 'xterm-256color'; os.environ['KIJO'] = '1'
    try: os.execvp(shell, [shell, '-l'] if os.path.basename(shell) in ('bash','zsh') else [shell])
    except Exception: os.execvp('/bin/sh', ['/bin/sh'])
def size(c, r):
    try: fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
    except Exception: pass
size(cols, rows)
signal.signal(signal.SIGTERM, lambda *a: (os.kill(pid, signal.SIGHUP), os._exit(0)))
ctl = 3; src = [0, fd, ctl]; cbuf = b''
while True:
    try: r, _, _ = select.select(src, [], [])
    except InterruptedError: continue
    if fd in r:
        try: d = os.read(fd, 65536)
        except OSError: d = b''
        if not d: break
        os.write(1, d)
    if 0 in r:
        d = os.read(0, 65536)
        if not d: src.remove(0); os.kill(pid, signal.SIGHUP)
        else: os.write(fd, d)
    if ctl in r:
        d = os.read(ctl, 256)
        if not d: src.remove(ctl)
        else:
            cbuf += d
            while b'\\n' in cbuf:
                ln, cbuf = cbuf.split(b'\\n', 1)
                try: c, rr = ln.split(); size(int(c), int(rr))
                except Exception: pass
try: _, st = os.waitpid(pid, 0)
except Exception: st = 0
sys.exit(os.waitstatus_to_exitcode(st) & 255)
`;

export async function startDaemon({ port = 7501, host = '127.0.0.1', token = process.env.KIJOD_TOKEN || rid(16), collect = true, ui = globalThis.__KIJO_UI__ || null, stateDir = process.env.KIJOD_STATE || '', quiet = false, shell = process.env.KIJOD_SHELL === '1' } = {}) {
  const store = new Store({ cap: 1800 });
  store.onStatus = () => true; // status messages are forwarded to browsers; the daemon owns no tiles
  const clients = new Set(), sessions = new Map();
  let queue = [], flushTimer = null, ingested = 0, authFails = 0, lastAuthLog = 0;
  const hostname = os.hostname(), t0 = Date.now();
  const say = (...a) => { if (!quiet) console.error(...a); };

  // ---- emit: the one path every message takes (store for late joiners, queue for live clients)
  function emit(msg, src, via = 'kijod') {
    if (msg.t === 'status') store.touch(src, via, 'status'); else if (!store.ingest({ ...msg, ts: msg.ts ?? Date.now() }, { src, via })) return false;
    queue.push({ ...msg, ts: msg.ts ?? Date.now(), src: msg.src || src });
    ingested++;
    flushTimer ??= setTimeout(flush, 250);
    return true;
  }
  function flush() {
    flushTimer = null; if (!queue.length) return;
    const frame = `event: m\ndata: ${JSON.stringify(queue)}\n\n`; queue = [];
    for (const c of clients) {
      if (c.res.writableLength > 2_000_000) { c.res.destroy(); clients.delete(c); continue; } // slow client: drop it, never buffer unboundedly
      c.res.write(frame);
    }
  }
  const log = (level, body) => emit({ t: 'log', level, body }, 'kijod');

  // ---- PTY sessions (opt-in: this is shell access, so it is off unless the operator asked for it)
  const ptys = new Map(); let ptySeq = 0, idleTimer = null;
  const sse = (event, obj) => { const f = `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`; for (const c of clients) c.res.write(f); };
  function ptyOpen(cols, rows) {
    const id = ++ptySeq, p = spawn('python3', ['-I', '-c', PTY_HELPER, String(cols), String(rows)], { stdio: ['pipe', 'pipe', 'ignore', 'pipe'] });
    const s = { id, p, cols, rows, replay: Buffer.alloc(0), pending: [], timer: null, dead: false };
    const flushOut = () => { s.timer = null; s.lastFlush = Date.now(); const d = Buffer.concat(s.pending); s.pending = []; if (d.length) sse('pty', { id, d: d.toString('base64') }); };
    s.lastFlush = 0; // leading edge: output after a quiet moment goes out at once (keystroke echo), a burst is coalesced into ~16 ms frames
    p.stdout.on('data', d => { s.replay = Buffer.concat([s.replay, d]).subarray(-PTY_REPLAY); s.pending.push(d); if (s.timer) return; const wait = 16 - (Date.now() - s.lastFlush); if (wait <= 0) flushOut(); else s.timer = setTimeout(flushOut, wait); });
    p.on('error', e => { log('warn', `pty ${id} failed: ${e.message}`); });
    p.on('close', code => { s.dead = true; clearTimeout(s.timer); flushOut(); ptys.delete(id); sse('pty', { id, exit: code ?? -1 }); log('info', `pty ${id} exited (${code})`); });
    p.stdin.on('error', () => {}); p.stdio[3].on('error', () => {});
    ptys.set(id, s); log('info', `pty ${id} opened (${cols}x${rows})`); return s;
  }
  const ptyKill = s => { try { s.p.kill('SIGTERM'); } catch {} };
  const ptyAll = () => { for (const s of ptys.values()) ptyKill(s); };
  const idleCheck = () => { clearTimeout(idleTimer); if (!clients.size && ptys.size) idleTimer = setTimeout(() => { if (!clients.size) { log('info', 'no browser attached: closing ptys'); ptyAll(); } }, 10_000); };

  // ---- request tracing: kijod's own request handling is real, measured telemetry
  class Trace {
    constructor(name) { this.name = name; this.id = rid(8); this.root = rid(4); this.start = Date.now(); this.p0 = performance.now(); this.steps = []; this.cur = null; }
    step(n) { const now = performance.now(); if (this.cur) this.cur.dur = now - this.cur.p0; this.cur = { name: n, p0: now, dur: 0 }; this.steps.push(this.cur); }
    end(status = 'ok') {
      const now = performance.now(); if (this.cur) this.cur.dur = now - this.cur.p0;
      emit({ t: 'span', name: this.name, trace: this.id, id: this.root, start: this.start, dur: now - this.p0, status }, 'kijod');
      for (const s of this.steps) emit({ t: 'span', name: s.name, trace: this.id, id: rid(4), parent: this.root, start: this.start + (s.p0 - this.p0), dur: s.dur, status }, 'kijod');
    }
  }

  // ---- http
  const hostOk = h => { if (!h) return false; const name = h.replace(/:\d+$/, '').replace(/^\[|\]$/g, ''); return !LOOPBACK.has(host) || LOOPBACK.has(name); }; // DNS-rebinding guard on loopback binds
  const bearer = req => { const a = req.headers.authorization || ''; return a.startsWith('Bearer ') ? a.slice(7) : ''; };
  function readBody(req) {
    return new Promise((ok, fail) => {
      const chunks = []; let n = 0;
      req.on('data', c => { n += c.length; if (n > BODY_LIMIT) { if (chunks.length) { chunks.length = 0; fail(Object.assign(new Error('body too large'), { code: 413 })); } } else chunks.push(c); });
      req.on('end', () => ok(Buffer.concat(chunks).toString('utf8'))); req.on('error', fail);
    });
  }
  const send = (res, code, body, type = 'application/json', extra = {}) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(code === 413 ? { connection: 'close' } : {}), ...extra }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  const srcOf = req => String(req.headers['x-kijo-source'] || '').replace(/[^\w.@:-]/g, '').slice(0, 40) || `http@${LOOPBACK.has(req.socket.remoteAddress?.replace('::ffff:', '')) || req.socket.remoteAddress === '::1' ? 'local' : req.socket.remoteAddress}`;

  async function route(req, res) {
    const url = new URL(req.url, 'http://x'), path = url.pathname;
    if (!hostOk(req.headers.host)) return send(res, 421, { error: 'bad Host header' });
    // CORS: the bearer token is the credential, so any origin that has it may talk to us.
    const origin = req.headers.origin, cors = origin ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, content-type, x-kijo-source', 'access-control-allow-methods': 'GET, POST, PUT, OPTIONS', vary: 'origin' } : {};
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      const html = ui ?? (await import('./bundle.mjs')).bundle();
      return send(res, 200, html, 'text/html; charset=utf-8', { 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; connect-src *; img-src data:", 'referrer-policy': 'no-referrer' });
    }
    if (path === '/healthz') return send(res, 200, { kijod: VERSION, uptime_s: Math.round((Date.now() - t0) / 1000) }, 'application/json', cors);

    // everything below needs the token
    if (!sameSecret(bearer(req), token)) {
      authFails++; if (Date.now() - lastAuthLog > 10_000) { lastAuthLog = Date.now(); log('warn', `rejected ${authFails} unauthenticated request(s), last: ${req.method} ${path}`); }
      return send(res, 401, { error: 'bearer token required' }, 'application/json', cors);
    }
    if (req.method === 'GET' && path === '/events') {
      if (clients.size >= MAX_CLIENTS) return send(res, 503, { error: 'too many clients' }, 'application/json', cors);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no', ...cors });
      res.write(`event: snapshot\ndata: ${JSON.stringify({ now: Date.now(), host: hostname, version: VERSION, shell, ptys: [...ptys.values()].map(p => ({ id: p.id, cols: p.cols, rows: p.rows, d: p.replay.toString('base64') })), ...store.snapshot() })}\n\n`);
      const c = { res }; clients.add(c); clearTimeout(idleTimer);
      const ka = setInterval(() => res.write(': ka\n\n'), 15_000);
      req.on('close', () => { clearInterval(ka); clients.delete(c); idleCheck(); log('info', `client detached (${clients.size} attached)`); });
      log('info', `client attached (${clients.size} attached)`);
      return;
    }
    if (req.method === 'POST' && (path === '/ingest' || path.startsWith('/v1/'))) {
      const tr = new Trace(`POST ${path}`);
      try {
        tr.step('read body'); const body = await readBody(req);
        tr.step('parse');
        let msgs;
        if (path.startsWith('/v1/')) {
          if (/protobuf/i.test(req.headers['content-type'] || '')) { tr.end('error'); return send(res, 415, { error: 'OTLP protobuf is not supported; set OTEL_EXPORTER_OTLP_PROTOCOL=http/json' }, 'application/json', cors); }
          const kind = path.slice(4); if (!['metrics', 'traces', 'logs'].includes(kind)) { tr.end('error'); return send(res, 404, { error: 'unknown OTLP signal' }, 'application/json', cors); }
          msgs = otlp(kind, JSON.parse(body || '{}'));
        } else msgs = parseText(body);
        if (msgs.length > BATCH_LIMIT) msgs = msgs.slice(0, BATCH_LIMIT);
        tr.step('apply'); const src = srcOf(req); let n = 0;
        for (const m of msgs) if (emit(m, m.src || src, 'http')) n++;
        tr.end(); return send(res, 200, path.startsWith('/v1/') ? {} : { accepted: n, rejected: msgs.length - n }, 'application/json', cors);
      } catch (e) { tr.end('error'); log('warn', `ingest failed: ${e.message}`); return send(res, e.code || 400, { error: e.message }, 'application/json', cors); }
    }

    const pm = path.match(/^\/pty\/(open|(\d{1,6})\/(in|resize|close))$/);
    if (pm && req.method === 'POST') {
      if (!shell) return send(res, 403, { error: 'shell access is disabled; start kijod with --allow-shell or KIJOD_SHELL=1' }, 'application/json', cors);
      const body = await readBody(req).catch(() => null); if (body === null) return send(res, 413, { error: 'too large' }, 'application/json', cors);
      const clamp = (v, lo, hi, d) => Math.max(lo, Math.min(hi, Math.round(Number(v)) || d));
      if (pm[1] === 'open') {
        if (ptys.size >= MAX_PTYS) return send(res, 429, { error: 'too many shells' }, 'application/json', cors);
        let j = {}; try { j = JSON.parse(body || '{}'); } catch {}
        const s = ptyOpen(clamp(j.cols, 10, 500, 80), clamp(j.rows, 2, 200, 24)); return send(res, 200, { id: s.id }, 'application/json', cors);
      }
      const s = ptys.get(Number(pm[2])); if (!s) return send(res, 404, { error: 'no such shell' }, 'application/json', cors);
      if (pm[3] === 'in') { if (Buffer.byteLength(body) > PTY_IN_LIMIT) return send(res, 413, { error: 'too large' }, 'application/json', cors); s.p.stdin.write(body); return send(res, 200, { ok: true }, 'application/json', cors); }
      if (pm[3] === 'close') { ptyKill(s); return send(res, 200, { ok: true }, 'application/json', cors); }
      let j = {}; try { j = JSON.parse(body); } catch { return send(res, 400, { error: 'not JSON' }, 'application/json', cors); }
      s.cols = clamp(j.cols, 10, 500, s.cols); s.rows = clamp(j.rows, 2, 200, s.rows); s.p.stdio[3].write(`${s.cols} ${s.rows}\n`); return send(res, 200, { ok: true }, 'application/json', cors);
    }
    const sm = path.match(/^\/api\/session\/([a-z0-9_-]{1,32})$/);
    if (sm) { // layout + notes live with the browser; this only lets a second device pick the same session up
      const name = sm[1], file = stateDir ? join(stateDir, name + '.json') : '';
      if (req.method === 'GET') { const v = sessions.get(name) ?? (file && existsSync(file) ? readFileSync(file, 'utf8') : null); return v ? send(res, 200, v, 'application/json', cors) : send(res, 404, { error: 'no such session' }, 'application/json', cors); }
      if (req.method === 'PUT') {
        const body = await readBody(req).catch(e => null); if (body === null || body.length > 262_144) return send(res, 413, { error: 'too large' }, 'application/json', cors);
        try { JSON.parse(body); } catch { return send(res, 400, { error: 'not JSON' }, 'application/json', cors); }
        sessions.set(name, body); if (file) { mkdirSync(stateDir, { recursive: true }); writeFileSync(file, body, { mode: 0o600 }); }
        return send(res, 200, { ok: true }, 'application/json', cors);
      }
    }
    return send(res, 404, { error: 'not found' }, 'application/json', cors);
  }
  const server = createServer((req, res) => route(req, res).catch(e => { try { send(res, 500, { error: 'internal' }); } catch {} }));
  server.requestTimeout = 30_000; server.headersTimeout = 10_000; // slowloris; SSE responses are not request-bound
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, host, ok); });
  const bound = server.address().port;

  // ---- built-in injector: real host numbers, same path as any remote injector
  const timers = [];
  if (collect) {
    const src = `proc@${hostname}`, cpus = os.cpus();
    const metric = (name, value, labels) => emit({ t: 'metric', name, value, ...(labels ? { labels } : {}) }, src, 'collector');
    const fact = (key, value) => emit({ t: 'fact', key, value }, src, 'collector');
    fact('host', hostname); fact('os', `${os.type()} ${os.release()}`); fact('arch', os.arch()); fact('cpu', (cpus[0]?.model || 'unknown').replace(/\s+/g, ' ')); fact('cores', cpus.length); fact('mem_total_mb', Math.round(os.totalmem() / 1048576)); fact('kijod', `${VERSION} node ${process.versions.node}`);
    let prev = os.cpus().map(c => ({ ...c.times })), prevNet = readNet(), prevT = Date.now();
    const tick = () => {
      const now = Date.now(), dt = (now - prevT) / 1000 || 1; prevT = now;
      const cur = os.cpus(); let busyAll = 0, totAll = 0;
      cur.forEach((c, i) => {
        const a = prev[i], b = c.times, idle = b.idle - a.idle, tot = Object.keys(b).reduce((s, k) => s + (b[k] - a[k]), 0);
        if (tot > 0) { metric('cpu.core_pct', Math.round((1 - idle / tot) * 1000) / 10, { core: String(i) }); busyAll += tot - idle; totAll += tot; }
      });
      prev = cur.map(c => ({ ...c.times }));
      if (totAll > 0) metric('cpu.util_pct', Math.round(busyAll / totAll * 1000) / 10);
      metric('cpu.load1', os.loadavg()[0]);
      const mem = readMem(); metric('mem.used_pct', Math.round(mem.used / mem.total * 1000) / 10); metric('mem.used_mb', Math.round(mem.used / 1048576));
      const net = readNet(); if (net && prevNet) { metric('net.rx_kbps', Math.round((net.rx - prevNet.rx) * 8 / 1000 / dt)); metric('net.tx_kbps', Math.round((net.tx - prevNet.tx) * 8 / 1000 / dt)); } prevNet = net;
      metric('sys.uptime_s', Math.round(os.uptime()));
      emit({ t: 'metric', name: 'kijod.clients', value: clients.size }, 'kijod'); emit({ t: 'metric', name: 'kijod.msgs_per_s', value: Math.round(ingested / ((now - t0) / 1000) * 10) / 10 }, 'kijod'); emit({ t: 'metric', name: 'kijod.rss_mb', value: Math.round(process.memoryUsage.rss() / 1048576) }, 'kijod');
    };
    timers.push(setInterval(tick, 1000)); timers.forEach(t => t.unref?.());
  }
  log('info', `kijod ${VERSION} up on ${host}:${bound}${collect ? ', collecting host metrics' : ''}`);

  return { server, store, token, port: bound, emit, clients, shell, close: () => { ptyAll(); clearTimeout(idleTimer); timers.forEach(clearInterval); clearTimeout(flushTimer); for (const c of clients) c.res.destroy(); server.closeAllConnections?.(); return new Promise(ok => server.close(ok)); } };
}

function readMem() {
  try { const t = readFileSync('/proc/meminfo', 'utf8'), g = k => Number(t.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'))?.[1]) * 1024; const total = g('MemTotal'), avail = g('MemAvailable'); if (total && avail) return { total, used: total - avail }; } catch {}
  return { total: os.totalmem(), used: os.totalmem() - os.freemem() };
}
function readNet() { // Linux only; elsewhere the net series simply never appears
  try { let rx = 0, tx = 0; for (const l of readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2)) { const [n, rest] = l.split(':'); if (!rest || n.trim() === 'lo') continue; const f = rest.trim().split(/\s+/).map(Number); rx += f[0]; tx += f[8]; } return { rx, tx }; } catch { return null; }
}

const isMain = globalThis.__KIJOD_BUNDLED__ || (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) {
  const host = process.env.KIJOD_BIND || '127.0.0.1', port = Number(process.env.KIJOD_PORT || 7501);
  const d = await startDaemon({ port, host, collect: !process.argv.includes('--no-collect'), shell: process.argv.includes('--allow-shell') || process.env.KIJOD_SHELL === '1' }).catch(e => { console.error('kijod: cannot start:', e.message); process.exit(1); });
  const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  console.error(`\nkijod ${VERSION}\n  open   http://${shown}:${d.port}/#token=${d.token}\n  inject curl -H "Authorization: Bearer ${d.token}" --data-binary 'my.metric 42' http://${shown}:${d.port}/ingest\n  otlp   OTEL_EXPORTER_OTLP_ENDPOINT=http://${shown}:${d.port} OTEL_EXPORTER_OTLP_PROTOCOL=http/json OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer%20${d.token}\n${d.shell ? '  SHELL  shell access is ENABLED: anyone holding the token can run commands as this user.\n' : ''}${host !== '127.0.0.1' && host !== '::1' ? '  NOTE   bound beyond loopback: put TLS in front (reverse proxy) before exposing this.\n' : ''}`);
  const bye = () => d.close().then(() => process.exit(0)); process.on('SIGINT', bye); process.on('SIGTERM', bye); process.on('SIGHUP', bye);
}
