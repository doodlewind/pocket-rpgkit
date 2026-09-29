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
//       per-map NPC containers  one Image per character; the inactive
//                               map's container is display:none
//       player Sprite           the Sharm walker
//       upper chunks            star layer of the current map
//     DialogBox               text / choices (themed, with portraits when
//                             the entry passes theme / faces)
//     fade overlay            black, opacity ramps for a faded transfer
//
// Desktop windows publish their live logical size (hostViewport /
// ui.__viewport). The frame polls it the same way apps/launcher does, so
// camera bounds and letterbox placement follow every resize. Positions and
// the world camera commit through one precompiled jump batch; chunk images
// stay mounted while the player walks.

import { batch, createSignal, onMount, Show } from "solid-js";
import { Image, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { createJumpBatch, type JumpBatch } from "@pocketjs/framework/animation";
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
import { activePage, createSwitchState, eventIdLess, modalChanged } from "../engine/interpreter.ts";
import type { CameraState, Facing, GameEvent, MapDef, Project, SpriteDef } from "../engine/types.ts";
import { PlayerSprite, playerImageKey } from "./PlayerSprite.tsx";
import { walkPose, type WalkPose } from "../engine/movement.ts";
import { DialogBox } from "./DialogBox.tsx";
import type { UiTheme } from "./theme.ts";
import type { Modal } from "../engine/interpreter.ts";
import type { GameAssets, NpcArt } from "./game-assets.ts";
import { AnimatedTiles, type AnimatedTilesStats } from "./AnimatedTiles.tsx";
import { ChunkLayer } from "./ChunkLayer.tsx";
import { StreamedChunkLayer, type StreamedChunkLayerStats } from "./StreamedChunkLayer.tsx";

type Sprites = Record<string, SpriteDef>;

// The PocketJS spec screen; console hosts render at exactly this size.
const SCREEN_W = 480;
const SCREEN_H = 272;

interface NpcSlot {
  mapId: string;
  eventId: string;
  key: string;
  /** The art the slot first mounts with (a static image src or a walker). */
  art: NpcArt;
}

/** Whether a project SpriteDef ever paints a character (static or walker). */
function spritePaints(def: SpriteDef | undefined): boolean {
  return !!def && (def.kind === "walker" || !!def.src);
}

/** Resolve a page sprite key to its asset-cooked art for one slot. */
function slotArt(
  sprites: Sprites,
  npcSrc: GameAssets["npcSrc"],
  name: string | null | undefined,
): NpcArt | "" {
  if (!name) return "";
  const def = sprites[name];
  if (!spritePaints(def)) return "";
  return npcSrc[name] ?? "";
}

/** The image key for a character's current art, given its live facing and
 *  mover phase. A static image art is returned as-is; a walker picks the
 *  idle/step-L/step-R frame for the facing from the saved phase. */
function characterImage(art: NpcArt, facing: Facing, phase: number): string {
  if (typeof art === "string") return art;
  return playerImageKey(walkPose(phase), facing, art);
}

/** Events that ever show a character image, in stable mount order. The
 *  mounted art is the initially-active page's sprite (empty when that page
 *  has none); per-frame page selection swaps it later. */
function collectSlots(
  maps: readonly MapDef[],
  sprites: Sprites,
  npcSrc: GameAssets["npcSrc"],
  order: readonly string[],
): NpcSlot[] {
  const slots: NpcSlot[] = [];
  const initial = createSwitchState();
  for (const mapId of order) {
    const map = maps.find((m) => m.id === mapId)!;
    for (const ev of [...(map.events as GameEvent[])].sort((a, b) => (eventIdLess(a.id, b.id) ? -1 : a.id === b.id ? 0 : 1))) {
      if (!ev.pages.some((p) => spritePaints(p.sprite != null ? sprites[p.sprite!] : undefined))) continue;
      const active = activePage(ev, initial, mapId);
      slots.push({ mapId, eventId: ev.id, key: `${mapId}/${ev.id}`, art: slotArt(sprites, npcSrc, active?.page.sprite) });
    }
  }
  return slots;
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

  const slots = collectSlots(project.maps, (project.sprites ?? {}) as Sprites, assets.npcSrc, assets.order);
  const slotIndex = new Map(slots.map((s, i) => [s.key, i]));
  const slotsByMap = new Map<string, NpcSlot[]>();
  for (const slot of slots) {
    const group = slotsByMap.get(slot.mapId) ?? [];
    group.push(slot);
    slotsByMap.set(slot.mapId, group);
  }

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
  // Per-slot resolved image src and frame height. A walker's src also moves
  // with its live facing + mover phase, recomputed every frame below; a
  // 32px frame anchors its bottom to the occupied tile (insetT = 16-h).
  const initialNpcImage: Record<string, string> = {};
  const initialNpcHeight: Record<string, 16 | 32> = {};
  for (const slot of slots) {
    initialNpcImage[slot.key] = typeof slot.art === "string"
      ? slot.art
      : playerImageKey(0, 0, slot.art);
    initialNpcHeight[slot.key] = typeof slot.art === "string" ? 16 : slot.art.h;
  }
  const [npcImage, setNpcImage] = createSignal<Record<string, string>>(initialNpcImage);
  const [npcHeight, setNpcHeight] = createSignal<Record<string, 16 | 32>>(initialNpcHeight);
  // Mutable mirror of each slot's current art (string image or walker),
  // updated by page swaps outside a signal diff so the per-frame pose pass
  // can read it without re-deriving from project state.
  const slotArtCurrent: Record<string, NpcArt | ""> = {};
  for (const slot of slots) slotArtCurrent[slot.key] = slot.art;
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

  // Precompiled position batch: world camera, player, then two props per NPC.
  let worldNode: NodeMirror | undefined;
  const playerRefs: (NodeMirror | undefined)[] = [];
  const npcRefs: (NodeMirror | undefined)[] = slots.map(() => undefined);
  let jumpBatch: JumpBatch | undefined;
  let prevButtons = 0;

  onMount(() => {
    const entries: [NodeMirror, "translateX" | "translateY"][] = [];
    if (worldNode) {
      entries.push([worldNode, "translateX"], [worldNode, "translateY"]);
    }
    if (playerRefs[0]) {
      entries.push([playerRefs[0], "translateX"], [playerRefs[0], "translateY"]);
    }
    for (const ref of npcRefs) {
      if (ref) entries.push([ref, "translateX"], [ref, "translateY"]);
    }
    jumpBatch = createJumpBatch(entries);
    // Static initial framing so an idle first frame emits nothing.
    jumpBatch.set(0, -camera.x);
    jumpBatch.set(1, -camera.y);
    jumpBatch.set(2, state.move.px);
    jumpBatch.set(3, state.move.py);
    slots.forEach((slot, i) => {
      const ev = project.maps
        .find((m) => m.id === slot.mapId)!
        .events!.find((e) => e.id === slot.eventId)!;
      jumpBatch!.set(4 + i * 2, ev.x * 16);
      jumpBatch!.set(5 + i * 2, ev.y * 16);
    });
    jumpBatch.commit();
  });

  const mapsById = new Map(project.maps.map((m) => [m.id, m]));
  const slotAt = (mapIdV: string, eventId: string): number | undefined =>
    slotIndex.get(`${mapIdV}/${eventId}`);

  // Position of an NPC on a given state snapshot: its live pixels while its
  // map is current, otherwise its authored cell (a hidden container).
  const npcXY = (st: SessionState, slot: NpcSlot): { px: number; py: number } => {
    if (st.mapId === slot.mapId) {
      const ch = st.chars.chars[slot.eventId];
      if (ch) return { px: ch.px, py: ch.py };
    }
    const ev = mapsById.get(slot.mapId)!.events!.find((e) => e.id === slot.eventId)!;
    return { px: ev.x * 16, py: ev.y * 16 };
  };

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

    // Positions and camera: one batch commit if any value changed. Only
    // touched slots are rewritten, so a fully idle frame emits no batch.
    // After a rewind/reset `prev` is a LATER state, so every displaced node
    // differs and the same diff resyncs the whole playfield.
    let moved = false;
    if (state.move.px !== prev.move.px || state.move.py !== prev.move.py) {
      jumpBatch?.set(2, state.move.px);
      jumpBatch?.set(3, state.move.py);
      moved = true;
    }
    for (const slot of slots) {
      const a = npcXY(prev, slot);
      const b = npcXY(state, slot);
      if (a.px === b.px && a.py === b.py) continue;
      const i = slotIndex.get(slot.key)!;
      jumpBatch?.set(4 + i * 2, b.px);
      jumpBatch?.set(5 + i * 2, b.py);
      moved = true;
    }
    const nextCamera = cameraFor(state);
    if (nextCamera.x !== camera.x || nextCamera.y !== camera.y) {
      jumpBatch?.set(0, -nextCamera.x);
      jumpBatch?.set(1, -nextCamera.y);
      moved = true;
    }
    camera = nextCamera;
    globalThis.__rpgGameCamera = camera;
    if (moved || status?.loopReset || status?.rewound) jumpBatch?.commit();

    // Page-driven art swaps (chest lids, lit rune, gates) and, for walkers,
    // the per-frame pose chosen from the live CharState facing + mover
    // phase. An event whose active page loses its sprite paints nothing
    // (opened thorn/iron gates): image "" -> setImage(-1).
    const currentMap = project.maps.find((m) => m.id === state.mapId)!;
    const liveArt = slotArtCurrent;
    for (const ev of currentMap.events ?? []) {
      const idx = slotAt(state.mapId, ev.id);
      if (idx === undefined) continue;
      const active = activePage(ev, state.sw, state.mapId, state.move.facing);
      const want = slotArt((project.sprites ?? {}) as Sprites, assets.npcSrc, active?.page.sprite);
      const key = `${state.mapId}/${ev.id}`;
      if (liveArt[key] !== want) {
        liveArt[key] = want;
      }
    }
    // Resolve every CURRENT-map character's image from its live pose. A
    // walker has no CharState only before the first sync; fall back to the
    // down-facing idle frame then.
    let nextImage: Record<string, string> | null = null;
    let nextHeight: Record<string, 16 | 32> | null = null;
    const oldImage = npcImage();
    const oldHeight = npcHeight();
    for (const slot of slotsByMap.get(state.mapId) ?? []) {
      const key = slot.key;
      const art = liveArt[key] ?? "";
      const ch = state.chars.chars[slot.eventId];
      const image = art === ""
        ? ""
        : characterImage(art, ch ? ch.facing : 0, ch ? ch.phase : 0);
      const height: 16 | 32 = typeof art === "string" ? 16 : art.h;
      if (oldImage[key] !== image) {
        nextImage ??= { ...oldImage };
        nextImage[key] = image;
      }
      if (oldHeight[key] !== height) {
        nextHeight ??= { ...oldHeight };
        nextHeight[key] = height;
      }
    }

    const op = fadeOpacity(state.fade);
    batch(() => {
      if (state.mapId !== prev.mapId || mapId() !== state.mapId) setMapId(state.mapId);
      // The walker pose is a pure function of the saved mover phase, so a
      // restore at any host frame offset renders identical pixels (R1202-2).
      const nextPose = walkPose(state.move.phase);
      if (nextPose !== pose()) setPose(nextPose);
      if (state.move.facing !== facing()) setFacing(state.move.facing);
      if (nextImage) setNpcImage(nextImage);
      if (nextHeight) setNpcHeight(nextHeight);
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
                const m = project.maps.find((mm) => mm.id === mapId())!;
                return { w: m.width, h: m.height };
              }}
              debugName="rpgkit-anim-below"
              onStats={(stats) => props.onAnimatedStats?.("below", stats)}
            />
          ) : null}

          {assets.order.map((mid) => (
            <View
              class="absolute"
              style={{ posType: 1, insetL: 0, insetT: 0, display: mapId() === mid ? 0 : 1 }}
              debugName={`rpgkit-npcs-${mid}`}
            >
              {slots
                .filter((s) => s.mapId === mid)
                .map((slot) => {
                  const i = slotIndex.get(slot.key)!;
                  const h = npcHeight()[slot.key] ?? 16;
                  return (
                    <Image
                      src={npcImage()[slot.key]}
                      class="absolute"
                      style={{ posType: 1, insetL: 0, insetT: 16 - h, width: 16, height: h }}
                      nodeRef={(n) => {
                        npcRefs[i] = n;
                      }}
                    />
                  );
                })}
            </View>
          ))}

          <PlayerSprite
            pose={pose()}
            facing={facing()}
            frames={assets.player}
            height={assets.playerHeight ?? 16}
            ref={(n) => {
              playerRefs[0] = n;
            }}
          />

          {stream ? (
            <StreamedChunkLayer
              mapId={mapId()}
              refs={stream.upper}
              columns={stream.columns}
              chunkPx={stream.chunkPx}
              camera={() => camera}
              viewport={() => viewport()}
              margin={stream.margin}
              loadBudget={stream.loadBudget}
              debugName="rpgkit-upper"
              onStats={(stats) => props.onStreamStats?.("upper", stats)}
            />
          ) : (
            <ChunkLayer
              names={assets.upper[mapId()] ?? assets.upper[firstMapId]!}
              columns={assets.chunkColumns[mapId()] ?? assets.chunkColumns[firstMapId] ?? 1}
              slots={assets.maxChunks}
              debugName="rpgkit-upper"
            />
          )}

          {assets.animated ? (
            <AnimatedTiles
              mapId={mapId()}
              tiles={assets.animated}
              above={true}
              camera={() => camera}
              viewport={() => viewport()}
              mapTiles={() => {
                const m = project.maps.find((mm) => mm.id === mapId())!;
                return { w: m.width, h: m.height };
              }}
              debugName="rpgkit-anim-above"
              onStats={(stats) => props.onAnimatedStats?.("above", stats)}
            />
          ) : null}
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
