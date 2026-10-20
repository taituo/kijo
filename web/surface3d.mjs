// 3D surface geometry, shared by the WebGPU pass and the Canvas2D fallback. Pure functions, no GPU.
// A surface is a height field: rows = series, columns = time, height = normalised value.
// Geometry and camera live here; the renderer only uploads vertices and draws them.
const s3mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, 1];

export function s3Mul(a, b) { // column-major 4x4: a * b
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; }
  return o;
}
export function s3Camera(yaw, pitch, dist, aspect) {
  const tx = 0, ty = 0.26, tz = 0, cp = Math.cos(pitch);
  const ex = tx + dist * cp * Math.sin(yaw), ey = ty + dist * Math.sin(pitch), ez = tz + dist * cp * Math.cos(yaw);
  let fx = tx - ex, fy = ty - ey, fz = tz - ez; const fl = Math.hypot(fx, fy, fz); fx /= fl; fy /= fl; fz /= fl;
  let sx = fy * 0 - fz * 1, sy = fz * 0 - fx * 0, sz = fx * 1 - fy * 0; // f x up(0,1,0)
  const sl = Math.hypot(sx, sy, sz) || 1; sx /= sl; sy /= sl; sz /= sl;
  const ux = sy * fz - sz * fy, uy = sz * fx - sx * fz, uz = sx * fy - sy * fx;
  const view = new Float32Array([sx, ux, -fx, 0, sy, uy, -fy, 0, sz, uz, -fz, 0, -(sx * ex + sy * ey + sz * ez), -(ux * ex + uy * ey + uz * ez), fx * ex + fy * ey + fz * ez, 1]);
  const f = 1 / Math.tan(0.33), n = 0.1, fa = 30, A = Math.max(0.2, aspect);
  const proj = new Float32Array([f / A, 0, 0, 0, 0, f, 0, 0, 0, 0, fa / (n - fa), -1, 0, 0, (fa * n) / (n - fa), 0]); // clip z in [0,1]
  return s3Mul(proj, view);
}

// op: { rows, cols, vals (rows*cols, 0..1), yaw, pitch, dist, aspect, ramp: [lo, mid, hi] }
// returns { tri: Float32Array (x y z r g b a)*n, line: same, mvp, light, triCount, lineCount }
export function buildSurface(op) {
  const cols = Math.max(2, op.cols | 0); let rows = Math.max(1, op.rows | 0), vals = op.vals;
  if (rows === 1) { const v2 = new Float32Array(cols * 2); v2.set(vals.subarray(0, cols), 0); v2.set(vals.subarray(0, cols), cols); vals = v2; rows = 2; } // a single series is a ribbon
  const SX = 1.0, SZ = Math.min(0.95, 0.16 + rows * 0.07), H = 0.78, [lo, mid, hi] = op.ramp;
  const X = i => (i / (cols - 1) - 0.5) * 2 * SX, Z = j => (j / (rows - 1) - 0.5) * 2 * SZ;
  const Y = (i, j) => Math.min(1, Math.max(0, vals[j * cols + i] || 0)) * H;
  const col = v => (v < 0.8 ? s3mix(lo, mid, v / 0.8) : s3mix(mid, hi, (v - 0.8) / 0.2));
  const tri = new Float32Array((rows - 1) * (cols - 1) * 6 * 7); let t = 0;
  const vert = (i, j) => { const v = vals[j * cols + i] || 0, c = col(Math.min(1, Math.max(0, v))); tri.set([X(i), Y(i, j), Z(j), c[0], c[1], c[2], 0.96], t); t += 7; };
  for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) { vert(i, j); vert(i + 1, j); vert(i, j + 1); vert(i + 1, j); vert(i + 1, j + 1); vert(i, j + 1); }
  const lines = []; const seg = (a, b, c) => lines.push(a[0], a[1], a[2], c[0], c[1], c[2], c[3], b[0], b[1], b[2], c[0], c[1], c[2], c[3]);
  const wire = [1, 1, 1, 0.34], grid = [1, 1, 1, 0.13], frame = [1, 1, 1, 0.45];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols - 1; i++) seg([X(i), Y(i, j) + 0.004, Z(j)], [X(i + 1), Y(i + 1, j) + 0.004, Z(j)], wire);
  for (let i = 0; i < cols; i += 4) for (let j = 0; j < rows - 1; j++) seg([X(i), Y(i, j) + 0.004, Z(j)], [X(i), Y(i, j + 1) + 0.004, Z(j + 1)], grid.map((v, k) => (k === 3 ? 0.2 : v)));
  for (let k = 0; k <= 4; k++) { const x = -SX + (2 * SX * k) / 4; seg([x, 0, -SZ], [x, 0, SZ], grid); }
  for (let j = 0; j < rows; j++) seg([-SX, 0, Z(j)], [SX, 0, Z(j)], grid);
  const c4 = [[-SX, 0, -SZ], [SX, 0, -SZ], [SX, 0, SZ], [-SX, 0, SZ]];
  for (let k = 0; k < 4; k++) seg(c4[k], c4[(k + 1) % 4], frame);
  for (const [x, z] of [[-SX, -SZ], [SX, -SZ]]) seg([x, 0, z], [x, H, z], grid); // back posts: the 0..1 scale
  const line = new Float32Array(lines);
  return { tri, line, triCount: t / 7, lineCount: line.length / 7, mvp: s3Camera(op.yaw ?? 0.6, op.pitch ?? 0.5, op.dist ?? 2.7, op.aspect ?? 1.6), light: [-0.4, 0.9, 0.5, 0] };
}

// Project a world point with an mvp; returns [x, y, w] in NDC (y up) or null when behind the camera.
export function s3Project(m, x, y, z) {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15]; if (w <= 0.01) return null;
  return [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w, w];
}
