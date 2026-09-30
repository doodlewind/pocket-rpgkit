// tests/fixtures/kb4-battle/fixture-data.ts — the trivial map and battle
// event shared by gen-assets.ts (bakes its chunk images) and kb4-battle.tsx
// (mounts it). The map itself is never actually walked: the battle starts
// the instant the session boots, autorun on frame 1.

import type { GameEvent, MapDef } from "../../../src/engine/types.ts";

export const MAP_ID = "kb4-field";
export const MAP_SIZE = { width: 4, height: 4 } as const;

export function battleEvent(setup: Record<string, unknown> = {}): GameEvent {
  return {
    id: "kb4-battle",
    x: 1,
    y: 1,
    pages: [
      {
        trigger: "autorun",
        commands: [
          { op: "battle", setup: setup as never },
          { op: "switch", id: "kb4-done", value: true },
        ],
      },
      {
        condition: { switch: "kb4-done" },
        trigger: "action",
        commands: [],
      },
    ],
  };
}

export const MAP: MapDef = {
  id: MAP_ID,
  name: MAP_ID,
  width: MAP_SIZE.width,
  height: MAP_SIZE.height,
  sheets: ["plain"],
  ground: new Array(MAP_SIZE.width * MAP_SIZE.height).fill("plain.0"),
  events: [battleEvent()],
};
