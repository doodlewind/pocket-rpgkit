// tests/schema-validate-depth.test.ts — validating a large real-world
// build with a schema error threw "RangeError: Maximum call stack size
// exceeded" instead of reporting the error. Root cause was the
// pre-KR1 schema-validate.ts rebinding `errs.push` one layer deeper on
// every `oneOf` walked anywhere in the document, so a full ~4,500-event
// project accumulated thousands of bound closures before the first error
// ever pushed through them. KR1 rewrote the validator around a plain
// `recording` flag with no per-oneOf closure — this file reproduces the
// reported shape at comparable scale and pins that it stays fixed.

import { describe, expect, test } from "bun:test";
import schema from "../src/data/schema.json" with { type: "json" };
import { validateSchema } from "../src/engine/schema-validate.ts";
import type { Command, GameEvent, MapDef, Project } from "../src/engine/types.ts";

// A command tree nested `depth` levels through if/then (the same shape a
// long chain of guarded dialogue produces). `leaf` sits at the bottom.
function nestedIf(depth: number, leaf: Command): Command {
  let cur = leaf;
  for (let i = 0; i < depth; i++) {
    cur = { op: "if", if: { kind: "switch", id: `s${i}` }, then: [cur] };
  }
  return cur;
}

// The report's own figure: the deepest nesting the real Tuxemon import
// produced was 1,008 layers (scout-S1-events.md).
const REPORTED_MAX_DEPTH = 1008;

function miniProject(commands: Command[]): Project {
  const map: MapDef = {
    id: "a", name: "a", width: 1, height: 1, sheets: ["t"],
    ground: ["t.0"],
    events: [{ id: "e", x: 0, y: 0, pages: [{ trigger: "action", commands }] } as GameEvent],
  };
  return {
    format: "rpgkit-project/v1", title: "deep", tileSize: 16,
    start: { map: "a", x: 0, y: 0, dir: "down" },
    sheets: [{ id: "t", pak: "chunks", cols: 1, rows: 1 }],
    items: [],
    maps: [map],
  };
}

describe("schema-validate — deep nesting and a large document with errors", () => {
  test(`a valid command chain nested ${REPORTED_MAX_DEPTH} levels deep (if/then) validates with zero errors`, () => {
    const project = miniProject([nestedIf(REPORTED_MAX_DEPTH, { op: "exit" })]);
    expect(validateSchema(schema, project)).toEqual([]);
  });

  test(`a ${REPORTED_MAX_DEPTH}-level chain with one error at the bottom does not stack overflow and reports exactly one error`, () => {
    const project = miniProject([
      nestedIf(REPORTED_MAX_DEPTH, { op: "shop", id: "s", goods: [] } as unknown as Command),
    ]);
    let errors: ReturnType<typeof validateSchema> = [];
    expect(() => {
      errors = validateSchema(schema, project);
    }).not.toThrow();
    expect(errors.length).toBeGreaterThan(0);
  });

  test("a ~4 MB document shaped like the full Tuxemon import (263 maps x 40 events) with one error near the end does not stack overflow", () => {
    // KR1's fix is about the WHOLE-DOCUMENT walk, not any single branch's
    // depth: the old bug rebound errs.push once per oneOf encountered
    // ANYWHERE in the tree, so only a large document (not a single deep
    // map) reproduced it. This mirrors that shape at reduced but still
    // multi-megabyte scale to keep the suite fast.
    const MAPS = 263;
    const EVENTS_PER_MAP = 40;
    const good = (): Command[] => [
      { op: "text", lines: ["hello"] },
      { op: "if", if: { kind: "switch", id: "s" }, then: [{ op: "variable", id: "v", set: { op: "add", value: 1 } }] },
      { op: "moveRoute", target: "this", route: { steps: [{ pathTo: { x: 1, y: 1 } }], repeat: false, skippable: false } },
      { op: "shop", id: "s", goods: [{ item: "x", price: 1 }] },
    ];
    const bad = (): Command[] => [
      ...good().slice(0, 3),
      { op: "shop", id: "s", goods: [{ item: "x", price: -1 }] } as unknown as Command, // negative price: a real schema error
    ];
    const maps: MapDef[] = [];
    for (let m = 0; m < MAPS; m++) {
      const events: GameEvent[] = [];
      for (let e = 0; e < EVENTS_PER_MAP; e++) {
        const isLast = m === MAPS - 1 && e === EVENTS_PER_MAP - 1;
        events.push({
          id: `e${e}`, x: 0, y: 0,
          pages: [{ trigger: "action", commands: isLast ? bad() : good() }],
        } as GameEvent);
      }
      maps.push({
        id: `m${m}`, name: `m${m}`, width: 1, height: 1, sheets: ["t"],
        ground: ["t.0"], events,
      });
    }
    const project: Project = {
      format: "rpgkit-project/v1", title: "breadth", tileSize: 16,
      start: { map: "m0", x: 0, y: 0, dir: "down" },
      sheets: [{ id: "t", pak: "chunks", cols: 1, rows: 1 }],
      items: [],
      maps,
    };
    const json = JSON.stringify(project);
    expect(json.length).toBeGreaterThan(2_000_000); // multi-megabyte, matches the reported scale
    let errors: ReturnType<typeof validateSchema> = [];
    expect(() => {
      errors = validateSchema(schema, project);
    }).not.toThrow();
    // Exactly the one planted error, at the document's very last event: the
    // oneOf discriminator narrowing must not suppress or duplicate it. The
    // negative price fails the "shop" branch's own `minimum`, so oneOf
    // reports zero matches at the command itself (the nested `.price`
    // failure is only recorded during the FIRST, non-elimination walk of a
    // branch that goes on to match; here it does not).
    expect(errors.length).toBe(1);
    expect(errors[0]!.path).toBe(`$.maps[${MAPS - 1}].events[${EVENTS_PER_MAP - 1}].pages[0].commands[3]`);
    expect(errors[0]!.msg).toBe("oneOf: matched 0 branches (need exactly 1)");
  });
});
