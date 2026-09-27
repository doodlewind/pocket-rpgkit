// src/engine/chars.ts — P1④ map characters: NPC motion.
//
// Every event with an active page has a CharState, whether or not the page
// has a sprite (sprite-less chars are invisible and non-blocking, but a
// moveRoute command can still move the event). Like movement.ts this is a
// tile-locked grid walk: one step takes stepFrames MOTION_HZ reference
// ticks (8 at 2 px/tick), decisions happen only on tile-boundary ticks,
// and the walk is a pure fold over the per-tick input with no host clock
// and no Math.random. The host folds 60/simulationHz reference ticks per
// host frame, so patrol and autonomous motion advance by virtual time.
//
// Three motion sources, highest priority first:
//   1. forced route   — a moveRoute command running NOW. When `waiter`
//                       names a fiber, that fiber is parked until the route
//                       finishes (interpreter "external" mode); a page
//                       switch aborts the route and releases the waiter.
//   2. patrol route   — the page-authored page.moveRoute loop (the guard's
//                       fixed two-steps-right / two-steps-left beat).
//   3. autonomous     — page.moveType: "random" ambles on the seeded RNG;
//                       "approach" steps toward the player on a timer;
//                       "static" stands.
//
// Collision is decided per tile BEFORE a step and combines the cooked
// PassageTable with character occupancy: a character never enters a tile
// the player occupies (or is stepping into) and never enters another
// character's tile. Only characters whose page sets blocks:true keep the
// player out — a below-character sign is walked over.
//
// A character whose event owns the running blocking fiber is `locked`:
// it freezes for the interaction (MV Game_Event lock). PARALLEL fibers do
// not lock.

import { activePage, eventKey, randInt, type SwitchState } from "./interpreter.ts";
import { keyedRecord } from "./clone.ts";
import { stepPixels, stepFrames, type MovementConfig } from "./movement.ts";
import type { Dir4, PassageTable } from "./passability.ts";
import { canStepFrom } from "./passability.ts";
import type { GameEvent, MapDef, MoveRoute, MoveStep } from "./types.ts";

const DX = [0, -1, 0, 1] as const; // down, left, up, right
const DY = [1, 0, -1, 0] as const;

/** MOTION_HZ reference ticks between autonomous random/approach decisions. */
const THINK_BEATS = 8;
const IDLE_BEATS = 16;
/** Approach pages only walk at the player inside this Manhattan radius. */
export const APPROACH_SIGHT = 6;

export type MotionType = "static" | "random" | "approach";

export interface RouteRun {
  steps: readonly MoveStep[];
  pc: number;
  repeat: boolean;
  /** MV "skip if cannot move": a blocked move ends the route instead of
   *  being retried forever. */
  skippable: boolean;
  /** Page patrol loops forever and is rebuilt on every page switch. */
  patrol: boolean;
  /** Fiber key parked until this route finishes; null = fire-and-forget. */
  waiter: string | null;
  /** MOTION_HZ reference ticks left of an in-route wait step. */
  waitLeft: number;
}

export interface CharState {
  id: string;
  tx: number;
  ty: number;
  px: number;
  py: number;
  facing: Dir4;
  /** 0 at a tile boundary, 1..stepFrames reference ticks while interpolating. */
  phase: number;
  moving: boolean;
  stepDir: Dir4;
  pageIndex: number;
  visible: boolean;
  blocks: boolean;
  thinkIn: number;
  /** The active run: a forced route while one is installed, otherwise the
   *  page patrol. */
  route: RouteRun | null;
  /** The page-authored patrol as a pristine template (pc 0). A forced
   *  route replaces `route` but keeps this; when the forced route ends the
   *  patrol is restored fresh from the character's current cell, the way
   *  MV rebuilds the page move route after a forced route completes. */
  patrol: RouteRun | null;
}

export interface CharsState {
  /** Mulberry32 cursor shared by random wander and turnRandom. Part of the
   *  per-map session state, so NPC motion tape-replays byte-for-byte. */
  rng: number;
  chars: Record<string, CharState>;
}

export function createChars(rng = 0x5151_5151): CharsState {
  return { rng, chars: keyedRecord() };
}

function cloneRoute(route: RouteRun | null): RouteRun | null {
  return route ? { ...route, steps: [...route.steps] } : null;
}

/** Clone mutable character state while retaining prototype-safe id tables. */
export function cloneChars(s0: CharsState): CharsState {
  const chars = keyedRecord<CharState>();
  for (const id of Object.keys(s0.chars)) {
    const ch = s0.chars[id]!;
    chars[id] = { ...ch, route: cloneRoute(ch.route), patrol: cloneRoute(ch.patrol) };
  }
  return { rng: s0.rng, chars };
}

export interface SyncResult {
  /** Waiter fibers whose forced route was aborted by a page switch or the
   *  event disappearing (the session resumes each so a parked fiber cannot
   *  deadlock). */
  abortedWaiters: string[];
}

/** Reconcile characters with the active pages. Called once per reference
 *  tick before stepChars: creates chars for new active pages, removes chars for
 *  erased events / pages whose condition stopped holding, and rebuilds the
 *  patrol route when the page index changes. */
export function syncPages(
  s0: CharsState,
  map: MapDef,
  sw: SwitchState,
  cfg: MovementConfig,
  erased: ReadonlySet<string>,
): { state: CharsState; result: SyncResult } {
  const s = cloneChars(s0);
  const abortedWaiters: string[] = [];
  const live = new Set<string>();

  for (const ev of map.events ?? []) {
    const key = eventKey(map.id, ev.id);
    if (erased.has(key)) continue;
    const active = activePage(ev, sw, map.id);
    if (!active) continue;
    live.add(ev.id);

    const existing = s.chars[ev.id];
    if (!existing) {
      s.chars[ev.id] = {
        id: ev.id,
        tx: ev.x,
        ty: ev.y,
        px: ev.x * cfg.tile,
        py: ev.y * cfg.tile,
        facing: 0,
        phase: 0,
        moving: false,
        stepDir: 0,
        pageIndex: active.index,
        visible: active.page.sprite != null,
        blocks: active.page.blocks === true,
        thinkIn: 0,
        route: makePatrol(active.page.moveRoute),
        patrol: makePatrol(active.page.moveRoute),
      };
      continue;
    }

    existing.visible = active.page.sprite != null;
    existing.blocks = active.page.blocks === true;
    if (active.index !== existing.pageIndex) {
      // A running fiber compiled from the OLD page keeps running, but its
      // parked route and the visual patrol belong to the page that is gone.
      if (existing.route?.waiter) abortedWaiters.push(existing.route.waiter);
      existing.pageIndex = active.index;
      existing.route = makePatrol(active.page.moveRoute);
      existing.patrol = existing.route;
      existing.phase = 0;
      existing.moving = false;
      existing.px = existing.tx * cfg.tile;
      existing.py = existing.ty * cfg.tile;
      existing.thinkIn = 0;
    }
  }

  for (const id of Object.keys(s.chars)) {
    if (!live.has(id)) {
      const gone = s.chars[id]!;
      if (gone.route?.waiter) abortedWaiters.push(gone.route.waiter);
      delete s.chars[id];
    }
  }
  return { state: s, result: { abortedWaiters } };
}

function makePatrol(route: MoveRoute | undefined): RouteRun | null {
  if (!route || route.steps.length === 0) return null;
  return {
    steps: route.steps,
    pc: 0,
    repeat: true,
    skippable: route.skippable,
    patrol: true,
    waiter: null,
    waitLeft: 0,
  };
}

/** Install a forced route published by a moveRoute command. A previous
 *  unfinished forced route is displaced; its waiter (if any) is returned so
 *  the session resumes it instead of leaking a parked fiber. */
export function installRoute(
  s0: CharsState,
  eventId: string,
  route: MoveRoute,
  waiter: string | null,
  cfg: MovementConfig,
): { state: CharsState; displacedWaiter: string | null } {
  const s = cloneChars(s0);
  const ch = s.chars[eventId];
  const displacedWaiter = ch?.route && !ch.route.patrol && ch.route.waiter ? ch.route.waiter : null;
  if (ch) {
    ch.route = {
      steps: route.steps,
      pc: 0,
      repeat: route.repeat,
      skippable: route.skippable,
      patrol: false,
      waiter,
      waitLeft: 0,
    };
    ch.phase = 0;
    ch.moving = false;
    ch.thinkIn = 0;
    ch.px = ch.tx * cfg.tile;
    ch.py = ch.ty * cfg.tile;
  }
  return { state: s, displacedWaiter };
}

const FACE: Record<string, Dir4> = {
  faceDown: 0,
  faceLeft: 1,
  faceUp: 2,
  faceRight: 3,
};
const MOVE: Record<string, Dir4> = {
  moveDown: 0,
  moveLeft: 1,
  moveUp: 2,
  moveRight: 3,
};

export interface PlayerPlace {
  tx: number;
  ty: number;
  /** Tile the player is stepping INTO this tick (same as tx,ty at rest). */
  destX: number;
  destY: number;
}

function occupantBlocks(
  ch: CharState,
  tx: number,
  ty: number,
  exit: Dir4,
  table: PassageTable,
  player: PlayerPlace,
  others: ReadonlyMap<string, CharState>,
): boolean {
  // The exit direction is the direction of THIS candidate step; the
  // character's current facing is its pre-turn orientation and must not be
  // used to look up the target cell's directional block. canStepFrom checks
  // BOTH edges of the crossing: the source cell's exit mask and the target
  // cell's reverse-entry mask (task-1206 dual-edge contract).
  if (!canStepFrom(table, ch.tx, ch.ty, exit)) return true;
  if (tx === player.tx && ty === player.ty) return true;
  if (tx === player.destX && ty === player.destY) return true;
  for (const [id, o] of others) {
    if (id === ch.id) continue;
    if (tx === o.tx && ty === o.ty) return true;
    if (o.moving && tx === o.tx + DX[o.stepDir] && ty === o.ty + DY[o.stepDir]) return true;
  }
  return false;
}

/** True when a character's body keeps the PLAYER out of (tx,ty): the
 *  active page must opt in with blocks:true. */
export function charBlocksPlayer(ch: CharState, tx: number, ty: number): boolean {
  if (!ch.blocks) return false;
  if (tx === ch.tx && ty === ch.ty) return true;
  if (ch.moving && tx === ch.tx + DX[ch.stepDir] && ty === ch.ty + DY[ch.stepDir]) return true;
  return false;
}

/** Build the per-tick collision predicate the player mover consults
 *  alongside its PassageTable. */
export function playerBlockedBy(s: CharsState): (tx: number, ty: number) => boolean {
  const chars = Object.values(s.chars);
  return (tx, ty) => chars.some((ch) => charBlocksPlayer(ch, tx, ty));
}

function commitStep(ch: CharState, dir: Dir4, cfg: MovementConfig): void {
  ch.facing = dir;
  ch.stepDir = dir;
  ch.moving = true;
  ch.phase = 1;
  const { px, py } = stepPixels(ch.tx * cfg.tile, ch.ty * cfg.tile, dir, 1, cfg);
  ch.px = px;
  ch.py = py;
}

function releaseRoute(ch: CharState, finishedWaiters: string[]): void {
  if (ch.route?.waiter) finishedWaiters.push(ch.route.waiter);
  if (ch.route?.patrol) {
    ch.route.pc = 0;
    ch.route.waitLeft = 0;
  } else if (ch.patrol) {
    // The forced route ended (landed, skipped, or was aborted via a page
    // switch elsewhere): restore the page patrol fresh from this cell.
    ch.route = { ...ch.patrol, pc: 0, waitLeft: 0 };
  } else {
    ch.route = null;
  }
}

/** One MOTION_HZ reference tick for every character, in ascending event-id
 *  order so the fold is deterministic. `locked` names events whose blocking
 *  fiber owns the session (they freeze). `motion` is the active page
 *  moveType per event. Returns waiters whose forced routes FINISHED (or were
 *  skipped) on or before this tick. */
export function stepChars(
  s0: CharsState,
  table: PassageTable,
  player: PlayerPlace,
  cfg: MovementConfig,
  locked: ReadonlySet<string>,
  motion: Readonly<Record<string, MotionType>>,
): { state: CharsState; finishedWaiters: string[] } {
  const s = cloneChars(s0);
  const frames = stepFrames(cfg);
  const finishedWaiters: string[] = [];
  const others = new Map(Object.entries(s.chars));

  for (const id of Object.keys(s.chars).sort()) {
    const ch = s.chars[id]!;
    others.set(id, ch);

    // Mid-step: interpolate. Nothing interrupts a step once committed
    // (locks and page changes snap at boundaries via syncPages).
    if (ch.moving) {
      const phase = ch.phase + 1;
      if (phase < frames) {
        const { px, py } = stepPixels(ch.tx * cfg.tile, ch.ty * cfg.tile, ch.stepDir, phase, cfg);
        ch.phase = phase;
        ch.px = px;
        ch.py = py;
        continue;
      }
      ch.tx += DX[ch.stepDir];
      ch.ty += DY[ch.stepDir];
      ch.px = ch.tx * cfg.tile;
      ch.py = ch.ty * cfg.tile;
      ch.phase = 0;
      ch.moving = false;
      // A non-repeating route ends exactly on the landing tick, so a
      // waiting fiber resumes as soon as the NPC reaches the last tile.
      if (ch.route && ch.route.pc >= ch.route.steps.length && !ch.route.repeat) {
        releaseRoute(ch, finishedWaiters);
      }
      continue;
    }

    if (locked.has(ch.id) && !(ch.route && !ch.route.patrol)) continue;
    if (ch.route && ch.route.waitLeft > 0) {
      ch.route.waitLeft--;
      // The tick the wait expires also takes the next command, so an
      // N-tick wait plus the following step occupies exactly N+8 ticks.
      if (ch.route.waitLeft > 0) continue;
    }

    if (ch.route) {
      stepRoute(s, ch, table, player, others, cfg, finishedWaiters);
      continue;
    }

    if (ch.thinkIn > 0) {
      ch.thinkIn--;
      if (ch.thinkIn > 0) continue; // decide on the tick the pause ends
    }
    const kind = motion[id] ?? "static";
    if (kind === "random") randomStep(s, ch, table, player, others, cfg);
    else if (kind === "approach") approachStep(ch, table, player, others, cfg);
  }

  return { state: s, finishedWaiters };
}

/** Consume exactly ONE route command on this boundary tick (MV advances
 *  its move list at most once per stop tick). */
function stepRoute(
  s: CharsState,
  ch: CharState,
  table: PassageTable,
  player: PlayerPlace,
  others: ReadonlyMap<string, CharState>,
  cfg: MovementConfig,
  finishedWaiters: string[],
): void {
  const route = ch.route!;
  const step: MoveStep | undefined = route.steps[route.pc];
  if (step === undefined) {
    releaseRoute(ch, finishedWaiters);
    return;
  }

  const faceDir = FACE[step];
  if (faceDir !== undefined) {
    ch.facing = faceDir;
    ch.stepDir = faceDir;
    route.pc++;
    if (route.pc >= route.steps.length && !route.repeat) releaseRoute(ch, finishedWaiters);
    else if (route.pc >= route.steps.length) route.pc = 0;
    return;
  }
  if (step === "turnRandom") {
    const r = randInt(s.rng, 0, 3);
    s.rng = r.next;
    ch.facing = r.value as Dir4;
    ch.stepDir = ch.facing;
    route.pc++;
    if (route.pc >= route.steps.length && !route.repeat) releaseRoute(ch, finishedWaiters);
    else if (route.pc >= route.steps.length) route.pc = 0;
    return;
  }
  if (step === "wait") {
    route.waitLeft = stepFrames(cfg);
    route.pc++;
    if (route.pc >= route.steps.length && route.repeat) route.pc = 0;
    // Non-repeat: pc stays at length; when the wait expires the next call
    // hits the undefined branch above and releases the waiter.
    return;
  }

  const dir = step === "stepForward" ? ch.facing : MOVE[step];
  if (dir === undefined) {
    route.pc++;
    return;
  }
  const tx = ch.tx + DX[dir];
  const ty = ch.ty + DY[dir];
  if (occupantBlocks(ch, tx, ty, dir, table, player, others)) {
    ch.facing = dir;
    ch.stepDir = dir;
    if (route.skippable) releaseRoute(ch, finishedWaiters);
    return; // retry on the next boundary tick
  }
  commitStep(ch, dir, cfg);
  route.pc++;
  if (route.pc >= route.steps.length && route.repeat) route.pc = 0;
}

function randomStep(
  s: CharsState,
  ch: CharState,
  table: PassageTable,
  player: PlayerPlace,
  others: ReadonlyMap<string, CharState>,
  cfg: MovementConfig,
): void {
  const r = randInt(s.rng, 0, 4);
  s.rng = r.next;
  if (r.value === 4) {
    ch.thinkIn = IDLE_BEATS; // one-in-five amble pauses
    return;
  }
  const dir = r.value as Dir4;
  ch.facing = dir;
  ch.stepDir = dir;
  const tx = ch.tx + DX[dir];
  const ty = ch.ty + DY[dir];
  if (!occupantBlocks(ch, tx, ty, dir, table, player, others)) {
    commitStep(ch, dir, cfg);
    // The 8-tick step is its own pacing; no extra think delay on a move.
    return;
  }
  ch.thinkIn = THINK_BEATS; // blocked: re-roll later
}

function approachStep(
  ch: CharState,
  table: PassageTable,
  player: PlayerPlace,
  others: ReadonlyMap<string, CharState>,
  cfg: MovementConfig,
): void {
  const dx = player.tx - ch.tx;
  const dy = player.ty - ch.ty;
  if (dx === 0 && dy === 0) return;
  if (Math.abs(dx) + Math.abs(dy) > APPROACH_SIGHT) return;
  // Larger gap first; ties go vertical, matching the mover's d-pad priority.
  const order: Dir4[] = Math.abs(dy) >= Math.abs(dx)
    ? [dy > 0 ? 0 : 2, dx > 0 ? 3 : 1]
    : [dx > 0 ? 3 : 1, dy > 0 ? 0 : 2];
  for (const dir of order) {
    const tx = ch.tx + DX[dir];
    const ty = ch.ty + DY[dir];
    if (!occupantBlocks(ch, tx, ty, dir, table, player, others)) {
      commitStep(ch, dir, cfg); // chained approach steps at the step cadence
      return;
    }
  }
  if (order[0] !== undefined) {
    ch.facing = order[0];
    ch.stepDir = order[0];
  }
  ch.thinkIn = THINK_BEATS; // boxed in: pause before retrying
}

/** Resolve a character's current cell (authored position if it has no
 *  CharState yet). Used by the session to build interpreter eventCells. */
export function charCell(s: CharsState, ev: GameEvent): { x: number; y: number } {
  const ch = s.chars[ev.id];
  return ch ? { x: ch.tx, y: ch.ty } : { x: ev.x, y: ev.y };
}
