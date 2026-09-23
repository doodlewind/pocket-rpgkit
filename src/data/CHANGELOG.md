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
  and per-cell `dirBlock` exit masks.
- Events: ordered pages; each page has one trigger
  (`action` | `playerTouch` | `autorun` | `parallel`), an optional
  condition (`switch` | `selfSwitch` | `variable` | `item`), an optional
  static `sprite`, `blocks`, autonomous `moveType`
  (`static` | `random` | `approach`) or an authored `moveRoute`, and a
  command list.
- Commands, 15: `text`, `choices`, `switch`, `variable`, `selfSwitch`,
  `if`, `transfer`, `moveRoute`, `wait`, `gold`, `item`, `se`, `erase`,
  `exit`, `common`.

Breaking changes to any of the above require a new marker
(`rpgkit-project/v2`) and a new entry here.
