// Font stacks shared by every renderer. Titles use sans, data and terminals use mono.
// Code points the glyph atlas draws (Latin with accents incl. Finnish/Nordic, Greek, Cyrillic, punctuation, arrows, maths, box drawing,
// blocks, geometric shapes, misc symbols, dingbats, currency, sub/superscripts). Everything else (CJK, emoji) is shown as '?' until wide cells exist.
export const GLYPH_RANGES = [[0x20, 0x7e], [0xa0, 0x24f], [0x370, 0x3ff], [0x400, 0x4ff], [0x1e00, 0x1eff], [0x2000, 0x22ff], [0x2300, 0x23ff], [0x2500, 0x27bf]];
export const glyphOk = cp => { for (const r of GLYPH_RANGES) if (cp >= r[0] && cp <= r[1]) return true; return false; };
export const drawable = str => { let o = ''; for (const ch of String(str)) o += glyphOk(ch.codePointAt(0)) ? ch : '?'; return o; };
export const FONTS = {
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace',
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", "DejaVu Sans", Arial, sans-serif',
};
