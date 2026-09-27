// tests/rpgkit-grow-hz.test.ts — D3 hz portability and play-layer order,
// through the BUILT "grow" bundle on the deterministic wasm sim host.
//
// Acceptance for review task 1395's two blockers:
//
//   1. HZ     one virtual moment (frame/hz + seed) holds the same grown
//             world and the same framebuffer at 60/30/20/4 Hz; growth no
//             longer advances on a raw guest-frame count. In play mode L
//             rewinds exactly three virtual seconds at every rate and
//             lands cross-rate runs on the same world.
//   2. ORDER  NPCs and the player mount BETWEEN ground and the upper star
//             cells, like ui/GameView.tsx, so Ninja foliage/roofs paint over
//             a body. Semantic pixel fixture: the player walks under known
//             grown foliage and its canopy covers the sprite.
//
// Plus the top-right help plate's semantic bounds: its text nodes stay
// inside the plate and never run into the right screen border.

import { describe, expect, test } from "bun:test";
import { bootWorld, fnv1a } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { cameraXForState, DEFAULT_PARAMS, growToDone, liveFrameAtTick, totalTicks, worldSummary } from "../examples/grow/grow.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";

// Without the built bundle/wasm these host tests cannot boot; register
// them as skips with the build command printed once.
const preflight = appPreflight("grow");
if (!preflight.ok) console.warn(`grow sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;

interface GrowPub {
  mode: "grow" | "play";
  tick: number;
  total: number;
  auto: boolean;
  seed: number;
  hash: string;
}

type SimWorld = {
  frame: (b: number, a?: number, t?: readonly number[]) => void;
  tick: () => void;
  render: () => Uint8Array;
  getTree: () => unknown;
  ticksPerFrame: number;
};

async function boot(hz: number): Promise<SimWorld> {
  return (await bootWorld(appBundle("grow"), hz)) as unknown as SimWorld;
}

function pump(w: SimWorld, frames: number, mask = 0): void {
  for (let f = 0; f < frames; f++) {
    w.frame(mask);
    for (let t = 0; t < w.ticksPerFrame; t++) w.tick();
  }
}

const growPub = (): GrowPub =>
  structuredClone((globalThis as { __rpgGrowState: GrowPub }).__rpgGrowState);

const HZ_RATES = [60, 30, 20, 4] as const;
const SETTLED_SECONDS = Math.ceil(totalTicks(DEFAULT_PARAMS) * DEFAULT_PARAMS.tickSeconds) + 1;

simDescribe("D3 growth cadence is hz-portable", () => {
  for (const seconds of [5, 10]) {
    test(`grown state and framebuffer agree at 60/30/20/4 Hz after ${seconds} virtual seconds`, async () => {
      const refs: { pub: GrowPub; hash: string }[] = [];
      for (const hz of HZ_RATES) {
        const w = await boot(hz);
        pump(w, Math.round(seconds * hz));
        refs.push({ pub: growPub(), hash: fnv1a(w.render()) });
      }
      // Same virtual time: same action count (25 at 5 s — one action every
      // 0.2 virtual s), same world hash, same framebuffer, every rate.
      for (const r of refs) {
        expect(r.pub).toEqual(refs[0]!.pub);
        expect(r.hash).toBe(refs[0]!.hash);
      }
    }, 15_000);
  }

  test("a coarse 4 Hz frame can land several crossed actions at once", async () => {
    const w = await boot(4);
    pump(w, 20); // 5 virtual seconds
    expect(growPub().tick).toBe(25);
  });

  test("camera easing spans the same virtual fraction at every hz", () => {
    const state = growToDone(DEFAULT_PARAMS);
    const from = Math.max(0, state.cameraFromX - 96);
    const sample = (hz: number) => {
      const frame = liveFrameAtTick(DEFAULT_PARAMS, hz, state.tick) + DEFAULT_PARAMS.tickSeconds * hz / 2;
      const view = { ...state, hz, frame, cameraFromX: from };
      return cameraXForState(view);
    };
    // At 4 Hz the 0.2 s action interval is shorter than one host frame, so
    // cameraXForState clamps the easing span to that single frame. The other
    // supported rates can represent the same half-interval exactly.
    const easingRates = [60, 30, 20] as const;
    const values = easingRates.map(sample);
    expect(new Set(values).size).toBe(1);
    expect(values[0]).toBeGreaterThan(from);
    expect(values[0]).toBeLessThan(state.cameraX);
    // Mutation guard: a fixed twelve-frame span would put 4 Hz at the start
    // while 60 Hz is halfway through the same virtual interval.
    const fixed = (hz: number) => {
      const elapsed = DEFAULT_PARAMS.tickSeconds * hz / 2;
      const t = Math.max(0, Math.min(1, elapsed / 12));
      const eased = t * t * (3 - 2 * t);
      return Math.round((from + (state.cameraX - from) * eased) * 1000) / 1000;
    };
    expect(new Set(easingRates.map(fixed)).size).toBeGreaterThan(1);
  });

  test("every rate reaches the same done world", async () => {
    const done = growToDone(DEFAULT_PARAMS);
    const doneHash = worldSummary(done).hash;
    for (const hz of HZ_RATES) {
      const w = await boot(hz);
      pump(w, Math.round(SETTLED_SECONDS * hz));
      const p = growPub();
      expect(p.tick).toBe(done.tick);
      expect(p.hash).toBe(doneHash);
    }
  }, 30_000);
});

simDescribe("D3 play rewind means the same virtual time at every rate", () => {
  async function walkThenRewind(hz: number): Promise<{
    rewoundFrames: number;
    virtualSeconds: number;
    frame: number;
    px: number;
    py: number;
  }> {
    const w = await boot(hz);
    pump(w, SETTLED_SECONDS * hz);
    w.frame(BTN.CIRCLE);
    for (let t = 0; t < w.ticksPerFrame; t++) w.tick();
    pump(w, 1);
    // Walk exactly 3 virtual seconds holding RIGHT.
    pump(w, 3 * hz, BTN.RIGHT);
    const before = (globalThis as { __rpgSessionState: { frame: number } }).__rpgSessionState.frame;
    w.frame(BTN.LTRIGGER);
    for (let t = 0; t < w.ticksPerFrame; t++) w.tick();
    const s = (globalThis as { __rpgSessionState: {
      frame: number;
      move: { px: number; py: number };
    } }).__rpgSessionState;
    return {
      rewoundFrames: before - s.frame,
      virtualSeconds: (before - s.frame) / hz,
      frame: s.frame,
      px: s.move.px,
      py: s.move.py,
    };
  }

  test("L rewinds 180/90/60 guest frames = 3 virtual seconds, to the same world", async () => {
    const at60 = await walkThenRewind(60);
    const at30 = await walkThenRewind(30);
    const at20 = await walkThenRewind(20);
    expect(at60.rewoundFrames).toBe(180);
    expect(at30.rewoundFrames).toBe(90);
    expect(at20.rewoundFrames).toBe(60);
    for (const r of [at60, at30, at20]) {
      expect(r.virtualSeconds).toBe(3);
      expect(r.frame).toBe(1); // play frame 1, the clean world
      expect(r.px).toBe(128); // generated start tile (8,16) at every rate
      expect(r.py).toBe(256);
    }
  }, 30_000);
});

// --- tree order + semantic pixel occlusion --------------------------------

function findNode(tree: unknown, name: string): any {
  const n = tree as { n?: string; k?: any[] };
  if (n?.n === name) return n;
  for (const child of n?.k ?? []) {
    const result = findNode(child, name);
    if (result) return result;
  }
  return undefined;
}

async function enterPlayAndWalkUnderCanopy(): Promise<SimWorld> {
  const w = await boot(60);
  pump(w, SETTLED_SECONDS * 60);
  w.frame(BTN.CIRCLE);
  w.tick();
  pump(w, 1);
  // The generated start is (8,16). Walk to the bottom row of a walkable
  // 2x2 grove tree at (3,10): five tiles left along the trunk, then six up
  // between the first town's west lots. Villagers share the trunk, so hold
  // each direction until the tile is reached (bounded; the world is
  // deterministic, and the tx/ty assertions catch a blocked walk).
  const move = () => (globalThis as { __rpgSessionState: { move: { tx: number; ty: number } } }).__rpgSessionState.move;
  for (let f = 0; f < 160 && move().tx > 3; f++) pump(w, 1, BTN.LEFT);
  pump(w, 8);
  for (let f = 0; f < 160 && move().ty > 10; f++) pump(w, 1, BTN.UP);
  pump(w, 8);
  return w;
}

simDescribe("D3 play entities paint between ground and the upper layer", () => {
  test("tree order: NPCs and the player precede every upper star cell", async () => {
    const w = await enterPlayAndWalkUnderCanopy();
    const camera = findNode(w.getTree(), "rpgkit-grow-camera");
    const children = camera.k as { n?: string; t?: string }[];
    const upperLayer = children.findIndex((node) => node.n === "rpgkit-grow-upper-layer");
    const firstEntity = children.findIndex(
      (node) => node.n === "rpgkit-grow-npc" || (!node.n && node.t === "image"),
    );
    const lastEntity = children.map((node) => node.n).lastIndexOf("rpgkit-grow-npc");
    expect(upperLayer).toBeGreaterThan(firstEntity);
    expect(upperLayer).toBeGreaterThan(lastEntity);
  }, 15_000);

  test("pixel fixture: Ninja foliage canopy covers the player sprite", async () => {
    const w = await enterPlayAndWalkUnderCanopy();
    // The player stands on the bottom row of a walkable 2x2 grove tree at
    // (3,10). The stamp's top row is canopy: its green pixels occupy the tile
    // above the walker's feet and cover the walker's head.
    const session = (globalThis as { __rpgSessionState: { move: { tx: number; ty: number } } })
      .__rpgSessionState;
    expect(session.move.tx).toBe(3);
    expect(session.move.ty).toBe(10);
    const fb = w.render();
    const isFoliageGreen = (x: number, y: number): boolean => {
      const i = (y * 480 + x) * 4;
      return fb[i + 1]! > 100 && fb[i + 1]! - fb[i]! > 5 && fb[i + 1]! - fb[i + 2]! > 30;
    };
    let green = 0;
    for (let y = 144; y < 160; y++) for (let x = 48; x < 64; x++) {
      if (isFoliageGreen(x, y)) green++;
    }
    expect(green).toBeGreaterThanOrEqual(100);
  }, 15_000);
});

simDescribe("D3 grow help plate stays inside the right margin", () => {
  async function boundsAt(settled: boolean): Promise<void> {
    const w = await boot(60);
    pump(w, settled ? SETTLED_SECONDS * 60 : 8);
    const tree = w.getTree() as { i?: number } | null;
    const textIds = new Set<number>();
    (function collect(n: any): void {
      if (n?.t === "text") textIds.add(n.i as number);
      for (const c of n?.k ?? []) collect(c);
    })(tree);
    const ops = (globalThis as { ui?: { hitTestBounds?: (x: number, y: number) => number } }).ui;
    expect(ops?.hitTestBounds).toBeDefined();
    // Rows through all three help lines; the six-pixel margin after the
    // plate's right edge must never report a help text node.
    for (const y of [8, 20, 32]) {
      for (let x = 468; x < 474; x++) {
        expect(textIds.has(ops!.hitTestBounds!(x, y))).toBe(false);
      }
    }
  }

  test("help text stays inside its plate while growing", () => boundsAt(false));
  test("help text stays inside its plate on the finished ENTER row", () => boundsAt(true), 15_000);
});
