# Kijo — first spatial prototype

An intentionally plain, Bauhaus-adjacent **functional wireframe**, influenced by the wireframe approach in [Crew's README](https://github.com/taituo/crewpi#screens). No decorative desktop cards, no pretend remote connections.

## Run

Open `index.html` in any modern browser. No installation, build step, or server needed. To serve it over a network or from a VPS:

```sh
python3 -m http.server 8080
```

Open `http://localhost:8080`.

## Interactions

- **Focus / 2×2**: exactly four logical positions. A content tile never stretches to fill an emptied sibling slot.
- **Overview / 6×6**: same logical cells, represented as a heatmap. Click a cell to enter its neighborhood.
- **Ghosts**: turn on to inspect reserved slots. Click a ghost to replace it with a persistent independent note.
- **Close tile**: removes its own ghosts, never a converted note or unrelated tile.
- **Search**: Ctrl/Cmd+K or `/` finds and locates tiles.
- **Arrow keys**: pan the 2×2 focus viewport, `-` to overview, `+` to focus, `g` to show ghosts.
- **Notes**: saved in localStorage. Export and import JSON for backup.
- **Back / Wiring**: explicit view of demonstrative data paths and currently unconnected remote adapter.
- **Time / Activity**: activity reads the same event model as other views; Gantt rows are explicitly illustrative.
- **Advance demo**: cycles simulated agent status and records events. Not a running agent.
- **Optional WebGL2 shader**: an opt-in sample compositor layer. Off by default, disabled when reduced motion is requested.
- **Real browser sensor**: reads online/offline and viewport from the browser, separately labeled from demo data.
- **WebSocket adapter**: `Connect data feed` accepts a `ws://` or `wss://` endpoint broadcasting known-tile status events.

## WebSocket adapter contract

Send UTF-8 JSON messages like:

```json
{"type":"status","id":"ops-1","status":"working"}
```

Or:

```json
{"type":"event","label":"Index updated","status":"done"}
```

Allowed statuses are `active`, `working`, `blocked`, `idle`, `done`. Unknown IDs are ignored. A real SSH/PTy/Ghostty/Herdr service requires a trusted server-side bridge; the HTML file alone cannot provide these capabilities.

## Core model

The spatial model is six by six, with **content tiles** and **ghost reservations** as separate records. Each ghost carries an owning tile ID and a group ID. Converting a ghost into a note removes the reservation before inserting independent content. Closing an owner filters only its still-owned ghost reservations; other content is preserved.

This is not yet a compositor or an operating system. Native WebAssembly apps, Ghostty rendering, real Herdr/SSH session transport, OSC 7501 parsing, security, a proper GPU compositing engine, remote persistent sessions, multi-device sync, and actual cron/agent orchestration are future engineering work, not claimed demo features.

## Architecture direction

- UI / model: mobile and large-screen layouts from the same immutable-addressable grid coordinates and event model.
- Runtime: browser DOM today; future WASM applications and isolated adapters.
- Graphics: separate content, layout, and optional shader render passes; WebGL2 proof of feasibility today, WebGPU later.
- Data: typed event envelope; remote WS transport; secure server-side connectors (SSH, Herdr, Ghostty sessions, OSC 7501, workflows) in later milestones.
- Trust: human approval and least-privilege capabilities, as demonstrated in Crew.
- Design: no theming system until the layout, ghost semantics, and runtime interaction are validated.