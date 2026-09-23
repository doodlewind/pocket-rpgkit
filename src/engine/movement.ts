// src/engine/movement.ts — tile-locked grid movement for P1②.
//
// The mover walks the tile grid: a d-pad press commits ONE tile and the
// following frames interpolate to it at a fixed px/frame (8 frames per
// 16px tile at 2 px/frame, 60 Hz). Input pressed mid-step is read at the
// next tile boundary, so held directions chain into continuous walking
// and a tap cannot cut a step short. Every step takes exactly
// tile/speed frames, chained steps included: the press frame renders the
// first 2px, phase advances 1..8, and phase 8 collapses onto the
// destination boundary. Collision is decided per tile BEFORE the step
// starts, against a cooked PassageTable: a blocked target (map edge,
// void ground, sheet flag, passage override) turns the mover in place
// but does not move it. Diagonal holds use the same fixed priority as
// the P1① camera reducer (vertical wins, deterministic tapes).
//
// Two booleans drive the walk animation:
//   moving  — a step is interpolating right now (pixel offset != origin)
//   walking — the mover is engaged: arrival keeps walking true while the
//             held direction stays open, so chained steps never rebind
//             the sprite; the core's 4-cell x 2-vblank atlas cycle is
//             exactly 8 frames, one tile, and stays phase-aligned by
//             itself. walking drops on release or a blocked next tile.
//
// Pure TS, pure fold: stepMovement returns a new state, reads no clock,
// and is driven only by the per-frame BTN mask (docs/SIMULATION.md).

import { BTN_BITS } from "./camera.ts";
import { canStepFrom, type Dir4, type PassageTable } from "./passability.ts";

export interface MovementConfig {
  /** Tile edge in pixels (project.tileSize, 16). */
  tile: number;
  /** Pixels per frame at 60 Hz; tile must divide evenly by speed. */
  speed: number;
}

export interface MovementState {
  /** Tile the current step started from (the standing tile at rest). */
  tx: number;
  ty: number;
  /** World-space top-left in pixels; interpolates between tile origins
   *  while moving. */
  px: number;
  py: number;
  facing: Dir4;
  /** Frames accumulated in the current step: 0 at a tile boundary,
   *  1..stepFrames while moving (stepFrames collapses to 0 on arrival). */
  phase: number;
  moving: boolean;
  walking: boolean;
  /** Direction of the current step (valid while moving). */
  stepDir: Dir4;
}

export function stepFrames(cfg: MovementConfig): number {
  if (cfg.tile <= 0 || cfg.speed <= 0 || !Number.isInteger(cfg.tile / cfg.speed)) {
    throw new Error(`movement: tile ${cfg.tile} must be an integer multiple of speed ${cfg.speed}`);
  }
  return cfg.tile / cfg.speed;
}

export function initialMovement(
  tx: number,
  ty: number,
  facing: Dir4,
  cfg: MovementConfig,
): MovementState {
  return {
    tx,
    ty,
    px: tx * cfg.tile,
    py: ty * cfg.tile,
    facing,
    phase: 0,
    moving: false,
    walking: false,
    stepDir: facing,
  };
}

const DX: readonly number[] = [0, -1, 0, 1]; // down, left, up, right
const DY: readonly number[] = [1, 0, -1, 0];

/** Walker pose for a step phase: 0 = two-foot idle stance, 1 = the
 *  left/back extreme, 2 = the right/front extreme. The baked atlas cycle
 *  is [idle, L, idle, R] indexed by floor(phase/2), so an 8-frame tile
 *  renders idle, L, L, idle, idle, R, R — the same cells a core auto-play
 *  atlas showed on a straight walk, but derived from the SAVED mover phase
 *  instead of a host frame clock the save cannot carry, so a restore at any
 *  host frame offset renders identical pixels (R1202-2). */
export type WalkPose = 0 | 1 | 2;
export function walkPose(phase: number): WalkPose {
  if (phase <= 0) return 0;
  switch (Math.floor(phase / 2)) {
    case 1: return 1; // phase 2..3
    case 3: return 2; // phase 6..7
    default: return 0; // phase 1, 4..5, 8: the cycle's idle cells
  }
}

/** Resolve a held BTN mask to one direction. Vertical wins a diagonal
 *  hold (down before up), then right over left — matching camera.ts's
 *  P1① tie-break. null = no d-pad. */
export function dirFromButtons(buttons: number): Dir4 | null {
  if (buttons & BTN_BITS.DOWN) return 0;
  if (buttons & BTN_BITS.UP) return 2;
  if (buttons & BTN_BITS.RIGHT) return 3;
  if (buttons & BTN_BITS.LEFT) return 1;
  return null;
}

/** Pixel position at phase p of a step in dir from origin (ox, oy). */
export function stepPixels(
  ox: number,
  oy: number,
  dir: Dir4,
  phase: number,
  cfg: MovementConfig,
): { px: number; py: number } {
  return { px: ox + DX[dir] * cfg.speed * phase, py: oy + DY[dir] * cfg.speed * phase };
}

function canStep(s: MovementState, dir: Dir4, table: PassageTable): boolean {
  // dirBlock is authored on the SOURCE tile as an exit mask; canStepFrom
  // checks that before testing the destination cell (review C13).
  return canStepFrom(table, s.tx, s.ty, dir);
}

/** One frame. `table` is the map's cooked PassageTable; blocked targets
 *  stop the mover at the boundary and apply only the facing turn. */
export function stepMovement(
  s: MovementState,
  buttons: number,
  table: PassageTable,
  cfg: MovementConfig,
): MovementState {
  const frames = stepFrames(cfg);

  if (s.moving) {
    const phase = s.phase + 1;
    if (phase < frames) {
      const { px, py } = stepPixels(s.tx * cfg.tile, s.ty * cfg.tile, s.stepDir, phase, cfg);
      return { ...s, phase, px, py };
    }
    // Arrival at phase 8: snap to the destination boundary. walking
    // stays true only while the held direction can continue, so a
    // chained step keeps the walker engaged and a wall/release shows idle
    // starting on this frame. An open turn keeps the COMPLETED step's
    // facing while the mover waits at the boundary: the resting branch
    // applies the new facing on the step's first displaced frame, so the
    // turned pose is not bound one frame before that step begins
    // (task-1207 walker phase after turns).
    const tx = s.tx + DX[s.stepDir];
    const ty = s.ty + DY[s.stepDir];
    const dir = dirFromButtons(buttons);
    const cont = dir !== null && canStepFrom(table, tx, ty, dir);
    return {
      ...s,
      tx,
      ty,
      px: tx * cfg.tile,
      py: ty * cfg.tile,
      phase: 0,
      moving: false,
      walking: cont,
      facing: cont ? s.facing : (dir ?? s.facing),
    };
  }

  // Resting at a tile boundary.
  const dir = dirFromButtons(buttons);
  if (dir === null) {
    return s.walking ? { ...s, walking: false } : s;
  }
  if (!canStep(s, dir, table)) {
    // Blocked: turn in place, engagement drops.
    return s.facing === dir && !s.walking ? s : { ...s, facing: dir, walking: false };
  }
  // Commit the step: the press frame renders the first 2px.
  const { px, py } = stepPixels(s.tx * cfg.tile, s.ty * cfg.tile, dir, 1, cfg);
  return { ...s, facing: dir, moving: true, walking: true, phase: 1, stepDir: dir, px, py };
}
