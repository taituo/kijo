// A small VT100/xterm-style terminal emulator: enough for bash, readline, ls/grep colours, htop-class
// full-screen programs, vim-class alt screen. Pure (no DOM, no Node), so it runs in the browser host
// and in tests. It does not run anything: it turns a byte stream into a cell grid.
//
// Cell: ch (string), fg/bg (-1 default, 0..255 palette, >=256: 256 + rgb24), fl (bit flags).
// OSC 7501 (Kijo status, defined here): ESC ] 7501 ; state=<idle|working|blocked|error|done>
//   [; kind=<permission|question|auth>] [; progress=<0-100>] BEL   -> onStatus({state, kind, progress})
export const FL = { BOLD: 1, DIM: 2, ITALIC: 4, UNDER: 8, INVERSE: 16 };
const STATES = { idle: 0, working: 1, blocked: 2, error: 3, done: 4, complete: 4 }, KINDS = { permission: 1, question: 2, auth: 3 };

const blank = (fg = -1, bg = -1) => ({ ch: ' ', fg, bg, fl: 0 });

export class VT {
  constructor({ cols = 80, rows = 24, scrollback = 500, onReply, onStatus, onTitle } = {}) {
    this.cols = cols; this.rows = rows; this.maxBack = scrollback; this.onReply = onReply; this.onStatus = onStatus; this.onTitle = onTitle;
    this.main = this.grid(); this.altGrid = null; this.g = this.main; this.back = [];
    this.x = 0; this.y = 0; this.pend = false; this.saved = { x: 0, y: 0 }; this.top = 0; this.bot = rows - 1;
    this.fg = -1; this.bg = -1; this.fl = 0; this.cursorVisible = true; this.appCursor = false; this.bracketed = false; this.mouse = 0; this.mouseSgr = false; this.altScroll = false; this.wrap = true;
    this.title = ''; this.state = 'g'; this.buf = ''; this.version = 0; this.dec = new TextDecoder();
  }
  grid() { return Array.from({ length: this.rows }, () => Array.from({ length: this.cols }, () => blank())); }
  row() { return Array.from({ length: this.cols }, () => blank(-1, this.bg)); }

  resize(cols, rows) {
    cols = Math.max(2, Math.min(500, cols | 0)); rows = Math.max(1, Math.min(200, rows | 0)); if (cols === this.cols && rows === this.rows) return;
    // Shrinking: drop rows below the cursor first (they are usually blank); only when the cursor itself would fall off
    // the bottom do rows leave through the top, into scrollback. Content near the top of a fresh terminal must stay put.
    const fix = g => {
      const holder = g === this.g ? this : g === this.main ? this.savedMain || (this.savedMain = { x: 0, y: 0 }) : { y: 0 };
      while (g.length > rows) { if (holder.y < g.length - 1) g.pop(); else { const r = g.shift(); if (g === this.main) this.pushBack(r); holder.y = Math.max(0, holder.y - 1); } }
      while (g.length < rows) g.push(Array.from({ length: cols }, () => blank()));
      for (const r of g) { while (r.length > cols) r.pop(); while (r.length < cols) r.push(blank()); }
    };
    this.cols = cols; this.rows = rows; fix(this.main); if (this.altGrid) fix(this.altGrid);
    this.y = Math.min(this.y, rows - 1); this.x = Math.min(this.x, cols - 1); this.top = 0; this.bot = rows - 1; this.pend = false; this.version++;
  }
  pushBack(r) { this.back.push(r); if (this.back.length > this.maxBack) this.evicted = this.back.shift(); } // the evicted row is recycled by scrollUp

  // Feed output. Accepts a string or bytes (decoded as streaming UTF-8 is the caller's job for strings).
  write(data) {
    const s = typeof data === 'string' ? data : this.dec.decode(data, { stream: true });
    const n = s.length;
    for (let i = 0; i < n; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0x20 && c < 0x7f && this.state === 'g') { // hot path: printable ASCII in the ground state (most of all output)
        if (this.pend && this.wrap) { this.x = 0; this.lf(); }
        this.pend = false;
        const cell = this.g[this.y][this.x]; cell.ch = s[i]; cell.fg = this.fg; cell.bg = this.bg; cell.fl = this.fl;
        if (this.x < this.cols - 1) this.x++; else this.pend = true;
        continue;
      }
      if (c >= 0xd800 && c < 0xdc00 && i + 1 < n) { this.feed(s[i] + s[i + 1]); i++; } else this.feed(s[i]); // surrogate pairs stay whole
    }
    this.version++;
  }

  feed(ch) {
    const c = ch.codePointAt(0);
    switch (this.state) {
      case 'g': return this.ground(ch, c);
      case 'e': return this.escape(ch, c);
      case 'c': { // CSI: parameters, intermediates, final
        if (c >= 0x40 && c <= 0x7e) { this.state = 'g'; this.csi(ch, this.buf); this.buf = ''; }
        else if (c < 0x20) this.ground(ch, c); else if (this.buf.length < 64) this.buf += ch;
        return;
      }
      case 'o': { // OSC until BEL or ST
        if (c === 7) { this.state = 'g'; this.osc(this.buf); this.buf = ''; }
        else if (c === 0x1b) this.state = 'O';
        else if (this.buf.length < 512) this.buf += ch;
        return;
      }
      case 'O': { this.state = 'g'; this.osc(this.buf); this.buf = ''; if (ch !== '\\') this.escape(ch, c); return; }
      case 'x': { if (c === 0x1b) this.state = 'X'; else if (c === 7) this.state = 'g'; return; } // DCS/PM/APC: ignored until ST
      case 'X': { this.state = 'g'; return; }
      case 'p': { this.state = 'g'; return; } // charset designation: one more byte, ignored
    }
  }

  ground(ch, c) {
    if (c === 0x1b) { this.state = 'e'; return; }
    if (c === 10 || c === 11 || c === 12) { this.lf(); return; }
    if (c === 13) { this.x = 0; this.pend = false; return; }
    if (c === 8) { if (this.x > 0) this.x--; this.pend = false; return; }
    if (c === 9) { this.x = Math.min(this.cols - 1, (this.x + 8) & ~7); this.pend = false; return; }
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c < 0xa0)) return;
    if (this.pend && this.wrap) { this.x = 0; this.lf(); }
    this.pend = false;
    const cell = this.g[this.y][this.x]; cell.ch = ch; cell.fg = this.fg; cell.bg = this.bg; cell.fl = this.fl;
    if (this.x < this.cols - 1) this.x++; else this.pend = true;
  }
  lf() {
    if (this.y === this.bot) this.scrollUp(1); else if (this.y < this.rows - 1) this.y++;
    this.pend = false;
  }
  scrollUp(n) {
    for (let i = 0; i < n; i++) {
      const r = this.g.splice(this.top, 1)[0]; let fresh = null;
      if (this.g === this.main && this.top === 0) { this.pushBack(r); if (this.back.length >= this.maxBack && this.evicted?.length === this.cols) { fresh = this.evicted; this.evicted = null; for (const c of fresh) { c.ch = ' '; c.fg = -1; c.bg = this.bg; c.fl = 0; } } }
      this.g.splice(this.bot, 0, fresh || this.row());
    }
  }
  scrollDown(n) { for (let i = 0; i < n; i++) { this.g.splice(this.bot, 1); this.g.splice(this.top, 0, this.row()); } }

  escape(ch, c) {
    this.state = 'g';
    switch (ch) {
      case '[': this.state = 'c'; this.buf = ''; return;
      case ']': this.state = 'o'; this.buf = ''; return;
      case 'P': case '^': case '_': case 'X': this.state = 'x'; return;
      case '(': case ')': case '*': case '+': this.state = 'p'; return;
      case '7': this.saved = { x: this.x, y: this.y }; return;
      case '8': this.x = Math.min(this.saved.x, this.cols - 1); this.y = Math.min(this.saved.y, this.rows - 1); this.pend = false; return;
      case 'D': this.lf(); return;
      case 'E': this.x = 0; this.lf(); return;
      case 'M': if (this.y === this.top) this.scrollDown(1); else if (this.y > 0) this.y--; return;
      case 'c': this.reset(); return;
      default: return; // '=' '>' and friends
    }
  }
  reset() {
    this.altGrid = null; this.main = this.grid(); this.g = this.main; this.back = []; this.x = this.y = 0; this.top = 0; this.bot = this.rows - 1;
    this.fg = this.bg = -1; this.fl = 0; this.pend = false; this.cursorVisible = true; this.appCursor = false; this.bracketed = false;
  }

  csi(fin, raw) {
    const priv = raw[0] === '?' || raw[0] === '>' || raw[0] === '=' ? raw[0] : '';
    const p = (priv ? raw.slice(1) : raw).replace(/[ -/]+$/, '').split(';').map(v => (v === '' ? NaN : parseInt(v, 10)));
    const n = (i, d = 1) => (Number.isFinite(p[i]) && p[i] > 0 ? p[i] : d);
    const clampX = () => (this.x = Math.max(0, Math.min(this.cols - 1, this.x))), clampY = () => (this.y = Math.max(0, Math.min(this.rows - 1, this.y)));
    this.pend = false;
    switch (fin) {
      case 'A': this.y = Math.max(this.top, this.y - n(0)); return;
      case 'B': this.y = Math.min(this.bot, this.y + n(0)); return;
      case 'C': this.x += n(0); clampX(); return;
      case 'D': this.x -= n(0); clampX(); return;
      case 'E': this.y = Math.min(this.bot, this.y + n(0)); this.x = 0; return;
      case 'F': this.y = Math.max(this.top, this.y - n(0)); this.x = 0; return;
      case 'G': this.x = n(0) - 1; clampX(); return;
      case 'H': case 'f': this.y = n(0) - 1; this.x = n(1) - 1; clampX(); clampY(); return;
      case 'd': this.y = n(0) - 1; clampY(); return;
      case 'J': { const m = Number.isFinite(p[0]) ? p[0] : 0; if (m === 3) { this.back = []; return; }
        if (m === 0) { this.eraseRow(this.y, this.x, this.cols); for (let r = this.y + 1; r < this.rows; r++) this.eraseRow(r, 0, this.cols); }
        else if (m === 1) { for (let r = 0; r < this.y; r++) this.eraseRow(r, 0, this.cols); this.eraseRow(this.y, 0, this.x + 1); }
        else for (let r = 0; r < this.rows; r++) this.eraseRow(r, 0, this.cols); return; }
      case 'K': { const m = Number.isFinite(p[0]) ? p[0] : 0; if (m === 0) this.eraseRow(this.y, this.x, this.cols); else if (m === 1) this.eraseRow(this.y, 0, this.x + 1); else this.eraseRow(this.y, 0, this.cols); return; }
      case 'L': if (this.y >= this.top && this.y <= this.bot) for (let i = 0; i < n(0); i++) { this.g.splice(this.bot, 1); this.g.splice(this.y, 0, this.row()); } return;
      case 'M': if (this.y >= this.top && this.y <= this.bot) for (let i = 0; i < n(0); i++) { this.g.splice(this.y, 1); this.g.splice(this.bot, 0, this.row()); } return;
      case '@': { const r = this.g[this.y]; for (let i = 0; i < n(0); i++) { r.splice(this.x, 0, blank(-1, this.bg)); r.pop(); } return; }
      case 'P': { const r = this.g[this.y]; for (let i = 0; i < n(0); i++) { r.splice(this.x, 1); r.push(blank(-1, this.bg)); } return; }
      case 'X': this.eraseRow(this.y, this.x, Math.min(this.cols, this.x + n(0))); return;
      case 'S': this.scrollUp(n(0)); return;
      case 'T': this.scrollDown(n(0)); return;
      case 'r': { const t = n(0) - 1, b = (Number.isFinite(p[1]) ? p[1] : this.rows) - 1; if (t < b && b < this.rows) { this.top = t; this.bot = b; } else { this.top = 0; this.bot = this.rows - 1; } this.x = 0; this.y = 0; return; }
      case 's': this.saved = { x: this.x, y: this.y }; return;
      case 'u': this.x = Math.min(this.saved.x, this.cols - 1); this.y = Math.min(this.saved.y, this.rows - 1); return;
      case 'm': this.sgr(p); return;
      case 'n': if (p[0] === 6) this.onReply?.(`\x1b[${this.y + 1};${this.x + 1}R`); else if (p[0] === 5) this.onReply?.('\x1b[0n'); return;
      case 'c': if (!priv) this.onReply?.('\x1b[?1;2c'); return;
      case 'h': case 'l': { const on = fin === 'h'; if (priv !== '?') return;
        for (const m of p) {
          if (m === 25) this.cursorVisible = on; else if (m === 1) this.appCursor = on; else if (m === 7) this.wrap = on; else if (m === 2004) this.bracketed = on;
          else if (m === 1049 || m === 1047 || m === 47) this.altScreen(on);
          else if (m === 1000 || m === 1002 || m === 1003) this.mouse = on ? m : 0; // report: clicks / +drag / +all motion
          else if (m === 1006) this.mouseSgr = on; else if (m === 1007) this.altScroll = on;
        } return; }
      default: return;
    }
  }
  eraseRow(r, a, b) { const row = this.g[r]; for (let i = a; i < b && i < row.length; i++) row[i] = blank(-1, this.bg); }
  altScreen(on) {
    if (on && this.g === this.main) { this.altGrid = this.grid(); this.g = this.altGrid; this.savedMain = { x: this.x, y: this.y }; this.x = this.y = 0; this.top = 0; this.bot = this.rows - 1; }
    else if (!on && this.g !== this.main) { this.g = this.main; this.altGrid = null; this.x = Math.min(this.savedMain?.x ?? 0, this.cols - 1); this.y = Math.min(this.savedMain?.y ?? 0, this.rows - 1); this.top = 0; this.bot = this.rows - 1; }
  }
  sgr(p) {
    if (!p.length || (p.length === 1 && Number.isNaN(p[0]))) p = [0];
    for (let i = 0; i < p.length; i++) {
      const v = Number.isNaN(p[i]) ? 0 : p[i];
      if (v === 0) { this.fg = this.bg = -1; this.fl = 0; }
      else if (v === 1) this.fl |= FL.BOLD; else if (v === 2) this.fl |= FL.DIM; else if (v === 3) this.fl |= FL.ITALIC; else if (v === 4) this.fl |= FL.UNDER; else if (v === 7) this.fl |= FL.INVERSE;
      else if (v === 22) this.fl &= ~(FL.BOLD | FL.DIM); else if (v === 23) this.fl &= ~FL.ITALIC; else if (v === 24) this.fl &= ~FL.UNDER; else if (v === 27) this.fl &= ~FL.INVERSE;
      else if (v >= 30 && v <= 37) this.fg = v - 30; else if (v === 39) this.fg = -1; else if (v >= 40 && v <= 47) this.bg = v - 40; else if (v === 49) this.bg = -1;
      else if (v >= 90 && v <= 97) this.fg = v - 90 + 8; else if (v >= 100 && v <= 107) this.bg = v - 100 + 8;
      else if (v === 38 || v === 48) {
        const set = c => (v === 38 ? (this.fg = c) : (this.bg = c));
        if (p[i + 1] === 5 && Number.isFinite(p[i + 2])) { set(Math.max(0, Math.min(255, p[i + 2]))); i += 2; }
        else if (p[i + 1] === 2 && [2, 3, 4].every(k => Number.isFinite(p[i + k]))) { set(256 + ((p[i + 2] & 255) << 16 | (p[i + 3] & 255) << 8 | (p[i + 4] & 255))); i += 4; }
      }
    }
  }
  osc(s) {
    const i = s.indexOf(';'), code = i < 0 ? s : s.slice(0, i), arg = i < 0 ? '' : s.slice(i + 1);
    if (code === '0' || code === '2') { this.title = arg.slice(0, 120); this.onTitle?.(this.title); }
    else if (code === '7501') {
      const kv = {}; for (const part of arg.split(';')) { const j = part.indexOf('='); if (j > 0) kv[part.slice(0, j)] = part.slice(j + 1); }
      const state = STATES[kv.state]; if (state === undefined) return;
      const pr = parseInt(kv.progress, 10);
      this.onStatus?.({ state, kind: KINDS[kv.kind] || 0, progress: Number.isFinite(pr) ? Math.max(0, Math.min(100, pr)) : -1 });
    }
  }

  // Everything a renderer needs, bottom of scrollback + the live grid.
  viewRows(offset = 0) { // offset = lines scrolled back from the bottom
    const all = this.g === this.main ? [...this.back, ...this.g] : this.g, end = all.length - Math.max(0, Math.min(offset, this.back.length)), start = Math.max(0, end - this.rows);
    return all.slice(start, end);
  }
  text() { return this.g.map(r => r.map(c => c.ch).join('').replace(/\s+$/, '')).join('\n').replace(/\n+$/, ''); }
}

// Keyboard -> bytes for a DOM-style key event (pure, so tests and any host can use it).
export function encodeKey(ev, vt = {}) {
  const k = ev.key, app = vt.appCursor, ctrl = ev.ctrlKey, alt = ev.altKey;
  const arrows = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D', Home: 'H', End: 'F' };
  if (arrows[k]) { const m = (ev.shiftKey ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0); return m ? `\x1b[1;${m + 1}${arrows[k]}` : (app ? '\x1bO' : '\x1b[') + arrows[k]; }
  const fixed = { Enter: '\r', Backspace: '\x7f', Tab: ev.shiftKey ? '\x1b[Z' : '\t', Escape: '\x1b', Delete: '\x1b[3~', PageUp: '\x1b[5~', PageDown: '\x1b[6~', Insert: '\x1b[2~' };
  if (fixed[k] !== undefined) return alt && k === 'Backspace' ? '\x1b\x7f' : fixed[k];
  const f = /^F([1-9]|1[0-2])$/.exec(k); if (f) return ['\x1bOP', '\x1bOQ', '\x1bOR', '\x1bOS', '\x1b[15~', '\x1b[17~', '\x1b[18~', '\x1b[19~', '\x1b[20~', '\x1b[21~', '\x1b[23~', '\x1b[24~'][Number(f[1]) - 1];
  if (k.length === 1) {
    if (ctrl && /[a-z]/i.test(k)) return String.fromCharCode(k.toUpperCase().charCodeAt(0) - 64);
    if (ctrl && k === ' ') return '\0'; if (ctrl && k === '[') return '\x1b'; if (ctrl && k === '\\') return '\x1c';
    return alt ? '\x1b' + k : k;
  }
  return '';
}

// Mouse -> bytes (xterm SGR 1006 when the app asked for it, else the legacy X10 form). `ev`: {type:'down'|'up'|'move'|'wheel',
// button:0|1|2, dy, x, y (0-based cells), shift, alt, ctrl}. Returns '' when the app did not ask for this kind of event.
export function encodeMouse(ev, vt) {
  if (!vt.mouse) return '';
  if (ev.type === 'move' && vt.mouse < 1002) return '';
  let b;
  if (ev.type === 'wheel') b = (ev.dy < 0 ? 64 : 65);
  else if (ev.type === 'up') b = vt.mouseSgr ? ev.button : 3;
  else b = ev.button + (ev.type === 'move' ? 32 : 0);
  if (ev.type === 'move' && !ev.buttons && vt.mouse < 1003) return '';
  b += (ev.shift ? 4 : 0) + (ev.alt ? 8 : 0) + (ev.ctrl ? 16 : 0);
  const x = Math.max(0, ev.x) + 1, y = Math.max(0, ev.y) + 1;
  if (vt.mouseSgr) return `\x1b[<${b};${x};${y}${ev.type === 'up' ? 'm' : 'M'}`;
  if (x > 222 || y > 222) return '';
  return '\x1b[M' + String.fromCharCode(32 + b, 32 + x, 32 + y);
}
