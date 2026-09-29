// PocketJS bundle fixture for end-to-end event-model and QuickJS scan tests.

import { batch, createSignal } from "solid-js";
import { mount } from "@pocketjs/framework";
import { View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { simulationHz } from "@pocketjs/framework/clock";
import { BTN } from "@pocketjs/framework/input";
import { createChars } from "../../../src/engine/chars.ts";
import {
  createInterpState,
  createSwitchState,
  createWorld,
  stepInterp,
  type InterpState,
} from "../../../src/engine/interpreter.ts";
import {
  createSession,
  startSession,
  stepSession,
  type SessionState,
} from "../../../src/engine/session.ts";
import {
  createSnapshot,
  decodeEnvelopeText,
  encodeEnvelope,
} from "../../../src/engine/save.ts";
import { buildAreaScanMap, buildEventModelProject } from "./project.ts";

export interface EventModelFixtureApi {
  state(): SessionState;
  snapshot(): string;
  restore(envelope: string): void;
  bench(areas: boolean): void;
}

declare global {
  // eslint-disable-next-line no-var
  var __eventModelFixture: EventModelFixtureApi | undefined;
  // eslint-disable-next-line no-var
  var __eventModelBenchMode: boolean | undefined;
}

const scanWorld = createWorld(buildAreaScanMap());
const emptyWorld = createWorld(buildAreaScanMap(0));
const scanInput = {
  // area-000 covers (0,0)..(2,1), so every measured scan evaluates one
  // spatial candidate while the other 299 remain outside the indexed cells.
  playerCell: { x: 0, y: 0 },
  prevCell: { x: 0, y: 0 },
  facing: 0 as const,
};

function EventModelFixture() {
  const project = buildEventModelProject();
  const session = createSession(project, simulationHz());
  let state = startSession(project, session, createSwitchState({
    switches: { "local.stale": true },
    variables: { "local.stale": 99 },
  }));
  let prevButtons = 0;
  let benchState: InterpState = createInterpState();
  let benchAreas = true;

  const [playerX, setPlayerX] = createSignal(state.move.px);
  const [playerY, setPlayerY] = createSignal(state.move.py);
  const [npcX, setNpcX] = createSignal(-32);
  const [npcY, setNpcY] = createSignal(-32);
  const [status, setStatus] = createSignal("#334155");

  const publish = (): void => {
    const npc = state.chars.chars.scout;
    batch(() => {
      setPlayerX(state.move.px);
      setPlayerY(state.move.py);
      setNpcX(npc?.px ?? -32);
      setNpcY(npc?.py ?? -32);
      setStatus(
        state.sw.switches["transfer-cleared-locals"]
          ? "#22c55e"
          : state.interp.inputLocked
            ? "#ef4444"
            : state.sw.switches["parallel-ran-while-locked"]
              ? "#f59e0b"
              : "#334155",
      );
    });
  };

  globalThis.__eventModelBenchMode = false;
  globalThis.__eventModelFixture = {
    state: () => state,
    snapshot: () => encodeEnvelope(createSnapshot(state.mapId, state.move, state.interp, prevButtons)),
    restore: (envelope) => {
      const snap = decodeEnvelopeText(envelope);
      state = {
        frame: Math.floor(snap.interp.frame / session.ticksPerFrame),
        mapId: snap.map,
        sw: snap.interp.sw,
        move: snap.player,
        chars: createChars(),
        interp: snap.interp,
        fade: null,
        playerRoute: null,
      };
      prevButtons = snap.held;
      publish();
    },
    bench: (areas) => {
      globalThis.__eventModelBenchMode = true;
      benchAreas = areas;
      benchState = createInterpState();
    },
  };

  onFrame((buttons) => {
    if (globalThis.__eventModelBenchMode) {
      benchState = stepInterp(benchAreas ? scanWorld : emptyWorld, benchState, scanInput);
      return;
    }
    const pressed = buttons & ~prevButtons;
    state = stepSession(session, state, {
      buttons,
      confirmEdge: !!(pressed & BTN.CIRCLE),
      cancelEdge: !!(pressed & BTN.CROSS),
      upEdge: !!(pressed & BTN.UP),
      downEdge: !!(pressed & BTN.DOWN),
    });
    prevButtons = buttons;
    publish();
  });

  return (
    <View class="w-full h-full overflow-hidden bg-black">
      <View
        class="absolute w-[16] h-[16]"
        style={{ posType: 1, insetL: playerX(), insetT: playerY(), bgColor: "#38bdf8" }}
        debugName="event-model-player"
      />
      <View
        class="absolute w-[16] h-[16]"
        style={{ posType: 1, insetL: npcX(), insetT: npcY(), bgColor: "#e879f9" }}
        debugName="event-model-npc"
      />
      <View
        class="absolute w-[32] h-[16]"
        style={{ posType: 1, insetL: 176, insetT: 16, bgColor: status() }}
        debugName="event-model-status"
      />
    </View>
  );
}

mount(() => <EventModelFixture />);
