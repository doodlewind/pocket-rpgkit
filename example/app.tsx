// example/app.tsx — minimal PocketJS app proving pocket-rpgkit works.
//
// One 20x12-tile meadow (example/mini-project.ts), one ground Image, one
// upper Image, the player between them, a follow-less centered world frame
// (the map is smaller than the 480x272 viewport), and the DialogBox driven
// by the session reducer (stepSession). The save menu and NPC sprites from
// the sample game are omitted; the example's four events cover text,
// choices, touch, gold/item grants, a self-switch page change, and a
// parallel wait+se fiber.
//
// For deterministic host tests the app exposes globalThis.__rpgkitExample:
//   state()   — the current SessionState
//  .modal()   — the visible modal (accessor mirror)
//  .restore(snapshot-ish) not needed; the reducer can be driven directly in
//             unit tests. The wasm sim boots THIS bundle and hashes frames.

import { batch, createSignal, onMount } from "solid-js";
import { mount } from "@pocketjs/framework";
import { Image, View, type NodeMirror } from "@pocketjs/framework/components";
import { createJumpBatch, type JumpBatch } from "@pocketjs/framework/animation";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { useActions } from "@pocketjs/framework/actions";
import { simulationHz } from "@pocketjs/framework/clock";
import { BTN } from "@pocketjs/framework/input";
import { getOps, hostViewport } from "@pocketjs/framework/host";
import {
  createSession,
  startSession,
  stepSession,
  fadeOpacity,
  modalChanged,
  deepClone,
  walkPose,
  centerOffset,
  type Session,
  type SessionState,
  type Modal,
  type Facing,
  type WalkPose,
} from "../src/index.ts";
// In an app that depends on the published package these are
// "pocket-rpgkit" / "pocket-rpgkit/ui"; the in-repo example imports the
// sources relatively so the PocketJS pass-1 transform walks them.
import { PlayerSprite, DialogBox, type PlayerFrames } from "../src/ui/index.ts";
import {
  MEADOW_GROUND,
  MEADOW_UPPER,
  WORLD,
  PLAYER_IDLE,
  PLAYER_WALK_L,
  PLAYER_WALK_R,
} from "./assets-manifest.ts";
import { buildMiniProject } from "./mini-project.ts";

const FRAMES: PlayerFrames = { idle: PLAYER_IDLE, walkL: PLAYER_WALK_L, walkR: PLAYER_WALK_R };

declare global {
  // eslint-disable-next-line no-var
  var __rpgkitExample: {
    state(): SessionState;
  } | undefined;
}

const SCREEN_W = 480;
const SCREEN_H = 272;

export function ExampleApp() {
  const project = buildMiniProject();
  const session: Session = createSession(project, simulationHz());
  let state: SessionState = startSession(project, session);

  const [pose, setPose] = createSignal<WalkPose>(walkPose(state.move.phase));
  const [facing, setFacing] = createSignal<Facing>(state.move.facing);
  const [modal, setModal] = createSignal<Modal | null>(null);
  const [fade, setFade] = createSignal(0);
  const vp0 = hostViewport(getOps());
  const [viewport, setViewport] = createSignal(
    vp0 ? { w: vp0.w, h: vp0.h } : { w: SCREEN_W, h: SCREEN_H },
  );

  const edge = { confirm: false, cancel: false };
  const fire = (key: "confirm" | "cancel") => () => {
    edge[key] = true;
  };
  const actions = useActions(() => {
    const m = modal();
    if (m?.kind === "choices") {
      return {
        confirm: { label: "ok", run: fire("confirm") },
        ...(m.cancellable ? { back: { label: "back", run: fire("cancel") } } : {}),
      };
    }
    return { confirm: { label: m ? "next" : "talk", run: fire("confirm") } };
  });

  let playerNode: NodeMirror | undefined;
  let jumpBatch: JumpBatch | undefined;
  let prevButtons = 0;

  onMount(() => {
    if (!playerNode) throw new Error("rpgkit-example: player node did not mount");
    jumpBatch = createJumpBatch([
      [playerNode, "translateX"],
      [playerNode, "translateY"],
    ]);
    jumpBatch.set(0, state.move.px);
    jumpBatch.set(1, state.move.py);
    jumpBatch.commit();
  });

  const offset = () => {
    const vp = viewport();
    return centerOffset({ w: WORLD.w, h: WORLD.h }, vp);
  };

  onFrame((buttons) => {
    const pressed = buttons & ~prevButtons;
    const upEdge = !!(pressed & BTN.UP);
    const downEdge = !!(pressed & BTN.DOWN);
    prevButtons = buttons;

    const nextViewport = hostViewport(getOps());
    if (nextViewport && (nextViewport.w !== viewport().w || nextViewport.h !== viewport().h)) {
      setViewport({ w: nextViewport.w, h: nextViewport.h });
    }

    const prev = state;
    state = stepSession(session, state, {
      buttons,
      confirmEdge: edge.confirm,
      cancelEdge: edge.cancel,
      upEdge,
      downEdge,
    });
    edge.confirm = false;
    edge.cancel = false;

    if (state.move.px !== prev.move.px || state.move.py !== prev.move.py) {
      jumpBatch?.set(0, state.move.px);
      jumpBatch?.set(1, state.move.py);
      jumpBatch?.commit();
    }

    // No sprites are authored in the minimal project (every page uses
    // sprite:null), so no NPC image reconciliation is needed.

    batch(() => {
      const nextPose = walkPose(state.move.phase);
      if (nextPose !== pose()) setPose(nextPose);
      if (state.move.facing !== facing()) setFacing(state.move.facing);
      if (fadeOpacity(state.fade) !== fade()) setFade(fadeOpacity(state.fade));
      setModal((m) => (modalChanged(m, state.interp.modal) ? deepClone(state.interp.modal) : m));
    });
  });

  globalThis.__rpgkitExample = {
    state: () => state,
  };

  return (
    <View class="w-full h-full overflow-hidden bg-black">
      <View
        class="absolute overflow-hidden"
        style={{
          posType: 1,
          insetL: offset().x,
          insetT: offset().y,
          width: WORLD.w,
          height: WORLD.h,
        }}
        debugName="rpgkit-example-world"
      >
        <Image src={MEADOW_GROUND} class="absolute w-[512] h-[512]" style={{ posType: 1, insetL: 0, insetT: 0 }} debugName="rpgkit-example-ground" />
        <PlayerSprite
          pose={pose()}
          facing={facing()}
          frames={FRAMES}
          ref={(n) => {
            playerNode = n;
          }}
        />
        <Image src={MEADOW_UPPER} class="absolute w-[512] h-[512]" style={{ posType: 1, insetL: 0, insetT: 0 }} debugName="rpgkit-example-upper" />
      </View>
      <DialogBox modal={modal} legend={actions.legend} />
      <View
        class="absolute left-0 right-0 top-0 bottom-0"
        style={{ posType: 1, bgColor: "#000000", opacity: fade() }}
        debugName="rpgkit-example-fade"
      />
    </View>
  );
}

mount(() => <ExampleApp />);
