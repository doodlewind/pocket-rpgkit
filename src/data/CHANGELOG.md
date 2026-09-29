# rpgkit-project format changelog

The format marker on every project document is the `format` string,
currently `"rpgkit-project/v1"` (`src/data/schema.json` is normative;
`src/engine/types.ts` carries the TypeScript types).

## v1 — 2026-09-23 (component extraction release 0.1.0)

First frozen release of the format, extracted from the PocketJS app
`apps/rpgkit` integration branch I3 (`pocketjs@780218d7` plus the merged
P1①–P1⑤ runtime work).

- Project: `format`, `title`, `tileSize` (16), `start` (map/x/y/dir),
  optional `initialGold`, `sheets`, `items`, optional `sprites`,
  `commonEvents`, `maps`.
- Maps: dense row-major `ground` tile ids (`"sheet.cell"`, `null` is a
  blocking void), sparse `upper` star layer, sparse `passage` overrides,
  `events`.
- Sheets: 16px-cell grids with `defaultPassage`, `block`/`pass` cell lists,
  and per-cell `dirBlock` edge masks (see the 2026-09-27 amendment).
- Events: ordered pages; each page has one trigger
  (`action` | `playerTouch` | `autorun` | `parallel`), an optional
  condition (`switch` | `selfSwitch` | `variable` | `item`), an optional
  static `sprite`, `blocks`, autonomous `moveType`
  (`static` | `random` | `approach`) or an authored `moveRoute`, and a
  command list.
- Commands, 15: `text`, `choices`, `switch`, `variable`, `selfSwitch`,
  `if`, `transfer`, `moveRoute`, `wait`, `gold`, `item`, `se`, `erase`,
  `exit`, `common`.

## v1 amendment — 2026-09-27 (release 0.2.0)

Two changes landed in the PocketJS working copy after the extraction and
are folded into v1 here, while the only v1 documents are this
repository's own examples:

- `dirBlock` follows RPG Maker MV's directional passage: an entry bars
  its edge in **both** directions (leaving the cell through that edge and
  entering it through that edge from outside). A step is refused when the
  source cell bars the step direction or the target cell bars the reverse
  one. v1.0 read the mask as exit-only; a document that relied on a
  one-way exit must now use a `passage` override instead.
- Event ids, and `switch`/`variable` ids, may contain uppercase letters
  (`^[A-Za-z0-9_-]+$`, `^[A-Za-z0-9_.-]+$`). Every document valid under
  v1.0 stays valid.

## v1 amendment — 2026-09-29 (K1 event-model extension)

Six optional, backwards-compatible event-model additions (T2-1, T2-2,
T2-3, T2-6, T2-7, T2-8). Every v1.0/v1.1 document stays valid; all new
fields and commands are optional and the v1 spellings keep their meaning.

- **Event areas (T2-1):** an event may occupy a rectangle with optional
  `w` / `h` (default 1×1; minimum 1). A `playerTouch` page fires when the
  player enters ANY cell of the rectangle (each step onto a fresh area
  cell is a new entry), and an `action` page fires when the player
  confirms while the faced tile OR the occupied tile lies inside it.
- **Compound page conditions (T2-2):** a page condition may carry
  `all: Condition[]`, an AND of existing switch (either value), variable,
  self-switch, item and gold conditions. It ANDs with the flat
  `switch` / `selfSwitch` / `variable` / `item` fields when both are used.
- **Facing conditions (T2-3):** a new `{ kind: "facing", dir }` condition
  (usable in `if` and in `condition.all`) tests the live player facing. A
  `playerTouch` page whose condition reads facing also re-fires when the
  player turns in place while standing inside its area — modelling a
  door/exit mat that only opens when faced, not when crossed sideways.
- **Per-visit `local.` variables (T2-6):** any switch or variable whose id
  starts with `local.` is reset on every map entry (it does not survive a
  transfer). Non-`local.` ids remain project-wide.
- **Place event and initial facing (T2-7):** a `place` command
  (`{ op: "place", target, x, y, dir? }`, target `"this"` or
  `{ event: id }`) relocates an event to a tile, optionally facing a
  direction (MV Set Event Location). A page may also set `dir` for the
  facing its character shows when that page spawns it (and after a page
  switch).
- **Cross-event input lock (T2-8):** `{ op: "lockInput" }` and
  `{ op: "unlockInput" }`. While the lock is held the mover ignores the
  d-pad and action presses start no event; `autorun` / `parallel` pages
  keep running. The lock is per map visit (a transfer clears it) and its
  held state is preserved by a save.

## v1 amendment — 2026-09-29 (player name, tall walkers)

- `playerName` optionally supplies the fresh-session value substituted for
  `{name}` in text and choice prompts. The value lives in save state after
  startup.
- A `walker` sprite may name a build-time source `sheet` id/path with optional `h`, `cols` and
  `rows`. The default is a 3-column by 4-row sheet of 16×32 frames; the asset
  cooker slices it into idle/left-step/right-step images for four facings.
  The original per-direction `atlases` walker declaration remains valid.

## v1 amendment — 2026-09-29 (movement extensions)

- **One-sided passage edges:** a sheet may declare `dirEdges`, keyed by
  cell, with optional `enter` and `exit` direction lists. `enter` refuses
  stepping into the cell across that edge; `exit` refuses leaving it across
  that edge. The existing `dirBlock` keeps its symmetric meaning (both
  leaving and entering through the edge).
- **Routes on any event:** `moveRoute` takes an optional `target`
  (`"player"`, `"this"` or `{ event: id }`) with the existing `wait`
  semantics.
- **Turn and path steps:** route steps `turnTowardPlayer`,
  `{ turnToward: target }`, `{ pathTo: { x, y, retries? } }` and
  `{ approach: { target, retries? } }`. Path searches are deterministic
  breadth-first searches split across reference ticks (independent of the
  host rate); a blocked step waits and replans at most `retries` times
  before the route ends.

Breaking changes to any of the above require a new marker
(`rpgkit-project/v2`) and a new entry here.
