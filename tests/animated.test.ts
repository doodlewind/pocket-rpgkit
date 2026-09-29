import { describe, expect, test } from "bun:test";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import {
  animatedManifestSource,
  cookAnimationAtlases,
  type AnimationSequenceInput,
} from "../tools/lib/animated.ts";

type Rgba = readonly [number, number, number, number];

function solid(colour: Rgba): Uint8Array {
  const out = new Uint8Array(16 * 16 * 4);
  for (let i = 0; i < 16 * 16; i++) out.set(colour, i * 4);
  return out;
}

function pixel(rgba: Uint8Array, width: number, x: number, y: number): number[] {
  const i = (y * width + x) * 4;
  return [...rgba.subarray(i, i + 4)];
}

const RED: Rgba = [230, 30, 50, 255];
const GREEN: Rgba = [20, 210, 80, 255];
const BLUE: Rgba = [30, 80, 230, 255];

function fixture(): AnimationSequenceInput[] {
  return [
    {
      id: "water-a",
      frames: [
        { rgba: solid(RED), durationMs: 200 },
        { rgba: solid(GREEN), durationMs: 50 },
        { rgba: solid(BLUE), durationMs: 900 },
      ],
    },
    {
      id: "water-copy",
      frames: [
        { rgba: solid(RED), durationMs: 200 },
        { rgba: solid(GREEN), durationMs: 777 },
        { rgba: solid(BLUE), durationMs: 1 },
      ],
    },
    {
      id: "slow-water",
      frames: [
        { rgba: solid(RED), durationMs: 1_000 },
        { rgba: solid(GREEN), durationMs: 50 },
        { rgba: solid(BLUE), durationMs: 50 },
      ],
    },
  ];
}

describe("animated tile asset cooker", () => {
  test("writes a power-of-two RGBA atlas and sprites.json metadata", () => {
    const cooked = cookAnimationAtlases(fixture());
    expect(cooked.atlases).toHaveLength(2);
    expect(cooked.atlasFor.get("water-a")).toBe("assets/anim/anim-0.png");
    expect(cooked.atlasFor.get("water-copy")).toBe("assets/anim/anim-0.png");
    expect(cooked.atlasFor.get("slow-water")).toBe("assets/anim/anim-1.png");
    expect(cooked.atlases[0]!.meta).toEqual({ cols: 4, rows: 1, frames: 3, step: 12, psm: 3 });
    expect(cooked.atlases[1]!.meta.step).toBe(60);
    expect(cooked.spritesJson).toEqual({
      "assets/anim/anim-0.png": { cols: 4, rows: 1, frames: 3, step: 12, psm: 3 },
      "assets/anim/anim-1.png": { cols: 4, rows: 1, frames: 3, step: 60, psm: 3 },
    });

    const atlas = decodePng(cooked.atlases[0]!.png);
    expect({ width: atlas.width, height: atlas.height }).toEqual({ width: 64, height: 16 });
    expect(pixel(atlas.rgba, atlas.width, 8, 8)).toEqual([...RED]);
    expect(pixel(atlas.rgba, atlas.width, 24, 8)).toEqual([...GREEN]);
    expect(pixel(atlas.rgba, atlas.width, 40, 8)).toEqual([...BLUE]);
    expect(pixel(atlas.rgba, atlas.width, 56, 8)).toEqual([0, 0, 0, 0]);
  });

  test("uses the first authored duration and emits byte-stable output", () => {
    const a = cookAnimationAtlases(fixture(), { directory: "art/tiles/", prefix: "cycle" });
    const b = cookAnimationAtlases(fixture(), { directory: "art/tiles/", prefix: "cycle" });
    expect(a.atlases.map((atlas) => [...atlas.png])).toEqual(b.atlases.map((atlas) => [...atlas.png]));
    expect(a.spritesJson).toEqual(b.spritesJson);
    expect(a.atlases[0]!.file).toBe("art/tiles/cycle-0.png");
    expect(a.atlases[0]!.step).toBe(12);
  });

  test("rejects empty and incorrectly-sized frames", () => {
    expect(() => cookAnimationAtlases([{ id: "empty", frames: [] }])).toThrow("at least one frame");
    expect(() => cookAnimationAtlases([{
      id: "short",
      frames: [{ rgba: new Uint8Array(7), durationMs: 100 }],
    }])).toThrow("got 7 RGBA bytes");
  });

  test("writes deterministic GameAssets placements including __proto__ map ids", () => {
    const maps = [
      { id: "plain", tiles: [{ x: 3, y: 5, above: false, sprite: "assets/anim/a.png" }] },
      { id: "empty", tiles: [] },
      { id: "__proto__", tiles: [{ x: 7, y: 11, above: true, sprite: "assets/anim/b.png" }] },
    ] as const;
    const source = animatedManifestSource(maps);
    expect(source).toBe(animatedManifestSource(maps));
    expect(source).toContain('"plain": [');
    expect(source).not.toContain('"empty":');
    expect(source).toContain('["__proto__"]: [');
    expect(source).toContain('{ x: 7, y: 11, above: true, sprite: "assets/anim/b.png" }');
  });
});
