// examples/grow/grow-project.ts — turn a grown settlement
// (engine/grow.ts) into a real rpgkit-project/v1 document.
//
// The generated village uses the SAME format, schema and loader as a
// hand-authored game: engine/schema-validate.ts validates it and
// engine/session.ts plays it. Nothing in the runtime treats a grown map
// differently from an authored one — the growth rules are the editor's
// "generate" leg; a generated project can be saved as JSON, edited by
// hand, and reloaded.
//
//   ground  -1 biome base      -> "ninja.<cell>" (walkable)
//   ground grown cell          -> "ninja.<cell>" (road, plaza, tilled)
//   upper trees / huts / fences -> sparse star layer, each a blocking
//                                  passage override (walls and fences keep
//                                  the mover out)
//   villagers                   -> events with a repeat moveRoute that
//                                  stays on road cells (guaranteed by the
//                                  grow reducer)
//
// The player starts on a road cell of the central plaza that no villager
// occupies.

import type { GameEvent, MapDef, Project, TileId } from "../../src/engine/types.ts";
import { biomeAt, growToDone, GROW_TILE, plazaCenter, wildernessTileAt, type GrowHouse, type GrowState } from "./grow.ts";
import { STAMP_END, STAMP_LIST } from "./grow-stamps.ts";

const SHEET = { id: "ninja", cols: 256, rows: Math.max(1, Math.ceil(STAMP_END / 256)), pak: "chunks" } as const;

/** Rule-grown Ninja foliage paints on the upper layer over walkable ground.
 *  It carries no "block" passage override; houses and fences stay solid.
 *  Passability keys off the reducer's decor indices, not the art id alone. */
const CANOPY_CELLS = new Set([
  GROW_TILE.TREE, GROW_TILE.BUSH, GROW_TILE.PALM, GROW_TILE.CACTUS,
  GROW_TILE.FIR, GROW_TILE.SNOW_SHRUB, GROW_TILE.FLOWER_PROP,
  GROW_TILE.GRASS_TUFT, GROW_TILE.LOGS, GROW_TILE.ROCK,
  ...Array.from({ length: 24 }, (_, i) => 46 + i),
  // Wilderness stamps (trees, bushes, rocks, flowers); houses and market stalls stay solid.
  ...STAMP_LIST.filter((st) => st.sheet !== "house" && !st.key.startsWith("market") && !st.key.startsWith("house") && !st.key.startsWith("dome"))
    .flatMap((st) => Array.from({ length: st.w * st.h }, (_, i) => st.base + i)),
]);

function tile(cell: number): TileId {
  return `ninja.${cell}`;
}

const BIOME_BASE = [90, 91, 92, 93] as const;

/** Greeting a grown villager gives when talked to. */
function villagerLine(h: GrowHouse, seed: number): string[] {
  return [
    `VILLAGER: My house grew off the road`,
    `under seed 0x${seed.toString(16).toUpperCase().padStart(8, "0")}.`,
    `Same seed always grows this door.`,
  ];
}

/** Build the playable project for a settled (done) grow state. */
export function growProject(done: GrowState): Project {
  const p = done.params;
  // The live generator has a 4,096-column backing strip, while v1 maps cap
  // width at 256. Export the authored prefix plus a four-cell edit margin;
  // the result is a normal bounded project with no empty 65K-pixel tail.
  const exportWidth = Math.min(256, Math.max(16, done.frontierX + 5));
  const ground: TileId[] = [];
  for (let y = 0; y < p.height; y++) for (let x = 0; x < exportWidth; x++) {
    const cell = done.ground[y * p.width + x]!;
    ground.push(cell < 0 ? tile(BIOME_BASE[biomeAt(p, x, y)]!) : tile(cell));
  }
  const upper: [number, TileId][] = [];
  const passage: [number, "block"][] = [];
  // Decor canopy indices are walkable (bodies pass UNDER the art); every
  // other upper cell is solid: hut roof/walls and the fence ring.
  const decorSet = new Set(done.decor);
  for (let i = 0; i < done.upper.length; i++) {
    if (done.upper[i]! >= 0) {
      const x = i % p.width;
      const y = Math.floor(i / p.width);
      if (x >= exportWidth) continue;
      const outIndex = y * exportWidth + x;
      upper.push([outIndex, tile(done.upper[i]!)]);
      // Walkable only when BOTH true: it is decor the grower planted AND
      // its art is foliage. A non-decor use of the same art stays solid.
      if (!(decorSet.has(i) && CANOPY_CELLS.has(done.upper[i]!))) passage.push([outIndex, "block"]);
    }
  }
  // Undeveloped wilderness is a deterministic presentation layer in the
  // grow demo. Materialize it into the exported project so the generated
  // rpgkit-project/v1 document starts from the same inhabited landscape.
  for (let y = 0; y < p.height; y++) for (let x = 0; x < exportWidth; x++) {
    const source = y * p.width + x;
    if (done.upper[source]! >= 0 || done.ground[source]! >= 0 || done.road[source] === 1) continue;
    const cell = wildernessTileAt(done, x, y);
    if (cell) upper.push([y * exportWidth + x, tile(cell)]);
  }

  // Villager events, stable id order (birth order).
  const events: GameEvent[] = done.villagers.map((v, i) => {
    const h = done.houses[v.house]!;
    return {
      id: `villager-${i + 1}`,
      name: `Villager ${i + 1}`,
      x: v.x,
      y: v.y,
      pages: [
        {
          trigger: "action",
          sprite: "villager",
          blocks: true,
          moveRoute: { steps: [...v.route], repeat: true, skippable: false },
          commands: [{ op: "text", lines: villagerLine(h, p.seed) }],
        },
      ],
    };
  });

  // A plaque on the plaza records the seed — the generated game states its
  // own provenance and how to regrow it identically.
  const { x: cx, y: cy } = plazaCenter(p);
  events.push({
    id: "seed-plaque",
    name: "Seed Plaque",
    x: cx,
    y: cy - 1,
    pages: [
      {
        trigger: "action",
        sprite: null,
        commands: [
          {
            op: "text",
            lines: [
              "<Settlement Plaque>",
              `Grown by rule from seed 0x${p.seed.toString(16).toUpperCase().padStart(8, "0")}.`,
              "Roads, huts, fields and walkers all from one number.",
            ],
          },
        ],
      },
    ],
  });

  const map: MapDef = {
    id: "settlement",
    name: "Grown Settlement",
    width: exportWidth,
    height: p.height,
    sheets: [SHEET.id],
    ground,
    upper,
    passage,
    events,
  };

  // Start the player on a plaza road cell no villager owns.
  const claimed = new Set(done.villagers.map((v) => v.y * p.width + v.x));
  let sx = cx;
  let sy = cy + 1;
  outer: for (let radius = 0; radius <= 2; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 1 || y < 1 || x >= p.width - 1 || y >= p.height - 1) continue;
        const i = y * p.width + x;
        if (done.road[i] === 1 && !claimed.has(i)) {
          sx = x;
          sy = y;
          break outer;
        }
      }
    }
  }

  return {
    format: "rpgkit-project/v1",
    title: `Grown Settlement 0x${p.seed.toString(16).toUpperCase().padStart(8, "0")}`,
    tileSize: 16,
    start: { map: "settlement", x: sx, y: sy, dir: "down" },
    sheets: [{ ...SHEET }],
    items: [],
    sprites: {
      villager: { kind: "image", src: "assets/grow-villager.png" },
    },
    maps: [map],
  };
}

/** Grow a seed to completion and emit its playable project. */
export function generateProject(params: GrowState["params"]): Project {
  return growProject(growToDone(params));
}
