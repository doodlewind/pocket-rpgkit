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
  randInt,
  stepInterp,
  type InterpInput,
  type InterpState,
  type PendingMoveRoute,
  type SwitchState,
} from "./interpreter.ts";
import {
  charCell,
  cloneChars,
  createChars,
  installRoute,
  placeChar,
  stepChars,
  syncPages,
  type CharsState,
  type MotionType,
} from "./chars.ts";
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
import type { Dir, Facing, MapDef, MoveStep, Project, Sheet } from "./types.ts";

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

export interface Session {
  cfg: MovementConfig;
  /** Host virtual frames per second. */
  hz: number;
  /** Fixed-rate reference ticks folded per host frame (MOTION_HZ / hz). */
  ticksPerFrame: number;
  maps: ReadonlyMap<string, MapDef>;
  worlds: ReadonlyMap<string, ReturnType<typeof createWorld>>;
  tables: ReadonlyMap<string, PassageTable>;
}

export function createSession(project: Project, hz: number = MOTION_HZ): Session {
  const sheets = new Map<string, Sheet>(project.sheets.map((s) => [s.id, s]));
  const maps = new Map<string, MapDef>(project.maps.map((m) => [m.id, m]));
  // Interpreter worlds compile at the FIXED motion reference: waits, text
  // reveal and fade frames are counted in reference ticks, and stepSession
  // folds MOTION_HZ/hz of them per host frame. Authored time then means the
  // same virtual time at every host rate.
  const worlds = new Map(
    project.maps.map((m) => [m.id, createWorld(m, project.commonEvents ?? [], MOTION_HZ)]),
  );
  const tables = new Map(project.maps.map((m) => [m.id, buildPassage(m, sheets)]));
  return {
    cfg: { tile: project.tileSize, speed: 2 },
    hz,
    ticksPerFrame: motionTicksPerFrame(hz),
    maps,
    worlds,
    tables,
  };
}

export function startSession(
  project: Project,
  session: Session,
  sw0?: SwitchState,
): SessionState {
  const start = project.start;
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
  // switch/item/variable banks begin empty).
  const interp = createInterpState();
  interp.sw.gold = project.initialGold ?? 0;
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
      ? { ...s0.playerRoute, steps: [...s0.playerRoute.steps] }
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
  //    (review C10).
  const prevFacing = s.move.facing;
  const busy = isBusy(s.interp);
  const choicesOpen = s.interp.modal?.kind === "choices";
  if (!busy && !choicesOpen && s.playerRoute === null && !s.interp.inputLocked) {
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
  s.interp = stepInterp(sess.worlds.get(s.mapId)!, s.interp, interpInput);
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
      };
    } else {
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
  if (!sess.maps.has(mapId)) throw new Error(`transfer: unknown map ${mapId}`);
  const facing: Facing = dir === "keep" ? s.move.facing : DIR_INDEX[dir];
  enterMap(s, mapId, x, y, facing, sess.cfg);
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

const FACE: Partial<Record<MoveStep, Dir4>> = {
  faceDown: 0,
  faceLeft: 1,
  faceUp: 2,
  faceRight: 3,
};
const MOVE: Partial<Record<MoveStep, Dir4>> = {
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
  const advance = (): boolean => {
    r.pc++;
    if (r.pc < r.steps.length) return false;
    if (r.repeat) r.pc = 0;
    else {
      endPlayerRoute(s);
      return true;
    }
    return false;
  };
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
