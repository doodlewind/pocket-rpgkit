// src/engine/start.ts — single source for where a play session
// begins. The project document (rpgkit-project/v1) names the start tile and
// facing (Project.start); the runtime mounts the camera on that tile, so the
// pixel-space CameraState is derived here instead of being a second,
// hand-authored constant in the UI. The demo project is the only project in
// P1①, so its start tile equals the camera's top-left tile.

import { clampCamera, type WorldSize } from "./camera.ts";
import { TILE } from "./tiles.ts";
import type { CameraState, Dir, Facing } from "./types.ts";

export interface StartRef {
  map: string;
  /** Tile coordinates of the camera top-left at session start. */
  x: number;
  y: number;
  dir: Dir;
}

const DIR_FACING: Record<Dir, Facing> = {
  down: 0,
  left: 1,
  up: 2,
  right: 3,
};

/** Facing index the reducer emits for a start dir (0 down, 1 left, 2 up,
 *  3 right — engine/camera.ts order and the hero atlas file order). */
export function facingOfDir(dir: Dir): Facing {
  return DIR_FACING[dir];
}

/** Camera top-left in pixels for a tile-aligned start ref, clamped into the
 *  world. The player focus is screen-centered, so the start tile is what the
 *  top-left of the viewport shows, not the player's own tile. */
export function startCamera(start: StartRef, cfg: WorldSize): CameraState {
  const c = clampCamera(start.x * TILE, start.y * TILE, cfg);
  return { x: c.x, y: c.y, facing: facingOfDir(start.dir) };
}
