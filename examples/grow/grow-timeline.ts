// Sparse per-seed timeline for the growth demo. One owned reducer state
// materializes history and each record keeps only metadata plus changed cells.
// Seeking moves one reusable grid cursor forward or backward through those
// edits, so no seek copies the 4096 x 33 backing layers.

import {
  cloneGrowState, createGrow, growGridEdits, growGridHash, growStateHash,
  rememberGrowGridHash, stepGrowTickOwned,
  type GrowGridEdit, type GrowParams, type GrowState,
} from "./grow.ts";

export interface GrowTimelineStats {
  seed: number;
  states: number;
  stepCalls: number;
  seeks: number;
  checkpointInterval: number;
}

const CHECKPOINT_INTERVAL = 32;

interface StateRecord {
  state: GrowState;
  edits: readonly GrowGridEdit[];
  gridHash: number;
}

export interface GrowTimelineSnapshot {
  tick: number;
  state: GrowState;
  edits: readonly GrowGridEdit[];
  gridHash: number;
}

function canonical(state: GrowState): GrowState {
  return state.frame === 0 && state.hz === 0 && state.cameraX === state.cameraFromX
    ? state
    : { ...state, frame: 0, hz: 0, cameraX: state.cameraFromX };
}

function editGrid(state: GrowState, edit: GrowGridEdit, value: number): void {
  const grid = edit.layer === "ground" ? state.ground : edit.layer === "upper" ? state.upper : state.road;
  grid[edit.index] = value;
}

export class GrowTimeline {
  readonly params: GrowParams;
  readonly #records: StateRecord[] = [];
  readonly #checkpointTicks = new Set<number>();
  readonly #hashes = new WeakMap<GrowState, string>();
  #builder: GrowState;
  #cursor: GrowState | undefined;
  #stepCalls = 0;
  #seeks = 0;

  constructor(params: GrowParams, initial: GrowState = createGrow(params)) {
    const start = canonical(initial);
    this.params = start.params;
    const gridHash = growGridHash(start);
    this.#records.push({ state: start, edits: [], gridHash });
    this.#checkpointTicks.add(0);
    // The builder owns its buffers and mutates them while recording edits.
    // The live UI keeps the initial buffers until it chooses to scrub.
    this.#builder = cloneGrowState(start);
  }

  get seed(): number { return this.params.seed; }
  get furthestTick(): number { return this.#builder.tick; }
  get complete(): boolean { return this.#builder.phase === "done"; }

  #append(): void {
    const next = canonical(stepGrowTickOwned(this.#builder));
    if (next.tick !== this.#records.length) return;
    const edits = growGridEdits(next);
    this.#records.push({ state: next, edits, gridHash: growGridHash(next) });
    if (next.tick % CHECKPOINT_INTERVAL === 0 || next.phase === "done") {
      this.#checkpointTicks.add(next.tick);
    }
    this.#builder = next;
  }

  #materializeTo(tick: number): void {
    while (this.#builder.tick < tick && this.#builder.phase !== "done") {
      this.#append();
      this.#stepCalls++;
    }
  }

  #moveCursor(target: number, reusable?: GrowState): GrowState {
    if (reusable && reusable.params.seed === this.seed && reusable.tick < this.#records.length) {
      this.#cursor = reusable;
    }
    if (!this.#cursor) this.#cursor = cloneGrowState(this.#records[0]!.state);

    const grids = this.#cursor;
    if (grids.tick < target) {
      for (let tick = grids.tick + 1; tick <= target; tick++) {
        for (const edit of this.#records[tick]!.edits) editGrid(grids, edit, edit.after);
      }
    } else if (grids.tick > target) {
      for (let tick = grids.tick; tick > target; tick--) {
        const edits = this.#records[tick]!.edits;
        for (let i = edits.length - 1; i >= 0; i--) editGrid(grids, edits[i]!, edits[i]!.before);
      }
    }

    const record = this.#records[target]!;
    const result = { ...record.state, ground: grids.ground, upper: grids.upper, road: grids.road };
    rememberGrowGridHash(result, record.gridHash);
    this.#cursor = result;
    return result;
  }

  /**
   * Return the exact reducer state at k, clamped to the terminal state.
   * A caller that no longer needs its current state may pass it as `reusable`
   * to make that state's typed arrays the seek cursor without an allocation.
   */
  at(tick: number, reusable?: GrowState): GrowState {
    this.#seeks++;
    const requested = Math.max(0, Math.round(tick));
    this.#materializeTo(requested);
    return this.#moveCursor(Math.min(requested, this.#builder.tick), reusable);
  }

  /** Extend recorded history through a bounded target without moving a cursor. */
  prefillTo(tick: number): number {
    this.#materializeTo(Math.max(0, Math.round(tick)));
    return this.#builder.tick;
  }

  /** Metadata and cell edits for an already materialized tick. */
  snapshot(tick: number): GrowTimelineSnapshot | undefined {
    const record = this.#records[Math.max(0, Math.round(tick))];
    return record ? { tick: record.state.tick, state: record.state, edits: record.edits, gridHash: record.gridHash } : undefined;
  }

  /** Materialize history and return its terminal tick without moving a cursor. */
  finish(): number {
    while (this.#builder.phase !== "done") {
      this.#append();
      this.#stepCalls++;
    }
    return this.#builder.tick;
  }

  done(): GrowState {
    return this.at(this.finish());
  }

  hash(state: GrowState): string {
    const cached = this.#hashes.get(state);
    if (cached !== undefined) return cached;
    const hash = growStateHash(state);
    this.#hashes.set(state, hash);
    return hash;
  }

  stats(): GrowTimelineStats {
    return {
      seed: this.params.seed,
      states: this.#checkpointTicks.size,
      stepCalls: this.#stepCalls,
      seeks: this.#seeks,
      checkpointInterval: CHECKPOINT_INTERVAL,
    };
  }
}
