// Canvas2D fallback for the same display list, for browsers or sessions
// without WebGPU (e.g. disabled GPU, older Chrome). Same output, no shaders:
// the activity material degrades to a slow soft pulse.
import { FONTS } from './fonts.mjs';
import { buildSurface, s3Project } from './surface3d.mjs';
const css = c => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3] ?? 1})`;

export function createCanvasRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  let dpr = 1; const cache = new Map();
  const font = (s, f = 'mono', w = 400) => `${w} ${Math.round(s * dpr) / dpr}px ${FONTS[f]}`;
  const rr = (x, y, w, h, r) => { ctx.beginPath(); if (r > 0 && ctx.roundRect) ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2)); else ctx.rect(x, y, w, h); };
  return {
    name: 'Canvas2D', gpu: 'none',
    setDpr(v) { dpr = v; cache.clear(); },
    measure(str, s, f = 'mono', w = 400) {
      ctx.font = font(s, f, w);
      const key = ctx.font + '|' + str;
      if (!cache.has(key)) { if (cache.size > 4000) cache.clear(); cache.set(key, ctx.measureText(str).width); }
      return cache.get(key);
    },
    draw({ cmds }, { time, theme }) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.textBaseline = 'top';
      for (const k of cmds) {
        if (k.op === 'wall') { // approximation: the shader's blobs as radial gradients
          const W = canvas.width / dpr, H = canvas.height / dpr, t = time * 0.035, hue = theme.wall?.hue ?? 0;
          ctx.fillStyle = '#090b22'; ctx.fillRect(0, 0, W, H);
          [[0.2, 0.3, '#5733c7', 0.9], [0.78, 0.25, '#0f94b3', 0.85], [0.45, 0.85, '#ed577a', 0.6], [0.92, 0.85, '#ffa852', 0.4]].forEach(([fx, fy, col, a], i) => {
            const cx = (fx + 0.05 * Math.sin(t * 5 + i)) * W, cy = (fy + 0.05 * Math.cos(t * 4 + i * 2)) * H, g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.55);
            g.addColorStop(0, col + Math.round(a * 255).toString(16).padStart(2, '0')); g.addColorStop(1, col + '00'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
          });
        } else if (k.op === 'scene3d') { // painter's algorithm over the same geometry the GPU pass uses
          const g = buildSurface({ ...k, aspect: k.w / k.h }), P = (i, tri) => s3Project(g.mvp, tri[i * 7], tri[i * 7 + 1], tri[i * 7 + 2]), polys = [];
          for (let i = 0; i < g.triCount; i += 3) { const a = P(i, g.tri), b = P(i + 1, g.tri), c = P(i + 2, g.tri); if (a && b && c) polys.push({ i, a, b, c, d: (a[2] + b[2] + c[2]) / 3 }); }
          polys.sort((p, q) => q.d - p.d);
          ctx.save(); ctx.beginPath(); ctx.rect(k.x, k.y, k.w, k.h); ctx.clip();
          const X = p => k.x + (p[0] * 0.5 + 0.5) * k.w, Y = p => k.y + (0.5 - p[1] * 0.5) * k.h;
          for (const p of polys) {
            const sh = 0.55 + 0.45 * Math.min(1, Math.abs((p.b[0] - p.a[0]) * (p.c[1] - p.a[1]) - (p.b[1] - p.a[1]) * (p.c[0] - p.a[0])) * 40), o = p.i * 7 + 3;
            ctx.fillStyle = css([g.tri[o] * sh, g.tri[o + 1] * sh, g.tri[o + 2] * sh, 0.96]); ctx.beginPath(); ctx.moveTo(X(p.a), Y(p.a)); ctx.lineTo(X(p.b), Y(p.b)); ctx.lineTo(X(p.c), Y(p.c)); ctx.fill();
          }
          ctx.lineWidth = 1; for (let i = 0; i < g.lineCount; i += 2) { const a = P(i, g.line), b = P(i + 1, g.line); if (!a || !b) continue; ctx.strokeStyle = css([1, 1, 1, g.line[i * 7 + 6]]); ctx.beginPath(); ctx.moveTo(X(a), Y(a)); ctx.lineTo(X(b), Y(b)); ctx.stroke(); }
          ctx.restore();
        } else if (k.op === 'glass') {
          ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 24; ctx.shadowOffsetY = 8;
          ctx.fillStyle = css([0.18 + k.c[0] * 0.2, 0.19 + k.c[1] * 0.2, 0.28 + k.c[2] * 0.2, 0.62 * (k.c[3] ?? 1)]); rr(k.x, k.y, k.w, k.h, k.r || 0); ctx.fill(); ctx.restore();
          const gr = ctx.createLinearGradient(k.x, k.y, k.x + k.w * 0.4, k.y + k.h); gr.addColorStop(0, 'rgba(255,255,255,0.55)'); gr.addColorStop(0.35, 'rgba(255,255,255,0.12)'); gr.addColorStop(1, 'rgba(255,255,255,0.28)');
          ctx.strokeStyle = gr; ctx.lineWidth = 1.5; rr(k.x + 0.75, k.y + 0.75, k.w - 1.5, k.h - 1.5, Math.max(0, (k.r || 0) - 0.75)); ctx.stroke();
        } else if (k.op === 'fill') { ctx.fillStyle = css(k.c); rr(k.x, k.y, k.w, k.h, k.r || 0); ctx.fill(); }
        else if (k.op === 'stroke' || k.op === 'dash') {
          ctx.strokeStyle = css(k.c); ctx.lineWidth = k.t;
          ctx.setLineDash(k.op === 'dash' ? [k.d * 0.55, k.d * 0.45] : []);
          rr(k.x + k.t / 2, k.y + k.t / 2, k.w - k.t, k.h - k.t, Math.max(0, (k.r || 0) - k.t / 2)); ctx.stroke();
        } else if (k.op === 'text') {
          ctx.font = font(k.s, k.f, k.w); ctx.fillStyle = css(k.c);
          ctx.fillText(k.str, k.x, k.y + Math.round(k.s * 0.12) + 1);
        } else if (k.op === 'heat') {
          const g = ctx.createRadialGradient(k.x + k.w / 2, k.y + k.h / 2, 0, k.x + k.w / 2, k.y + k.h / 2, Math.max(k.w, k.h) * 0.6);
          const a = 0.10 + 0.06 * Math.sin(time * 0.8);
          g.addColorStop(0, css([...theme.blue.slice(0, 3), a])); g.addColorStop(1, css([...theme.blue.slice(0, 3), 0]));
          ctx.fillStyle = g; ctx.fillRect(k.x, k.y, k.w, k.h);
        }
      }
      ctx.setLineDash([]);
    },
  };
}
