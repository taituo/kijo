# Kijo / spatial core 0.5 — WASM first, GPU-drawn, no DOM UI, nothing to install

Kijo is a **spatial desktop layer**: one structured scene (workspaces, 6x6 slot grids, ghost
reservations, status) owned by a WebAssembly core, drawn by interchangeable renderers. It is also
just a **bulletin board**: pin notes anywhere, no agent or connector required.

```text
injectors: this page · paste/drop · other tabs · pull URL · WebSocket · curl · OTel SDK · kijod relay
                        |  telemetry Store (metrics · logs · spans · facts · status)
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

Nothing here is a fixed constraint: DOM, canvas and native surfaces may be combined, GPU surfaces sit beside
text and PTY surfaces, and 6x6 is today's grid, not the design. The seams that keep that possible are written
down in [`docs/surface-contract.md`](docs/surface-contract.md) (tracking issue #1).

## Nothing to install

The browser **is** the runtime. Open `dist/kijo.html` (one file, WASM and shaders inlined) and you
have the whole thing: workspaces, bulletin board, dashboards, search. Data reaches it through
*injectors*, and every injector ends in the same `store.ingest()`:

| injector | how |
|---|---|
| this page | built in: fps, draw time, event-loop lag, JS heap, GPU, cores (real numbers) |
| console / bookmarklet | `kijo.inject('queue.depth 12')` |
| paste or drop | NDJSON, OTLP JSON, Prometheus text, `name value` / `name=value` lines |
| other tabs | `new BroadcastChannel('kijo').postMessage({t:'metric',name:'x',value:1})` |
| pull URL | palette: `pull https://host/metrics` (CORS must allow it) |
| WebSocket | palette: `ws wss://host/stream` |
| **kijod relay** (optional) | one file, runs on any host you can SSH into, forwards host metrics + `/ingest` + OTLP to your browser |

```sh
# remote host: no install, no files written, it dies with the connection
ssh -L 7501:127.0.0.1:7501 you@host 'node --input-type=module -' < dist/kijod.mjs
# it prints  http://127.0.0.1:7501/#token=...   open that in any browser
curl -H "Authorization: Bearer $TOKEN" --data-binary 'jobs.pending 12' http://127.0.0.1:7501/ingest
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:7501 OTEL_EXPORTER_OTLP_PROTOCOL=http/json   # SDKs work as-is
```

Message schema (all optional fields have defaults): `{t:'metric',name,value,ts?,unit?,labels?}`,
`{t:'log',level,body}`, `{t:'span',trace,id,parent?,name,start,dur,status?}`, `{t:'fact',key,value}`,
`{t:'status',id,state,kind?,progress?}` (drives a tile through `kijo_report`, OSC 7501 vocabulary).

**Dashboards are tiles.** Workspace 3 charts the page itself; workspace 4 shows a system card
(neofetch facts + htop-style bars from `cpu.core_pct{core}`), charts, logs and a trace waterfall.
Pin anything you injected: `/` then `Pin chart: <series>`, `Pin logs`, `Pin traces`, `Pin system`.
`[` `]` change the time window (1m / 5m / 15m / 30m). View `6` is **flow**: injectors → series → tiles,
read from the live store; a moving packet on a cable means data really arrived on it in the last seconds.

**Security model.** kijod binds 127.0.0.1 only, requires a bearer token on everything except the page
itself, checks Host (DNS rebinding) and caps body size, clients and series. The token travels in the URL
fragment (never sent to a server) and is removed from the address bar on load. Reach a remote kijod
through an SSH tunnel; do not expose it. OTLP/protobuf is refused with 415 (use `http/json`).
Shell access (below) is a separate switch, off by default.

## Text you can select, and a real terminal

**Every text surface is selectable and copyable.** Drag inside a tile to select, `Ctrl+A` selects the tile's
text, `Ctrl+C` copies, `Esc` clears. Selection lives in a semantic text model (`web/textsel.mjs`) built from the
display list, not in pixels, so it behaves the same on WebGPU, Canvas2D and any future host.

**Terminal tile.** The shell tile is a real PTY when the relay allows it:

```sh
ssh -L 7501:127.0.0.1:7501 you@host 'node --input-type=module - --allow-shell' < dist/kijod.mjs   # or KIJOD_SHELL=1
# open the printed URL, select the shell tile, press Enter (or click it, or palette: "Terminal: open shell")
```

`src/vt.mjs` is a VT100/xterm-class emulator (SGR 16/256/truecolor, cursor and edit ops, scroll regions, alt screen,
scrollback, bracketed paste, DSR/DA replies). The PTY itself is a ~30-line `python3` helper spawned by kijod, so there is
nothing to compile on the host. While a terminal is captured, keys go to the shell (`Ctrl+C` is SIGINT); `Ctrl+]`
gives them back, `Ctrl+Shift+C` / `Ctrl+Shift+V` copy and paste, the wheel or `Shift+PgUp/PgDn` scrolls history.
The PTY follows the tile's size. Shells survive a page reload (kijod replays recent output) and are reaped 10 s after the
last browser detaches.

**Status from inside the shell** uses OSC 7501, so any script or agent can colour its own tile:

```sh
printf '\033]7501;state=blocked;kind=permission\007'     # idle | working | blocked | error | done, optional ;progress=0-100
```

**Shell access is shell access.** It is off unless kijod starts with `--allow-shell` (or `KIJOD_SHELL=1`); otherwise
`/pty/*` answers 403 and the tile says so. Anyone holding the token can then run commands as that user, so keep the
loopback bind and the tunnel. At most 4 shells, 64 KB per input request. Limits: the glyph atlas is ASCII (box drawing
folds to `+ - |`, other characters show as `?`), no mouse reporting yet, no wide (CJK) cells.

The surface contract (what a tile, a surface and a scene node are, focus/capture, selection, status) is written down
in [`docs/surface-contract.md`](docs/surface-contract.md).

## How fast

Measured on loopback in the test sandbox (software GPU, so no GPU numbers; check `fps` / `draw_ms` in the bar on your own machine):

| | |
|---|---|
| keystroke echo, browser to PTY and back through kijod | ~1.4 ms median (add your network RTT over an SSH tunnel) |
| PTY output through the relay | ~21 MB/s |
| VT emulator parse, coloured text | ~17 MB/s |
| display list for a 1080p frame with a busy 160x50 terminal | ~0.7 ms median |

Output after a quiet moment is sent at once; only bursts are coalesced into ~16 ms frames. The VT parser runs on the
main thread, so a multi-hundred-megabyte `cat` will stutter; moving it to a worker is on the roadmap.

## Layout of the repo

```text
core/    scene.c (the WASM core) and its build        src/    core.mjs, vt.mjs, telemetry.mjs, kijod.mjs, hosts, bundler
web/     Chrome host: display list, renderers,        shaders/ WGSL (scene, heatmap, 3D surface)
         terminal, text selection, injectors          docs/    surface-contract.md
test/    unit, drawing, daemon (incl. real PTY) and real-Chrome E2E tests      dist/  built single-file artifacts
```

## Run

```sh
npm test                           # core fuzz + telemetry + drawing + VT + text selection + relay, no dependencies
npm run e2e                        # real Chrome (KIJO_CHROME=...; needs playwright): UI, and a real PTY through kijod
node src/host.mjs                  # terminal host (works over SSH, no X11/Wayland)
node src/serve.mjs                 # Chrome host at http://127.0.0.1:7501/
node src/bundle.mjs                # dist/kijo.html (the app) and dist/kijod.mjs (the relay, UI embedded)
node src/kijod.mjs                 # the relay from a checkout (KIJOD_PORT, KIJOD_TOKEN)
./build.sh                         # rebuild core/scene.wasm (clang, wasm32); .b64 is checked in
```

On a VPS keep the loopback bind and tunnel it: `ssh -L 7501:127.0.0.1:7501 host`.
Node 22+. Chrome with WebGPU is best; `?renderer=2d` forces the Canvas2D fallback.

## 3D tile

Workspace 5 puts a **3D surface** tile (rows = series, columns = time, height = value) next to a text
log and two charts: a GPU surface coexisting with text surfaces. It is a small in-house pass inside the
same WebGPU frame (`shaders/surface.wgsl`, geometry in `web/surface3d.mjs`): own render pass, depth
buffer, scissored to the tile, flat-shaded from derivatives. Percent series keep their 0-100 scale,
others are min-max normalised per series and the tile says so. The camera auto-orbits; drag to orbit,
double-click to spin again. Canvas2D draws the same geometry with a painter's algorithm. `Pin 3D
surface` in the palette adds more. A full engine (three.js, Babylon, a native Bevy/wgpu host) can later
plug in as another surface type behind the same display-list op; none is needed for height fields and
a dependency would own the device and the pass structure.

## Glass theme and wallpaper

`?theme=glass` or palette `Theme: glass`: translucent panels over a procedural wallpaper, drawn by two
extra shader modes in `shaders/scene.wgsl` (no textures, no assets). The wallpaper is four soft colour
blobs on a domain-warped field that drifts slowly; `Wallpaper: aurora / saffron / lagoon / orchid /
meadow` (key `W`) are hue and seed variants of the same function. Glass samples that function five times
around a lens-offset point (cheap frosted blur), lifts saturation, adds a directional rim highlight,
inner glow and a soft shadow. Because the backdrop is analytic there is no render-to-texture pass; the
limit is that glass shows the wallpaper, not other tiles behind it. Canvas2D gets an approximation.

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
- **Views** (`1`-`6`): focus (2x2), overview (6x6 heatmap), wiring, timeline, workspaces, flow.
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

Also real since 0.4: the telemetry store and every injector above, OTLP/Prometheus/NDJSON parsing, the
`kijod` relay (collector reads `/proc` and `os`, self-traces its own requests), status injection into
the core, layout sync between devices through kijod sessions. Charts only ever show injected data;
there is no synthetic data in the app (tests use fixtures, labelled as such).

Also real since 0.5: selectable/copyable text on every text surface, the VT emulator, PTY-backed terminal tiles
through kijod (opt-in), OSC 7501 parsed from the PTY stream into tile status.

Not built yet, and labelled as such in the UI: SSH/Herdr attach, mouse reporting, OTLP/protobuf, agent execution.
The agent tile is a local simulation. The terminal host's `P`/`O` still take over the terminal for a real shell/SSH session.

## Roadmap

1. kijod adapters: declare capabilities; consequential actions need human approval. Today the relay collects and
   forwards and runs nothing, except the opt-in shell (`--allow-shell`), which is explicit shell access for the token holder.
2. Terminal tiles: more than one shell per host, mouse reporting, Unicode glyph atlas, VT parsing in a worker, a scrollable log surface with search.
3. Herdr adapter via `herdr terminal session observe|control` (NDJSON) and `herdr session list --json`.
4. Hyprland adapter via `hyprctl` socket for mirroring real workspaces.
5. Theme tokens (radius, gap, palette, motion) exposed as JSON; native wgpu host (same core, same display-list ops); render-to-texture glass over tiles; an accessibility mirror of the text model.

## Design constraints

- Bauhaus wireframe first; function over decoration. Dense, readable, honest.
- One structured scene, many render targets. WASM owns invariants; renderers own pixels.
- Adapters distinguish real data from simulation. Agent tools need explicit permission.
