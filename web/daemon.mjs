// Connection to an (optional) kijod relay. SSE over fetch, so the bearer token travels in a header,
// never in a URL. Reconnects with backoff; a fresh snapshot after reconnect is de-duplicated by the store.
export function connectDaemon({ url, token, store, onState, onInfo, onPty }) {
  url = url.replace(/\/$/, '');
  const inq = new Map();
  let stop = false, retry = 1000, ctrl = null, skew = 0;
  const frame = text => {
    const ev = text.match(/^event: (.*)$/m)?.[1], data = text.match(/^data: (.*)$/m)?.[1];
    if (!ev || !data) return;
    let j; try { j = JSON.parse(data); } catch { return; }
    if (ev === 'snapshot') { skew = j.now - Date.now(); store.load(j, { src: 'kijod', via: 'daemon', skew, dedupe: true }); onInfo?.({ host: j.host, version: j.version, skew, shell: !!j.shell }); onPty?.({ snapshot: j.ptys || [] }); }
    else if (ev === 'pty') onPty?.(j);
    else if (ev === 'm') store.ingestMany(j, { src: 'kijod', via: 'daemon', skew });
  };
  async function run() {
    onState('connecting'); ctrl = new AbortController();
    try {
      const res = await fetch(url + '/events', { headers: { authorization: 'Bearer ' + token }, signal: ctrl.signal });
      if (res.status === 401) { onState('unauthorized'); stop = true; return; }
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      onState('connected'); retry = 1000;
      const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true }); let i;
        while ((i = buf.indexOf('\n\n')) >= 0) { const f = buf.slice(0, i); buf = buf.slice(i + 2); if (f[0] !== ':') frame(f); }
      }
    } catch (e) { if (stop) return; }
    if (stop) return; onState('down'); setTimeout(run, retry); retry = Math.min(retry * 2, 15000);
  }
  run();
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  return {
    close() { stop = true; ctrl?.abort(); onState('closed'); },
    async loadSession(name = 'default') { const r = await fetch(`${url}/api/session/${name}`, { headers }); return r.ok ? r.json() : null; },
    saveSession(state, name = 'default') { return fetch(`${url}/api/session/${name}`, { method: 'PUT', headers, body: JSON.stringify(state) }).catch(() => {}); },
    // Shell access (only when kijod was started with --allow-shell). Input is serialised per shell:
    // parallel fetches could reorder keystrokes, so one request is in flight at a time and bytes queue behind it.
    async ptyOpen(cols, rows) { const r = await fetch(url + '/pty/open', { method: 'POST', headers, body: JSON.stringify({ cols, rows }) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status); return j; },
    ptyIn(id, text) {
      const q = inq.get(id) || { buf: '', busy: false }; inq.set(id, q); q.buf += text; if (q.busy) return; q.busy = true;
      (async () => { while (q.buf) { const chunk = q.buf.slice(0, 32768); q.buf = q.buf.slice(32768); try { await fetch(`${url}/pty/${id}/in`, { method: 'POST', headers, body: chunk }); } catch { q.buf = ''; } } q.busy = false; })();
    },
    ptyResize(id, cols, rows) { return fetch(`${url}/pty/${id}/resize`, { method: 'POST', headers, body: JSON.stringify({ cols, rows }) }).catch(() => {}); },
    ptyClose(id) { return fetch(`${url}/pty/${id}/close`, { method: 'POST', headers, body: '' }).catch(() => {}); },
    async post(text, source = 'page') { const r = await fetch(url + '/ingest', { method: 'POST', headers: { authorization: headers.authorization, 'x-kijo-source': source }, body: text }); return r.json(); },
  };
}
