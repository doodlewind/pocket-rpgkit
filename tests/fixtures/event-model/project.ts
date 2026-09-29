// Integrated project used by the event-model bundle fixture. It deliberately
// combines area triggers, compound/facing guards, per-visit values, event
// placement, page facing, and a cross-event input lock in one short journey.

import type { Command, GameEvent, MapDef, Page, Project, TileId } from "../../../src/engine/types.ts";

const TILE = "tiles.0" as const;

const inc = (id: string): Command => ({
  op: "variable",
  id,
  set: { op: "add", value: 1 },
});

const page = (trigger: Page["trigger"], commands: Command[], extra: Partial<Page> = {}): Page => ({
  trigger,
  sprite: null,
  commands,
  ...extra,
});

const event = (
  id: string,
  x: number,
  y: number,
  pages: Page[],
  area: { w?: number; h?: number } = {},
): GameEvent => ({ id, x, y, ...area, pages });

const map = (id: string, events: GameEvent[], passage?: [number, "pass" | "block"][]): MapDef => ({
  id,
  name: id,
  width: 12,
  height: 12,
  sheets: ["tiles"],
  ground: new Array<TileId>(12 * 12).fill(TILE),
  events,
  passage,
});

export function buildEventModelProject(): Project {
  const boot = event("boot", 0, 0, [
    page("autorun", [
      { op: "lockInput" },
      { op: "switch", id: "lock-window", value: true },
      {
        op: "if",
        if: { kind: "switch", id: "local.stale", value: false },
        then: [{
          op: "if",
          if: { kind: "variable", id: "local.stale", op: "==", value: 0 },
          then: [{ op: "switch", id: "initial-locals-cleared", value: true }],
        }],
      },
      { op: "place", target: { event: "scout" }, x: 8, y: 4, dir: "left" },
      { op: "variable", id: "local.phase", set: { op: "set", value: 1 } },
      // Satisfies one clause of the all-gate page from the start; the other
      // (all-ready) is only set later by stepping on arm-all.
      { op: "variable", id: "all-hits", set: { op: "set", value: 1 } },
      { op: "switch", id: "local.ready", value: true },
      { op: "item", item: "key", set: "add", count: 1 },
      { op: "selfSwitch", key: "A", value: true },
    ]),
    page("parallel", [], { condition: { selfSwitch: "A" } }),
  ]);

  const release = event("release", 0, 0, [
    page("parallel", [
      { op: "wait", seconds: 0.2 },
      { op: "switch", id: "parallel-ran-while-locked", value: true },
      { op: "switch", id: "lock-window", value: false },
      { op: "unlockInput" },
      { op: "exit" },
    ], { condition: { switch: "lock-window" } }),
  ]);

  const lockedSign = event("locked-sign", 2, 2, [
    page("action", [inc("forbidden-actions")]),
  ]);

  const strip = event("strip", 3, 2, [
    page("playerTouch", [inc("area-hits")], {
      condition: {
        all: [
          { kind: "switch", id: "local.ready", value: true },
          { kind: "variable", id: "local.phase", op: ">=", value: 1 },
          { kind: "facing", dir: "right" },
        ],
      },
    }),
  ], { w: 2, h: 1 });

  const counter = event("counter", 6, 2, [
    page("action", [
      { op: "switch", id: "action-used", value: true },
      { op: "transfer", map: "return", x: 1, y: 2, dir: "right" },
    ], {
      blocks: true,
      condition: {
        all: [
          { kind: "switch", id: "local.ready", value: true },
          { kind: "switch", id: "disabled", value: false },
          { kind: "variable", id: "area-hits", op: ">=", value: 2 },
          { kind: "selfSwitch", key: "A", value: false },
          { kind: "item", id: "key", count: 1 },
          { kind: "facing", dir: "right" },
        ],
      },
    }),
  ], { w: 2, h: 1 });

  const scout = event("scout", 9, 7, [page("action", [], { dir: "up" })]);

  // Regression: a one-cell playerTouch EXIT MAT
  // gated on facing. Crossing it sideways (facing along the walk) must not
  // leave the map; turning in place to the demanded facing while standing on
  // it re-fires (interpreter turnEdge) and transfers out.
  const exitMat = event("exit-mat", 2, 5, [
    page("playerTouch", [
      { op: "switch", id: "mat-exited", value: true },
      // A short fade freezes gameplay during both swaps (held input is
      // ignored), making the round trip rate-independent in the sim.
      { op: "transfer", map: "matreturn", x: 1, y: 1, dir: "right", fade: 0.1 },
    ], {
      condition: { all: [{ kind: "facing", dir: "down" }] },
    }),
  ]);

  // K1-review leftover: an `all` page that stays INACTIVE while one clause
  // is missing. boot sets all-hits=1; the separate arm-all strip later sets
  // the all-ready switch, after which re-entering the gate cell fires it.
  const allGate = event("all-gate", 1, 7, [
    page("playerTouch", [
      { op: "switch", id: "all-fired", value: true },
    ], {
      condition: {
        all: [
          { kind: "switch", id: "all-ready", value: true },
          { kind: "variable", id: "all-hits", op: ">=", value: 1 },
        ],
      },
    }),
  ]);
  const armAll = event("arm-all", 3, 7, [
    page("playerTouch", [{ op: "switch", id: "all-ready", value: true }]),
  ]);

  // Stepping onto this pad transfers to the dedicated movement
  // extension map (routes on arbitrary events, turn/pathTo/approach).
  const k2pad = event("k2-pad", 1, 10, [
    page("playerTouch", [{ op: "transfer", map: "k2", x: 1, y: 6, dir: "right" }]),
  ]);

  const returnEvent = event("return-home", 0, 0, [page("autorun", [
    {
      op: "if",
      if: { kind: "variable", id: "local.phase", op: "==", value: 0 },
      then: [{
        op: "if",
        if: { kind: "switch", id: "local.ready", value: false },
        then: [{ op: "switch", id: "transfer-cleared-locals", value: true }],
      }],
    },
    { op: "transfer", map: "lab", x: 1, y: 2, dir: "right" },
  ])]);

  // Landing map for the facing-gated exit mat; its autorun simply sends the
  // player back to the lab (the sim only asserts the round trip completed).
  const matReturnEvent = event("mat-return-home", 0, 0, [page("autorun", [
    { op: "transfer", map: "lab", x: 1, y: 2, dir: "right", fade: 0.1 },
  ])]);

  // Movement-extension map: a single autorun drives a distant NPC first
  // with turnTowardPlayer + pathTo, then approach player (T2-4/T2-5). The
  // player is transferred in at (1,6) and stands still; the NPC ends on the
  // adjacent tile (2,6) facing the player.
  const k2npc = event("k2-npc", 10, 6, [
    page("action", [], { dir: "up", sprite: null }),
  ]);
  const k2scene = event("k2-scene", 0, 0, [
    page("autorun", [
      {
        op: "moveRoute",
        target: { event: "k2-npc" },
        wait: true,
        route: {
          steps: ["turnTowardPlayer", { pathTo: { x: 6, y: 6 } }],
          repeat: false,
          skippable: false,
        },
      },
      {
        op: "moveRoute",
        target: { event: "k2-npc" },
        wait: true,
        route: {
          steps: [{ approach: { target: "player" } }],
          repeat: false,
          skippable: false,
        },
      },
      { op: "switch", id: "k2-done", value: true },
      { op: "selfSwitch", key: "A", value: true },
    ]),
    page("parallel", [], { condition: { selfSwitch: "A" } }),
  ]);
  const k2Map: MapDef = {
    id: "k2",
    name: "k2",
    width: 12,
    height: 12,
    sheets: ["tiles"],
    ground: new Array<TileId>(12 * 12).fill(TILE),
    // Block directly below the transfer landing (1,7) so a DOWN button held
    // across the transfer frame cannot carry the player off the start cell,
    // keeping the post-transfer position rate-independent for the sim.
    passage: [[7 * 12 + 1, "block"]],
    events: [k2npc, k2scene],
  };

  return {
    format: "rpgkit-project/v1",
    title: "Event model fixture",
    tileSize: 16,
    start: { map: "lab", x: 1, y: 2, dir: "right" },
    sheets: [{ id: "tiles", cols: 1, rows: 1, pak: "tiles", defaultPassage: "pass" }],
    items: [{ id: "key", name: "Key", sprite: TILE }],
    maps: [
      // A block directly below the exit mat (2,6) keeps a downward press on
      // the mat as a turn-in-place (the facing-gated touch re-fires on the
      // turn) instead of walking off it.
      map(
        "lab",
        [boot, release, lockedSign, strip, counter, scout, exitMat, allGate, armAll, k2pad],
        [[6 * 12 + 2, "block"]],
      ),
      map("return", [returnEvent]),
      map("matreturn", [matReturnEvent]),
      k2Map,
    ],
  };
}

/** A 100×100 map with 300 rectangular touch events for the QuickJS scan
 * benchmark. Events are spread deterministically across the map. */
export function buildAreaScanMap(count = 300): MapDef {
  return {
    id: "scan",
    name: "Area scan",
    width: 100,
    height: 100,
    sheets: ["tiles"],
    ground: new Array<TileId>(100 * 100).fill(TILE),
    events: Array.from({ length: count }, (_, i) => event(
      `area-${String(i).padStart(3, "0")}`,
      (i * 17) % 97,
      (i * 29) % 98,
      [page("playerTouch", [inc("scan-hits")])],
      { w: 3, h: 2 },
    )),
  };
}

/** A 100×100 fully-open map for the QuickJS pathTo benchmark. An open map
 *  from one corner to the opposite corner is the BFS worst case: the goal is
 *  at the maximum Manhattan distance, so the fixed-order search visits all
 *  10,000 cells before it. `walls` adds deterministic interior block cells
 *  for a realistic-ish secondary case. */
export function buildPathBenchMap(walls = false): MapDef {
  const ground = new Array<TileId>(100 * 100).fill(TILE);
  const passage: [number, "block"][] = [];
  if (walls) {
    // Vertical teeth leaving alternating gaps, forcing detours.
    for (let x = 10; x < 90; x += 10) {
      for (let y = 0; y < 90; y++) passage.push([y * 100 + x, "block"]);
    }
  }
  return {
    id: "pathbench",
    name: "Path bench",
    width: 100,
    height: 100,
    sheets: ["tiles"],
    ground,
    passage,
    events: [],
  };
}

/** A real reducer workload with ten events repeatedly searching an open
 *  100x100 field for an enclosed goal. Every route is fire-and-forget and
 *  has enough retries to keep the benchmark in steady state. */
export function buildConcurrentPathBenchProject(): Project {
  const starts = [
    [1, 1], [20, 1], [40, 1], [60, 1], [80, 1],
    [1, 98], [20, 98], [40, 98], [60, 98], [80, 98],
  ] as const;
  const movers = starts.map(([x, y], i) => event(
    `path-${String(i).padStart(2, "0")}`,
    x,
    y,
    [page("action", [])],
  ));
  const commands: Command[] = movers.map((mover) => ({
    op: "moveRoute",
    target: { event: mover.id },
    wait: false,
    route: {
      steps: [{ pathTo: { x: 50, y: 50, retries: 100_000 } }],
      repeat: false,
      skippable: false,
    },
  }));
  commands.push({ op: "selfSwitch", key: "A", value: true });
  const driver = event("path-driver", 99, 99, [
    page("autorun", commands),
    page("parallel", [], { condition: { selfSwitch: "A" } }),
  ]);
  const benchMap = buildPathBenchMap(false);
  benchMap.events = [...movers, driver];
  // The target is standable but enclosed, forcing each BFS to exhaust the
  // reachable field and exercise the retry path without moving a character.
  benchMap.passage = [
    [50 * 100 + 49, "block"],
    [50 * 100 + 51, "block"],
    [49 * 100 + 50, "block"],
    [51 * 100 + 50, "block"],
  ];
  return {
    format: "rpgkit-project/v1",
    title: "Concurrent path benchmark",
    tileSize: 16,
    start: { map: benchMap.id, x: 0, y: 0, dir: "down" },
    sheets: [{ id: "tiles", cols: 1, rows: 1, pak: "tiles", defaultPassage: "pass" }],
    items: [],
    maps: [benchMap],
  };
}
