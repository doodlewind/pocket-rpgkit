// src/engine/session.ts — P1④ multi-map session.
//
// One pure fold per virtual frame over the whole project:
//
//   mover (movement.ts) ─▶ characters (chars.ts) ─▶ interpreter
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
//                 fade-out half, swap on the first fully-black frame,
//                 fade-in half.
//   moveRoute   — a command-published route installs on its character
//                 (chars.ts). A wait:true fiber parks in the interpreter's
//                 "external" mode until the route lands, then the session
//                 resumes it with continueExternal. Page switches abort
//                 the route and resume the waiter on the same frame.
//
// No host imports, no wall clock, no Math.random (docs/SIMULATION.md).

import { deepClone } from "./clone.ts";

import {
  activePage,
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
  createChars,
  installRoute,
  playerBlockedBy,
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
import type { Dir4, PassageTable } from "./passability.ts";
import { BLOCK, buildPassage, canStepFrom } from "./passability.ts";
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
   *  pending wait (-frames..-1). */
  phase: number;
  dir: Dir4;
  /** The route installed while the mover was mid-step. It takes over on
   *  the next frame: the inherited interpolation snaps back to its origin
   *  boundary before the first route command, so a command face cannot
   *  redirect the committed step into an unchecked cell. */
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
  maps: ReadonlyMap<string, MapDef>;
  worlds: ReadonlyMap<string, ReturnType<typeof createWorld>>;
  tables: ReadonlyMap<string, PassageTable>;
}

export function createSession(project: Project, hz: number = 60): Session {
  const sheets = new Map<string, Sheet>(project.sheets.map((s) => [s.id, s]));
  const maps = new Map<string, MapDef>(project.maps.map((m) => [m.id, m]));
  const worlds = new Map(
    project.maps.map((m) => [m.id, createWorld(m, project.commonEvents ?? [], hz)]),
  );
  const tables = new Map(project.maps.map((m) => [m.id, buildPassage(m, sheets)]));
  return { cfg: { tile: project.tileSize, speed: 2 }, maps, worlds, tables };
}

export function startSession(
  project: Project,
  session: Session,
  sw0?: SwitchState,
): SessionState {
  const start = project.start;
  if (sw0) {
    const interp = createInterpState(sw0);
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

/** Spawn per-entry state for a map: fresh interpreter (MV rebuilds the map
 *  interpreter on load) and characters at their authored cells, with the
 *  project-wide switch bank shared. */
function enterMap(
  s: SessionState,
  mapId: string,
  x: number,
  y: number,
  facing: Facing,
  cfg: MovementConfig,
): void {
  s.mapId = mapId;
  s.move = initialMovement(x, y, facing, cfg);
  s.chars = createChars();
  s.interp = createInterpState(s.sw);
  s.sw = s.interp.sw;
  s.playerRoute = null;
}

/** The baked map table plus blocking-character bodies, stamped into a
 *  fresh override buffer (maps are at most a few hundred cells). A body
 *  blocks regardless of the terrain opinion under it: a map.passage
 *  "pass" override reopens terrain (a gate through a fence), it never
 *  lets the mover walk through a blocks:true character standing there. */
function tableWithBodies(base: PassageTable, chars: CharsState): PassageTable {
  const overrides = new Int8Array(base.overrides);
  const blocked = playerBlockedBy(chars);
  for (let i = 0; i < overrides.length; i++) {
    if (overrides[i] !== BLOCK && blocked(i % base.width, Math.floor(i / base.width))) {
      overrides[i] = BLOCK;
    }
  }
  return { ...base, overrides };
}

function motionOf(map: MapDef, sw: SwitchState): Record<string, MotionType> {
  const out: Record<string, MotionType> = {};
  for (const ev of map.events ?? []) {
    const active = activePage(ev, sw, map.id);
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

/** One virtual frame. Pure: returns a NEW SessionState. */
export function stepSession(
  sess: Session,
  s0: SessionState,
  input: SessionInput,
): SessionState {
  const s: SessionState = deepClone(s0);
  s.frame++;
  const map = sess.maps.get(s.mapId)!;

  // -- fade: gameplay and input freeze while the overlay moves -----------
  if (s.fade) {
    s.fade.left--;
    if (s.fade.left > 0) return s;
    if (s.fade.phase === "out") {
      const t = s.interp.pendingTransfer;
      if (t) applyTransfer(sess, s, t.map, t.x, t.y, t.dir);
      s.fade = { phase: "in", left: s.fade.half, half: s.fade.half };
      return s;
    }
    s.fade = null;
    return s;
  }

  // A fatal interpreter error freezes the playfield (review 1274 B1): the
  // clock advances but no mover, character, or interpreter fold runs, so a
  // cyclic program cannot consume steps or keep throwing frame after frame.
  if (s.interp.error) return s;

  // 1. Reconcile NPC pages. A page switch (or an event that went away)
  //    aborts any forced route parked on it; resume the waiter so the
  //    external fiber cannot deadlock.
  const erased = new Set(Object.keys(s.interp.erased));
  const synced = syncPages(s.chars, map, s.sw, sess.cfg, erased);
  s.chars = synced.state;
  for (const waiter of synced.result.abortedWaiters) {
    s.interp = continueExternal(s.interp, waiter);
  }

  // 2. Mover — frozen while a blocking fiber runs, the player's own forced
  //    route is driving, or a choices box (including one owned by a PARALLEL
  //    page) is open capturing the d-pad. A parallel TEXT line does not
  //    freeze the world (review C10).
  const busy = isBusy(s.interp);
  const choicesOpen = s.interp.modal?.kind === "choices";
  if (!busy && !choicesOpen && s.playerRoute === null) {
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
    motionOf(map, s.sw),
  );
  s.chars = stepped.state;
  for (const waiter of stepped.finishedWaiters) {
    s.interp = continueExternal(s.interp, waiter);
  }

  // Player forced route (moveRoute target:"player").
  if (s.playerRoute) stepPlayerRoute(s, sess);

  // 4. Interpreter — live NPC cells feed the trigger scan.
  const eventCells: Record<string, { x: number; y: number }> = {};
  for (const ev of map.events ?? []) eventCells[ev.id] = charCell(s.chars, ev);
  const interpInput: InterpInput = {
    confirmEdge: input.confirmEdge,
    cancelEdge: input.cancelEdge,
    upEdge: input.upEdge,
    downEdge: input.downEdge,
    playerCell: { x: s.move.tx, y: s.move.ty },
    prevCell: { x: s0.move.tx, y: s0.move.ty },
    facing: s.move.facing,
    eventCells,
  };
  s.interp = stepInterp(sess.worlds.get(s.mapId)!, s.interp, interpInput);
  // stepInterp folds over a deepClone snapshot, so the switch bank it
  // returns is a new object; re-alias the session's top-level bank to it so
  // the values chars/motion read next frame are the ones commands just wrote.
  s.sw = s.interp.sw;

  // A page-scoped parallel canceled this frame may have owned a waited
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
  if (s.interp.pendingTransfer) {
    const t = s.interp.pendingTransfer;
    if (t.fadeFrames > 0) {
      const half = Math.max(1, Math.round(t.fadeFrames / 2));
      s.fade = { phase: "out", left: half, half };
    } else {
      applyTransfer(sess, s, t.map, t.x, t.y, t.dir);
    }
  }
  return s;
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
// commits one 8-frame tile step. Faces apply on the boundary frame; waits
// park for one step's worth of frames; a blocked non-skippable move is
// retried on the next frame. A repeat:false route resumes its waiter on
// the landing frame of the last step.
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

  // First frame owning a route installed mid-step: cancel the inherited
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
    // fall through to the next command on this landing frame
  }

  const table = tableWithBodies(sess.tables.get(s.mapId)!, s.chars);
  // MV advances a move list at most once per stop frame: consume exactly
  // ONE route command on this boundary frame (matching chars.stepRoute).
  // Instant-only routes (a repeat face route) therefore take one command
  // per frame and never spin the runaway guard.
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
    // Non-repeat: pc rests at length; the boundary frame after the wait
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
    // Blocked (a source-cell dirBlock exit or an unenterable target):
    // retry on the next boundary frame, unless the route is skippable
    // (MV MoveRoute "skip if cannot move").
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
