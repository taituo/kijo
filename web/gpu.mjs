// WebGPU backend for the Kijo display list. Two pipelines:
//   shaders/scene.wgsl   - instanced rects / strokes / dashes / glyphs
//   shaders/heatmap.wgsl - the repo's activity material, unchanged, drawn into
//                          a viewport per WORKING tile (shader_id 1 from WASM)
// The heatmap is monochrome by design; theme tint comes from blend constants.
const FLOATS = 16; // rect4 color4 uv4 params4
import { FONTS, glyphOk } from './fonts.mjs';
import { buildSurface } from './surface3d.mjs';
const ATLAS_W = 2048;

// Glyph atlas: one entry per (font, device-pixel size, weight). Glyphs are added on demand (any code point glyphOk() allows), each with
// its real advance, so proportional text lays out exactly the same in the display list and on the GPU. Adding a glyph re-lays-out and
// re-rasterises the atlas, which is cheap (a few hundred glyphs) and happens once per new character, before the frame's instances are built.
class GlyphAtlas {
  constructor() { this.sizes = new Map(); this.dirty = true; this.height = 1; this.canvas = new OffscreenCanvas(ATLAS_W, 1); }
  font(e) { return `${e.weight} ${e.px}px ${FONTS[e.font]}`; }
  entry(px, font = 'mono', weight = 400) {
    const key = `${font}/${px}/${weight}`;
    let e = this.sizes.get(key);
    if (e) return e;
    e = { key, px, font, weight, idx: new Map(), cps: [], widths: [], cw: 0, ch: Math.ceil(px * 1.4) + 2, cols: 1, y: 0 };
    this.sizes.set(key, e);
    const ctx = this.canvas.getContext('2d'); ctx.font = this.font(e);
    for (let c = 0x20; c <= 0x7e; c++) this.add(e, c, ctx);
    for (const ch of '\u00e4\u00f6\u00e5\u00c4\u00d6\u00c5\u00e9\u00fc\u00df\u2500\u2502\u2588') this.add(e, ch.codePointAt(0), ctx); // common ones up front: no first-use hitch
    this.layout(); return e;
  }
  add(e, cp, ctx) {
    if (e.idx.has(cp)) return false;
    if (!ctx) { ctx = this.canvas.getContext('2d'); ctx.font = this.font(e); }
    const w = ctx.measureText(String.fromCodePoint(cp)).width;
    e.idx.set(cp, e.cps.length); e.cps.push(cp); e.widths.push(w);
    e.cw = Math.max(e.cw, Math.ceil(w) + 2);
    return true;
  }
  ensure(e, str) { let n = false; for (const ch of str) { const cp = ch.codePointAt(0); if (glyphOk(cp) && this.add(e, cp)) n = true; } if (n) this.layout(); }
  layout() {
    let y = 0;
    for (const e of this.sizes.values()) {
      e.cols = Math.max(1, Math.floor(ATLAS_W / e.cw)); e.y = y;
      y += Math.ceil(e.cps.length / e.cols) * e.ch;
    }
    this.height = Math.max(1, y); this.dirty = true;
  }
  rasterize() {
    this.canvas = new OffscreenCanvas(ATLAS_W, this.height);
    const ctx = this.canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.textBaseline = 'top';
    for (const e of this.sizes.values()) {
      ctx.font = this.font(e);
      e.cps.forEach((cp, i) => {
        const gx = (i % e.cols) * e.cw + 1, gy = e.y + Math.floor(i / e.cols) * e.ch + 1;
        ctx.fillText(String.fromCodePoint(cp), gx, gy + Math.round(e.px * 0.12));
      });
    }
    this.dirty = false;
  }
  glyph(e, ch) {
    let cp = ch.codePointAt(0);
    if (!glyphOk(cp)) cp = 63;
    if (!e.idx.has(cp)) this.ensure(e, String.fromCodePoint(cp));
    const i = e.idx.get(cp);
    return { u: (i % e.cols) * e.cw, v: e.y + Math.floor(i / e.cols) * e.ch, adv: e.widths[i] };
  }
}

export async function createGpuRenderer(canvas, { sceneWGSL, heatWGSL, surfaceWGSL }) {
  if (!globalThis.navigator?.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  device.addEventListener('uncapturederror', ev => console.error('WebGPU:', ev.error.message));
  const context = canvas.getContext('webgpu');
  if (!context) return null;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });
  const info = adapter.info || {};
  const gpuName = [info.vendor, info.architecture].filter(Boolean).join(' ') || 'webgpu';

  const atlas = new GlyphAtlas();
  let atlasTex = null, sceneBG = null, instBuf = null, instCap = 0, data = new Float32Array(FLOATS * 1024);
  const uniBuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const sampler = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });

  const sceneModule = device.createShaderModule({ code: sceneWGSL });
  const sceneBGL = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
  ] });
  const attrs = [0, 1, 2, 3].map(i => ({ shaderLocation: i, offset: i * 16, format: 'float32x4' }));
  const alphaBlend = { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
  const scenePipe = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [sceneBGL] }),
    vertex: { module: sceneModule, entryPoint: 'vs', buffers: [{ arrayStride: FLOATS * 4, stepMode: 'instance', attributes: attrs }] },
    fragment: { module: sceneModule, entryPoint: 'fs', targets: [{ format, blend: alphaBlend }] },
    primitive: { topology: 'triangle-list' },
  });

  // Heatmap: unchanged shaders/heatmap.wgsl, one 256-byte uniform slot per draw.
  const heatModule = device.createShaderModule({ code: heatWGSL });
  const heatBGL = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX, buffer: { hasDynamicOffset: true } }] });
  const HEAT_SLOTS = 64, heatBuf = device.createBuffer({ size: 256 * HEAT_SLOTS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const heatBG = device.createBindGroup({ layout: heatBGL, entries: [{ binding: 0, resource: { buffer: heatBuf, size: 16 } }] });
  const heatPipe = op => device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [heatBGL] }),
    vertex: { module: heatModule, entryPoint: 'vert' },
    fragment: { module: heatModule, entryPoint: 'frag', targets: [{ format, blend: {
      color: { srcFactor: 'constant', dstFactor: 'one', operation: op },
      alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } } }] },
    primitive: { topology: 'triangle-list' },
  });
  const heatAdd = heatPipe('add'), heatSub = heatPipe('reverse-subtract');

  // 3D surface tiles: own pass with a depth buffer, scissored to the tile (web/surface3d.mjs builds vertices).
  const S3_SLOTS = 16; let s3 = null, s3Buf = null, s3Cap = 0, depthTex = null;
  if (surfaceWGSL) {
    const mod = device.createShaderModule({ code: surfaceWGSL });
    const bgl = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { hasDynamicOffset: true } }] });
    const ubuf = device.createBuffer({ size: 256 * S3_SLOTS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    const buffers = [{ arrayStride: 28, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x4' }] }];
    const pipe = (entry, topology, write, compare) => device.createRenderPipeline({ layout, vertex: { module: mod, entryPoint: 'vs', buffers },
      fragment: { module: mod, entryPoint: entry, targets: [{ format, blend: alphaBlend }] }, primitive: { topology },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: write, depthCompare: compare } });
    s3 = { ubuf, bg: device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: ubuf, size: 80 } }] }), tri: pipe('fs_tri', 'triangle-list', true, 'less'), line: pipe('fs_line', 'line-list', false, 'less-equal') };
  }

  function syncAtlas() {
    if (!atlas.dirty && atlasTex) return;
    atlas.rasterize();
    atlasTex?.destroy();
    atlasTex = device.createTexture({ size: [ATLAS_W, atlas.height], format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
    device.queue.copyExternalImageToTexture({ source: atlas.canvas }, { texture: atlasTex }, [ATLAS_W, atlas.height]);
    sceneBG = device.createBindGroup({ layout: sceneBGL, entries: [
      { binding: 0, resource: { buffer: uniBuf } }, { binding: 1, resource: sampler }, { binding: 2, resource: atlasTex.createView() }] });
  }

  let dpr = 1, pending = null;
  return {
    name: 'WebGPU', gpu: gpuName,
    setDpr(v) { dpr = v; },
    // Test/debug hook: resolves with the next presented frame as RGBA bytes.
    capture() { return new Promise(resolve => { pending = resolve; }); },
    // Width of `str` in CSS px, identical to what draw() will lay out.
    measure(str, sizeCss, font = 'mono', weight = 400) {
      const e = atlas.entry(Math.round(sizeCss * dpr), font, weight); let w = 0;
      for (const ch of str) w += atlas.glyph(e, ch).adv;
      return w / dpr;
    },
    draw({ cmds }, { time, theme }) {
      const W = canvas.width, H = canvas.height;
      let n = 0; const segs = []; let segStart = 0, heatIdx = 0;
      const push = (x, y, w, h, c, mode, t = 0, d = 0, uv = [0, 0, 0, 0], r = 0) => {
        if ((n + 1) * FLOATS > data.length) { const g = new Float32Array(data.length * 2); g.set(data); data = g; }
        data.set([x, y, w, h, c[0], c[1], c[2], c[3] ?? 1, uv[0], uv[1], uv[2], uv[3], mode, t, d, r], n * FLOATS); n++;
      };
      const R = v => Math.round(v * dpr);
      const s3Geo = []; let s3Bytes = 0;
      for (const k of cmds) if (k.op === 'text') atlas.ensure(atlas.entry(Math.round(k.s * dpr), k.f || 'mono', k.w || 400), k.str); // register new glyphs first: layout settles before any uv is taken
      for (const k of cmds) {
        const r = Math.round((k.r || 0) * dpr), box = [R(k.x), R(k.y), R(k.x + k.w) - R(k.x), R(k.y + k.h) - R(k.y)];
        if (k.op === 'fill') push(...box, k.c, 0, 0, 0, undefined, r);
        else if (k.op === 'wall') push(0, 0, W, H, [0, 0, 0, 1], 4, 0, 0, undefined, 0);
        else if (k.op === 'glass') { const m = R(k.m ?? 26); push(R(k.x) - m, R(k.y) - m, box[2] + 2 * m, box[3] + 2 * m, k.c, 5, m, k.k ?? 0.1, undefined, r); }
        else if (k.op === 'stroke') push(...box, k.c, 1, Math.max(1, Math.round(k.t * dpr)), 0, undefined, r);
        else if (k.op === 'dash') push(...box, k.c, 2, Math.max(1, Math.round(k.t * dpr)), k.d * dpr, undefined, r);
        else if (k.op === 'text') {
          const e = atlas.entry(Math.round(k.s * dpr), k.f || 'mono', k.w || 400);
          let x = R(k.x); const y = R(k.y);
          for (const ch of k.str) {
            const g = atlas.glyph(e, ch);
            if (ch !== ' ') push(Math.round(x), y, e.cw, e.ch, k.c, 3, 0, 0, [g.u, g.v, e.cw, e.ch]);
            x += g.adv;
          }
        } else if (k.op === 'scene3d' && s3 && s3Geo.length < S3_SLOTS) {
          const geo = buildSurface({ ...k, aspect: k.w / k.h }), slot = s3Geo.length;
          s3Geo.push({ geo, triOff: s3Bytes, lineOff: s3Bytes + geo.tri.byteLength }); s3Bytes += geo.tri.byteLength + geo.line.byteLength;
          segs.push({ kind: 'inst', first: segStart, count: n - segStart });
          segs.push({ kind: 's3', slot, rect: [R(k.x), R(k.y), R(k.w), R(k.h)] });
          segStart = n;
        } else if (k.op === 'heat' && heatIdx < HEAT_SLOTS) {
          segs.push({ kind: 'inst', first: segStart, count: n - segStart });
          segs.push({ kind: 'heat', slot: heatIdx++, rect: [R(k.x), R(k.y), R(k.w), R(k.h)], activity: k.activity });
          segStart = n;
        }
      }
      segs.push({ kind: 'inst', first: segStart, count: n - segStart });
      syncAtlas();
      // Glyph uv in texels -> normalized now that atlas size is final.
      for (let i = 0; i < n; i++) if (data[i * FLOATS + 12] === 3) {
        data[i * FLOATS + 8] /= ATLAS_W; data[i * FLOATS + 10] /= ATLAS_W;
        data[i * FLOATS + 9] /= atlas.height; data[i * FLOATS + 11] /= atlas.height;
      }
      if (!instBuf || instCap < n) {
        instBuf?.destroy(); instCap = Math.max(1024, n * 2);
        instBuf = device.createBuffer({ size: instCap * FLOATS * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      }
      device.queue.writeBuffer(instBuf, 0, data, 0, n * FLOATS);
      device.queue.writeBuffer(uniBuf, 0, new Float32Array([W, H, time, dpr, theme.wall?.hue ?? 0, theme.wall?.seed ?? 0, 0, 0]));
      for (const s of segs) if (s.kind === 'heat')
        device.queue.writeBuffer(heatBuf, s.slot * 256, new Float32Array([time, theme.name === 'dark' || theme.glass ? 0.55 : 0.4, s.activity, dpr]));

      if (s3Geo.length) {
        if (!s3Buf || s3Cap < s3Bytes) { s3Buf?.destroy(); s3Cap = Math.max(1 << 20, s3Bytes * 2); s3Buf = device.createBuffer({ size: s3Cap, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }); }
        if (!depthTex || depthTex.width !== W || depthTex.height !== H) { depthTex?.destroy(); depthTex = device.createTexture({ size: [W, H], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT }); }
        s3Geo.forEach((g, i) => {
          device.queue.writeBuffer(s3Buf, g.triOff, g.geo.tri); device.queue.writeBuffer(s3Buf, g.lineOff, g.geo.line);
          device.queue.writeBuffer(s3.ubuf, i * 256, new Float32Array([...g.geo.mvp, ...g.geo.light]));
        });
      }
      const enc = device.createCommandEncoder();
      const bg = theme.bg;
      // Capture renders the same frame offscreen, independent of presentation.
      const target = pending ? device.createTexture({ size: [W, H], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
        : context.getCurrentTexture();
      const targetView = target.createView();
      const begin = load => enc.beginRenderPass({ colorAttachments: [{ view: targetView, clearValue: { r: bg[0], g: bg[1], b: bg[2], a: 1 }, loadOp: load ? 'load' : 'clear', storeOp: 'store' }] });
      let pass = begin(false);
      const tint = theme.name === 'dark' || theme.glass ? theme.blue : theme.blue.map((c, i) => i < 3 ? 1 - c : 1);
      for (const s of segs) {
        if (s.kind === 'inst') {
          if (!s.count) continue;
          pass.setViewport(0, 0, W, H, 0, 1); pass.setScissorRect(0, 0, W, H);
          pass.setPipeline(scenePipe); pass.setBindGroup(0, sceneBG); pass.setVertexBuffer(0, instBuf);
          pass.draw(6, s.count, 0, s.first);
        } else if (s.kind === 's3') {
          let [x, y, w, h] = s.rect; x = Math.max(0, x); y = Math.max(0, y); w = Math.min(W - x, w); h = Math.min(H - y, h);
          if (w < 2 || h < 2) continue;
          pass.end();
          const g = s3Geo[s.slot], p3 = enc.beginRenderPass({ colorAttachments: [{ view: targetView, loadOp: 'load', storeOp: 'store' }],
            depthStencilAttachment: { view: depthTex.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' } });
          p3.setViewport(x, y, w, h, 0, 1); p3.setScissorRect(x, y, w, h);
          p3.setBindGroup(0, s3.bg, [s.slot * 256]); p3.setVertexBuffer(0, s3Buf, g.triOff, g.geo.tri.byteLength);
          p3.setPipeline(s3.tri); p3.draw(g.geo.triCount);
          p3.setVertexBuffer(0, s3Buf, g.lineOff, g.geo.line.byteLength); p3.setPipeline(s3.line); p3.draw(g.geo.lineCount);
          p3.end();
          pass = begin(true);
        } else {
          let [x, y, w, h] = s.rect;
          x = Math.max(0, x); y = Math.max(0, y); w = Math.min(W - x, w); h = Math.min(H - y, h);
          if (w < 1 || h < 1) continue;
          pass.setPipeline(theme.name === 'dark' || theme.glass ? heatAdd : heatSub);
          pass.setBindGroup(0, heatBG, [s.slot * 256]);
          pass.setBlendConstant({ r: tint[0], g: tint[1], b: tint[2], a: 1 });
          pass.setViewport(x, y, w, h, 0, 1); pass.setScissorRect(x, y, w, h);
          pass.draw(6);
        }
      }
      pass.end();
      let readback = null;
      if (pending) {
        const bpr = Math.ceil(W * 4 / 256) * 256;
        readback = { done: pending, bpr, tex: target, buf: device.createBuffer({ size: bpr * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }) };
        enc.copyTextureToBuffer({ texture: target }, { buffer: readback.buf, bytesPerRow: bpr }, [W, H]);
        pending = null;
      }
      device.queue.submit([enc.finish()]);
      if (readback) readback.buf.mapAsync(GPUMapMode.READ).then(() => {
        const src = new Uint8Array(readback.buf.getMappedRange()), px = new Uint8ClampedArray(W * H * 4), bgra = format === 'bgra8unorm';
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const i = y * readback.bpr + x * 4, o = (y * W + x) * 4;
          px[o] = src[i + (bgra ? 2 : 0)]; px[o + 1] = src[i + 1]; px[o + 2] = src[i + (bgra ? 0 : 2)]; px[o + 3] = 255;
        }
        readback.buf.unmap(); readback.buf.destroy(); readback.tex.destroy(); readback.done({ width: W, height: H, data: px });
      });
    },
  };
}
