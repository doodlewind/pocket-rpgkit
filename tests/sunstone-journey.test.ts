// tests/sunstone-journey.test.ts — D1 attract content: the deterministic
// winning-playthrough tape ("The Sunstone of Bramble Hollow", village key
// chest → wood rune → thorn gate → cave iron gate → Sunstone).
//
//   1. The adaptive driver (examples/sunstone/journey.ts) reaches the victory state at
//      every sim rate 60/30/20/4 Hz: milestone SWITCH/ITEM/MAP snapshots
//      are byte-identical across rates. The mover is an 8-frames-per-tile,
//      60-Hz-policy system (engine/movement.ts), so fixed frame scripts do
//      not align across rates — the same JOURNEY in virtual time does, and
//      the driver is what proves it.
//   2. Two runs at the same rate produce the same masks and states.
//   3. The built-in frozen tape (examples/sunstone/demo-tape.ts) expands to the exact
//      masks the driver records, and replaying it against the BUILT
//      sunstone bundle reaches the same per-frame session states — the
//      shipped demo cannot drift from the shipped game.
//
// Sim cases need `bun run build:wasm` and `bun run build:example sunstone`;
// without them they register as skips.

import { describe, expect, test } from "bun:test";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import { bootWorld, fnv1a } from "../vendor/pocketjs/hosts/sim/sim.ts";
import {
  DEMO_TAPE_FRAMES,
  DEMO_TAPE_MILESTONES,
  DEMO_TAPE_RUNS,
} from "../examples/sunstone/demo-tape.ts";
import {
  milestoneSnapshot,
  playWinningRun,
} from "../examples/sunstone/journey.ts";
import type { SessionState } from "../src/engine/session.ts";

const preflight = appPreflight("sunstone");
if (!preflight.ok) console.warn(`sunstone bundle replay skipped: ${preflight.reason}`);
const simTest = preflight.ok ? test : test.skip;

function expandRuns(runs: readonly (readonly [number, number])[]): number[] {
  const out: number[] = [];
  for (const [mask, count] of runs) for (let i = 0; i < count; i++) out.push(mask);
  return out;
}

const RATES = [60, 30, 20, 4] as const;

describe("journey driver — one virtual playthrough at every sim rate", () => {
  for (const hz of RATES) {
    test(`${hz} Hz: opens the chest, lights the rune, takes the Sunstone`, () => {
      const r = playWinningRun(hz);
      const end = milestoneSnapshot(r.states[r.milestones.end]!);
      expect(end).toMatchObject({
        mapId: "cave",
        items: { "thorn-key": 1, sunstone: 1 },
        switches: { "rune-lit": true, won: true },
      });
      // Gold: 5 start + 25 village chest; the 10-gold torch is never bought.
      expect((end as { gold: number }).gold).toBe(30);
    });
  }

  test("milestone states are byte-identical across 60/30/20/4 Hz", () => {
    const ref = playWinningRun(60);
    const keys = ["chest", "forest", "rune", "cave", "gate", "end"] as const;
    for (const hz of [30, 20, 4] as const) {
      const r = playWinningRun(hz);
      for (const k of keys) {
        expect(milestoneSnapshot(r.states[r.milestones[k]]!), `milestone ${k} at ${hz} Hz`).toEqual(
          milestoneSnapshot(ref.states[ref.milestones[k]]!),
        );
      }
    }
  });

  test("two runs at the same rate record the same masks and states", () => {
    for (const hz of RATES) {
      const a = playWinningRun(hz);
      const b = playWinningRun(hz);
      expect(b.masks, `masks at ${hz} Hz`).toEqual(a.masks);
      expect(b.states, `states at ${hz} Hz`).toEqual(a.states);
    }
  });
});

describe("built-in attract tape", () => {
  test("the frozen RLE tape expands to the driver's recorded 60 Hz masks", () => {
    const r = playWinningRun(60);
    const masks = expandRuns(DEMO_TAPE_RUNS);
    expect(masks).toHaveLength(DEMO_TAPE_FRAMES);
    expect(masks).toEqual(r.masks);
    expect(DEMO_TAPE_FRAMES).toBe(r.masks.length);
    expect(r.milestones).toEqual({ ...DEMO_TAPE_MILESTONES });
  });

  simTest("replaying it against the built sunstone bundle wins, deterministically", async () => {
    const masks = expandRuns(DEMO_TAPE_RUNS);

    const drive = async (hz: number): Promise<{ hashes: string[]; states: SessionState[] }> => {
      const world = await bootWorld(appBundle("sunstone"), hz);
      const hashes: string[] = [];
      const states: SessionState[] = [];
      const g = globalThis as { __rpgSessionState?: SessionState };
      for (const mask of masks) {
        world.frame(mask, 0x8080);
        world.tick();
        hashes.push(fnv1a(world.render()));
        states.push(structuredClone(g.__rpgSessionState!) as SessionState);
      }
      return { hashes, states };
    };

    const a = await drive(60);
    const b = await drive(60);
    expect(b.hashes).toEqual(a.hashes);
    expect(b.states).toEqual(a.states);

    // The bundle playthrough ends on the victory state in the cave.
    const last = a.states[a.states.length - 1]!;
    expect(last.mapId).toBe("cave");
    expect(last.sw.items.sunstone).toBe(1);
    expect(last.sw.switches.won).toBe(true);

    // Bundle states equal the pure-driver states frame for frame.
    const driver = playWinningRun(60);
    expect(a.states).toEqual(driver.states);
  }, 60_000);
});
