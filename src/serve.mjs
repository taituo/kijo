#!/usr/bin/env node
// Zero-dependency static server for the Chrome host.
//   node src/serve.mjs            -> http://127.0.0.1:7501/
//   KIJO_PORT=8080 KIJO_BIND=0.0.0.0 node src/serve.mjs
// On a VPS keep the default loopback bind and tunnel: ssh -L 7501:127.0.0.1:7501 host
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allowed = ['web', 'src', 'shaders', 'core'];
const types = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.wgsl': 'text/plain; charset=utf-8', '.b64': 'text/plain; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json' };
const port = Number(process.env.KIJO_PORT || 7501), bind = process.env.KIJO_BIND || '127.0.0.1';

export function startServer({ port: p = port, host = bind } = {}) {
  const server = createServer(async (req, res) => {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/') { res.writeHead(302, { location: '/web/' }); return res.end(); }
    if (path.endsWith('/')) path += 'index.html';
    const file = resolve(root, '.' + path);
    const top = file.slice(root.length + 1).split(sep)[0];
    if (!file.startsWith(root + sep) || !allowed.includes(top) || /\/\./.test(path)) { res.writeHead(404); return res.end('not found'); }
    try {
      if (!(await stat(file)).isFile()) throw new Error();
      res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(await readFile(file));
    } catch { res.writeHead(404); res.end('not found'); }
  });
  return new Promise(ok => server.listen(p, host, () => ok(server)));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await startServer();
  const { address, port: p } = s.address();
  console.log(`Kijo Chrome host: http://${address === '0.0.0.0' ? 'localhost' : address}:${p}/`);
}
