import { deepClone } from "../../src/engine/clone.ts";
import { rngNext } from "../../src/engine/interpreter.ts";
import type {
  BattleCompletion,
  BattleResult,
  BattleRules,
} from "../../src/engine/battle.ts";
import type { JsonValue } from "../../src/engine/types.ts";

export const TOY_ANIMATION_TICKS = 15;

interface ToySetup {
  skip?: boolean;
  playerHp?: number;
  enemyHp?: number;
  transfer?: {
    map: string;
    x: number;
    y: number;
    dir?: "down" | "left" | "up" | "right" | "keep";
    fade?: number;
  };
}

interface ToyState {
  rng: number;
  playerHp: number;
  enemyHp: number;
  phase: "choice" | "animate" | "done";
  animationTick: number;
  turn: number;
  pending: BattleResult | null;
  lastButtons: number;
  ext: JsonValue;
  transfer: ToySetup["transfer"] | null;
}

function record(value: JsonValue): Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}

function setupOf(value: JsonValue): ToySetup {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as unknown as ToySetup
    : {};
}

function stateOf(value: JsonValue): ToyState {
  return value as unknown as ToyState;
}

function stateJson(state: ToyState): JsonValue {
  return state as unknown as JsonValue;
}

function drawDamage(state: ToyState): number {
  const draw = rngNext(state.rng);
  state.rng = draw.next;
  return 2 + Math.floor(draw.value * 3);
}

/** Small, deliberately visible BattleRules fixture: 1v1 HP, seeded random
 * damage, a reference-tick animation cursor, and win/lose/escape outcomes. */
export const toyBattleRules: BattleRules = {
  start(ext, rawSetup, seed) {
    const setup = setupOf(rawSetup);
    if (setup.skip) return null;
    const nextExt: JsonValue = {
      ...record(ext),
      toyStarts: Number(record(ext).toyStarts ?? 0) + 1,
    };
    return {
      ext: nextExt,
      state: stateJson({
        rng: seed >>> 0,
        playerHp: setup.playerHp ?? 10,
        enemyHp: setup.enemyHp ?? 10,
        phase: "choice",
        animationTick: 0,
        turn: 0,
        pending: null,
        lastButtons: 0,
        ext: deepClone(nextExt),
        transfer: setup.transfer ? { ...setup.transfer } : null,
      }),
    };
  },

  step(rawState, input, ticks) {
    const state = deepClone(stateOf(rawState));
    state.lastButtons = input.buttons >>> 0;
    if (state.phase === "done") return stateJson(state);
    if (state.phase === "animate") {
      state.animationTick = Math.min(TOY_ANIMATION_TICKS, state.animationTick + ticks);
      if (state.animationTick >= TOY_ANIMATION_TICKS) {
        state.phase = state.pending === null ? "choice" : "done";
      }
      return stateJson(state);
    }
    if (input.cancelEdge) {
      state.pending = "escape";
      state.phase = "animate";
      state.animationTick = 0;
      return stateJson(state);
    }
    if (!input.confirmEdge) return stateJson(state);

    state.turn++;
    state.enemyHp = Math.max(0, state.enemyHp - drawDamage(state));
    if (state.enemyHp === 0) {
      state.pending = state.playerHp === 0 ? "draw" : "win";
    } else {
      state.playerHp = Math.max(0, state.playerHp - drawDamage(state));
      if (state.playerHp === 0) state.pending = "lose";
    }
    state.phase = "animate";
    state.animationTick = 0;
    return stateJson(state);
  },

  done(rawState): BattleCompletion | null {
    const state = stateOf(rawState);
    if (state.phase !== "done" || state.pending === null) return null;
    const previous = record(state.ext).toyResults;
    const results: JsonValue[] = Array.isArray(previous) ? [...previous] : [];
    results.push(state.pending);
    return {
      ext: { ...record(state.ext), toyResults: results },
      result: state.pending,
      writes: {
        "toy.result": state.pending,
        "toy.turns": state.turn,
      },
      switches: {
        [`toy.result.${state.pending}`]: true,
      },
      ...(state.transfer ? { transfer: state.transfer } : {}),
    };
  },
};

export function toyState(value: JsonValue): Readonly<ToyState> {
  return stateOf(value);
}
