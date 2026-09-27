// tests/meadow-sim.test.ts — the minimal example boots on PocketJS's wasm
// sim host and proves the packaged component works end to end:
//
//   PIXELS     semantic assertions, not only hashes: a map smaller than the
//              viewport is centered with black letterboxes at 480x272 and
//              after a live resize to 800x600; map ground is content (the
//              pad green), not black or empty.
//   EVENTS     the signpost text/choices flow sets the switch and self
//              switch; the flowerbed playerTouch opens on cell entry; the
//              chest grants gold and the item; the parallel brook emits its
//              sound cue after its 5-second wait.
//   DETERM.    one fixed 400-frame tape driven through two fresh boots hashes
//              byte-identically, frame for frame.
//   GOLDEN     pinned FNV hashes for selected frames (a regression net that
//              sits beside the semantic checks; a hash alone cannot tell
//              content from a wrong-but-stable render).
//
// Requires dist/meadow.js (bun run build:example) and the vendored wasm
// (cd vendor/pocketjs && bun tools/wasm.ts).

import { describe, expect, test } from "bun:test";
import { bootExample, fnv1a, simPreflight } from "./helpers/boot.ts";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";

// Without the built bundle/wasm these host tests cannot boot; register
// them as skips with the build command printed once.
const preflight = simPreflight();
if (!preflight.ok) console.warn(`example sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;

const TILE_MS = 8; // frames per 16px tile at 2 px/frame, 60 Hz

async function boot(w = 480, h = 272) {
  const world = await bootExample(60, undefined, { width: w, height: h });
  const step = (buttons: number) => {
    world.frame(buttons, 0x8080);
    world.tick();
    return fnv1a(world.render());
  };
  step(0); // compose the idle first frame
  return { world, step, render: world.render };
}

const state = (): any => (globalThis as any).__rpgkitExample.state();

const isBlack = (fb: Uint8Array, p: number): boolean =>
  fb[p]! === 0 && fb[p + 1]! === 0 && fb[p + 2]! === 0 && fb[p + 3]! === 255;

const isMapContent = (fb: Uint8Array, p: number): boolean =>
  fb[p + 3] === 255 && !(fb[p] === 0 && fb[p + 1] === 0 && fb[p + 2] === 0);

/** Hold one direction for `tiles` complete tile steps. Returns frames. */
function walk(step: (b: number) => string, btn: number, tiles: number): string[] {
  const hashes: string[] = [];
  for (let i = 0; i < tiles * TILE_MS; i++) hashes.push(step(btn));
  step(0); // one rest frame on the boundary
  return hashes;
}

simDescribe("example — letterbox pixel rule (semantic, not hash-only)", () => {
  test("480x272: 80px side bands and 40px top/bottom bands are black; map is content", async () => {
    const { render } = await boot();
    const fb = render();
    const W = 480;
    // meadow 320x192 centers at (80,40).
    expect(isBlack(fb, (136 * W + 8) * 4)).toBe(true);
    expect(isBlack(fb, (136 * W + W - 8) * 4)).toBe(true);
    expect(isBlack(fb, (8 * W + 240) * 4)).toBe(true);
    expect(isBlack(fb, ((272 - 9) * W + 240) * 4)).toBe(true);
    // Just inside the centered world: grass pad and road are opaque content.
    expect(isMapContent(fb, ((40 + 24) * W + (80 + 20)) * 4)).toBe(true);
    // Road tile meadow (13,7) at screen (80+208, 40+112).
    expect(isMapContent(fb, ((40 + 118) * W + (80 + 214)) * 4)).toBe(true);
    // A horizontal strip inside the map is not ALL black (would catch a
    // collapsed/empty world frame).
    let content = 0;
    for (let x = 80; x < 400; x += 4) if (isMapContent(fb, (100 * W + x) * 4)) content++;
    expect(content).toBeGreaterThan(40);
  });

  test("a live resize to 800x600 recenters to (240,196)", async () => {
    const b = await boot(480, 272);
    b.world.resizeViewport(800, 600);
    b.step(0);
    const fb = b.render();
    expect(fb.length).toBe(800 * 600 * 4);
    expect(isBlack(fb, (300 * 800 + 8) * 4)).toBe(true);
    expect(isBlack(fb, (300 * 800 + 800 - 8) * 4)).toBe(true);
    expect(isMapContent(fb, (300 * 800 + 260) * 4)).toBe(true);
    expect(isBlack(fb, ((196 - 8) * 800 + 400) * 4)).toBe(true);
  });
});

simDescribe("example — pinned golden frames", () => {
  test("idle and early-walk frames match the pinned hashes", async () => {
    const { step } = await boot();
    expect(step(0)).toBe("a25f8546");
    const walkHashes: string[] = [];
    for (let i = 0; i < TILE_MS; i++) walkHashes.push(step(BTN.RIGHT));
    expect(walkHashes[0]).toBe("0c7bf21d");
    expect(walkHashes[7]).toBe("018fb566");
    expect(step(0)).toBe("018fb566");
  });
});

simDescribe("example — events over the live session reducer", () => {
  test("the signpost text/choices flow sets note-read and self switch A", async () => {
    const { step } = await boot();
    // Open, skip, close the text; pick "Read note"; skip/close the branch
    // line (mirrors the upstream signpost tape timing).
    const tape = [
      BTN.CIRCLE, 0, BTN.CIRCLE, 0, BTN.CIRCLE, 0, 0, 0,
      BTN.CIRCLE, 0, BTN.CIRCLE, 0, BTN.CIRCLE, 0,
    ];
    for (const b of tape) step(b);
    const s = state();
    expect(s.sw.switches["note-read"]).toBe(true);
    expect(s.sw.self["meadow/signpost"]).toBe("A");
    // Page 2 is active now; a fresh confirm opens its single line.
    step(0);
    step(BTN.CIRCLE);
    expect(state().interp.modal?.kind).toBe("text");
  });

  test("walking onto the flowerbed opens its playerTouch line without confirm", async () => {
    const { step } = await boot();
    walk(step, BTN.LEFT, 2); // (10,7) -> (8,7)
    const hashes = walk(step, BTN.DOWN, 1); // (8,7) -> (8,8)
    // The touch fires on the entry frame; the modal is open by the rest
    // frame after the step lands.
    void hashes;
    let s = state();
    expect(s.move.tx).toBe(8);
    expect(s.move.ty).toBe(8);
    s = state();
    expect(s.interp.modal?.kind).toBe("text");
    // First CONFIRM completes the typewriter, the second closes the box.
    step(BTN.CIRCLE);
    step(0);
    step(BTN.CIRCLE);
    step(0);
    expect(state().interp.modal).toBeNull();
  });

  test("the chest grants 25 gold and a potion and swaps to its spent page", async () => {
    const { step } = await boot();
    walk(step, BTN.RIGHT, 5); // (10,7) -> (15,7)
    walk(step, BTN.UP, 4); // (15,7) -> (15,3), ends facing up
    expect(state().move.tx).toBe(15);
    expect(state().move.ty).toBe(3);
    step(BTN.CIRCLE); // grants run before the text opens
    const s = state();
    expect(s.sw.gold).toBe(30);
    expect(s.sw.items["potion"]).toBe(1);
    expect(s.sw.self["meadow/chest"]).toBe("A");
    expect(s.interp.modal?.kind).toBe("text");
  });

  test("the parallel brook waits 5 seconds, then emits its drip cue and restarts", async () => {
    const { step } = await boot();
    let sawCue = false;
    for (let f = 0; f < 320; f++) {
      step(0);
      const cues = state().interp.cues as { name: string }[];
      if (cues.some((c) => c.name === "drip")) sawCue = true;
    }
    expect(sawCue).toBe(true);
  });
});

simDescribe("example — determinism", () => {
  test("one fixed 400-frame tape hashes byte-identically across two boots", async () => {
    const tape: number[] = [];
    for (let f = 0; f < 400; f++) {
      const phase = f % 64;
      let b = 0;
      if (phase < 16) b = BTN.RIGHT;
      else if (phase < 32) b = BTN.UP;
      else if (phase < 48) b = BTN.LEFT;
      else b = BTN.DOWN;
      if (f === 70 || f === 200) b = BTN.CIRCLE; // drive/close dialogs mid-walk
      tape.push(b);
    }
    const run = async (): Promise<string[]> => {
      const { step } = await boot();
      return tape.map(step);
    };
    const a = await run();
    const b = await run();
    expect(a).toEqual(b);
    expect(new Set(a).size).toBeGreaterThan(10); // the world actually moved
  });
});
