import assert from 'node:assert/strict';
import { VT, FL, encodeKey } from '../src/vt.mjs';

const mk = (c = 20, r = 5, o = {}) => new VT({ cols: c, rows: r, ...o });
let t = mk(); t.write('hello\r\nworld');
assert.equal(t.text(), 'hello\nworld'); assert.deepEqual([t.x, t.y], [5, 1]);

// wrapping, scrollback, scroll region
t = mk(5, 3); t.write('abcdefgh'); assert.equal(t.text(), 'abcde\nfgh'); assert.equal(t.y, 1);
t.write('\r\n1\r\n2\r\n3'); assert.equal(t.back.length >= 1, true, 'lines scroll into history'); assert.equal(t.viewRows(0).length, 3);
assert.equal(t.viewRows(1)[0].map(c => c.ch).join('').trim(), t.back[t.back.length - 1].map(c => c.ch).join('').trim(), 'scrolled-back view shows history');

// cursor movement and erase
t = mk(); t.write('abcdef\x1b[3D\x1b[K'); assert.equal(t.text(), 'abc'); t.write('\x1b[2J\x1b[H'); assert.equal(t.text(), ''); assert.deepEqual([t.x, t.y], [0, 0]);
t.write('\x1b[3;4Hx'); assert.equal(t.g[2][3].ch, 'x');

// SGR: basic, bright, 256, truecolor, reset, flags
t = mk(); t.write('\x1b[1;31mR\x1b[0mn\x1b[38;5;200mP\x1b[48;2;1;2;3mT\x1b[94mB\x1b[7mI');
assert.deepEqual([t.g[0][0].fg, t.g[0][0].fl], [1, FL.BOLD]); assert.deepEqual([t.g[0][1].fg, t.g[0][1].fl], [-1, 0]);
assert.equal(t.g[0][2].fg, 200); assert.equal(t.g[0][3].bg, 256 + (1 << 16 | 2 << 8 | 3)); assert.equal(t.g[0][4].fg, 12); assert.ok(t.g[0][5].fl & FL.INVERSE);

// delete/insert, alt screen restores the main screen and cursor
t = mk(); t.write('abcdef\x1b[1;2H\x1b[2P'); assert.equal(t.text(), 'adef'); t.write('\x1b[1;2H\x1b[2@'); assert.equal(t.g[0].slice(0, 6).map(c => c.ch).join(''), 'a  def');
t = mk(); t.write('main screen'); t.write('\x1b[?1049h'); t.write('\x1b[Hfull-screen app'); assert.equal(t.text(), 'full-screen app'); t.write('\x1b[?1049l'); assert.equal(t.text(), 'main screen'); assert.equal(t.back.length, 0, 'alt screen never pollutes history');

// replies a program waits for, modes that change key encoding
const replies = []; t = mk(20, 5, { onReply: r => replies.push(r) }); t.write('ab\x1b[6n\x1b[c'); assert.deepEqual(replies, ['\x1b[1;3R', '\x1b[?1;2c']);
t.write('\x1b[?1h'); assert.equal(encodeKey({ key: 'ArrowUp' }, t), '\x1bOA'); t.write('\x1b[?1l'); assert.equal(encodeKey({ key: 'ArrowUp' }, t), '\x1b[A');

// OSC: title and Kijo status (OSC 7501), both terminators
let status = null, title = ''; t = mk(20, 5, { onStatus: s => (status = s), onTitle: s => (title = s) });
t.write('\x1b]2;my title\x07'); assert.equal(title, 'my title');
t.write('\x1b]7501;state=blocked;kind=permission;progress=40\x1b\\'); assert.deepEqual(status, { state: 2, kind: 1, progress: 40 });
t.write('\x1b]7501;state=working;progress=250\x07'); assert.deepEqual(status, { state: 1, kind: 0, progress: 100 }, 'progress is clamped');
status = null; t.write('\x1b]7501;state=exploding\x07'); assert.equal(status, null, 'unknown states are ignored');

// hostile input never throws or grows without bound
t = mk(10, 4); const junk = Array.from({ length: 4000 }, (_, i) => String.fromCharCode((i * 7919) % 127)).join('') + '\x1b['.repeat(500) + '\x1b]'.repeat(50) + 'x'.repeat(100000);
t.write(junk); assert.ok(t.back.length <= t.maxBack && t.g.length === 4 && t.g.every(r => r.length === 10));
t.resize(40, 10); assert.ok(t.g.length === 10 && t.g.every(r => r.length === 40)); t.resize(4, 2); assert.ok(t.g.length === 2 && t.g.every(r => r.length === 4) && t.x < 4 && t.y < 2);

// keys
assert.equal(encodeKey({ key: 'c', ctrlKey: true }), '\x03'); assert.equal(encodeKey({ key: 'Enter' }), '\r'); assert.equal(encodeKey({ key: 'a' }), 'a'); assert.equal(encodeKey({ key: 'Backspace' }), '\x7f');
assert.equal(encodeKey({ key: 'ArrowLeft', ctrlKey: true }), '\x1b[1;5D'); assert.equal(encodeKey({ key: 'x', altKey: true }), '\x1bx'); assert.equal(encodeKey({ key: 'Shift' }), '');
console.log('PASS — vt: cursor, wrap, scrollback, SGR (16/256/truecolor), edit ops, alt screen, DSR replies, OSC title + 7501 status, hostile input, keys');
