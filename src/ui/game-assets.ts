// src/ui/game-assets.ts — the baked-asset manifest GameView renders a
// project with. A game's asset cooker (examples/sunstone/gen-assets.ts,
// using tools/lib/chunks.ts gameManifestSource) writes one as plain .ts
// with full string literals, so the PocketJS pak pass bakes every name.

import type { PlayerFrames } from "./PlayerSprite.tsx";

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
}
