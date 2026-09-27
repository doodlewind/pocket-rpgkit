// examples/grow/GrowView.tsx — D6 rightward rule-grown settlement.
//
// The camera follows the advancing road across grass, mud, sand and snow.
// Rendering is a bounded tile window: only columns intersecting the live
// viewport plus one overscan column mount. A wider/longer world therefore
// never leaves its history resident in the native scene graph.

import { batch, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Image, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { createElement, detachNode, insertNode, setProp } from "@pocketjs/framework/renderer";
import { createJumpBatch, type JumpBatch } from "@pocketjs/framework/animation";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { simulationHz } from "@pocketjs/framework/clock";
import { getOps, hostViewport } from "@pocketjs/framework/host";
import { touches, BTN } from "@pocketjs/framework/input";
import { followCamera } from "../../src/engine/camera.ts";
import { deepClone } from "../../src/engine/clone.ts";
import {
  biomeAt, biomeBoundaryX, biomeTransitionKind, cameraXForState, createGrow, DEFAULT_PARAMS, naturalStampAt, wildernessTileAt,
  growStateHash, liveFrameAtTick, rememberGrowGridHash,
  type GrowParams, type GrowState,
} from "./grow.ts";
import { GrowTimeline } from "./grow-timeline.ts";
import { growProject } from "./grow-project.ts";
import { AttractController } from "../../src/engine/attract.ts";
import { modalChanged, type Modal } from "../../src/engine/interpreter.ts";
import { walkPose, type WalkPose } from "../../src/engine/movement.ts";
import { centerOffset } from "../../src/engine/viewport.ts";
import type { Facing, Project } from "../../src/engine/types.ts";
import { PlayerSprite } from "../../src/ui/PlayerSprite.tsx";
import { DialogBox } from "../../src/ui/DialogBox.tsx";
import { GROW_GROUND, GROW_NPC, GROW_PLAYER, GROW_TERRAIN, GROW_TERRAIN_BLOCK, GROW_UPPER } from "./assets-grow.ts";

const TILE = 16;
const PSP_W = 480;
const PSP_H = 272;
const TIMELINE_H = 16;
const AUTHORED_WORLD_H = DEFAULT_PARAMS.height * TILE;
const OVERSCAN = 1;
const NEXT_SEED = 0x9e37_79b9;
const DEFAULT_TOTAL_TICKS = 156;
const PREFILL_TICKS_PER_FRAME = 2;
const TERRAIN_BLOCK_TILES = 16;

type Mode = "grow" | "play";
interface OverlayCell { key: string; x: number; y: number; src: string; w?: number; h?: number }
interface Viewport { w: number; h: number }
interface TileBounds { x0: number; x1: number; y0: number; y1: number }

function SparseGridLayer(props: {
  state: () => GrowState;
  bounds: () => TileBounds;
  rowOffset: () => number;
  renderedRows: () => number;
  mode: () => Mode;
  timeline: () => GrowTimeline;
  layer: "ground" | "upper";
  onMounted: (count: number) => void;
}) {
  const root = createElement("view");
  setProp(root, "style", {
    posType: 1, insetL: 0, insetT: 0,
    width: props.state().params.width * TILE,
    height: props.renderedRows() * TILE,
  });
  setProp(root, "debugName", `rpgkit-grow-${props.layer}-layer`);
  const nodes = new Map<number, { node: NodeMirror; src: string; x: number; y: number }>();
  let previous: { seed: number; tick: number; mode: Mode; offset: number; bounds: TileBounds } | undefined;

  const sourceAt = (s: GrowState, x: number, y: number, offset: number): string | undefined => {
    const authoredY = y - offset;
    if (props.layer === "ground") {
      if (authoredY < 0 || authoredY >= s.params.height) return undefined;
      const cell = s.ground[authoredY * s.params.width + x]!;
      return cell < 0 ? undefined : GROW_GROUND[cell];
    }
    const grown = authoredY >= 0 && authoredY < s.params.height
      ? s.upper[authoredY * s.params.width + x]!
      : -1;
    const wrappedY = ((authoredY % s.params.height) + s.params.height) % s.params.height;
    const cell = grown >= 0 ? grown : wildernessTileAt(s, x, wrappedY);
    return GROW_UPPER[cell];
  };

  const inside = (b: TileBounds, x: number, y: number): boolean =>
    x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
  const syncCell = (s: GrowState, b: TileBounds, offset: number, x: number, y: number): void => {
    if (!inside(b, x, y)) return;
    const key = y * s.params.width + x;
    const src = sourceAt(s, x, y, offset);
    const mounted = nodes.get(key);
    if (!src) {
      if (mounted) { detachNode(root, mounted.node); nodes.delete(key); }
      return;
    }
    if (mounted) {
      if (mounted.src !== src) {
        setProp(mounted.node, "src", src, mounted.src);
        mounted.src = src;
      }
      return;
    }
    const node = createElement("image");
    setProp(node, "style", { posType: 1, insetL: x * TILE, insetT: y * TILE, width: TILE, height: TILE });
    setProp(node, "src", src);
    setProp(node, "debugName", `rpgkit-grow-${props.layer === "ground" ? "gcell" : "ucell"}`);
    insertNode(root, node);
    nodes.set(key, { node, src, x, y });
  };
  const syncAll = (s: GrowState, b: TileBounds, offset: number): void => {
    for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) syncCell(s, b, offset, x, y);
  };

  const sync = (): void => {
    const s = props.state();
    const b = props.bounds();
    const offset = props.rowOffset();
    const mode = props.mode();
    if (previous && previous.seed === s.params.seed && previous.tick === s.tick
      && previous.mode === mode && previous.offset === offset
      && previous.bounds.x0 === b.x0 && previous.bounds.x1 === b.x1
      && previous.bounds.y0 === b.y0 && previous.bounds.y1 === b.y1) return;

    for (const [key, mounted] of nodes) {
      if (mounted.x < b.x0 || mounted.x > b.x1 || mounted.y < b.y0 || mounted.y > b.y1) {
        detachNode(root, mounted.node);
        nodes.delete(key);
      }
    }

    const reset = !previous || previous.seed !== s.params.seed
      || previous.mode !== mode || previous.offset !== offset;
    if (reset) {
      for (const mounted of nodes.values()) detachNode(root, mounted.node);
      nodes.clear();
      syncAll(s, b, offset);
    } else if (previous) {
      // A camera move evaluates only newly visible rows/columns. Existing
      // cells keep their nodes and texture bindings.
      for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) {
        if (!inside(previous.bounds, x, y)) syncCell(s, b, offset, x, y);
      }
      // A timeline jump evaluates only cells whose authored layers changed
      // between the two ticks, in either direction.
      if (s.tick !== previous.tick && mode === "grow") {
        const first = Math.min(s.tick, previous.tick) + 1;
        const last = Math.max(s.tick, previous.tick);
        let complete = true;
        for (let tick = first; tick <= last; tick++) {
          const snapshot = props.timeline().snapshot(tick);
          if (!snapshot) { complete = false; break; }
          for (const edit of snapshot.edits) {
            if (props.layer === "ground" && edit.layer !== "ground") continue;
            if (props.layer === "upper" && edit.layer === "road") continue;
            const x = edit.index % s.params.width;
            const y = Math.floor(edit.index / s.params.width) + offset;
            syncCell(s, b, offset, x, y);
            // One edited tile can clear a complete two-by-three tree silhouette.
            // Refresh those art neighbors without changing timeline storage.
            if (props.layer === "upper") {
              const whole = naturalStampAt(s.params, x, y - offset);
              if (whole) {
                for (let dy = 0; dy < whole.h; dy++) for (let dx = 0; dx < whole.w; dx++) syncCell(s, b, offset, whole.x + dx, whole.y + offset + dy);
              }
            }
          }
        }
        if (!complete) syncAll(s, b, offset);
      }
    }
    previous = { seed: s.params.seed, tick: s.tick, mode, offset, bounds: { ...b } };
    props.onMounted(nodes.size);
  };

  sync();
  onFrame(sync);
  onCleanup(() => {
    for (const mounted of nodes.values()) detachNode(root, mounted.node);
    nodes.clear();
  });
  return root as unknown as ReturnType<typeof View>;
}

declare global {
  // eslint-disable-next-line no-var
  var __rpgGrowState: {
    mode: Mode; tick: number; total: number; auto: boolean; seed: number; hash: string;
    cameraX: number; frontierX: number; mounted: number; visibleX0: number; visibleX1: number;
    scrub?: { seekCount: number; timelineStepCalls: number; timelineSeeks: number };
  } | undefined;
  // eslint-disable-next-line no-var
  var __rpgSessionState: import("../../src/engine/session.ts").SessionState | undefined;
}

function PlayLayer(props: {
  project: Project; hz: number; viewport: () => Viewport;
  onCamera: (x: number, y: number) => void; onBack: () => void;
  onModal: (m: Modal | null) => void; onNotice: (n: number) => void;
}) {
  const project = props.project;
  const attract = new AttractController(project, [], { hz: props.hz, attractEnabled: false, onSelect: props.onBack });
  attract.startPlay();
  let state = attract.state;
  globalThis.__rpgSessionState = state;
  const map = project.maps[0]!;
  const worldW = map.width * TILE;
  const npcIds = (map.events ?? []).filter((e) => e.id.startsWith("villager-")).map((e) => e.id);
  const authored = new Map((map.events ?? []).map((e) => [e.id, { x: e.x * TILE, y: e.y * TILE }]));
  const [pose, setPose] = createSignal<WalkPose>(0);
  const [facing, setFacing] = createSignal<Facing>(0);
  let modal: Modal | null = null;
  let playerRef: NodeMirror | undefined;
  const npcPosition = npcIds.map((id) => createSignal(authored.get(id)!));
  const positionOf = (id: string, index: number, st = state): { x: number; y: number } => {
    const live = st.chars.chars[id];
    return live ? { x: live.px, y: live.py } : authored.get(id)!;
  };
  const idsInWindow = (st: typeof state, cameraX: number, cameraY: number): string[] => {
    const vp = props.viewport();
    return npcIds.filter((id, i) => {
      const p = positionOf(id, i, st);
      return p.x >= cameraX - TILE && p.x <= cameraX + vp.w + TILE
        && p.y >= cameraY - TILE && p.y <= cameraY + vp.h + TILE;
    });
  };
  const [visibleNpcIds, setVisibleNpcIds] = createSignal(idsInWindow(state, 0, 0));
  let jumpBatch: JumpBatch | undefined;
  onMount(() => {
    const entries: [NodeMirror, "translateX" | "translateY"][] = [];
    if (playerRef) entries.push([playerRef, "translateX"], [playerRef, "translateY"]);
    jumpBatch = createJumpBatch(entries);
    jumpBatch.set(0, state.move.px); jumpBatch.set(1, state.move.py);
    jumpBatch.commit();
  });
  onFrame((buttons) => {
    const prev = state;
    const result = attract.step(buttons);
    state = result.state;
    globalThis.__rpgSessionState = state;
    const vp = props.viewport();
    const cam = followCamera(state.move.px, state.move.py, TILE, state.move.facing, {
      worldW: Math.max(worldW, vp.w), worldH: Math.max(AUTHORED_WORLD_H, vp.h),
    });
    // followCamera uses the portable 480x272 focus constants. Adjust the
    // target by half the live viewport delta while retaining the proven
    // camera clamp and center behavior.
    const cameraX = Math.max(0, Math.min(worldW - vp.w, cam.x - (vp.w - PSP_W) / 2));
    const cameraY = Math.max(0, cam.y - (vp.h - PSP_H) / 2);
    props.onCamera(cameraX, cameraY);
    let moved = false;
    if (state.move.px !== prev.move.px || state.move.py !== prev.move.py) {
      jumpBatch?.set(0, state.move.px); jumpBatch?.set(1, state.move.py); moved = true;
    }
    for (let i = 0; i < npcIds.length; i++) {
      const id = npcIds[i]!; const a = prev.chars.chars[id]; const b = state.chars.chars[id];
      const fallback = authored.get(id)!;
      const ax = a?.px ?? fallback.x, ay = a?.py ?? fallback.y;
      const bx = b?.px ?? fallback.x, by = b?.py ?? fallback.y;
      if (ax !== bx || ay !== by) npcPosition[i]![1]({ x: bx, y: by });
    }
    if (moved || result.status.rewound) jumpBatch?.commit();
    const visible = idsInWindow(state, cameraX, cameraY);
    if (visible.length !== visibleNpcIds().length || visible.some((id, i) => id !== visibleNpcIds()[i])) {
      setVisibleNpcIds(visible);
    }
    batch(() => {
      const p = walkPose(state.move.phase); if (p !== pose()) setPose(p);
      if (state.move.facing !== facing()) setFacing(state.move.facing);
      if (modalChanged(modal, state.interp.modal)) modal = deepClone(state.interp.modal);
      props.onModal(modal); props.onNotice(result.status.rewindNotice);
    });
  });
  return <>
    <For each={visibleNpcIds()}>{(id) => {
      const i = npcIds.indexOf(id);
      return <Image src={GROW_NPC.villager} class="absolute w-[16] h-[16]" style={{ posType: 1, insetL: npcPosition[i]![0]().x, insetT: npcPosition[i]![0]().y }} debugName="rpgkit-grow-npc" />;
    }}</For>
    <PlayerSprite pose={pose()} facing={facing()} frames={GROW_PLAYER} ref={(n) => { playerRef = n; }} />
  </>;
}

export function GrowView() {
  const hz = simulationHz();
  const initialViewport = hostViewport(getOps());
  const [viewport, setViewport] = createSignal<Viewport>(initialViewport ? { ...initialViewport } : { w: PSP_W, h: PSP_H });
  let grow = createGrow(DEFAULT_PARAMS);
  let params: GrowParams = grow.params;
  let timeline = new GrowTimeline(params, grow);
  let total = DEFAULT_TOTAL_TICKS;
  let auto = true;
  let mode: Mode = "grow";
  let mounted = 0;
  let growHash = timeline.hash(grow);
  let seekCount = 0;
  let scrubActive = false;
  let groundMounted = 0;
  let upperMounted = 0;
  const [g, setG] = createSignal(grow, { equals: (a, b) =>
    a.tick === b.tick && a.cameraX === b.cameraX && a.params.seed === b.params.seed
  });
  const [modeSig, setModeSig] = createSignal<Mode>("grow");
  const [autoSig, setAutoSig] = createSignal(true);
  const [seedSig, setSeedSig] = createSignal(params.seed);
  const [playEpoch, setPlayEpoch] = createSignal(0);
  const [playDone, setPlayDone] = createSignal(grow);
  const [playProject, setPlayProject] = createSignal<Project>();
  const [playModal, setPlayModal] = createSignal<Modal | null>(null);
  const [playNotice, setPlayNotice] = createSignal(0);
  const [playCamX, setPlayCamX] = createSignal(0);
  const [playCamY, setPlayCamY] = createSignal(0);
  const itemCache = new Map<string, OverlayCell>();

  const fieldH = () => Math.max(TILE, viewport().h - (modeSig() === "grow" ? TIMELINE_H : 0));
  const activeWidthTiles = () => modeSig() === "play" ? playProject()!.maps[0]!.width : params.width;
  const renderedRows = () => modeSig() === "grow" ? Math.max(params.height, Math.ceil(fieldH() / TILE)) : params.height;
  const renderedWorldH = () => renderedRows() * TILE;
  const authoredRowOffset = () => modeSig() === "grow" ? Math.floor((renderedRows() - params.height) / 2) : 0;
  const activeWorldSize = () => ({ w: activeWidthTiles() * TILE, h: renderedWorldH() });
  const growCamY = () => fieldH() < AUTHORED_WORLD_H ? Math.floor((AUTHORED_WORLD_H - fieldH()) / 2) : 0;
  const cameraLead = () => modeSig() === "grow" ? Math.max(params.cameraLeadPx, viewport().w * 0.6) : params.cameraLeadPx;
  const cameraX = () => modeSig() === "grow" ? g().cameraX : playCamX();
  const cameraY = () => modeSig() === "grow" ? growCamY() : playCamY();
  const growCameraX = () => Math.max(0, g().cameraX + params.cameraLeadPx - cameraLead());
  const visibleBounds = createMemo(() => {
    const vp = viewport();
    const presentedCameraX = modeSig() === "grow"
      ? growCameraX()
      : cameraX();
    const x0 = Math.max(0, Math.floor(presentedCameraX / TILE) - OVERSCAN);
    const x1 = Math.min(activeWidthTiles() - 1, Math.floor((presentedCameraX + vp.w - 1) / TILE) + OVERSCAN);
    const y0 = Math.max(0, Math.floor(cameraY() / TILE) - OVERSCAN);
    const y1 = Math.min(renderedRows() - 1, Math.floor((cameraY() + fieldH() - 1) / TILE) + OVERSCAN);
    return { x0, x1, y0, y1 };
  }, undefined, { equals: (a, b) => a?.x0 === b.x0 && a.x1 === b.x1 && a.y0 === b.y0 && a.y1 === b.y1 });
  const publish = () => {
    const b = visibleBounds();
    const timelineStats = timeline.stats();
    globalThis.__rpgGrowState = {
      mode, tick: grow.tick, total, auto, seed: params.seed, hash: growHash, cameraX: grow.cameraX,
      frontierX: grow.roadFrontierX, mounted, visibleX0: b.x0, visibleX1: b.x1,
      ...(scrubActive ? { scrub: { seekCount, timelineStepCalls: timelineStats.stepCalls, timelineSeeks: timelineStats.seeks } } : {}),
    };
  };

  const itemFor = (key: string, x: number, y: number, src: string): OverlayCell => {
    const old = itemCache.get(key);
    if (old?.src === src) return old;
    const next = { key, x, y, src }; itemCache.set(key, next); return next;
  };
  const active = () => modeSig() === "play" ? playDone() : g();
  const visiblePeople = createMemo(active, undefined, { equals: (a, b) =>
    a?.villagers === b.villagers && a.params === b.params
  });
  const terrainBlocks = (): OverlayCell[] => {
    const { x0, x1, y0, y1 } = visibleBounds();
    const out: OverlayCell[] = [];
    const bx0 = Math.floor(x0 / TERRAIN_BLOCK_TILES);
    const bx1 = Math.floor(x1 / TERRAIN_BLOCK_TILES);
    const by0 = Math.floor(y0 / TERRAIN_BLOCK_TILES);
    const by1 = Math.floor(y1 / TERRAIN_BLOCK_TILES);
    for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
      const x = bx * TERRAIN_BLOCK_TILES;
      // Default biome bands are two blocks wide. Jagged boundary cells are
      // painted by terrainSeams over this rectangular fill.
      const biome = Math.floor(x / params.biomeBandWidth) % 4;
      out.push(itemFor(`tb:${bx}:${by}`, x, by * TERRAIN_BLOCK_TILES, GROW_TERRAIN_BLOCK[biome]!));
    }
    return out;
  };
  const terrainSeams = (): OverlayCell[] => {
    seedSig();
    const { x0, x1, y0, y1 } = visibleBounds(); const out: OverlayCell[] = [];
    const firstBoundary = Math.max(1, Math.floor((x0 - 2) / params.biomeBandWidth));
    const lastBoundary = Math.ceil((x1 + 2) / params.biomeBandWidth);
    for (let boundary = firstBoundary; boundary <= lastBoundary; boundary++) for (let y = y0; y <= y1; y++) {
      const authoredY = ((y - authoredRowOffset()) % params.height + params.height) % params.height;
      const center = boundary * params.biomeBandWidth;
      const edge = biomeBoundaryX(params, boundary, authoredY);
      for (let x = Math.max(x0, Math.min(center, edge)); x <= Math.min(x1, Math.max(center, edge + 2)); x++) {
        const biome = biomeAt(params, x, authoredY);
        const kind = biomeTransitionKind(params, x, authoredY);
        const nominalBiome = Math.floor(x / params.biomeBandWidth) % 4;
        if (kind === "fill" && biome === nominalBiome) continue;
        out.push(itemFor(`ts:${x}:${y}`, x, y, GROW_TERRAIN[biome]![kind]));
      }
    }
    return out;
  };
  const villagerCells = (): OverlayCell[] => {
    if (modeSig() !== "grow") return [];
    const b = visibleBounds(), s = visiblePeople();
    return s.villagers.filter((v) => v.x >= b.x0 && v.x <= b.x1 && v.y + authoredRowOffset() >= b.y0 && v.y + authoredRowOffset() <= b.y1).map((v) => itemFor(`v:${v.house}`, v.x, v.y + authoredRowOffset(), GROW_NPC.villager));
  };
  const visibleTerrainBlocks = createMemo(terrainBlocks);
  const visibleTerrainSeams = createMemo(terrainSeams);
  const visibleVillagers = createMemo(villagerCells);
  const refreshMounted = () => { mounted = visibleTerrainBlocks().length + visibleTerrainSeams().length + groundMounted + upperMounted + visibleVillagers().length; };
  const pruneItemCache = () => {
    const b = visibleBounds();
    for (const [key, cell] of itemCache) {
      if (cell.x < b.x0 || cell.x > b.x1 || cell.y < b.y0 || cell.y > b.y1) itemCache.delete(key);
    }
  };
  const syncProject = () => { const done = grow.phase === "done" ? grow : timeline.done(); setPlayDone(done); setPlayProject(growProject(done)); };
  const seekTo = (tick: number) => {
    if (mode !== "grow") return;
    scrubActive = true; seekCount++;
    const k = Math.max(0, Math.min(total, Math.round(tick)));
    const canonicalFrame = liveFrameAtTick(params, hz, k);
    if (k === grow.tick && !auto && grow.frame === canonicalFrame && grow.cameraX === grow.cameraFromX) return;
    const cached = timeline.at(k, grow); growHash = timeline.hash(cached);
    grow = { ...cached, hz, frame: canonicalFrame };
    auto = false; batch(() => { setG(grow); setAutoSig(false); }); refreshMounted(); publish();
  };
  const advanceLiveFrame = (): GrowState => {
    const nextFrame = grow.frame + 1;
    const period = grow.params.tickSeconds * hz;
    const due = grow.phase === "done" ? grow.tick : Math.max(0, Math.floor(nextFrame / period + 1e-9));
    const target = Math.min(due, timeline.furthestTick);
    let metadata = grow;
    for (let tick = grow.tick + 1; tick <= target; tick++) {
      const snapshot = timeline.snapshot(tick)!;
      for (const edit of snapshot.edits) {
        const grid = edit.layer === "ground" ? grow.ground : edit.layer === "upper" ? grow.upper : grow.road;
        grid[edit.index] = edit.after;
      }
      metadata = snapshot.state;
    }
    const next = { ...metadata, ground: grow.ground, upper: grow.upper, road: grow.road,
      hz, frame: nextFrame, grew: target !== grow.tick };
    next.cameraX = cameraXForState(next);
    const snapshot = timeline.snapshot(target);
    if (snapshot) rememberGrowGridHash(next, snapshot.gridHash);
    return next;
  };
  const changeSeed = () => {
    grow = createGrow({ ...params, seed: (params.seed + NEXT_SEED) >>> 0 }); params = grow.params; timeline = new GrowTimeline(params, grow); total = DEFAULT_TOTAL_TICKS; growHash = timeline.hash(grow); auto = true; scrubActive = false; seekCount = 0; itemCache.clear();
    batch(() => { setG(grow); setAutoSig(true); setSeedSig(params.seed); setPlayDone(grow); setPlayProject(undefined); setPlayCamX(0); setPlayCamY(0); }); refreshMounted(); publish();
  };
  const enterPlay = () => {
    if (grow.phase !== "done") return; mode = "play"; syncProject(); setPlayCamX(0); setPlayCamY(0); setPlayModal(null); setPlayNotice(0); setModeSig("play"); setPlayEpoch((e) => e + 1); refreshMounted(); publish();
  };
  const backToGrow = () => { mode = "grow"; setPlayModal(null); setPlayNotice(0); setModeSig("grow"); refreshMounted(); publish(); };

  let pointerDown = false;
  interface MouseLine { t: string; x: number | null; y: number | null; d: boolean }
  const mouseEvents: MouseLine[] = [];
  const stripTick = (x: number) => Math.round((Math.max(0, Math.min(viewport().w, x)) / viewport().w) * total);
  const pollPointer = (): number | undefined => {
    if (mode !== "grow") return undefined;
    const ops = getOps(); const lines = ops.svcPoll?.();
    if (lines) for (const line of lines.split("\n")) if (line) try { const m = JSON.parse(line) as MouseLine; if (m.t === "mouse") mouseEvents.push(m); } catch {}
    const y0 = viewport().h - TIMELINE_H;
    let pending: number | undefined;
    for (const c of touches()) if (c.y >= y0) pending = stripTick(c.x);
    for (const ev of mouseEvents.splice(0)) {
      if (ev.x === null || ev.y === null) { if (!ev.d) pointerDown = false; continue; }
      if (ev.d && (ev.y >= y0 || pointerDown)) { pointerDown = true; pending = stripTick(ev.x); }
      else if (!ev.d) pointerDown = false;
    }
    return pending;
  };

  let prevButtons = 0, heldDir = 0, heldFrames = 0;
  onFrame((buttons) => {
    const nextVp = hostViewport(getOps());
    if (nextVp && (nextVp.w !== viewport().w || nextVp.h !== viewport().h)) setViewport({ ...nextVp });
    if (mode === "play") { refreshMounted(); publish(); prevButtons = buttons; return; }
    if (!timeline.complete) {
      timeline.prefillTo(Math.min(total, timeline.furthestTick + PREFILL_TICKS_PER_FRAME));
      if (timeline.complete) total = timeline.furthestTick;
    }
    const pointerTick = pollPointer(); if (pointerTick !== undefined) seekTo(pointerTick);
    const pressed = buttons & ~prevButtons;
    let dir = 0; if (buttons & BTN.LEFT) dir = -1; else if (buttons & BTN.RIGHT) dir = 1;
    if (dir !== heldDir) { heldDir = dir; heldFrames = 0; if (dir) seekTo(grow.tick + dir); }
    else if (dir && ++heldFrames > 12 && heldFrames % 4 === 0) seekTo(grow.tick + dir);
    if (pressed & BTN.TRIANGLE) { auto = !auto; if (auto && grow.phase === "done") { grow = createGrow(params); growHash = timeline.hash(grow); itemCache.clear(); } batch(() => { setAutoSig(auto); setG(grow); }); }
    if (pressed & BTN.SQUARE) changeSeed();
    if ((pressed & BTN.CIRCLE) && grow.phase === "done") enterPlay();
    if (auto && grow.phase !== "done") {
      const before = grow.tick; grow = advanceLiveFrame();
      growHash = growStateHash(grow);
      // cameraX changes between action boundaries, so publish every frame.
      if (grow.tick !== before || grow.cameraX !== g().cameraX) setG(grow);
      if (grow.phase === "done") { auto = false; batch(() => { setG(grow); setAutoSig(false); }); }
    }
    refreshMounted(); pruneItemCache(); publish(); prevButtons = buttons;
  });

  const timelineFill = () => total ? (g().tick / total) * viewport().w : 0;
  const seedHex = () => seedSig().toString(16).toUpperCase().padStart(8, "0");
  const worldOffset = () => centerOffset(activeWorldSize(), { w: viewport().w, h: fieldH() });
  const worldX = () => worldOffset().x - (modeSig() === "grow" ? growCameraX() : cameraX());
  const worldY = () => worldOffset().y - cameraY();

  return <View class="w-full h-full overflow-hidden bg-black">
    <View class="absolute overflow-hidden" style={{ posType: 1, insetL: 0, insetT: 0, width: viewport().w, height: viewport().h }} debugName="rpgkit-grow-frame">
      <View class="absolute" style={{ posType: 1, insetL: worldX(), insetT: worldY() }} debugName="rpgkit-grow-camera">
        <For each={visibleTerrainBlocks()}>{(c) => <Image src={c.src} class="absolute w-[256] h-[256]" style={{ posType: 1, insetL: c.x * TILE, insetT: c.y * TILE }} debugName="rpgkit-grow-terrain-block" />}</For>
        <For each={visibleTerrainSeams()}>{(c) => <Image src={c.src} class="absolute w-[16] h-[16]" style={{ posType: 1, insetL: c.x * TILE, insetT: c.y * TILE }} debugName="rpgkit-grow-terrain-seam" />}</For>
        <SparseGridLayer state={active} bounds={visibleBounds} rowOffset={authoredRowOffset} renderedRows={renderedRows} mode={modeSig} timeline={() => timeline} layer="ground" onMounted={(count) => { groundMounted = count; refreshMounted(); publish(); }} />
        <For each={visibleVillagers()}>{(c) => <Image src={c.src} class="absolute w-[16] h-[16]" style={{ posType: 1, insetL: c.x * TILE, insetT: c.y * TILE }} debugName="rpgkit-grow-gvillager" />}</For>
        <Show when={playEpoch() > 0 && modeSig() === "play"} keyed>
          <PlayLayer project={playProject()!} hz={hz} viewport={viewport} onCamera={(x, y) => { setPlayCamX(x); setPlayCamY(y); }} onBack={backToGrow} onModal={setPlayModal} onNotice={setPlayNotice} />
        </Show>
        <SparseGridLayer state={active} bounds={visibleBounds} rowOffset={authoredRowOffset} renderedRows={renderedRows} mode={modeSig} timeline={() => timeline} layer="upper" onMounted={(count) => { upperMounted = count; refreshMounted(); publish(); }} />
      </View>
    </View>
    <Show when={modeSig() === "play"}>
      <DialogBox modal={playModal} legend={() => playModal() ? "next" : "talk"} />
      <Show when={playNotice() > 0}><View class="absolute flex-row justify-center" style={{ posType: 1, insetT: 40, insetL: 0, insetR: 0 }} debugName="rpgkit-grow-rewind"><Text class="text-sm" style={{ textColor: "#8ad0ff", lineHeight: 18, height: 18 }}>REWIND 3 SEC</Text></View></Show>
    </Show>
    <Show when={modeSig() === "grow"}>
      <View class="absolute" style={{ posType: 1, insetT: 4, insetL: 6, width: 164, height: 31, bgColor: "#0b1626", opacity: 0.84 }} debugName="rpgkit-grow-plate" />
      <Text class="text-xs" style={{ posType: 1, insetT: 6, insetL: 12, textColor: "#ffe97a", lineHeight: 12, height: 12 }}>{`SEED 0x${seedHex()}`}</Text>
      <Text class="text-xs" style={{ posType: 1, insetT: 19, insetL: 12, textColor: "#9fd0ff", lineHeight: 12, height: 12 }}>{`TICK ${String(g().tick).padStart(3, "0")}/${total} ${autoSig() ? "GROWING" : "PAUSED"}`}</Text>
      <View class="absolute" style={{ posType: 1, insetT: 4, insetR: 6, width: 128, height: 43, bgColor: "#0b1626", opacity: 0.76 }} debugName="rpgkit-grow-help" />
      <Text class="text-xs" style={{ posType: 1, insetT: 6, insetR: 12, textColor: "#c8d6ea", lineHeight: 12, height: 12 }}>L/R SCRUB</Text>
      <Text class="text-xs" style={{ posType: 1, insetT: 19, insetR: 12, textColor: "#c8d6ea", lineHeight: 12, height: 12 }}>TRI PLAY/PAUSE</Text>
      <Text class="text-xs" style={{ posType: 1, insetT: 32, insetR: 12, textColor: "#c8d6ea", lineHeight: 12, height: 12 }}>{g().phase === "done" ? "SQR SEED  ENTER" : "SQR SEED"}</Text>
      <View class="absolute" style={{ posType: 1, insetL: 0, insetT: viewport().h - TIMELINE_H, width: viewport().w, height: TIMELINE_H, bgColor: "#101a2c" }} debugName="rpgkit-grow-timeline">
        <View class="absolute" style={{ posType: 1, insetL: 0, insetT: 6, width: timelineFill(), height: 4, bgColor: "#4a90d9" }} debugName="rpgkit-grow-tfill" />
        <View class="absolute" style={{ posType: 1, insetL: Math.max(0, timelineFill() - 2), insetT: 4, width: 4, height: 8, bgColor: "#ffe97a" }} debugName="rpgkit-grow-knob" />
      </View>
    </Show>
    <Show when={modeSig() === "play"}><View class="absolute flex-row justify-end" style={{ posType: 1, insetT: 4, insetR: 6, bgColor: "#0b1626", opacity: 0.7 }}><Text class="text-xs" style={{ textColor: "#9fd0ff", lineHeight: 13, height: 13, insetL: 6, insetT: 1, insetR: 6, insetB: 1 }}>L REWIND 3S   SELECT BACK</Text></View></Show>
  </View>;
}
