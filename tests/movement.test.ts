// tests/rpgkit-movement.test.ts — P1② pure-TS engine: passability lookup
// and tile-locked grid movement (step interpolation, collision, edge
// clamp, facing, chaining). Pure bun, no host/framework imports.

import { describe, expect, test } from "bun:test";
import { buildPassage, canEnter, canStepFrom, cellBlocksEntry, cellBlocksExit, isStandable, stampBlockedCells, BLOCK, PASS, type Dir4 } from "../src/engine/passability.ts";
import {
  dirFromButtons,
  initialMovement,
  stepFrames,
  stepMovement,
  stepPixels,
  walkPose,
  type MovementConfig,
} from "../src/engine/movement.ts";
import { BTN_BITS } from "../src/engine/camera.ts";
import type { MapDef, Sheet, TileId } from "../src/engine/types.ts";

const CFG: MovementConfig = { tile: 16, speed: 2 };
const STEP = 8; // frames per tile

function map10(
  ground?: TileId[],
  passage?: [number, "pass" | "block"][],
  sheets: Sheet[] = [],
): { map: MapDef; table: ReturnType<typeof buildPassage> } {
  const map: MapDef = {
    id: "t",
    name: "t",
    width: 10,
    height: 10,
    sheets: sheets.map((s) => s.id),
    ground: ground ?? new Array<TileId>(100).fill("town.0"),
    passage,
    events: [],
  };
  return { map, table: buildPassage(map, new Map(sheets.map((s) => [s.id, s]))) };
}

describe("step geometry", () => {
  test("a 16px tile at 2px/frame takes 8 frames", () => {
    expect(stepFrames(CFG)).toBe(8);
  });

  test("rejects speeds that do not divide the tile evenly", () => {
    expect(() => stepFrames({ tile: 16, speed: 3 })).toThrow();
    expect(() => stepFrames({ tile: 0, speed: 2 })).toThrow();
  });

  test("stepPixels interpolates linearly in the step direction", () => {
    expect(stepPixels(32, 48, 3, 1, CFG)).toEqual({ px: 34, py: 48 });
    expect(stepPixels(32, 48, 0, 7, CFG)).toEqual({ px: 32, py: 62 });
    expect(stepPixels(0, 0, 2, STEP, CFG)).toEqual({ px: 0, py: -16 });
  });

  test("initialMovement anchors pixel position on the tile origin", () => {
    const s = initialMovement(3, 5, 1, CFG);
    expect({ px: s.px, py: s.py }).toEqual({ px: 48, py: 80 });
    expect(s.moving).toBe(false);
    expect(s.phase).toBe(0);
  });
});

describe("walkPose — saveable walk animation phase", () => {
  // One 8-frame tile renders idle,L,L,idle,idle,R,R — the baked pose cycle
  // [idle,L,idle,R] at floor(phase/2). This is the pure reducer function
  // the static player Image is keyed on (R1202-2).
  test("maps the eight step phases to idle/L/idle/R cells", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(walkPose)).toEqual([0, 0, 1, 1, 0, 0, 2, 2]);
  });
  test("rest and the phase-1 press frame are both the idle stance", () => {
    expect(walkPose(0)).toBe(0);
    expect(walkPose(1)).toBe(0);
  });
});

describe("dirFromButtons", () => {
  test("reads the four d-pad bits", () => {
    expect(dirFromButtons(BTN_BITS.RIGHT)).toBe(3);
    expect(dirFromButtons(BTN_BITS.LEFT)).toBe(1);
    expect(dirFromButtons(BTN_BITS.UP)).toBe(2);
    expect(dirFromButtons(BTN_BITS.DOWN)).toBe(0);
    expect(dirFromButtons(0)).toBeNull();
  });

  test("vertical wins a diagonal, down wins up, right wins left", () => {
    expect(dirFromButtons(BTN_BITS.RIGHT | BTN_BITS.DOWN)).toBe(0);
    expect(dirFromButtons(BTN_BITS.RIGHT | BTN_BITS.UP)).toBe(2);
    expect(dirFromButtons(BTN_BITS.LEFT | BTN_BITS.RIGHT)).toBe(3);
  });
});

describe("passability", () => {
  test("open ground is walkable on every side", () => {
    const { table } = map10();
    for (let d = 0; d < 4; d++) {
      expect(canEnter(table, 5, 5, d as 0)).toBe(true);
    }
  });

  test("cells outside the map rectangle block", () => {
    const { table } = map10();
    expect(canEnter(table, -1, 0)).toBe(false);
    expect(canEnter(table, 0, -1)).toBe(false);
    expect(canEnter(table, 10, 0)).toBe(false);
    expect(canEnter(table, 0, 10)).toBe(false);
  });

  test("a null ground tile is a blocking void", () => {
    const g = new Array<TileId>(100).fill("town.0");
    g[42] = null;
    const { table } = map10(g);
    expect(canEnter(table, 2, 4)).toBe(false);
    expect(canEnter(table, 3, 4)).toBe(true);
  });

  test("map.passage block overrides open ground; pass overrides a void", () => {
    const g = new Array<TileId>(100).fill("town.0");
    g[15] = null;
    const { table } = map10(g, [
      [23, "block"],
      [15, "pass"],
    ]);
    expect(canEnter(table, 3, 2)).toBe(false); // blocked grass
    expect(canEnter(table, 5, 1)).toBe(true); // reopened void (a gate)
  });

  test("sheet defaultPassage=block with a pass cell exception", () => {
    const sheet: Sheet = { id: "wall", cols: 4, rows: 4, defaultPassage: "block", pass: [7] };
    const { table } = map10(new Array(100).fill("wall.0"), undefined, [sheet]);
    expect(canEnter(table, 1, 1)).toBe(false);
    const opened = map10(new Array(100).fill("wall.7"), undefined, [sheet]).table;
    expect(canEnter(opened, 1, 1)).toBe(true);
  });

  test("sheet block list and dirBlock dual edges are honored", () => {
    const sheet: Sheet = {
      id: "town",
      cols: 8,
      rows: 8,
      block: [5],
      dirBlock: { "9": ["up"] }, // cell 9 bars its up edge, both ways
    };
    const g = new Array<TileId>(100).fill("town.0");
    g[11] = "town.5"; // (1,1)
    g[12] = "town.9"; // (2,1)
    const { table } = map10(g, undefined, [sheet]);
    expect(canEnter(table, 1, 1, 3)).toBe(false); // block list, any dir
    // canEnter receives the TARGET cell's entry edge: cell 9's terrain is
    // open, but entering it through its barred up edge is refused while
    // every other edge stays open.
    expect(canEnter(table, 2, 1, 2)).toBe(false); // entry through up barred
    expect(canEnter(table, 2, 1, 1)).toBe(true); // entry through left open
    expect(canEnter(table, 2, 1)).toBe(true); // omitted entry ignores dirBlock
    expect(cellBlocksExit(table, 2, 1, 2)).toBe(true); // cannot leave 9 upward
    expect(cellBlocksExit(table, 2, 1, 3)).toBe(false); // leaving 9 right is fine
    expect(cellBlocksEntry(table, 2, 1, 2)).toBe(true); // cannot enter 9 from above
    expect(cellBlocksEntry(table, 2, 1, 1)).toBe(false); // entering from the west is fine
    expect(canStepFrom(table, 2, 1, 2)).toBe(false); // up exit barred on the source
    expect(canStepFrom(table, 2, 0, 0)).toBe(false); // step down INTO 9 crosses its up edge
    expect(canStepFrom(table, 2, 1, 3)).toBe(true); // side exit, open target
    expect(canStepFrom(table, 1, 1, 3)).toBe(true); // stepping east INTO 9 crosses its left edge
    // dirBlock never changes direction-agnostic standability. The
    // save-restore gate must accept a character resting on the cell facing
    // the blocked direction, while a cell on the block list rejects standing.
    expect(isStandable(table, 2, 1)).toBe(true);
    expect(isStandable(table, 1, 1)).toBe(false); // block list still rejects
  });

  test("map.passage pass reopens a target reverse dirBlock edge", () => {
    const names = ["down", "left", "up", "right"] as const;
    const opposite = [2, 3, 0, 1] as const;
    const dx = [0, -1, 0, 1] as const;
    const dy = [1, 0, -1, 0] as const;
    for (const dir of [0, 1, 2, 3] as const) {
      const width = 5;
      const targetX = 2 + dx[dir];
      const targetY = 2 + dy[dir];
      const target = targetY * width + targetX;
      const ground = new Array<TileId>(width * width).fill("edge.0");
      ground[target] = "edge.1";
      const sheet: Sheet = {
        id: "edge", cols: 2, rows: 1, defaultPassage: "pass",
        dirBlock: { "1": [names[opposite[dir]]!] },
      };
      const map: MapDef = {
        id: "edge", name: "edge", width, height: width, sheets: [sheet.id], ground,
        passage: [[target, "pass"]], events: [],
      };
      const table = buildPassage(map, new Map([[sheet.id, sheet]]));
      expect(canStepFrom(table, 2, 2, dir), names[dir]).toBe(true);
    }
  });

  describe("dirBlock destination reverse edge", () => {
    function edgeTable(blocked: "down" | "left" | "up" | "right", target: [number, number] = [2, 1]) {
      const sheet: Sheet = {
        id: "town",
        cols: 2,
        rows: 1,
        defaultPassage: "pass",
        dirBlock: { "1": [blocked] },
      };
      const ground = new Array<TileId>(100).fill("town.0");
      ground[target[1] * 10 + target[0]] = "town.1";
      return map10(ground, undefined, [sheet]).table;
    }

    test("rightward entry into a left-blocking target is refused", () => {
      const table = edgeTable("left");
      expect(canStepFrom(table, 1, 1, 3)).toBe(false);
      expect(canStepFrom(table, 2, 1, 1)).toBe(false);
      expect(canStepFrom(table, 2, 1, 0)).toBe(true);
      expect(canStepFrom(table, 2, 1, 2)).toBe(true);
      expect(canStepFrom(table, 2, 1, 3)).toBe(true);
    });

    test("a right-blocking target does not stop rightward entry (the mask seals the far edge)", () => {
      const table = edgeTable("right");
      expect(canStepFrom(table, 1, 1, 3)).toBe(true);
      expect(canStepFrom(table, 3, 1, 1)).toBe(false);
    });

    test("every direction: entry is refused only across the target's reverse edge", () => {
      const cases: ReadonlyArray<{
        dir: Dir4;
        from: [number, number];
        target: [number, number];
        blocks: "down" | "left" | "up" | "right";
        open: "down" | "left" | "up" | "right";
      }> = [
        { dir: 0, from: [5, 4], target: [5, 5], blocks: "up", open: "down" },
        { dir: 1, from: [6, 5], target: [5, 5], blocks: "right", open: "left" },
        { dir: 2, from: [5, 6], target: [5, 5], blocks: "down", open: "up" },
        { dir: 3, from: [4, 5], target: [5, 5], blocks: "left", open: "right" },
      ];
      for (const entry of cases) {
        expect(canStepFrom(edgeTable(entry.blocks, entry.target), ...entry.from, entry.dir)).toBe(false);
        expect(canStepFrom(edgeTable(entry.open, entry.target), ...entry.from, entry.dir)).toBe(true);
      }
    });

    test("canEnter keeps terrain semantics: the edge mask is not an enterability opinion", () => {
      const table = edgeTable("left");
      expect(canEnter(table, 2, 1, 3)).toBe(true);
      expect(cellBlocksExit(table, 2, 1, 1)).toBe(true);
    });

    test("the mover refuses a rightward press into a left-blocking tile: turn only, no pixels", () => {
      const stopped = stepMovement(initialMovement(1, 1, 3, CFG), BTN_BITS.RIGHT, edgeTable("left"), CFG);
      expect({ tx: stopped.tx, px: stopped.px, moving: stopped.moving })
        .toEqual({ tx: 1, px: 16, moving: false });
      const moving = stepMovement(initialMovement(1, 1, 3, CFG), BTN_BITS.RIGHT, edgeTable("right"), CFG);
      expect({ tx: moving.tx, px: moving.px, moving: moving.moving })
        .toEqual({ tx: 1, px: 18, moving: true });
    });
  });

  test("a passage override outside the map throws at build time", () => {
    expect(() => map10(undefined, [[100, "block"]])).toThrow();
  });

  test("BLOCK/PASS sentinels are -1 and 1", () => {
    expect(BLOCK).toBe(-1);
    expect(PASS).toBe(1);
  });

  test("stampBlockedCells forces an event body block over passable terrain", () => {
    const { table } = map10();
    expect(canEnter(table, 3, 3)).toBe(true);
    const stamped = stampBlockedCells(table, [3 * 10 + 3]);
    expect(canEnter(stamped, 3, 3)).toBe(false);
    // The base table is untouched (a fresh stamp does not accumulate).
    expect(canEnter(table, 3, 3)).toBe(true);
    // Out-of-range cells are ignored rather than throwing.
    expect(() => stampBlockedCells(table, [999])).not.toThrow();
  });
});

describe("tile movement — one step", () => {
  test("the first press moves on the same frame: 2px, moving, phase 1", () => {
    const { table } = map10();
    const s0 = initialMovement(5, 5, 0, CFG);
    const s1 = stepMovement(s0, BTN_BITS.RIGHT, table, CFG);
    expect({ tx: s1.tx, ty: s1.ty, px: s1.px, py: s1.py, phase: s1.phase, moving: s1.moving, walking: s1.walking }).toEqual({
      tx: 5,
      ty: 5,
      px: 82,
      py: 80,
      phase: 1,
      moving: true,
      walking: true,
    });
    expect(s1.facing).toBe(3);
  });

  test("interpolates 2px per frame and arrives on the 8th frame at the new tile", () => {
    const { table } = map10();
    let s = initialMovement(5, 5, 0, CFG);
    for (let f = 1; f <= STEP; f++) {
      s = stepMovement(s, f === 1 ? BTN_BITS.RIGHT : 0, table, CFG);
      if (f < STEP) {
        expect(s.moving).toBe(true);
        expect(s.px).toBe(80 + 2 * f);
      }
    }
    expect(s.moving).toBe(false);
    expect(s.phase).toBe(0);
    expect({ tx: s.tx, ty: s.ty, px: s.px, py: s.py }).toEqual({ tx: 6, ty: 5, px: 96, py: 80 });
  });

  test("releasing mid-step finishes the committed step and stops", () => {
    const { table } = map10();
    let s = stepMovement(initialMovement(5, 5, 0, CFG), BTN_BITS.RIGHT, table, CFG);
    for (let f = 2; f <= STEP; f++) s = stepMovement(s, 0, table, CFG);
    expect(s.tx).toBe(6);
    expect(s.moving).toBe(false);
    // idle afterwards
    const idle = stepMovement(s, 0, table, CFG);
    expect(idle).toBe(s);
  });

  test("is a pure fold: input state is never mutated", () => {
    const { table } = map10();
    const s0 = initialMovement(5, 5, 0, CFG);
    const frozen = structuredClone(s0);
    stepMovement(s0, BTN_BITS.RIGHT, table, CFG);
    expect(s0).toEqual(frozen);
  });
});

describe("tile movement — collision", () => {
  test("a blocked adjacent tile turns the player in place without moving", () => {
    const g = new Array<TileId>(100).fill("town.0");
    g[5 * 10 + 6] = null; // tile (6,5) east of start
    const { table } = map10(g);
    const s0 = initialMovement(5, 5, 0, CFG);
    const s1 = stepMovement(s0, BTN_BITS.RIGHT, table, CFG);
    expect(s1.moving).toBe(false);
    expect(s1.px).toBe(80);
    expect(s1.facing).toBe(3);
    // facing the wall again: state is unchanged entirely
    const s2 = stepMovement(s1, BTN_BITS.RIGHT, table, CFG);
    expect(s2).toBe(s1);
  });

  test("holding toward a wall never leaves the tile, even over many frames", () => {
    const g = new Array<TileId>(100).fill("town.0");
    g[5 * 10 + 6] = null;
    const { table } = map10(g);
    let s = initialMovement(5, 5, 0, CFG);
    for (let f = 0; f < 60; f++) s = stepMovement(s, BTN_BITS.RIGHT, table, CFG);
    expect({ tx: s.tx, ty: s.ty, px: s.px, py: s.py, moving: s.moving }).toEqual({
      tx: 5,
      ty: 5,
      px: 80,
      py: 80,
      moving: false,
    });
  });

  test("map edges clamp: walking off each side turns/stops at the border tile", () => {
    const { table } = map10();
    for (const [btn, start, axis] of [
      [BTN_BITS.UP, [5, 0], "y"],
      [BTN_BITS.DOWN, [5, 9], "y"],
      [BTN_BITS.LEFT, [0, 5], "x"],
      [BTN_BITS.RIGHT, [9, 5], "x"],
    ] as const) {
      let s = initialMovement(start[0], start[1], 0, CFG);
      for (let f = 0; f < 20; f++) s = stepMovement(s, btn, table, CFG);
      expect(s[axis === "x" ? "tx" : "ty"]).toBe(start[axis === "x" ? 0 : 1]);
      expect(s.moving).toBe(false);
    }
  });

  test("blocked one axis, open the other: a diagonal hold slides vertically", () => {
    const g = new Array<TileId>(100).fill("town.0");
    g[5 * 10 + 6] = null; // east blocked
    const { table } = map10(g);
    // vertical priority resolves the diagonal DOWN (open), so the player
    // walks south instead of sticking on the east wall.
    let s = initialMovement(5, 5, 3, CFG);
    s = stepMovement(s, BTN_BITS.RIGHT | BTN_BITS.DOWN, table, CFG);
    expect(s.facing).toBe(0);
    expect(s.ty).toBe(5);
    for (let f = 2; f <= STEP; f++) s = stepMovement(s, BTN_BITS.RIGHT | BTN_BITS.DOWN, table, CFG);
    expect({ tx: s.tx, ty: s.ty }).toEqual({ tx: 5, ty: 6 });
  });
});

describe("tile movement — chaining and facing", () => {
  test("held direction chains steps with no idle frame", () => {
    const { table } = map10();
    let s = initialMovement(2, 5, 3, CFG);
    for (let f = 0; f < STEP * 3; f++) s = stepMovement(s, BTN_BITS.RIGHT, table, CFG);
    expect({ tx: s.tx, px: s.px, moving: s.moving, phase: s.phase, walking: s.walking }).toEqual({
      tx: 5,
      px: 80,
      moving: false,
      phase: 0,
      walking: true, // still engaged at the boundary; one release drops it
    });
    const stopped = stepMovement(s, 0, table, CFG);
    expect(stopped.walking).toBe(false);
    expect(stopped.moving).toBe(false);
  });

  test("a wall ending a walk drops engagement on the arrival frame", () => {
    const g = new Array<TileId>(100).fill("town.0");
    g[5 * 10 + 6] = "town.0";
    g[5 * 10 + 8] = null; // two open tiles east, then void
    const { table } = map10(g);
    let s = initialMovement(5, 5, 3, CFG);
    for (let f = 0; f < STEP * 2; f++) s = stepMovement(s, BTN_BITS.RIGHT, table, CFG);
    expect({ tx: s.tx, walking: s.walking, facing: s.facing }).toEqual({
      tx: 7,
      walking: false, // arrival sees the blocked (8,5): idle pose resumes
      facing: 3,
    });
  });

  test("turning at a boundary changes facing without spending a step", () => {
    const { table } = map10();
    const s0 = initialMovement(5, 5, 3, CFG);
    const s1 = stepMovement(s0, BTN_BITS.UP, table, CFG);
    expect(s1.facing).toBe(2);
    expect(s1.moving).toBe(true); // up is open, so the step begins immediately
    // but a turn toward a blocked side only turns
    const g = new Array<TileId>(100).fill("town.0");
    g[5 * 10 + 4] = null; // tile (4,5) west of start
    const t2 = map10(g).table;
    const s2 = stepMovement(initialMovement(5, 5, 0, CFG), BTN_BITS.LEFT, t2, CFG);
    expect(s2.facing).toBe(1);
    expect(s2.moving).toBe(false);
  });

  test("new direction pressed mid-step is read at arrival and faced when its step starts (task-1207)", () => {
    const { table } = map10();
    let s = initialMovement(5, 5, 3, CFG);
    for (let f = 1; f <= STEP; f++) {
      // hold LEFT (opposite) from the second frame through arrival
      s = stepMovement(s, f === 1 ? BTN_BITS.RIGHT : BTN_BITS.LEFT, table, CFG);
    }
    // arrives east, never reverses mid-tile. The held LEFT is accepted for
    // the next step and engagement continues, but facing stays on the
    // completed step so the turned pose is not bound at phase 0.
    expect(s.tx).toBe(6);
    expect(s.ty).toBe(5);
    expect(s.facing).toBe(3);
    expect(s.walking).toBe(true);
    expect(s.moving).toBe(false);
    // The following frame commits LEFT and changes facing together with its
    // first displacement, aligning the new pose with movement phase 1.
    s = stepMovement(s, BTN_BITS.LEFT, table, CFG);
    expect({ facing: s.facing, moving: s.moving, phase: s.phase, px: s.px }).toEqual({
      facing: 1,
      moving: true,
      phase: 1,
      px: 94,
    });
  });
});

// --- directional passage over the reducer (task-1206 dual-edge contract) ---
// A dirBlock entry authored on one tile guards BOTH sides of an edge: as a
// source cell it forbids LEAVING through the named edge, and as a target
// cell it forbids ENTERING through that edge from outside. Walking east
// checks the source's "right" edge and the target's "left" edge.

function directionalTable(flaggedX: number, blocked: Dir4[]) {
  const width = 5;
  const ground = new Array<TileId>(width * 3).fill("town.0");
  ground[width + flaggedX] = "town.9";
  const names = ["down", "left", "up", "right"] as const;
  const sheet: Sheet = {
    id: "town", cols: 10, rows: 1, defaultPassage: "pass",
    dirBlock: { "9": blocked.map((d) => names[d]!) },
  };
  const map: MapDef = {
    id: "directional", name: "Directional", width, height: 3,
    sheets: ["town"], ground, events: [],
  };
  return buildPassage(map, new Map([[sheet.id, sheet]]));
}

describe("directional passage (task-1206: source exit and target entry edges)", () => {
  test("checks the source exit and destination entry edge for a single step", () => {
    const start = initialMovement(1, 1, 3, CFG);

    const sourceBlocked = stepMovement(
      start,
      BTN_BITS.RIGHT,
      directionalTable(1, [3]),
      CFG,
    );
    expect({ tx: sourceBlocked.tx, px: sourceBlocked.px, moving: sourceBlocked.moving }).toEqual({
      tx: 1,
      px: 16,
      moving: false,
    });

    const unrelatedTargetEdge = stepMovement(
      start,
      BTN_BITS.RIGHT,
      directionalTable(2, [3]),
      CFG,
    );
    expect({ px: unrelatedTargetEdge.px, moving: unrelatedTargetEdge.moving }).toEqual({
      px: 18,
      moving: true,
    });

    // Task-1206 regression: the target's opposite edge blocks entry.
    const targetEntryBlocked = stepMovement(
      start,
      BTN_BITS.RIGHT,
      directionalTable(2, [1]),
      CFG,
    );
    expect({ tx: targetEntryBlocked.tx, px: targetEntryBlocked.px, moving: targetEntryBlocked.moving }).toEqual({
      tx: 1,
      px: 16,
      moving: false,
    });
  });

  test("a barred source exit turns the mover in place without moving", () => {
    const start = initialMovement(1, 1, 3, CFG);
    const out = stepMovement(start, BTN_BITS.RIGHT, directionalTable(1, [3]), CFG);
    expect({ tx: out.tx, px: out.px, moving: out.moving, facing: out.facing }).toEqual({
      tx: 1, px: 16, moving: false, facing: 3,
    });
  });

  test("a neighbour's unrelated barred edge does not stop me ENTERING it", () => {
    // Cell 2 forbids crossing its UP edge; walking right into it crosses its
    // LEFT edge, which stays open.
    const start = initialMovement(1, 1, 3, CFG);
    const out = stepMovement(start, BTN_BITS.RIGHT, directionalTable(2, [2]), CFG);
    expect({ px: out.px, moving: out.moving }).toEqual({ px: 18, moving: true });
  });

  test("a target cell that bars its left edge refuses entry from the west", () => {
    const start = initialMovement(1, 1, 3, CFG);
    const out = stepMovement(start, BTN_BITS.RIGHT, directionalTable(2, [1]), CFG);
    expect({ tx: out.tx, px: out.px, moving: out.moving, facing: out.facing }).toEqual({
      tx: 1, px: 16, moving: false, facing: 3,
    });
  });

  test("held input stops on arrival when the next source exit is blocked", () => {
    const table = directionalTable(2, [3]);
    let state = initialMovement(1, 1, 3, CFG);

    for (let frame = 0; frame < STEP; frame++) {
      state = stepMovement(state, BTN_BITS.RIGHT, table, CFG);
    }
    expect({ tx: state.tx, px: state.px, moving: state.moving, walking: state.walking }).toEqual({
      tx: 2,
      px: 32,
      moving: false,
      walking: false,
    });

    for (let frame = 0; frame < STEP * 2; frame++) {
      state = stepMovement(state, BTN_BITS.RIGHT, table, CFG);
    }
    expect({ tx: state.tx, px: state.px, moving: state.moving, walking: state.walking }).toEqual({
      tx: 2,
      px: 32,
      moving: false,
      walking: false,
    });
  });

  test("held input never crosses a target cell's barred reverse entry", () => {
    const table = directionalTable(2, [1]); // cell 2 keeps movers out from the west
    let state = initialMovement(1, 1, 3, CFG);
    for (let frame = 0; frame < STEP * 3; frame++) {
      state = stepMovement(state, BTN_BITS.RIGHT, table, CFG);
    }
    expect({ tx: state.tx, px: state.px, moving: state.moving }).toEqual({
      tx: 1,
      px: 16,
      moving: false,
    });
  });
});

// --- blocking event bodies stamped from active pages (review C14) ----------
// This is the exact decision the MapView frame loop makes: read each event's
// active page, stamp its blocks cell, then run the mover. The three-map game
// is covered through chars bodies; a view without a chars reducer stamps
// the authored page directly.

import { activePage } from "../src/engine/interpreter.ts";
import { createSwitchState } from "../src/engine/interpreter.ts";
import type { GameEvent } from "../src/engine/types.ts";

describe("MapView occupancy — an active blocks page stops the mover", () => {
  test("walking right stops one tile short of the blocking event", () => {
    const W = 20, H = 13;
    const ev: GameEvent = {
      id: "npc", x: 13, y: 9,
      pages: [{ trigger: "action", sprite: null, blocks: true, commands: [] }],
    };
    const map: MapDef = {
      id: "m", name: "d", width: W, height: H, sheets: ["town"],
      ground: new Array<TileId>(W * H).fill("town.0"), events: [ev],
    };
    const sheet: Sheet = { id: "town", cols: 12, rows: 11, defaultPassage: "pass" };
    const base = buildPassage(map, new Map([["town", sheet]]));
    const sw = createSwitchState();
    const cells: number[] = [];
    for (const e of map.events!) {
      const active = activePage(e, sw, map.id);
      if (active?.page.blocks === true) cells.push(e.y * W + e.x);
    }
    const table = stampBlockedCells(base, cells);
    let mv = initialMovement(12, 9, 3, CFG); // facing right
    for (let i = 0; i < 8; i++) mv = stepMovement(mv, BTN_BITS.RIGHT, table, CFG);
    expect(mv.tx).toBe(12);
    expect(mv.px).toBe(12 * 16);
  });
});
