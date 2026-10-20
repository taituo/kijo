// Canvas2D fallback for the same display list, for browsers or sessions
// without WebGPU (e.g. disabled GPU, older Chrome). Same output, no shaders:
// the activity material degrades to a slow soft pulse.
import { FONTS } from './fonts.mjs';
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
        if (k.op === 'fill') { ctx.fillStyle = css(k.c); rr(k.x, k.y, k.w, k.h, k.r || 0); ctx.fill(); }
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
