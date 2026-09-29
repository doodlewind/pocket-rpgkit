import type { MapDef, Project, TileId } from "../../../src/engine/types.ts";

export const R2_MAP_ID = "r2-ui-field";
export const R2_MAP_SIZE = { width: 64, height: 40 } as const;
export const PLAYER_START = { x: 15, y: 12 } as const;
export const CANOPY_NPC = { x: 19, y: 12 } as const;
export const WALKING_NPC = { x: 22, y: 14 } as const;
export const ABOVE_ANIMATION = { x: 17, y: 11 } as const;

const ground: TileId[] = Array.from(
  { length: R2_MAP_SIZE.width * R2_MAP_SIZE.height },
  () => "fixture.0",
);

export const R2_MAP: MapDef = {
  id: R2_MAP_ID,
  name: "Animated walker field",
  width: R2_MAP_SIZE.width,
  height: R2_MAP_SIZE.height,
  sheets: ["fixture"],
  ground,
  upper: [[(CANOPY_NPC.y - 1) * R2_MAP_SIZE.width + CANOPY_NPC.x, "fixture.1"]],
  events: [
    {
      id: "canopy-npc",
      x: CANOPY_NPC.x,
      y: CANOPY_NPC.y,
      pages: [{ trigger: "action", sprite: "walker", blocks: true, commands: [] }],
    },
    {
      id: "walking-npc",
      x: WALKING_NPC.x,
      y: WALKING_NPC.y,
      pages: [{
        trigger: "action",
        sprite: "walker",
        blocks: true,
        moveRoute: {
          steps: ["moveRight", "moveLeft"],
          repeat: true,
          skippable: false,
        },
        commands: [],
      }],
    },
  ],
};

export const R2_UI_PROJECT: Project = {
  format: "rpgkit-project/v1",
  title: "R2 UI fixture",
  tileSize: 16,
  start: { map: R2_MAP_ID, x: PLAYER_START.x, y: PLAYER_START.y, dir: "down" },
  sheets: [{ id: "fixture", cols: 2, rows: 1, pak: "chunks", defaultPassage: "pass" }],
  sprites: {
    walker: { kind: "walker", sheet: "walker-source", h: 32, cols: 3, rows: 4 },
  },
  items: [],
  maps: [R2_MAP],
};
