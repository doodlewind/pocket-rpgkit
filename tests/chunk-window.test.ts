import { describe, expect, test } from "bun:test";
import { chunkWindow, chunkWindowContains, expandChunkWindow } from "../src/engine/chunk-window.ts";

describe("chunkWindow", () => {
  test("maps a 480x272 viewport plus 16px margin onto an inclusive 256px grid", () => {
    expect(chunkWindow({ x: 0, y: 0 }, { w: 480, h: 272 }, 256, 4, 3, 16)).toEqual({
      x0: 0, y0: 0, x1: 1, y1: 1,
    });
    expect(chunkWindow({ x: 216, y: 32 }, { w: 480, h: 272 }, 256, 4, 3, 16)).toEqual({
      x0: 0, y0: 0, x1: 2, y1: 1,
    });
  });

  test("uses half-open viewport edges and clamps at the world boundary", () => {
    expect(chunkWindow({ x: 256, y: 256 }, { w: 256, h: 256 }, 256, 4, 3)).toEqual({
      x0: 1, y0: 1, x1: 1, y1: 1,
    });
    expect(chunkWindow({ x: 900, y: 600 }, { w: 480, h: 272 }, 256, 4, 3)).toEqual({
      x0: 3, y0: 2, x1: 3, y1: 2,
    });
  });

  test("returns a canonical empty window outside the grid or for an empty viewport", () => {
    expect(chunkWindow({ x: -800, y: 0 }, { w: 100, h: 100 }, 256, 4, 3)).toEqual({ x0: 0, y0: 0, x1: -1, y1: -1 });
    expect(chunkWindow({ x: 0, y: 0 }, { w: 0, h: 100 }, 256, 4, 3)).toEqual({ x0: 0, y0: 0, x1: -1, y1: -1 });
  });

  test("expands a retention window by one chunk without leaving the grid", () => {
    const load = { x0: 1, y0: 1, x1: 2, y1: 1 };
    const keep = expandChunkWindow(load, 1, 4, 3);
    expect(keep).toEqual({ x0: 0, y0: 0, x1: 3, y1: 2 });
    expect(chunkWindowContains(keep, 0, 2)).toBe(true);
    expect(chunkWindowContains(keep, 4, 2)).toBe(false);
  });
});
