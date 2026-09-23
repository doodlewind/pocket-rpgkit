// src/engine/tiles.ts — tile id parsing and map helpers. Tile ids
// are "sheet.cell" strings per data/schema.json (rpgkit-project/v1); cell
// is a zero-based index into the sheet's cols*rows cell grid.

import type { MapDef, TileId } from "./types.ts";

/** Tile edge in pixels (the Kenney/Sharm source art is 16px cells). */
export const TILE = 16;

/** Prebaked chunk edge in pixels (pow2 <= spec TEX_MAX_DIM). */
export const CHUNK_PX = 512;

/** Tiles per chunk edge (512/16 = 32). */
export const CHUNK_TILES = CHUNK_PX / TILE;

export function parseTileId(id: string): { sheet: string; cell: number } {
  const dot = id.lastIndexOf(".");
  if (dot <= 0) throw new Error(`bad tile id ${JSON.stringify(id)} (want "sheet.cell")`);
  const sheet = id.slice(0, dot);
  const cell = Number(id.slice(dot + 1));
  if (!Number.isInteger(cell) || cell < 0) {
    throw new Error(`bad tile id ${JSON.stringify(id)}: cell must be a non-negative integer`);
  }
  return { sheet, cell };
}

export function cellX(cell: number, cols: number): number {
  return cell % cols;
}

export function cellY(cell: number, cols: number): number {
  return Math.floor(cell / cols);
}

export function indexAt(map: MapDef, tx: number, ty: number): number {
  return ty * map.width + tx;
}

export function groundAt(map: MapDef, tx: number, ty: number): TileId {
  return map.ground[indexAt(map, tx, ty)] ?? null;
}
