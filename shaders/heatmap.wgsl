// Future native GPU adapter: WGSL material example, NOT used by ANSI host.
// Renderer receives scene nodes plus uniforms; this shader decorates activity
// only and never decides occupancy or semantic status.
struct Uniforms {
  time: f32,
  intensity: f32,
  activity: f32,
  dpr: f32,
}
@group(0) @binding(0) var<uniform> ui: Uniforms;

struct VSOut { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> }

@vertex fn vert(@builtin(vertex_index) idx: u32) -> VSOut {
  let positions = array<vec2<f32>, 6>(
    vec2<f32>(-1.0,-1.0), vec2<f32>(1.0,-1.0), vec2<f32>(-1.0,1.0),
    vec2<f32>(-1.0,1.0), vec2<f32>(1.0,-1.0), vec2<f32>(1.0,1.0));
  var v: VSOut;
  v.position = vec4<f32>(positions[idx],0.0,1.0);
  v.uv = positions[idx]*0.5+vec2<f32>(0.5);
  return v;
}

@fragment fn frag(in: VSOut) -> @location(0) vec4<f32> {
  let uv = in.uv;
  let distance = length(uv - vec2<f32>(0.5));
  let waves = sin(uv.x*18.0 + sin(uv.y*11.0 + ui.time*0.25)*1.3 - ui.time*0.4);
  let field = (0.5+0.5*waves) * exp(-distance*2.6);
  let strength = clamp(ui.activity*ui.intensity*field,0.0,1.0);
  // Monochrome by design. Palette belongs to the renderer's theme tokens.
  return vec4<f32>(vec3<f32>(strength),1.0);
}
