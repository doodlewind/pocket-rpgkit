// src/ui/GameView.tsx — a complete game screen for an rpgkit-project/v1
// document: maps, transfers, moving NPCs and all four triggers over the
// pure session reducer (engine/session.ts). The entry passes the project
// and its baked asset manifest (GameAssets, cooked with
// tools/lib/chunks.ts); examples/sunstone mounts its three-map game.
// An entry that also passes an attract tape gets attract mode and
// takeover/rewind: engine/attract.ts owns the fold and derives every press
// edge from the button mask, so a demo frame and a live frame reach the
// reducer identically. Without a tape the view folds live input directly.
//
//   root (overflow-hidden, black)
//     world frame (clips to the CURRENT map or viewport on each axis and
//                 centers undersized axes for black letterboxing)
//       translated world      follows the player on oversized axes
//       ground chunks         row-major 512x512 images
//       upper/actor plane       only current-map characters; actors and
//                               clipped upper rows share (y,x) paint order
//     DialogBox               text / choices (themed, with portraits when
//                             the entry passes theme / faces)
//     fade overlay            black, opacity ramps for a faded transfer
//
// Desktop windows publish their live logical size (hostViewport /
// ui.__viewport). The frame polls it the same way apps/launcher does, so
// camera bounds and letterbox placement follow every resize. Positions and
// the world camera commit through one precompiled jump batch; chunk images
// stay mounted while the player walks.

import { batch, createSignal, onMount, Show, type Accessor } from "solid-js";
import { Image, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { createJumpBatch, type JumpBatch } from "@pocketjs/framework/animation";
import { createElement, setProp } from "@pocketjs/framework/renderer";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { useActions } from "@pocketjs/framework/actions";
import { simulationHz } from "@pocketjs/framework/clock";
import { BTN } from "@pocketjs/framework/input";
import { getOps, hostViewport } from "@pocketjs/framework/host";
import { followCamera } from "../engine/camera.ts";
import { deepClone } from "../engine/clone.ts";
import { centerOffset } from "../engine/viewport.ts";
import {
  createSession,
  fadeOpacity,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../engine/session.ts";
import { AttractController, type AttractStatus } from "../engine/attract.ts";
import { activePage, eventIdLess, modalChanged } from "../engine/interpreter.ts";
import type { CameraState, Facing, GameEvent, MapDef, Project, SpriteDef } from "../engine/types.ts";
import { PlayerSprite, playerImageKey } from "./PlayerSprite.tsx";
import { walkPose, type WalkPose } from "../engine/movement.ts";
import { TILE } from "../engine/tiles.ts";
import { DialogBox } from "./DialogBox.tsx";
import type { UiTheme } from "./theme.ts";
import type { Modal } from "../engine/interpreter.ts";
import type { GameAssets, NpcArt } from "./game-assets.ts";
import { AnimatedTiles, type AnimatedTilesStats } from "./AnimatedTiles.tsx";
import { ChunkLayer } from "./ChunkLayer.tsx";
import { StreamedChunkLayer, type StreamedChunkLayerStats } from "./StreamedChunkLayer.tsx";
import { actorDepth, OccludingUpperLayer } from "./OccludingUpperLayer.tsx";

type Sprites = Record<string, SpriteDef>;

// The PocketJS spec screen; console hosts render at exactly this size.
const SCREEN_W = 480;
const SCREEN_H = 272;

/** Whether a project SpriteDef ever paints a character (static or walker). */
function spritePaints(def: SpriteDef | undefined): boolean {
  return !!def && (def.kind === "walker" || !!def.src);
}

/** Events that ever show a character image, indexed in stable mount order. */
function collectSlots(
  maps: ReadonlyMap<string, MapDef>,
  sprites: Sprites,
  order: readonly string[],
): Map<string, GameEvent[]> {
  const byMap = new Map<string, GameEvent[]>();
  for (const mapId of order) {
    const map = maps.get(mapId);
    if (!map) continue;
    const slots: GameEvent[] = [];
    for (const ev of [...(map.events as GameEvent[])].sort((a, b) => (eventIdLess(a.id, b.id) ? -1 : a.id === b.id ? 0 : 1))) {
      if (!ev.pages.some((p) => spritePaints(p.sprite != null ? sprites[p.sprite!] : undefined))) continue;
      slots.push(ev);
    }
    byMap.set(mapId, slots);
  }
  return byMap;
}

interface NpcRenderSlot {
  node: NodeMirror;
  px: number;
  py: number;
}

type NpcFrame = [number, number, string, 16 | 32];

function depthOrder(points: readonly (readonly [number, number, ...unknown[]])[], worldWidth: number): string {
  const actors = points
    .map((_, index) => index)
    .sort((a, b) => actorDepth(points[a]![0]!, points[a]![1]!, worldWidth)
      - actorDepth(points[b]![0]!, points[b]![1]!, worldWidth) || a - b);
  return `${points.map((point) => Math.floor((Math.floor(point[1]!) - 2) / TILE))}|${actors}`;
}

function npcFrame(
  state: SessionState,
  event: GameEvent,
  sprites: Sprites,
  npcSrc: GameAssets["npcSrc"],
): NpcFrame {
  const active = activePage(event, state.sw, state.mapId, state.move.facing);
  const name = active?.page.sprite;
  const art: NpcArt | "" = name && spritePaints(sprites[name]) ? (npcSrc[name] ?? "") : "";
  const ch = state.chars.chars[event.id];
  return [
    ch ? ch.px : event.x * TILE,
    ch ? ch.py : event.y * TILE,
    art === "" || typeof art === "string"
      ? art
      : playerImageKey(walkPose(ch ? ch.phase : 0), ch ? ch.facing : 0, art),
    typeof art === "string" ? 16 : art.h,
  ];
}

function npcStyle(height: 16 | 32, depth: number) {
  return { posType: 1, insetL: 0, insetT: TILE - height, width: TILE, height, zIndex: depth };
}

/** The only mounted actor subtree. It owns enough stable image slots for any
 *  transfer destination and rebinds them without replacing native nodes. */
function CurrentMapActors(props: {
  slots: () => readonly GameEvent[];
  slotCount: number;
  worldWidth: number;
  sprites: Sprites;
  npcSrc: GameAssets["npcSrc"];
  player: GameAssets["player"];
  playerHeight: 16 | 32;
  pose: Accessor<WalkPose>;
  facing: Accessor<Facing>;
  state: () => SessionState;
  worldNode: () => NodeMirror | undefined;
  camera: () => CameraState;
}) {
  const initial = props.state();
  let slots = props.slots();
  const stride = props.worldWidth;
  const npcs: NpcRenderSlot[] = Array.from({ length: props.slotCount }, (_, index) => {
    const source = slots[index];
    const frame = source
      ? npcFrame(initial, source, props.sprites, props.npcSrc)
      : [0, 0, "", 16] as const;
    const node = createElement("image");
    setProp(node, "style", npcStyle(frame[3], actorDepth(frame[0], frame[1], stride)));
    setProp(node, "src", frame[2]);
    if (source) setProp(node, "debugName", `rpgkit-npc-${source.id}`);
    return { node, px: frame[0], py: frame[1] };
  });

  const [playerDepth, setPlayerDepth] = createSignal(actorDepth(initial.move.px, initial.move.py, stride));
  let hero: NodeMirror | undefined;
  let positions: JumpBatch | undefined;
  let { px, py } = initial.move;
  let { x: cx, y: cy } = props.camera();
  let order = depthOrder(
    [
      [initial.move.px, initial.move.py],
      ...npcs.slice(0, slots.length).map((npc) => [npc.px, npc.py] as const),
    ],
    stride,
  );

  const compilePositions = (): void => {
    const worldNode = props.worldNode();
    if (!worldNode || !hero) return;
    const entries: [NodeMirror, "translateX" | "translateY"][] = [
      [worldNode, "translateX"],
      [worldNode, "translateY"],
      [hero, "translateX"],
      [hero, "translateY"],
    ];
    for (let index = 0; index < slots.length; index++) {
      const npc = npcs[index]!;
      entries.push([npc.node, "translateX"], [npc.node, "translateY"]);
    }
    positions = createJumpBatch(entries);
    const state = props.state();
    const camera = props.camera();
    positions.set(0, -camera.x);
    positions.set(1, -camera.y);
    positions.set(2, state.move.px);
    positions.set(3, state.move.py);
    for (let index = 0; index < slots.length; index++) {
      const npc = npcs[index]!;
      positions!.set(4 + index * 2, npc.px);
      positions!.set(5 + index * 2, npc.py);
    }
    positions.commit();
    px = state.move.px;
    py = state.move.py;
    cx = camera.x;
    cy = camera.y;
  };

  onMount(compilePositions);

  onFrame(() => {
    const state = props.state();
    const next = props.slots();
    const transfer = next !== slots;
    if (transfer) slots = next;
    let moved = false;
    let dirty = transfer;
    const camera = props.camera();
    if (!transfer && (camera.x !== cx || camera.y !== cy)) {
      positions?.set(0, -camera.x);
      positions?.set(1, -camera.y);
      moved = true;
    }
    if (!transfer && (state.move.px !== px || state.move.py !== py)) {
      positions?.set(2, state.move.px);
      positions?.set(3, state.move.py);
      moved = true;
      dirty = true;
    }

    const touched = transfer ? npcs.length : slots.length;
    const frames: NpcFrame[] = [];
    for (let index = 0; index < touched; index++) {
      const source = slots[index];
      const frame: NpcFrame = source
        ? npcFrame(state, source, props.sprites, props.npcSrc)
        : [0, 0, "", 16];
      frames.push(frame);
      const npc = npcs[index]!;
      if (!transfer && source && (npc.px !== frame[0] || npc.py !== frame[1])) {
        positions?.set(4 + index * 2, frame[0]);
        positions?.set(5 + index * 2, frame[1]);
        moved = true;
        dirty = true;
      }
      npc.px = frame[0];
      npc.py = frame[1];
    }
    let reorder = transfer;
    if (dirty) {
      const nextOrder = depthOrder([
        [state.move.px, state.move.py],
        ...frames.slice(0, slots.length),
      ], stride);
      reorder ||= order !== nextOrder;
      order = nextOrder;
    }
    if (transfer) compilePositions();
    else if (moved) positions?.commit();
    if (reorder) setPlayerDepth(actorDepth(state.move.px, state.move.py, stride));
    for (let index = 0; index < touched; index++) {
      const frame = frames[index]!;
      const npc = npcs[index]!;
      const oldStyle = npc.node.domAttrs?.style as ReturnType<typeof npcStyle> | undefined;
      setProp(npc.node, "src", frame[2], npc.node.domAttrs?.src as string | undefined);
      setProp(npc.node, "style", npcStyle(frame[3],
        slots[index] && reorder ? actorDepth(frame[0], frame[1], stride) : oldStyle?.zIndex ?? 0), oldStyle);
      if (transfer) setProp(npc.node, "debugName", slots[index] ? `rpgkit-npc-${slots[index]!.id}` : undefined);
    }
    px = state.move.px;
    py = state.move.py;
    cx = camera.x;
    cy = camera.y;
  });

  return (
    <>
      <PlayerSprite
        pose={props.pose()}
        facing={props.facing()}
        frames={props.player}
        height={props.playerHeight}
        zIndex={playerDepth()}
        debugName="rpgkit-player"
        ref={(node) => {
          hero = node;
        }}
      />
      {npcs.map((npc) => npc.node as any)}
    </>
  );
}

// The view exposes its bare reducer state and camera to sim tests; the
// read-only globals carry no behavior.
declare global {
  // eslint-disable-next-line no-var
  var __rpgSessionState: SessionState | undefined;
  // eslint-disable-next-line no-var
  var __rpgGameCamera: CameraState | undefined;
}

export function GameView(props: {
  project: Project;
  assets: GameAssets;
  /** One u16 button mask per 60 Hz source frame (engine/attract-tape.ts).
   *  Present: attract/takeover/rewind drive the fold. Absent: live play. */
  attractTape?: readonly number[];
  /** DialogBox colours (ui/theme.ts); missing keys keep the kit default. */
  theme?: Partial<UiTheme>;
  /** DialogBox speaker portraits: NAME -> 64x64 image src. */
  faces?: Readonly<Record<string, string>>;
  /** DialogBox portrait column width (default 72). */
  faceWidth?: number;
  /** Optional diagnostics for streamed ground/upper residency. */
  onStreamStats?: (layer: "ground" | "upper", stats: StreamedChunkLayerStats) => void;
  /** Optional diagnostics for viewport-mounted animated tile sprites. */
  onAnimatedStats?: (layer: "below" | "above", stats: AnimatedTilesStats) => void;
}) {
  const { project, assets } = props;
  const stream = assets.stream;
  // The host rate selects how many fixed 60 Hz reference ticks each frame
  // folds. Time-bearing commands compile against that fixed reference.
  const hz = simulationHz();
  // The controller folds the published 60 Hz tape on its source timeline
  // and maps each host frame onto that timeline.
  const attract = props.attractTape ? new AttractController(project, [...props.attractTape], { hz }) : null;
  const session: Session = attract ? attract.getSession() : createSession(project, hz);
  let state: SessionState = attract ? attract.state : startSession(project, session);
  globalThis.__rpgSessionState = state;

  const mapsById = new Map(project.maps.map((map) => [map.id, map]));
  const sprites = (project.sprites ?? {}) as Sprites;
  const slotsByMap = collectSlots(mapsById, sprites, assets.order);
  const actorSlotCount = Math.max(0, ...[...slotsByMap.values()].map((group) => group.length));
  const worldWidth = Math.max(1, ...project.maps.map((map) => map.width * TILE));

  const [mapId, setMapId] = createSignal(state.mapId);
  const [pose, setPose] = createSignal<WalkPose>(walkPose(state.move.phase));
  const [facing, setFacing] = createSignal<Facing>(state.move.facing);
  const [modal, setModal] = createSignal<Modal | null>(null);
  const [demo, setDemo] = createSignal<AttractStatus | null>(null);
  // Live host viewport: console hosts omit ui.__viewport (spec screen),
  // desktop windows publish and resize it. Polled in onFrame like
  // apps/launcher, so no host-specific subscription lives in the view.
  // hostViewport() returns ui.__viewport BY REFERENCE and the wasm host
  // mutates that same object on resize (hosts/web/wasm-ops.js), so keep a
  // private snapshot: comparing the shared object's fields would see the
  // new numbers through the signal's old value and never emit, leaving the
  // Solid style effect unpainted.
  const vp0 = hostViewport(getOps());
  const [viewport, setViewport] = createSignal(
    vp0 ? { w: vp0.w, h: vp0.h } : { w: SCREEN_W, h: SCREEN_H },
  );
  const firstMapId = assets.order[0]!;
  const mapSize = (id: string): { w: number; h: number } => assets.world[id] ?? assets.world[firstMapId]!;
  const worldFrame = () => {
    const vp = viewport();
    const size = mapSize(mapId());
    const off = centerOffset(size, vp);
    return { x: off.x, y: off.y, w: Math.min(size.w, vp.w), h: Math.min(size.h, vp.h) };
  };
  const cameraFor = (st: SessionState): CameraState => {
    const vp = viewport();
    const size = mapSize(st.mapId);
    return followCamera(st.move.px, st.move.py, project.tileSize, st.move.facing, {
      worldW: size.w,
      worldH: size.h,
      viewportW: vp.w,
      viewportH: vp.h,
    });
  };
  let camera = cameraFor(state);
  globalThis.__rpgGameCamera = camera;
  const [fade, setFade] = createSignal(0);

  // Live play fires reducer edges from the action handlers. Under the
  // attract controller the legend is presentational: every press edge
  // (confirm, cancel, choices up/down) is derived from the folded button
  // mask (one unified input stream), so the view never fires edges itself.
  const edge = { confirm: false, cancel: false };
  const fire = (key: "confirm" | "cancel") =>
    attract
      ? undefined
      : () => {
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

  // The world camera and actor slots stay stable across transfers, so their
  // coordinates can share one precompiled position batch.
  let worldNode: NodeMirror | undefined;
  let prevButtons = 0;

  onFrame((buttons) => {
    const pressed = buttons & ~prevButtons;
    const upEdge = !!(pressed & BTN.UP);
    const downEdge = !!(pressed & BTN.DOWN);
    prevButtons = buttons;

    // Pick up a desktop window resize before this frame's layout reads the
    // centering offset (hostViewport stays the one runtime fact).
    const nextViewport = hostViewport(getOps());
    if (
      nextViewport &&
      (nextViewport.w !== viewport().w || nextViewport.h !== viewport().h)
    ) {
      setViewport({ w: nextViewport.w, h: nextViewport.h });
    }

    // Under attract the controller owns the fold: a tape mask or the live
    // mask, takeover, rewind and the idle attract entry all resolve inside it.
    const prev = state;
    let status: AttractStatus | null = null;
    if (attract) {
      const result = attract.step(buttons);
      state = result.state;
      status = result.status;
    } else {
      state = stepSession(session, state, {
        buttons,
        confirmEdge: edge.confirm,
        cancelEdge: edge.cancel,
        upEdge,
        downEdge,
      });
    }
    globalThis.__rpgSessionState = state;
    edge.confirm = false;
    edge.cancel = false;

    const nextCamera = cameraFor(state);
    camera = nextCamera;
    globalThis.__rpgGameCamera = camera;

    const op = fadeOpacity(state.fade);
    batch(() => {
      if (state.mapId !== prev.mapId || mapId() !== state.mapId) setMapId(state.mapId);
      // The walker pose is a pure function of the saved mover phase, so a
      // restore at any host frame offset renders identical pixels (R1202-2).
      const nextPose = walkPose(state.move.phase);
      if (nextPose !== pose()) setPose(nextPose);
      if (state.move.facing !== facing()) setFacing(state.move.facing);
      if (op !== fade()) setFade(op);
      const shownModal = attract ? attract.presentedModal() : state.interp.modal;
      setModal((m) => (modalChanged(m, shownModal) ? deepClone(shownModal) : m));
      if (status) {
        const st = status;
        setDemo((d) =>
          d === null ||
          d.phase !== st.phase ||
          d.demoFrame !== st.demoFrame ||
          d.controlNotice !== st.controlNotice ||
          d.rewindNotice !== st.rewindNotice ||
          d.idle !== st.idle
            ? { ...st }
            : d,
        );
      }
    });
  });

  return (
    <View class="w-full h-full overflow-hidden bg-black">
      {/* The frame clips each axis to min(map, viewport). Undersized axes
          are centered over the black root; oversized axes start at zero
          and the inner world translates by the clamped follow camera. */}
      <View
        class="absolute overflow-hidden"
        style={{
          posType: 1,
          insetL: worldFrame().x,
          insetT: worldFrame().y,
          width: worldFrame().w,
          height: worldFrame().h,
        }}
        debugName="rpgkit-world-frame"
      >
        <View
          class="absolute"
          nodeRef={(n) => {
            worldNode = n;
          }}
          debugName="rpgkit-world"
        >
          {stream ? (
            <StreamedChunkLayer
              mapId={mapId()}
              refs={stream.ground}
              columns={stream.columns}
              chunkPx={stream.chunkPx}
              camera={() => camera}
              viewport={() => viewport()}
              margin={stream.margin}
              loadBudget={stream.loadBudget}
              debugName="rpgkit-ground"
              onStats={(stats) => props.onStreamStats?.("ground", stats)}
            />
          ) : (
            <ChunkLayer
              names={assets.ground[mapId()] ?? assets.ground[firstMapId]!}
              columns={assets.chunkColumns[mapId()] ?? assets.chunkColumns[firstMapId] ?? 1}
              slots={assets.maxChunks}
              debugName="rpgkit-ground"
            />
          )}

          {assets.animated ? (
            <AnimatedTiles
              mapId={mapId()}
              tiles={assets.animated}
              above={false}
              camera={() => camera}
              viewport={() => viewport()}
              mapTiles={() => {
                const m = mapsById.get(mapId())!;
                return { w: m.width, h: m.height };
              }}
              debugName="rpgkit-anim-below"
              onStats={(stats) => props.onAnimatedStats?.("below", stats)}
            />
          ) : null}

          <OccludingUpperLayer
            mapId={mapId()}
            maps={mapsById}
            assets={assets}
            firstMapId={firstMapId}
            camera={() => camera}
            viewport={() => viewport()}
            debugName="rpgkit-actors"
            onStreamStats={(stats) => props.onStreamStats?.("upper", stats)}
            onAnimatedStats={(stats) => props.onAnimatedStats?.("above", stats)}
          >
            <CurrentMapActors
              slots={() => slotsByMap.get(state.mapId) ?? []}
              slotCount={actorSlotCount}
              worldWidth={worldWidth}
              sprites={sprites}
              npcSrc={assets.npcSrc}
              player={assets.player}
              playerHeight={assets.playerHeight ?? 16}
              pose={pose}
              facing={facing}
              state={() => state}
              worldNode={() => worldNode}
              camera={() => camera}
            />
          </OccludingUpperLayer>
        </View>
      </View>

      <DialogBox
        modal={modal}
        legend={actions.legend}
        theme={props.theme}
        faces={props.faces}
        faceWidth={props.faceWidth}
      />

      {/* D1/D2 demo overlay. In attract a small DEMO plate with the tape
          frame number sits in the top-right corner, away from the action.
          Takeover flashes "YOU HAVE CONTROL" for two seconds; L rewinds
          and flashes "REWIND". The overlay is presentation only — it
          emits no ops while hidden, and never mounts without a tape. */}
      <Show when={demo()?.phase === "attract"}>
        <View
          class="absolute flex-col items-end"
          style={{ posType: 1, insetT: 6, insetR: 8, bgColor: "#0b1626", opacity: 0.78 }}
          debugName="rpgkit-demo-badge"
        >
          <Text
            class="text-xs"
            style={{ textColor: "#ffe97a", lineHeight: 13, height: 13, insetL: 6, insetT: 2, insetR: 6 }}
          >
            {`DEMO ${String(demo()?.demoFrame ?? 0).padStart(3, "0")}/${demo()?.tapeFrames ?? 0}`}
          </Text>
        </View>
      </Show>
      <Show when={(demo()?.controlNotice ?? 0) > 0}>
        <View
          class="absolute flex-row justify-center"
          style={{ posType: 1, insetT: 18, insetL: 0, insetR: 0 }}
          debugName="rpgkit-control-notice"
        >
          <Text class="text-sm" style={{ textColor: "#ffe97a", lineHeight: 18, height: 18 }}>
            YOU HAVE CONTROL
          </Text>
        </View>
      </Show>
      <Show when={(demo()?.rewindNotice ?? 0) > 0}>
        <View
          class="absolute flex-row justify-center"
          style={{ posType: 1, insetT: 40, insetL: 0, insetR: 0 }}
          debugName="rpgkit-rewind-notice"
        >
          <Text class="text-sm" style={{ textColor: "#8ad0ff", lineHeight: 18, height: 18 }}>
            REWIND 3 SEC
          </Text>
        </View>
      </Show>

      <View
        class="absolute left-0 right-0 top-0 bottom-0"
        style={{ posType: 1, bgColor: "#000000", opacity: fade() }}
        debugName="rpgkit-fade"
      />
    </View>
  );
}
