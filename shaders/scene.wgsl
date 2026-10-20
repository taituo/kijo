// Kijo scene material: instanced rectangles for fills, wireframe strokes,
// dashed ghost outlines and glyphs from a monospace atlas. Executed by the
// Chrome/WebGPU host (web/gpu.mjs). Semantics come from WASM scene nodes;
// this shader only draws what the display list asks for.
struct Uniforms { res: vec2<f32>, time: f32, dpr: f32 }
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var atlas: texture_2d<f32>;

struct Inst {
  @location(0) rect: vec4<f32>,   // x, y, w, h in device pixels
  @location(1) color: vec4<f32>,
  @location(2) uv: vec4<f32>,     // atlas u, v, du, dv (glyph mode)
  @location(3) p: vec4<f32>,      // mode, thickness, dash period, unused
}
struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) local: vec2<f32>,
  @location(1) @interpolate(flat) size: vec2<f32>,
  @location(2) color: vec4<f32>,
  @location(3) uv: vec2<f32>,
  @location(4) @interpolate(flat) p: vec4<f32>,
}

@vertex fn vs(@builtin(vertex_index) vi: u32, i: Inst) -> VOut {
  let corners = array<vec2<f32>, 6>(vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
                                    vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0));
  let c = corners[vi];
  let px = i.rect.xy + c * i.rect.zw;
  var o: VOut;
  o.pos = vec4<f32>(px.x / u.res.x * 2.0 - 1.0, 1.0 - px.y / u.res.y * 2.0, 0.0, 1.0);
  o.local = c * i.rect.zw;
  o.size = i.rect.zw;
  o.color = i.color;
  o.uv = i.uv.xy + c * i.uv.zw;
  o.p = i.p;
  return o;
}

fn sd_round_box(p: vec2<f32>, hs: vec2<f32>, r: f32) -> f32 {
  let rr = min(r, min(hs.x, hs.y));
  let q = abs(p) - hs + vec2<f32>(rr);
  return length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - rr;
}

@fragment fn fs(v: VOut) -> @location(0) vec4<f32> {
  let mode = u32(v.p.x + 0.5);
  if (mode == 3u) {
    let a = textureSampleLevel(atlas, samp, v.uv, 0.0).a;
    return vec4<f32>(v.color.rgb, v.color.a * a);
  }
  // p = mode, thickness, dash period, corner radius (device px). Radius 0 stays pixel-crisp.
  let hs = v.size * 0.5;
  let d = sd_round_box(v.local - hs, hs, v.p.w);
  var cover = clamp(0.5 - d, 0.0, 1.0);
  if (mode == 1u || mode == 2u) {
    let t = v.p.y;
    cover = clamp(0.5 - (abs(d + t * 0.5) - t * 0.5), 0.0, 1.0);
    if (mode == 2u) {
      // Dash along the edge we are on: x for top/bottom, y for left/right.
      let dx = min(v.local.x, v.size.x - v.local.x);
      let dy = min(v.local.y, v.size.y - v.local.y);
      let along = select(v.local.y, v.local.x, dy <= dx);
      if (fract(along / v.p.z) > 0.55) { cover = 0.0; }
    }
  }
  if (cover <= 0.0) { discard; }
  return vec4<f32>(v.color.rgb, v.color.a * cover);
}
