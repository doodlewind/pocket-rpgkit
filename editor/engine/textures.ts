// editor/engine/textures.ts — maps a project tile id
// ("sheet.cell") to the pak-baked 16x16 IMG src key an Image node binds.
// Every cell is baked at build time by gen-assets.ts (one PSM_8888 PNG per
// cell), so the same tile pixels render on every host — including the wgpu
// desktop host (Metal), whose renderer samples pak-baked image textures.

import { TILE_SRC } from "./tile-keys.ts";

export interface TileTextures {
  /** The pak IMG src key for a tile id, or null when it is not a cell. */
  key: (tileId: string) => string | null;
  /** Number of distinct cell keys available. */
  uploaded: () => number;
}

export function createTileTextures(): TileTextures {
  return {
    key: (tileId: string) => TILE_SRC[tileId] ?? null,
    uploaded: () => Object.keys(TILE_SRC).length,
  };
}
