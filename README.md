# pocket-rpgkit

A reusable 2D tile-RPG runtime and the **`rpgkit-project/v1`** data format,
built on [PocketJS](https://github.com/pocket-stack/pocketjs). It contains
the parts an RPG-Maker-style game needs without any specific game:

- **pure-TS engine** (`src/engine/`) — tile movement and collision, the
  event interpreter (pages, triggers, 15 commands), map-character motion,
  multi-map sessions, deterministic save snapshots. No host imports, no
  wall clock, no `Math.random`: a session is one pure fold per virtual
  frame, so a button tape replays byte-for-byte on every host;
- **Solid UI components** (`src/ui/`) — `MapView`-style composition blocks:
  `DialogBox`, `PlayerSprite`, `SaveMenu`;
- **host adapters** (`src/host/`) — the `data.fs` save slot store;
- **a build-time asset pipeline** (`tools/lib/bake.ts`) — tile sheets to
  baked 512px PSM_4444 canvases and static walker frames;
- **the format** (`src/data/schema.json`, frozen at v1; changes recorded in
  `src/data/CHANGELOG.md`);
- **a minimal example** (`example/`, one 20×12 map, four events) proving
  the package boots, renders, replays deterministically, and round-trips
  on the PocketJS wasm sim host.

The runtime pins PocketJS with a git submodule at
`vendor/pocketjs` (commit recorded in `git submodule status`).

## Quick start

```sh
git clone --recurse-submodules <repo-url> pocket-rpgkit
cd pocket-rpgkit
bun install
bun test                 # 251 reducer/host-adapter unit tests (plain bun)
bun run build:wasm       # one-time: compile the vendored sim core
bun run build:example    # build the example bundle/pak into dist/
bun test                 # + 8 deterministic sim tests with pixel assertions
bunx tsc --noEmit        # typecheck, exit 0
```

`bun run gen-assets` regenerates the example's baked art from
`example/assets/src/`; the cooker is deterministic and its PNGs are
byte-stable across runs.

## The format in one screen

A project document (`"format": "rpgkit-project/v1"`) names a `start` tile,
tile `sheets`, `items`, and `maps`. A map has a dense row-major `ground`
array of `"sheet.cell"` tile ids (`null` is a blocking void), a sparse
`upper` star layer drawn above characters, sparse `passage` overrides, and
`events`. Each event owns ordered **pages**; the active page is the
highest-index page whose condition holds. A page names one trigger, an
optional sprite, motion (`moveType` or an authored `moveRoute`), and a
command list. `src/data/schema.json` is normative and
`src/engine/types.ts` carries the matching TypeScript types.

### The 15 commands

| op | purpose |
| --- | --- |
| `text` | typewriter dialog lines |
| `choices` | prompt with option branches and an optional cancel branch |
| `switch` | set a global switch |
| `variable` | set/add/sub or a seeded random range |
| `selfSwitch` | set the event-local A/B/C/D flag |
| `if` | condition over switch/variable/selfSwitch/item/gold, with `else` |
| `transfer` | swap maps at x/y/dir, with an optional fade |
| `moveRoute` | force the player or this event through a step list |
| `wait` | virtual-time pause (seconds, compiled against `simulationHz`) |
| `gold` | add/sub gold |
| `item` | add/remove an item count |
| `se` | emit a sound cue the host drains |
| `erase` | remove this event for the rest of the map visit |
| `exit` | end this fiber |
| `common` | run a common event's command list |

Triggers: `action` (confirm on the faced or occupied tile),
`playerTouch` (on cell entry), `autorun` (blocking, restarts after it
finishes), `parallel` (concurrent fiber per active page). Conditions
compile to forward jumps; no command can express a loop, and the runtime
backstops a hand-crafted cyclic program with a fatal interpreter error
instead of hanging the frame loop.

## Using it in your own project

The published package exports the engine surface (`pocket-rpgkit`), the
Solid components (`pocket-rpgkit/ui`), the fs adapter (`pocket-rpgkit/host`),
and the schema (`pocket-rpgkit/schema`). The in-repo example imports the
sources relatively; see `example/app.tsx` for the full shape:

```ts
import { createSession, startSession, stepSession } from "pocket-rpgkit";
import { DialogBox, PlayerSprite } from "pocket-rpgkit/ui";

const session = createSession(project, simulationHz());
let state = startSession(project, session);
onFrame((buttons) => {
  state = stepSession(session, state, { buttons, confirmEdge, /* ... */ });
  // state.move / state.chars / state.interp drive the Solid tree.
});
```

A game supplies its own project document, its own baked art (call the
`tools/lib/bake.ts` pipeline with its sheet PNGs), and its own walker
frame table; `PlayerSprite` receives the image keys as props and names no
asset paths itself.

Saves are FNV-checksummed envelopes over a safe-point snapshot (mover on a
tile boundary, no modal, no parked request). Hosts with `data.fs` write
three slots through `src/host/save-fs.ts`; other hosts exchange the same
envelope as URL-safe base64 text (the save code).

## Target matrix

The engine is host-free TypeScript; the targets below describe what the
PocketJS app using it can run on (the example builds for the fixed
480×272 viewport).

| host | runtime | notes |
| --- | --- | --- |
| `linux-app` / `macos-app` | PocketJS desktop host | `data.fs` save slots; resizable logical viewport letterboxes per `centerOffset` |
| `web-app` (wasm) | wasm core | same bundle; save codes when no fs mount |
| sim (`hosts/sim`) | wasm core, headless | deterministic tapes and framebuffer hashes; the example suite runs here |
| `psp` | PSP core | not gated by this repo; the vendor build's `pocket check --target psp` is the admission path for a consuming app (512px baked canvases, PSM_4444) |

## Repository layout

```
src/engine/      pure runtime (types, movement, passability, interpreter,
                 chars, session, camera, viewport, tiles, save*, schema-validate)
src/data/        schema.json (normative) + CHANGELOG
src/ui/          DialogBox, PlayerSprite, SaveMenu (Solid, presentation only)
src/host/        data.fs save adapter
tools/lib/       game-agnostic baking pipeline
tools/           example cooker and build driver
example/         minimal project (data + assets + PocketJS app)
tests/           unit suites + the wasm sim example suite
vendor/pocketjs  pinned PocketJS submodule
```

## License

MIT (`LICENSE`). Example art: Kenney Tiny Town (CC0 1.0) and Lanea
Zimmerman (Sharm) Tiny 16 (**CC-BY 3.0**, attribution required) — see
`example/ATTRIBUTION.md`.
