# Kijo / spatial core 0.3 — WASM first, GPU-drawn, no DOM UI

Kijo is a **spatial desktop layer**: one structured scene (workspaces, 6x6 slot grids, ghost
reservations, status) owned by a WebAssembly core, drawn by interchangeable renderers. It is also
just a **bulletin board**: pin notes anywhere, no agent or connector required.

```text
local fs / SSH / OS metrics / Herdr / agents          (adapters: planned in kijod, see Roadmap)
                        |
              WASM core  (core/scene.c, ABI v2)
   workspaces · selection · ghost ownership · dispatchers · status · event ring
                        |
                 structured scene nodes
              /                         \
   terminal host (ANSI, SSH)     Chrome host (one <canvas>, WebGPU)
   src/host.mjs                  web/*.mjs  + shaders/*.wgsl
```

The browser is only a GPU surface here: `web/index.html` contains a single `<canvas>`. Every pixel
(bar, tiles, text, palette) comes from a display list built from the WASM scene and drawn with
WebGPU (Canvas2D fallback). There is no DOM UI, no CSS layout, no HTML components.

## Run

```sh
npm test                           # 4000-step fuzz + invariants, no dependencies
node src/host.mjs                  # terminal host (works over SSH, no X11/Wayland)
node src/serve.mjs                 # Chrome host at http://127.0.0.1:7501/
node src/bundle.mjs                # one self-contained dist/kijo.html (wasm + shaders inlined)
./build.sh                         # rebuild core/scene.wasm (clang, wasm32); .b64 is checked in
```

On a VPS keep the loopback bind and tunnel it: `ssh -L 7501:127.0.0.1:7501 host`.
Node 22+. Chrome with WebGPU is best; `?renderer=2d` forces the Canvas2D fallback.

## Model (Hyprland-style, with ghost tiles)

- **Workspaces 1-9 + special (scratchpad)**, each its own 6x6 canvas. `Alt+1..9` switches,
  `Alt+Shift+1..9` moves the selected tile, `S` toggles the scratchpad.
- **Dispatchers** (`kijo_dispatch`): movefocus, jumpfocus, swap, workspace, cycleworkspace,
  movetoworkspace, killactive, togglespecial. Keys, pointer and the palette all call the same ones.
- **Ghost tiles** reserve slots so neighbours never auto-expand. `kijo_spawn(app, fw, fh, corner)`
  creates a visible tile plus owned ghosts in one transaction. Closing the owner removes exactly the
  ghosts it still owns (owner id + group + creation tx). A ghost promoted to a note is independent
  and survives. Ghosts are transparent by default; `G` reveals them.
- **Status vocabulary matches OSC 7501**: `idle · working · blocked(permission|question|auth) ·
  error · done`, plus `progress`. `kijo_report(id, state, kind, progress)` is the entry point a
  future adapter feeds. The bar and workspace pills surface the most urgent state per workspace.
- **Views** (`1`-`5`): focus (2x2), overview (6x6 heatmap), wiring, timeline, workspaces.
  `Esc`/`Enter` and the wheel zoom between them; tiles glide between rectangles.
- **Search** (`/` or `Ctrl+K`): one palette over commands, workspaces and every note/tile.
- **Notes**: `N` makes a note, `F` reserves a 2x2 footprint, `E` writes text (`Esc` saves).

## ABI v2 (core/scene.c)

Little-endian i32 in linear memory. Tiles are 10 ints, scene nodes 15, events 5; scene coordinates are
0..6000. Selection, viewport, workspaces and the event ring live in the core, so any host (or a remote
client) drives identical state. Layout is never recomputed by renderers. `src/core.mjs` is the
environment-neutral decoder shared by every host. State persists as schema v2
(`~/.local/state/kijo/state.json` or `localStorage`).

## What is real and what is not

Real: the WASM core and its invariants (fuzz-tested), both hosts, the WebGPU renderer (verified in
Chromium/SwiftShader by reading back pixels), persistence, the dispatcher API, browser metrics
(cores, memory, battery, online state).

Not built yet, and labelled as such in the UI: PTY-backed terminal tiles, SSH/Herdr attach, OSC 7501
parsing, the `kijod` daemon and adapter protocol, real CPU/RAM numbers in the browser, agent
execution. The agent tile is a local simulation. The terminal host's `P`/`O` still take over the
terminal for a real shell/SSH session.

## Roadmap

1. `kijod`: Node daemon holding the WASM core, serving WebSocket + local socket; adapters declare
   capabilities, consequential actions need human approval.
2. Terminal tiles: PTY sessions, cell grid streamed to the renderer, OSC 7501 -> `kijo_report`.
3. Herdr adapter via `herdr terminal session observe|control` (NDJSON) and `herdr session list --json`.
4. Hyprland adapter via `hyprctl` socket for mirroring real workspaces.
5. Theme tokens (radius, gap, palette, motion) exposed as JSON; native wgpu host.

## Design constraints

- Bauhaus wireframe first; function over decoration. Dense, readable, honest.
- One structured scene, many render targets. WASM owns invariants; renderers own pixels.
- Adapters distinguish real data from simulation. Agent tools need explicit permission.
