// src/engine/session.ts — P1④ multi-map session.
//
// One pure fold over the whole project on the fixed MOTION_HZ reference
// (motion-clock.ts, 60 ticks per virtual second):
//
//   mover (movement.ts) ─▶ characters (chars.ts) ─▶ interpreter
//
// stepSession is called once per HOST virtual frame but advances
// MOTION_HZ/simulationHz reference ticks per call (two at 30 Hz, three at
// 20 Hz, fifteen at 4 Hz). Motion, waits, the typewriter and fades are then
// functions of virtual time and agree at every host rate. Input edges are
// one host frame wide and reach only the first reference tick of a batch.
//
// plus the two P1④ mechanics:
//
//   transfer    — swap the current map. Matches MV map-load semantics:
//                 the map interpreter is rebuilt fresh and every map
//                 character returns to its authored cell, while the
//                 project values (switches, items, variables, gold, RNG
//                 cursor) survive. Same-map transfers reset the same way;
//                 the parking fiber ends at the transfer (every authored
//                 transfer is the terminal command of its page). With
//                 fade>0 the swap happens behind a black overlay:
//                 fade-out half, swap on the first fully-black reference
//                 tick, fade-in half.
//   moveRoute   — a command-published route installs on its character
//                 (chars.ts). A wait:true fiber parks in the interpreter's
//                 "external" mode until the route lands, then the session
//                 resumes it with continueExternal. Page switches abort
//                 the route and resume the waiter on the same tick.
//
// No host imports, no wall clock, no Math.random (docs/SIMULATION.md).

import { keyedRecord } from "./clone.ts";

import {
  activePage,
  cloneInterp,
  continueExternal,
  createInterpState,
  createWorld,
  isBusy,
  messageHoldsPlayer,
  randInt,
  stepInterp,
  type InterpInput,
  type InterpState,
  type PendingMoveRoute,
  type SwitchState,
  type WorldOptions,
} from "./interpreter.ts";
import {
  charCell,
  cloneChars,
  createChars,
  installRoute,
  placeChar,
  stepChars,
  syncPages,
  BFS_CELLS_PER_TICK,
  DEFAULT_PATH_RETRIES,
  PATH_REPLAN_TICKS,
  type CharsState,
  type MotionType,
  type PathPlan,
} from "./chars.ts";
import {
  approachSide,
  approachStand,
  advancePathSearch,
  clonePathSearch,
  createPathSearch,
  facingToward,
} from "./pathfind.ts";
import {
  initialMovement,
  stepFrames,
  stepMovement,
  stepPixels,
  type MovementConfig,
  type MovementState,
} from "./movement.ts";
import { MOTION_HZ, motionTicksPerFrame } from "./motion-clock.ts";
import type { Dir4, PassageTable } from "./passability.ts";
import { buildPassage, canStepFrom, stampBlockedCells } from "./passability.ts";
import {
  MAP_SCHEMA_HASH,
  isProjectShell,
  mapManifestHash,
  validateMapIndex,
  type MapContentIdentity,
} from "./map-repository.ts";
import type {
  CommonEvent,
  Dir,
  Facing,
  MapDef,
  MapIndexEntry,
  MapRepository,
  MoveStep,
  ProjectSource,
  Sheet,
} from "./types.ts";

const DX = [0, -1, 0, 1] as const;
const DY = [1, 0, -1, 0] as const;
const DIR_INDEX: Record<Dir, Facing> = { down: 0, left: 1, up: 2, right: 3 };

export interface FadeState {
  phase: "out" | "in";
  /** Frames until the next fade boundary (swap at end of out; clear at
   *  end of in). */
  left: number;
  /** Frames for one half-ramp. */
  half: number;
}

interface PlayerRoute {
  steps: readonly MoveStep[];
  pc: number;
  repeat: boolean;
  skippable: boolean;
  waiter: string | null;
  /** 0 idle at boundary; 1..stepFrames while stepping; negative counts a
   *  pending wait (-ticks..-1), all in MOTION_HZ reference ticks. */
  phase: number;
  dir: Dir4;
  /** The route installed while the mover was mid-step. It takes over on
   *  the next reference tick: the inherited interpolation snaps back to its
   *  origin boundary before the first route command, so a command face
   *  cannot redirect the committed step into an unchecked cell. */
  takeOver: boolean;
  /** Expansion state for the current pathTo/approach step. */
  plan: PathPlan | null;
  /** Remaining replans for the current path step; survives plan rebuilds. */
  pathRetriesLeft: number | null;
}

export interface SessionState {
  frame: number;
  mapId: string;
  sw: SwitchState;
  move: MovementState;
  chars: CharsState;
  interp: InterpState;
  fade: FadeState | null;
  playerRoute: PlayerRoute | null;
}

export interface SessionInput {
  buttons: number;
  confirmEdge?: boolean;
  cancelEdge?: boolean;
  upEdge?: boolean;
  downEdge?: boolean;
}

interface SessionMapPreparation {
  id: string;
  map?: MapDef;
  world?: ReturnType<typeof createWorld>;
  table?: PassageTable;
}

export interface Session {
  cfg: MovementConfig;
  /** Host virtual frames per second. */
  hz: number;
  /** Fixed-rate reference ticks folded per host frame (MOTION_HZ / hz). */
  ticksPerFrame: number;
  /** Derived, mutable compile cache. It is deliberately outside
   * SessionState, snapshots and reducer hashes. Inline projects retain all
   * maps; sharded projects retain only the deterministic keep set. */
  maps: Map<string, MapDef>;
  worlds: Map<string, ReturnType<typeof createWorld>>;
  tables: Map<string, PassageTable>;
  /** Metadata for every sharded map without retaining any MapDef payload. */
  mapIndex: ReadonlyMap<string, MapIndexEntry> | null;
  /** Content identity copied into save envelopes for sharded projects. */
  content: MapContentIdentity | null;
  repository: MapRepository | null;
  /** Partially prepared transfer target. Derived only: never serialized or
   * exposed to event logic. */
  preparingMap: SessionMapPreparation | null;
  sheets: ReadonlyMap<string, Sheet>;
  commonEvents: CommonEvent[];
  /** Project.system options every compiled world (eager or on demand) uses. */
  worldOptions: WorldOptions;
}

/** Acquire, validate and compile one map into the derived session cache. */
export function acquireSessionMap(sess: Session, id: string): MapDef {
  const hit = sess.maps.get(id);
  if (hit) {
    if (sess.preparingMap?.id === id) sess.preparingMap = null;
    return hit;
  }
  const expected = sess.mapIndex?.get(id);
  const repository = sess.repository;
  if (!expected || !repository) throw new Error(`session: unknown map ${id}`);
  const actual = repository.meta(id);
  if (!actual || actual.id !== expected.id || actual.width !== expected.width ||
    actual.height !== expected.height || actual.entry !== expected.entry ||
    actual.sha256 !== expected.sha256) {
    throw new Error(`map repository: manifest metadata mismatch for ${id}`);
  }
  const prepared = sess.preparingMap?.id === id ? sess.preparingMap : null;
  if (prepared?.map && prepared.world && prepared.table) {
    sess.maps.set(id, prepared.map);
    sess.worlds.set(id, prepared.world);
    sess.tables.set(id, prepared.table);
    sess.preparingMap = null;
    return prepared.map;
  }
  const map = repository.acquire(id);
  if (map.id !== expected.id || map.width !== expected.width || map.height !== expected.height) {
    throw new Error(`map repository: payload metadata mismatch for ${id}`);
  }
  // Compile into locals first. A throw leaves the live cache and simulation
  // untouched, which is what an async caller needs before retrying a frame.
  const world = createWorld(map, sess.commonEvents, MOTION_HZ, sess.worldOptions);
  const table = buildPassage(map, sess.sheets);
  sess.maps.set(id, map);
  sess.worlds.set(id, world);
  sess.tables.set(id, table);
  if (sess.preparingMap?.id === id) sess.preparingMap = null;
  return map;
}

/** Perform at most one fixed preparation unit for a synchronous repository:
 * repository parse, repository validation, then world + passage compilation.
 * Completed data remains derived and unpublished until acquireSessionMap at
 * the original transfer boundary. */
export function prepareSessionMapStep(sess: Session, id: string): boolean {
  if (sess.maps.has(id)) return true;
  const expected = sess.mapIndex?.get(id);
  const repository = sess.repository;
  if (!expected || !repository) throw new Error(`session: unknown map ${id}`);
  const actual = repository.meta(id);
  if (!actual || actual.id !== expected.id || actual.width !== expected.width ||
    actual.height !== expected.height || actual.entry !== expected.entry ||
    actual.sha256 !== expected.sha256) {
    throw new Error(`map repository: manifest metadata mismatch for ${id}`);
  }
  if (!repository.acquireStep) return false;
  if (sess.preparingMap?.id !== id) sess.preparingMap = { id };
  const preparation = sess.preparingMap;
  if (!preparation.map) {
    const map = repository.acquireStep(id);
    if (map) {
      if (map.id !== expected.id || map.width !== expected.width || map.height !== expected.height) {
        throw new Error(`map repository: payload metadata mismatch for ${id}`);
      }
      preparation.map = map;
    }
    return false;
  }
  if (!preparation.world || !preparation.table) {
    const world = createWorld(preparation.map, sess.commonEvents, MOTION_HZ, sess.worldOptions);
    const table = buildPassage(preparation.map, sess.sheets);
    preparation.world = world;
    preparation.table = table;
  }
  return true;
}

/** Prepare web-backed bytes (when supported) and compile them outside the
 * reducer. The caller then retries the exact state/input pair that met a
 * MapNotReadyError; no logical tick is consumed while this promise waits. */
export async function prepareSessionMap(sess: Session, id: string): Promise<void> {
  if (sess.maps.has(id)) return;
  if (!sess.repository || !sess.mapIndex?.has(id)) {
    throw new Error(`session: unknown map ${id}`);
  }
  await sess.repository.prepare?.(id);
  acquireSessionMap(sess, id);
}

/** Deterministic cache policy for sharded projects: retain exactly the given
 * ids, in caller-provided order. Inline projects keep their eager cache. */
export function releaseSessionMapsExcept(sess: Session, ids: readonly string[]): void {
  if (!sess.repository) return;
  const keep = new Set(ids);
  for (const id of [...sess.maps.keys()]) if (!keep.has(id)) sess.maps.delete(id);
  for (const id of [...sess.worlds.keys()]) if (!keep.has(id)) sess.worlds.delete(id);
  for (const id of [...sess.tables.keys()]) if (!keep.has(id)) sess.tables.delete(id);
  if (sess.preparingMap && !keep.has(sess.preparingMap.id)) sess.preparingMap = null;
  sess.repository.releaseExcept(ids);
}

export function createSession(
  project: ProjectSource,
  hz: number = MOTION_HZ,
  maps?: MapRepository,
): Session {
  const sheets = new Map<string, Sheet>(project.sheets.map((s) => [s.id, s]));
  const commonEvents = [...(project.commonEvents ?? [])];
  const worldOptions: WorldOptions = {
    messageBlocksPlayer: project.system?.messageBlocksPlayer === true,
  };
  if (isProjectShell(project)) {
    if (!maps) throw new Error("map repository: ProjectShell requires a MapRepository");
    const index = validateMapIndex(project.mapIndex);
    const manifest = mapManifestHash(project);
    if (project.mapManifestHash !== undefined && project.mapManifestHash !== manifest) {
      throw new Error("map repository: shell manifest hash mismatch");
    }
    if (project.mapSchemaHash !== undefined && project.mapSchemaHash !== MAP_SCHEMA_HASH) {
      throw new Error("map repository: shell schema hash mismatch");
    }
    if (!index.has(project.start.map)) {
      throw new Error(`map repository: start map ${project.start.map} is absent from mapIndex`);
    }
    const session: Session = {
      cfg: { tile: project.tileSize, speed: 2 },
      hz,
      ticksPerFrame: motionTicksPerFrame(hz),
      maps: new Map(),
      worlds: new Map(),
      tables: new Map(),
      mapIndex: index,
      content: { manifest, schema: MAP_SCHEMA_HASH },
      repository: maps,
      preparingMap: null,
      sheets,
      commonEvents,
      worldOptions,
    };
    acquireSessionMap(session, project.start.map);
    releaseSessionMapsExcept(session, [project.start.map]);
    return session;
  }
  const inlineMaps = new Map<string, MapDef>(project.maps.map((m) => [m.id, m]));
  // Interpreter worlds compile at the FIXED motion reference: waits, text
  // reveal and fade frames are counted in reference ticks, and stepSession
  // folds MOTION_HZ/hz of them per host frame. Authored time then means the
  // same virtual time at every host rate.
  const worlds = new Map(
    project.maps.map((m) => [m.id, createWorld(m, commonEvents, MOTION_HZ, worldOptions)]),
  );
  const tables = new Map(project.maps.map((m) => [m.id, buildPassage(m, sheets)]));
  return {
    cfg: { tile: project.tileSize, speed: 2 },
    hz,
    ticksPerFrame: motionTicksPerFrame(hz),
    maps: inlineMaps,
    worlds,
    tables,
    mapIndex: null,
    content: null,
    repository: null,
    preparingMap: null,
    sheets,
    commonEvents,
    worldOptions,
  };
}

export function startSession(
  project: ProjectSource,
  session: Session,
  sw0?: SwitchState,
): SessionState {
  const start = project.start;
  acquireSessionMap(session, start.map);
  releaseSessionMapsExcept(session, [start.map]);
  if (sw0) {
    const interp = createInterpState(sw0);
    clearLocalBank(interp.sw);
    return {
      frame: 0,
      mapId: start.map,
      sw: interp.sw,
      move: initialMovement(start.x, start.y, DIR_INDEX[start.dir], session.cfg),
      chars: createChars(),
      interp,
      fade: null,
      playerRoute: null,
    };
  }
  // Fresh playthrough: seed the project's starting gold (the remaining
  // switch/item/variable banks begin empty) and the configurable default
  // player name (substituted for the {name} text token).
  const interp = createInterpState();
  interp.sw.gold = project.initialGold ?? 0;
  if (project.playerName) interp.sw.playerName = project.playerName;
  return {
    frame: 0,
    mapId: start.map,
    sw: interp.sw,
    move: initialMovement(start.x, start.y, DIR_INDEX[start.dir], session.cfg),
    chars: createChars(),
    interp,
    fade: null,
    playerRoute: null,
  };
}

/** Drop per-visit switch/variable ids. Any switch or variable
 *  whose id starts with `local.` lives for one map visit: it is cleared on
 *  every map entry, so a guard like `local.npc.guard == 0` re-runs after a
 *  transfer away and back. Mutates the shared project-wide bank in place
 *  (the map interpreter rebuild shares this object). */
function clearLocalBank(sw: SwitchState): void {
  for (const id of Object.keys(sw.switches)) {
    if (id.startsWith("local.")) delete sw.switches[id];
  }
  for (const id of Object.keys(sw.variables)) {
    if (id.startsWith("local.")) delete sw.variables[id];
  }
}

/** Spawn per-entry state for a map: fresh interpreter (MV rebuilds the map
 *  interpreter on load) and characters at their authored cells, with the
 *  project-wide switch bank shared (minus the per-visit `local.` ids). */
function enterMap(
  s: SessionState,
  mapId: string,
  x: number,
  y: number,
  facing: Facing,
  cfg: MovementConfig,
): void {
  clearLocalBank(s.sw);
  s.mapId = mapId;
  s.move = initialMovement(x, y, facing, cfg);
  s.chars = createChars();
  s.interp = createInterpState(s.sw);
  s.sw = s.interp.sw;
  s.playerRoute = null;
}

/** The baked map table plus blocking-character bodies, held as a sparse
 *  set of occupied row-major cells. A body
 *  blocks regardless of the terrain opinion under it: a map.passage
 *  "pass" override reopens terrain (a gate through a fence), it never
 *  lets the mover walk through a blocks:true character standing there. */
export function tableWithBodies(base: PassageTable, chars: CharsState): PassageTable {
  const cells: number[] = [];
  const add = (x: number, y: number): void => {
    if (x >= 0 && y >= 0 && x < base.width && y < base.height) {
      cells.push(y * base.width + x);
    }
  };
  for (const ch of Object.values(chars.chars)) {
    if (!ch.blocks) continue;
    add(ch.tx, ch.ty);
    if (ch.moving) add(ch.tx + DX[ch.stepDir], ch.ty + DY[ch.stepDir]);
  }
  return stampBlockedCells(base, cells);
}

function motionOf(map: MapDef, sw: SwitchState, facing: Facing): Record<string, MotionType> {
  const out = keyedRecord<MotionType>();
  for (const ev of map.events ?? []) {
    const active = activePage(ev, sw, map.id, facing);
    if (active) out[ev.id] = active.page.moveType ?? "static";
  }
  return out;
}

function eventIdOf(key: string, mapId: string): string {
  const prefix = `${mapId}/`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

/** Opacity the UI overlay shows on the current fade frame: 1 fully black. */
export function fadeOpacity(fade: FadeState | null): number {
  if (!fade) return 0;
  return fade.phase === "out" ? 1 - fade.left / fade.half : fade.left / fade.half;
}

/** One host virtual frame. The fold runs on the fixed MOTION_HZ reference:
 *  every host frame folds MOTION_HZ/hz reference ticks — two at 30 Hz,
 *  three at 20 Hz, fifteen at 4 Hz. Motion, waits, text and fades are
 *  therefore functions of virtual time and agree at every host rate. Input
 *  edges are one host frame wide and are delivered only on the FIRST
 *  reference tick of a batch; the remaining ticks reuse the held button
 *  mask with no edges. Pure: returns a NEW SessionState. */
export function stepSession(
  sess: Session,
  s0: SessionState,
  input: SessionInput,
): SessionState {
  const interp = cloneInterp(s0.interp);
  const s: SessionState = {
    frame: s0.frame,
    mapId: s0.mapId,
    sw: interp.sw,
    move: { ...s0.move },
    chars: cloneChars(s0.chars),
    interp,
    fade: s0.fade ? { ...s0.fade } : null,
    playerRoute: s0.playerRoute
      ? {
          ...s0.playerRoute,
          steps: [...s0.playerRoute.steps],
          plan: s0.playerRoute.plan
            ? {
                ...s0.playerRoute.plan,
                dirs: [...s0.playerRoute.plan.dirs],
                search: clonePathSearch(s0.playerRoute.plan.search),
                approach: s0.playerRoute.plan.approach
                  ? { ...s0.playerRoute.plan.approach }
                  : null,
              }
            : null,
        }
      : null,
  };
  s.frame++;
  const ticks = sess.ticksPerFrame;

  let prevCell = { x: s.move.tx, y: s.move.ty };
  for (let tick = 0; tick < ticks; tick++) {
    const tickInput: SessionInput =
      tick === 0
        ? input
        : { buttons: input.buttons, confirmEdge: false, cancelEdge: false, upEdge: false, downEdge: false };
    const nextCell = stepReferenceTick(sess, s, tickInput, prevCell);
    prevCell = nextCell;
    // A fatalized interpreter freezes the playfield for the rest of the
    // batch (review 1274 B1): reference clock keeps advancing, the fold
    // does not.
    if (s.interp.error) break;
  }
  return s;
}

/** Advance the session one MOTION_HZ reference tick, mutating the working
 *  clone `s`. Returns the player cell the next tick sees as prevCell. */
function stepReferenceTick(
  sess: Session,
  s: SessionState,
  input: SessionInput,
  prevCellIn: { x: number; y: number },
): { x: number; y: number } {
  const map = sess.maps.get(s.mapId)!;

  // -- fade: gameplay and input freeze while the overlay moves -----------
  if (s.fade) {
    if (s.fade.phase === "out") {
      const transfer = s.interp.pendingTransfer;
      if (transfer) prepareSessionMapStep(sess, transfer.map);
    }
    s.fade.left--;
    if (s.fade.left > 0) return { x: s.move.tx, y: s.move.ty };
    if (s.fade.phase === "out") {
      const t = s.interp.pendingTransfer;
      if (t) applyTransfer(sess, s, t.map, t.x, t.y, t.dir);
      s.fade = { phase: "in", left: s.fade.half, half: s.fade.half };
      return { x: s.move.tx, y: s.move.ty };
    }
    s.fade = null;
    return { x: s.move.tx, y: s.move.ty };
  }

  // A fatal interpreter error freezes the playfield (review 1274 B1): the
  // clock advances but no mover, character, or interpreter fold runs, so a
  // cyclic program cannot consume steps or keep throwing tick after tick.
  if (s.interp.error) return { x: s.move.tx, y: s.move.ty };

  // 1. Reconcile NPC pages. A page switch (or an event that went away)
  //    aborts any forced route parked on it; resume the waiter so the
  //    external fiber cannot deadlock.
  const erased = new Set(Object.keys(s.interp.erased));
  const synced = syncPages(
    s.chars,
    map,
    s.sw,
    sess.cfg,
    erased,
    s.interp.placements,
    s.move.facing,
  );
  s.chars = synced.state;
  for (const waiter of synced.result.abortedWaiters) {
    s.interp = continueExternal(s.interp, waiter);
  }

  // 2. Mover — frozen while a blocking fiber runs, the player's own forced
  //    route is driving, a choices box (including one owned by a PARALLEL
  //    page) is open capturing the d-pad, or the cross-event input lock is
  //    held. A parallel TEXT line does not freeze the world
  //    (review C10) unless the project opts in with
  //    system.messageBlocksPlayer: then any open box holds the player.
  const world = sess.worlds.get(s.mapId)!;
  const prevFacing = s.move.facing;
  const busy = isBusy(s.interp);
  const choicesOpen = s.interp.modal?.kind === "choices";
  const held = messageHoldsPlayer(world, s.interp);
  if (!busy && !choicesOpen && !held && s.playerRoute === null && !s.interp.inputLocked) {
    const table = tableWithBodies(sess.tables.get(s.mapId)!, s.chars);
    Object.assign(s.move, stepMovement(s.move, input.buttons, table, sess.cfg));
  }

  // 3. Characters.
  const playerPlace = {
    tx: s.move.tx,
    ty: s.move.ty,
    destX: s.move.moving ? s.move.tx + DX[s.move.stepDir] : s.move.tx,
    destY: s.move.moving ? s.move.ty + DY[s.move.stepDir] : s.move.ty,
  };
  const locked = new Set<string>();
  if (s.interp.main) locked.add(eventIdOf(s.interp.main.key, s.mapId));
  const stepped = stepChars(
    s.chars,
    sess.tables.get(s.mapId)!,
    playerPlace,
    sess.cfg,
    locked,
    motionOf(map, s.sw, s.move.facing),
  );
  s.chars = stepped.state;
  for (const waiter of stepped.finishedWaiters) {
    s.interp = continueExternal(s.interp, waiter);
  }

  // Player forced route (moveRoute target:"player").
  if (s.playerRoute) stepPlayerRoute(s, sess);

  // 4. Interpreter — only displaced NPC cells need to supplement the
  // world's authored spatial index. Static characters resolve from the
  // indexed event origin without growing the per-frame record.
  const eventCells = keyedRecord<{ x: number; y: number }>();
  for (const ev of map.events ?? []) {
    const cell = charCell(s.chars, ev);
    if (cell.x !== ev.x || cell.y !== ev.y) eventCells[ev.id] = cell;
  }
  const interpInput: InterpInput = {
    confirmEdge: input.confirmEdge,
    cancelEdge: input.cancelEdge,
    upEdge: input.upEdge,
    downEdge: input.downEdge,
    playerCell: { x: s.move.tx, y: s.move.ty },
    prevCell: prevCellIn,
    facing: s.move.facing,
    prevFacing,
    eventCells,
  };
  s.interp = stepInterp(world, s.interp, interpInput);
  // stepInterp clones the mutable interpreter state, so the switch bank it
  // returns is a new object; re-alias the session's top-level bank to it so
  // the values chars/motion read next tick are the ones commands just wrote.
  s.sw = s.interp.sw;

  // A page-scoped parallel canceled this tick may have owned a waited
  // player route: drop it without resuming the dead waiter. The event-side
  // half is torn down by syncPages (the character's page went away).
  if (s.playerRoute && s.playerRoute.waiter && s.interp.abortedRoutes.includes(s.playerRoute.waiter)) {
    s.playerRoute = null;
    s.move.walking = false;
  }

  // 5. Consume published external requests. Routes drain in command order
  //    so the fire-and-forget player turn installs before the waited
  //    self-route parks the fiber.
  for (const req of s.interp.pendingMoveRoutes) {
    if (req.target === "player") {
      // A route replacing one still running releases the parked waiter
      // instead of orphaning it, and takes over at a tile boundary: a
      // command face must not inherit the mover's committed interpolation
      // and redirect it into a cell the new direction never checked.
      if (s.playerRoute?.waiter) {
        s.interp = continueExternal(s.interp, s.playerRoute.waiter);
      }
      s.playerRoute = {
        steps: req.route.steps,
        pc: 0,
        repeat: req.route.repeat,
        skippable: req.route.skippable,
        waiter: req.wait ? req.fiber : null,
        phase: 0,
        dir: s.move.facing,
        takeOver: s.move.moving,
        plan: null,
        pathRetriesLeft: null,
      };
    } else {
      // A route to an event with no live character (no active page, or it
      // was erased) cannot run: resume a waiting caller immediately rather
      // than park its external fiber forever (MV: a Set Movement Route on
      // an absent map event is a no-op).
      if (!s.chars.chars[req.eventId]) {
        if (req.wait) s.interp = continueExternal(s.interp, req.fiber);
        continue;
      }
      const installed = installRoute(
        s.chars,
        req.eventId,
        req.route,
        req.wait ? req.fiber : null,
        sess.cfg,
      );
      s.chars = installed.state;
      if (installed.displacedWaiter) {
        s.interp = continueExternal(s.interp, installed.displacedWaiter);
      }
    }
  }
  // 5b. `place` requests: relocate the live character now; the
  //     durable placement record the interpreter already holds makes a
  //     later-created character spawn at the new tile on the next sync.
  for (const p of s.interp.pendingPlacements) {
    const placed = placeChar(s.chars, p.eventId, p.x, p.y, p.dir, sess.cfg);
    s.chars = placed.state;
    if (placed.displacedWaiter) {
      s.interp = continueExternal(s.interp, placed.displacedWaiter);
    }
  }
  if (s.interp.pendingTransfer) {
    const t = s.interp.pendingTransfer;
    if (t.fadeFrames > 0) {
      const half = Math.max(1, Math.round(t.fadeFrames / 2));
      s.fade = { phase: "out", left: half, half };
    } else {
      applyTransfer(sess, s, t.map, t.x, t.y, t.dir);
    }
  }
  return { x: s.move.tx, y: s.move.ty };
}

function applyTransfer(
  sess: Session,
  s: SessionState,
  mapId: string,
  x: number,
  y: number,
  dir: Dir | "keep",
): void {
  acquireSessionMap(sess, mapId);
  const facing: Facing = dir === "keep" ? s.move.facing : DIR_INDEX[dir];
  enterMap(s, mapId, x, y, facing, sess.cfg);
  releaseSessionMapsExcept(sess, [mapId]);
}

// ---------------------------------------------------------------------------
// Player forced route (moveRoute target:"player")
//
// Reuses the mover's interpolation (stepPixels, stepFrames): a route step
// commits one 8-reference-tick tile step. Faces apply on the boundary tick;
// waits park for one step's worth of ticks; a blocked non-skippable move is
// retried on the next tick. A repeat:false route resumes its waiter on the
// landing tick of the last step.
// ---------------------------------------------------------------------------

/** The string-verb move steps the FACE/MOVE lookup tables cover; object
 *  path steps are handled separately. */
type VerbMoveStep = Extract<MoveStep, string>;
const FACE: Partial<Record<VerbMoveStep, Dir4>> = {
  faceDown: 0,
  faceLeft: 1,
  faceUp: 2,
  faceRight: 3,
};
const MOVE: Partial<Record<VerbMoveStep, Dir4>> = {
  moveDown: 0,
  moveLeft: 1,
  moveUp: 2,
  moveRight: 3,
};

function endPlayerRoute(s: SessionState): void {
  if (s.playerRoute!.waiter) s.interp = continueExternal(s.interp, s.playerRoute!.waiter);
  s.playerRoute = null;
  s.move.walking = false;
}

/** Snap a half-walked tile step back to its origin boundary. A route
 *  installed mid-step takes over on the boundary: the committed
 *  interpolation belonged to the mover's (or the old route's) direction,
 *  and carrying it onto the route's facing would enter a cell the new
 *  direction never checked. */
function cancelCommittedStep(m: MovementState, cfg: MovementConfig): void {
  if (!m.moving) return;
  m.phase = 0;
  m.moving = false;
  m.walking = false;
  m.px = m.tx * cfg.tile;
  m.py = m.ty * cfg.tile;
}

function stepPlayerRoute(s: SessionState, sess: Session): void {
  const r = s.playerRoute!;
  const cfg = sess.cfg;
  const frames = stepFrames(cfg);
  const m = s.move;

  // First tick owning a route installed mid-step: cancel the inherited
  // interpolation and resume from its origin boundary.
  if (r.takeOver) {
    r.takeOver = false;
    cancelCommittedStep(m, cfg);
  }

  if (r.phase < 0) {
    r.phase++;
    return;
  }
  if (r.phase > 0) {
    r.phase++;
    if (r.phase < frames) {
      const { px, py } = stepPixels(m.tx * cfg.tile, m.ty * cfg.tile, r.dir, r.phase, cfg);
      m.px = px;
      m.py = py;
      m.moving = true;
      return;
    }
    m.tx += DX[r.dir];
    m.ty += DY[r.dir];
    m.px = m.tx * cfg.tile;
    m.py = m.ty * cfg.tile;
    m.facing = r.dir;
    m.stepDir = r.dir;
    m.moving = false;
    r.phase = 0;
    // The final internal step of a pathTo/approach plan lands here.
    // Apply the approach arrival-facing and advance the route pc once.
    if (r.plan?.done) {
      const ap = r.plan.approach;
      if (ap) {
        const tc = resolvePlayerTarget(ap.target, s);
        if (tc) {
          const f = facingToward(m.tx, m.ty, tc.x, tc.y);
          if (f !== null) { m.facing = f; m.stepDir = f; }
        }
      }
      advance();
      return;
    }
    // fall through to the next command on this landing tick
  }

  const table = tableWithBodies(sess.tables.get(s.mapId)!, s.chars);
  // MV advances a move list at most once per stop tick: consume exactly
  // ONE route command on this reference tick (matching chars.stepRoute).
  // Instant-only routes (a repeat face route) therefore take one command
  // per reference tick and never spin the runaway guard.
  const step = r.steps[r.pc];
  if (step === undefined) {
    endPlayerRoute(s);
    return;
  }
  function advance(): boolean {
    r.plan = null;
    r.pathRetriesLeft = null;
    r.pc++;
    if (r.pc < r.steps.length) return false;
    if (r.repeat) r.pc = 0;
    else {
      endPlayerRoute(s);
      return true;
    }
    return false;
  }

  // --- turn / path steps ---------------------------------------------------
  if (typeof step === "object") {
    if ("turnToward" in step) {
      const tc = resolvePlayerTarget(step.turnToward, s);
      if (tc) {
        const f = facingToward(m.tx, m.ty, tc.x, tc.y);
        if (f !== null) { r.dir = f; m.facing = f; m.stepDir = f; }
      }
      advance();
      return;
    }
    if ("pathTo" in step || "approach" in step) {
      stepPlayerPath(s, sess, table, step, advance);
      return;
    }
    advance(); // unknown object step: skip defensively
    return;
  }
  if (step === "turnTowardPlayer") {
    // The player turning toward the player is a no-op turn; keep facing.
    advance();
    return;
  }

  const faceDir = FACE[step];
  if (faceDir !== undefined) {
    r.dir = faceDir;
    m.facing = faceDir;
    m.stepDir = faceDir;
    advance();
    return;
  }
  if (step === "turnRandom") {
    // The project RNG bank owns randomness, keeping the route
    // deterministic and saveable.
    const roll = randInt(s.sw.rng, 0, 3);
    s.sw.rng = roll.next;
    const dir = roll.value as Dir4;
    r.dir = dir;
    m.facing = dir;
    m.stepDir = dir;
    advance();
    return;
  }
  if (step === "wait") {
    r.phase = -frames;
    r.pc++;
    if (r.repeat && r.pc >= r.steps.length) r.pc = 0;
    // Non-repeat: pc rests at length; the reference tick after the wait
    // hits the undefined branch above and releases the waiter.
    return;
  }
  const dir = step === "stepForward" ? r.dir : MOVE[step];
  if (dir === undefined) {
    advance();
    return;
  }
  r.dir = dir;
  m.facing = dir;
  m.stepDir = dir;
  if (!canStepFrom(table, m.tx, m.ty, dir)) {
    // Blocked: the source cell's exit or the target's reverse entry is
    // dirBlocked, or the target terrain is unenterable. Retry on the next
    // reference tick, unless the route is skippable (MV MoveRoute
    // "skip if cannot move").
    if (r.skippable) endPlayerRoute(s);
    return;
  }
  r.phase = 1;
  r.pc++;
  m.moving = true;
  const { px, py } = stepPixels(m.tx * cfg.tile, m.ty * cfg.tile, dir, 1, cfg);
  m.px = px;
  m.py = py;
  if (r.repeat && r.pc >= r.steps.length) r.pc = 0;
}

/** Resolve a route target character to its live cell for a PLAYER route.
 *  The player is always at the mover's own cell; an event resolves through
 *  its live character cell, else its authored origin. */
function resolvePlayerTarget(
  target: "player" | { event: string },
  s: SessionState,
): { x: number; y: number } | null {
  if (target === "player") return { x: s.move.tx, y: s.move.ty };
  const ch = s.chars.chars[target.event];
  if (ch) return { x: ch.tx, y: ch.ty };
  return null;
}

/** Expand/walk one player pathTo or approach step for this reference tick.
 *  The stamped table already carries blocks:true bodies, so the BFS needs
 *  no extra occupancy set. The authored pc advances only when the whole
 *  plan is consumed; `advance` handles repeat/finish/waiter release. */
function stepPlayerPath(
  s: SessionState,
  sess: Session,
  table: PassageTable,
  step: Extract<MoveStep, { pathTo: unknown }> | Extract<MoveStep, { approach: unknown }>,
  advance: () => boolean,
): void {
  const r = s.playerRoute!;
  const m = s.move;
  const cfg = sess.cfg;

  if (r.plan === null) {
    let gx: number;
    let gy: number;
    let approach: PathPlan["approach"] = null;
    if ("pathTo" in step) {
      gx = step.pathTo.x;
      gy = step.pathTo.y;
    } else {
      const target = step.approach.target;
      if (target === "player") { endPlayerRoute(s); return; }
      const tc = resolvePlayerTarget(target, s);
      if (!tc) { endPlayerRoute(s); return; }
      let side: Dir4;
      if (step.approach.side) {
        side = DIR4_PLAYER[step.approach.side]!;
      } else {
        const resolved = approachSide(m.tx, m.ty, tc.x, tc.y);
        if (resolved === null) { advance(); return; }
        side = resolved;
      }
      const distance = step.approach.distance ?? 1;
      const stand = approachStand(tc.x, tc.y, side, distance);
      gx = stand.x;
      gy = stand.y;
      approach = { target, side, distance };
    }

    if (gx === m.tx && gy === m.ty) {
      if (approach) {
        const tc = resolvePlayerTarget(approach.target, s);
        if (tc) {
          const f = facingToward(m.tx, m.ty, tc.x, tc.y);
          if (f !== null) { r.dir = f; m.facing = f; m.stepDir = f; }
        }
      }
      advance();
      return;
    }

    if (r.pathRetriesLeft === null) {
      r.pathRetriesLeft =
        ("pathTo" in step ? step.pathTo.retries : step.approach.retries) ?? DEFAULT_PATH_RETRIES;
    }
    // The stamped table already carries every blocks:true body (and the
    // cell it is stepping into). A blocks:false event is walked over by the
    // mover, so the search crosses it too, the way a character route does.
    // Begin a frame-split BFS (one slice per reference tick).
    const search = createPathSearch(table, m.tx, m.ty, gx, gy);
    if (search === null) { endPlayerRoute(s); return; }
    r.plan = { search, dirs: [], blockedTicks: 0, done: false, approach };
  }

  const plan = r.plan;
  if (!plan) return;
  if (plan.search) {
    const res = advancePathSearch(plan.search, table, BFS_CELLS_PER_TICK);
    if (!res.done) return; // still computing; no movement this tick
    plan.search = null;
    if (res.path === null) {
      plan.dirs = [];
      plan.blockedTicks = 1;
    } else if (res.path.length === 0) {
      if (plan.approach) {
        const tc = resolvePlayerTarget(plan.approach.target, s);
        if (tc) {
          const f = facingToward(m.tx, m.ty, tc.x, tc.y);
          if (f !== null) { r.dir = f; m.facing = f; m.stepDir = f; }
        }
      }
      advance();
      return;
    } else {
      plan.dirs = res.path;
      plan.blockedTicks = 0;
    }
  }
  if (plan.done) return; // the landing branch advances
  const dir = plan.dirs[0];
  if (dir === undefined) {
    plan.blockedTicks++;
    if (plan.blockedTicks < PATH_REPLAN_TICKS) return;
    if (r.pathRetriesLeft! <= 0) { endPlayerRoute(s); return; }
    r.pathRetriesLeft = r.pathRetriesLeft! - 1;
    r.plan = null;
    return;
  }
  r.dir = dir;
  m.facing = dir;
  m.stepDir = dir;
  if (!canStepFrom(table, m.tx, m.ty, dir)) {
    plan.blockedTicks++;
    if (plan.blockedTicks < PATH_REPLAN_TICKS) return;
    if (r.pathRetriesLeft! <= 0) { endPlayerRoute(s); return; }
    r.pathRetriesLeft = r.pathRetriesLeft! - 1;
    r.plan = null;
    return;
  }
  r.phase = 1;
  m.moving = true;
  const { px, py } = stepPixels(m.tx * cfg.tile, m.ty * cfg.tile, dir, 1, cfg);
  m.px = px;
  m.py = py;
  plan.dirs.shift();
  if (plan.dirs.length === 0) plan.done = true;
}

const DIR4_PLAYER: Record<Dir, Dir4> = { down: 0, left: 1, up: 2, right: 3 };
