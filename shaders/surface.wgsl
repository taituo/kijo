// 3D surface pass (web/surface3d.mjs builds the vertices). Flat-shaded from screen-space derivatives,
// so no normals are stored. Runs in its own render pass with a depth buffer, scissored to the tile.
struct U { mvp: mat4x4<f32>, light: vec4<f32> }
@group(0) @binding(0) var<uniform> u: U;
struct VIn { @location(0) pos: vec3<f32>, @location(1) col: vec4<f32> }
struct VOut { @builtin(position) p: vec4<f32>, @location(0) col: vec4<f32>, @location(1) w: vec3<f32> }
@vertex fn vs(v: VIn) -> VOut {
  var o: VOut; o.p = u.mvp * vec4<f32>(v.pos, 1.0); o.col = v.col; o.w = v.pos; return o;
}
@fragment fn fs_tri(v: VOut) -> @location(0) vec4<f32> {
  let n = normalize(cross(dpdx(v.w), dpdy(v.w)));
  let l = normalize(u.light.xyz);
  let d = abs(dot(n, l)) * 0.62 + 0.38;
  return vec4<f32>(v.col.rgb * d, v.col.a);
}
@fragment fn fs_line(v: VOut) -> @location(0) vec4<f32> { return v.col; }
