// tests/k2-movement.test.ts — movement extensions over the
// real session reducer:
//   T2-4  moveRoute targets any map event (wait parks the caller)
//   T2-5  turnTowardPlayer / turnToward / pathTo (deterministic BFS) /
//         approach (walk adjacent + face), blocked wait/replan
//   determinism: multi-hz agreement and mid-move serialization
//
// Pure bun: folds stepSession directly, no built bundle.

import { describe, expect, test } from "bun:test";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import { createSwitchState } from "../src/engine/interpreter.ts";
import { MOTION_HZ } from "../src/engine/motion-clock.ts";
import { validateSchema, type VError } from "../src/engine/schema-validate.ts";
import type {
  Command,
  Dir,
  GameEvent,
  MapDef,
  MoveStep,
  Page,
  Project,
  TileId,
} from "../src/engine/types.ts";

const GRASS: TileId = "town.0";

function smap(id: string, w: number, h: number, events: GameEvent[], extra: Partial<MapDef> = {}): MapDef {
  return {
    id, name: id, width: w, height: h, sheets: ["town"],
    ground: new Array(w * h).fill(GRASS), events, ...extra,
  };
}

function ge(id: string, x: number, y: number, pages: Page[], wh?: { w?: number; h?: number }): GameEvent {
  return { id, x, y, ...(wh ?? {}), pages };
}

function pg(trigger: Page["trigger"], commands: Command[], extra: Partial<Page> = {}): Page {
  return { trigger, sprite: null, commands, ...extra };
}

/** An autorun that runs `commands` once, then parks on self switch A (a
 *  second, empty parallel page keeps it from re-firing). */
function cutscene(id: string, commands: Command[]): GameEvent {
  return ge(id, 0, 0, [
    pg("autorun", [...commands, { op: "selfSwitch", key: "A", value: true }]),
    pg("parallel", [], { condition: { selfSwitch: "A" } }),
  ]);
}

const staticNpc = (id: string, x: number, y: number, dir: Page["dir"] = "down", blocks = false): GameEvent =>
  ge(id, x, y, [pg("action", [], { dir, blocks, sprite: "a" })]);

function project(maps: MapDef[], start?: { map: string; x: number; y: number; dir: Dir }): Project {
  const st = start ?? { map: "a", x: 1, y: 1, dir: "right" as Dir };
  return {
    format: "rpgkit-project/v1", title: "k2", tileSize: 16, start: st,
    sheets: [{ id: "town", cols: 12, rows: 11, defaultPassage: "pass" }],
    items: [], maps,
  };
}

/** Fold n HOST frames with no input. */
function fold(sess: Session, s: SessionState, frames: number): SessionState {
  let out = s;
  for (let i = 0; i < frames; i++) out = stepSession(sess, out, { buttons: 0 });
  return out;
}

/** Fold until the cutscene's self switch A is set (its waited route landed),
 *  or the frame ceiling trips. */
function awaitDone(sess: Session, s: SessionState, mapId: string, id: string, ceiling = 600): SessionState {
  const key = `${mapId}/${id}`;
  let out = s;
  for (let i = 0; i < ceiling; i++) {
    if (out.sw.self[key] !== undefined) return out;
    out = stepSession(sess, out, { buttons: 0 });
  }
  throw new Error(`cutscene ${key} never finished`);
}

const cut = (map: MapDef, id: string, steps: MoveStep[], wait = true) =>
  cutscene("scene", [{ op: "moveRoute", target: { event: id }, wait, route: { steps, repeat: false, skippable: false } }]);

describe("K2/T2-4 — a forced route targets any event", () => {
  test("a waited route on another event parks the caller until the route lands", () => {
    const npc = staticNpc("npc", 1, 1);
    const map = smap("a", 8, 8, [npc, cut(smap("a", 8, 8, []), "npc", ["moveRight", "moveRight", "moveRight"])]);
    const p = project([map]);
    const sess = createSession(p, MOTION_HZ);
    let s = startSession(p, sess);
    // The route starts; well before it lands the calling fiber is still
    // parked (self switch not yet set) and the NPC is committed mid-step.
    s = fold(sess, s, 8);
    expect(s.sw.self["a/scene"]).toBeUndefined();
    expect(s.chars.chars.npc!.moving).toBe(true);
    s = awaitDone(sess, s, "a", "scene");
    expect(s.chars.chars.npc!).toMatchObject({ tx: 4, ty: 1 });
  });

  test("a fire-and-forget route returns immediately and walks on its own", () => {
    const npc = staticNpc("npc", 1, 1);
    const scene = cutscene("scene", [
      { op: "moveRoute", target: { event: "npc" }, wait: false, route: { steps: ["moveDown", "moveDown"], repeat: false, skippable: false } },
      { op: "switch", id: "returned", value: true },
    ]);
    const map = smap("a", 8, 8, [npc, scene]);
    const p = project([map]);
    const sess = createSession(p, MOTION_HZ);
    let s = startSession(p, sess);
    // A couple of frames: the caller has already advanced and set its
    // marker even though the NPC is still walking.
    s = fold(sess, s, 4);
    expect(s.sw.switches["returned"]).toBe(true);
    s = fold(sess, s, 20);
    expect(s.chars.chars.npc!).toMatchObject({ tx: 1, ty: 3 });
  });
});

describe("K2/T2-5 — turn steps", () => {
  test("turnTowardPlayer faces the live player", () => {
    const npc = staticNpc("npc", 5, 1, "up"); // starts facing up
    const scene = cut(smap("a", 8, 8, []), "npc", ["turnTowardPlayer"]);
    // Player at (1,1) is directly WEST of the NPC (5,1): face left.
    const p = project([smap("a", 8, 8, [npc, scene])], { map: "a", x: 1, y: 1, dir: "right" });
    const sess = createSession(p, MOTION_HZ);
    let s = startSession(p, sess);
    s = awaitDone(sess, s, "a", "scene");
    expect(s.chars.chars.npc!.facing).toBe(1); // left
  });

  test("turnToward {event} faces another character on the dominant axis", () => {
    const npc = staticNpc("npc", 1, 1, "down");
    const anchor = staticNpc("anchor", 4, 4, "down");
    const scene = cutscene("scene", [{ op: "moveRoute", target: { event: "npc" }, wait: true, route: { steps: [{ turnToward: { event: "anchor" } }], repeat: false, skippable: false } }]);
    const p = project([smap("a", 8, 8, [npc, anchor, scene])]);
    const sess = createSession(p, MOTION_HZ);
    let s = startSession(p, sess);
    s = awaitDone(sess, s, "a", "scene");
    // (4,4) is equally east and south of (1,1): vertical wins -> down.
    expect(s.chars.chars.npc!.facing).toBe(0);
  });
});

describe("K2/T2-5 — pathTo deterministic BFS", () => {
  test("walks to an open tile and rests facing the last step direction", () => {
    const npc = staticNpc("npc", 1, 1);
    const scene = cut(smap("a", 10, 10, []), "npc", [{ pathTo: { x: 4, y: 1 } }]);
    const p = project([smap("a", 10, 10, [npc, scene])]);
    const sess = createSession(p, MOTION_HZ);
    let s = startSession(p, sess);
    s = awaitDone(sess, s, "a", "scene");
    expect(s.chars.chars.npc!).toMatchObject({ tx: 4, ty: 1, moving: false });
  });

  test("detours around a wall of block cells", () => {
    const npc = staticNpc("npc", 1, 1);
    // Vertical wall x=3, y=0..2 with a gap below at y=3.
    const blocks: [number, "block"][] = [];
    for (let y = 0; y <= 2; y++) blocks.push([y * 10 + 3, "block"]);
    const scene = cut(smap("a", 10, 6, []), "npc", [{ pathTo: { x: 5, y: 1 } }]);
    const map = smap("a", 10, 6, [npc, scene], { passage: blocks });
    const p = project([map]);
    const sess = createSession(p, MOTION_HZ);
    let s = startSession(p, sess);
    s = awaitDone(sess, s, "a", "scene", 1200);
    const c = s.chars.chars.npc!;
    expect({ tx: c.tx, ty: c.ty }).toEqual({ tx: 5, ty: 1 });
  });

  test("an unreachable NPC goal exhausts retries 0/1/3/default and releases the waiter", () => {
    // Goal (2,2) is fully enclosed by block cells; the NPC starts well away.
    const wall: [number, "block"][] = [];
    for (const [x, y] of [[2, 1], [2, 3], [1, 2], [3, 2]] as const) {
      wall.push([y * 8 + x, "block"]);
    }
    const cases = [
      { retries: 0, expectedFrames: 8 },
      { retries: 1, expectedFrames: 15 },
      { retries: 3, expectedFrames: 29 },
      { retries: undefined, expectedFrames: 78 },
    ] as const;
    for (const { retries, expectedFrames } of cases) {
      const pathTo = retries === undefined ? { x: 2, y: 2 } : { x: 2, y: 2, retries };
      const scene = cutscene("scene", [{
        op: "moveRoute",
        target: { event: "npc" },
        wait: true,
        route: { steps: [{ pathTo }], repeat: false, skippable: false },
      }]);
      const p = project([smap("a", 8, 5, [staticNpc("npc", 7, 1), scene], { passage: wall })]);
      const sess = createSession(p, MOTION_HZ);
      let s = startSession(p, sess);
      let frames = 0;
      while (s.sw.self["a/scene"] === undefined && frames < 200) {
        s = stepSession(sess, s, { buttons: 0 });
        frames++;
      }
      expect(s.sw.self["a/scene"], `retries=${retries ?? "default"}`).toBe("A");
      expect(s.chars.chars.npc!.route).toBeNull();
      expect(frames, `retries=${retries ?? "default"}`).toBe(expectedFrames);
    }
  });

  test("an unreachable player goal also exhausts its retry budget", () => {
    const wall: [number, "block"][] = [];
    for (const [x, y] of [[2, 1], [2, 3], [1, 2], [3, 2]] as const) {
      wall.push([y * 8 + x, "block"]);
    }
    const scene = cutscene("scene", [{
      op: "moveRoute",
      target: "player",
      wait: true,
      route: { steps: [{ pathTo: { x: 2, y: 2, retries: 1 } }], repeat: false, skippable: false },
    }]);
    const p = project(
      [smap("a", 8, 5, [scene], { passage: wall })],
      { map: "a", x: 6, y: 3, dir: "up" },
    );
    const sess = createSession(p, MOTION_HZ);
    let s = startSession(p, sess);
    let frames = 0;
    while (s.sw.self["a/scene"] === undefined && frames < 200) {
      s = stepSession(sess, s, { buttons: 0 });
      frames++;
    }
    expect(s.sw.self["a/scene"]).toBe("A");
    expect(s.playerRoute).toBeNull();
    expect(frames).toBe(15);
  });

  test("a waited player route pathfinds around terrain and resumes its caller", () => {
    const wall: [number, "block"][] = [];
    for (let y = 0; y <= 2; y++) wall.push([y * 10 + 3, "block"]);
    const scene = cutscene("scene", [{
      op: "moveRoute",
      target: "player",
      wait: true,
      route: { steps: [{ pathTo: { x: 6, y: 1 } }], repeat: false, skippable: false },
    }]);
    const p = project(
      [smap("a", 10, 6, [scene], { passage: wall })],
      { map: "a", x: 1, y: 1, dir: "right" },
    );
    const sess = createSession(p, MOTION_HZ);
    let s = awaitDone(sess, startSession(p, sess), "a", "scene", 1200);
    expect(s.move).toMatchObject({ tx: 6, ty: 1, moving: false });
    expect(s.sw.self["a/scene"]).toBe("A");
  });

  test("an occupied corridor is replanned after its blocker moves away", () => {
    const walker = staticNpc("walker", 1, 1);
    // Only a body (blocks:true) holds the corridor against the walker.
    const blocker = staticNpc("blocker", 2, 1, "down", true);
    const scene = cutscene("scene", [
      {
        op: "moveRoute",
        target: { event: "blocker" },
        wait: false,
        route: { steps: ["wait", "moveDown"], repeat: false, skippable: false },
      },
      {
        op: "moveRoute",
        target: { event: "walker" },
        wait: true,
        route: { steps: [{ pathTo: { x: 4, y: 1, retries: 6 } }], repeat: false, skippable: false },
      },
    ]);
    // Only row 1 is a corridor; (2,2) is the blocker's escape tile. Until
    // the blocker lands there, the walker has no path and must wait/replan.
    const blocked: [number, "block"][] = [];
    for (let x = 0; x < 6; x++) blocked.push([x, "block"]);
    for (const x of [0, 1, 3, 4, 5]) blocked.push([12 + x, "block"]);
    const map = smap("a", 6, 3, [walker, blocker, scene], { passage: blocked });
    const p = project([map]);
    const sess = createSession(p, MOTION_HZ);
    const s = awaitDone(sess, startSession(p, sess), "a", "scene", 800);
    expect(s.chars.chars.blocker).toMatchObject({ tx: 2, ty: 2 });
    expect(s.chars.chars.walker).toMatchObject({ tx: 4, ty: 1 });
  });
});

describe("K2/T2-5 — approach", () => {
  test("walks adjacent to the player and faces them on arrival", () => {
    // NPC far west, player stationary at (5,1). NPC should end on a 4-neighbour
    // cell of the player facing east (right).
    const npc = staticNpc("npc", 1, 1, "down");
    const scene = cutscene("scene", [{ op: "moveRoute", target: { event: "npc" }, wait: true, route: { steps: [{ approach: { target: "player" } }], repeat: false, skippable: false } }]);
    const p = project([smap("a", 10, 6, [npc, scene])], { map: "a", x: 5, y: 1, dir: "left" });
    const sess = createSession(p, MOTION_HZ);
    let s = startSession(p, sess);
    s = awaitDone(sess, s, "a", "scene", 800);
    const c = s.chars.chars.npc!;
    expect(Math.abs(c.tx - 5) + Math.abs(c.ty - 1)).toBe(1);
    expect(c.facing).toBe(3); // faces east toward the player
  });

  test("an authored side picks a specific stand tile", () => {
    // Stand on the target's up side: stand tile is north of the target and
    // the NPC faces down toward it.
    const npc = staticNpc("npc", 3, 1, "down");
    const anchor = staticNpc("anchor", 5, 5, "down");
    const scene = cutscene("scene", [{ op: "moveRoute", target: { event: "npc" }, wait: true, route: { steps: [{ approach: { target: { event: "anchor" }, side: "up" } }], repeat: false, skippable: false } }]);
    const p = project([smap("a", 10, 10, [npc, anchor, scene])]);
    const sess = createSession(p, MOTION_HZ);
    let s = startSession(p, sess);
    s = awaitDone(sess, s, "a", "scene", 800);
    const c = s.chars.chars.npc!;
    expect({ tx: c.tx, ty: c.ty }).toEqual({ tx: 5, ty: 4 });
    expect(c.facing).toBe(0); // faces down at the anchor
  });
});

describe("character collision follows blocks, like the player's", () => {
  /** A cutscene that holds the input lock around one waited, non-skippable
   *  route: if the route can never land, the lock is never released. */
  const lockedWalk = (target: string, steps: MoveStep[]): GameEvent => cutscene("scene", [
    { op: "lockInput" },
    { op: "moveRoute", target: { event: target }, wait: true, route: { steps, repeat: false, skippable: false } },
    { op: "unlockInput" },
  ]);

  test("a locked cutscene walks an NPC across a sprite-less transfer marker and unlocks", () => {
    const kyle = staticNpc("kyle", 4, 4, "up", true);
    const portal = ge("portal", 4, 3, [pg("playerTouch", [{ op: "transfer", map: "b", x: 1, y: 1 }])]);
    const p = project(
      [smap("a", 8, 8, [kyle, portal, lockedWalk("kyle", ["moveUp", "moveUp"])]), smap("b", 4, 4, [])],
      { map: "a", x: 1, y: 6, dir: "up" },
    );
    const sess = createSession(p, MOTION_HZ);
    const s = awaitDone(sess, startSession(p, sess), "a", "scene");
    expect(s.chars.chars.kyle!).toMatchObject({ tx: 4, ty: 2, moving: false });
    expect(s.interp.inputLocked).toBe(false);
    expect(s.mapId).toBe("a"); // an NPC on a touch marker fires nothing
  });

  test("an unspawned NPC slot (blocks:false page) is crossed; its spawned body is not", () => {
    // The slot's page 0 is an empty placeholder; page 1 (switch "arrived")
    // is the NPC with a body.
    const slot = ge("aeble", 4, 3, [
      pg("action", []),
      pg("action", [], { condition: { switch: "arrived" }, sprite: "a", blocks: true }),
    ]);
    const build = (): Project => project(
      [smap("a", 8, 8, [staticNpc("kyle", 4, 4, "up", true), slot, lockedWalk("kyle", ["moveUp"])])],
      { map: "a", x: 1, y: 6, dir: "up" },
    );
    const p = build();
    const sess = createSession(p, MOTION_HZ);
    const crossed = awaitDone(sess, startSession(p, sess), "a", "scene");
    expect(crossed.chars.chars.kyle!).toMatchObject({ tx: 4, ty: 3 });
    expect(crossed.interp.inputLocked).toBe(false);

    // With the NPC present its body keeps holding the cell: the same
    // non-skippable step waits instead of walking into it.
    const p2 = build();
    const sess2 = createSession(p2, MOTION_HZ);
    let s = startSession(p2, sess2, createSwitchState({ switches: { arrived: true } }));
    s = fold(sess2, s, 120);
    expect(s.chars.chars.kyle!).toMatchObject({ tx: 4, ty: 4 });
    expect(s.sw.self["a/scene"]).toBeUndefined();
    expect(s.interp.inputLocked).toBe(true);
  });

  test("a waited player pathTo crosses a blocks:false marker in a one-tile corridor", () => {
    // Row 1 is the only open row; the marker at (3,1) sits in it.
    const blocked: [number, "block"][] = [];
    for (let x = 0; x < 7; x++) blocked.push([x, "block"], [14 + x, "block"]);
    const marker = ge("marker", 3, 1, [pg("playerTouch", [{ op: "switch", id: "stepped", value: true }])]);
    const scene = cutscene("scene", [{
      op: "moveRoute",
      target: "player",
      wait: true,
      route: { steps: [{ pathTo: { x: 6, y: 1, retries: 0 } }], repeat: false, skippable: false },
    }]);
    const p = project([smap("a", 7, 3, [marker, scene], { passage: blocked })], { map: "a", x: 0, y: 1, dir: "right" });
    const sess = createSession(p, MOTION_HZ);
    const s = awaitDone(sess, startSession(p, sess), "a", "scene");
    expect(s.move).toMatchObject({ tx: 6, ty: 1, moving: false });
  });
});

describe("K2 determinism — multi-hz and mid-move serialization", () => {
  test("a pathTo reaches the same end cell and cutscene marker at 60/30/20 hz", () => {
    const build = () => {
      const npc = staticNpc("npc", 1, 1);
      const wall: [number, "block"][] = [];
      for (let y = 0; y <= 2; y++) wall.push([y * 12 + 6, "block"]);
      const scene = cutscene("scene", [{ op: "moveRoute", target: { event: "npc" }, wait: true, route: { steps: [{ pathTo: { x: 9, y: 1 } }], repeat: false, skippable: false } }]);
      return project([smap("a", 12, 8, [npc, scene], { passage: wall })]);
    };
    const endpoints: Array<{ tx: number; ty: number; done: boolean; referenceTicks: number }> = [];
    for (const hz of [60, 30, 20]) {
      const p = build();
      const sess = createSession(p, hz);
      let s = startSession(p, sess);
      let hostFrames = 0;
      while (s.sw.self["a/scene"] === undefined && hostFrames < 1600) {
        s = stepSession(sess, s, { buttons: 0 });
        hostFrames++;
      }
      expect(s.sw.self["a/scene"]).toBe("A");
      const c = s.chars.chars.npc!;
      endpoints.push({
        tx: c.tx,
        ty: c.ty,
        done: s.sw.self["a/scene"] === "A",
        referenceTicks: hostFrames * sess.ticksPerFrame,
      });
    }
    for (const e of endpoints.slice(1)) {
      expect({ tx: e.tx, ty: e.ty, done: e.done }).toEqual({
        tx: endpoints[0]!.tx,
        ty: endpoints[0]!.ty,
        done: endpoints[0]!.done,
      });
    }
    expect(endpoints[0]).toMatchObject({ tx: 9, ty: 1, done: true });
    // Completion is observed only at host-frame boundaries, so lower rates
    // may include at most one partial batch (three ticks at 20 Hz).
    const durations = endpoints.map((e) => e.referenceTicks);
    expect(Math.max(...durations) - Math.min(...durations)).toBeLessThanOrEqual(2);
  });

  test("a session serialized mid path-step resumes and folds identically", () => {
    const npc = staticNpc("npc", 1, 1);
    const scene = cutscene("scene", [{ op: "moveRoute", target: { event: "npc" }, wait: true, route: { steps: [{ pathTo: { x: 7, y: 1 } }], repeat: false, skippable: false } }]);
    const p = project([smap("a", 10, 6, [npc, scene])]);
    const sess = createSession(p, MOTION_HZ);
    let s = startSession(p, sess);
    // Advance to a tick the NPC is committed to a path step (mid tile).
    s = fold(sess, s, 10);
    const npc0 = s.chars.chars.npc!;
    expect(npc0.route?.plan).not.toBeNull(); // a path expansion is live
    // Round-trip the WHOLE session through JSON (the save envelope is a
    // safe-point subset; this proves the per-visit route/plan state is plain
    // serializable data with no host/closure dependence).
    const json = JSON.stringify(s);
    const restored = JSON.parse(json) as SessionState;
    expect(restored.chars.chars.npc!.route!.plan!.dirs).toEqual(npc0.route!.plan!.dirs);
    // Fold both trajectories with identical input; they must stay equal.
    let a = s;
    let b = restored;
    for (let i = 0; i < 200; i++) {
      a = stepSession(sess, a, { buttons: 0 });
      b = stepSession(sess, b, { buttons: 0 });
    }
    expect(JSON.parse(JSON.stringify(b))).toEqual(JSON.parse(JSON.stringify(a)));
    expect(a.chars.chars.npc!).toMatchObject({ tx: 7, ty: 1 });
    expect(a.sw.self["a/scene"]).toBe("A");
  });

  test("JSON round-trip during an incremental search stays identical every frame", () => {
    const npc = staticNpc("npc", 0, 0);
    const scene = cutscene("scene", [{
      op: "moveRoute",
      target: { event: "npc" },
      wait: true,
      route: { steps: [{ pathTo: { x: 99, y: 98 } }], repeat: false, skippable: false },
    }]);
    const p = project(
      [smap("a", 100, 100, [npc, scene])],
      { map: "a", x: 50, y: 99, dir: "up" },
    );
    const sess = createSession(p, MOTION_HZ);
    const checkpoint = fold(sess, startSession(p, sess), 5);
    const search = checkpoint.chars.chars.npc!.route!.plan!.search;
    expect(search).not.toBeNull();
    expect(search!.qh).toBeGreaterThan(0);
    expect(search!.qh).toBeLessThan(search!.qt);

    // This is intentionally the same raw JSON checkpoint used by the built
    // fixture. Typed arrays parse as numeric-keyed objects, so the next
    // reducer clone must revive them before advancing the search.
    const restored = JSON.parse(JSON.stringify(checkpoint)) as SessionState;
    expect(Object.prototype.toString.call(restored.chars.chars.npc!.route!.plan!.search!.parent)).toBe("[object Object]");

    let uninterrupted = checkpoint;
    let resumed = restored;
    let frames = 0;
    while (uninterrupted.sw.self["a/scene"] === undefined && frames < 3_000) {
      uninterrupted = stepSession(sess, uninterrupted, { buttons: 0 });
      resumed = stepSession(sess, resumed, { buttons: 0 });
      expect(resumed, `frame ${frames + 1}`).toEqual(uninterrupted);
      frames++;
    }
    expect(frames).toBeLessThan(3_000);
    expect(uninterrupted.chars.chars.npc).toMatchObject({ tx: 99, ty: 98 });
    expect(uninterrupted.sw.self["a/scene"]).toBe("A");
  });
});

describe("movement-extension project schema", async () => {
  const schema = await Bun.file(new URL("../src/data/schema.json", import.meta.url)).json();

  function errorsFor(commands: Command[]): VError[] {
    const event = ge("schema-event", 1, 1, [pg("parallel", commands)]);
    const p = project([smap("a", 8, 8, [event])]);
    p.sheets[0]!.pak = "town";
    p.sheets[0]!.dirEdges = {
      "0": { enter: ["left"], exit: ["down"] },
    };
    return validateSchema(schema, p);
  }

  test("accepts one-sided edges, cross-event targets, turns, paths, and approaches", () => {
    expect(errorsFor([{
      op: "moveRoute",
      target: { event: "npc" },
      wait: true,
      route: {
        steps: [
          "turnTowardPlayer",
          { turnToward: { event: "anchor" } },
          { pathTo: { x: 4, y: 5, retries: 3 } },
          { approach: { target: "player", side: "up", distance: 2, retries: 1 } },
        ],
        repeat: false,
        skippable: false,
      },
    }])).toEqual([]);
  });

  test("rejects empty event ids and non-positive approach distance", () => {
    const errors = errorsFor([{
      op: "moveRoute",
      target: { event: "" },
      route: {
        steps: [{ approach: { target: { event: "" }, distance: 0 } }],
        repeat: false,
        skippable: false,
      },
    }]);
    expect(errors.length).toBeGreaterThan(0);
  });
});
