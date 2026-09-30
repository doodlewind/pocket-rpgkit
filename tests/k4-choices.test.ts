// tests/k4-choices.test.ts — T2-9: choices widen from 4 to 8 options
// (labels up to 64 chars, B2). compile()/runFiber already treat the
// option count generically (modulo the live length), so this is a
// schema-shape test plus a direct proof that an 8th option is reachable
// and its branch runs. The scrolling window is a UI concern
// (ui-theme-sim.test.ts).

import { describe, expect, test } from "bun:test";
import {
  createInterpState,
  createWorld,
  stepInterp,
  type InterpInput,
} from "../src/engine/interpreter.ts";
import { validateSchema } from "../src/engine/schema-validate.ts";
import schema from "../src/data/schema.json" with { type: "json" };
import type { Command, GameEvent, MapDef, Project, TileId } from "../src/engine/types.ts";

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

const OPTIONS = ["Mercenary", "Diplomat", "Smuggler", "Pilgrim", "Scholar", "Recluse", "Hermit", "Wanderer"];

function eightChoiceWorld() {
  const options = OPTIONS.map((text, i) => ({
    text,
    commands: [{ op: "variable", id: "picked", set: { op: "set" as const, value: i } }] as Command[],
  }));
  const event: GameEvent = {
    id: "e", x: 10, y: 10,
    pages: [{ trigger: "action", sprite: null, commands: [{ op: "choices", prompt: "Choose", options }] }],
  };
  return createWorld(imap([event]));
}

describe("T2-9 more than 4 choices", () => {
  test("opens with 8 options and the cursor at 0", () => {
    const w = eightChoiceWorld();
    let s = createInterpState();
    s = stepInterp(w, s, iinput({ confirmEdge: true }));
    expect(s.modal).toMatchObject({ kind: "choices", options: OPTIONS, index: 0 });
  });

  test("down-cursor reaches and selects the 8th option; its branch runs", () => {
    const w = eightChoiceWorld();
    let s = createInterpState();
    s = stepInterp(w, s, iinput({ confirmEdge: true })); // open
    for (let i = 0; i < 7; i++) s = stepInterp(w, s, iinput({ downEdge: true }));
    expect((s.modal as { index: number }).index).toBe(7);
    s = stepInterp(w, s, iinput({ confirmEdge: true })); // pick option 7
    expect(s.sw.variables.picked).toBe(7);
    expect(s.modal).toBeNull();
  });

  test("the cursor wraps both directions across all 8 rows", () => {
    const w = eightChoiceWorld();
    let s = createInterpState();
    s = stepInterp(w, s, iinput({ confirmEdge: true }));
    s = stepInterp(w, s, iinput({ upEdge: true })); // wrap up from 0 -> 7
    expect((s.modal as { index: number }).index).toBe(7);
    s = stepInterp(w, s, iinput({ downEdge: true })); // wrap down from 7 -> 0
    expect((s.modal as { index: number }).index).toBe(0);
  });

  test("selecting a middle option (e.g. index 3) runs exactly that branch", () => {
    const w = eightChoiceWorld();
    let s = createInterpState();
    s = stepInterp(w, s, iinput({ confirmEdge: true }));
    for (let i = 0; i < 3; i++) s = stepInterp(w, s, iinput({ downEdge: true }));
    s = stepInterp(w, s, iinput({ confirmEdge: true }));
    expect(s.sw.variables.picked).toBe(3);
  });
});

describe("T2-9 schema: up to 8 options, labels up to 64 chars", () => {
  const project = (options: { text: string; commands: Command[] }[]): Project => ({
    format: "rpgkit-project/v1", title: "t", tileSize: 16,
    start: { map: "a", x: 0, y: 0, dir: "down" },
    sheets: [{ id: "t", pak: "chunks", cols: 1, rows: 1 }],
    items: [],
    maps: [{
      id: "a", name: "a", width: 1, height: 1, sheets: ["t"], ground: ["t.0"],
      events: [{ id: "e", x: 0, y: 0, pages: [{ trigger: "action", commands: [{ op: "choices", prompt: "p", options }] }] }],
    }],
  });
  const opt = (text: string): { text: string; commands: Command[] } => ({ text, commands: [] });

  test("2..8 options validate; 1 and 9 are rejected", () => {
    expect(validateSchema(schema, project([opt("a"), opt("b")]))).toEqual([]);
    expect(validateSchema(schema, project(Array.from({ length: 8 }, (_, i) => opt(`o${i}`))))).toEqual([]);
    expect(validateSchema(schema, project([opt("a")])).length).toBeGreaterThan(0);
    expect(validateSchema(schema, project(Array.from({ length: 9 }, (_, i) => opt(`o${i}`)))).length).toBeGreaterThan(0);
  });

  test("a 64-char label validates; 65 chars is rejected", () => {
    const label64 = "x".repeat(64);
    const label65 = "x".repeat(65);
    expect(validateSchema(schema, project([opt(label64), opt("b")]))).toEqual([]);
    expect(validateSchema(schema, project([opt(label65), opt("b")])).length).toBeGreaterThan(0);
  });

  // B2: the real Spyder campaign opening choice label (33 chars) was
  // rejected by the old 32-char cap even though the UI already truncates
  // safely; importers should not have to hand-shorten authored text.
  test("a real 33-char option label (Tuxemon: Spyder and the Cathedral) validates", () => {
    const label = "Tuxemon: Spyder and the Cathedral";
    expect(label.length).toBe(33);
    expect(validateSchema(schema, project([opt(label), opt("b")]))).toEqual([]);
  });
});
