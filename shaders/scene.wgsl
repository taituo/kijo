// Kijo scene material: instanced rectangles for fills, wireframe strokes,
// dashed ghost outlines and glyphs from a monospace atlas. Executed by the
// Chrome/WebGPU host (web/gpu.mjs). Semantics come from WASM scene nodes;
// this shader only draws what the display list asks for.
struct Uniforms { res: vec2<f32>, time: f32, dpr: f32, wp: vec4<f32> } // wp: wallpaper hue, seed
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

fn hash21(p: vec2<f32>) -> f32 {
  var q = fract(p * vec2<f32>(123.34, 456.21));
  q += dot(q, q + 45.32);
  return fract(q.x * q.y);
}

// Procedural wallpaper: four soft colour blobs on a domain-warped field, blended by weight.
// Deterministic in (position, time, seed); hue rotation gives other palettes from the same code.
fn wall(px: vec2<f32>) -> vec3<f32> {
  let asp = u.res.x / u.res.y;
  var p = (px / u.res - vec2<f32>(0.5)) * vec2<f32>(asp, 1.0);
  let t = u.time * 0.035 + u.wp.y * 7.31;
  p += 0.16 * vec2<f32>(sin(p.y * 2.3 + t * 3.0), cos(p.x * 2.1 - t * 2.4));
  p += 0.07 * vec2<f32>(sin(p.y * 5.1 - t * 4.0 + u.wp.y), cos(p.x * 4.7 + t * 3.3));
  let s = u.wp.y;
  let b1 = vec2<f32>(-0.42 * asp + 0.12 * sin(t * 5.0 + s), -0.22 + 0.10 * cos(t * 4.0));
  let b2 = vec2<f32>(0.30 * asp + 0.10 * cos(t * 4.5), -0.30 + 0.12 * sin(t * 3.0 + s * 2.0));
  let b3 = vec2<f32>(-0.10 * asp + 0.14 * sin(t * 3.5 + 1.0), 0.34 + 0.08 * cos(t * 5.5));
  let b4 = vec2<f32>(0.48 * asp + 0.08 * sin(t * 6.0), 0.30 + 0.10 * cos(t * 2.5 + s));
  let w1 = exp(-dot(p - b1, p - b1) * 2.4);
  let w2 = exp(-dot(p - b2, p - b2) * 2.8);
  let w3 = exp(-dot(p - b3, p - b3) * 3.4);
  let w4 = exp(-dot(p - b4, p - b4) * 5.0);
  let c0 = vec3<f32>(0.035, 0.045, 0.135);   // deep ink blue
  let c1 = vec3<f32>(0.34, 0.20, 0.78);      // violet
  let c2 = vec3<f32>(0.06, 0.58, 0.70);      // teal
  let c3 = vec3<f32>(0.93, 0.34, 0.48);      // coral pink
  let c4 = vec3<f32>(1.00, 0.66, 0.32);      // amber, small
  var col = (c0 * 0.30 + c1 * w1 + c2 * w2 + c3 * w3 * 0.8 + c4 * w4 * 0.5) / (0.30 + w1 + w2 + w3 * 0.8 + w4 * 0.5);
  // hue rotation about the grey axis
  let h = u.wp.x; let k = vec3<f32>(0.57735);
  col = col * cos(h) + cross(k, col) * sin(h) + k * dot(k, col) * (1.0 - cos(h));
  // gentle vignette keeps edges calm and text contrast predictable
  let vg = 1.0 - 0.38 * smoothstep(0.35, 1.05, length((px / u.res - vec2<f32>(0.5)) * vec2<f32>(1.0, 0.9)) * 1.6);
  return clamp(col * vg * 1.02, vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment fn fs(v: VOut) -> @location(0) vec4<f32> {
  let mode = u32(v.p.x + 0.5);
  if (mode == 4u) {
    return vec4<f32>(wall(v.pos.xy) + vec3<f32>((hash21(v.pos.xy) - 0.5) / 128.0), 1.0);
  }
  if (mode == 5u) {
    // Glass: p.y = outer margin (shadow room), p.z = tint strength, p.w = corner radius, color = tint + opacity.
    let m = v.p.y;
    let hs = v.size * 0.5 - vec2<f32>(m);
    let q = v.local - v.size * 0.5;
    let d = sd_round_box(q, hs, v.p.w);
    let cover = clamp(0.5 - d, 0.0, 1.0);
    let sh = sd_round_box(q - vec2<f32>(0.0, m * 0.28), hs, v.p.w);
    let shadow = 0.34 * exp(-max(sh, 0.0) / (m * 0.42)) * (1.0 - cover);
    if (d > 0.5 && shadow < 0.004) { discard; }
    if (cover <= 0.0) { return vec4<f32>(0.0, 0.0, 0.0, shadow * v.color.a); }
    let dp = max(u.dpr, 1.0);
    let bevel = max(2.0, min(16.0 * dp, min(hs.x, hs.y) * 0.5));
    let e = clamp(-d / bevel, 0.0, 1.0);
    let g = vec2<f32>(sd_round_box(q + vec2<f32>(1.0, 0.0), hs, v.p.w) - sd_round_box(q - vec2<f32>(1.0, 0.0), hs, v.p.w),
                      sd_round_box(q + vec2<f32>(0.0, 1.0), hs, v.p.w) - sd_round_box(q - vec2<f32>(0.0, 1.0), hs, v.p.w));
    let n = g / max(length(g), 1e-4);
    // Lens: the rim bends the backdrop, the interior stays calm. Five taps = cheap frosted blur.
    let off = n * pow(1.0 - e, 2.0) * 30.0 * dp;
    let px = v.pos.xy + off;
    let r = 9.0 * dp;
    var c = (wall(px) * 2.0 + wall(px + vec2<f32>(r, 0.0)) + wall(px - vec2<f32>(r, 0.0)) + wall(px + vec2<f32>(0.0, r)) + wall(px - vec2<f32>(0.0, r))) / 6.0;
    let l = dot(c, vec3<f32>(0.299, 0.587, 0.114));
    c = mix(vec3<f32>(l), c, 1.28) * 0.80;                 // slight saturation lift, darker base for legibility
    c = mix(c, v.color.rgb, v.p.z);                         // tint (white lift, or status colour)
    let L = normalize(vec2<f32>(-0.55, -0.83));
    let rim = 1.0 - smoothstep(0.0, 2.4 * dp, -d);
    let hl = rim * (0.20 + 0.80 * pow(max(dot(n, L), 0.0), 2.0) + 0.30 * pow(max(dot(n, -L), 0.0), 2.0));
    c += vec3<f32>(hl * 0.75);
    c += vec3<f32>(0.05 * (1.0 - smoothstep(0.0, 14.0 * dp, -d)));              // inner glow
    c += vec3<f32>(0.05 * (1.0 - clamp((q.y + hs.y) / max(hs.y * 1.4, 1.0), 0.0, 1.0))); // top sheen
    c += vec3<f32>((hash21(v.pos.xy + 7.0) - 0.5) / 100.0);
    let a = mix(shadow * v.color.a, v.color.a, cover);
    return vec4<f32>(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)), a);
  }
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
