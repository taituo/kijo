# RFC: the surface contract (draft 0.1)

Status: draft, written against what is implemented in 0.5. Tracks GitHub issue #1.
Nothing here is a fixed constraint: it names the seams that already exist so hybrids stay possible
(DOM + canvas + native, GPU surfaces beside text and PTY surfaces, a 6x6 grid today and something else tomorrow).

## 1. Three things that are easy to confuse

| term | owned by | what it is |
|---|---|---|
| **tile** | the WASM core | a slot in the layout: id, app, status, position, owner/ghost relations. Has no pixels and no content. |
| **surface** | the host | whatever produces the content inside a tile: a VT grid, a log list, a chart, a 3D height field, later a native wgpu view or an iframe. One tile has at most one primary surface. |
| **scene node** | the core, per view | a tile (or ghost/empty slot) as placed in the current view's rectangle. Renderers map nodes to pixels; they never compute layout. |

The core knows tiles and nodes. It must never learn what a surface is made of. Surfaces are a host concern,
which is what lets a browser host, the terminal host and a future native host disagree about rendering and agree about state.

## 2. Identity and ownership

- A surface is addressed by its **tile id** (`surf` in the display list). The id is stable for the life of the tile,
  survives workspace moves and swaps, and is never reused while the tile exists.
- Ghost reservations (owner id + group + creation tx) are about *layout space*, not content. A closing owner removes
  exactly the ghosts it still owns; a surface never holds a ghost alive and a ghost never owns a surface.
- Closing a tile closes its surface: the host drops the VT/PTY/GPU resources keyed by that id. A host that cannot do
  so synchronously (a PTY that takes a moment to die) must treat the id as dead anyway.

## 3. Display-list ops (the rendering seam)

`buildDisplayList(api, st, env)` is pure and returns `{cmds, hits, animating, selectionText, termSizes}`.
Ops are data; any renderer that implements them can draw any surface.

| op | meaning | notes |
|---|---|---|
| `fill` `stroke` `dash` | rectangles | SDF, so radius and thickness are exact at any dpr |
| `text` | one run of glyphs | carries `surf` (tile id) and optionally `term` (cell-aligned text: gaps are columns) |
| `heat` | animated activity field | used by the overview |
| `glass` `wall` | translucent panel, procedural wallpaper | optional; a renderer without them approximates |
| `scene3d` | a 3D surface in a rectangle | data only (rows, cols, values, camera); the renderer builds geometry |

A new kind of surface adds an op or composes existing ones. It does not add a code path in the core.
**Capability and fallback:** every op has a defined degraded form (glass -> tinted fill, scene3d -> painter's algorithm).
A renderer states what it supports; a surface that needs something unsupported draws a labelled placeholder, never nothing.

A tile may also carry a **look** chosen by the host (a chart pinned as stat, gauge, bar gauge or Up/Down status). The look
lives beside the tile's binding in host state, never in the core, which is the contract's rule applied to itself.
Layout uses square cells: the host maps the core's scene into the largest centred square, and a zoom (`Z`) is a host mapping, not a core state.

## 4. Input routing and focus

Focus has two levels and only one of them is a surface's business.

1. **Layout focus**: which tile is selected. Owned by the core, changed by dispatchers (`movefocus`, `jumpfocus`,
   `swap`, ...). Keys, pointer and the palette all call the same dispatchers.
2. **Key capture**: whether a surface receives raw keys. A surface starts uncaptured. Capture is entered
   *explicitly* (Enter, or a click that is not a drag, on a surface that declared it accepts input) and left explicitly
   (a reserved release chord, `Ctrl+]` for terminals) or implicitly by anything that changes layout focus or view.
   While captured, **everything** goes to the surface except the release chord and the copy/paste chords
   (`Ctrl+Shift+C`, `Ctrl+Shift+V`, or `Cmd+C/V`); the host must not interpret Kijo shortcuts, so `Ctrl+C` is SIGINT.

A surface never moves layout focus on its own. Status it wants shown goes through `kijo_report` (section 6).

## 5. Selection and clipboard

- Selection is a property of the **text model**, not of pixels: `{surf, ax, ay, bx, by}` or `{surf, all}`,
  resolved by `web/textsel.mjs` from the display list's text ops. Renderers only draw the highlight rectangles.
- Reading order is top to bottom, runs left to right inside one surface. Selection never crosses surfaces.
- Text ops with `term: true` keep columns exactly (adjacent runs join without a space, gaps become that many spaces);
  other text caps a gap at 8 spaces so layout whitespace does not leak into a paste.
- Copy writes `selectionText`, computed from the same ops that were drawn, so what you copy is what you saw.
  (The glyph atlas draws Latin/Greek/Cyrillic, symbols and box drawing; code points it cannot draw become `?` *before* drawing, so copy matches the screen.)
- Paste into a captured surface is the surface's business (bracketed paste for a terminal). Paste into an uncaptured
  page is telemetry injection, and the two must never both fire.
- **Accessibility:** `selectionText` is the seed of an a11y mirror. A DOM mirror of the text model, kept offscreen and
  updated from the display list, is compatible with this contract and not built yet.

## 6. Status and approvals

A surface reports `idle | working | blocked(permission|question|auth) | error | done` plus progress through
`kijo_report(tileId, state, kind, progress)`. The wire form for streams is **OSC 7501**:

```
ESC ] 7501 ; state=<idle|working|blocked|error|done> [; kind=permission|question|auth] [; progress=0-100] BEL
```

(ST `ESC \` also terminates.) Unknown states and malformed fields are ignored. A surface can *ask* for attention;
it cannot approve anything. Consequential actions (running a command on someone's host, writing files, spending money)
need an explicit human action in the host, never an escape sequence.

## 7. Versioning

- The core ABI is versioned (v2 today: little-endian i32 tables, tiles 10 ints, nodes 15, events 5). Hosts check it.
- The display-list op set is additive: unknown ops are skipped by renderers, unknown fields ignored.
- Daemon wire (SSE `snapshot` / `m` / `pty`, `/pty/*`) is additive for the same reason; `snapshot.shell` advertises capability.

## 8. Capability and security notes for hosted surfaces

- A surface that executes anything (PTY today) is **off unless the operator enabled it** on the thing that runs the code
  (`kijod --allow-shell`), advertised in the snapshot, refused with 403 otherwise, capped in count, size and lifetime
  (shells are reaped ten seconds after the last browser detaches).
- The browser cannot run a shell by itself. Zero-install holds because the relay is one file run over the ssh session you already have.
- Untrusted content (a remote page, an iframe, a plugin) belongs behind a separate origin or process; the contract only
  hands it a rectangle and takes pixels or text back.

## 9. What is deliberately not decided

- **Native wgpu host**: same core, same display-list ops, different renderer. The ops above are the only contract it must meet.
  A spike (`native/`) already runs the same `scene.wasm` under wasmi with byte-identical state (`test/parity.mjs`) and draws ops 0-2 of
  `scene.wgsl` through wgpu; the display-list builder, glyph atlas and remaining ops are what a full host still needs.
- **Render-to-texture** (glass over *tiles*, not just the wallpaper): a renderer feature behind the existing `glass` op.
- **Embedding a full engine** (three.js, Bevy): another op or a surface with its own pass, scissored to its rectangle, as `scene3d` already is.
- **Multiple surfaces per tile** (split terminal, tabs): a layout question for the core, not a rendering one.
- **Depth between tiles** (parallax, z-order experiments): optional, behind the same ops.
