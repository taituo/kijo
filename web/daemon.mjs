// Connection to an (optional) kijod relay. SSE over fetch, so the bearer token travels in a header,
// never in a URL. Reconnects with backoff; a fresh snapshot after reconnect is de-duplicated by the store.
export function connectDaemon({ url, token, store, onState, onInfo }) {
  url = url.replace(/\/$/, '');
  let stop = false, retry = 1000, ctrl = null, skew = 0;
  const frame = text => {
    const ev = text.match(/^event: (.*)$/m)?.[1], data = text.match(/^data: (.*)$/m)?.[1];
    if (!ev || !data) return;
    let j; try { j = JSON.parse(data); } catch { return; }
    if (ev === 'snapshot') { skew = j.now - Date.now(); store.load(j, { src: 'kijod', via: 'daemon', skew, dedupe: true }); onInfo?.({ host: j.host, version: j.version, skew }); }
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
    async post(text, source = 'page') { const r = await fetch(url + '/ingest', { method: 'POST', headers: { authorization: headers.authorization, 'x-kijo-source': source }, body: text }); return r.json(); },
  };
}
