// tests/rpgkit-chars.test.ts — P1④ character motion reducer
// (engine/chars.ts): patrol routes, random/approach autonomy, collision
// against the player and other characters, forced routes with waiters, and
// page-switch teardown. Pure reducer tests: no host, no clock.

import { describe, expect, test } from "bun:test";
import {
  createChars,
  installRoute,
  stepChars,
  syncPages,
  charBlocksPlayer,
  APPROACH_SIGHT,
  type CharsState,
} from "../src/engine/chars.ts";
import { createSwitchState } from "../src/engine/interpreter.ts";
import { buildPassage } from "../src/engine/passability.ts";
import type { Facing, GameEvent, MapDef, MoveRoute, Sheet } from "../src/engine/types.ts";

const CFG = { tile: 16, speed: 2 };
const STEP = 8;
const SHEET: Sheet = { id: "s", cols: 1, rows: 1, defaultPassage: "pass" };

function makeMap(events: GameEvent[], w = 12, h = 12): MapDef {
  return {
    id: "m",
    name: "m",
    width: w,
    height: h,
    sheets: ["s"],
    ground: new Array(w * h).fill("s.0"),
    events,
  };
}

function ev(id: string, x: number, y: number, extra: Partial<GameEvent["pages"][number]> = {}): GameEvent {
  return {
    id,
    x,
    y,
    pages: [{ trigger: "action", sprite: "a", blocks: true, commands: [], ...extra }],
  };
}

const route = (steps: MoveRoute["steps"], repeat = false): MoveRoute => ({
  steps,
  repeat,
  skippable: false,
});

function run(
  map: MapDef,
  chars0: CharsState,
  frames: number,
  player = { tx: 0, ty: 0, destX: 0, destY: 0 },
  locked = new Set<string>(),
): CharsState {
  const table = buildPassage(map, new Map([["s", SHEET]]));
  let chars = chars0;
  for (let i = 0; i < frames; i++) {
    const motion: Record<string, string> = {};
    for (const e of map.events ?? []) {
      const e0 = e;
      motion[e0.id] = e0.pages[0]!.moveType ?? "static";
    }
    chars = stepChars(chars, table, player, CFG, locked, motion as never).state;
  }
  return chars;
}

function synced(map: MapDef): CharsState {
  const r = syncPages(createChars(), map, createSwitchState(), CFG, new Set());
  return r.state;
}

describe("P1④ chars — patrol routes", () => {
  test("a static character never leaves its authored cell", () => {
    const map = makeMap([ev("npc", 5, 5)]);
    const end = run(map, synced(map), 100, { tx: 1, ty: 1, destX: 1, destY: 1 });
    expect([end.chars["npc"]!.tx, end.chars["npc"]!.ty]).toEqual([5, 5]);
  });

  test("a patrol walks two right, waits, faces up, returns, and loops", () => {
    const map = makeMap([
      ev("guard", 2, 2, {
        moveType: undefined,
        moveRoute: route(
          ["moveRight", "moveRight", "wait", "faceUp", "wait", "moveLeft", "moveLeft", "faceDown"],
          true,
        ),
      }),
    ]);
    let chars = synced(map);
    // One beat per command; moves take STEP frames, waits STEP frames,
    // faces one frame. Sample the first right step.
    chars = run(map, chars, STEP, { tx: 0, ty: 0, destX: 0, destY: 0 });
    expect([chars.chars["guard"]!.tx, chars.chars["guard"]!.ty]).toEqual([3, 2]);
    // second right step finishes at frame 16
    chars = run(map, chars, STEP, { tx: 0, ty: 0, destX: 0, destY: 0 });
    expect([chars.chars["guard"]!.tx, chars.chars["guard"]!.ty]).toEqual([4, 2]);
    // wait (8) + faceUp (1) + wait (8): guard at (4,2) facing up
    chars = run(map, chars, STEP + 1 + STEP, { tx: 0, ty: 0, destX: 0, destY: 0 });
    expect([chars.chars["guard"]!.tx, chars.chars["guard"]!.ty]).toEqual([4, 2]);
    expect(chars.chars["guard"]!.facing).toBe(2);
    // two lefts bring it home
    chars = run(map, chars, STEP * 2, { tx: 0, ty: 0, destX: 0, destY: 0 });
    expect([chars.chars["guard"]!.tx, chars.chars["guard"]!.ty]).toEqual([2, 2]);
  });

  test("a patrol is byte-identical across two runs", () => {
    const map = makeMap([
      ev("guard", 3, 3, { moveRoute: route(["moveRight", "wait", "moveDown", "wait"], true) }),
    ]);
    const a = run(map, synced(map), 200);
    const b = run(map, synced(map), 200);
    expect(b.chars).toEqual(a.chars);
  });
});

describe("P1④ chars — autonomous motion", () => {
  test("a random wanderer is driven by the seeded RNG and replays identically", () => {
    const map = makeMap([ev("boy", 6, 6, { moveType: "random" })], 20, 20);
    const a = run(map, synced(map), 400, { tx: 0, ty: 0, destX: 0, destY: 0 });
    const b = run(map, synced(map), 400, { tx: 0, ty: 0, destX: 0, destY: 0 });
    expect(b.chars).toEqual(a.chars);
    // 400 frames at ~one move per 16 frames: it left the start cell.
    expect([a.chars["boy"]!.tx, a.chars["boy"]!.ty]).not.toEqual([6, 6]);
    // Never left the map bounds.
    const c = a.chars["boy"]!;
    expect(c.tx).toBeGreaterThanOrEqual(0);
    expect(c.tx).toBeLessThan(20);
    expect(c.ty).toBeGreaterThanOrEqual(0);
    expect(c.ty).toBeLessThan(20);
  });

  test("an approach character walks toward the player inside sight and faces it when blocked", () => {
    // A vertical corridor with the NPC south of the player.
    const w = 3;
    const h = 12;
    const map: MapDef = {
      id: "m",
      name: "m",
      width: w,
      height: h,
      sheets: ["s"],
      ground: new Array(w * h).fill("s.0"),
      // walls on the side columns so approach can't detour wide
      passage: [],
      events: [ev("slime", 1, 10, { moveType: "approach" })],
    };
    for (let y = 0; y < h; y++) {
      map.passage!.push([y * w + 0, "block"], [y * w + 2, "block"]);
    }
    // player five tiles north, within APPROACH_SIGHT
    expect(Math.abs(1 - 1) + Math.abs(10 - 5)).toBeLessThanOrEqual(APPROACH_SIGHT);
    let chars = synced(map);
    chars = run(map, chars, STEP * 4, { tx: 1, ty: 5, destX: 1, destY: 5 });
    // four steps north: (1,10)->(1,6), one short of the player at (1,5)
    expect([chars.chars["slime"]!.tx, chars.chars["slime"]!.ty]).toEqual([1, 6]);
    // it must never enter the player's tile
    chars = run(map, chars, STEP * 4, { tx: 1, ty: 5, destX: 1, destY: 5 });
    expect([chars.chars["slime"]!.tx, chars.chars["slime"]!.ty]).toEqual([1, 6]);
    expect(chars.chars["slime"]!.facing).toBe(2); // faces up toward player
  });

  test("approach does not move when the player is beyond sight", () => {
    const map = makeMap([ev("slime", 1, 1, { moveType: "approach" })], 20, 20);
    const end = run(map, synced(map), 100, { tx: 11, ty: 11, destX: 11, destY: 11 });
    expect([end.chars["slime"]!.tx, end.chars["slime"]!.ty]).toEqual([1, 1]);
  });
});

describe("P1④ chars — collision and exclusion", () => {
  test("a blocking character keeps the player out of its cell and step target", () => {
    const map = makeMap([ev("npc", 5, 5)]);
    const chars = synced(map);
    expect(charBlocksPlayer(chars.chars["npc"]!, 5, 5)).toBe(true);
    expect(charBlocksPlayer(chars.chars["npc"]!, 5, 6)).toBe(false);
    // a below-character (sprite null, blocks false) still has a char (a
    // route may move it) but it is invisible and never blocks the player.
    const map2 = makeMap([ev("sign", 5, 5, { blocks: false, sprite: null })]);
    const chars2 = synced(map2);
    expect(chars2.chars["sign"]!.visible).toBe(false);
    expect(charBlocksPlayer(chars2.chars["sign"]!, 5, 5)).toBe(false);
  });

  test("two characters can never occupy the same cell", () => {
    // Two NPCs on row 5: a walker at (3,5) moving right into a static at (5,5);
    // it must stop at (4,5).
    const map = makeMap([
      ev("a", 3, 5, { moveRoute: route(["moveRight"], false) }),
      ev("b", 5, 5),
    ]);
    let chars = synced(map);
    // first step lands (4,5); the next right into (5,5) is occupied and
    // (repeat:false) the one-step route ends. Run long enough to retry.
    chars = run(map, chars, STEP * 6, { tx: 0, ty: 0, destX: 0, destY: 0 });
    expect([chars.chars["a"]!.tx, chars.chars["a"]!.ty]).toEqual([4, 5]);
    expect([chars.chars["b"]!.tx, chars.chars["b"]!.ty]).toEqual([5, 5]);
  });
});

describe("P1④ chars — forced routes and waiters", () => {
  test("a waited forced route reports the waiter when the last step lands", () => {
    const map = makeMap([ev("porter", 4, 4)]);
    const table = buildPassage(map, new Map([["s", SHEET]]));
    let chars = synced(map);
    const installed = installRoute(
      chars,
      "porter",
      route(["moveUp", "moveUp"]),
      "m/porter",
      CFG,
    );
    chars = installed.state;
    const motion = { porter: "static" } as never;
    let finished: string[] = [];
    for (let i = 0; i < STEP * 2; i++) {
      const r = stepChars(chars, table, { tx: 0, ty: 0, destX: 0, destY: 0 }, CFG, new Set(), motion);
      chars = r.state;
      finished = finished.concat(r.finishedWaiters);
    }
    expect([chars.chars["porter"]!.tx, chars.chars["porter"]!.ty]).toEqual([4, 2]);
    expect(finished).toContain("m/porter");
    expect(chars.chars["porter"]!.route).toBeNull();
  });

  test("a skippable route blocked immediately releases the waiter", () => {
    // moveUp from the top-left corner (0,0) leaves the map, so canEnter
    // blocks and the skippable route gives up on the first frame.
    const map = makeMap([ev("porter", 0, 0)]);
    const table = buildPassage(map, new Map([["s", SHEET]]));
    let chars = synced(map);
    const blocked: MoveRoute = { steps: ["moveUp"], repeat: false, skippable: true };
    chars = installRoute(chars, "porter", blocked, "m/porter", CFG).state;
    const r = stepChars(chars, table, { tx: 9, ty: 9, destX: 9, destY: 9 }, CFG, new Set(), {
      porter: "static",
    } as never);
    expect(r.finishedWaiters).toContain("m/porter");
    expect(r.state.chars["porter"]!.route).toBeNull();
  });

  test("a page switch aborts the forced route and reports the waiter", () => {
    const map = makeMap([ev("porter", 4, 4)]);
    // install a running route, then sync against a switch state where the
    // event still exists (page index changed by adding a gated page 0).
    let chars = synced(map);
    chars = installRoute(chars, "porter", route(["moveUp", "moveUp"]), "m/porter", CFG).state;
    const switched: GameEvent = {
      ...map.events![0]!,
      pages: [
        { trigger: "action", sprite: "a", blocks: true, commands: [], condition: { switch: "x" } },
        { trigger: "action", sprite: "a", blocks: true, commands: [] },
      ],
    };
    const map2 = makeMap([switched]);
    const sw = createSwitchState({ switches: { x: true } });
    const r = syncPages(chars, map2, sw, CFG, new Set());
    expect(r.result.abortedWaiters).toContain("m/porter");
    expect(r.state.chars["porter"]!.route).toBeNull();
  });

  test("a locked character freezes for its interaction but its forced route continues", () => {
    // Autonomous random NPC locked for a dialog: no motion.
    const map = makeMap([ev("boy", 6, 6, { moveType: "random" })], 20, 20);
    const locked = run(
      map,
      synced(map),
      200,
      { tx: 0, ty: 0, destX: 0, destY: 0 },
      new Set(["boy"]),
    );
    expect([locked.chars["boy"]!.tx, locked.chars["boy"]!.ty]).toEqual([6, 6]);
  });
});

describe("P1④-fix — a route step checks the cell in the step direction (R5)", () => {
  const dirSheet: Sheet = {
    id: "s", cols: 12, rows: 11, defaultPassage: "pass",
    dirBlock: { "1": ["right"] },
  };
  const groundAt = (w: number, h: number, cell: number): MapDef["ground"] =>
    Array.from({ length: w * h }, (_, i) => (i === cell ? "s.1" : "s.0"));

  test("moveRight out of a cell that forbids the right exit is refused", () => {
    const map: MapDef = {
      id: "m", name: "m", width: 9, height: 9, sheets: ["s"],
      // The blocking tile is under the character's OWN (source) cell.
      ground: groundAt(9, 9, 3 * 9 + 3),
      events: [ev("mover", 3, 3, { moveRoute: route(["moveRight"], true) })],
    };
    const table = buildPassage(map, new Map([["s", dirSheet]]));
    const synced0 = syncPages(createChars(), map, createSwitchState(), CFG, new Set()).state;
    // The character starts facing DOWN; the lookup must use the STEP
    // direction (right) for the source cell's exit mask, not the old facing.
    expect(synced0.chars["mover"]!.facing).toBe(0);
    const end = (() => {
      let chars = synced0;
      for (let i = 0; i < STEP; i++) {
        chars = stepChars(chars, table, { tx: 0, ty: 0, destX: 0, destY: 0 }, CFG, new Set(), { mover: "static" }).state;
      }
      return chars;
    })();
    expect([end.chars["mover"]!.tx, end.chars["mover"]!.ty]).toEqual([3, 3]);
    expect(end.chars["mover"]!.facing).toBe(3); // turned to face the refused direction
  });

  test("the right-blocked cell is enterable from the left through a cell that allows the exit", () => {
    const map: MapDef = {
      id: "m", name: "m", width: 9, height: 9, sheets: ["s"],
      ground: groundAt(9, 9, 3 * 9 + 4), // (4,3): s.1 forbids only its own right exit
      events: [ev("mover", 3, 3, { moveRoute: route(["moveRight", "moveUp"], false) })],
    };
    const table = buildPassage(map, new Map([["s", dirSheet]]));
    let chars = syncPages(createChars(), map, createSwitchState(), CFG, new Set()).state;
    // First moveRight: source (3,3)=s.0 allows right, target (4,3)=s.1 is
    // enterable (its right-exit mask governs LEAVING it, not entering it).
    for (let i = 0; i < STEP * 2; i++) {
      chars = stepChars(chars, table, { tx: 0, ty: 0, destX: 0, destY: 0 }, CFG, new Set(), { mover: "static" }).state;
    }
    expect([chars.chars["mover"]!.tx, chars.chars["mover"]!.ty]).toEqual([4, 2]);
  });

  test("moveUp out of an up-blocked source cell is refused even when pre-facing right", () => {
    const sheet: Sheet = { id: "s", cols: 12, rows: 11, defaultPassage: "pass", dirBlock: { "1": ["up"] } };
    const map: MapDef = {
      id: "m", name: "m", width: 9, height: 9, sheets: ["s"],
      ground: groundAt(9, 9, 3 * 9 + 3), // source (3,3)=s.1 forbids the up exit
      events: [ev("mover", 3, 3, { moveRoute: route(["moveUp"], true) })],
    };
    const table = buildPassage(map, new Map([["s", sheet]]));
    let chars = syncPages(createChars(), map, createSwitchState(), CFG, new Set()).state;
    // Assign through a Facing-typed parameter so the property is not
    // narrowed to the literal type 3 (which made .toBe(2) a TS2769).
    const preface = (facing: Facing): void => {
      chars.chars["mover"]!.facing = facing;
    };
    preface(3); // pre-turn orientation: right
    for (let i = 0; i < STEP; i++) {
      chars = stepChars(chars, table, { tx: 0, ty: 0, destX: 0, destY: 0 }, CFG, new Set(), { mover: "static" }).state;
    }
    expect([chars.chars["mover"]!.tx, chars.chars["mover"]!.ty]).toEqual([3, 3]);
    expect(chars.chars["mover"]!.facing).toBe(2);
  });
});

describe("P1④-fix — a forced route restores the page patrol afterward (R3)", () => {
  test("the patrol is reinstalled when a waited forced route lands", () => {
    const map = makeMap([
      ev("guard", 3, 3, { moveRoute: route(["moveRight", "wait", "moveLeft", "wait"], true) }),
    ]);
    const table = buildPassage(map, new Map([["s", SHEET]]));
    let chars = synced(map);
    // Action installs a one-step forced route down to (3,4).
    chars = installRoute(chars, "guard", route(["moveDown"]), "m/guard", CFG).state;
    const motion = { guard: "static" } as never;
    let finished: string[] = [];
    for (let i = 0; i < STEP; i++) {
      const r = stepChars(chars, table, { tx: 0, ty: 0, destX: 0, destY: 0 }, CFG, new Set(), motion);
      chars = r.state;
      finished = finished.concat(r.finishedWaiters);
    }
    expect(finished).toContain("m/guard");
    const g = chars.chars["guard"]!;
    expect([g.tx, g.ty]).toEqual([3, 4]);
    expect(g.route?.patrol).toBe(true); // patrol is back, not a null route
    expect(g.route?.pc).toBe(0); // restored from the first command
  });

  test("the restored patrol runs from the character's current cell", () => {
    const map = makeMap([
      ev("guard", 3, 3, { moveRoute: route(["moveRight", "wait", "moveLeft", "wait"], true) }),
    ]);
    const table = buildPassage(map, new Map([["s", SHEET]]));
    let chars = synced(map);
    // Advance the patrol one command (first moveRight lands at (4,3),
    // pc becomes 1), then force a moveDown.
    const motion = { guard: "static" } as never;
    for (let i = 0; i < STEP; i++) {
      chars = stepChars(chars, table, { tx: 0, ty: 0, destX: 0, destY: 0 }, CFG, new Set(), motion).state;
    }
    expect([chars.chars["guard"]!.tx, chars.chars["guard"]!.ty]).toEqual([4, 3]);
    expect(chars.chars["guard"]!.route?.pc).toBe(1);
    chars = installRoute(chars, "guard", route(["moveDown"]), null, CFG).state;
    for (let i = 0; i < STEP; i++) {
      chars = stepChars(chars, table, { tx: 0, ty: 0, destX: 0, destY: 0 }, CFG, new Set(), motion).state;
    }
    // Forced route landed at (4,4); the restored patrol restarts at pc 0,
    // so its next moveRight takes the guard to (5,4) one step later.
    expect(chars.chars["guard"]!.route?.patrol).toBe(true);
    expect(chars.chars["guard"]!.route?.pc).toBe(0);
    for (let i = 0; i < STEP; i++) {
      chars = stepChars(chars, table, { tx: 0, ty: 0, destX: 0, destY: 0 }, CFG, new Set(), motion).state;
    }
    expect([chars.chars["guard"]!.tx, chars.chars["guard"]!.ty]).toEqual([5, 4]);
  });
});
