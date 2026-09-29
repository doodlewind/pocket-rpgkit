// End-to-end event-model coverage through the built PocketJS fixture bundle.
// The same short journey is checked at every supported simulation rate, then
// replayed twice and resumed from a mid-journey save for framebuffer equality.

import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { bootWorld, fnv1a, type SimWorld } from "../vendor/pocketjs/hosts/sim/sim.ts";
import type { SessionState } from "../src/engine/session.ts";
import type { EventModelFixtureApi } from "./fixtures/event-model/event-model.tsx";
import { appBundle, appPreflight } from "./helpers/boot.ts";

const preflight = appPreflight("event-model");
if (!preflight.ok) console.warn(`event-model sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
const RATES = [60, 30, 20, 4] as const;
const W = 480;

declare global {
  // eslint-disable-next-line no-var
  var __eventModelFixture: EventModelFixtureApi | undefined;
}

setDefaultTimeout(15_000);
beforeEach(() => {
  delete globalThis.__eventModelFixture;
});

function api(): EventModelFixtureApi {
  if (!globalThis.__eventModelFixture) throw new Error("event-model fixture did not mount");
  return globalThis.__eventModelFixture;
}

function frame(world: SimWorld, buttons = 0): void {
  world.frame(buttons, 0x8080);
  for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
}

function seconds(world: SimWorld, count: number, buttons = 0): void {
  for (let i = 0; i < count * world.hz; i++) frame(world, buttons);
}

function rgbAt(framebuffer: Uint8Array, x: number, y: number): [number, number, number] {
  const i = (y * W + x) * 4;
  return [framebuffer[i]!, framebuffer[i + 1]!, framebuffer[i + 2]!];
}

function semantic(state: SessionState) {
  const scout = state.chars.chars.scout;
  return {
    map: state.mapId,
    player: {
      tx: state.move.tx,
      ty: state.move.ty,
      px: state.move.px,
      py: state.move.py,
      facing: state.move.facing,
      moving: state.move.moving,
      phase: state.move.phase,
    },
    switches: {
      initial: state.sw.switches["initial-locals-cleared"] ?? false,
      parallel: state.sw.switches["parallel-ran-while-locked"] ?? false,
      action: state.sw.switches["action-used"] ?? false,
      transfer: state.sw.switches["transfer-cleared-locals"] ?? false,
      localReady: state.sw.switches["local.ready"] ?? false,
    },
    variables: {
      hits: state.sw.variables["area-hits"] ?? 0,
      localPhase: state.sw.variables["local.phase"] ?? 0,
      localStale: state.sw.variables["local.stale"] ?? 0,
      forbiddenActions: state.sw.variables["forbidden-actions"] ?? 0,
    },
    key: state.sw.items.key ?? 0,
    inputLocked: state.interp.inputLocked,
    placements: state.interp.placements,
    scout: scout
      ? { tx: scout.tx, ty: scout.ty, px: scout.px, py: scout.py, facing: scout.facing }
      : null,
  };
}

async function boot(hz: number): Promise<SimWorld> {
  return bootWorld(appBundle("event-model"), hz);
}

async function reachCounter(hz: number): Promise<{ world: SimWorld; snapshot: string; hash: string }> {
  const world = await boot(hz);
  seconds(world, 1);
  seconds(world, 1, BTN.RIGHT);
  const state = api().state();
  expect(state.mapId).toBe("lab");
  expect(state.move).toMatchObject({ tx: 5, ty: 2, moving: false, facing: 3 });
  expect(state.sw.variables["area-hits"]).toBe(2);
  expect(state.sw.switches["initial-locals-cleared"]).toBe(true);
  expect(state.sw.switches["parallel-ran-while-locked"]).toBe(true);
  expect(state.sw.variables["forbidden-actions"] ?? 0).toBe(0);
  expect(state.interp.inputLocked).toBe(false);
  expect(state.interp.placements.scout).toEqual({ x: 8, y: 4, dir: "left" });
  expect(state.chars.chars.scout).toMatchObject({ tx: 8, ty: 4, facing: 1 });

  const framebuffer = world.render();
  expect(rgbAt(framebuffer, 5 * 16 + 8, 2 * 16 + 8)).toEqual([56, 189, 248]);
  expect(rgbAt(framebuffer, 8 * 16 + 8, 4 * 16 + 8)).toEqual([232, 121, 249]);
  expect(rgbAt(framebuffer, 180, 20)).toEqual([245, 158, 11]);
  return { world, snapshot: api().snapshot(), hash: fnv1a(framebuffer) };
}

function finish(world: SimWorld): { hashes: string[]; state: ReturnType<typeof semantic> } {
  const hashes: string[] = [];
  frame(world, BTN.CIRCLE);
  hashes.push(fnv1a(world.render()));
  frame(world, 0);
  hashes.push(fnv1a(world.render()));
  for (let i = 0; i < world.hz; i++) {
    frame(world, 0);
    hashes.push(fnv1a(world.render()));
  }
  const state = api().state();
  expect(state.mapId).toBe("lab");
  expect(state.sw.switches["action-used"]).toBe(true);
  expect(state.sw.switches["transfer-cleared-locals"]).toBe(true);
  expect(state.sw.switches["local.ready"] ?? false).toBe(false);
  expect(state.sw.variables["local.phase"] ?? 0).toBe(0);
  expect(state.interp.placements).toEqual({});
  expect(state.chars.chars.scout).toMatchObject({ tx: 9, ty: 7, facing: 2 });

  const framebuffer = world.render();
  expect(rgbAt(framebuffer, 1 * 16 + 8, 2 * 16 + 8)).toEqual([56, 189, 248]);
  expect(rgbAt(framebuffer, 9 * 16 + 8, 7 * 16 + 8)).toEqual([232, 121, 249]);
  expect(rgbAt(framebuffer, 180, 20)).toEqual([34, 197, 94]);
  return { hashes, state: semantic(state) };
}

simDescribe("built event-model fixture", () => {
  test("a cross-event lock blocks movement and action while its parallel unlocker advances", async () => {
    const world = await boot(60);
    frame(world, 0); // boot autorun acquires the lock and finishes
    const atLock = structuredClone(api().state());
    expect(atLock.interp.inputLocked).toBe(true);
    frame(world, BTN.CIRCLE); // sign is directly ahead, but action is locked
    for (let i = 0; i < 5; i++) frame(world, BTN.RIGHT);
    const held = api().state();
    expect(held.move).toMatchObject({ tx: 1, ty: 2, px: 16, py: 32 });
    expect(held.sw.variables["forbidden-actions"] ?? 0).toBe(0);
    seconds(world, 1);
    expect(api().state().sw.switches["parallel-ran-while-locked"]).toBe(true);
    expect(api().state().interp.inputLocked).toBe(false);
  });

  test("one journey has the same milestones at 60/30/20/4 Hz", async () => {
    const runs: Array<{ ready: ReturnType<typeof semantic>; readyHash: string; end: ReturnType<typeof semantic>; endHash: string }> = [];
    for (const hz of RATES) {
      const ready = await reachCounter(hz);
      const readyState = semantic(api().state());
      const end = finish(ready.world);
      runs.push({
        ready: readyState,
        readyHash: ready.hash,
        end: end.state,
        endHash: fnv1a(ready.world.render()),
      });
    }
    for (const run of runs.slice(1)) expect(run).toEqual(runs[0]);
  });

  test("two clean boots produce byte-identical framebuffer hashes", async () => {
    const run = async (): Promise<string[]> => {
      const ready = await reachCounter(60);
      return [ready.hash, ...finish(ready.world).hashes];
    };
    expect(await run()).toEqual(await run());
  });

  test("a mid-journey save resumes to the same states and framebuffer hashes", async () => {
    const first = await reachCounter(60);
    const uninterrupted = finish(first.world);

    const restored = await boot(60);
    api().restore(first.snapshot);
    const resumed = finish(restored);
    expect(resumed.state).toEqual(uninterrupted.state);
    expect(resumed.hashes).toEqual(uninterrupted.hashes);
  });
});
