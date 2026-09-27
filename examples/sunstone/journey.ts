// examples/sunstone/journey.ts — deterministic winning-playthrough driver.
//
// The attract-mode tape is a real playthrough of "The Sunstone of Bramble
// Hollow": village key chest -> north gate -> forest rune stone -> thorn
// gate -> cave iron gate -> sunstone relic -> THE END. This module drives
// the pure session reducer (session.ts) to produce that playthrough as one
// u16 button mask per virtual frame. It runs on every host (QuickJS-safe:
// plain data, engine deps only) and the sim test replays the recorded
// masks against the built bundle, so the demo can never drift from the
// game it ships.
//
// The driver is ADAPTIVE, not frame-scripted: it reads the live reducer
// state, holds a direction until the target tile is reached, and pulses
// confirm until every fiber closes. Wandering NPCs (mulberry32 in the
// switch bank) move during the run, so the route picks around their live
// bodies; the RNG stream is part of the folded state, which keeps each
// run byte-identical and lets the same driver reach the same milestones at
// every simulation rate. Below 60 Hz one host frame folds several motion
// reference ticks under one mask (motion-clock.ts), so walkTo plans those
// frames with the real reducer (journey-search.ts); the 60 Hz path, which
// generates the frozen attract tape, is unchanged.

import { buildGame } from "./game-data.ts";
import { createSession, startSession, stepSession, type Session, type SessionState } from "../../src/engine/session.ts";
import { canStepFrom, type Dir4, type PassageTable } from "../../src/engine/passability.ts";
import { searchWalk } from "../../src/engine/journey-search.ts";

// BTN masks (duplicated as constants so this engine module keeps zero
// framework/contracts imports — same values as contracts/spec/spec.ts).
const BTN_UP = 0x0010;
const BTN_RIGHT = 0x0020;
const BTN_DOWN = 0x0040;
const BTN_LEFT = 0x0080;
const BTN_CIRCLE = 0x2000;

const DX = [0, -1, 0, 1] as const;
const DY = [1, 0, -1, 0] as const;
const DIR_BTN = [BTN_DOWN, BTN_LEFT, BTN_UP, BTN_RIGHT] as const;

export interface JourneyResult {
  /** One held button mask per virtual frame, index = frame. */
  masks: number[];
  /** Session state AFTER the frame with the same index. */
  states: SessionState[];
  hz: number;
}

export interface JourneyMilestones {
  /** Frame the thorn-key chest was opened. */
  chest: number;
  /** Frame the player arrived in the forest. */
  forest: number;
  /** Frame the rune stone was lit. */
  rune: number;
  /** Frame the player arrived in the cave. */
  cave: number;
  /** Frame the iron gate was opened. */
  gate: number;
  /** Frame the altar fiber closed with the Sunstone taken ("won" set).
   *  The victory autorun starts after it; the tape ends here and the
   *  attract end-hold shows THE END. */
  end: number;
}

/** Milestone states survive the journey (asserted at every sim rate):
 *  switch/item banks and the current map, never NPC pixels. */
export function milestoneSnapshot(s: SessionState): Record<string, unknown> {
  return {
    mapId: s.mapId,
    gold: s.sw.gold,
    items: { ...s.sw.items },
    switches: { ...s.sw.switches },
    self: Object.fromEntries(Object.entries(s.sw.self).filter(([, v]) => v !== undefined)),
  };
}

class Driver {
  readonly session: Session;
  state: SessionState;
  readonly masks: number[] = [];
  readonly states: SessionState[] = [];
  private prev = 0;
  private readonly hz: number;

  constructor(hz: number) {
    const { project } = buildGame();
    this.session = createSession(project, hz);
    this.state = startSession(project, this.session);
    this.hz = hz;
  }

  /** Fold one frame: the held mask plus press edges derived from the
   *  held-level transition, exactly as the live view derives them. Public
   *  for the scripted transfer/confirm steps of playWinningRun. */
  go(mask: number): SessionState {
    const pressed = mask & ~this.prev;
    this.prev = mask;
    this.state = stepSession(this.session, this.state, {
      buttons: mask,
      confirmEdge: !!(pressed & BTN_CIRCLE),
      upEdge: !!(pressed & BTN_UP),
      downEdge: !!(pressed & BTN_DOWN),
    });
    this.masks.push(mask >>> 0);
    this.states.push(this.state);
    return this.state;
  }

  private table(): PassageTable {
    return this.session.tables.get(this.state.mapId)!;
  }

  /** playerTouch transfer pads on the current map. The route never walks
   *  over one except as an explicit scripted step, or the map would swap
   *  mid-route. */
  private pads(): Set<number> {
    const map = this.session.maps.get(this.state.mapId)!;
    const out = new Set<number>();
    for (const ev of map.events ?? []) {
      if (ev.pages.some((p) => p.trigger === "playerTouch")) out.add(ev.y * map.width + ev.x);
    }
    return out;
  }

  /** Static BFS over terrain minus live NPC bodies and transfer pads;
   *  returns the first-step direction toward (tx,ty), or null when no
   *  corridor exists right now (a wandering body can move away later). */
  private nextStep(tx: number, ty: number, avoid: Set<number>): Dir4 | null {
    const s = this.state;
    const table = this.table();
    const map = this.session.maps.get(s.mapId)!;
    const W = map.width;
    const H = map.height;
    const idx = (x: number, y: number): number => y * W + x;
    const blocked = new Set<number>();
    for (const ch of Object.values(s.chars.chars)) {
      blocked.add(idx(ch.tx, ch.ty));
      if (ch.moving) blocked.add(idx(ch.tx + DX[ch.stepDir], ch.ty + DY[ch.stepDir]));
    }
    const start = idx(s.move.tx, s.move.ty);
    const goal = idx(tx, ty);
    if (start === goal) return null;
    const parent = new Int32Array(W * H).fill(-2);
    parent[start] = -1;
    const queue = [start];
    for (let qi = 0; qi < queue.length; qi++) {
      const cur = queue[qi]!;
      if (cur === goal) break;
      const cx = cur % W;
      const cy = Math.floor(cur / W);
      for (let dir = 0 as Dir4; dir < 4; dir = (dir + 1) as Dir4) {
        const nx = cx + DX[dir];
        const ny = cy + DY[dir];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = idx(nx, ny);
        if (parent[ni] !== -2) continue;
        if (ni !== goal && (avoid.has(ni) || blocked.has(ni))) continue;
        if (!canStepFrom(table, cx, cy, dir)) continue;
        parent[ni] = cur;
        queue.push(ni);
      }
    }
    if (parent[goal] === -2) return null;
    let cur = goal;
    let p = parent[cur]!;
    while (p !== start) {
      cur = p;
      p = parent[cur]!;
      if (p < 0) return null;
    }
    const sx = start % W;
    const sy = Math.floor(start / W);
    const nx = cur % W;
    const ny = Math.floor(cur / W);
    if (nx === sx + 1) return 3;
    if (nx === sx - 1) return 1;
    if (ny === sy + 1) return 0;
    return 2;
  }

  /** Walk to (tx,ty) along a BFS route recomputed at every tile boundary.
   *  Callers stop one tile short of a playerTouch transfer pad and enter
   *  it with an explicit step, since the landing swaps the map. When a
   *  wandering NPC blocks the only corridor the driver idles until it
   *  moves; its RNG motion is part of the deterministic fold. */
  walkTo(tx: number, ty: number, maxFrames = 6000): void {
    const avoid = this.pads();
    if (this.session.ticksPerFrame > 1) {
      const plan = searchWalk({ session: this.session, state: this.state, prevMask: this.prev, tx, ty, avoid });
      plan.masks.forEach((mask, i) => {
        this.go(mask);
        if (JSON.stringify(this.state.move) !== JSON.stringify(plan.states[i]!.move)) {
          throw new Error(`journey: replay of the ${this.hz} Hz plan to (${tx},${ty}) diverged at step ${i}`);
        }
      });
      return;
    }
    let blockedFor = 0;
    for (let i = 0; i < maxFrames; i++) {
      const s = this.state;
      if (s.move.tx === tx && s.move.ty === ty && !s.move.moving) return;
      let held: number;
      if (s.move.moving) {
        held = this.prev; // carry the committed step's held direction
      } else {
        const dir = this.nextStep(tx, ty, avoid);
        if (dir === null) {
          if (s.move.tx === tx && s.move.ty === ty) return;
          if (++blockedFor > this.hz * 10) {
            throw new Error(`journey: route to (${tx},${ty}) blocked at (${s.move.tx},${s.move.ty})`);
          }
          held = 0;
        } else {
          blockedFor = 0;
          held = DIR_BTN[dir];
        }
      }
      this.go(held);
    }
    const s = this.state;
    throw new Error(`journey: never reached (${tx},${ty}); at ${s.mapId}(${s.move.tx},${s.move.ty})`);
  }

  /** Pulse confirm on alternating frames until no blocking fiber or fade
   *  remains (and the current map is `wantMap` when given). */
  settle(wantMap?: string, maxFrames = 6000): void {
    let confirm = true;
    const awaited = this.state.interp.main?.key ?? null;
    for (let i = 0; i < maxFrames; i++) {
      const s = this.state;
      const quiet = !s.fade && (!wantMap || s.mapId === wantMap);
      if (s.interp.main === null && quiet) return;
      // A frame of several reference ticks can close the awaited fiber and
      // start a follow-on autorun (the victory page) before the frame ends;
      // at 60 Hz that boundary shows main === null first. Stop at the same
      // world event either way.
      if (this.session.ticksPerFrame > 1 && awaited !== null && s.interp.main !== null && s.interp.main.key !== awaited && quiet) return;
      this.go(confirm ? BTN_CIRCLE : 0);
      confirm = !confirm;
    }
    throw new Error("journey: settle timed out");
  }

  /** Face `dir` and stay on the boundary: one held frame against the
   *  (blocking) event one tile away turns the mover without entering it. */
  face(dir: Dir4): void {
    this.go(DIR_BTN[dir]);
  }

  /** Commit exactly one tile step toward `dir` (the remaining step frames
   *  fold under a released mask; a step finishes without a held button).
   *  Used to step onto a transfer pad. */
  stepOnce(dir: Dir4): void {
    this.go(DIR_BTN[dir]);
  }

  /** Pulse confirm to open the blocking event one tile in front (the
   *  caller rests adjacent and faces it), then settle through its fiber. */
  talkFacing(): void {
    this.go(BTN_CIRCLE);
    this.settle();
  }
}

/** Play the full winning run at the given virtual frame rate. */
export function playWinningRun(hz = 60): JourneyResult & { milestones: JourneyMilestones } {
  const d = new Driver(hz);

  // 1. Village chest (17,3): enter the house through the (16,5) door, rest
  //    south of the chest at (17,4), face up, open it (25 gold + key).
  d.walkTo(17, 4);
  d.face(2);
  d.talkFacing();
  const chest = d.states.length - 1;

  // 2. Out of the house and north through the (9,0) gate pad to the wood.
  //    The pad is a transfer: walk to (9,1), then one explicit step up.
  d.walkTo(9, 1);
  d.stepOnce(2);
  d.settle("forest");
  const forest = d.states.length - 1;

  // 3. Up the corridor to the rune stone (9,4); talk from (9,5) facing up.
  d.walkTo(9, 5);
  d.face(2);
  d.talkFacing();
  const rune = d.states.length - 1;

  // 4. North to the thorn gate (9,0) — the iron key parts it and fades
  //    into the cave.
  d.walkTo(9, 1);
  d.face(2);
  d.go(BTN_CIRCLE);
  d.settle("cave");
  const cave = d.states.length - 1;

  // 5. Chamber to the iron gate (9,3): talk from (9,4) facing up; the
  //    lit rune opens it.
  d.walkTo(9, 4);
  d.face(2);
  d.talkFacing();
  const gate = d.states.length - 1;

  // 6. Step onto the opened gate tile and rest below the relic (9,3),
  //    which blocks (9,2); face up and open the altar. The run ends as the
  //    altar fiber closes with "won" set; the victory autorun then plays
  //    on its own (the attract end-hold shows it).
  d.walkTo(9, 3);
  d.face(2);
  d.talkFacing();
  const end = d.states.length - 1;

  return {
    masks: d.masks,
    states: d.states,
    hz,
    milestones: { chest, forest, rune, cave, gate, end },
  };
}
