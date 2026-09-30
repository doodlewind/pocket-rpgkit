// tests/k4-variable-ops.test.ts — T2-16 variable-operand arithmetic:
// `variable`'s set can read another variable's live value (copy/add/sub/
// mul/div/mod) instead of only a literal or a random range. Pure
// stepInterp coverage, plus the schema.json acceptance/rejection shape.

import { describe, expect, test } from "bun:test";
import {
  createInterpState,
  createSwitchState,
  createWorld,
  stepInterp,
  type InterpInput,
} from "../src/engine/interpreter.ts";
import { createSnapshot, decodeEnvelopeText, encodeEnvelope } from "../src/engine/save.ts";
import { initialMovement } from "../src/engine/movement.ts";
import { validateSchema } from "../src/engine/schema-validate.ts";
import schema from "../src/data/schema.json" with { type: "json" };
import type { Command, GameEvent, MapDef, Project, TileId, VariableValue } from "../src/engine/types.ts";

const MAP_ID = "v";
const GRASS: TileId = "town.0";

const NO_EDGE = { confirmEdge: false, cancelEdge: false, upEdge: false, downEdge: false };
function iinput(partial: Partial<InterpInput> = {}): InterpInput {
  const cell = partial.playerCell ?? { x: 10, y: 10 };
  return { ...NO_EDGE, playerCell: cell, prevCell: partial.prevCell ?? cell, facing: partial.facing ?? 2, ...partial };
}
function imap(events: GameEvent[]): MapDef {
  return { id: MAP_ID, name: "t", width: 20, height: 13, sheets: ["town"], ground: Array(260).fill(GRASS), events };
}
function ge(id: string, commands: Command[]): GameEvent {
  return { id, x: 10, y: 10, pages: [{ trigger: "action", sprite: null, commands }] };
}

/** Fold ONE action-triggered fiber to completion (it never suspends: every
 *  command here is instant), starting from initial switch-state `init`. */
function run(commands: Command[], init?: Record<string, number>): Record<string, VariableValue> {
  const w = createWorld(imap([ge("e", commands)]));
  let s = createInterpState(createSwitchState(init ? { variables: init } : undefined));
  s = stepInterp(w, s, iinput({ confirmEdge: true }));
  return s.sw.variables;
}

const ref = (id: string, op: "copy" | "add" | "sub" | "mul" | "div" | "mod", from: string): Command => ({
  op: "variable", id, set: { op, from },
});

describe("T2-16 variable-operand arithmetic", () => {
  test("copy assigns the source's live value, overwriting the target", () => {
    expect(run([ref("a", "copy", "b")], { a: 5, b: 9 })).toMatchObject({ a: 9, b: 9 });
  });

  test("add/sub/mul combine the target's current value with the source's", () => {
    expect(run([ref("a", "add", "b")], { a: 5, b: 9 }).a).toBe(14);
    expect(run([ref("a", "sub", "b")], { a: 5, b: 9 }).a).toBe(-4);
    expect(run([ref("a", "mul", "b")], { a: 5, b: 9 }).a).toBe(45);
  });

  test("div floors toward negative infinity (B3, matches MV/Tuxemon); mod is the JS remainder", () => {
    expect(run([ref("a", "div", "b")], { a: 7, b: 2 }).a).toBe(3);
    expect(run([ref("a", "div", "b")], { a: -7, b: 2 }).a).toBe(-4); // floor(-3.5), not trunc's -3
    expect(run([ref("a", "mod", "b")], { a: 7, b: 2 }).a).toBe(1);
    expect(run([ref("a", "mod", "b")], { a: -7, b: 2 }).a).toBe(-1);
  });

  test("B3: division and modulo by a source reading 0 leave the variable unchanged", () => {
    const div = run([ref("a", "div", "b")], { a: 7, b: 0 });
    const mod = run([ref("a", "mod", "b")], { a: 7, b: 0 });
    expect(div.a).toBe(7); // not 0: Tuxemon's safe_floordiv returns the left operand
    expect(mod.a).toBe(7);
    expect(Number.isFinite(div.a!)).toBe(true);
    expect(Number.isFinite(mod.a!)).toBe(true);
  });

  test("an unset source variable reads 0, matching every other read of an absent id", () => {
    expect(run([ref("a", "add", "never-set")], { a: 5 }).a).toBe(5);
    expect(run([ref("a", "copy", "never-set")]).a).toBe(0);
  });

  test("a variable can combine with itself (id === from)", () => {
    // a = a + a, doubling it — proves the source read happens before the
    // target write within the same instruction.
    expect(run([ref("a", "add", "a")], { a: 6 }).a).toBe(12);
  });

  test("chained variable-ref ops within one command list see each other's writes in order", () => {
    // total = a; total += b; total *= 2
    const out = run([
      { op: "variable", id: "total", set: { op: "copy" as const, from: "a" } },
      ref("total", "add", "b"),
      { op: "variable", id: "total", set: { op: "add" as const, value: 0 } }, // no-op literal, mixed with ref ops
      ref("total", "mul", "two"),
    ], { a: 3, b: 4, two: 2 });
    expect(out.total).toBe(14);
  });

  test("literal set/add/sub and the random op still work unchanged alongside the new variant", () => {
    expect(run([{ op: "variable", id: "a", set: { op: "set", value: 7 } }]).a).toBe(7);
    const out = run([{ op: "variable", id: "a", set: { op: "random", min: 3, max: 3 } }]);
    expect(out.a).toBe(3);
  });
});

describe("T2-16 schema: the variable-ref shape", () => {
  const project = (set: unknown): Project => ({
    format: "rpgkit-project/v1", title: "t", tileSize: 16,
    start: { map: "a", x: 0, y: 0, dir: "down" },
    sheets: [{ id: "t", pak: "chunks", cols: 1, rows: 1 }],
    items: [],
    maps: [{
      id: "a", name: "a", width: 1, height: 1, sheets: ["t"], ground: ["t.0"],
      events: [{ id: "e", x: 0, y: 0, pages: [{ trigger: "action", commands: [{ op: "variable", id: "v", set } as unknown as Command] }] }],
    }],
  });

  test("every op accepts {op, from}", () => {
    for (const op of ["copy", "add", "sub", "mul", "div", "mod"]) {
      expect(validateSchema(schema, project({ op, from: "other" }))).toEqual([]);
    }
  });

  test("an unknown op, or from missing/wrong-typed, is rejected", () => {
    expect(validateSchema(schema, project({ op: "xor", from: "other" })).length).toBeGreaterThan(0);
    expect(validateSchema(schema, project({ op: "copy" })).length).toBeGreaterThan(0);
    expect(validateSchema(schema, project({ op: "copy", from: 5 })).length).toBeGreaterThan(0);
  });

  test("mixing {value} into a from-shaped set (or vice versa) is rejected", () => {
    expect(validateSchema(schema, project({ op: "add", from: "other", value: 1 })).length).toBeGreaterThan(0);
    expect(validateSchema(schema, project({ op: "add", value: 1 }))).toEqual([]); // the literal variant alone still validates
  });
});

// B3: every write lands as a finite integer clamped to
// [-MAX_SAFE_INTEGER, MAX_SAFE_INTEGER]. JSON Schema's "integer" only
// requires no fractional part, so an authoring-time value like 1e308 (a
// legal double with none) passes schema validation while being far outside
// that range; the runtime clamp, not the schema, is what keeps arithmetic
// on it from producing a non-finite result.
describe("T2-16/B3 variable writes: finite-integer clamp", () => {
  const MAX = Number.MAX_SAFE_INTEGER;

  test("a literal set/add/sub clamps to the safe-integer boundary", () => {
    expect(run([{ op: "variable", id: "a", set: { op: "set", value: 1e308 } }]).a).toBe(MAX);
    expect(run([{ op: "variable", id: "a", set: { op: "set", value: -1e308 } }]).a).toBe(-MAX);
    expect(run([{ op: "variable", id: "a", set: { op: "add", value: 1e308 } }], { a: 5 }).a).toBe(MAX);
  });

  test("1e308 * 1e308 clamps to a finite integer instead of overflowing to Infinity", () => {
    const out = run([
      { op: "variable", id: "a", set: { op: "set", value: 1e308 } },
      { op: "variable", id: "b", set: { op: "set", value: 1e308 } },
      ref("c", "copy", "a"),
      ref("c", "mul", "b"),
    ]);
    expect(Number.isFinite(out.c!)).toBe(true);
    expect(out.c).toBe(MAX);
  });

  test("a schema-legal 1e308 * 1e308 project saves and reloads after clamping", () => {
    const commands: Command[] = [
      { op: "variable", id: "a", set: { op: "set", value: 1e308 } },
      { op: "variable", id: "b", set: { op: "set", value: 1e308 } },
      { op: "variable", id: "c", set: { op: "copy", from: "a" } },
      ref("c", "mul", "b"),
    ];
    const p: Project = {
      format: "rpgkit-project/v1", title: "t", tileSize: 16,
      start: { map: "a", x: 0, y: 0, dir: "down" },
      sheets: [{ id: "t", pak: "chunks", cols: 1, rows: 1 }],
      items: [],
      maps: [{
        id: "a", name: "a", width: 1, height: 1, sheets: ["t"], ground: ["t.0"],
        events: [{ id: "e", x: 0, y: 0, pages: [{ trigger: "action", commands }] }],
      }],
    };
    expect(validateSchema(schema, p)).toEqual([]); // schema has no upper bound: the clamp is a runtime invariant

    const w = createWorld(p.maps[0]!);
    let s = createInterpState();
    s = stepInterp(w, s, iinput({
      confirmEdge: true, playerCell: { x: 0, y: 0 }, prevCell: { x: 0, y: 0 },
    }));
    expect(s.main).toBeNull(); // the fiber ran to completion (every command here is instant)
    expect(s.sw.variables.c).toBe(MAX);

    const player = initialMovement(0, 0, 0, { tile: 16, speed: 2 });
    const snap = createSnapshot("a", player, s, 0);
    const restored = decodeEnvelopeText(encodeEnvelope(snap)); // throws on a non-finite variable
    expect(restored.interp.sw.variables.c).toBe(MAX);
  });

  test("negative division floors toward negative infinity and stays within the safe range", () => {
    expect(run([ref("a", "div", "b")], { a: -7, b: 2 }).a).toBe(-4);
    expect(run([ref("a", "div", "b")], { a: -MAX, b: 1 }).a).toBe(-MAX);
  });

  test("division/modulo by a source reading 0 leave the variable unchanged, never NaN", () => {
    expect(run([ref("a", "div", "b")], { a: 12, b: 0 }).a).toBe(12);
    expect(run([ref("a", "mod", "b")], { a: 12, b: 0 }).a).toBe(12);
  });
});

// B3 follow-up: the clamp is not special to `variable` — every numeric bank
// in state.sw (gold, items, and by extension shop gold/stock) shares the
// same normalizer, so a schema-legal-but-huge `amount`/`count` cannot push
// the saved state non-finite either.
describe("B3: gold/item command writes share the variable clamp", () => {
  const MAX = Number.MAX_SAFE_INTEGER;

  test("two 1e308 gold adds clamp to the safe-integer boundary and still save/reload", () => {
    const commands: Command[] = [
      { op: "gold", set: "add", amount: 1e308 },
      { op: "gold", set: "add", amount: 1e308 },
    ];
    const w = createWorld(imap([ge("e", commands)]));
    let s = createInterpState();
    s = stepInterp(w, s, iinput({ confirmEdge: true }));
    expect(Number.isFinite(s.sw.gold)).toBe(true);
    expect(s.sw.gold).toBe(MAX);

    const player = initialMovement(10, 10, 0, { tile: 16, speed: 2 });
    const snap = createSnapshot(MAP_ID, player, s, 0);
    const restored = decodeEnvelopeText(encodeEnvelope(snap)); // throws on a non-finite gold
    expect(restored.interp.sw.gold).toBe(MAX);
  });

  test("two 1e308 item adds clamp to the safe-integer boundary and still save/reload", () => {
    const commands: Command[] = [
      { op: "item", item: "gem", set: "add", count: 1e308 },
      { op: "item", item: "gem", set: "add", count: 1e308 },
    ];
    const w = createWorld(imap([ge("e", commands)]));
    let s = createInterpState();
    s = stepInterp(w, s, iinput({ confirmEdge: true }));
    expect(Number.isFinite(s.sw.items.gem)).toBe(true);
    expect(s.sw.items.gem).toBe(MAX);

    const player = initialMovement(10, 10, 0, { tile: 16, speed: 2 });
    const snap = createSnapshot(MAP_ID, player, s, 0);
    const restored = decodeEnvelopeText(encodeEnvelope(snap)); // throws on a non-finite item count
    expect(restored.interp.sw.items.gem).toBe(MAX);
  });
});
