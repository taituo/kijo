//! Native renderer spike: the same core, the same `shaders/scene.wgsl` (the file the browser compiles),
//! drawn headless through wgpu into a PNG. No browser, no DOM, no WebGPU-in-a-tab.
//! Scope, deliberately: rectangles, strokes and dashes (shader modes 0-2). Text needs the glyph atlas
//! (web/fonts.mjs), wallpaper/glass/3D need their own ops; none of that is in the spike.
use crate::core::{Core, NODE_SIZE};
use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;

const SCALE: f32 = 6000.0;
const SHADER: &str = include_str!("../../shaders/scene.wgsl");

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Inst { rect: [f32; 4], color: [f32; 4], uv: [f32; 4], p: [f32; 4] }

fn hex(h: u32) -> [f32; 4] { [((h >> 16) & 255) as f32 / 255.0, ((h >> 8) & 255) as f32 / 255.0, (h & 255) as f32 / 255.0, 1.0] }
// THEMES.dark from web/displaylist.mjs
const BG: u32 = 0x0e0e0d; const BAR: u32 = 0x141413; const PANEL: u32 = 0x171715; const INK: u32 = 0xebe8e2; const DIM: u32 = 0x8a8780;
const FAINT: u32 = 0x2a2a27; const LINE: u32 = 0x46453f; const RED: u32 = 0xe5513c; const YELLOW: u32 = 0xf2c21b; const BLUE: u32 = 0x4b7bff;

struct Draw(Vec<Inst>);
impl Draw {
    fn fill(&mut self, x: f32, y: f32, w: f32, h: f32, c: [f32; 4], r: f32) { self.0.push(Inst { rect: [x.round(), y.round(), w.round(), h.round()], color: c, uv: [0.0; 4], p: [0.0, 0.0, 0.0, r] }); }
    fn stroke(&mut self, x: f32, y: f32, w: f32, h: f32, c: [f32; 4], t: f32, r: f32) { self.0.push(Inst { rect: [x.round(), y.round(), w.round(), h.round()], color: c, uv: [0.0; 4], p: [1.0, t, 0.0, r] }); }
    fn dash(&mut self, x: f32, y: f32, w: f32, h: f32, c: [f32; 4], t: f32, d: f32, r: f32) { self.0.push(Inst { rect: [x.round(), y.round(), w.round(), h.round()], color: c, uv: [0.0; 4], p: [2.0, t, d, r] }); }
}

pub fn render_png(core: &mut Core, view: i32, w: u32, h: u32, out: &str) -> Result<String, String> {
    // ---- scene -> instances (the display-list step, reduced to rectangles)
    let nodes = core.scene(view);
    let (wf, hf) = (w as f32, h as f32);
    let mut d = Draw(Vec::new());
    d.fill(0.0, 0.0, wf, hf, hex(BG), 0.0);
    let bar = 38.0; d.fill(0.0, 0.0, wf, bar, hex(BAR), 0.0); d.fill(0.0, bar - 1.0, wf, 1.0, hex(FAINT), 0.0);
    let pad = (wf * 0.012).clamp(8.0, 20.0);
    let area = (pad, bar + pad * 0.7, wf - pad * 2.0, hf - 28.0 - bar - pad * 1.2);
    d.fill(0.0, hf - 28.0, wf, 28.0, hex(BAR), 0.0); d.fill(0.0, hf - 28.0, wf, 1.0, hex(FAINT), 0.0);
    let focus = view == 0;
    let status_color = |s: i32| match s { 1 => hex(BLUE), 2 => hex(YELLOW), 3 => hex(RED), 4 => hex(INK), _ => hex(DIM) };
    let mut count = 0;
    for n in nodes.chunks_exact(NODE_SIZE) {
        let (kind, _id, nx, ny, nw, nh, status, _o, _g, flags) = (n[0], n[1], n[2] as f32, n[3] as f32, n[4] as f32, n[5] as f32, n[6], n[7], n[8], n[9]);
        let gap = if focus { 10.0 } else { 4.0 };
        let (x, y, ww, hh) = (area.0 + nx / SCALE * area.2 + gap / 2.0, area.1 + ny / SCALE * area.3 + gap / 2.0, nw / SCALE * area.2 - gap, nh / SCALE * area.3 - gap);
        if ww < 4.0 || hh < 4.0 { continue; }
        let rad = if focus { 6.0 } else { 4.0 };
        let selected = flags & 1 != 0;
        match kind {
            2 => { // TILE
                let solid = !focus && status >= 2;
                let fill = if solid { status_color(status) } else if !focus && status == 1 { hex(0x1a2234) } else { hex(PANEL) };
                d.fill(x, y, ww, hh, fill, rad);
                d.stroke(x, y, ww, hh, if focus || status < 2 { hex(LINE) } else { fill }, 1.0, rad);
                if focus { // header badge in the status colour, as in the browser host
                    d.fill(x + 14.0, y + 14.0, 20.0, 20.0, if status == 0 { hex(FAINT) } else { status_color(status) }, 3.0);
                    d.fill(x + ww - 22.0, y + 22.0, 6.0, 6.0, status_color(status), 0.0);
                }
                count += 1;
            }
            3 => d.dash(x, y, ww, hh, hex(LINE), 1.0, if focus { 10.0 } else { 6.0 }, rad), // GHOST
            1 => d.stroke(x, y, ww, hh, hex(FAINT), 1.0, rad),                                // SLOT
            6 => { d.fill(x, y, ww, hh, hex(PANEL), rad); d.stroke(x, y, ww, hh, hex(LINE), 1.0, rad); }  // WORKSPACE card
            _ => {}
        }
        if selected && kind != 4 { d.stroke(x - 3.0, y - 3.0, ww + 6.0, hh + 6.0, hex(INK), 2.0, rad + 3.0); }
    }

    // ---- wgpu, headless
    let instance = wgpu::Instance::default();
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, force_fallback_adapter: false, compatible_surface: None }))
        .map_err(|e| format!("no GPU adapter (install a Vulkan driver, e.g. mesa-vulkan-drivers): {e}"))?;
    let info = adapter.get_info();
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).map_err(|e| e.to_string())?;
    let format = wgpu::TextureFormat::Rgba8Unorm;
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("scene.wgsl"), source: wgpu::ShaderSource::Wgsl(SHADER.into()) });

    let uni: [f32; 8] = [wf, hf, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0];
    let ubuf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: None, contents: bytemuck::cast_slice(&uni), usage: wgpu::BufferUsages::UNIFORM });
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor::default());
    let atlas = device.create_texture_with_data(&queue, &wgpu::TextureDescriptor { label: Some("atlas (1x1 white; glyphs not in the spike)"), size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format, usage: wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[] }, wgpu::util::TextureDataOrder::LayerMajor, &[255, 255, 255, 255]);
    let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: None, entries: &[
        wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::VERTEX_FRAGMENT, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None },
        wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
        wgpu::BindGroupLayoutEntry { binding: 2, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }, count: None },
    ] });
    let bg = device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &bgl, entries: &[
        wgpu::BindGroupEntry { binding: 0, resource: ubuf.as_entire_binding() },
        wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&sampler) },
        wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&atlas.create_view(&Default::default())) },
    ] });
    let attrs: Vec<wgpu::VertexAttribute> = (0..4).map(|i| wgpu::VertexAttribute { shader_location: i, offset: (i * 16) as u64, format: wgpu::VertexFormat::Float32x4 }).collect();
    let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[&bgl], push_constant_ranges: &[] });
    let blend = wgpu::BlendState { color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::SrcAlpha, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add }, alpha: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add } };
    let pipe = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: None, layout: Some(&pl),
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[wgpu::VertexBufferLayout { array_stride: 64, step_mode: wgpu::VertexStepMode::Instance, attributes: &attrs }] },
        fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs"), compilation_options: Default::default(), targets: &[Some(wgpu::ColorTargetState { format, blend: Some(blend), write_mask: wgpu::ColorWrites::ALL })] }),
        primitive: wgpu::PrimitiveState::default(), depth_stencil: None, multisample: wgpu::MultisampleState::default(), multiview: None, cache: None,
    });

    let target = device.create_texture(&wgpu::TextureDescriptor { label: None, size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format, usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC, view_formats: &[] });
    let tview = target.create_view(&Default::default());
    let ibuf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: None, contents: bytemuck::cast_slice(&d.0), usage: wgpu::BufferUsages::VERTEX });
    let bpr = (w * 4 + 255) / 256 * 256;
    let readback = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: (bpr * h) as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
    let mut enc = device.create_command_encoder(&Default::default());
    {
        let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor { label: None, color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &tview, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store } })], depth_stencil_attachment: None, timestamp_writes: None, occlusion_query_set: None });
        pass.set_pipeline(&pipe); pass.set_bind_group(0, &bg, &[]); pass.set_vertex_buffer(0, ibuf.slice(..)); pass.draw(0..6, 0..d.0.len() as u32);
    }
    enc.copy_texture_to_buffer(wgpu::TexelCopyTextureInfo { texture: &target, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All }, wgpu::TexelCopyBufferInfo { buffer: &readback, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(bpr), rows_per_image: Some(h) } }, wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 });
    let t0 = std::time::Instant::now();
    queue.submit([enc.finish()]);
    let slice = readback.slice(..); slice.map_async(wgpu::MapMode::Read, |r| r.expect("map"));
    device.poll(wgpu::PollType::wait_indefinitely()).map_err(|e| format!("{e:?}"))?;
    let gpu_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let data = slice.get_mapped_range();
    let mut rgba = Vec::with_capacity((w * h * 4) as usize);
    for row in 0..h as usize { rgba.extend_from_slice(&data[row * bpr as usize..row * bpr as usize + (w * 4) as usize]); }
    drop(data); readback.unmap();
    let file = std::fs::File::create(out).map_err(|e| e.to_string())?;
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), w, h); enc.set_color(png::ColorType::Rgba); enc.set_depth(png::BitDepth::Eight);
    enc.write_header().map_err(|e| e.to_string())?.write_image_data(&rgba).map_err(|e| e.to_string())?;
    Ok(format!("{} ({:?}, {:?}) | view {} | {} nodes, {} tiles, {} instances | submit+readback {:.1} ms -> {}", info.name, info.backend, info.device_type, view, nodes.len() / NODE_SIZE, count, d.0.len(), gpu_ms, out))
}
