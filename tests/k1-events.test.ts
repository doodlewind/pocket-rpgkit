// tests/k1-events.test.ts — event-model extension unit coverage
// coverage over the pure reducers:
//   event areas (w/h rectangles for playerTouch and action)
//   compound page conditions (condition.all, AND)
//   facing conditions and turn-in-place touch re-fire
//   local. switches/variables cleared on map entry
//   place command and page initial dir
//   cross-event lockInput/unlockInput
//
// Trigger semantics are driven through stepInterp directly (a built-bundle
// sim journey exercising the same features lives in k1-events-sim.test.ts);
// transfer/local/place/movement cases fold the real session reducer.

import { describe, expect, test } from "bun:test";
import {
  createInterpState,
  createSwitchState,
  createWorld,
  evalCondition,
  stepInterp,
  activePage,
  type InterpInput,
  type InterpState,
} from "../src/engine/interpreter.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import { createChars, syncPages } from "../src/engine/chars.ts";
import { validateSchema, type VError } from "../src/engine/schema-validate.ts";
import type { Command, GameEvent, MapDef, Page, Project, TileId } from "../src/engine/types.ts";

const MAP_ID = "v";
const GRASS: TileId = "town.0";

// --- interpreter scaffolding ------------------------------------------------

const NO_EDGE = { confirmEdge: false, cancelEdge: false, upEdge: false, downEdge: false };

function iinput(partial: Partial<InterpInput> = {}): InterpInput {
  const cell = partial.playerCell ?? { x: 10, y: 10 };
  return {
    ...NO_EDGE,
    playerCell: cell,
    prevCell: partial.prevCell ?? cell,
    facing: partial.facing ?? 2,
    ...partial,
  };
}

function imap(events: GameEvent[], w = 20, h = 13): MapDef {
  return {
    id: MAP_ID, name: "t", width: w, height: h, sheets: ["town"],
    ground: Array(w * h).fill(GRASS), events,
  };
}

const inc = (id: string): Command => ({ op: "variable", id, set: { op: "add", value: 1 } });

function idle(s0: InterpState, w: ReturnType<typeof createWorld>, n = 1): InterpState {
  let s = s0;
  for (let k = 0; k < n; k++) s = stepInterp(w, s, iinput());
  return s;
}

// --- session scaffolding -----------------------------------------------------

function sproject(maps: MapDef[], start = { map: "a", x: 2, y: 2, dir: "up" as const }): Project {
  return {
    format: "rpgkit-project/v1", title: "t", tileSize: 16, start,
    sheets: [{ id: "town", cols: 12, rows: 11, defaultPassage: "pass" }],
    items: [{ id: "key", name: "Key", sprite: "town.0" }],
    maps,
  };
}
function smap(id: string, w: number, h: number, events: GameEvent[]): MapDef {
  return {
    id, name: id, width: w, height: h, sheets: ["town"],
    ground: new Array(w * h).fill(GRASS), events,
  };
}
function ge(id: string, x: number, y: number, pages: Page[], wh?: { w?: number; h?: number }): GameEvent {
  return { id, x, y, ...(wh ?? {}), pages };
}
function pg(trigger: Page["trigger"], commands: Command[], extra: Partial<Page> = {}): Page {
  return { trigger, sprite: null, commands, ...extra };
}
function frames(sess: Session, s: SessionState, n: number, buttons = 0): SessionState {
  let out = s;
  for (let k = 0; k < n; k++) out = stepSession(sess, out, { buttons });
  return out;
}
function pulseConfirm(sess: Session, s: SessionState): SessionState {
  let out = stepSession(sess, s, { buttons: 0, confirmEdge: true });
  out = stepSession(sess, out, { buttons: 0 });
  return out;
}

// ===========================================================================
// Event areas
// ===========================================================================

describe("event areas", () => {
  test("playerTouch fires once per step into a fresh area cell along a 3-wide strip", () => {
    const strip = ge("strip", 8, 10, [pg("playerTouch", [inc("fires")])], { w: 3, h: 1 });
    const w = createWorld(imap([strip]));
    let s = createInterpState();
    // Walk east from (7,10) across (8,10),(9,10),(10,10) then off to (11,10).
    const cells = [
      [7, 8], [8, 9], [9, 10], [10, 11],
    ] as const;
    for (const [prev, cur] of cells) {
      s = stepInterp(w, s, iinput({
        playerCell: { x: cur, y: 10 }, prevCell: { x: prev, y: 10 }, facing: 3,
      }));
    }
    expect(s.sw.variables["fires"]).toBe(3);
    // Walking back west across the strip re-fires on every entry.
    const back = [[11, 10], [10, 9], [9, 8]] as const;
    for (const [prev, cur] of back) {
      s = stepInterp(w, s, iinput({
        playerCell: { x: cur, y: 10 }, prevCell: { x: prev, y: 10 }, facing: 1,
      }));
    }
    expect(s.sw.variables["fires"]).toBe(6);
  });

  test("playerTouch does not re-fire while standing on the same area cell", () => {
    const area = ge("a", 10, 9, [pg("playerTouch", [inc("fires")])], { w: 2, h: 3 });
    const w = createWorld(imap([area]));
    let s = createInterpState();
    s = stepInterp(w, s, iinput({ playerCell: { x: 10, y: 10 }, prevCell: { x: 9, y: 10 }, facing: 3 }));
    expect(s.sw.variables["fires"]).toBe(1);
    s = idle(s, w, 5);
    expect(s.sw.variables["fires"]).toBe(1);
  });

  test("action fires when the faced tile or the occupied tile lies in the area", () => {
    const area = ge("counter", 8, 10, [pg("action", [inc("talked")])], { w: 3, h: 1 });
    const w = createWorld(imap([area]));
    // Facing the left edge from (7,10).
    let s = createInterpState();
    s = stepInterp(w, s, iinput({
      confirmEdge: true, playerCell: { x: 7, y: 10 }, facing: 3,
    }));
    expect(s.sw.variables["talked"]).toBe(1);
    // Facing the right edge from (11,10).
    s = stepInterp(w, s, iinput({
      confirmEdge: true, playerCell: { x: 11, y: 10 }, prevCell: { x: 11, y: 10 }, facing: 1,
    }));
    expect(s.sw.variables["talked"]).toBe(2);
    // Standing on the middle cell and confirming.
    s = stepInterp(w, s, iinput({
      confirmEdge: true, playerCell: { x: 9, y: 10 }, prevCell: { x: 9, y: 10 }, facing: 0,
    }));
    expect(s.sw.variables["talked"]).toBe(3);
    // Confirming from a tile that does not face or occupy the area: no fire.
    s = stepInterp(w, s, iinput({
      confirmEdge: true, playerCell: { x: 7, y: 9 }, prevCell: { x: 7, y: 9 }, facing: 2,
    }));
    expect(s.sw.variables["talked"]).toBe(3);
  });

  test("a moved area (eventCells) carries its rectangle with it", () => {
    const area = ge("m", 8, 10, [pg("playerTouch", [inc("fires")])], { w: 2, h: 1 });
    const w = createWorld(imap([area]));
    let s = createInterpState();
    // The NPC (area origin) walked one tile east; the player enters its old
    // cell — no fire; enters the moved rectangle — fire.
    s = stepInterp(w, s, iinput({
      playerCell: { x: 8, y: 10 }, prevCell: { x: 7, y: 10 }, facing: 3,
      eventCells: { m: { x: 9, y: 10 } },
    }));
    expect(s.sw.variables["fires"] ?? 0).toBe(0);
    s = stepInterp(w, s, iinput({
      playerCell: { x: 9, y: 10 }, prevCell: { x: 8, y: 10 }, facing: 3,
      eventCells: { m: { x: 9, y: 10 } },
    }));
    expect(s.sw.variables["fires"]).toBe(1);
  });
});

// ===========================================================================
// Compound page conditions
// ===========================================================================

describe("compound page conditions (condition.all)", () => {
  const gate = (): GameEvent =>
    ge("gate", 10, 10, [
      pg("action", [inc("opened")], {
        condition: {
          all: [
            { kind: "switch", id: "s1", value: true },
            { kind: "switch", id: "s2", value: false },
            { kind: "variable", id: "v", op: ">=", value: 3 },
            { kind: "item", id: "key", count: 1 },
          ],
        },
      }),
    ]);

  test("the page activates only when every clause holds", () => {
    const ev = gate();
    const w = createWorld(imap([ev]));
    let s = createInterpState();
    const confirm = (): InterpState =>
      stepInterp(w, s, iinput({
        confirmEdge: true, playerCell: { x: 9, y: 10 }, facing: 3,
      }));
    s = confirm();
    expect(s.sw.variables["opened"] ?? 0).toBe(0);
    s.sw.switches["s1"] = true; // s2 still unset (false), v/key missing
    s = confirm();
    expect(s.sw.variables["opened"] ?? 0).toBe(0);
    s.sw.variables["v"] = 3;
    s.sw.items["key"] = 1;
    s = confirm();
    expect(s.sw.variables["opened"]).toBe(1);
  });

  test("the flat fields AND with all", () => {
    const ev = ge("g", 10, 10, [pg("action", [inc("ok")], {
      condition: { switch: "a", all: [{ kind: "switch", id: "b", value: true }] },
    })]);
    const w = createWorld(imap([ev]));
    const sw = createSwitchState({ switches: { a: true } });
    expect(activePage(ev, sw, MAP_ID)).toBeNull();
    sw.switches["b"] = true;
    expect(activePage(ev, sw, MAP_ID)?.index).toBe(0);
  });

  test("a switch false clause inside all works in an if command too", () => {
    const ev = ge("e", 10, 10, [
      pg("action", [
        { op: "if", if: { kind: "switch", id: "off", value: false }, then: [inc("branch")] },
      ]),
    ]);
    const w = createWorld(imap([ev]));
    let s = createInterpState();
    s = stepInterp(w, s, iinput({ confirmEdge: true, playerCell: { x: 9, y: 10 }, facing: 3 }));
    expect(s.sw.variables["branch"]).toBe(1);
  });
});

// ===========================================================================
// Facing conditions
// ===========================================================================

describe("facing conditions", () => {
  test("evalCondition facing compares the live facing and fails without one", () => {
    const s = createSwitchState();
    const c = { kind: "facing", dir: "up" } as const;
    expect(evalCondition(c, s, "v/e", 2)).toBe(true);
    expect(evalCondition(c, s, "v/e", 0)).toBe(false);
    expect(evalCondition(c, s, "v/e")).toBe(false);
  });

  test("crossing a facing-gated touch mat sideways never fires; turning up does", () => {
    const mat = ge("mat", 10, 10, [
      pg("playerTouch", [inc("exited")], { condition: { all: [{ kind: "facing", dir: "up" }] } }),
    ]);
    const w = createWorld(imap([mat]));
    let s = createInterpState();
    // Enter facing right (sideways), continue right out: no fire.
    s = stepInterp(w, s, iinput({ playerCell: { x: 10, y: 10 }, prevCell: { x: 9, y: 10 }, facing: 3 }));
    s = stepInterp(w, s, iinput({ playerCell: { x: 11, y: 10 }, prevCell: { x: 10, y: 10 }, facing: 3 }));
    expect(s.sw.variables["exited"] ?? 0).toBe(0);
    // Walk back onto the mat facing left: still no fire.
    s = stepInterp(w, s, iinput({ playerCell: { x: 10, y: 10 }, prevCell: { x: 11, y: 10 }, facing: 1 }));
    expect(s.sw.variables["exited"] ?? 0).toBe(0);
    // Turn in place to face up: the touch re-fires.
    s = stepInterp(w, s, iinput({
      playerCell: { x: 10, y: 10 }, prevCell: { x: 10, y: 10 }, facing: 2, prevFacing: 1,
    }));
    expect(s.sw.variables["exited"]).toBe(1);
    // Staying facing up does not re-fire; turning away and back does.
    s = idle(s, w, 2);
    expect(s.sw.variables["exited"]).toBe(1);
    s = stepInterp(w, s, iinput({
      playerCell: { x: 10, y: 10 }, prevCell: { x: 10, y: 10 }, facing: 0, prevFacing: 2,
    }));
    expect(s.sw.variables["exited"]).toBe(1);
    s = stepInterp(w, s, iinput({
      playerCell: { x: 10, y: 10 }, prevCell: { x: 10, y: 10 }, facing: 2, prevFacing: 0,
    }));
    expect(s.sw.variables["exited"]).toBe(2);
  });

  test("a facing-gated action page only starts when faced", () => {
    const ev = ge("door", 10, 9, [
      pg("action", [inc("used")], { condition: { all: [{ kind: "facing", dir: "up" }] } }),
    ]);
    const w = createWorld(imap([ev]));
    let s = createInterpState();
    // Stand at (10,10) facing down; confirm — page not active.
    s = stepInterp(w, s, iinput({ confirmEdge: true, playerCell: { x: 10, y: 10 }, facing: 0 }));
    expect(s.sw.variables["used"] ?? 0).toBe(0);
    // Face up (the door is the front tile): confirm fires.
    s = stepInterp(w, s, iinput({
      confirmEdge: true, playerCell: { x: 10, y: 10 }, prevCell: { x: 10, y: 10 }, facing: 2, prevFacing: 0,
    }));
    expect(s.sw.variables["used"]).toBe(1);
  });

  test("if facing picks its branch from the live facing", () => {
    const ev = ge("e", 10, 10, [pg("action", [
      { op: "if", if: { kind: "facing", dir: "left" }, then: [inc("L")], else: [inc("other")] },
    ])]);
    const w = createWorld(imap([ev]));
    let s = createInterpState();
    // Stand beside the event facing left: front tile is the event.
    s = stepInterp(w, s, iinput({ confirmEdge: true, playerCell: { x: 11, y: 10 }, facing: 1 }));
    expect(s.sw.variables["L"]).toBe(1);
    // Stand ON the event facing down: the occupied tile is inside it.
    s = stepInterp(w, s, iinput({
      confirmEdge: true, playerCell: { x: 10, y: 10 }, prevCell: { x: 11, y: 10 }, facing: 0, prevFacing: 1,
    }));
    expect(s.sw.variables["other"]).toBe(1);
  });

  test("facing changes cancel stale parallel pages and drive character pages", () => {
    const ev = ge("watcher", 5, 5, [
      pg("parallel", [], { dir: "down" }),
      pg("parallel", [{ op: "wait", seconds: 60 }], {
        condition: { all: [{ kind: "facing", dir: "up" }] },
        dir: "up",
      }),
    ]);
    const w = createWorld(imap([ev]));
    let s = stepInterp(w, createInterpState(), iinput({ facing: 2 }));
    expect(s.parallels[`${MAP_ID}/watcher`]?.pageIndex).toBe(1);
    s = stepInterp(w, s, iinput({ facing: 0, prevFacing: 2 }));
    expect(s.parallels[`${MAP_ID}/watcher`]).toBeUndefined();

    const cfg = { tile: 16, speed: 2 };
    const up = syncPages(createChars(), imap([ev]), s.sw, cfg, new Set(), {}, 2).state;
    expect(up.chars.watcher?.pageIndex).toBe(1);
    expect(up.chars.watcher?.facing).toBe(2);
    const down = syncPages(up, imap([ev]), s.sw, cfg, new Set(), {}, 0).state;
    expect(down.chars.watcher?.pageIndex).toBe(0);
    expect(down.chars.watcher?.facing).toBe(0);
  });
});

// ===========================================================================
// Per-visit local. variables / switches
// ===========================================================================

describe("per-visit local. variables", () => {
  test("local ids are cleared on the initial map entry too", () => {
    const p = sproject([smap("a", 12, 12, [])]);
    const sess = createSession(p);
    const sw = createSwitchState({
      switches: { "local.stale": true, global: true },
      variables: { "local.count": 9, score: 4 },
    });
    const s = startSession(p, sess, sw);
    expect(s.sw.switches).toEqual({ global: true });
    expect(s.sw.variables).toEqual({ score: 4 });
  });

  test("local. ids reset across a transfer round trip; globals survive", () => {
    // a: pad sets locals + a global, transfers to b.
    const padA = ge("out", 2, 1, [
      pg("playerTouch", [
        { op: "variable", id: "local.visit", set: { op: "set", value: 1 } },
        { op: "switch", id: "local.flag", value: true },
        { op: "variable", id: "g", set: { op: "set", value: 7 } },
        { op: "transfer", map: "b", x: 5, y: 10, dir: "up" },
      ]),
    ]);
    // b: pad transfers back to a.
    const padB = ge("back", 5, 8, [
      pg("playerTouch", [{ op: "transfer", map: "a", x: 2, y: 11, dir: "up" }]),
    ]);
    const p = sproject([smap("a", 12, 12, [padA]), smap("b", 12, 12, [padB])]);
    const sess = createSession(p);
    let s = startSession(p, sess);
    // Walk north onto a's pad -> b.
    s = frames(sess, s, 8 * 2, 0x0010);
    expect(s.mapId).toBe("b");
    // Locals were already cleared entering b; the global survived.
    expect(s.sw.variables["g"]).toBe(7);
    expect(s.sw.variables["local.visit"] ?? 0).toBe(0);
    expect(s.sw.switches["local.flag"] ?? false).toBe(false);
    // Walk north onto b's pad -> a.
    s = frames(sess, s, 8 * 2, 0x0010);
    expect(s.mapId).toBe("a");
    expect(s.sw.variables["g"]).toBe(7);
    expect(s.sw.variables["local.visit"] ?? 0).toBe(0);
    expect(s.sw.switches["local.flag"] ?? false).toBe(false);
  });
});

// ===========================================================================
// Place event + page initial dir
// ===========================================================================

describe("place and initial facing", () => {
  test("place moves this event's character and records a durable placement", () => {
    // The event sits directly above the start tile; the player faces up and
    // confirms, which relocates the event to (1,5) facing up.
    const ev: GameEvent = {
      id: "mo", x: 2, y: 1,
      pages: [pg("action", [
        { op: "place", target: "this", x: 1, y: 5, dir: "up" },
        { op: "switch", id: "moved", value: true },
      ])],
    };
    const p = sproject([smap("a", 12, 12, [ev])]);
    const sess = createSession(p);
    let s = startSession(p, sess);
    s = frames(sess, s, 2); // spawn the char
    expect(s.chars.chars["mo"]?.facing).toBe(0); // default down
    s = pulseConfirm(sess, s);
    expect(s.sw.switches["moved"]).toBe(true);
    expect([s.chars.chars["mo"]?.tx, s.chars.chars["mo"]?.ty]).toEqual([1, 5]);
    expect(s.chars.chars["mo"]?.facing).toBe(2);
    // The durable placement record survives (a later page re-sync keeps it).
    expect(s.interp.placements["mo"]).toEqual({ x: 1, y: 5, dir: "up" });
  });

  test("page.dir sets the spawned character's facing", () => {
    const npc = ge("npc", 5, 5, [pg("action", [], { dir: "right" })]);
    const p = sproject([smap("a", 12, 12, [npc])]);
    const sess = createSession(p);
    let s = startSession(p, sess);
    s = frames(sess, s, 2);
    expect(s.chars.chars["npc"]?.facing).toBe(3); // right
  });

  test("a placed event that has no character yet spawns at the new cell", () => {
    const ctl = ge("ctl", 2, 1, [pg("action", [
      { op: "place", target: { event: "hidden" }, x: 5, y: 5, dir: "up" },
      { op: "switch", id: "show", value: true },
    ])]);
    const hidden = ge("hidden", 9, 9, [
      pg("parallel", [], { condition: { switch: "show" }, dir: "up" }),
    ]);
    const p = sproject([smap("a", 12, 12, [ctl, hidden])]);
    const sess = createSession(p);
    let s = startSession(p, sess);
    expect(s.chars.chars["hidden"]).toBeUndefined();
    // Walk north next to ctl (player at (2,2), ctl at (2,1)) and confirm.
    s = frames(sess, s, 8, 0x0010);
    s = pulseConfirm(sess, s);
    s = frames(sess, s, 2);
    const ch = s.chars.chars["hidden"];
    expect(ch?.tx).toBe(5);
    expect(ch?.ty).toBe(5);
    expect(ch?.facing).toBe(2); // up, from page.dir
  });
});

// ===========================================================================
// Cross-event input lock
// ===========================================================================

describe("lockInput / unlockInput", () => {
  test("the lock suppresses action input but not scripted playerTouch", () => {
    const touch = ge("touch", 10, 10, [pg("playerTouch", [inc("touched")])]);
    const action = ge("action", 11, 10, [pg("action", [inc("acted")])]);
    const w = createWorld(imap([touch, action]));
    const locked = createInterpState();
    locked.inputLocked = true;
    let s = stepInterp(w, locked, iinput({
      playerCell: { x: 10, y: 10 }, prevCell: { x: 9, y: 10 }, facing: 3,
      confirmEdge: true,
    }));
    expect(s.sw.variables.touched).toBe(1);
    expect(s.sw.variables.acted ?? 0).toBe(0);
  });

  test("the mover ignores the d-pad and action while locked; a parallel still unlocks", () => {
    // Page 0 autorun takes the lock and parks itself via self switch; the
    // page-1 parallel release waits 0.3 virtual seconds then unlocks.
    const cut: GameEvent = {
      id: "cut", x: 0, y: 0, pages: [
        pg("autorun", [
          { op: "lockInput" },
          { op: "selfSwitch", key: "A", value: true },
        ]),
        pg("parallel", [], { condition: { selfSwitch: "A" } }),
      ],
    };
    const release = ge("rel", 0, 0, [
      pg("parallel", [
        { op: "wait", seconds: 0.3 },
        { op: "unlockInput" },
        { op: "switch", id: "released", value: true },
      ]),
    ]);
    // An action event north of the start: its confirm must be swallowed
    // while the lock is held.
    const sign = ge("sign", 2, 1, [pg("action", [inc("read")])]);
    const p = sproject([smap("a", 12, 12, [cut, release, sign])]);
    const sess = createSession(p);
    let s = startSession(p, sess);
    // Let the autorun acquire the lock before applying player input. Hold up
    // for 10 frames (0.3 s is 18 reference ticks): neither tile nor pixels
    // may move while the cross-event lock is held.
    s = frames(sess, s, 1);
    const lockedAt = { tx: s.move.tx, ty: s.move.ty, px: s.move.px, py: s.move.py };
    s = frames(sess, s, 10, 0x0010);
    expect({ tx: s.move.tx, ty: s.move.ty, px: s.move.px, py: s.move.py }).toEqual(lockedAt);
    expect(s.interp.inputLocked).toBe(true);
    // Confirm during the lock cannot start the sign.
    s = stepSession(sess, s, { buttons: 0, confirmEdge: true });
    s = stepSession(sess, s, { buttons: 0 });
    expect(s.sw.variables["read"] ?? 0).toBe(0);
    // The unlock lands on the 18th reference tick; keep holding up and the
    // player starts walking north once control returns (8 ticks per tile).
    s = frames(sess, s, 40, 0x0010);
    expect(s.sw.switches["released"]).toBe(true);
    expect(s.interp.inputLocked).toBe(false);
    expect(s.move.ty).toBeLessThan(2); // walked north off the start tile
  });

  test("autorun and parallel fibers keep folding while the lock is held", () => {
    const tick = ge("tick", 0, 0, [pg("parallel", [
      { op: "lockInput" },
      { op: "switch", id: "parallelRan", value: true },
      { op: "wait", seconds: 60 },
    ])]);
    const p = sproject([smap("a", 12, 12, [tick])]);
    const sess = createSession(p);
    let s = startSession(p, sess);
    s = frames(sess, s, 3);
    expect(s.interp.inputLocked).toBe(true);
    expect(s.sw.switches["parallelRan"]).toBe(true);
  });
});

describe("project schema additions", async () => {
  const schema = await Bun.file(new URL("../src/data/schema.json", import.meta.url)).json();

  function errorsFor(event: GameEvent): VError[] {
    const project = sproject([smap("a", 12, 12, [event])]);
    project.sheets[0]!.pak = "tiles";
    return validateSchema(schema, project);
  }

  test("accepts areas, compound/facing conditions, page dir, placement, and input lock", () => {
    const event = ge("schema-event", 1, 1, [pg("playerTouch", [
      { op: "lockInput" },
      { op: "place", target: { event: "schema-event" }, x: 2, y: 3, dir: "left" },
      { op: "unlockInput" },
    ], {
      dir: "up",
      condition: {
        all: [
          { kind: "switch", id: "local.ready", value: false },
          { kind: "facing", dir: "up" },
        ],
      },
    })], { w: 3, h: 2 });
    expect(errorsFor(event)).toEqual([]);
  });

  test("rejects zero-sized areas and malformed facing/place directions", () => {
    const event = ge("bad", 1, 1, [pg("action", [
      { op: "place", target: "this", x: 2, y: 3, dir: "sideways" as never },
    ], {
      condition: { all: [{ kind: "facing", dir: "sideways" as never }] },
    })], { w: 0 });
    const paths = errorsFor(event).map((e) => e.path);
    expect(paths).toContain("$.maps[0].events[0].w");
    expect(paths).toContain("$.maps[0].events[0].pages[0].commands[0]");
    expect(paths).toContain("$.maps[0].events[0].pages[0].condition.all[0]");
  });
});
