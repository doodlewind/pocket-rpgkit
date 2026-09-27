# pocket-rpgkit

A reusable 2D tile-RPG runtime and the **`rpgkit-project/v1`** data format,
built on [PocketJS](https://github.com/pocket-stack/pocketjs). It contains
the parts an RPG-Maker-style game needs without any specific game:

- **pure-TS engine** (`src/engine/`) — tile movement and collision, the
  event interpreter (pages, triggers, 15 commands), map-character motion,
  multi-map sessions, deterministic save snapshots. No host imports, no
  wall clock, no `Math.random`: a session is one pure fold per virtual
  frame, so a button tape replays byte-for-byte on every host;
- **Solid UI components** (`src/ui/`) — `GameView`, a complete game screen
  for a project (chunked maps, follow camera, NPCs, dialog, fades, and
  optional attract mode), plus the blocks it is made of: `DialogBox`,
  `PlayerSprite`, `ChunkLayer`, `SaveMenu`;
- **attract mode** (`src/engine/attract.ts`) — after 10 idle seconds a
  recorded playthrough replays from a clean world; any button takes over
  on that very frame, **L** rewinds 3 virtual seconds, **SELECT** hands
  the session back to the demo. Demo and player input are one u16 stream,
  so rewind undoes the player's moves exactly like the tape's;
- **host adapters** (`src/host/`) — the `data.fs` save slot store and the
  attract-tape override loader;
- **build-time asset pipelines** (`tools/lib/`) — tile sheets to baked
  512px PSM_4444 canvases and chunks, static walker frames, and the
  `GameAssets` manifest a game mounts;
- **the format** (`src/data/schema.json`, v1; changes recorded in
  `src/data/CHANGELOG.md`);
- **three examples** (`examples/`), each a PocketJS app with its own art
  and tests on the wasm sim host (below).

## Examples

| | |
| --- | --- |
| ![Sunstone attract takeover](tests/goldens/sunstone-attract.700.png) | ![Grown village, snow biome](tests/goldens/grow.2028.png) |
| **`examples/sunstone`** — *The Sunstone of Bramble Hollow*, a three-map RPG (village → forest → cave: key chest, rune stone, thorn and iron gates, the relic). Idle for 10 s and it plays itself from a frozen 539-frame winning tape; press any button to take over mid-demo, **L** to rewind. | **`examples/grow`** — four settlements grow to the right from one seeded rule set (roads, homes, fields, residents) through grass, mud, sand and snow. Scrub the timeline (**L/R**, touch, or mouse drag) to any tick — each is a pure re-grow — **SQUARE** for a new seed, **CIRCLE** to walk into the finished village, which is played as a generated `rpgkit-project/v1` document. |

**`examples/meadow`** is the minimal example: one 20×12 map and four
events proving the package boots, renders, replays deterministically,
and round-trips on the PocketJS wasm sim host.

Everything runs on a fixed 60 Hz virtual-time reference: a host at 30,
20 or 4 Hz folds 2, 3 or 15 reference ticks per frame, so the world at a
given virtual moment is the same at every rate (the journey tests drive
each example's winning run at 60/30/20/4 Hz and compare milestones).

The runtime pins PocketJS with a git submodule at
`vendor/pocketjs` (commit recorded in `git submodule status`).

## Quick start

```sh
git clone --recurse-submodules <repo-url> pocket-rpgkit
cd pocket-rpgkit
bun install
bun test                 # reducer/format/controller suites; sim cases skip
bun run build:wasm       # one-time: compile the vendored sim core
bun run build:example    # build meadow, sunstone, grow into dist/
bun test                 # 428 tests incl. sim journeys and pixel goldens
bunx tsc --noEmit        # typecheck, exit 0
bun run desktop sunstone # build for the desktop host and open a window
                         # (also: grow, meadow; needs a Rust toolchain)
```

`bun run build:example sunstone` builds one example. `bun run gen-assets`
regenerates every example's baked art from its `assets/src/`; the cookers
are deterministic and reproduce the committed PNGs byte for byte.

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
Solid components (`pocket-rpgkit/ui`), the host adapters
(`pocket-rpgkit/host`), and the schema (`pocket-rpgkit/schema`). The
in-repo examples import the sources relatively, because PocketJS's build
pass 1 walks relative imports; `examples/meadow/meadow.tsx` shows the
reducer loop by hand:

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

and `examples/sunstone/sunstone.tsx` mounts the whole screen:

```tsx
import { GameView } from "pocket-rpgkit/ui";
import { loadAttractTape } from "pocket-rpgkit/host";

mount(() => (
  <GameView project={project} assets={GAME_ASSETS}
            attractTape={loadAttractTape(DEMO_TAPE_RUNS).masks} />
));
```

A game supplies its own project document, its own baked art (the
`tools/lib/chunks.ts` pipeline turns its sheet PNGs into map chunks and
writes the `GameAssets` manifest), and its own walker frames; the
components name no asset paths themselves. To give a game attract mode,
write a deterministic journey driver (`examples/sunstone/journey.ts`;
`searchWalk` in `src/engine/journey-search.ts` plans the walks on hosts
slower than 60 Hz), freeze its 60 Hz masks as an RLE tape, and pass the
tape to `GameView`. On a host with `data.fs`, an `attract-tape.json` at
the app's data root replaces the built-in tape without a rebuild.

Saves are FNV-checksummed envelopes over a safe-point snapshot (mover on a
tile boundary, no modal, no parked request). Hosts with `data.fs` write
three slots through `src/host/save-fs.ts`; other hosts exchange the same
envelope as URL-safe base64 text (the save code).

## Target matrix

The engine is host-free TypeScript; the targets below describe what the
PocketJS app using it can run on. The examples declare the fixed 480×272
viewport plus a live dynamic viewport on desktop hosts, where `GameView`
letterboxes small maps and follows the player on large ones.

| host | runtime | notes |
| --- | --- | --- |
| `linux-app` / `macos-app` | PocketJS desktop host | `data.fs` save slots; resizable logical viewport letterboxes per `centerOffset` |
| `web-app` (wasm) | wasm core | same bundle; save codes when no fs mount |
| sim (`hosts/sim`) | wasm core, headless | deterministic tapes and framebuffer hashes; the example suites run here |
| `psp` | PSP core | not gated by this repo; the vendor build's `pocket check --target psp` is the admission path for a consuming app (512px baked canvases, PSM_4444) |

## Repository layout

```
src/engine/      pure runtime (types, motion-clock, movement, passability,
                 interpreter, chars, session, camera, viewport, tiles,
                 save*, schema-validate, attract, tape, journey-search)
src/data/        schema.json (normative) + CHANGELOG
src/ui/          GameView, ChunkLayer, DialogBox, PlayerSprite, SaveMenu
src/host/        data.fs save adapter, attract-tape loader
tools/lib/       game-agnostic baking pipelines (bake.ts, chunks.ts)
tools/           example build driver
examples/        meadow (minimal), sunstone (game + attract), grow (demo);
                 each has its entry, data, assets/src, gen-assets.ts,
                 images.json, pocket.json and ATTRIBUTION.md
tests/           unit suites, sim suites, goldens/
vendor/pocketjs  pinned PocketJS submodule
```

## License

MIT (`LICENSE`). Example art: Kenney Tiny Town and Tiny Dungeon (CC0 1.0),
Pixel-Boy and AAA's Ninja Adventure (CC0 1.0), and Lanea Zimmerman
(Sharm) Tiny 16 (**CC-BY 3.0**, attribution required) — see each
example's `ATTRIBUTION.md`.
