// examples/grow/grow-stamps.ts — multi-cell art stamps for the grown
// world, cut from the CC0 Ninja Adventure pack (TilesetNature, TilesetHouse,
// TilesetDesert). One registry feeds three consumers: gen-assets.ts cuts one
// 16px cell PNG per stamp cell, grow.ts writes the cell ids into the grids,
// and GrowView/grow-project resolve a cell back to its stamp.
//
// Ids are allocated in registry order from STAMP_BASE upward, so the list is
// APPEND-ONLY: reordering or inserting renumbers every later stamp.

export type StampSheet = "nature" | "house" | "desert";

export interface StampDef {
  key: string;
  sheet: StampSheet;
  /** Source rectangle in 16px cells. */
  sx: number; sy: number; w: number; h: number;
  /** Houses: door column inside the stamp (the door is on the bottom row). */
  door?: number;
}

export interface Stamp extends StampDef { base: number }

export const STAMP_BASE = 128;

const DEFS: readonly StampDef[] = [
  // Nature, 2x2 trees.
  { key: "tree-round", sheet: "nature", sx: 0, sy: 0, w: 2, h: 2 },
  { key: "tree-pine", sheet: "nature", sx: 2, sy: 0, w: 2, h: 2 },
  { key: "tree-dead", sheet: "nature", sx: 4, sy: 0, w: 2, h: 2 },
  { key: "tree-snowpine-moss", sheet: "nature", sx: 8, sy: 0, w: 2, h: 2 },
  { key: "tree-snowpine", sheet: "nature", sx: 10, sy: 0, w: 2, h: 2 },
  { key: "tree-snowround", sheet: "nature", sx: 12, sy: 0, w: 2, h: 2 },
  { key: "tree-cherry", sheet: "nature", sx: 14, sy: 0, w: 2, h: 2 },
  { key: "tree-round-b", sheet: "nature", sx: 16, sy: 0, w: 2, h: 2 },
  { key: "tree-round-c", sheet: "nature", sx: 18, sy: 0, w: 2, h: 2 },
  { key: "tree-small", sheet: "nature", sx: 6, sy: 8, w: 2, h: 2 },
  // Nature, 2x2 ground objects.
  { key: "stump-big", sheet: "nature", sx: 0, sy: 8, w: 2, h: 2 },
  { key: "stump-big-b", sheet: "nature", sx: 2, sy: 8, w: 2, h: 2 },
  { key: "boulder-brown", sheet: "nature", sx: 13, sy: 8, w: 2, h: 2 },
  { key: "boulder-grey", sheet: "nature", sx: 16, sy: 8, w: 2, h: 2 },
  { key: "bush-dark", sheet: "nature", sx: 0, sy: 12, w: 2, h: 2 },
  { key: "bush-snow", sheet: "nature", sx: 2, sy: 12, w: 2, h: 2 },
  // Nature, 1x1 dressing.
  { key: "stump", sheet: "nature", sx: 4, sy: 8, w: 1, h: 1 },
  { key: "twig", sheet: "nature", sx: 5, sy: 9, w: 1, h: 1 },
  { key: "bush-a", sheet: "nature", sx: 0, sy: 10, w: 1, h: 1 },
  { key: "bush-b", sheet: "nature", sx: 1, sy: 10, w: 1, h: 1 },
  { key: "bush-c", sheet: "nature", sx: 2, sy: 10, w: 1, h: 1 },
  { key: "tuft-a", sheet: "nature", sx: 3, sy: 10, w: 1, h: 1 },
  { key: "tuft-b", sheet: "nature", sx: 4, sy: 10, w: 1, h: 1 },
  { key: "tuft-c", sheet: "nature", sx: 7, sy: 10, w: 1, h: 1 },
  { key: "flower-sun", sheet: "nature", sx: 0, sy: 11, w: 1, h: 1 },
  { key: "flower-sun-b", sheet: "nature", sx: 1, sy: 11, w: 1, h: 1 },
  { key: "clover", sheet: "nature", sx: 2, sy: 11, w: 1, h: 1 },
  { key: "flower-daisy", sheet: "nature", sx: 6, sy: 11, w: 1, h: 1 },
  { key: "leaves", sheet: "nature", sx: 12, sy: 11, w: 1, h: 1 },
  { key: "rock-brown", sheet: "nature", sx: 15, sy: 9, w: 1, h: 1 },
  { key: "rock-grey", sheet: "nature", sx: 18, sy: 9, w: 1, h: 1 },
  { key: "snow-rock", sheet: "nature", sx: 4, sy: 12, w: 1, h: 1 },
  { key: "snow-round", sheet: "nature", sx: 5, sy: 12, w: 1, h: 1 },
  { key: "snow-grass", sheet: "nature", sx: 8, sy: 13, w: 1, h: 1 },
  { key: "snow-grass-b", sheet: "nature", sx: 9, sy: 13, w: 1, h: 1 },
  { key: "snowball", sheet: "nature", sx: 10, sy: 13, w: 1, h: 1 },
  // Desert.
  { key: "palm", sheet: "desert", sx: 10, sy: 10, w: 2, h: 2 },
  { key: "palm-b", sheet: "desert", sx: 12, sy: 10, w: 2, h: 2 },
  { key: "sprout", sheet: "desert", sx: 14, sy: 10, w: 1, h: 1 },
  { key: "sprout-b", sheet: "desert", sx: 14, sy: 11, w: 1, h: 1 },
  { key: "market-red", sheet: "desert", sx: 2, sy: 10, w: 2, h: 2 },
  { key: "market-gold", sheet: "desert", sx: 4, sy: 10, w: 2, h: 2 },
  { key: "pot-red", sheet: "desert", sx: 6, sy: 11, w: 1, h: 1 },
  { key: "pot-gold", sheet: "desert", sx: 7, sy: 11, w: 1, h: 1 },
  // Houses: grass, mud, sand, snow (door on the bottom row).
  { key: "house-orange", sheet: "house", sx: 0, sy: 0, w: 4, h: 3, door: 1 },
  { key: "house-redtile", sheet: "house", sx: 12, sy: 0, w: 4, h: 3, door: 1 },
  { key: "house-beige", sheet: "house", sx: 4, sy: 0, w: 4, h: 3, door: 1 },
  { key: "hut-wood", sheet: "house", sx: 26, sy: 0, w: 3, h: 3, door: 1 },
  { key: "hut-gable", sheet: "house", sx: 0, sy: 7, w: 3, h: 3, door: 1 },
  { key: "hut-thatch", sheet: "house", sx: 3, sy: 7, w: 3, h: 3, door: 1 },
  { key: "dome-green", sheet: "desert", sx: 0, sy: 0, w: 3, h: 3, door: 1 },
  { key: "house-flat", sheet: "desert", sx: 6, sy: 0, w: 4, h: 3, door: 1 },
  { key: "house-round-beige", sheet: "house", sx: 23, sy: 0, w: 3, h: 3, door: 1 },
  { key: "igloo", sheet: "house", sx: 0, sy: 11, w: 3, h: 3, door: 1 },
  { key: "igloo-b", sheet: "house", sx: 3, sy: 11, w: 3, h: 3, door: 1 },
  { key: "igloo-c", sheet: "house", sx: 6, sy: 11, w: 3, h: 3, door: 1 },
];

export const STAMPS: Readonly<Record<string, Stamp>> = (() => {
  const out: Record<string, Stamp> = {};
  let next = STAMP_BASE;
  for (const d of DEFS) {
    if (out[d.key]) throw new Error(`grow-stamps: duplicate key ${d.key}`);
    out[d.key] = { ...d, base: next };
    next += d.w * d.h;
  }
  return out;
})();

export const STAMP_LIST: readonly Stamp[] = Object.values(STAMPS);
export const STAMP_END = STAMP_LIST.reduce((m, s) => Math.max(m, s.base + s.w * s.h), STAMP_BASE);

const OWNER: (Stamp | undefined)[] = [];
for (const s of STAMP_LIST) for (let i = 0; i < s.w * s.h; i++) OWNER[s.base + i] = s;

/** Cell id of the stamp part at (dx, dy). */
export function stampCell(key: string, dx: number, dy: number): number {
  const s = STAMPS[key];
  if (!s) throw new Error(`grow-stamps: unknown stamp ${key}`);
  return s.base + dy * s.w + dx;
}

/** The stamp a cell id belongs to, without allocating (hot view paths). */
export function stampOwner(cell: number): Stamp | undefined {
  return cell >= STAMP_BASE ? OWNER[cell] : undefined;
}

/** The stamp a cell id belongs to, and the part's offset inside it. */
export function stampOfCell(cell: number): { stamp: Stamp; dx: number; dy: number } | undefined {
  const s = cell >= STAMP_BASE ? OWNER[cell] : undefined;
  if (!s) return undefined;
  const part = cell - s.base;
  return { stamp: s, dx: part % s.w, dy: Math.floor(part / s.w) };
}

/** Houses available to each biome (grass, mud, sand, snow). */
export const HOUSE_STAMPS: readonly (readonly string[])[] = [
  ["house-orange", "house-redtile", "house-beige"],
  ["hut-wood", "hut-gable", "hut-thatch"],
  ["dome-green", "house-flat", "house-round-beige"],
  ["igloo", "igloo-b", "igloo-c"],
];
