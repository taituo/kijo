# Kijo / spatial core 0.2 — WASM first, no HTML

Kijo is **not a browser desktop**. It is an experimental runtime for one structured spatial scene shared across native and remote presentation layers.

The first executable slice is deliberately plain and usable: a **real WebAssembly module** containing the layout, focus, ownership, scene-graph generation and state transitions, hosted by a **native terminal renderer**. It works over SSH on a headless Linux VPS without X11, Wayland, Chromium, or a browser.

```text
local filesystem / SSH / OS metrics / future agent connectors
                        |
                host adapter (Node v22)
                  |           |
             WASM memory   terminal I/O
                  |
        [structured scene nodes]
                  |
           ANSI renderer (now)
                  |
            Ghostty / SSH

Future adapters: native wgpu compositor, remote scene transport,
mobile renderer; no DOM-based presentation is required.
```

## Run

```sh
node src/host.mjs --once           # show 2x2 snapshot; zero dependencies
node src/host.mjs --view overview --once
node src/host.mjs                  # interactive; requires terminal
npm test
```

Node.js 22+ is needed for the initial host. `core/scene.wasm.b64` is checked in as a portable precompiled module (~5–6KB decoded), so you can run without Clang. Local builds create `core/scene.wasm`. Rebuild with a Clang that supports `--target=wasm32`:

```sh
./build.sh
```

## Interaction

Use `1`–`4` for focus, 6x6 overview, wiring and timeline. Arrow keys select slots. `Enter` zooms from overview to focus; `n` promotes a selected ghost to an independently owned note; `x` closes the selected tile and **only ghosts it still owns**; `t` cycles a demo status. `g` shows/hides ghost outlines; `r` resets; `q` quits. `p` temporarily opens a **real local shell** when the shell tile is selected; it returns to Kijo on exit. Set `KIJO_SSH_HOST=hostname` and select the SSH tile, then press `o` to attach via SSH. This attachment temporarily takes over the terminal; it is **not** yet embedded pane multiplexing.

Saved workspace state and notes are stored under `~/.local/state/kijo/state.json` (or `KIJO_STATE_FILE`). `--fresh` ignores saved state.

## The actual WASM contract

`core/scene.c` compiles to `core/scene.wasm`. It exports typed arrays in linear memory using ABI v1, queried via `kijo_tile_ptr`, `kijo_node_ptr`, `kijo_node_count`, and `kijo_build_scene(view)`. One scene supports focus, overview heatmap, wiring, and timeline. The host reads nodes with semantic types, grid coordinates, state, ownership, material and shader identifiers. Renderers are adapters; **layout is not recomputed by individual renderers**.

Ownership uses a group ID **and creation transaction**. Promoting a ghost detaches ownership. Closing a parent removes its remaining owned placeholders and preserves independently occupied slots. `npm test` verifies this invariant.

## Shaders and future native compositor

Shaders are a rendering concern, not WASM's job. `shaders/heatmap.wgsl` is an example WGSL activity material for a planned **native wgpu/WebGPU host**; the shader is not executed by the current ANSI adapter. Semantic statuses and accessibility must remain available without GPU effects. A real renderer can eventually support signed WASM app modules, GPU composition, text shaping, multi-monitor focus, and remote input/frame transport.

## Remote and phone ambitions

A VPS can already run the terminal host over SSH (no X server). However, a **true remote pixel desktop** requires a separate GPU/software compositor and network transport, while a phone needs an adaptive renderer and input protocol. This prototype does not provide these yet. Herdr, Ghostty session embedding, OSC 7501, sandboxing and authenticated connectors are follow-on integrations—not simulated as working.

## Design constraints

- **Bauhaus wireframe first:** restrained, minimal 2x2 primary focus; 6x6 overview is a separate zoom level, not 36 widgets always on screen.
- **No HTML, DOM, CSS or browser-based renderer.**
- **One structured scene, many render targets.**
- **WASM owns spatial invariants; GPU native layer eventually owns drawing.**
- **Adapters distinguish local metrics from simulated agent status.**
- **Future agent tools need explicit permission and human approval for consequential operations.**

This is a working *architecture demonstrator*, not yet a finished GUI desktop.
