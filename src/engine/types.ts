// src/engine/types.ts — data types for rpgkit-project/v1 (the schema
// in data/schema.json is normative). P1① carried the map/sheet subset; P1③
// widens to the event vocabulary the interpreter consumes (R2 report §2–3):
// pages, triggers, the 15-op command list, page conditions. The interpreter
// (interpreter.ts) is a pure fold over these types: no host imports. P1②
// adds the sheet dirBlock directional masks consumed by passability.ts.

export type Dir = "down" | "left" | "right" | "up";

/** Facing as an engine index: 0 down, 1 left, 2 up, 3 right. Matches the
 *  BTN-driven order the camera reducer emits and the hero atlas file order. */
export type Facing = 0 | 1 | 2 | 3;

/** A tile id "sheet.cell" (e.g. "grass.43"); null is a blocking void. */
export type TileId = string | null;

export interface Sheet {
  id: string;
  cols: number;
  rows: number;
  /** Cooked TILESET pak entry ("chunks" marks the P1① prebaked-chunk build,
   *  which owns no per-tile entry). */
  pak?: string;
  defaultPassage?: "pass" | "block";
  block?: number[];
  pass?: number[];
  /** Cell index (as string) -> directions of the edges that cell forbids
   *  crossing: the mask blocks LEAVING that cell through a named edge and
   *  ENTERING it through that same edge from outside (P1②, task-1206). */
  dirBlock?: Record<string, Dir[]>;
}

// --- events ----------------------------------------------------------------

export type Trigger = "action" | "playerTouch" | "autorun" | "parallel";

export type MoveStep =
  | "moveDown" | "moveLeft" | "moveRight" | "moveUp"
  | "stepForward"
  | "faceDown" | "faceLeft" | "faceRight" | "faceUp"
  | "wait" | "turnRandom";

export interface MoveRoute {
  steps: MoveStep[];
  repeat: boolean;
  skippable: boolean;
}

/** A condition inside an `if` command (compare against live switch state).
 *  The same union backs PageCondition.all: a switch clause
 *  there may demand either value, unlike the bare page-condition `switch`
 *  field which only asks for ON. `facing` reads the live player facing and
 *  is meaningful only where a facing context exists (the trigger scan, an
 *  `if` folded on the map); elsewhere it evaluates false. */
export type Condition =
  | { kind: "switch"; id: string; value?: boolean }
  | { kind: "variable"; id: string; op: ">=" | "<=" | "==" | "!="; value: number }
  | { kind: "selfSwitch"; key: "A" | "B" | "C" | "D"; value?: boolean }
  | { kind: "item"; id: string; count: number }
  | { kind: "gold"; amount: number }
  | { kind: "facing"; dir: Dir };

export interface VariableSet {
  op: "set" | "add" | "sub";
  value: number;
}
export interface VariableRandom {
  op: "random";
  min: number;
  max: number;
}

export type Command =
  | { op: "text"; lines: string[]; cps?: number }
  | {
      op: "choices";
      prompt: string;
      options: { text: string; commands: Command[] }[];
      cancel?: { commands: Command[] };
    }
  | { op: "switch"; id: string; value: boolean }
  | { op: "variable"; id: string; set: VariableSet | VariableRandom }
  | { op: "selfSwitch"; key: "A" | "B" | "C" | "D"; value: boolean }
  | { op: "if"; if: Condition; then: Command[]; else?: Command[] }
  | { op: "transfer"; map: string; x: number; y: number; dir?: Dir | "keep"; fade?: number }
  | { op: "moveRoute"; target: "player" | "this"; wait?: boolean; route: MoveRoute }
  | { op: "wait"; seconds: number }
  | { op: "gold"; set: "add" | "sub"; amount: number }
  | { op: "item"; item: string; set: "add" | "sub"; count: number }
  | { op: "se"; name: string; volume?: number; pitch?: number }
  | { op: "erase" }
  | { op: "exit" }
  | { op: "common"; id: string }
  /** Cross-event input lock. While the lock is held the mover
   *  ignores the d-pad and action presses cannot start an event; autorun
   *  and parallel fibers keep folding. MV lock_controls/unlock_controls. */
  | { op: "lockInput" }
  | { op: "unlockInput" }
  /** Relocate an event to a tile (MV Set Event Location),
   *  optionally facing a direction there. "this" moves the running event;
   *  { event } moves another map event. Applied on the next character
   *  sync, so a page with blocks:true occupies the new cell. */
  | { op: "place"; target: "this" | { event: string }; x: number; y: number; dir?: Dir };

/** A page's activation gate. Every present clause must hold (AND). The
 *  four flat fields stay the v1 spelling; `all` is the compound
 *  spelling: every Condition in the list must hold, and it ANDs with the
 *  flat fields when both are authored. An `all` entry of kind "facing"
 *  additionally makes a playerTouch page re-fire when the
 *  player turns while standing in its area. */
export interface PageCondition {
  switch?: string;
  selfSwitch?: "A" | "B" | "C" | "D";
  variable?: { id: string; op: ">=" | "<=" | "==" | "!="; value: number };
  item?: string;
  all?: Condition[];
}

export interface Page {
  condition?: PageCondition;
  trigger: Trigger;
  sprite?: string | null;
  blocks?: boolean;
  /** Autonomous motion (MV moveType): "static" stands still, "random"
   *  wanders on the seeded RNG, "approach" takes one step toward the
   *  player on a timer. An explicit moveRoute overrides all three. */
  moveType?: "static" | "random" | "approach";
  moveRoute?: MoveRoute;
  /** Facing the character shows when the page spawns it (the
   *  first page that creates the CharState, and again after a page
   *  switch). Defaults to down. */
  dir?: Dir;
  commands: Command[];
}

export interface GameEvent {
  id: string;
  name?: string;
  x: number;
  y: number;
  /** The event occupies the w×h rectangle with (x,y) as its
   *  top-left corner. playerTouch fires when the player enters ANY cell of
   *  the rectangle; action fires when the player confirms facing any cell
   *  of it (or stands in it). Defaults to 1×1; the schema requires >= 1. */
  w?: number;
  h?: number;
  pages: Page[];
}

export interface MapDef {
  id: string;
  name: string;
  width: number;
  height: number;
  /** Sheet ids this map draws from. */
  sheets?: string[];
  /** Row-major, length width*height; null is a void (nothing baked). */
  ground: TileId[];
  /** Sparse star layer drawn above characters: [row-major index, tile id]. */
  upper?: [number, TileId][];
  /** Per-cell passage overrides: [index, "pass"|"block"]. */
  passage?: [number, "pass" | "block"][];
  /** Interactive events (P1③: page selection + interpretation). */
  events?: GameEvent[];
}

export interface Item {
  id: string;
  name: string;
  sprite: string;
  usable?: boolean;
}

export interface CommonEvent {
  id: string;
  name?: string;
  trigger: "none" | "parallel";
  conditionSwitch?: string;
  commands: Command[];
}

/** Page.sprite resolves through this map; v1 ships static 16x16 image
 *  characters only (the player walker is authored separately). */
export interface SpriteDef {
  kind: "image";
  src: string;
}

export interface Project {
  format: "rpgkit-project/v1";
  title: string;
  tileSize: 16;
  start: { map: string; x: number; y: number; dir: Dir };
  initialGold?: number;
  /** Default name substituted for the {name} text token in a fresh
   *  playthrough. Stored in the switch bank after that, so a rename (a future
   *  op) survives saves and transfers. */
  playerName?: string;
  sheets: Sheet[];
  items: Item[];
  /** Page.sprite key -> static character image. */
  sprites?: Record<string, SpriteDef>;
  commonEvents?: CommonEvent[];
  maps: MapDef[];
}

/** Pure simulation state for the camera slice. Position is the world-space
 *  top-left of the camera in pixels; the player focus stays screen-centered
 *  (its world position is cam + viewport center). */
export interface CameraState {
  x: number;
  y: number;
  facing: Facing;
}
