// tests/pathfind.test.ts — K2/T2-5 deterministic BFS (src/engine/pathfind.ts):
// fixed-order expansion, blocked-cell avoidance, one-sided dirEdges routing,
// and the approach-stand / facing helpers. Pure bun, no host.

import { describe, expect, test } from "bun:test";
import { buildPassage, type Dir4 } from "../src/engine/passability.ts";
import {
  advancePathSearch,
  approachSide,
  approachStand,
  bfsPath,
  createPathSearch,
  facingToward,
} from "../src/engine/pathfind.ts";
import type { MapDef, Sheet, TileId } from "../src/engine/types.ts";

function table(
  w: number,
  h: number,
  opts: {
    ground?: TileId[];
    sheets?: Sheet[];
    blockedCells?: number[];
  } = {},
) {
  const sheets: Sheet[] = opts.sheets ?? [{ id: "s", cols: 1, rows: 1, defaultPassage: "pass" }];
  const ground = opts.ground ?? new Array<TileId>(w * h).fill("s.0");
  const passage: [number, "block"][] = (opts.blockedCells ?? []).map((i) => [i, "block"]);
  const map: MapDef = {
    id: "p", name: "p", width: w, height: h,
    sheets: sheets.map((s) => s.id), ground, passage, events: [],
  };
  return buildPassage(map, new Map(sheets.map((s) => [s.id, s])));
}

function walk(t: ReturnType<typeof table>, sx: number, sy: number, dirs: Dir4[]) {
  const DX = [0, -1, 0, 1], DY = [1, 0, -1, 0];
  let x = sx, y = sy;
  const cells = [`${x},${y}`];
  for (const d of dirs) { x += DX[d]!; y += DY[d]!; cells.push(`${x},${y}`); }
  return cells;
}

describe("bfsPath — determinism and geometry", () => {
  test("already on the goal is an empty path", () => {
    const t = table(5, 5);
    expect(bfsPath(t, 2, 2, 2, 2)).toEqual([]);
  });

  test("a straight open map takes the axis-aligned path", () => {
    const t = table(5, 5);
    expect(bfsPath(t, 0, 0, 3, 0)).toEqual([3, 3, 3]); // right,right,right
    expect(bfsPath(t, 0, 0, 0, 2)).toEqual([0, 0]); // down,down
  });

  test("equal-length ties resolve by the fixed neighbour order (down,left,up,right)", () => {
    const t = table(5, 5);
    // From (1,1) to (2,2) two shortest paths exist: down-then-right or
    // right-then-down. down (0) is expanded before right (3), so the path
    // goes down first.
    expect(bfsPath(t, 1, 1, 2, 2)).toEqual([0, 3]);
  });

  test("running twice yields the identical path", () => {
    const t = table(20, 20, { blockedCells: [30, 51, 72, 93, 114, 135, 177, 198] });
    const a = bfsPath(t, 1, 1, 18, 18);
    const b = bfsPath(t, 1, 1, 18, 18);
    expect(a).toEqual(b);
    expect(a).not.toBeNull();
  });

  test("routes around blocked cells", () => {
    // A vertical wall at x=2 from y=0..3 with a gap at y=4; the path detours.
    const wall = [2, 12, 22, 32];
    const t = table(6, 6, { blockedCells: wall });
    const path = bfsPath(t, 1, 1, 4, 1);
    expect(path).not.toBeNull();
    // Replay the path cell by cell and never enter a wall cell.
    const cells = walk(t, 1, 1, path!);
    for (const c of cells) {
      const [x, y] = c.split(",").map(Number);
      expect(wall).not.toContain(y! * 6 + x!);
    }
    expect(cells[cells.length - 1]).toBe("4,1");
  });

  test("returns null when the goal is enclosed", () => {
    const t = table(5, 5, { blockedCells: [7, 11, 13, 17] }); // ring around (2,2)=12
    expect(bfsPath(t, 0, 0, 2, 2)).toBeNull();
  });

  test("returns null for an out-of-map goal", () => {
    const t = table(5, 5);
    expect(bfsPath(t, 0, 0, 9, 9)).toBeNull();
  });

  test("dynamic blocked cells route the path around a standing body", () => {
    const t = table(5, 3);
    // The cell directly east (1,1 -> (2,1)) is occupied; the path detours
    // over row 0.
    const cells = new Set<number>([2 + 1 * 5]);
    const path = bfsPath(t, 1, 1, 3, 1, { cells });
    expect(path).not.toBeNull();
    const replayed = walk(t, 1, 1, path!);
    expect(replayed).not.toContain("2,1");
    expect(replayed[replayed.length - 1]).toBe("3,1");
  });

  test("a blocked goal is unreachable (caller waits and retries)", () => {
    const t = table(5, 5);
    expect(bfsPath(t, 0, 0, 3, 3, { cells: new Set([3 + 3 * 5]) })).toBeNull();
  });
});

describe("bfsPath — one-sided dirEdges are honored", () => {
  const SHEET: Sheet = {
    id: "s", cols: 2, rows: 1, defaultPassage: "pass",
    dirEdges: { "1": { enter: ["left"] } }, // cell 1 refuses entry from the west
  };
  /** A 5×1 corridor (the rows above/below are blocked so there is no
   *  detour); cell (2,0) is the flagged s.1. */
  function ledgeCorridor() {
    const w = 5, h = 1;
    const g: TileId[] = ["s.0", "s.0", "s.1", "s.0", "s.0"];
    return table(w, h, { ground: g, sheets: [SHEET] });
  }

  test("a path cannot cross the blocked side of a one-way edge", () => {
    const t = ledgeCorridor();
    // West -> east must enter (2,0) across its closed west edge: the
    // corridor offers no detour, so the goal east of the lip is unreachable.
    expect(bfsPath(t, 0, 0, 4, 0)).toBeNull();
    // Reaching only the cell just before the lip still works.
    expect(bfsPath(t, 0, 0, 1, 0)).toEqual([3]);
  });

  test("the open side is routable in the reverse direction", () => {
    const t = ledgeCorridor();
    // East -> west enters (2,0) across its open RIGHT edge and leaves it
    // west across the same physical edge, which an enter-only rule never
    // guards: the whole corridor is walkable in reverse.
    expect(bfsPath(t, 4, 0, 0, 0)).toEqual([1, 1, 1, 1]);
  });

  test("the incremental search observes the same one-sided barrier", () => {
    const finish = (sx: number, gx: number) => {
      const t = ledgeCorridor();
      const search = createPathSearch(t, sx, 0, gx, 0)!;
      let result = advancePathSearch(search, t, 1);
      while (!result.done) result = advancePathSearch(search, t, 1);
      return result.path;
    };
    expect(finish(0, 4)).toBeNull();
    expect(finish(4, 0)).toEqual([1, 1, 1, 1]);
  });

  test("the incremental search observes a source-side exit barrier", () => {
    const sheet: Sheet = {
      id: "s", cols: 2, rows: 1, defaultPassage: "pass",
      dirEdges: { "1": { exit: ["right"] } },
    };
    const t = table(5, 1, {
      ground: ["s.0", "s.0", "s.1", "s.0", "s.0"],
      sheets: [sheet],
    });
    const search = createPathSearch(t, 0, 0, 4, 0)!;
    let result = advancePathSearch(search, t, 1);
    while (!result.done) result = advancePathSearch(search, t, 1);
    expect(result.path).toBeNull();
  });
});

describe("incremental BFS — bounded slices", () => {
  test("already on the goal finishes in one advance without scanning", () => {
    const t = table(100, 100);
    const search = createPathSearch(t, 50, 50, 50, 50)!;
    expect(advancePathSearch(search, t, 1)).toEqual({ done: true, path: [] });
    expect(search.qh).toBe(0);
  });

  test("equal-length ties use down/left/up/right order in the incremental kernel", () => {
    const t = table(3, 3);
    const search = createPathSearch(t, 1, 1, 0, 0)!;
    let result = advancePathSearch(search, t, 1);
    while (!result.done) result = advancePathSearch(search, t, 1);
    expect(result.path).toEqual([1, 2]); // left, then up
  });

  test("a 100x100 corner search spans many slices and matches synchronous BFS", () => {
    const t = table(100, 100);
    const expected = bfsPath(t, 0, 0, 99, 99);
    const search = createPathSearch(t, 0, 0, 99, 99)!;

    // A deliberately small first slice proves advancePathSearch observes its
    // dequeue budget instead of hiding a full 10,000-cell search in one tick.
    expect(advancePathSearch(search, t, 37)).toEqual({ done: false });
    expect(search.qh).toBe(37);

    let slices = 1;
    let result = advancePathSearch(search, t, 400);
    while (!result.done) {
      slices++;
      result = advancePathSearch(search, t, 400);
    }
    expect(slices).toBeGreaterThan(20);
    expect(result.path).toEqual(expected);
  });

  test("cloning an in-progress search produces the same remaining path", () => {
    const t = table(100, 100, { blockedCells: [1010, 2020, 3030, 4040, 5050] });
    const original = createPathSearch(t, 2, 3, 97, 96)!;
    expect(advancePathSearch(original, t, 123)).toEqual({ done: false });
    const restored = {
      ...original,
      parent: new Int32Array(original.parent),
      queue: new Int32Array(original.queue),
      blockedMask: original.blockedMask ? new Uint8Array(original.blockedMask) : null,
    };

    const finish = (search: typeof original) => {
      let result = advancePathSearch(search, t, 211);
      while (!result.done) result = advancePathSearch(search, t, 211);
      return result.path;
    };
    expect(finish(restored)).toEqual(finish(original));
  });
});

describe("approach / facing helpers", () => {
  test("facingToward picks the dominant axis, vertical winning a tie", () => {
    expect(facingToward(0, 0, 0, 2)).toBe(0); // down
    expect(facingToward(0, 0, 0, -2)).toBe(2); // up
    expect(facingToward(0, 0, 2, 0)).toBe(3); // right
    expect(facingToward(0, 0, -2, 0)).toBe(1); // left
    expect(facingToward(0, 0, 3, 3)).toBe(0); // tie -> vertical/down
    expect(facingToward(2, 2, 2, 2)).toBeNull(); // same cell
  });

  test("approachSide is the target side the mover stands on", () => {
    // Mover west of target: it faces right at the target, so the target's
    // side it occupies is the target's left.
    expect(approachSide(0, 0, 2, 0)).toBe(1); // left side
    expect(approachSide(2, 0, 0, 0)).toBe(3); // right side
    expect(approachSide(0, 0, 0, 2)).toBe(2); // above -> target's up side
  });

  test("approachStand places the stand tile opposite the approach facing", () => {
    // Stand on the target's left side => stand tile one west of target.
    expect(approachStand(5, 5, 1, 1)).toEqual({ x: 4, y: 5 });
    expect(approachStand(5, 5, 0, 1)).toEqual({ x: 5, y: 6 }); // target's down side
    expect(approachStand(5, 5, 1, 2)).toEqual({ x: 3, y: 5 });
  });
});
