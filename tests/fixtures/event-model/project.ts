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

const map = (id: string, events: GameEvent[]): MapDef => ({
  id,
  name: id,
  width: 12,
  height: 12,
  sheets: ["tiles"],
  ground: new Array<TileId>(12 * 12).fill(TILE),
  events,
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

  return {
    format: "rpgkit-project/v1",
    title: "Event model fixture",
    tileSize: 16,
    start: { map: "lab", x: 1, y: 2, dir: "right" },
    sheets: [{ id: "tiles", cols: 1, rows: 1, pak: "tiles", defaultPassage: "pass" }],
    items: [{ id: "key", name: "Key", sprite: TILE }],
    maps: [
      map("lab", [boot, release, lockedSign, strip, counter, scout]),
      map("return", [returnEvent]),
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
