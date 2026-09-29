// tests/player-name.test.ts — the {name} token: pure substitution, reducer
// expansion in text and choices, the configurable project default, and save
// round-trip.

import { describe, expect, test } from "bun:test";
import {
  createInterpState,
  createSwitchState,
  createWorld,
  stepInterp,
  type InterpInput,
} from "../src/engine/interpreter.ts";
import { createSession, startSession } from "../src/engine/session.ts";
import {
  DEFAULT_PLAYER_NAME,
  NAME_TOKEN,
  substitutePlayerName,
} from "../src/engine/player-name.ts";
import {
  canonicalJson,
  createSnapshot,
  decodeEnvelopeText,
  encodeEnvelope,
  fnv1aText,
} from "../src/engine/save.ts";
import type { Command, GameEvent, MapDef, Project } from "../src/engine/types.ts";

// --- pure substitution ------------------------------------------------------

describe("substitutePlayerName", () => {
  test("replaces every token and leaves other braces alone", () => {
    expect(substitutePlayerName("Hi {name}!", "Red")).toBe("Hi Red!");
    expect(substitutePlayerName("{name}/{name}", "Red")).toBe("Red/Red");
    expect(substitutePlayerName("{other} and {name}", "Red")).toBe("{other} and Red");
    expect(substitutePlayerName("no token", "Red")).toBe("no token");
  });

  test("a name that contains the token is substituted once (it terminates)", () => {
    // {name} with name "a{name}b" -> "aa{name}bb" is NOT rescanned, so the
    // expansion always terminates even if a future rename op sets such a name.
    expect(substitutePlayerName("{name}", `a${NAME_TOKEN}b`)).toBe(`a${NAME_TOKEN}b`);
  });
});

// --- reducer expansion ------------------------------------------------------

const MAP_ID = "v";
function world(commands: Command[]) {
  const ev: GameEvent = {
    id: "e",
    x: 10,
    y: 10,
    pages: [{ trigger: "autorun", commands }],
  };
  const map: MapDef = {
    id: MAP_ID,
    name: "t",
    width: 20,
    height: 13,
    sheets: ["town"],
    ground: Array(20 * 13).fill("town.0"),
    events: [ev],
  };
  return createWorld(map, [], 60);
}

const cell = { x: 10, y: 10 };
const noEdges: InterpInput = {
  confirmEdge: false,
  cancelEdge: false,
  upEdge: false,
  downEdge: false,
  playerCell: cell,
  prevCell: cell,
  facing: 2,
};

describe("{name} in the reducer", () => {
  test("a text modal shows the banked player name and counts reveal over it", () => {
    const w = world([{ op: "text", lines: ["Hey {name}."], cps: 30 }]);
    let s = createInterpState(createSwitchState({ playerName: "Red" }));
    s = stepInterp(w, s, noEdges);
    expect(s.modal).toMatchObject({ kind: "text", lines: ["Hey Red."] });
    // "Hey Red." is 8 chars; total must reflect the EXPANDED text, not the
    // 12-character authored "Hey {name}.".
    expect((s.modal as { total: number }).total).toBe(8);
  });

  test("absent playerName falls back to the default", () => {
    const w = world([{ op: "text", lines: ["{name}"] }]);
    let s = createInterpState();
    s.sw.playerName = undefined as unknown as string;
    s = stepInterp(w, s, noEdges);
    expect(s.modal).toMatchObject({ lines: [DEFAULT_PLAYER_NAME] });
  });

  test("choices prompt and options expand the token", () => {
    const w = world([{
      op: "choices",
      prompt: "{name}, pick",
      options: [
        { text: "I am {name}", commands: [] },
        { text: "no name", commands: [] },
      ],
    }]);
    let s = createInterpState(createSwitchState({ playerName: "Ada" }));
    s = stepInterp(w, s, noEdges);
    expect(s.modal).toMatchObject({
      kind: "choices",
      prompt: "Ada, pick",
      options: ["I am Ada", "no name"],
    });
  });
});

// --- project default --------------------------------------------------------

function baseProject(playerName?: string): Project {
  const map: MapDef = {
    id: "m",
    name: "m",
    width: 8,
    height: 8,
    sheets: ["town"],
    ground: Array(64).fill("town.0"),
    events: [],
  };
  return {
    format: "rpgkit-project/v1",
    title: "name test",
    tileSize: 16,
    start: { map: "m", x: 1, y: 1, dir: "down" },
    ...(playerName !== undefined ? { playerName } : {}),
    sheets: [{ id: "town", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: [],
    maps: [map],
  };
}

describe("player name session seeding", () => {
  test("a fresh session uses project.playerName, else the built-in default", () => {
    const named = createSession(baseProject("Red"));
    expect(startSession(baseProject("Red"), named).sw.playerName).toBe("Red");
    const def = createSession(baseProject());
    expect(startSession(baseProject(), def).sw.playerName).toBe(DEFAULT_PLAYER_NAME);
  });

  test("a restored switch bank keeps its saved name over the project default", () => {
    const p = baseProject("Red");
    const sess = createSession(p);
    const saved = createSwitchState({ playerName: "Ghost" });
    expect(startSession(p, sess, saved).sw.playerName).toBe("Ghost");
  });
});

// --- save round-trip --------------------------------------------------------

describe("player name saves", () => {
  test("the name is carried byte-for-byte through an envelope", () => {
    const interp = createInterpState(createSwitchState({ playerName: "Red" }));
    const snap = createSnapshot("m", {
      tx: 0, ty: 0, px: 0, py: 0, facing: 0, phase: 0, moving: false,
      walking: false, stepDir: 0,
    }, interp, 0);
    const loaded = decodeEnvelopeText(encodeEnvelope(snap));
    expect(loaded.interp.sw.playerName).toBe("Red");
  });

  test("a checksum-valid bank with a bad name is rejected", () => {
    const interp = createInterpState();
    const snap = createSnapshot("m", {
      tx: 0, ty: 0, px: 0, py: 0, facing: 0, phase: 0, moving: false,
      walking: false, stepDir: 0,
    }, interp, 0);
    const env = JSON.parse(encodeEnvelope(snap)) as {
      format: string; version: number; checksum: string; state: any;
    };
    env.state.interp.sw.playerName = "";
    env.checksum = fnv1aText(canonicalJson(env.state));
    expect(() => decodeEnvelopeText(JSON.stringify(env))).toThrow(/playerName/);
  });
});
