// src/engine/viewport.ts — pure placement math for maps that do not
// fill the host viewport (docs/SIMULATION.md: no host reads in reducers;
// this module takes both sizes as arguments).
//
// A map narrower or shorter than the viewport is CENTERED, and the root's
// black background fills the leftover letterbox on both sides. A map at
// least as large as the viewport on an axis pins to 0: the follow camera
// owns that axis (engine/camera.ts), so this offset never scrolls a large
// world — it only places undersized ones.
//
// Odd leftover pixels go to the right/bottom (floor on the left/top), so the
// split is deterministic at every integer viewport size, not just 480x272:
// desktop windows publish their live logical size through
// hostViewport()/ui.__viewport, and console hosts pass the spec screen.

export interface Size {
  w: number;
  h: number;
}

export interface Offset {
  x: number;
  y: number;
}

export function centerOffset(world: Size, viewport: Size): Offset {
  return {
    x: Math.max(0, Math.floor((viewport.w - world.w) / 2)),
    y: Math.max(0, Math.floor((viewport.h - world.h) / 2)),
  };
}
