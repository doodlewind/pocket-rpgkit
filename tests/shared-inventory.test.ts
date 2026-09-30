import { describe, expect, test } from "bun:test";
import { AttractController } from "../src/engine/attract.ts";
import type { BattleRules } from "../src/engine/battle.ts";
import { createSwitchState, type ShopModal } from "../src/engine/interpreter.ts";
import { createSessionSnapshot, encodeEnvelope } from "../src/engine/save.ts";
import { restoreSessionEnvelope } from "../src/engine/save-restore.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import type { Command, GameEvent, Project } from "../src/engine/types.ts";

const UP = 0x0010;
const DOWN = 0x0040;
const L = 0x0100;
const CIRCLE = 0x2000;
const CROSS = 0x4000;

function project(commands: Command[]): Project {
  const event: GameEvent = {
    id: "flow",
    x: 1,
    y: 1,
    pages: [
      { trigger: "autorun", commands },
      { condition: { switch: "flow.done" }, trigger: "action", commands: [] },
    ],
  };
  return {
    format: "rpgkit-project/v1",
    title: "shared inventory",
    tileSize: 16,
    start: { map: "a", x: 2, y: 2, dir: "down" },
    sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: [{ id: "potion", name: "Potion", sprite: "plain.0", price: 10 }],
    maps: [{
      id: "a",
      name: "a",
      width: 6,
      height: 6,
      sheets: ["plain"],
      ground: new Array(36).fill("plain.0"),
      events: [event],
    }],
  };
}

function step(session: Session, state: SessionState, buttons = 0): SessionState {
  return stepSession(session, state, {
    buttons,
    confirmEdge: (buttons & CIRCLE) !== 0,
    cancelEdge: (buttons & CROSS) !== 0,
    upEdge: (buttons & UP) !== 0,
    downEdge: (buttons & DOWN) !== 0,
  });
}

function shopModal(state: SessionState): ShopModal {
  expect(state.interp.modal?.kind).toBe("shop");
  return state.interp.modal as ShopModal;
}

const rewardRules: BattleRules = {
  start(ext) {
    return { ext, state: { advanced: false } };
  },
  step() {
    return { advanced: true };
  },
  done(state) {
    if (!(state as { advanced: boolean }).advanced) return null;
    return {
      ext: null,
      result: "win",
      items: { potion: 2 },
      gold: 50,
    };
  },
};

const overflowingRewardRules: BattleRules = {
  start: rewardRules.start,
  step: rewardRules.step,
  done(state) {
    if (!(state as { advanced: boolean }).advanced) return null;
    return {
      ext: null,
      result: "win",
      items: { z: 1, potion: 1e308 },
      gold: 1e308,
    };
  },
};

describe("shared session inventory for extensions and battles", () => {
  test("an extension item/gold replacement is visible to later commands and conditions in the same tick", () => {
    const p = project([
      { op: "ext", call: "demo.replace_wallet", args: null },
      {
        op: "if",
        if: { kind: "item", id: "potion", count: 2 },
        then: [{ op: "switch", id: "saw.items", value: true }],
      },
      {
        op: "if",
        if: { kind: "gold", amount: 40 },
        then: [{ op: "switch", id: "saw.gold", value: true }],
      },
      { op: "ext", call: "demo.observe_wallet", args: null },
      { op: "switch", id: "flow.done", value: true },
    ]);
    const session = createSession(p, 60, {
      extensions: {
        commands: {
          "demo.replace_wallet": () => ({ items: { old: 0, potion: 2 }, gold: 40 }),
          "demo.observe_wallet": (context) => ({
            writes: {
              "observed.items": context.items.potion ?? -1,
              "observed.gold": context.gold,
            },
          }),
        },
      },
    });
    const initial = startSession(
      p,
      session,
      createSwitchState({ items: { old: 1 }, gold: 5 }),
    );
    const state = step(session, initial);

    expect(state.sw.items).toEqual({ potion: 2 });
    expect(state.sw.gold).toBe(40);
    expect(state.sw.switches["saw.items"]).toBe(true);
    expect(state.sw.switches["saw.gold"]).toBe(true);
    expect(state.sw.variables["observed.items"]).toBe(2);
    expect(state.sw.variables["observed.gold"]).toBe(40);
  });

  test("item replacements clamp and admit new kinds in lexical order after removals", () => {
    const p = project([
      { op: "ext", call: "demo.apply_limits", args: null },
      { op: "ext", call: "demo.clear_gold", args: null },
      { op: "switch", id: "flow.done", value: true },
    ]);
    p.system = { inventory: { maxPerItem: 2, maxKinds: 3 } };
    const session = createSession(p, 60, {
      extensions: {
        commands: {
          "demo.apply_limits": () => ({
            // Deliberately reverse the candidates: admission must not depend
            // on JavaScript property insertion order.
            items: { z: 1, old: 0, negative: -4, kept: 1.9, b: 1e308, a: 1 },
            gold: 1e308,
          }),
          "demo.clear_gold": (context) => ({
            writes: { "observed.clampedGold": context.gold },
            gold: -7,
          }),
        },
      },
    });
    const initial = startSession(
      p,
      session,
      createSwitchState({ items: { old: 1, kept: 1 }, gold: 5 }),
    );
    const state = step(session, initial);

    expect(state.sw.items).toEqual({ kept: 1, a: 1, b: 2 });
    expect(state.sw.variables["observed.clampedGold"]).toBe(Number.MAX_SAFE_INTEGER);
    expect(state.sw.gold).toBe(0);
  });

  test("BattleRules.start reads a purchase from the same backpack and wallet", () => {
    const p = project([
      { op: "shop", id: "chemist", goods: [{ item: "potion" }], sell: false },
      { op: "battle", setup: null },
      { op: "switch", id: "flow.done", value: true },
    ]);
    p.initialGold = 20;
    const rules: BattleRules = {
      start(ext, _setup, _seed, context) {
        return {
          ext,
          state: { items: { ...context.items }, gold: context.gold },
        };
      },
      step(state) {
        return state;
      },
      done() {
        return null;
      },
    };
    const session = createSession(p, 60, { battle: rules });
    let state = step(session, startSession(p, session));
    expect(shopModal(state).gold).toBe(20);

    state = step(session, state, CIRCLE); // buy one potion
    state = step(session, state, CROSS); // leave and start the battle

    expect(state.sw.items).toEqual({ potion: 1 });
    expect(state.sw.gold).toBe(10);
    expect(state.scene?.state).toEqual({ items: { potion: 1 }, gold: 10 });
  });

  test("a legacy three-parameter BattleRules.start remains callable by the session", () => {
    let calls = 0;
    const legacy: BattleRules = {
      start(ext, setup, seed) {
        calls++;
        return { ext, state: { setup, seed } };
      },
      step(state) {
        return state;
      },
      done() {
        return null;
      },
    };
    const p = project([{ op: "battle", setup: { enemy: "slime" } }]);
    const session = createSession(p, 60, { battle: legacy });
    const state = step(session, startSession(p, session));

    expect(calls).toBe(1);
    expect(state.scene?.state).toMatchObject({ setup: { enemy: "slime" }, seed: expect.any(Number) });
  });

  test("a battle reward immediately drives the shop sell list and survives save/restore", () => {
    const p = project([
      { op: "battle", setup: null },
      { op: "shop", id: "chemist", goods: [{ item: "potion" }] },
      { op: "switch", id: "flow.done", value: true },
    ]);
    const session = createSession(p, 60, { battle: rewardRules });
    let state = step(session, startSession(p, session));
    expect(state.scene?.kind).toBe("battle");
    expect(() => createSessionSnapshot(session, state, 0)).toThrow(/no modal or scene open/);

    state = step(session, state); // complete and commit the reward
    expect(state.sw.items).toEqual({ potion: 2 });
    expect(state.sw.gold).toBe(50);
    state = step(session, state); // resume into the shop
    expect(shopModal(state).gold).toBe(50);

    state = step(session, state, DOWN); // buy row -> sell row
    state = step(session, state, CIRCLE); // enter sell list
    expect(shopModal(state).rows[0]).toMatchObject({ item: "potion", owned: 2, price: 5 });
    state = step(session, state, CIRCLE); // sell one
    expect(state.sw.items).toEqual({ potion: 1 });
    expect(state.sw.gold).toBe(55);
    expect(shopModal(state)).toMatchObject({ gold: 55 });

    state = step(session, state, CROSS); // sell list -> buy list
    state = step(session, state, CROSS); // leave shop
    state = step(session, state); // select the completed page
    const restored = restoreSessionEnvelope(
      session,
      encodeEnvelope(createSessionSnapshot(session, state, 0)),
    );
    expect(restored.sw.items).toEqual({ potion: 1 });
    expect(restored.sw.gold).toBe(55);
  });

  test("rewind refolds item and gold replacements from the clean session", () => {
    const p = project([
      { op: "wait", seconds: 2 / 60 },
      { op: "ext", call: "demo.reward", args: null },
      { op: "switch", id: "flow.done", value: true },
    ]);
    const controller = new AttractController(p, [], {
      hz: 60,
      attractEnabled: false,
      rewindSeconds: 4 / 60,
      extensions: {
        commands: {
          "demo.reward": () => ({ items: { potion: 3 }, gold: 25 }),
        },
      },
    });
    controller.startPlay();
    for (let frame = 0; frame < 10 && !controller.state.sw.switches["flow.done"]; frame++) {
      controller.step(0);
    }
    expect(controller.state.sw.switches["flow.done"]).toBe(true);
    const completed = structuredClone(controller.state);
    const completedLength = controller.length;

    controller.step(L);
    expect(controller.state.sw.items).toEqual({});
    expect(controller.state.sw.gold).toBe(0);
    for (let frame = controller.length; frame < completedLength; frame++) controller.step(0);
    expect(controller.state).toEqual(completed);
  });

  test("battle item and gold writeback has the same semantic state at every supported Hz", () => {
    const run = (hz: 60 | 30 | 20 | 4): string => {
      const p = project([
        { op: "battle", setup: null },
        { op: "switch", id: "flow.done", value: true },
      ]);
      p.system = { inventory: { maxPerItem: 1, maxKinds: 1 } };
      const session = createSession(p, hz, { battle: overflowingRewardRules });
      let state = startSession(p, session);
      for (let frame = 0; frame < hz; frame++) state = step(session, state);
      expect(state.sw.items).toEqual({ potion: 1 });
      expect(state.sw.gold).toBe(Number.MAX_SAFE_INTEGER);
      expect(state.sw.switches["flow.done"]).toBe(true);
      return JSON.stringify({ ...state, frame: 0 });
    };

    const reference = run(60);
    expect(run(60)).toBe(reference);
    for (const hz of [30, 20, 4] as const) expect(run(hz)).toBe(reference);
  });
});
