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
import { BFS_CELLS_PER_TICK } from "../../../src/engine/chars.ts";
import { buildPassage } from "../../../src/engine/passability.ts";
import { advancePathSearch, bfsPath, createPathSearch, type PathSearchState } from "../../../src/engine/pathfind.ts";
import type { Sheet } from "../../../src/engine/types.ts";
import {
  createSnapshot,
  decodeEnvelopeText,
  encodeEnvelope,
} from "../../../src/engine/save.ts";
import {
  buildAreaScanMap,
  buildConcurrentPathBenchProject,
  buildEventModelProject,
  buildPathBenchMap,
} from "./project.ts";

export interface EventModelFixtureApi {
  state(): SessionState;
  snapshot(): string;
  restore(envelope: string): void;
  /** Serialize the WHOLE live SessionState (player pixel phase, every
   *  character's mid-step route/path plan, the parked external fiber) so a
   *  save can be taken while a forced route is mid-tile and restored to a
   *  fold that matches the uninterrupted one. Unlike snapshot() this is not
   *  the safe-point slot envelope; it exists to prove mid-movement
   *  continuity of the pure reducers. */
  snapshotFull(): string;
  restoreFull(text: string): void;
  bench(areas: boolean): void;
  /** QuickJS pathfinding bench selector; null returns to gameplay. */
  benchPath(mode: null | "open" | "ten" | "incr" | "real-ten"): void;
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

// Pathfinding QuickJS bench: cooked once, reused every measured frame so
// the timed work is the BFS alone.
const PATH_SHEET: Sheet = { id: "tiles", cols: 1, rows: 1, pak: "tiles", defaultPassage: "pass" };
const PATH_SHEETS = new Map<string, Sheet>([["tiles", PATH_SHEET]]);
const pathTableOpen = buildPassage(buildPathBenchMap(false), PATH_SHEETS);
// Ten deterministically spread (start,goal) pairs across the open 100x100.
const PATH_PAIRS: Array<[number, number, number, number]> = Array.from({ length: 10 }, (_, i) => [
  (i * 7) % 100,
  (i * 13) % 100,
  (99 - ((i * 7) % 100) + 100) % 100,
  (99 - ((i * 13) % 100) + 100) % 100,
]);
/** null = area scan (legacy); "open" = one worst-case synchronous corner
 *  BFS/frame; "ten" = ten synchronous spread BFS/frame (upper bound);
 *  "incr" = ten FRAME-SPLIT searches, BFS_CELLS_PER_TICK cells each/frame
 *  (the real per-frame cost when ten NPCs pathfind at once). */
let pathBenchMode: null | "open" | "ten" | "incr" | "real-ten" = null;
// The ten live incremental searches, restarted as each reaches its goal.
let incrSearches: PathSearchState[] = [];
const realPathProject = buildConcurrentPathBenchProject();
const realPathSession = createSession(realPathProject);
let realPathState = startSession(realPathProject, realPathSession);

function resetRealPathBench(): void {
  realPathState = startSession(realPathProject, realPathSession);
  // First frame starts the autorun and installs all ten fire-and-forget
  // routes. Measured frames then enter the real session/character fold.
  realPathState = stepSession(realPathSession, realPathState, { buttons: 0 });
}

function pathBenchFrame(): void {
  if (pathBenchMode === "real-ten") {
    realPathState = stepSession(realPathSession, realPathState, { buttons: 0 });
    return;
  }
  if (pathBenchMode === "open") {
    // Corner to opposite corner: maximum Manhattan distance, visits all
    // 10,000 cells in the fixed-order search.
    bfsPath(pathTableOpen, 0, 0, 99, 99);
    return;
  }
  if (pathBenchMode === "ten") {
    for (const [sx, sy, gx, gy] of PATH_PAIRS) bfsPath(pathTableOpen, sx, sy, gx, gy);
    return;
  }
  // incr: advance each of the ten searches one slice; restart a finished
  // one so every measured frame carries steady-state slice work.
  if (incrSearches.length === 0) {
    incrSearches = PATH_PAIRS.map(([sx, sy, gx, gy]) => createPathSearch(pathTableOpen, sx, sy, gx, gy)!)
      .filter((s): s is PathSearchState => s !== null);
  }
  for (let i = 0; i < incrSearches.length; i++) {
    const res = advancePathSearch(incrSearches[i]!, pathTableOpen, BFS_CELLS_PER_TICK);
    if (res.done) {
      const [sx, sy, gx, gy] = PATH_PAIRS[i]!;
      incrSearches[i] = createPathSearch(pathTableOpen, sx, sy, gx, gy)!;
    }
  }
}

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
    snapshot: () => encodeEnvelope(createSnapshot(state.mapId, state.move, state.interp, prevButtons, state.ext, state.scene)),
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
        ext: snap.ext,
        scene: null,
      };
      prevButtons = snap.held;
      publish();
    },
    snapshotFull: () => JSON.stringify(state),
    restoreFull: (text) => {
      state = JSON.parse(text) as SessionState;
      publish();
    },
    bench: (areas) => {
      globalThis.__eventModelBenchMode = true;
      pathBenchMode = null;
      benchAreas = areas;
      benchState = createInterpState();
    },
    benchPath: (mode) => {
      globalThis.__eventModelBenchMode = false;
      pathBenchMode = mode;
      if (mode === "real-ten") resetRealPathBench();
    },
  };

  onFrame((buttons) => {
    if (pathBenchMode) {
      pathBenchFrame();
      return;
    }
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
