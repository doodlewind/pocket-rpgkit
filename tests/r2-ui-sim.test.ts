import { describe, expect, test } from "bun:test";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { fnv1a } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { chunkWindow } from "../src/engine/chunk-window.ts";
import { walkPose } from "../src/engine/movement.ts";
import { TILE } from "../src/engine/tiles.ts";
import type { AnimatedTilesStats } from "../src/ui/AnimatedTiles.tsx";
import {
  ABOVE_ANIMATION,
  CANOPY_NPC,
  PLAYER_START,
  R2_MAP_SIZE,
} from "./fixtures/r2-ui/fixture-data.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import {
  bootGameWorld,
  installGameSimIsolation,
  type BoundGameWorld,
} from "./helpers/sim-session.ts";

const preflight = appPreflight("r2-ui");
if (!preflight.ok) console.warn(`r2-ui sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
installGameSimIsolation();

type Rgba = readonly [number, number, number, number];
type FacingName = "down" | "left" | "up" | "right";

const VIEWPORT = { width: 480, height: 272 } as const;
const FACING_COLOURS: Record<FacingName, Rgba> = {
  down: [246, 92, 92, 255],
  left: [86, 216, 116, 255],
  up: [246, 206, 74, 255],
  right: [74, 132, 246, 255],
};
const ANIMATION_COLOURS: readonly Rgba[] = [
  [22, 190, 214, 255],
  [246, 188, 58, 255],
  [124, 96, 238, 255],
  [236, 72, 104, 255],
];
const IDLE_FEET: Rgba = [238, 238, 244, 255];
const CANOPY: Rgba = [174, 48, 142, 255];

interface R2Stats {
  below?: AnimatedTilesStats;
  above?: AnimatedTilesStats;
}

const stats = (): R2Stats =>
  structuredClone((globalThis as { __r2UiStats?: R2Stats }).__r2UiStats ?? {});

function pump(world: BoundGameWorld, frames: number, buttons = 0): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(buttons, 0x8080);
    for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  }
}

function rgbaAt(frame: Uint8Array, width: number, x: number, y: number): number[] {
  const i = (Math.round(y) * width + Math.round(x)) * 4;
  return [...frame.subarray(i, i + 4)];
}

function expectPixel(
  frame: Uint8Array,
  width: number,
  x: number,
  y: number,
  colour: Rgba,
): void {
  expect(rgbaAt(frame, width, x, y), `pixel (${x},${y})`).toEqual([...colour]);
}

async function golden(name: string, frame: Uint8Array): Promise<string> {
  const url = new URL(`./goldens/${name}.png`, import.meta.url);
  if (process.env.R2_UI_UPDATE_GOLDENS) {
    await Bun.write(url, encodePNG(frame, VIEWPORT.width, VIEWPORT.height));
  }
  const bytes = new Uint8Array(await Bun.file(url).arrayBuffer());
  expect(frame).toEqual(decodePng(bytes).rgba);
  return fnv1a(frame);
}

function playerHead(world: BoundGameWorld, frame: Uint8Array, colour: Rgba): void {
  const { state, camera } = world.probes();
  expectPixel(frame, VIEWPORT.width, state.move.px - camera.x + 8, state.move.py - camera.y - 8, colour);
  expectPixel(frame, VIEWPORT.width, state.move.px - camera.x + 6, state.move.py - camera.y + 13, IDLE_FEET);
}

function moveOne(world: BoundGameWorld, buttons: number, x: number, y: number): void {
  for (let frames = 0; frames < 20; frames++) {
    pump(world, 1, buttons);
    const move = world.probes().state.move;
    if (move.tx === x && move.ty === y && !move.moving) break;
  }
  pump(world, 1);
  const move = world.probes().state.move;
  expect({ x: move.tx, y: move.ty, moving: move.moving }).toEqual({ x, y, moving: false });
}

function findNode(tree: unknown, name: string): any {
  const node = tree as { n?: string; k?: unknown[] };
  if (node?.n === name) return node;
  for (const child of node?.k ?? []) {
    const found = findNode(child, name);
    if (found) return found;
  }
  return undefined;
}

simDescribe("animated tiles", () => {
  test("mounts only the viewport + one-tile ring and advances native atlas frame 6", async () => {
    const world = await bootGameWorld(appBundle("r2-ui"), 60, undefined, undefined, VIEWPORT);
    pump(world, 1);

    const camera = world.probes().camera;
    const expected = chunkWindow(
      camera,
      { w: VIEWPORT.width, h: VIEWPORT.height },
      TILE,
      R2_MAP_SIZE.width,
      R2_MAP_SIZE.height,
      TILE,
    );
    const mounted = (expected.x1 - expected.x0 + 1) * (expected.y1 - expected.y0 + 1);
    expect(stats().below).toMatchObject({ mounted, created: mounted, pooled: 0 });
    expect(stats().above).toMatchObject({ mounted: 1, created: 1, pooled: 0 });

    const sampleX = 3 * TILE - camera.x + 8;
    const sampleY = 3 * TILE - camera.y + 8;
    expectPixel(world.render(), VIEWPORT.width, sampleX, sampleY, ANIMATION_COLOURS[0]!);
    pump(world, 5);
    const sixth = world.render().slice();
    expectPixel(sixth, VIEWPORT.width, sampleX, sampleY, ANIMATION_COLOURS[1]!);
    expect(await golden("r2-ui.animation-frame-6", sixth)).toBe("1e8ffbf5");

    const tree = findNode(world.getTree(), "rpgkit-world");
    const names = (tree.k as { n?: string }[]).map((node) => node.n ?? "");
    expect(names.indexOf("rpgkit-anim-below")).toBeLessThan(names.indexOf("rpgkit-npcs-r2-ui-field"));
    expect(names.indexOf("rpgkit-npcs-r2-ui-field")).toBeLessThan(names.indexOf("rpgkit-upper"));
    expect(names.indexOf("rpgkit-upper")).toBeLessThan(names.indexOf("rpgkit-anim-above"));
  }, 30_000);

  test("native animation and reducer-owned walkers agree at 60/30/20 Hz", async () => {
    const samples: Array<{ hash: string; player: unknown; npc: unknown }> = [];
    for (const hz of [60, 30, 20] as const) {
      const world = await bootGameWorld(appBundle("r2-ui"), hz, undefined, undefined, VIEWPORT);
      pump(world, hz * 2);
      const state = world.probes().state;
      samples.push({
        hash: fnv1a(world.render()),
        player: {
          tx: state.move.tx,
          ty: state.move.ty,
          px: state.move.px,
          py: state.move.py,
          facing: state.move.facing,
          phase: state.move.phase,
        },
        npc: state.chars.chars["walking-npc"],
      });
    }
    expect(samples[1]).toEqual(samples[0]);
    expect(samples[2]).toEqual(samples[0]);
  }, 30_000);
});

simDescribe("16x32 walkers", () => {
  test("renders four idle facings, bottom-anchors feet, and lets upper art occlude a head", async () => {
    const world = await bootGameWorld(appBundle("r2-ui"), 60, undefined, undefined, VIEWPORT);
    pump(world, 1);

    const down = world.render().slice();
    playerHead(world, down, FACING_COLOURS.down);
    expect(await golden("r2-ui.walker-down", down)).toBe("f084bf2f");

    moveOne(world, BTN.RIGHT, PLAYER_START.x + 1, PLAYER_START.y);
    const right = world.render().slice();
    playerHead(world, right, FACING_COLOURS.right);
    expect(await golden("r2-ui.walker-right", right)).toBe("b6d1978b");

    moveOne(world, BTN.UP, PLAYER_START.x + 1, PLAYER_START.y - 1);
    const up = world.render().slice();
    playerHead(world, up, FACING_COLOURS.up);
    expect(await golden("r2-ui.walker-up", up)).toBe("1b95ab45");

    moveOne(world, BTN.LEFT, PLAYER_START.x, PLAYER_START.y - 1);
    const left = world.render().slice();
    playerHead(world, left, FACING_COLOURS.left);
    expect(await golden("r2-ui.walker-left", left)).toBe("3a6dc9ed");

    moveOne(world, BTN.DOWN, PLAYER_START.x, PLAYER_START.y);
    const camera = world.probes().camera;
    const occludedHead = {
      x: CANOPY_NPC.x * TILE - camera.x + 8,
      y: (CANOPY_NPC.y - 1) * TILE - camera.y + 8,
    };
    const visibleBody = {
      x: CANOPY_NPC.x * TILE - camera.x + 8,
      y: CANOPY_NPC.y * TILE - camera.y + 4,
    };
    expectPixel(world.render(), VIEWPORT.width, occludedHead.x, occludedHead.y, CANOPY);
    expectPixel(world.render(), VIEWPORT.width, visibleBody.x, visibleBody.y, FACING_COLOURS.down);

    const aboveX = ABOVE_ANIMATION.x * TILE - camera.x + 8;
    const aboveY = ABOVE_ANIMATION.y * TILE - camera.y + 8;
    expect(ANIMATION_COLOURS.map((colour) => [...colour])).toContainEqual(
      rgbaAt(world.render(), VIEWPORT.width, aboveX, aboveY),
    );
  }, 30_000);

  test("selects both walking poses for an NPC from its live CharState phase", async () => {
    const world = await bootGameWorld(appBundle("r2-ui"), 60, undefined, undefined, VIEWPORT);
    let guard = 0;
    while (walkPose(world.probes().state.chars.chars["walking-npc"]?.phase ?? 0) !== 1 && guard++ < 20) {
      pump(world, 1);
    }
    let { state, camera } = world.probes();
    let npc = state.chars.chars["walking-npc"]!;
    expect(npc.facing).toBe(3);
    expect(walkPose(npc.phase)).toBe(1);
    expectPixel(world.render(), VIEWPORT.width, npc.px - camera.x + 3, npc.py - camera.y + 13, [252, 72, 214, 255]);

    guard = 0;
    while (walkPose(world.probes().state.chars.chars["walking-npc"]!.phase) !== 2 && guard++ < 20) {
      pump(world, 1);
    }
    ({ state, camera } = world.probes());
    npc = state.chars.chars["walking-npc"]!;
    expect(walkPose(npc.phase)).toBe(2);
    expectPixel(world.render(), VIEWPORT.width, npc.px - camera.x + 13, npc.py - camera.y + 13, [68, 232, 248, 255]);
  }, 30_000);
});
