import { describe, expect, test } from "bun:test";
import { playerBlockedBy, type CharState, type CharsState } from "../src/engine/chars.ts";
import {
  buildPassage,
  canEnter,
  canStepFrom,
  isStandable,
  type Dir4,
  type PassageTable,
} from "../src/engine/passability.ts";
import { tableWithBodies } from "../src/engine/session.ts";
import type { Sheet, TileId } from "../src/engine/types.ts";

function legacyTableWithBodies(base: PassageTable, chars: CharsState): PassageTable {
  const solid = new Uint8Array(base.solid);
  const blocked = playerBlockedBy(chars);
  for (let i = 0; i < solid.length; i++) {
    if (solid[i] === 0 && blocked(i % base.width, Math.floor(i / base.width))) {
      solid[i] = 1;
    }
  }
  return { ...base, bodyBlocks: undefined, solid };
}

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

const between = (next: () => number, lo: number, hi: number): number =>
  lo + next() % (hi - lo + 1);

function randomCharacter(next: () => number, id: string, width: number, height: number): CharState {
  const tx = between(next, -2, width + 1);
  const ty = between(next, -2, height + 1);
  const stepDir = between(next, 0, 3) as Dir4;
  return {
    id,
    tx,
    ty,
    px: tx * 16,
    py: ty * 16,
    facing: between(next, 0, 3) as Dir4,
    phase: between(next, 0, 7),
    moving: (next() & 1) === 1,
    stepDir,
    pageIndex: 0,
    visible: (next() & 1) === 1,
    blocks: (next() & 1) === 1,
    thinkIn: 0,
    route: null,
    patrol: null,
  };
}

function decisions(table: PassageTable): boolean[] {
  const out: boolean[] = [];
  for (let y = -1; y <= table.height; y++) {
    for (let x = -1; x <= table.width; x++) {
      out.push(isStandable(table, x, y), canEnter(table, x, y));
      for (const dir of [0, 1, 2, 3] as const) {
        out.push(canEnter(table, x, y, dir), canStepFrom(table, x, y, dir));
      }
    }
  }
  return out;
}

describe("session character occupancy", () => {
  test("the sparse O(characters) table equals the former per-cell scan on seeded random worlds", () => {
    const next = rng(0x1677_b10c);
    const open: Sheet = {
      id: "open",
      cols: 2,
      rows: 1,
      defaultPassage: "pass",
      dirBlock: { "1": ["left", "up"] },
    };
    const wall: Sheet = { id: "wall", cols: 1, rows: 1, defaultPassage: "block" };
    const tiles: TileId[] = ["open.0", "open.1", "wall.0", null];

    for (let trial = 0; trial < 64; trial++) {
      const width = between(next, 1, 48);
      const height = between(next, 1, 48);
      const count = width * height;
      const overrides = new Int8Array(count);
      const ground: TileId[] = [];
      for (let i = 0; i < count; i++) {
        overrides[i] = [-1, 0, 0, 0, 1][next() % 5]!;
        ground.push(tiles[next() % tiles.length]!);
      }
      const base: PassageTable = buildPassage(
        {
          id: "eq", name: "eq", width, height, sheets: [open.id, wall.id],
          ground,
          passage: overrides.reduce<[number, "pass" | "block"][]>((acc, v, i) => {
            if (v === 1) acc.push([i, "pass"]);
            else if (v === -1) acc.push([i, "block"]);
            return acc;
          }, []),
        },
        new Map([[open.id, open], [wall.id, wall]]),
      );
      const chars: CharsState = { rng: next(), chars: Object.create(null) as Record<string, CharState> };
      const charCount = between(next, 0, 40);
      for (let i = 0; i < charCount; i++) {
        chars.chars[`npc${i}`] = randomCharacter(next, `npc${i}`, width, height);
      }

      const legacy = legacyTableWithBodies(base, chars);
      const sparse = tableWithBodies(base, chars);
      expect(decisions(sparse), `trial ${trial}: ${width}x${height}, ${charCount} characters`).toEqual(decisions(legacy));
      expect(sparse.overrides).toBe(base.overrides);
      expect(base.bodyBlocks).toBeUndefined();
    }
  });
});
