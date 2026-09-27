# Asset attribution — minimal example

The example (`examples/meadow/`) ships only the art it actually uses. No
RPG Maker or other commercial game assets are included.

## Kenney — Tiny Town (map tiles)

- File: `examples/meadow/assets/src/town-tiles.png` (192×176, 12×11 grid of
  16×16 cells).
- Source: https://kenney.nl/assets/tiny-town
- License: **CC0 1.0 Universal** (public domain dedication),
  https://creativecommons.org/publicdomain/zero/1.0/legalcode.
  Verbatim license text: `examples/meadow/assets/src/LICENSE-kenney-town.txt`.
- The baked `examples/meadow/assets/meadow-ground.png` and
  `meadow-upper.png` (512×512, PSM_4444) are generated from this sheet by
  `examples/meadow/gen-assets.ts` via the game-agnostic pipeline in
  `tools/lib/bake.ts`.
  Credit is not required by CC0 but is given: Kenney (www.kenney.nl).

## Lanea Zimmerman (Sharm) — Tiny 16 basic character set (player)

- Files: `examples/meadow/assets/src/hero-down.png`, `hero-left.png`,
  `hero-right.png`, `hero-up.png` (four 64×16 three-frame walker atlases).
- Source: https://opengameart.org/content/tiny-16-basic
  (Lanea Zimmerman, "Tiny 16", via OpenGameArt.org, downloaded 2026-09-17).
- License: **CC-BY 3.0**, https://creativecommons.org/licenses/by/3.0/legalcode
  (the source page also offers CC-BY 4.0 and OGA-BY 3.0; used under
  CC-BY 3.0).
- Required credit: **Lanea Zimmerman (Sharm), "Tiny 16"**, via
  OpenGameArt.org.
- `examples/meadow/assets/player-dir0..3.png` (idle) and
  `player-pose{0..3}-{l,r}.png` (walk extremes) are crops of the atlases;
  no pixels were altered.

## Generated in this repository

- `examples/meadow/assets/meadow-ground.png`, `meadow-upper.png` — 512×512
  baked canvases produced by `examples/meadow/gen-assets.ts` from the
  Kenney sheet above (CC0; derivatives remain free to use under CC0).
- `examples/meadow/assets/player-*.png` — 16×16 frames cropped from the
  Sharm walker atlases above (CC-BY 3.0; the credit line above applies).
