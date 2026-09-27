# Asset attribution — rule-grown settlement

All art in this example is CC0 or CC-BY. No RPG Maker or other commercial
game assets are included.

## Pixel-Boy and AAA — Ninja Adventure (terrain, village, villagers)

- Files: `examples/grow/assets/src/ninja-adventure/tileset-floor.png`,
  `tileset-village.png`, `samurai-green.png`, `TilesetNature.png`,
  `TilesetHouse.png`, `TilesetDesert.png` (the last three from the pack's
  `Backgrounds/Tilesets/`). The pack's GitHub repository ships only the
  game's four map sheets; the three full-pack sheets were taken from a
  public project that vendors the unmodified pack
  (https://github.com/MarioLDD/Kuroshiro-adventure,
  `Assets/NinjaAdventure/Backgrounds/Tilesets/`, whose `LICENSE.txt` is the
  same CC0 text). Its `TilesetFloor.png` is byte-identical to the official
  repository's `tileset_floor.png`, which is how provenance was checked.
- Sources: https://pixel-boy.itch.io/ninja-adventure-asset-pack and
  https://github.com/pixel-boy/NinjaAdventure.
- License: **CC0 1.0 Universal** (public domain dedication),
  https://creativecommons.org/publicdomain/zero/1.0/legalcode.
  The author's verbatim notice is in
  `examples/grow/assets/src/ninja-adventure/LICENSE-ninja-adventure.txt`.
  Credit is not required by CC0 but is given: **Ninja Adventure Asset Pack
  — Pixel-Boy and AAA**.

## Lanea Zimmerman (Sharm) — Tiny 16 basic character set (player)

- Files: `examples/grow/assets/player-dir0..3.png` (idle) and
  `player-pose{0..3}-{l,r}.png` (walk extremes), the same 16×16 crops of
  the "Tiny 16" walker atlases the Sunstone example ships in
  `examples/sunstone/assets/src/hero-*.png`; no pixels were altered.
- Source: https://opengameart.org/content/tiny-16-basic
  (Lanea Zimmerman, "Tiny 16", via OpenGameArt.org, downloaded 2026-09-17).
- License: **CC-BY 3.0**, https://creativecommons.org/licenses/by/3.0/legalcode.
- Required credit: **Lanea Zimmerman (Sharm), "Tiny 16"**, via
  OpenGameArt.org.

## Generated in this repository

- `examples/grow/assets/grow-terrain-*.png`, `grow-ground-*.png`,
  `grow-upper-*.png`, `grow-villager.png` — 16×16 cells and 256×256 fill
  blocks written by `examples/grow/gen-assets.ts`:
  - cottages, tents and broadleaf trees are resampled from Ninja Adventure
    (CC0) and split into cells; dark-woodland, desert and snow variants are
    palette shifts of those pixels (CC0);
  - `grow-upper-128.png` and above are the stamp cells listed in
    `grow-stamps.ts`, cropped from the three full-pack sheets (CC0; igloo
    lavender shading is pulled toward ice blue);
  - `grow-villager.png` is the Ninja samurai crop (CC0);
  - terrain fills, three-cell transitions, fields, paths, river banks,
    bridges, fences, the well, notice board, timber stacks, stalls, small
    plants, palms and firs are original pixel recipes in `grow-art.ts`,
    dedicated under **CC0 1.0**,
    https://creativecommons.org/publicdomain/zero/1.0/.
- `tests/goldens/grow*.png` — frames rendered by the PocketJS wasm sim from
  the assets above; the same licenses apply.
