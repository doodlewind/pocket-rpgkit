// src/engine/passability.ts — walkable/blocked lookup for P1②.
//
// Precedence, high to low:
//   1. map edge        — outside the width/height rectangle blocks
//   2. map.passage     — sparse [index, "pass"|"block"] overrides (fences
//                        painted on grass; a gate re-opening a fence cell)
//   3. ground void     — a null ground tile is a blocking void
//   4. sheet flags     — sheet.defaultPassage plus block[]/pass[] cell lists
//                        and dirBlock masks (data/schema.json sheet def)
//
// A dirBlock entry is authored on ONE tile but guards TWO edges of a step:
// the mask on the SOURCE tile forbids LEAVING through the named edge, and
// the same mask on the TARGET tile forbids ENTERING through that edge from
// outside. A step east crosses the source tile's "right" edge and the
// target tile's "left" edge, so both are checked (task-1206 contract).
//
// The upper star layer NEVER blocks (schema: "always walkable"); trees and
// fences collide through a ground/passage entry, not by being drawn.
//
// Pure TS: the sheet table is injected as a Map so this module has no
// project/schema dependency and runs under plain bun.

import type { MapDef, Sheet, TileId } from "./types.ts";
import { parseTileId } from "./tiles.ts";

export type Dir4 = 0 | 1 | 2 | 3; // 0 down, 1 left, 2 up, 3 right (Facing order)

/** Pre-cooked, allocation-free lookup for one map. */
export interface PassageTable {
  width: number;
  height: number;
  /** Resolved per-cell override; 0 = no opinion (ground/sheet rule decides).
   *  Indexed row-major. */
  overrides: Int8Array; // -1 block, 0 unset, 1 pass
  /** Transient blockers such as event bodies. Kept sparse so adding a small
   *  number of characters never copies or scans the whole map. */
  bodyBlocks?: ReadonlySet<number>;
  ground: readonly TileId[];
  sheets: ReadonlyMap<string, Sheet>;
}

export const BLOCK = -1;
export const PASS = 1;

const DIR_NAMES = ["down", "left", "up", "right"] as const;

export function buildPassage(map: MapDef, sheets: ReadonlyMap<string, Sheet>): PassageTable {
  const overrides = new Int8Array(map.width * map.height);
  for (const [idx, flag] of map.passage ?? []) {
    if (idx < 0 || idx >= overrides.length) {
      throw new Error(`passage index ${idx} outside ${map.id} (${map.width}x${map.height})`);
    }
    overrides[idx] = flag === "block" ? BLOCK : PASS;
  }
  return { width: map.width, height: map.height, overrides, ground: map.ground, sheets };
}

function sheetCellBlocks(table: PassageTable, tile: TileId, entry?: Dir4): boolean {
  if (tile === null) return true; // blocking void
  const { sheet: sheetId, cell } = parseTileId(tile);
  const sheet = table.sheets.get(sheetId);
  if (!sheet) return false; // unknown sheet: ground is walkable
  if (sheet.pass?.includes(cell)) return false;
  if (sheet.block?.includes(cell)) return true;
  // The entry edge is the TARGET cell's edge the step crosses: a step east
  // enters its target from the target's "left" side. The target's dirBlock
  // mask is an entry guard here; the source-cell exit half is cellBlocksExit.
  if (entry !== undefined && sheet.dirBlock?.[String(cell)]?.includes(DIR_NAMES[entry])) return true;
  return sheet.defaultPassage === "block";
}

const OPPOSITE: readonly Dir4[] = [2, 3, 0, 1]; // down<->up, left<->right

/** Does the sheet's dirBlock forbid LEAVING the cell at (tx, ty) facing
 *  `exit`? A dirBlock entry is authored on the cell a character STANDS on:
 *  the exit-half lookup uses the SOURCE cell's tile, never the
 *  destination's (review C13). Only the directional mask is consulted here
 *  — block/pass/void opinions concern entering a cell and are tested by
 *  canEnter on the destination. */
export function cellBlocksExit(table: PassageTable, tx: number, ty: number, exit: Dir4): boolean {
  if (tx < 0 || ty < 0 || tx >= table.width || ty >= table.height) return false;
  const tile = table.ground[ty * table.width + tx] ?? null;
  if (tile === null) return false;
  const { sheet: sheetId, cell } = parseTileId(tile);
  const sheet = table.sheets.get(sheetId);
  if (!sheet) return false;
  return sheet.dirBlock?.[String(cell)]?.includes(DIR_NAMES[exit]) === true;
}

/** Does the sheet's dirBlock forbid ENTERING the cell at (tx, ty) through
 *  its `entry` edge? A tile authored with dirBlock ["left"] keeps every
 *  mover OUT from the west even when the cell's terrain is otherwise open:
 *  the same authored mask is an exit guard when the character stands on
 *  the tile and an entry guard for a step into it (task-1206). */
export function cellBlocksEntry(table: PassageTable, tx: number, ty: number, entry: Dir4): boolean {
  if (tx < 0 || ty < 0 || tx >= table.width || ty >= table.height) return false;
  const tile = table.ground[ty * table.width + tx] ?? null;
  if (tile === null) return false;
  const { sheet: sheetId, cell } = parseTileId(tile);
  const sheet = table.sheets.get(sheetId);
  if (!sheet) return false;
  return sheet.dirBlock?.[String(cell)]?.includes(DIR_NAMES[entry]) === true;
}

/** Is the cell at (tx, ty) walkable when entering it through its optional
 *  `entry` edge (the target-cell side of the crossing; omit it for a
 *  direction-agnostic terrain lookup)? Out-of-range coordinates block
 *  rather than throw: a tape must never crash because a mover reached the
 *  edge. */
export function canEnter(table: PassageTable, tx: number, ty: number, entry?: Dir4): boolean {
  if (tx < 0 || ty < 0 || tx >= table.width || ty >= table.height) return false;
  const idx = ty * table.width + tx;
  if (table.bodyBlocks?.has(idx)) return false;
  const over = table.overrides[idx];
  if (over === PASS) return true;
  if (over === BLOCK) return false;
  return !sheetCellBlocks(table, table.ground[idx] ?? null, entry);
}

/** Full step decision for a character STANDING on (fx, fy): it may move to
 *  the adjacent cell in `dir` only when BOTH directional edges of the
 *  crossing are open — the source cell does not forbid the exit (its sheet
 *  dirBlock mask) AND the target cell does not forbid entering through its
 *  opposite edge (the target's dirBlock mask) — and the destination terrain
 *  is otherwise enterable (task-1206 dual-edge contract). */
export function canStepFrom(table: PassageTable, fx: number, fy: number, dir: Dir4): boolean {
  if (cellBlocksExit(table, fx, fy, dir)) return false;
  // The target is entered through its OPPOSITE edge: a step east crosses the
  // target's left edge, so canEnter must receive the target-side edge.
  return canEnter(table, fx + DX4[dir], fy + DY4[dir], OPPOSITE[dir]);
}

/** Return a table whose given row-major cells are forced BLOCK on top of the
 *  base opinions (a blocking event body standing on otherwise-passable
 *  ground). A map.passage "pass" override reopens terrain but never lets the
 *  mover walk through such a character. The base table is not mutated. */
export function stampBlockedCells(base: PassageTable, cells: Iterable<number>): PassageTable {
  const bodyBlocks = new Set(base.bodyBlocks);
  for (const idx of cells) {
    if (idx >= 0 && idx < base.overrides.length) bodyBlocks.add(idx);
  }
  return { ...base, bodyBlocks };
}

const DX4 = [0, -1, 0, 1] as const; // down, left, up, right
const DY4 = [1, 0, -1, 0] as const;

/** Direction-agnostic standability: bounds, ground void and sheet
 *  block/pass lists, but NOT the per-entry dirBlock exit mask. A character
 *  that legally entered a cell may stand on it while facing any direction;
 *  the save-restore gate must accept that snapshot even when the current
 *  facing is one the cell forbids ENTRY from. */
export function isStandable(table: PassageTable, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= table.width || ty >= table.height) return false;
  const idx = ty * table.width + tx;
  if (table.bodyBlocks?.has(idx)) return false;
  const over = table.overrides[idx];
  if (over === PASS) return true;
  if (over === BLOCK) return false;
  const tile = table.ground[idx];
  if (tile === null) return false; // blocking void
  const { sheet: sheetId, cell } = parseTileId(tile);
  const sheet = table.sheets.get(sheetId);
  if (!sheet) return true; // unknown sheet: ground is walkable
  if (sheet.pass?.includes(cell)) return true;
  if (sheet.block?.includes(cell)) return false;
  return sheet.defaultPassage !== "block";
}
