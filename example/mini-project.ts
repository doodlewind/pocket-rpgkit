// example/mini-project.ts — the minimal sample shipped with Pocket RPG Kit:
// one 20x12-tile meadow and four events. It proves the component end to end
// (session reducer, dialog, choices, touch trigger, page switching) without
// carrying the three-map sample game, which lives in its own repository.
//
// Geometry is authored in code; tools/gen-assets.ts bakes the ground/upper
// canvases from it. The format is rpgkit-project/v1 (src/data/schema.json).

import type { Command, MapDef, Project, Sheet, TileId } from "../src/engine/types.ts";

export const SHEET: Sheet = { id: "town", cols: 12, rows: 11, pak: "chunks" };

const t = (cell: number): TileId => `town.${cell}`;
const txt = (lines: string[]): Command => ({ op: "text", lines });

function fill<X>(w: number, h: number, v: X): X[] {
  return Array.from({ length: w * h }, () => v);
}

function paint(map: MapDef, x: number, y: number, tile: TileId, flag?: "pass" | "block"): void {
  map.ground[y * map.width + x] = tile;
  if (flag) (map.passage ??= []).push([y * map.width + x, flag]);
}

function upper(map: MapDef, x: number, y: number, tile: TileId, block = false): void {
  (map.upper ??= []).push([y * map.width + x, tile]);
  if (block) (map.passage ??= []).push([y * map.width + x, "block"]);
}

/** The sample map: 20x12 tiles (320x192 px), smaller than the 480x272
 *  viewport, so the host centers it with a black letterbox. */
export function buildMiniMap(): MapDef {
  const W = 20;
  const H = 12;
  const m: MapDef = {
    id: "meadow",
    name: "Kit Meadow",
    width: W,
    height: H,
    sheets: [SHEET.id],
    ground: fill(W, H, t(0)),
    events: [],
  };

  // Dirt road across row 7 (the player starts on it) with a cobble patch
  // one row north around the signpost.
  for (let x = 0; x < W; x++) paint(m, x, 7, t([39, 40, 41, 42][x % 4]!));
  for (let x = 8; x <= 12; x++) paint(m, x, 6, t(43));

  // Enclosed tree ring: the star-layer canopy cells carry block passage.
  const ring = [3, 4, 17, 29, 30, 3, 4];
  for (let x = 0; x < W; x++) {
    if (x !== 0 && x !== W - 1) upper(m, x, 0, t(ring[x % ring.length]!), true);
    upper(m, x, H - 1, t(ring[(x + 2) % ring.length]!), true);
  }
  for (let y = 1; y < H - 1; y++) {
    upper(m, 0, y, t(ring[y % ring.length]!), true);
    upper(m, W - 1, y, t(ring[(y + 3) % ring.length]!), true);
  }

  // Markers for the below-character events: a sign board over the plaza and
  // a coin glint on the chest cell; both stay walkable (the upper star
  // layer never collides by itself).
  upper(m, 10, 6, t(83));
  upper(m, 15, 3, t(93));
  upper(m, 8, 8, t(2));

  m.events = [
    {
      // One tile north of the start: CIRCLE at boot opens this immediately.
      // text -> choices -> branch commands -> self-switch page change.
      id: "signpost",
      name: "Meadow Signpost",
      x: 10,
      y: 6,
      pages: [
        {
          trigger: "action",
          sprite: null,
          commands: [
            txt(["KIT MEADOW", "A tiny map for trying the kit.", "South: the road you walked in on."]),
            {
              op: "choices",
              prompt: "Read the nailed note?",
              options: [
                {
                  text: "Read note",
                  commands: [
                    { op: "switch", id: "note-read", value: true },
                    txt(["NOTE: Events are pure data.", "Every frame is a deterministic fold."]),
                    { op: "selfSwitch", key: "A", value: true },
                  ],
                },
                {
                  text: "Walk on",
                  commands: [txt(["You leave the signpost behind."])],
                },
              ],
            },
          ],
        },
        {
          condition: { selfSwitch: "A" },
          trigger: "action",
          sprite: null,
          commands: [txt(["The note is memorized. The meadow waits."])],
        },
      ],
    },
    {
      // playerTouch: walking onto the flower cell opens a line with no
      // confirm press.
      id: "flowerbed",
      name: "Wayside Flowers",
      x: 8,
      y: 8,
      pages: [
        {
          trigger: "playerTouch",
          sprite: null,
          commands: [txt(["Wild flowers brush your boots as you pass."])],
        },
      ],
    },
    {
      // Gold + item grant, then the self-switch swaps in the spent page.
      id: "chest",
      name: "Old Chest",
      x: 15,
      y: 3,
      pages: [
        {
          trigger: "action",
          sprite: null,
          commands: [
            { op: "gold", set: "add", amount: 25 },
            { op: "item", item: "potion", set: "add", count: 1 },
            { op: "selfSwitch", key: "A", value: true },
            txt(["Found 25 gold and a POTION."]),
          ],
        },
        {
          condition: { selfSwitch: "A" },
          trigger: "action",
          sprite: null,
          commands: [txt(["The chest is empty."])],
        },
      ],
    },
    {
      // A PARALLEL page: waits, then emits a sound cue the host may drain.
      // The example app mounts no audio, so the cue is observed only in the
      // reducer state by tests.
      id: "brook",
      name: "The Brook",
      x: 2,
      y: 10,
      pages: [
        {
          trigger: "parallel",
          sprite: null,
          commands: [
            { op: "wait", seconds: 5 },
            { op: "se", name: "drip", volume: 40 },
          ],
        },
      ],
    },
  ];
  return m;
}

export function buildMiniProject(): Project {
  const map = buildMiniMap();
  return {
    format: "rpgkit-project/v1",
    title: "Pocket RPG Kit — Mini Meadow",
    tileSize: 16,
    start: { map: "meadow", x: 10, y: 7, dir: "up" },
    initialGold: 5,
    sheets: [SHEET],
    items: [{ id: "potion", name: "Potion", sprite: "town.108", usable: true }],
    maps: [map],
  };
}
