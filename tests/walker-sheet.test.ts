import { describe, expect, test } from "bun:test";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import {
  sliceWalkerSheet,
  TUXEMON_WALKER_LAYOUT,
  type SheetImage,
} from "../tools/lib/bake.ts";

type Rgba = readonly [number, number, number, number];

function sourceSheet(): SheetImage {
  const width = 3 * 16;
  const height = 4 * 32;
  const rgba = new Uint8Array(width * height * 4);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 3; col++) {
      const colour: Rgba = [30 + row * 40, 20 + col * 70, 10 + row * 3 + col, 255];
      for (let y = 0; y < 32; y++) {
        for (let x = 0; x < 16; x++) {
          rgba.set(colour, (((row * 32 + y) * width) + col * 16 + x) * 4);
        }
      }
    }
  }
  return { width, height, rgba };
}

function centre(png: Uint8Array): number[] {
  const decoded = decodePng(png);
  const i = (16 * decoded.width + 8) * 4;
  return [...decoded.rgba.subarray(i, i + 4)];
}

function colour(row: number, col: number): number[] {
  return [30 + row * 40, 20 + col * 70, 10 + row * 3 + col, 255];
}

describe("3x4 walker sheet slicing", () => {
  test("maps Tuxemon rows and three poses into engine-facing order", () => {
    const frames = sliceWalkerSheet(sourceSheet());
    expect({ w: frames.cellW, h: frames.cellH }).toEqual({ w: 16, h: 32 });
    const rows = [0, 1, 3, 2];
    for (let facing = 0; facing < 4; facing++) {
      expect(centre(frames.idle[facing]!)).toEqual(colour(rows[facing]!, 1));
      expect(centre(frames.walkL[facing]!)).toEqual(colour(rows[facing]!, 0));
      expect(centre(frames.walkR[facing]!)).toEqual(colour(rows[facing]!, 2));
    }
  });

  test("is byte-stable and does not mutate decoded source pixels", () => {
    const source = sourceSheet();
    const before = source.rgba.slice();
    const a = sliceWalkerSheet(source);
    const b = sliceWalkerSheet(source);
    expect(a.idle.map((png) => [...png])).toEqual(b.idle.map((png) => [...png]));
    expect(a.walkL.map((png) => [...png])).toEqual(b.walkL.map((png) => [...png]));
    expect(a.walkR.map((png) => [...png])).toEqual(b.walkR.map((png) => [...png]));
    expect(source.rgba).toEqual(before);
  });

  test("rejects a wrong sheet size or a layout outside the declared grid", () => {
    expect(() => sliceWalkerSheet({ width: 47, height: 128, rgba: new Uint8Array() }))
      .toThrow("expected a 3x4 sheet of 16x32 cells");
    expect(() => sliceWalkerSheet(sourceSheet(), {
      layout: { ...TUXEMON_WALKER_LAYOUT, idleCol: 3 },
    })).toThrow("outside the 3x4 sheet");
  });
});
