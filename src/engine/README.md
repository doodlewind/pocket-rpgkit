# rpgkit engine

Pure-TS simulation core for Pocket RPG Kit. Every module here is a plain
reducer: no host imports, no wall clock, no `Math.random`. The host folds
`step(state, input) -> state` once per virtual frame and renders from
state.

## Modules

- `camera.ts` — free-scroll camera reducer, the follow camera, and the BTN
  mask mirror.
- `viewport.ts` — centering offset for maps smaller than the host viewport.
- `start.ts` — camera placement derived from a project's start tile.
- `tiles.ts` — tile ids and the baked-chunk constants.
- `motion-clock.ts` — the fixed 60 Hz motion reference and how many
  reference ticks one host frame folds.
- `passability.ts`, `movement.ts` — tile collision (dual-edge `dirBlock`
  masks, blocking bodies) and the grid mover.
- `interpreter.ts` — event pages, triggers, the 15-command interpreter,
  the typewriter clock, the seeded RNG, saveable switch state.
- `chars.ts` — per-map character motion: page patrol routes, autonomous
  random/approach, command-forced routes, mutual exclusion.
- `session.ts` — the multi-map fold: transfer (map swap + fade) and
  moveRoute completion across the mover / characters / interpreter.
- `clone.ts` — host-portable deep copy (the desktop QuickJS realm has no
  `structuredClone`).
- `schema-validate.ts` — zero-dependency checker for the JSON schema
  subset `../data/schema.json` uses.
- `save.ts`, `save-validate.ts`, `save-restore.ts`, `save-menu.ts` —
  save envelope/codecs, structural validation, the map-aware restore gate,
  and the save-menu navigation reducer.
- `attract.ts`, `tape.ts` — the attract/takeover/rewind controller over
  one unified u16 input stream, and RLE/devtools tape helpers.
- `journey-search.ts` — A* over real reducer frames, for deterministic
  journey drivers on hosts whose frame spans several reference ticks.
- `types.ts` — the `rpgkit-project/v1` vocabulary (normative schema:
  `../data/schema.json`).

## P1② ↔ P1③ integration contract

The interpreter does not move the player. The host owns a mover (P1②'s
`stepMovement`) and feeds the interpreter the player's tile each frame.

```ts
import {
  createWorld, createInterpState, stepInterp, isBusy,
  continueExternal, type InterpInput, type World, type InterpState,
} from "./interpreter.ts";

const world: World = createWorld(map, project.commonEvents ?? [], hz);
let interp = createInterpState();

// each virtual frame, AFTER the mover has run:
if (!isBusy(interp)) {
  // mover runs only while no blocking fiber owns the session (an open
  // dialog, a choices box, a wait, an autorun).
  movement = stepMovement(movement, buttons, passageTable);
}
const input: InterpInput = {
  confirmEdge, cancelEdge, upEdge, downEdge,   // pressed-this-frame edges
  playerCell: { x: tileX, y: tileY },          // mover cell this frame
  prevCell: { x: prevTileX, y: prevTileY },    // mover cell last frame
  facing,                                      // 0 down, 1 left, 2 up, 3 right
};
interp = stepInterp(world, interp, input);

// P1④ hooks: when a fiber parks on a transfer or a waiting move route, the
// result carries exactly one pending* payload; perform the work, then resume:
if (interp.pendingTransfer) { /* swap map, move player; fade frames */ }
if (interp.pendingMoveRoute) { /* walk the route steps */ }
interp = continueExternal(interp, fiberKey);
```

Conventions:

- `facing` is the `Facing` index both the camera and mover emit:
  0 down, 1 left, 2 up, 3 right. Action-button events trigger on the event
  one tile **in front** of `playerCell` on that facing.
- `playerTouch` events trigger on the frame the player's cell **enters**
  the event cell (`playerCell !== prevCell`); standing still never fires,
  and the event does not refire until the player leaves and re-enters.
- `isBusy(state)` is true while a blocking (action / playerTouch / autorun)
  fiber runs. The mover freezes for its whole duration. PARALLEL pages run
  concurrently and never set busy.
- Edges are one frame wide: the host computes `pressed = buttons & ~prev`
  for CIRCLE (confirm), CROSS (cancel), UP and DOWN and passes booleans.
- `state.cues` lists sound effects emitted by commands on the latest step;
  drain it after every step (it is cleared at the top of the next one).
- All switch/variable/item/gold values and the mulberry32 RNG cursor live
  in `state.sw`, a plain JSON-serializable object: the P1⑤ save snapshot.

## P1④ session (multi-map) fold

For a multi-map game the host does not drive the mover and interpreter by
hand; `session.ts` folds all three reducers per virtual frame:

```ts
import { createSession, startSession, stepSession } from "./session.ts";

const session = createSession(project);        // maps, worlds, passage tables
let state = startSession(project, session);    // project.start position/dir
state = stepSession(session, state, {          // once per virtual frame
  buttons, confirmEdge, cancelEdge, upEdge, downEdge,
});
```

`stepSession` owns the frame order:

1. **characters.syncPages** — reconcile NPCs with active pages; a page
   switch aborts a forced route and resumes its parked waiter.
2. **mover** — frozen while a blocking fiber runs or the player's own
   command route is driving; collision adds blocking character bodies.
3. **characters.stepChars** — patrol / random / approach / forced motion.
4. **interpreter.stepInterp** — fed the live NPC cells for trigger scans.
5. **external requests** — a `transfer` swaps map/fresh-interp/characters
   while keeping `state.sw`; `moveRoute` installs on an NPC (or the
   player) and resumes its fiber when the route lands.

Transfer semantics:

- A transfer rebuilds the map interpreter and returns every character to
  its authored cell (MV map-load semantics); switches, items, variables,
  gold and the RNG cursor in `state.sw` survive. Same-map transfers reset
  the same way.
- `fade > 0` freezes gameplay for the fade: fade-out half, swap on the
  first fully-black frame, fade-in half (`fadeOpacity(state.fade)` is the
  overlay alpha the UI binds).
- The render structure that makes a transfer cheap is one ground and one
  upper `Image` per **current** map plus per-map NPC containers: a swap is
  an `Image` src change and a container `display` toggle — O(maps), not the
  1998-op sliding-chunk burst the R1 review measured.
