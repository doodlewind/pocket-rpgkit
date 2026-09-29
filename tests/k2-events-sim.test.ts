// End-to-end discriminating coverage for the event-model fixture bundle:
//   A facing-gated exit mat crossed sideways
//   does not leave the map, then a turn in place fires it; and an `all`
//   compound page stays inactive while one clause is missing, activates
//   after the missing clause is armed.
//   On the dedicated movement map an autorun drives a distant
//   NPC with turnTowardPlayer + pathTo + approach, deterministically at
//   every supported rate and resumable from a mid-move save.

import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { bootWorld, type SimWorld } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import type { EventModelFixtureApi } from "./fixtures/event-model/event-model.tsx";

const preflight = appPreflight("event-model");
if (!preflight.ok) console.warn(`event-model sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
const RATES = [60, 30, 20] as const;

declare global {
  // eslint-disable-next-line no-var
  var __eventModelFixture: EventModelFixtureApi | undefined;
}

setDefaultTimeout(20_000);
beforeEach(() => {
  delete globalThis.__eventModelFixture;
});

function api() {
  if (!globalThis.__eventModelFixture) throw new Error("event-model fixture did not mount");
  return globalThis.__eventModelFixture;
}

function frame(world: SimWorld, buttons = 0): void {
  world.frame(buttons, 0x8080);
  for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
}

function idle(world: SimWorld, count: number): void {
  for (let i = 0; i < count; i++) frame(world, 0);
}

function awaitMap(world: SimWorld, mapId: string, ceiling = 120): void {
  for (let i = 0; i < ceiling; i++) {
    if (api().state().mapId === mapId) return;
    frame(world, 0);
  }
  throw new Error(`map ${mapId} was not reached`);
}

/** One tile: a single held host frame commits exactly one tile step at
 *  60/30/20 Hz (one frame folds 1/2/3 reference ticks, all < the 8-tick
 *  step, so a tap cannot chain a second step), then release until rest. */
function stepOnce(world: SimWorld, btn: number): void {
  frame(world, btn);
  for (let i = 0; i < 12; i++) {
    frame(world, 0);
    if (!api().state().move.moving) return;
  }
}

/** Tap-walk a straight axis to (x,y), stopping early on a map transfer. */
function tapTo(world: SimWorld, x: number, y: number, btn: number, ceiling = 80): void {
  const fromMap = api().state().mapId;
  for (let i = 0; i < ceiling; i++) {
    const s = api().state();
    if (s.mapId !== fromMap) return; // a touch pad transferred us away
    if (s.move.tx === x && s.move.ty === y) return;
    stepOnce(world, btn);
  }
  const s = api().state();
  throw new Error(`tapTo (${x},${y}) stopped at (${s.move.tx},${s.move.ty}) on ${s.mapId}`);
}

/** A pure turn in place (held one frame); the mover must not leave its cell. */
function turn(world: SimWorld, btn: number): void {
  const before = api().state().move;
  frame(world, btn);
  for (let i = 0; i < 4; i++) frame(world, 0);
  const after = api().state().move;
  if (after.tx !== before.tx || after.ty !== before.ty) {
    throw new Error(`turn moved the player from (${before.tx},${before.ty}) to (${after.tx},${after.ty})`);
  }
}

async function boot(hz: number): Promise<SimWorld> {
  const world = await bootWorld(appBundle("event-model"), hz);
  idle(world, world.hz); // let the boot autorun + lock window settle
  const s = api().state();
  expect(s.mapId).toBe("lab");
  return world;
}

simDescribe("facing-gated exit mat (K1 review leftover)", () => {
  test("crossing the mat sideways never leaves; turning down on it transfers", async () => {
    for (const hz of RATES) {
      const world = await boot(hz);
      // Reach (1,5) by walking straight down column 1.
      tapTo(world, 1, 5, BTN.DOWN);
      // Turn to face right, then step EAST onto the mat at (2,5) sideways.
      frame(world, BTN.RIGHT);
      idle(world, 2);
      tapTo(world, 2, 5, BTN.RIGHT);
      idle(world, 4);
      let s = api().state();
      // Sideways crossing: the mat demands facing DOWN, so no transfer.
      expect(s.mapId).toBe("lab");
      expect(s.sw.switches["mat-exited"] ?? false).toBe(false);
      // Keep going east off it, then come back west onto it, still sideways.
      tapTo(world, 3, 5, BTN.RIGHT);
      tapTo(world, 2, 5, BTN.LEFT);
      idle(world, 4);
      s = api().state();
      expect(s.mapId).toBe("lab");
      // The cell below (2,6) is blocked: pressing DOWN turns in place to
      // face down without moving, and the turn edge re-fires the touch page.
      frame(world, BTN.DOWN);
      idle(world, 24); // transfer to "matreturn" and immediately back to lab
      s = api().state();
      expect(s.sw.switches["mat-exited"] ?? false).toBe(true);
      // The round trip through the turn-gated mat lands back in the lab.
      expect(s.mapId).toBe("lab");
    }
  });
});

simDescribe("compound `all` page gate (K1 review leftover)", () => {
  test("stays inactive with a clause missing, activates once armed", async () => {
    for (const hz of RATES) {
      const world = await boot(hz);
      // Enter the all-gate cell (1,7) before all-ready is armed.
      tapTo(world, 1, 6, BTN.DOWN);
      tapTo(world, 1, 7, BTN.DOWN);
      idle(world, 4);
      let s = api().state();
      expect(s.sw.variables["all-hits"] ?? 0).toBeGreaterThanOrEqual(1); // clause 1 holds
      expect(s.sw.switches["all-ready"] ?? false).toBe(false); // clause 2 missing
      expect(s.sw.switches["all-fired"] ?? false).toBe(false); // page inactive
      // Walk east onto arm-all (3,7), which sets the missing switch.
      tapTo(world, 2, 7, BTN.RIGHT);
      tapTo(world, 3, 7, BTN.RIGHT);
      idle(world, 4);
      s = api().state();
      expect(s.sw.switches["all-ready"] ?? false).toBe(true);
      expect(s.sw.switches["all-fired"] ?? false).toBe(false);
      // Re-enter the gate cell: every clause now holds, the page fires.
      tapTo(world, 2, 7, BTN.LEFT);
      tapTo(world, 1, 7, BTN.LEFT);
      idle(world, 4);
      s = api().state();
      expect(s.sw.switches["all-fired"] ?? false).toBe(true);
    }
  });
});

simDescribe("K2 movement extension through the real bundle", () => {
  async function reachK2Done(hz: number): Promise<{
    world: SimWorld;
    npcCell: { tx: number; ty: number; facing: number };
    done: boolean;
    referenceTicks: number;
  }> {
    const world = await boot(hz);
    // Step onto the transfer pad at (1,10).
    tapTo(world, 1, 10, BTN.DOWN);
    awaitMap(world, "k2");
    let s = api().state();
    expect(s.mapId).toBe("k2");
    expect(s.move).toMatchObject({ tx: 1, ty: 6 });
    // The autorun drives the NPC with no player input.
    let hostFrames = 0;
    for (; hostFrames < 600; hostFrames++) {
      frame(world, 0);
      s = api().state();
      if (s.sw.switches["k2-done"]) {
        hostFrames++;
        break;
      }
    }
    const npc = s.chars.chars["k2-npc"]!;
    return {
      world,
      npcCell: { tx: npc.tx, ty: npc.ty, facing: npc.facing },
      done: !!s.sw.switches["k2-done"],
      referenceTicks: hostFrames * world.ticksPerFrame,
    };
  }

  test("an NPC turns, pathfinds and approaches the player, identically at 60/30/20 Hz", async () => {
    const runs = [];
    for (const hz of RATES) {
      runs.push(await reachK2Done(hz));
    }
    for (const r of runs) {
      expect(r.done).toBe(true);
      // The NPC ends on the tile just east of the player (2,6), facing west
      // (1) toward the player at (1,6).
      expect(r.npcCell).toEqual({ tx: 2, ty: 6, facing: 1 });
    }
    const durations = runs.map((r) => r.referenceTicks);
    expect(Math.max(...durations) - Math.min(...durations)).toBeLessThanOrEqual(2);
  });

  test("a full-state save taken mid path-step restores to the identical end", async () => {
    // Reach k2 and snapshot while the NPC is committed to a BFS path step.
    const world = await boot(60);
    tapTo(world, 1, 10, BTN.DOWN);
    awaitMap(world, "k2");
    expect(api().state().mapId).toBe("k2");
    let mid: string | null = null;
    let midFrame = -1;
    for (let i = 0; i < 400; i++) {
      frame(world, 0);
      const s = api().state();
      const npc = s.chars.chars["k2-npc"]!;
      if (npc.route?.plan && (npc.moving || npc.phase > 0)) {
        mid = api().snapshotFull();
        midFrame = s.frame;
        break;
      }
    }
    expect(mid).not.toBeNull();

    // Finish the uninterrupted trajectory, recording the end per frame.
    const finishFrom = (w: SimWorld): { npc: { tx: number; ty: number; facing: number }; done: boolean; frames: number } => {
      let f = 0;
      for (let i = 0; i < 600; i++) {
        frame(w, 0);
        f++;
        if (api().state().sw.switches["k2-done"]) break;
      }
      const npc = api().state().chars.chars["k2-npc"]!;
      return { npc: { tx: npc.tx, ty: npc.ty, facing: npc.facing }, done: !!api().state().sw.switches["k2-done"], frames: f };
    };
    const uninterrupted = finishFrom(world);

    // Fresh boot, get onto k2, then restore the mid-path full state and
    // finish again from the SAME frame with the SAME (empty) input.
    const again = await boot(60);
    tapTo(again, 1, 10, BTN.DOWN);
    awaitMap(again, "k2");
    expect(api().state().mapId).toBe("k2");
    api().restoreFull(mid!);
    expect(api().state().frame).toBe(midFrame);
    const resumed = finishFrom(again);
    expect(resumed).toEqual(uninterrupted);
    expect(resumed.npc).toEqual({ tx: 2, ty: 6, facing: 1 });
  });
});
