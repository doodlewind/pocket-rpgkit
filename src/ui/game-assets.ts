// src/ui/game-assets.ts — the baked-asset manifest GameView renders a
// project with. A game's asset cooker (examples/sunstone/gen-assets.ts,
// using tools/lib/chunks.ts gameManifestSource) writes one as plain .ts
// with full string literals, so the PocketJS pak pass bakes every name.

import type { PlayerFrames } from "./PlayerSprite.tsx";

export interface StreamedGameAssets {
  /** Edge of each TILESET chunk texture (normally 256px). */
  chunkPx: number;
  /** Map id -> row-major streamed ground refs (`ui:tile.*#index`). */
  ground: Readonly<Record<string, readonly (string | null)[]>>;
  /** Map id -> row-major streamed upper refs; null chunks stay unmounted. */
  upper: Readonly<Record<string, readonly (string | null)[]>>;
  /** Map id -> chunk columns shared by ground and upper. */
  columns: Readonly<Record<string, number>>;
  /** Pixel prefetch margin around the viewport (default 16). */
  margin?: number;
  /** Texture loads per layer per frame (default unlimited). */
  loadBudget?: number;
}

export interface GameAssets {
  /** Map id -> row-major baked 512x512 ground chunks. */
  ground: Readonly<Record<string, readonly string[]>>;
  /** Map id -> row-major baked 512x512 star-layer chunks. */
  upper: Readonly<Record<string, readonly string[]>>;
  /** Map id -> number of chunk columns in each layer. */
  chunkColumns: Readonly<Record<string, number>>;
  /** Maximum chunk slots mounted for one map. */
  maxChunks: number;
  /** Map id -> map size in pixels. */
  world: Readonly<Record<string, { w: number; h: number }>>;
  /** Map ids in NPC-container mount order. */
  order: readonly string[];
  /** Page.sprite key -> baked 16x16 character image. */
  npcSrc: Readonly<Record<string, string>>;
  /** The player's 12 static walker frames. */
  player: PlayerFrames;
  /** Optional viewport-streamed map art. When present GameView does not mount
   * the legacy eager ground/upper image grids. */
  stream?: StreamedGameAssets;
}
