// tests/sunstone-attract-sim.test.ts — D1/D2 end-to-end through the BUILT
// sunstone bundle on the deterministic wasm sim host. The pure
// controller semantics live in attract.test.ts; here the same flows
// run through GameView (attract badge, "YOU HAVE CONTROL" and "REWIND 3
// SEC" overlays), pinned framebuffer hashes cross-checked against
// committed wasm-oracle PNGs plus semantic pixel assertions.
//
// Timeline (60 Hz, idle attract after 10 s = 600 frames):
//   f0..599   live play with no input
//   f600      attract starts and folds tape[0]
//   f601..699 tape[1..99]
//   f699      DEMO 100/539 badge, village by the chest house
//   f700      RIGHT pressed -> takeover frame (still folds tape[100]),
//             "YOU HAVE CONTROL" from this frame
//   f701      released live frame
//   f702      L -> REWIND 3 SEC; only 102 frames were logged after the
//             clean attract start, so it scrubs to frame 0 at (9,9)
//
// Sim cases need `bun run build:wasm` and `bun run build:example sunstone`;
// without them they register as skips.

import { describe, expect, test } from "bun:test";
import { bootWorld, fnv1a } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { AttractController } from "../src/engine/attract.ts";
import { expandTapeRuns } from "../src/engine/tape.ts";
import { DEMO_TAPE_RUNS } from "../examples/sunstone/demo-tape.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
const builtinAttractTape = (): number[] => expandTapeRuns(DEMO_TAPE_RUNS);
import { buildGame } from "../examples/sunstone/game-data.ts";
import type { SessionState } from "../src/engine/session.ts";

// Without the built bundle/wasm these host tests cannot boot; register
// them as skips with the build command printed once.
const preflight = appPreflight("sunstone");
if (!preflight.ok) console.warn(`sunstone sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;

const BTN_RIGHT = 0x0020;
const BTN_LTRIGGER = 0x0100;
const IDLE_FRAMES = 600;
const END_HOLD_FRAMES = 120;
const PACED_LOOP_FRAMES_60_HZ = 2693;

function pacedLoopFrames(): number {
  const { project } = buildGame();
  const controller = new AttractController(project, builtinAttractTape(), {
    hz: 60,
    tapeHz: 60,
    endHoldFrames: END_HOLD_FRAMES,
  });
  controller.startAttract();
  for (let frame = 1; frame <= 10_000; frame++) {
    if (controller.step(0).status.loopReset) return frame;
  }
  throw new Error("paced attract loop did not reset");
}

interface Box {
  n: number;
  minx: number;
  maxx: number;
  miny: number;
  maxy: number;
}

function box(fb: Uint8Array, pred: (r: number, g: number, b: number) => boolean, x0: number, x1: number, y0: number, y1: number): Box {
  let n = 0;
  let minx = 999, maxx = 0, miny = 999, maxy = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * 480 + x) * 4;
      if (pred(fb[i]!, fb[i + 1]!, fb[i + 2]!)) {
        n++;
        minx = Math.min(minx, x);
        maxx = Math.max(maxx, x);
        miny = Math.min(miny, y);
        maxy = Math.max(maxy, y);
      }
    }
  }
  return { n, minx, maxx, miny, maxy };
}

// The badge's dark navy plate (#0b1626 at 0.78 alpha over black), top-right.
const badgePlate = (fb: Uint8Array): Box =>
  box(fb, (r, g, b) => r <= 16 && g <= 24 && b >= 22 && b <= 40, 380, 480, 0, 26);
// "YOU HAVE CONTROL" amber glyph pixels whose band starts at the top y=24
// row (background foliage amber never reaches that row in the x band).
const controlAmber = (fb: Uint8Array): Box =>
  box(fb, (r, g, b) => r > 180 && g > 170 && b < 190 && r >= b, 120, 360, 24, 48);
// "REWIND 3 SEC" light blue (#8ad0ff), unique on the playfield.
const rewindBlue = (fb: Uint8Array): Box =>
  box(fb, (r, g, b) => b > 180 && r < 190 && g > 170, 150, 340, 36, 64);

async function scenario(): Promise<{
  frames: Map<number, Uint8Array>;
  states: Map<number, SessionState>;
}> {
  const world = await bootWorld(appBundle("sunstone"), 60);
  const g = globalThis as { __rpgSessionState?: SessionState };
  const frames = new Map<number, Uint8Array>();
  const states = new Map<number, SessionState>();
  const go = (f: number, mask: number): void => {
    world.frame(mask, 0x8080);
    world.tick();
    frames.set(f, world.render().slice());
    states.set(f, structuredClone(g.__rpgSessionState!) as SessionState);
  };
  let f = 0;
  for (; f < IDLE_FRAMES; f++) go(f, 0);
  for (let d = 0; d < 100; d++, f++) go(f, 0); // attract tape frames 0..99
  go(f++, BTN_RIGHT); // f700? — see assertions: capture indices below
  go(f++, 0);
  go(f, BTN_LTRIGGER); // rewind
  return { frames, states };
}

simDescribe("D1/D2 — attract/takeover/rewind through the built bundle", () => {
  test("the badge, control notice and rewind notice render with the right semantics", async () => {
    const { frames, states } = await scenario();
    const f700 = frames.get(699)!;
    const f701 = frames.get(700)!;
    const f704 = frames.get(702)!;

    // f699: attract, tape frame 100 — the DEMO plate is top-right and the
    // world is the village (the demo route has the player by the chest
    // house at this moment), no control notice yet.
    const plate = badgePlate(f700);
    expect(plate.n).toBeGreaterThan(300);
    expect(plate.minx).toBeGreaterThanOrEqual(380);
    expect(controlAmber(f700).miny).toBeGreaterThan(30); // background only
    expect(states.get(699)!.mapId).toBe("village");

    // f700: takeover frame — badge gone, "YOU HAVE CONTROL" occupies the
    // top-centre band from row 24.
    expect(badgePlate(f701).n).toBe(0);
    const notice = controlAmber(f701);
    expect(notice.n).toBeGreaterThan(350);
    expect(notice.miny).toBe(24);
    expect(notice.maxy).toBeGreaterThanOrEqual(44);

    // f702: after release and one L press — REWIND blue text and the world
    // scrubbed back to the village start area.
    const blue = rewindBlue(f704);
    expect(blue.n).toBeGreaterThan(200);
    expect(blue.minx).toBeGreaterThan(150);
    expect(blue.maxx).toBeLessThan(340);
    const s704 = states.get(702)!;
    expect(s704.mapId).toBe("village");
    // The rewound world sits near the start tile (within a couple of
    // tiles), hundreds of frames before the chest-house position.
    expect(Math.abs(s704.move.tx - 9) + Math.abs(s704.move.ty - 9)).toBeLessThanOrEqual(3);
  }, 60_000);

  const pins: Record<number, string> = {
    699: "078c9faf",
    700: "7a4f59c8",
    702: "7c6d95be",
  };

  test("pinned framebuffer hashes match the committed oracle PNGs", async () => {
    const { frames } = await scenario();
    for (const [fStr, hash] of Object.entries(pins)) {
      const f = Number(fStr);
      const fb = frames.get(f)!;
      expect(fnv1a(fb), `frame ${f}`).toBe(hash);
      const png = new Uint8Array(
        await Bun.file(new URL(`./goldens/sunstone-attract.${f}.png`, import.meta.url)).arrayBuffer(),
      );
      expect(fnv1a(decodePng(png).rgba), `frame ${f} PNG`).toBe(hash);
    }
  }, 60_000);

  test("the overlay flow is deterministic across two runs", async () => {
    const a = await scenario();
    const b = await scenario();
    expect([...a.frames.keys()].map((f) => fnv1a(a.frames.get(f)!))).toEqual(
      [...b.frames.keys()].map((f) => fnv1a(b.frames.get(f)!)),
    );
  }, 60_000);

  test("a second attract loop reproduces the first loop frame-for-frame", async () => {
    // Boot idle into attract (600), play the paced 539-frame source, rest
    // 120 frames on the victory state, then reset. Dialog typewriter and
    // readable holds expand the source to 2,573 timeline ticks, so the full
    // 60 Hz loop is 2,693 ticks. The second loop must reproduce the first
    // at offsets spanning source playback, readable holds, and reset.
    const world = await bootWorld(appBundle("sunstone"), 60);
    const hashes: string[] = [];
    const go = (): string => {
      world.frame(0, 0x8080);
      world.tick();
      return fnv1a(world.render());
    };
    const loopFrames = pacedLoopFrames();
    expect(loopFrames).toBe(PACED_LOOP_FRAMES_60_HZ);
    // The idle-threshold frame renders the same freshly reset state as each
    // loop-reset frame. Tape frame 0 is folded on the following host frame.
    const firstStart = IDLE_FRAMES - 1;
    const secondStart = firstStart + loopFrames;
    for (let f = 0; f < secondStart + loopFrames; f++) hashes.push(go());
    for (const k of [0, 100, 1000, 2500, loopFrames - 1]) {
      expect(hashes[secondStart + k], `second-loop frame ${k}`).toBe(hashes[firstStart + k]);
    }
  }, 60_000);
});
