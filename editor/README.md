# Pocket RPG Kit — Editor (preview)

A tile-map editor for `rpgkit-project/v1` documents, running as a
PocketJS app on the portable desktop host. It opens the kit's example
projects (`examples/sunstone`, `examples/meadow`) and paints them with
those examples' own tile art.

## What it does

- **Tile painting**: click or drag on the canvas to paint ground cells.
  The header **LAYER** button switches to the sparse upper (star) layer,
  drawn above characters at runtime. Right click or shift+click erases;
  palette slot 0 is the eraser brush.
- **Undo/redo**: every drag stroke is one history step, 64 steps deep.
  **UNDO**/**REDO** in the header, or Cmd+Z / Cmd+Shift+Z (Ctrl on Linux).
- **Maps**: **<** and **>** switch between the document's maps; the palette
  shows every cell of the sheets the current map declares.
- **Open and save**: the document is parsed and checked against
  `src/data/schema.json` on load, and again before every save, which
  refuses an invalid export with the first schema error in the status bar.
  An unedited document saves back byte for byte.
- **Event markers**: every event is drawn as a translucent marker on its
  cell, above both tile layers.

Not yet: editing events (adding, moving, or changing pages and commands),
map properties, passage overrides, or new maps. The editor never touches
those parts of a document.

## Running

```sh
bun run editor              # dist/editor/sunstone.json, a working copy
bun run editor meadow       # dist/editor/meadow.json
bun run editor sunstone --file my-map.json   # edit another file; seeded from
                                             # the example document if missing
                                             # (relative paths start at the
                                             # repository root)
bun run editor --build-only # bundle + release host, no window
bun run editor meadow -- --quit-after 600    # extra host flags pass through
```

`tools/editor.ts` resolves `editor/pocket.json` for the desktop target
(macos-app on a Mac, linux-app elsewhere), builds the bundle into
`dist/<target>/editor.{js,pak}`, builds the Rust host with
`cargo build --release`, and starts it with the `rpgkit-editor` companion
and `--file`. The host forwards the real mouse and keyboard to the editor,
sends the file's text at boot, and writes each SAVE (header button or
Cmd+S) back to that file through a temp file and a rename.

**Working copies.** The examples author their projects in code
(`examples/sunstone/game-data.ts`, `examples/meadow/mini-project.ts`);
`data/*.json` is what their cookers emit, and the games themselves still
build from code. So by default the editor works on a copy in
`dist/editor/`, seeded from the example document the first time. Passing
`--file examples/sunstone/data/sunstone.json` edits the example document
itself, but `bun run gen-assets` rewrites it from code and drops the edits,
and `tests/editor-model.test.ts` notices a document that no longer matches
the editor's bundled copy.
Once the host file is open, the **DOC** button is disabled, so SAVE can
never write a different project into it.

Mouse wheel scrolls the palette; the arrow keys move the gamepad cursor,
which pans the view on maps larger than the 20×14-cell window.

### Without the companion

On a host without the `rpgkit-editor` channel (the wasm sim, a browser),
the editor shows an amber banner and runs entirely from buttons: the d-pad
moves a cursor across canvas, palette and header, **CIRCLE** paints or
activates, **CROSS** erases, **SQUARE**/**TRIANGLE** undo/redo, **L**/**R**
switch maps, **SELECT** toggles the layer, **START** saves. **DOC** cycles
the bundled documents. On a host with `data.fs` a save goes to
`projects/<id>.json` under the app's data root and wins over the bundled
copy at the next boot; with neither channel the save is refused with a
visible notice.

## Building and testing

```sh
bun run build:editor        # dist/editor.{js,pak} for the sim tests
bun test tests/editor-model.test.ts tests/editor-sim.test.ts
bun editor/gen-assets.ts    # regenerate the editor's baked inputs
```

`bun run build:example` builds the editor along with the examples, and
`bun run gen-assets` runs the editor cooker after the example cookers
(it reads their documents). The cooker is deterministic: two runs produce
identical bytes.

The sim suite drives both input modes on the wasm sim host with semantic
pixel checks (banner, palette art and selection, tile art, markers,
letterbox hit-testing), svc save/load lines, the data.fs store, a
byte-identical round trip of both documents, and a runtime session booted
from an edited export.

## Layout

```
editor/
  editor.tsx, app.tsx   entry and shell (header, palette, canvas, status)
  svc.ts                the rpgkit-editor companion channel (svc lines)
  store.ts              data.fs project documents (gamepad mode)
  sources.ts            which example documents and sheets the cooker reads
  gen-assets.ts         the cooker (below)
  engine/document.ts    parse, schema-check, canonical serialize
  engine/model.ts       pure edit reducer: strokes, layers, maps, history
  engine/layout.ts      fixed geometry and pointer hit-testing
  engine/cursor.ts      buttons-mode cursor reducer
  engine/textures.ts    tile id -> baked image key
  ui/canvas.tsx         map window: ground, star layer, markers, cursors
  ui/panels.tsx         header buttons, palette strip, gamepad banner
  pocket.json           manifest: dynamic 720x480 viewport, companion
generated by gen-assets.ts (committed):
  assets/tile-<sheet>-<cell>.png   one 16x16 PNG per sheet cell
  images.json                      their PSM marks
  engine/tile-keys.ts              tile id -> pak image literal
  engine/sheets.ts                 sheet grids and source files
  engine/projects.ts               bundled documents + schema copy
```

## Art and licenses

The editor ships no art of its own. `assets/tile-*.png` are 16×16 cells
cut, unaltered, from the examples' source sheets:
`examples/sunstone/assets/src/town-tiles.png` (Kenney Tiny Town) and
`examples/sunstone/assets/src/dungeon-tiles.png` (Kenney Tiny Dungeon),
both CC0 1.0. Meadow's `town-tiles.png` is the same file byte for byte;
the cooker refuses two examples whose sheets share an id but differ. See
`examples/sunstone/ATTRIBUTION.md` and `examples/meadow/ATTRIBUTION.md`
for sources and license texts.
