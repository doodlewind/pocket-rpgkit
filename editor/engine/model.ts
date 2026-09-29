// editor/engine/model.ts — pure tile-edit model: selected
// palette tile/layer/map, one mutable stroke, and an undo/redo log capped at
// HISTORY_LIMIT strokes. No host APIs: sim tests and the UI share this file.

import type { MapDef, Project, TileId } from "../../src/engine/types.ts";

export type Layer = "ground" | "upper";
export const HISTORY_LIMIT = 64; // spec: undo/redo for at least 32 steps

/** Dense upper layer, length width*height: null = no star-layer cell. */
export type DenseUpper = (TileId | null)[];

interface HistoryEntry {
  mapIndex: number;
  layer: Layer;
  /** Layer array snapshots around the stroke (structural sharing: arrays
   *  are replaced, never mutated). */
  before: TileId[];
  after: TileId[];
}

interface OpenStroke {
  mapIndex: number;
  layer: Layer;
  /** Tile painted by this stroke; null = an erase stroke. Fixed at press
   *  time so changing the palette selection mid-drag cannot mix brushes. */
  brush: TileId;
  before: TileId[];
}

export interface EditorState {
  project: Project;
  mapIndex: number;
  layer: Layer;
  /** Selected paint tile ("town.43"); null = eraser. */
  tile: TileId;
  /** Per-map dense upper caches; a map enters the touched set the first
   *  time its upper layer is painted, and export compacts ONLY touched
   *  maps back to sparse pairs — untouched maps serialize their original
   *  [index, tile] ordering byte-for-byte. */
  upperDense: DenseUpper[];
  upperTouched: boolean[];
  groundTouched: boolean[];
  stroke: OpenStroke | null;
  past: HistoryEntry[];
  future: HistoryEntry[];
  dirty: boolean;
}

export function toDenseUpper(map: MapDef): DenseUpper {
  const dense: DenseUpper = new Array(map.width * map.height).fill(null);
  for (const [index, tile] of map.upper ?? []) {
    if (index >= 0 && index < dense.length) dense[index] = tile;
  }
  return dense;
}

export function fromDenseUpper(dense: DenseUpper): [number, TileId][] {
  const pairs: [number, TileId][] = [];
  dense.forEach((tile, index) => {
    if (tile !== null) pairs.push([index, tile]);
  });
  return pairs;
}

export function createEditorState(project: Project): EditorState {
  return {
    project,
    mapIndex: 0,
    layer: "ground",
    tile: null,
    upperDense: project.maps.map(toDenseUpper),
    upperTouched: project.maps.map(() => false),
    groundTouched: project.maps.map(() => false),
    stroke: null,
    past: [],
    future: [],
    dirty: false,
  };
}

export function currentMap(state: EditorState): MapDef {
  return state.project.maps[state.mapIndex]!;
}

export function canUndo(state: EditorState): boolean {
  return state.past.length > 0;
}
export function canRedo(state: EditorState): boolean {
  return state.future.length > 0;
}

const TILE_RE = /^([a-z0-9_-]+)\.(\d+)$/;

/** A tile paints on a map only when its sheet is one of that map's sheets
 *  and the cell index is inside the sheet grid (src/data/schema.json patterns
 *  catch the shape; this catches cross-sheet references the schema cannot). */
export function canPaint(state: EditorState, tile: string): boolean {
  const m = TILE_RE.exec(tile);
  if (!m) return false;
  const map = currentMap(state);
  const sheetId = m[1]!;
  if (!(map.sheets ?? []).includes(sheetId)) return false;
  const sheet = state.project.sheets.find((s) => s.id === sheetId);
  if (!sheet) return false;
  const cell = Number(m[2]!);
  return cell >= 0 && cell < sheet.cols * sheet.rows;
}

function layerArray(state: EditorState, mapIndex: number, layer: Layer): TileId[] {
  const map = state.project.maps[mapIndex]!;
  return layer === "ground" ? map.ground : state.upperDense[mapIndex]!;
}

export function selectTile(state: EditorState, tile: TileId): EditorState {
  if (tile === null) return { ...state, tile: null };
  if (!TILE_RE.test(tile) || !canPaint(state, tile)) return state;
  return { ...state, tile };
}

export function selectLayer(state: EditorState, layer: Layer): EditorState {
  if (state.layer === layer) return state;
  // A switch mid-stroke commits nothing: the pointer-up model guarantees
  // the stroke closed, but stay defensive so history cannot wedge.
  return { ...state, layer, stroke: state.stroke ? null : state.stroke };
}

export function selectMap(state: EditorState, mapIndex: number): EditorState {
  if (mapIndex === state.mapIndex || mapIndex < 0 || mapIndex >= state.project.maps.length) {
    return state;
  }
  return { ...state, mapIndex, stroke: null };
}

function withLayer(state: EditorState, mapIndex: number, layer: Layer, next: TileId[]): EditorState {
  if (layer === "ground") {
    const maps = state.project.maps.slice();
    maps[mapIndex] = { ...maps[mapIndex]!, ground: next as (string | null)[] };
    const groundTouched = state.groundTouched.slice();
    groundTouched[mapIndex] = true;
    return { ...state, project: { ...state.project, maps }, groundTouched };
  }
  const upperDense = state.upperDense.slice();
  upperDense[mapIndex] = next as DenseUpper;
  const upperTouched = state.upperTouched.slice();
  upperTouched[mapIndex] = true;
  return { ...state, upperDense, upperTouched };
}

/** Begin a drag stroke on the active map/layer. `erase` selects the eraser
 *  brush for this stroke regardless of the palette selection (right button
 *  / modifier). The pre-stroke array is captured once for the undo log. */
export function strokeStart(state: EditorState, erase = false): EditorState {
  if (state.stroke) return state;
  const brush = erase ? null : state.tile;
  return {
    ...state,
    stroke: {
      mapIndex: state.mapIndex,
      layer: state.layer,
      brush,
      before: layerArray(state, state.mapIndex, state.layer).slice(),
    },
  };
}

/** Paint (or erase, when the stroke's brush is null) one cell. Cells outside
 *  the map and non-eraser strokes with an unselected tile are no-ops. */
export function paintCell(state: EditorState, index: number): EditorState {
  const stroke = state.stroke;
  if (!stroke || stroke.mapIndex !== state.mapIndex || stroke.layer !== state.layer) return state;
  const map = state.project.maps[stroke.mapIndex]!;
  if (index < 0 || index >= map.width * map.height) return state;
  const layer = stroke.layer;
  const current = layerArray(state, stroke.mapIndex, layer).slice();
  const next = stroke.brush;
  if (next !== null && !canPaint(state, next)) return state;
  if (current[index] === next) return state;
  current[index] = next;
  return { ...withLayer(state, stroke.mapIndex, layer, current), dirty: true };
}

/** Close the stroke: push one history entry covering every cell the drag
 *  touched and clear the redo branch. A stroke that changed nothing records
 *  no history (e.g. a press on an out-of-range cell). */
export function strokeEnd(state: EditorState): EditorState {
  const stroke = state.stroke;
  if (!stroke) return state;
  const after = layerArray(state, stroke.mapIndex, stroke.layer);
  let changed = after.length !== stroke.before.length;
  for (let i = 0; !changed && i < after.length; i++) {
    if (after[i] !== stroke.before[i]) changed = true;
  }
  if (!changed) return { ...state, stroke: null };
  const entry: HistoryEntry = {
    mapIndex: stroke.mapIndex,
    layer: stroke.layer,
    before: stroke.before,
    after: after.slice(),
  };
  const past = [...state.past, entry];
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
  return { ...state, stroke: null, past, future: [] };
}

function applyHistory(state: EditorState, entry: HistoryEntry): EditorState {
  return withLayer(state, entry.mapIndex, entry.layer, entry.before.slice());
}

export function undo(state: EditorState): EditorState {
  const entry = state.past[state.past.length - 1];
  if (!entry || state.stroke) return state;
  const restored = applyHistory(state, entry);
  return {
    ...restored,
    past: state.past.slice(0, -1),
    future: [...state.future, { ...entry, before: entry.before.slice(), after: entry.after.slice() }],
    mapIndex: entry.mapIndex,
    layer: entry.layer,
    dirty: true,
  };
}

export function redo(state: EditorState): EditorState {
  const entry = state.future[state.future.length - 1];
  if (!entry || state.stroke) return state;
  const reapplied = withLayer(state, entry.mapIndex, entry.layer, entry.after.slice());
  return {
    ...reapplied,
    past: [...state.past, { ...entry, before: entry.before.slice(), after: entry.after.slice() }],
    future: state.future.slice(0, -1),
    mapIndex: entry.mapIndex,
    layer: entry.layer,
    dirty: true,
  };
}

/** Compact one touched upper layer back to sparse pairs. The runtime's
 *  dense rule is "the last pair at an index wins", so an UNEDITED index can
 *  legitimately hold several authored pairs (the village fences do): keep
 *  every one of those pairs verbatim. An edited index drops its authored
 *  pairs and emits the single new pair; an erased index emits nothing.
 *  Brand-new cells append in row-major order. */
export function compactUpper(original: [number, TileId][] | undefined, dense: DenseUpper): [number, TileId][] {
  const originalIndices = new Set<number>();
  const lastOriginal = new Map<number, TileId>();
  for (const [index, tile] of original ?? []) {
    originalIndices.add(index);
    lastOriginal.set(index, tile);
  }
  const pairs: [number, TileId][] = [];
  // 1. authored pairs: untouched indices keep every pair verbatim (duplicate
  //    indices are legal; the last pair is what the runtime paints).
  for (const [index, tile] of original ?? []) {
    if (dense[index] === lastOriginal.get(index)) pairs.push([index, tile]);
  }
  // 2. edited indices emit their single new pair (erased = null, nothing).
  for (const index of originalIndices) {
    const tile = dense[index];
    if (tile !== null && tile !== lastOriginal.get(index)) pairs.push([index, tile]);
  }
  // 3. brand-new cells append in row-major order.
  dense.forEach((tile, index) => {
    if (tile !== null && !originalIndices.has(index)) pairs.push([index, tile]);
  });
  return pairs;
}

/** Export form: only touched upper maps compact (preserving authored pair
 *  order); untouched maps keep their original arrays. The result is then
 *  validated by engine/document.ts before leaving the editor. */
export function exportProject(state: EditorState): Project {
  if (state.stroke) state = strokeEnd(state);
  const maps = state.project.maps.map((map, i) => {
    if (state.upperTouched[i]) return { ...map, upper: compactUpper(map.upper, state.upperDense[i]!) };
    return map;
  });
  return { ...state.project, maps };
}

export function markSaved(state: EditorState): EditorState {
  return { ...state, dirty: false };
}

/** Event position markers the canvas overlays (display only; editing
 *  events is not implemented yet). Sorted top-to-bottom for stable z-order. */
export function eventMarkers(map: MapDef): { id: string; x: number; y: number }[] {
  return (map.events ?? [])
    .map((e) => ({ id: e.id, x: e.x, y: e.y }))
    .sort((a, b) => (a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1)));
}

/** Palette contents for a map: eraser (null) first, then every cell of
 *  every sheet the map draws from, in sheet/grid order. Slot 0 is always
 *  the eraser; slot n maps to paletteTiles(state)[n]. */
export function paletteTiles(state: EditorState): TileId[] {
  const map = currentMap(state);
  const tiles: TileId[] = [null];
  for (const sheetId of map.sheets ?? []) {
    const sheet = state.project.sheets.find((s) => s.id === sheetId);
    if (!sheet) continue;
    for (let cell = 0; cell < sheet.cols * sheet.rows; cell++) tiles.push(`${sheetId}.${cell}`);
  }
  return tiles;
}

/** Palette slot holding a tile id, or -1 when it is not in the current
 *  map's palette (map switch made the selection stale). */
export function slotForTile(tiles: TileId[], tile: TileId): number {
  if (tile === null) return 0;
  const i = tiles.indexOf(tile);
  return i >= 0 ? i : -1;
}
