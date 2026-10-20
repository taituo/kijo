#!/usr/bin/env node
// Builds dist/kijo.html: the Chrome host as ONE self-contained file
// (WASM, WGSL and modules inlined). Open it straight from disk, mail it,
// or host it anywhere static. No bundler dependency: our modules only use
// plain `import {..} from` / `export` forms, which are stripped here.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(resolve(root, p), 'utf8');
const order = ['web/fonts.mjs', 'src/core.mjs', 'web/displaylist.mjs', 'web/gpu.mjs', 'web/canvas2d.mjs', 'web/main.mjs'];

export function bundle() {
  const code = order.map(p => `// ---- ${p}\n` + read(p)
    .replace(/^import\s[^;]+;\s*$/gm, '')
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, '')
    .replace(/^export\s+(?=(async\s+)?function|const|let|class)/gm, '')).join('\n');
  if (/^\s*(import|export)\s/m.test(code)) throw new Error('bundle: unhandled import/export form');
  const embed = {};
  for (const p of ['core/scene.wasm.b64', 'shaders/scene.wgsl', 'shaders/heatmap.wgsl']) embed[p] = read(p);
  const json = JSON.stringify(embed).replace(/</g, '\\u003c');
  const html = read('web/index.html').replace('<script type="module" src="./main.mjs"></script>',
    `<script>globalThis.KIJO_EMBED=${json};</script>\n<script type="module">\n${code.replace(/<\/script/gi, '<\\/script')}\n</script>`);
  return html;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = resolve(root, process.argv[2] || 'dist/kijo.html');
  mkdirSync(dirname(out), { recursive: true });
  const html = bundle();
  writeFileSync(out, html);
  console.log(`Wrote ${out} (${(html.length / 1024).toFixed(1)} KB)`);
}
