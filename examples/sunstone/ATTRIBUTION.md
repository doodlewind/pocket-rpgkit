# Asset attribution — The Sunstone of Bramble Hollow

All art in this example is CC0 or CC-BY. No RPG Maker or other commercial
game assets are included.

## Kenney — Tiny Town (village and forest tiles)

- File: `examples/sunstone/assets/src/town-tiles.png` (192×176, 12×11 grid
  of 16×16 cells).
- Source: https://kenney.nl/assets/tiny-town
- License: **CC0 1.0 Universal** (public domain dedication),
  https://creativecommons.org/publicdomain/zero/1.0/legalcode.
  Verbatim license text: `examples/sunstone/assets/src/LICENSE-kenney-town.txt`.
  Credit is not required by CC0 but is given: Kenney (www.kenney.nl).

## Kenney — Tiny Dungeon (cave tiles and characters)

- Files: `examples/sunstone/assets/src/dungeon-tiles.png` (192×176, 12×11
  grid of 16×16 cells) and the 13 cells under `assets/src/npc/` (wiz, boy,
  merchant, villager, slime, bat, chest-a/b/c, thorn, irongate, runestone,
  runestone-lit; each a 16×16 RGBA PNG).
- Source: https://kenney.nl/assets/tiny-dungeon
- License: **CC0 1.0 Universal** (public domain dedication),
  https://creativecommons.org/publicdomain/zero/1.0/legalcode.
  Verbatim license text:
  `examples/sunstone/assets/src/LICENSE-kenney-dungeon.txt`.
- `runestone-lit.png` is a recolour of a Tiny Dungeon stone cell (CC0; the
  derivative remains free to use under CC0).
  Credit is not required by CC0 but is given: Kenney (www.kenney.nl).

## Lanea Zimmerman (Sharm) — Tiny 16 basic character set (player)

- Files: `examples/sunstone/assets/src/hero-down.png`, `hero-left.png`,
  `hero-right.png`, `hero-up.png` (four 64×16 three-frame walker atlases).
- Source: https://opengameart.org/content/tiny-16-basic
  (Lanea Zimmerman, "Tiny 16", via OpenGameArt.org, downloaded 2026-09-17).
- License: **CC-BY 3.0**, https://creativecommons.org/licenses/by/3.0/legalcode
  (the source page also offers CC-BY 4.0 and OGA-BY 3.0; used under
  CC-BY 3.0).
- Required credit: **Lanea Zimmerman (Sharm), "Tiny 16"**, via
  OpenGameArt.org.

## Generated in this repository

- `examples/sunstone/assets/map-{village,forest,cave}-{ground,upper}.png` —
  512×512 PSM_4444 map canvases baked by `examples/sunstone/gen-assets.ts`
  from the Kenney sheets above (CC0; derivatives remain free to use under
  CC0).
- `examples/sunstone/assets/npc/*.png` — the 13 character cells, copied
  verbatim from Kenney Tiny Dungeon (CC0).
- `examples/sunstone/assets/player-dir0..3.png` (idle) and
  `player-pose{0..3}-{l,r}.png` (walk extremes) — 16×16 crops of the Sharm
  walker atlases; no pixels were altered (CC-BY 3.0; the credit line above
  applies).
- `tests/goldens/sunstone-*.png` — frames rendered by the PocketJS wasm sim
  from the assets above; the same licenses apply.
