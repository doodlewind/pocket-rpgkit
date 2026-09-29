// src/engine/interpreter.ts — P1③ event interpreter.
//
// A pure fold over (state, input) per docs/SIMULATION.md: no wall clock, no
// Math.random (the RNG cursor lives in state), no host imports. The host
// calls stepInterp once per virtual frame with pressed-edge intents and the
// player cell; the reducer owns page selection, trigger arbitration, the
// command stack, the typewriter clock and every gameplay value.
//
// Fibers
//   main       — at most one action / playerTouch / AUTORUN fiber. While it
//                runs the game is "busy" (P1② freezes player movement, the
//                UI freezes its camera) and no new blocking trigger starts.
//   parallels  — PARALLEL pages run concurrently in their own fibers, in
//                ascending event-key order so each frame is deterministic.
//
// A fiber runs a compiled linear program (compile()): `if/else` becomes
// IF + JMP, a chosen choices branch or a common event pushes another program
// on the frame stack. Suspending commands (text/choices/wait) pin the pc
// until later-frame input releases them; transfer/moveRoute park the fiber
// in "external" mode and publish a pending request P1④ completes with
// continueExternal(). Parallel and autorun fibers restart one frame after
// they finish (MV semantics): the victory autorun ends its loop by flipping
// its self switch, which changes its active page.

import { keyedRecord } from "./clone.ts";
import { DEFAULT_PLAYER_NAME, substituteLines, substitutePlayerName } from "./player-name.ts";
import type {
  Command,
  CommonEvent,
  Condition,
  Dir,
  Facing,
  GameEvent,
  MapDef,
  MoveRoute,
  Page,
} from "./types.ts";

export const TICK_HZ = 60;

/** Maximum number of interpreter steps shared by every fiber in one
 *  stepInterp call. Forward-only local bytecode can still exceed a frame's
 *  work bound, and common events can recurse across programs. This runtime
 *  budget is therefore the termination backstop; serialized-program checks
 *  only reject malformed control flow earlier. Exceeding the budget records
 *  a fatal state instead of throwing or hanging the host frame loop. */
export const RUNAWAY_STEP_LIMIT = 10000;
/** Maximum number of nested choice/common program frames. This bounds a
 * wait-interleaved recursive common event across host frames as well as an
 * in-frame recursion before it reaches the step budget. */
export const MAX_FIBER_STACK_DEPTH = 100;

// --- virtual time -----------------------------------------------------------

export function secondsToFrames(seconds: number, hz = TICK_HZ): number {
  return Math.max(0, Math.round(seconds * hz));
}

/** Characters revealed by frame `frame` (frames since revealStart) for a
 *  line of `len` chars at `cps` chars per virtual second. Fractional chars
 *  per frame accumulate, so authored cps is hz-portable: the same virtual
 *  instant reveals the same text at 60/30/10/2 Hz (R2 acceptance table). */
export function revealedChars(len: number, cps: number, frame: number, hz = TICK_HZ): number {
  if (frame <= 0) return 0;
  const cpf = cps / hz;
  return Math.max(0, Math.min(len, Math.floor(cpf * frame)));
}

// --- seeded RNG: mulberry32, cursor is a serializable state field -----------

export function rngNext(rngState: number): { value: number; next: number } {
  let a = rngState >>> 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, next: a >>> 0 };
}

export function randInt(rngState: number, min: number, max: number): { value: number; next: number } {
  const r = rngNext(rngState);
  return { value: min + Math.floor(r.value * (max - min + 1)), next: r.next };
}

// --- switch state (the saveable game values) --------------------------------

export type SelfKey = "A" | "B" | "C" | "D";

export interface SwitchState {
  switches: Record<string, boolean>;
  /** `${mapId}/${eventId}` -> held self switch (undefined = none). R2 v1
   *  models one held key per event; the sample game uses only A. */
  self: Record<string, SelfKey | undefined>;
  items: Record<string, number>;
  variables: Record<string, number>;
  gold: number;
  /** The player's name, substituted for the {name} text token. Part of the
   *  save snapshot; a fresh session seeds it from Project.playerName. */
  playerName: string;
  /** Mulberry32 cursor. Part of the save snapshot (R2 §3.1). */
  rng: number;
}

export function createSwitchState(init?: Partial<SwitchState>): SwitchState {
  return {
    switches: keyedRecord(init?.switches),
    self: keyedRecord(init?.self),
    items: keyedRecord(init?.items),
    variables: keyedRecord(init?.variables),
    gold: init?.gold ?? 0,
    playerName: init?.playerName ?? DEFAULT_PLAYER_NAME,
    rng: init?.rng ?? 0x12345678,
  };
}

function keyedValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

// --- conditions and page selection ------------------------------------------

export function evalCondition(
  c: Condition,
  s: SwitchState,
  eventKey: string,
  facing?: Facing,
): boolean {
  switch (c.kind) {
    case "switch":
      return (keyedValue(s.switches, c.id) ?? false) === (c.value ?? true);
    case "variable": {
      const v = keyedValue(s.variables, c.id) ?? 0;
      switch (c.op) {
        case ">=": return v >= c.value;
        case "<=": return v <= c.value;
        case "==": return v === c.value;
        case "!=": return v !== c.value;
      }
      return false;
    }
    case "selfSwitch":
      return (keyedValue(s.self, eventKey) === c.key) === (c.value ?? true);
    case "item":
      return (keyedValue(s.items, c.id) ?? 0) >= c.count;
    case "gold":
      return s.gold >= c.amount;
    case "facing":
      // A facing condition needs a live player direction. Callers that do
      // not have one cannot prove the condition and therefore fail it.
      return facing !== undefined && facing === FACING_OF_DIR[c.dir];
  }
}

const FACING_OF_DIR: Record<Dir, Facing> = { down: 0, left: 1, up: 2, right: 3 };

/** True when every clause of a `condition.all` list holds. */
function allClausesHold(clauses: Condition[], s: SwitchState, eventKey: string, facing?: Facing): boolean {
  for (const c of clauses) {
    if (!evalCondition(c, s, eventKey, facing)) return false;
  }
  return true;
}

/** A page whose `all` list contains a facing clause: such a playerTouch
 *  page re-fires when the player turns in place. */
export function pageReadsFacing(p: Page): boolean {
  return p.condition?.all?.some((c) => c.kind === "facing") ?? false;
}

export function pageConditionHolds(
  p: Page,
  s: SwitchState,
  eventKey: string,
  facing?: Facing,
): boolean {
  const c = p.condition;
  if (!c) return true;
  if (c.switch !== undefined && !(keyedValue(s.switches, c.switch) ?? false)) return false;
  if (c.selfSwitch !== undefined && keyedValue(s.self, eventKey) !== c.selfSwitch) return false;
  if (c.variable) {
    const v = keyedValue(s.variables, c.variable.id) ?? 0;
    const { op, value } = c.variable;
    if (op === ">=" && !(v >= value)) return false;
    if (op === "<=" && !(v <= value)) return false;
    if (op === "==" && !(v === value)) return false;
    if (op === "!=" && !(v !== value)) return false;
  }
  if (c.item !== undefined && (keyedValue(s.items, c.item) ?? 0) < 1) return false;
  if (c.all && !allClausesHold(c.all, s, eventKey, facing)) return false;
  return true;
}

/** Highest-index page whose condition holds (R2 §2); null when none do.
 *  Callers must supply `facing` when an event can use a facing condition. */
export function activePage(
  ev: GameEvent,
  s: SwitchState,
  mapId: string,
  facing?: Facing,
): { page: Page; index: number } | null {
  const key = eventKey(mapId, ev.id);
  for (let i = ev.pages.length - 1; i >= 0; i--) {
    if (pageConditionHolds(ev.pages[i]!, s, key, facing)) return { page: ev.pages[i]!, index: i };
  }
  return null;
}

export function eventKey(mapId: string, eventId: string): string {
  return `${mapId}/${eventId}`;
}

/** Explicit UTF-16 code-unit ordering for event ids. String.localeCompare is
 *  host-locale dependent: Bun and the desktop QuickJS guest order "-" (U+002D)
 *  and "_" (U+005F) differently, so the same JSON picked a different event on
 *  the two hosts (review C12). Trigger arbitration must depend only on the
 *  authored id bytes, never on the host's collation tables. */
export function eventIdLess(a: string, b: string): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca !== cb) return ca < cb;
  }
  return a.length < b.length;
}

// --- compiled programs -------------------------------------------------------

export type Instr =
  | { op: "text"; lines: string[]; cps: number }
  | {
      op: "choices";
      prompt: string;
      texts: string[];
      branches: Prog[];
      cancel: Prog | null;
    }
  | { op: "switch"; id: string; value: boolean }
  | {
      op: "variable";
      id: string;
      set:
        | { op: "set" | "add" | "sub"; value: number }
        | { op: "random"; min: number; max: number };
    }
  | { op: "selfSwitch"; key: SelfKey; value: boolean }
  | { op: "if"; cond: Condition; onFalse: number }
  | { op: "jmp"; to: number }
  | { op: "wait"; frames: number }
  | { op: "gold"; set: "add" | "sub"; amount: number }
  | { op: "item"; item: string; set: "add" | "sub"; count: number }
  | { op: "se"; name: string; volume: number; pitch: number }
  | { op: "erase" }
  | { op: "exit" }
  | { op: "lockInput" }
  | { op: "unlockInput" }
  | { op: "place"; target: "this" | { event: string }; x: number; y: number; dir: Dir | null }
  | { op: "transfer"; map: string; x: number; y: number; dir: Dir | "keep"; fadeFrames: number }
  | { op: "moveRoute"; target: "player" | "this"; wait: boolean; route: MoveRoute }
  | { op: "common"; id: string };

export type Prog = Instr[];

const DEFAULT_CPS = 30;

export function compile(cmds: readonly Command[], hz: number = TICK_HZ): Prog {
  const out: Prog = [];
  const emit = (ins: Instr): number => {
    out.push(ins);
    return out.length - 1;
  };
  const walk = (list: readonly Command[]): void => {
    for (const c of list) {
      switch (c.op) {
        case "text":
          emit({ op: "text", lines: c.lines, cps: c.cps ?? DEFAULT_CPS });
          break;
        case "choices":
          emit({
            op: "choices",
            prompt: c.prompt,
            texts: c.options.map((o) => o.text),
            branches: c.options.map((o) => compile(o.commands, hz)),
            cancel: c.cancel ? compile(c.cancel.commands, hz) : null,
          });
          break;
        case "switch":
          emit({ op: "switch", id: c.id, value: c.value });
          break;
        case "variable":
          emit({ op: "variable", id: c.id, set: c.set });
          break;
        case "selfSwitch":
          emit({ op: "selfSwitch", key: c.key, value: c.value });
          break;
        case "if": {
          const at = out.length;
          emit({ op: "if", cond: c.if, onFalse: -1 });
          walk(c.then);
          const jmpAt = emit({ op: "jmp", to: -1 });
          const elseAt = out.length;
          if (c.else) walk(c.else);
          const endAt = out.length;
          (out[at] as Extract<Instr, { op: "if" }>).onFalse = elseAt;
          (out[jmpAt] as Extract<Instr, { op: "jmp" }>).to = endAt;
          break;
        }
        case "wait":
          emit({ op: "wait", frames: secondsToFrames(c.seconds, hz) });
          break;
        case "gold":
          emit({ op: "gold", set: c.set, amount: c.amount });
          break;
        case "item":
          emit({ op: "item", item: c.item, set: c.set, count: c.count });
          break;
        case "se":
          emit({ op: "se", name: c.name, volume: c.volume ?? 80, pitch: c.pitch ?? 100 });
          break;
        case "erase":
          emit({ op: "erase" });
          break;
        case "exit":
          emit({ op: "exit" });
          break;
        case "lockInput":
          emit({ op: "lockInput" });
          break;
        case "unlockInput":
          emit({ op: "unlockInput" });
          break;
        case "place":
          emit({
            op: "place",
            target: c.target,
            x: c.x,
            y: c.y,
            dir: c.dir ?? null,
          });
          break;
        case "transfer":
          emit({
            op: "transfer",
            map: c.map,
            x: c.x,
            y: c.y,
            dir: c.dir ?? "keep",
            fadeFrames: secondsToFrames(c.fade ?? 0, hz),
          });
          break;
        case "moveRoute":
          emit({ op: "moveRoute", target: c.target, wait: c.wait ?? true, route: c.route });
          break;
        case "common":
          emit({ op: "common", id: c.id });
          break;
      }
    }
  };
  walk(cmds);
  return out;
}

// --- runtime state -----------------------------------------------------------

export interface Cell {
  x: number;
  y: number;
}

export interface InterpInput {
  /** Pressed-edge intents for THIS frame (the host computes the edges). */
  confirmEdge?: boolean;
  cancelEdge?: boolean;
  upEdge?: boolean;
  downEdge?: boolean;
  /** Player cell this frame and last frame (playerTouch fires on entry). */
  playerCell: Cell;
  prevCell: Cell;
  /** 0 down, 1 left, 2 up, 3 right — action triggers fire one tile ahead. */
  facing: Facing;
  /** Facing at the START of this frame, before the mover turned. A
   *  difference from `facing` is a turn-in-place edge, which re-fires a
   *  facing-reading playerTouch page. Defaults to `facing`. */
  prevFacing?: Facing;
  /** Live cells of map characters this frame (P1④ NPC motion); event id ->
   *  cell. Events absent from the record stand on their authored x/y. */
  eventCells?: Record<string, Cell>;
}

export interface TextModal {
  kind: "text";
  fiber: string;
  lines: string[];
  /** Joined text length (the UI renders lines joined with "\n"). */
  total: number;
  revealed: number;
  /** True once the typewriter has caught up; confirm then closes the box. */
  complete: boolean;
}

export interface ChoiceModal {
  kind: "choices";
  fiber: string;
  prompt: string;
  options: string[];
  index: number;
  cancellable: boolean;
}

export type Modal = TextModal | ChoiceModal;

/** Did the VISIBLE modal identity/content change between two reducer
 *  frames? The UI repaints the message layer only when this is true, so a
 *  parked typewriter emits zero ops on idle frames. Comparing only kind and
 *  fiber is not enough: two consecutive Show Choices run on the SAME fiber
 *  (a nested choice opens right after its parent is picked), and the second
 *  box has a different prompt, options and cancel permission. Those fields
 *  must be part of the identity or Solid keeps the previous box on screen
 *  and useActions never binds the newly-authored back action (review C07). */
export function modalChanged(a: Modal | null, b: Modal | null): boolean {
  if (a === b) return false;
  if (a === null || b === null) return true;
  if (a.kind !== b.kind || a.fiber !== b.fiber) return true;
  if (a.kind === "text" && b.kind === "text") {
    return (
      a.revealed !== b.revealed ||
      a.complete !== b.complete ||
      a.lines.length !== b.lines.length ||
      a.lines.some((line, i) => line !== b.lines[i])
    );
  }
  if (a.kind === "choices" && b.kind === "choices") {
    return (
      a.index !== b.index ||
      a.prompt !== b.prompt ||
      a.cancellable !== b.cancellable ||
      a.options.length !== b.options.length ||
      a.options.some((opt, i) => opt !== b.options[i])
    );
  }
  return false;
}

export interface SoundCue {
  name: string;
  volume: number;
  pitch: number;
}

/** P1④ consumes these: the fiber is parked in "external" mode until
 *  continueExternal() is called. P1③ publishes the payload only. */
export interface PendingTransfer {
  fiber: string;
  map: string;
  x: number;
  y: number;
  dir: Dir | "keep";
  fadeFrames: number;
}
export interface PendingMoveRoute {
  fiber: string;
  target: "player" | "this";
  eventId: string;
  route: MoveRoute;
  /** true: the fiber parked in "external" mode and the session resumes it
   *  when the route lands; false: fire-and-forget, the fiber already
   *  advanced past the command. */
  wait: boolean;
}

/** A `place` command published on THIS step. The session
 *  relocates the matching CharState after the fold; the durable position
 *  also lands in InterpState.placements so a later-created character (a
 *  page that only becomes active afterwards) spawns at the new cell. */
export interface PendingPlacement {
  eventId: string;
  x: number;
  y: number;
  /** Facing to show after the move, or keep the current one. */
  dir: Dir | null;
}

interface Fiber {
  key: string;
  pageIndex: number;
  parallel: boolean;
  stack: { prog: Prog; pc: number }[];
  mode: "run" | "text" | "choices" | "wait" | "external";
  /** Frame on which the current wait/text started. */
  since: number;
  erase: boolean;
}

export interface World {
  hz: number;
  map: MapDef;
  /** Programs are compiled once for this immutable project's id/content. */
  commonPrograms: ReadonlyMap<string, Prog>;
  pagePrograms: ReadonlyMap<string, readonly Prog[]>;
  /** Event order and spatial candidates are compiled once with the world.
   *  Trigger scans then inspect only the current/faced cells plus events
   *  whose autorun/parallel pages or live positions require a dynamic scan. */
  eventsById?: ReadonlyMap<string, GameEvent>;
  cellEvents?: ReadonlyMap<number, readonly GameEvent[]>;
  alwaysScanEvents?: readonly GameEvent[];
}

export interface InterpError {
  kind: "runaway";
  message: string;
}

export interface InterpState {
  frame: number;
  sw: SwitchState;
  main: Fiber | null;
  parallels: Record<string, Fiber>;
  modal: Modal | null;
  /** Erased event keys, for the rest of this map visit. */
  erased: Record<string, true>;
  /** playerTouch latches: set on entry, cleared once the player leaves. */
  touched: Record<string, true>;
  /** Cross-event input lock. While true the mover ignores the
   *  d-pad and action presses start no event; autorun/parallel still fold.
   *  Per map visit (the interpreter rebuilds on entry). */
  inputLocked: boolean;
  /** Durable per-visit event position overrides from `place`
   *  commands: event id -> tile + facing. syncPages spawns a later-created
   *  character here instead of the authored x/y. Cleared on map entry. */
  placements: Record<string, { x: number; y: number; dir: Dir | null }>;
  /** Sound cues emitted on this frame; the host drains them after step. */
  cues: SoundCue[];
  pendingTransfer: PendingTransfer | null;
  /** Move routes published on THIS step, in command order. A fiber can
   *  publish more than one before it parks (a fire-and-forget player turn
   *  immediately followed by a waited self-route); the session drains all. */
  pendingMoveRoutes: PendingMoveRoute[];
  /** `place` requests published on THIS step, in command order. */
  pendingPlacements: PendingPlacement[];
  /** Keys of PARALLEL fibers canceled on THIS step because their page
   *  stopped being the active page (condition failed, a higher page took
   *  over, or the event was erased). A key parked in "external" mode names
   *  a route the session must abort: a waited player route is dropped, and
   *  the event-side route is torn down by the character page sync. */
  abortedRoutes: string[];
  /** Fatal interpreter error (review 1274 B1 backstop). Absent on a
   *  healthy state (the key is not serialized, so legal save bytes are
   *  unchanged). Once set, stepInterp freezes every fiber in place: the
   *  host frame loop keeps returning instead of throwing frame after
   *  frame, and the UI shows the message. A save carrying this field is
   *  refused by the decoder (save-validate.ts). */
  error?: InterpError;
}

export function createInterpState(sw: SwitchState = createSwitchState()): InterpState {
  const safeSwitches = createSwitchState(sw);
  return {
    frame: 0,
    sw: safeSwitches,
    main: null,
    parallels: keyedRecord(),
    modal: null,
    erased: keyedRecord(),
    touched: keyedRecord(),
    inputLocked: false,
    placements: keyedRecord(),
    cues: [],
    pendingTransfer: null,
    pendingMoveRoutes: [],
    pendingPlacements: [],
    abortedRoutes: [],
  };
}

export function createWorld(map: MapDef, common: CommonEvent[] = [], hz: number = TICK_HZ): World {
  const commonPrograms = new Map<string, Prog>();
  for (const event of common) commonPrograms.set(event.id, compile(event.commands, hz));
  const pagePrograms = new Map<string, readonly Prog[]>();
  for (const event of map.events ?? []) {
    pagePrograms.set(eventKey(map.id, event.id), event.pages.map((page) => compile(page.commands, hz)));
  }
  const orderedEvents = [...(map.events ?? [])]
    .sort((a, b) => (eventIdLess(a.id, b.id) ? -1 : a.id === b.id ? 0 : 1));
  const eventsById = new Map(orderedEvents.map((ev) => [ev.id, ev]));
  const cellEvents = new Map<number, GameEvent[]>();
  const alwaysScanEvents: GameEvent[] = [];
  for (const ev of orderedEvents) {
    if (ev.pages.some((page) => page.trigger === "autorun" || page.trigger === "parallel")) {
      alwaysScanEvents.push(ev);
    }
    const w = ev.w ?? 1;
    const h = ev.h ?? 1;
    const x0 = Math.max(0, ev.x);
    const y0 = Math.max(0, ev.y);
    const x1 = Math.min(map.width, ev.x + w);
    const y1 = Math.min(map.height, ev.y + h);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const cell = y * map.width + x;
        const events = cellEvents.get(cell);
        if (events) events.push(ev);
        else cellEvents.set(cell, [ev]);
      }
    }
  }
  return { hz, map, commonPrograms, pagePrograms, eventsById, cellEvents, alwaysScanEvents };
}

/** True while the blocking interpreter owns the session: player movement
 *  and free-scroll input freeze (a text/choices/wait/autorun fiber). */
export function isBusy(_s: InterpState): boolean {
  return _s.main !== null;
}

/** Deep-copy interpreter state without host built-ins. The desktop guest
 *  runs on QuickJS, which has no structuredClone global; compiled programs
 *  are immutable and shared, only the per-fiber pc cursor is copied. */
export function cloneModal(m: Modal | null): Modal | null {
  if (m === null) return null;
  if (m.kind === "text") return { ...m, lines: [...m.lines] };
  return { ...m, options: [...m.options] };
}

function cloneMoveRoute(route: MoveRoute): MoveRoute {
  return { ...route, steps: [...route.steps] };
}

function clonePlacements(
  src: Readonly<Record<string, { x: number; y: number; dir: Dir | null }>>,
): Record<string, { x: number; y: number; dir: Dir | null }> {
  const out = keyedRecord<{ x: number; y: number; dir: Dir | null }>();
  for (const key of Object.keys(src)) out[key] = { ...src[key]! };
  return out;
}

function cloneFiber(f: Fiber): Fiber {
  return {
    key: f.key,
    pageIndex: f.pageIndex,
    parallel: f.parallel,
    stack: f.stack.map((frame) => ({ prog: frame.prog, pc: frame.pc })),
    mode: f.mode,
    since: f.since,
    erase: f.erase,
  };
}

export function cloneInterp(s0: InterpState): InterpState {
  const main = s0.main ? cloneFiber(s0.main) : null;
  const parallels = keyedRecord<Fiber>();
  for (const key of Object.keys(s0.parallels)) parallels[key] = cloneFiber(s0.parallels[key]!);
  const s: InterpState = {
    frame: s0.frame,
    sw: {
      switches: keyedRecord(s0.sw.switches),
      self: keyedRecord(s0.sw.self),
      items: keyedRecord(s0.sw.items),
      variables: keyedRecord(s0.sw.variables),
      gold: s0.sw.gold,
      playerName: s0.sw.playerName ?? DEFAULT_PLAYER_NAME,
      rng: s0.sw.rng,
    },
    main,
    parallels,
    modal: cloneModal(s0.modal),
    erased: keyedRecord(s0.erased),
    touched: keyedRecord(s0.touched),
    inputLocked: s0.inputLocked,
    placements: clonePlacements(s0.placements),
    cues: s0.cues.map((cue) => ({ ...cue })),
    pendingTransfer: s0.pendingTransfer ? { ...s0.pendingTransfer } : null,
    pendingMoveRoutes: s0.pendingMoveRoutes.map((r) => ({
      ...r,
      route: cloneMoveRoute(r.route),
    })),
    pendingPlacements: s0.pendingPlacements.map((p) => ({ ...p })),
    abortedRoutes: [...s0.abortedRoutes],
  };
  if (s0.error) s.error = { ...s0.error };
  return s;
}


// --- trigger arbitration ------------------------------------------------------

const FRONT: Record<Facing, [number, number]> = {
  0: [0, 1], // down
  1: [-1, 0], // left
  2: [0, -1], // up
  3: [1, 0], // right
};

/** The live top-left of an event's area rectangle: its moving character
 *  cell, else a durable `place` override, else the authored (x,y). */
function eventOrigin(ev: GameEvent, s: InterpState, input: InterpInput): Cell {
  return (
    (input.eventCells ? keyedValue(input.eventCells, ev.id) : undefined) ??
    keyedValue(s.placements, ev.id) ??
    { x: ev.x, y: ev.y }
  );
}

interface Rect {
  x0: number;
  y0: number;
  x1: number; // inclusive
  y1: number; // inclusive
}

/** An event's w×h area. Defaults to 1×1. A zero-width or
 *  zero-height area contains no cell: Tuxemon's boundary.py treats such a
 *  box as never matching, so the event can never touch/action-fire. */
function eventRect(ev: GameEvent, origin: Cell): Rect | null {
  const w = ev.w ?? 1;
  const h = ev.h ?? 1;
  if (w < 1 || h < 1) return null;
  return { x0: origin.x, y0: origin.y, x1: origin.x + w - 1, y1: origin.y + h - 1 };
}

function cellInRect(c: Cell, r: Rect): boolean {
  return c.x >= r.x0 && c.x <= r.x1 && c.y >= r.y0 && c.y <= r.y1;
}

function indexedEventsAt(w: World, cell: Cell): readonly GameEvent[] {
  if (cell.x < 0 || cell.y < 0 || cell.x >= w.map.width || cell.y >= w.map.height) return [];
  return w.cellEvents?.get(cell.y * w.map.width + cell.x) ?? [];
}

function worldEventById(w: World, id: string): GameEvent | undefined {
  return w.eventsById?.get(id) ?? (w.map.events ?? []).find((ev) => ev.id === id);
}

/** Events that can react this frame, in deterministic event-id order.
 *  Authored areas come from the per-cell index. Autorun/parallel pages are
 *  always eligible, while placed or moving events are added dynamically
 *  because their live rectangle no longer matches the authored index. */
function triggerCandidates(s: InterpState, w: World, input: InterpInput): GameEvent[] {
  // Keep structural compatibility for callers that construct a World
  // directly instead of using createWorld(): without an index, conservatively
  // scan every event in the same deterministic order as the original fold.
  if (!w.eventsById || !w.cellEvents || !w.alwaysScanEvents) {
    return [...(w.map.events ?? [])]
      .sort((a, b) => (eventIdLess(a.id, b.id) ? -1 : a.id === b.id ? 0 : 1));
  }
  const byId = new Map<string, GameEvent>();
  const add = (events: readonly GameEvent[]): void => {
    for (const ev of events) byId.set(ev.id, ev);
  };
  add(w.alwaysScanEvents);
  add(indexedEventsAt(w, input.playerCell));
  const [fx, fy] = FRONT[input.facing];
  add(indexedEventsAt(w, { x: input.playerCell.x + fx, y: input.playerCell.y + fy }));
  for (const id of Object.keys(s.placements)) {
    const ev = w.eventsById.get(id);
    if (ev) byId.set(id, ev);
  }
  if (input.eventCells) {
    for (const id of Object.keys(input.eventCells)) {
      const ev = w.eventsById.get(id);
      const cell = input.eventCells[id]!;
      if (ev && (cell.x !== ev.x || cell.y !== ev.y)) byId.set(id, ev);
    }
  }
  return [...byId.values()]
    .sort((a, b) => (eventIdLess(a.id, b.id) ? -1 : a.id === b.id ? 0 : 1));
}

function startFiber(
  s: InterpState,
  key: string,
  pageIndex: number,
  parallel: boolean,
  prog: Prog,
): Fiber {
  return {
    key,
    pageIndex,
    parallel,
    stack: [{ prog, pc: 0 }],
    mode: "run",
    since: s.frame,
    erase: false,
  };
}

/** Page-scoped parallel lifecycle: a parallel fiber belongs to the page
 *  that started it. When that page stops being active before the fiber
 *  finishes — its condition fails, a higher-index page takes over, or the
 *  event is erased — the fiber is canceled on the next frame. It does not
 *  run to completion: a `wait` past the cancellation frame never applies.
 *  A canceled fiber parked on an external route reports its key so the
 *  session can abort the matching player/event move route. */
function cancelStaleParallels(s: InterpState, w: World, facing: Facing): void {
  for (const key of Object.keys(s.parallels)) {
    const f = s.parallels[key]!;
    const ev = worldEventById(w, key.slice(w.map.id.length + 1));
    const active = ev && !s.erased[key] ? activePage(ev, s.sw, w.map.id, facing) : null;
    // Same page still active: keep running. A page change (index differs)
    // cancels; scanTriggers restarts a fiber for the new page on this step.
    if (active && active.index === f.pageIndex) continue;
    if (f.mode === "external") s.abortedRoutes.push(f.key);
    if (s.modal?.fiber === f.key) s.modal = null;
    delete s.parallels[key];
  }
}

function scanTriggers(s: InterpState, w: World, input: InterpInput): void {
  const rectOf = (ev: GameEvent): Rect | null => eventRect(ev, eventOrigin(ev, s, input));
  const moved = input.prevCell.x !== input.playerCell.x || input.prevCell.y !== input.playerCell.y;
  const prevFacing = input.prevFacing ?? input.facing;
  const turned = prevFacing !== input.facing;
  // Release touch latches. A latch only blocks a re-fire while the player
  // stands on the SAME cell: stepping to another cell releases it even when
  // that cell is still inside the area (every step into an area cell
  // is a fresh entry), and walking off releases it outright.
  for (const key of Object.keys(s.touched)) {
    const ev = worldEventById(w, key.slice(w.map.id.length + 1));
    if (!ev) {
      delete s.touched[key];
      continue;
    }
    const r = rectOf(ev);
    if (moved || !r || !cellInRect(input.playerCell, r)) delete s.touched[key];
  }
  // Ascending event-id order so parallel starts and the blocking-fiber
  // choice are deterministic across frames. The order is explicit UTF-16
  // code units (eventIdLess), never localeCompare, whose collation differs
  // between the Bun and QuickJS hosts (review C12).
  for (const ev of triggerCandidates(s, w, input)) {
    const key = eventKey(w.map.id, ev.id);
    if (s.erased[key]) continue;
    // Page selection sees the live player facing, so a `facing` clause
    // gates the page by direction.
    const active = activePage(ev, s.sw, w.map.id, input.facing);
    if (!active) continue;
    const { page, index } = active;
    // A page with no commands has no fiber: an opened gate's touch page and
    // a victory event's spent parallel page are inert markers, not
    // per-frame start/finish spin.
    if (page.commands.length === 0) continue;
    if (page.trigger === "parallel") {
      if (!keyedValue(s.parallels, key)) {
        s.parallels[key] = startFiber(s, key, index, true, w.pagePrograms.get(key)![index]!);
      }
      continue;
    }
    if (s.main) continue; // one blocking fiber at a time
    if (page.trigger === "autorun") {
      s.main = startFiber(s, key, index, false, w.pagePrograms.get(key)![index]!);
    } else if (page.trigger === "action") {
      // While the cross-event input lock is held, confirm presses
      // start no event (the cutscene owns control); autorun/parallel above
      // still run.
      if (s.inputLocked || !input.confirmEdge) continue;
      // MV parity: action button starts the event one tile in FRONT of the
      // player (NPCs block the tile; below-character signs are faced, not
      // stood on) OR sharing the player's cell (a plate the player walked
      // onto). With an area either tile may lie anywhere in the
      // w×h rect, so a multi-cell counter is confirmable from any edge.
      const r = rectOf(ev);
      if (!r) continue;
      const [fx, fy] = FRONT[input.facing];
      const front = { x: input.playerCell.x + fx, y: input.playerCell.y + fy };
      if (cellInRect(front, r) || cellInRect(input.playerCell, r)) {
        s.main = startFiber(s, key, index, false, w.pagePrograms.get(key)![index]!);
      }
    } else if (page.trigger === "playerTouch") {
      const r = rectOf(ev);
      if (!r || !cellInRect(input.playerCell, r)) continue;
      // Entry/step edge: moved onto an unlatched area cell.
      const stepEdge = moved && !s.touched[key];
      // Turn edge: a page whose condition reads facing re-fires when
      // the player turns in place to the direction the page now requires.
      const turnEdge = turned && !moved && pageReadsFacing(page);
      if (stepEdge || turnEdge) {
        s.touched[key] = true;
        s.main = startFiber(s, key, index, false, w.pagePrograms.get(key)![index]!);
      }
    }
  }
}

// --- fiber execution -----------------------------------------------------------

type InstantInstr = Extract<
  Instr,
  | { op: "switch" }
  | { op: "variable" }
  | { op: "selfSwitch" }
  | { op: "gold" }
  | { op: "item" }
  | { op: "se" }
>;

function runInstant(s: InterpState, f: Fiber, ins: InstantInstr): void {
  switch (ins.op) {
    case "switch":
      s.sw.switches[ins.id] = ins.value;
      break;
    case "variable": {
      if (ins.set.op === "random") {
        const r = randInt(s.sw.rng, ins.set.min, ins.set.max);
        s.sw.variables[ins.id] = r.value;
        s.sw.rng = r.next;
      } else {
        const cur = s.sw.variables[ins.id] ?? 0;
        s.sw.variables[ins.id] =
          ins.set.op === "set" ? ins.set.value
          : ins.set.op === "add" ? cur + ins.set.value
          : cur - ins.set.value;
      }
      break;
    }
    case "selfSwitch":
      s.sw.self[f.key] = ins.value ? ins.key : undefined;
      break;
    case "gold":
      s.sw.gold += ins.set === "add" ? ins.amount : -ins.amount;
      break;
    case "item":
      s.sw.items[ins.item] = (s.sw.items[ins.item] ?? 0) + (ins.set === "add" ? ins.count : -ins.count);
      break;
    case "se":
      s.cues.push({ name: ins.name, volume: ins.volume, pitch: ins.pitch });
      break;
  }
}

function finishFiber(s: InterpState, f: Fiber): void {
  if (f.erase) s.erased[f.key] = true;
  if (s.modal?.fiber === f.key) s.modal = null;
  if (f.parallel) delete s.parallels[f.key];
  else if (s.main?.key === f.key) s.main = null;
}

interface StepBudget {
  remaining: number;
}

function runFiber(
  s: InterpState,
  w: World,
  f: Fiber,
  input: InterpInput,
  budget: StepBudget,
): void {
  // Resolve already-suspending commands first; on resume the fiber falls
  // through into the run loop so the instant commands after a wait/text/
  // choice apply on the same frame the player released them.
  if (f.mode === "wait") {
    const top = f.stack[0]!;
    const ins = top.prog[top.pc]! as Extract<Instr, { op: "wait" }>;
    if (s.frame - f.since >= ins.frames) {
      f.mode = "run";
      top.pc++;
    } else return;
  }
  if (f.mode === "text") {
    const top = f.stack[0]!;
    const ins = top.prog[top.pc]!;
    if (ins.op === "text") {
      if (s.modal && s.modal.fiber !== f.key) return; // another fiber's box
      // The slot became free while this fiber parked waiting for it: the
      // reveal clock starts on the install frame, not the wait frame, or a
      // queued parallel line would dump its whole text at once (review C09).
      if (!s.modal) f.since = s.frame;
      const shownLines = substituteLines(ins.lines, s.sw.playerName ?? DEFAULT_PLAYER_NAME);
      const joined = shownLines.join("\n");
      // Once a confirm has skipped the typewriter (or it finished naturally)
      // the box stays full: elapsed-time reveal must not shrink it again.
      const wasComplete = s.modal?.kind === "text" && s.modal.complete;
      const timed = wasComplete ? joined.length : revealedChars(joined.length, ins.cps, s.frame - f.since, w.hz);
      if (input.confirmEdge && timed >= joined.length) {
        s.modal = null;
        f.mode = "run";
        top.pc++;
      } else {
        const complete = input.confirmEdge || timed >= joined.length;
        s.modal = {
          kind: "text",
          fiber: f.key,
          lines: shownLines,
          total: joined.length,
          revealed: complete ? joined.length : timed,
          complete,
        };
        return;
      }
    } else {
      f.mode = "run"; // modal slot was busy last frame; retry
    }
  }
  if (f.mode === "choices") {
    const top = f.stack[0]!;
    const ins = top.prog[top.pc]!;
    if (ins.op === "choices") {
      if (s.modal && s.modal.fiber !== f.key) return;
      // First frame after opening installs the modal; later frames keep the
      // player's cursor index.
      if (!s.modal || s.modal.kind !== "choices") {
        const name = s.sw.playerName ?? DEFAULT_PLAYER_NAME;
        s.modal = {
          kind: "choices",
          fiber: f.key,
          prompt: substitutePlayerName(ins.prompt, name),
          options: ins.texts.map((text) => substitutePlayerName(text, name)),
          index: 0,
          cancellable: ins.cancel !== null,
        };
      }
      const modal = s.modal as ChoiceModal;
      if (input.upEdge) modal.index = (modal.index + ins.texts.length - 1) % ins.texts.length;
      if (input.downEdge) modal.index = (modal.index + 1) % ins.texts.length;
      let branch: Prog | null = null;
      if (input.confirmEdge) branch = ins.branches[modal.index]!;
      else if (input.cancelEdge && ins.cancel) branch = ins.cancel;
      if (branch) {
        if (f.stack.length >= MAX_FIBER_STACK_DEPTH) {
          s.error = { kind: "runaway", message: `interpreter: stack depth exceeded in ${f.key}` };
          return;
        }
        s.modal = null;
        top.pc++; // past CHOICES in the parent
        f.stack.unshift({ prog: branch, pc: 0 });
        f.mode = "run"; // fall through: run the branch this frame
      } else {
        return;
      }
    } else {
      f.mode = "run";
    }
  }

  while (f.mode === "run") {
    if (budget.remaining-- <= 0) {
      // Backstop (reviews 1274 B1 and 1401 B1): all fibers draw from one
      // step budget. This bounds aggregate parallel work as well as a long
      // forward program or recursive common-event stack.
      s.error = { kind: "runaway", message: `interpreter: runaway program in ${f.key}` };
      return;
    }
    const top = f.stack[0]!;
    if (top.pc >= top.prog.length) {
      f.stack.shift();
      if (f.stack.length === 0) {
        finishFiber(s, f);
        return;
      }
      continue;
    }
    const ins = top.prog[top.pc]!;
    switch (ins.op) {
      case "if":
        top.pc = evalCondition(ins.cond, s.sw, f.key, input.facing) ? top.pc + 1 : ins.onFalse;
        break;
      case "jmp":
        top.pc = ins.to;
        break;
      case "switch":
      case "variable":
      case "selfSwitch":
      case "gold":
      case "item":
      case "se":
        runInstant(s, f, ins);
        top.pc++;
        break;
      case "lockInput":
        s.inputLocked = true;
        top.pc++;
        break;
      case "unlockInput":
        s.inputLocked = false;
        top.pc++;
        break;
      case "place": {
        const eventId = ins.target === "this" ? f.key.split("/").pop()! : ins.target.event;
        const p = { x: ins.x, y: ins.y, dir: ins.dir };
        s.placements[eventId] = p;
        s.pendingPlacements.push({ eventId, ...p });
        top.pc++;
        break;
      }
      case "erase":
        f.erase = true;
        finishFiber(s, f);
        return;
      case "exit":
        finishFiber(s, f);
        return;
      case "wait":
        if (ins.frames <= 0) {
          top.pc++;
          break;
        }
        f.mode = "wait";
        f.since = s.frame;
        return;
      case "text":
        // The modal slot is a single shared resource: a PARALLEL line must
        // wait behind an open main-fiber dialog instead of overwriting it
        // (review C09). Stay in "run" mode and retry next frame without
        // advancing the pc or starting the reveal clock.
        if (s.modal) return;
        f.mode = "text";
        f.since = s.frame;
        const firstLines = substituteLines(ins.lines, s.sw.playerName ?? DEFAULT_PLAYER_NAME);
        s.modal = {
          kind: "text",
          fiber: f.key,
          lines: firstLines,
          total: firstLines.join("\n").length,
          revealed: 0,
          complete: false,
        };
        return;
      case "choices":
        // Same single-slot rule for the choices box.
        if (s.modal) return;
        f.mode = "choices";
        s.modal = {
          kind: "choices",
          fiber: f.key,
          prompt: substitutePlayerName(ins.prompt, s.sw.playerName ?? DEFAULT_PLAYER_NAME),
          options: ins.texts.map((text) => substitutePlayerName(text, s.sw.playerName ?? DEFAULT_PLAYER_NAME)),
          index: 0,
          cancellable: ins.cancel !== null,
        };
        return;
      case "transfer":
        f.mode = "external";
        s.pendingTransfer = {
          fiber: f.key,
          map: ins.map,
          x: ins.x,
          y: ins.y,
          dir: ins.dir,
          fadeFrames: ins.fadeFrames,
        };
        return;
      case "moveRoute":
        if (!ins.wait) {
          // Fire-and-forget route: P1④ walks it, this fiber continues now.
          s.pendingMoveRoutes.push({
            fiber: f.key,
            target: ins.target,
            eventId: f.key.split("/").pop()!,
            route: ins.route,
            wait: false,
          });
          top.pc++;
          break;
        }
        f.mode = "external";
        s.pendingMoveRoutes.push({
          fiber: f.key,
          target: ins.target,
          eventId: f.key.split("/").pop()!,
          route: ins.route,
          wait: true,
        });
        return;
      case "common": {
        const prog = w.commonPrograms.get(ins.id);
        if (!prog) {
          top.pc++; // unknown common event: no-op (MV logs and skips)
          break;
        }
        if (f.stack.length >= MAX_FIBER_STACK_DEPTH) {
          s.error = { kind: "runaway", message: `interpreter: stack depth exceeded in ${f.key}` };
          return;
        }
        top.pc++;
        f.stack.unshift({ prog, pc: 0 });
        break;
      }
    }
  }
}

/** One virtual frame. Returns a NEW state; the input state is not mutated. */
export function stepInterp(w: World, s0: InterpState, input: InterpInput): InterpState {
  // A fatalized state is frozen: no triggers scan, no fiber advances. The
  // frame clock still ticks so render/host code keeps its cadence, but the
  // cyclic program can never consume another step (review 1274 B1).
  if (s0.error) {
    const frozen = cloneInterp(s0);
    frozen.frame = s0.frame + 1;
    frozen.cues = [];
    return frozen;
  }
  const s = cloneInterp(s0);
  s.frame = s0.frame + 1;
  s.cues = [];
  // Pending requests live only on the step that issued them: P1④ reads them
  // off that step, performs the work, then calls continueExternal().
  s.pendingTransfer = null;
  s.pendingMoveRoutes = [];
  s.pendingPlacements = [];
  s.abortedRoutes = [];

  cancelStaleParallels(s, w, input.facing);
  scanTriggers(s, w, input);
  const budget: StepBudget = { remaining: RUNAWAY_STEP_LIMIT };

  // Parallels first (ascending key), then the blocking fiber, so a parallel
  // can never observe a value the main fiber sets later in the same frame.
  for (const key of Object.keys(s.parallels).sort()) {
    runFiber(s, w, s.parallels[key]!, input, budget);
    if (s.error) return s;
  }
  if (s.main) runFiber(s, w, s.main, input, budget);
  return s;
}

/** P1④ entry point: resume a fiber parked on transfer/moveRoute after the
 *  external work (map swap, route walk) has completed. */
export function continueExternal(s0: InterpState, fiberKey: string): InterpState {
  const s = cloneInterp(s0);
  const resume = (f: Fiber | null): void => {
    if (!f || f.key !== fiberKey || f.mode !== "external") return;
    f.stack[0]!.pc++;
    f.mode = "run";
  };
  resume(s.main);
  for (const f of Object.values(s.parallels)) resume(f);
  return s;
}

/** True when the fiber is parked in "external" mode (a wait:true route or
 *  a transfer): the session completes the work before resuming it. A
 *  wait:false moveRoute publishes the same payload but the fiber already
 *  advanced, so the session treats the route as fire-and-forget. */
export function fiberIsExternal(s: InterpState, fiberKey: string): boolean {
  if (s.main?.key === fiberKey) return s.main.mode === "external";
  return Object.values(s.parallels).some((f) => f.key === fiberKey && f.mode === "external");
}
