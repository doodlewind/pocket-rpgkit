// tools/lib/bake.ts — game-agnostic asset baking pipeline for Pocket RPG
// Kit projects. A project authors maps as tile-id arrays over one or more
// 16px cell sheets (rpgkit-project/v1); this module:
//
//   - slices a source tile sheet PNG into RGBA cells,
//   - paints a map's dense ground layer and sparse upper star layer into
//     square RGBA canvases (alpha compositing for star-layer gaps),
//   - extracts the 12 static walker frames (4 facings x idle/step-L/step-R)
//     from 4x1 walker atlases,
//   - encodes PNGs via the vendored PocketJS codec.
//
// Nothing here knows a specific game: the caller passes the Project and the
// source files. The pak build (vendor/pocketjs/tools/build.ts) bakes the
// emitted PNGs; images.json marks them PSM_4444 (2 B/px, exact for art with
// only 0/255 alpha like the Kenney sheets).

import { decodePng } from "../../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../../vendor/pocketjs/tests/png.ts";
import type { MapDef, TileId } from "../../src/engine/types.ts";

export interface SheetImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export interface TileCells {
  cols: number;
  rows: number;
  tile: number;
  cell: (index: number) => Uint8Array;
}

/** Decode a sheet PNG and slice it into `cols*rows` square RGBA cells. */
export async function loadTileCells(path: string, cols: number, rows: number, tile = 16): Promise<TileCells> {
  const png = decodePng(new Uint8Array(await Bun.file(path).arrayBuffer()));
  if (png.width !== cols * tile || png.height !== rows * tile) {
    throw new Error(`${path}: expected ${cols * tile}x${rows * tile}, got ${png.width}x${png.height}`);
  }
  const cache = new Map<number, Uint8Array>();
  return {
    cols,
    rows,
    tile,
    cell(index: number): Uint8Array {
      const hit = cache.get(index);
      if (hit) return hit;
      const cx = index % cols;
      const cy = Math.floor(index / cols);
      const out = new Uint8Array(tile * tile * 4);
      for (let y = 0; y < tile; y++) {
        const src = ((cy * tile + y) * png.width + cx * tile) * 4;
        out.set(png.rgba.subarray(src, src + tile * 4), y * tile * 4);
      }
      cache.set(index, out);
      return out;
    },
  };
}

/** Alpha-composite one square tile onto a canvas at pixel origin. */
export function blitTile(canvas: Uint8Array, canvasW: number, px0: number, py0: number, art: Uint8Array, tile = 16): void {
  for (let y = 0; y < tile; y++) {
    for (let x = 0; x < tile; x++) {
      const sp = (y * tile + x) * 4;
      const a = art[sp + 3]!;
      const dp = ((py0 + y) * canvasW + (px0 + x)) * 4;
      if (a === 255) {
        canvas.set(art.subarray(sp, sp + 4), dp);
      } else if (a !== 0) {
        for (let k = 0; k < 4; k++) {
          const below = canvas[dp + k]!;
          canvas[dp + k] = k === 3 ? a : Math.round((art[sp + k]! * a + below * (255 - a)) / 255);
        }
      }
    }
  }
}

function tileParts(id: TileId): { sheet: string; cell: number } | null {
  if (id === null) return null;
  const dot = id.lastIndexOf(".");
  return { sheet: id.slice(0, dot), cell: Number(id.slice(dot + 1)) };
}

export interface BakedMap {
  /** Painted map size in pixels (canvas may be larger, padded). */
  widthPx: number;
  heightPx: number;
  ground: Buffer;
  upper: Buffer;
}

export interface BakeOptions {
  /** Square canvas edge in pixels (pow2 <= TEX_MAX_DIM; 512 for PSP). */
  canvasPx?: number;
  /** RGBA fill stamped behind the ground layer's map rectangle. Defaults to
   *  opaque black (the host viewport letterboxes the remainder anyway). */
  pad?: [number, number, number, number];
}

/** Paint one map's two layers into square canvases, one PNG Buffer each.
 *  Ground starts as the pad fill and receives every dense cell; upper
 *  starts transparent and receives the sparse star-layer entries. Tile ids
 *  resolve through `cells` keyed by sheet id. */
export function bakeMap(map: MapDef, cells: ReadonlyMap<string, TileCells>, opts: BakeOptions = {}): BakedMap {
  const canvasPx = opts.canvasPx ?? 512;
  const tile = 16;
  if (map.width * tile > canvasPx || map.height * tile > canvasPx) {
    throw new Error(`map ${map.id} (${map.width}x${map.height}) exceeds the ${canvasPx}px canvas`);
  }
  const pad: [number, number, number, number] = opts.pad ?? [0, 0, 0, 255];
  const fillTile = (): Uint8Array => {
    const out = new Uint8Array(tile * tile * 4);
    for (let i = 0; i < tile * tile; i++) out.set(pad, i * 4);
    return out;
  };
  const artFor = (id: TileId): Uint8Array | null => {
    const parts = tileParts(id);
    if (!parts) return null;
    const sheet = cells.get(parts.sheet);
    if (!sheet) throw new Error(`bake: unknown sheet "${parts.sheet}" in tile ${id}`);
    return sheet.cell(parts.cell);
  };

  const ground = new Uint8Array(canvasPx * canvasPx * 4);
  const grass = fillTile();
  for (let py = 0; py < canvasPx; py += tile) {
    for (let px = 0; px < canvasPx; px += tile) blitTile(ground, canvasPx, px, py, grass, tile);
  }
  for (let ty = 0; ty < map.height; ty++) {
    for (let tx = 0; tx < map.width; tx++) {
      const art = artFor(map.ground[ty * map.width + tx] ?? null);
      if (art) blitTile(ground, canvasPx, tx * tile, ty * tile, art, tile);
    }
  }

  const upper = new Uint8Array(canvasPx * canvasPx * 4);
  for (const [idx, id] of map.upper ?? []) {
    const art = artFor(id);
    if (art) blitTile(upper, canvasPx, (idx % map.width) * tile, Math.floor(idx / map.width) * tile, art, tile);
  }

  return {
    widthPx: map.width * tile,
    heightPx: map.height * tile,
    ground: encodePNG(ground, canvasPx, canvasPx),
    upper: encodePNG(upper, canvasPx, canvasPx),
  };
}

export interface WalkerFrames {
  /** Facing order 0 down, 1 left, 2 up, 3 right — engine Facing order. */
  idle: Buffer[];
  walkL: Buffer[];
  walkR: Buffer[];
}

/** Slice four 4x1 walker atlases into 12 static 16x16 frames. Each atlas is
 *  [walk-L, idle, walk-R, empty]; the engine picks the image from the saved
 *  mover phase (never a host clock), so a restored tape renders the same
 *  pixels at any host frame offset. */
export async function loadWalker(atlasPaths: readonly string[]): Promise<WalkerFrames> {
  const idle: Buffer[] = [];
  const walkL: Buffer[] = [];
  const walkR: Buffer[] = [];
  for (const path of atlasPaths) {
    const png = decodePng(new Uint8Array(await Bun.file(path).arrayBuffer()));
    const tile = 16;
    if (png.height !== tile || png.width !== 4 * tile) {
      throw new Error(`${path}: expected a 4x1 strip of ${tile}px cells`);
    }
    const copy = (cell: number): Buffer => {
      const out = new Uint8Array(tile * tile * 4);
      for (let y = 0; y < tile; y++) {
        const src = (y * png.width + cell * tile) * 4;
        out.set(png.rgba.subarray(src, src + tile * 4), y * tile * 4);
      }
      return encodePNG(out, tile, tile);
    };
    walkL.push(copy(0));
    idle.push(copy(1));
    walkR.push(copy(2));
  }
  return { idle, walkL, walkR };
}

/** Twelve frame PNGs cut from a sheet, in engine facing order
 *  (0 down, 1 left, 2 up, 3 right) x (idle, walkL, walkR). Frame size is
 *  cellW x cellH; the sheets are taller than one tile, their extra rows
 *  overflow UPWARD and GameView anchors the frame to the occupied tile's
 *  bottom. */
export interface WalkerSheetFrames extends WalkerFrames {
  /** Frame width in pixels (always 16 for the kit). */
  cellW: number;
  /** Frame height in pixels (16 square or 32 for a Tuxemon walker). */
  cellH: number;
}

/** Where each engine facing/pose lives on a source sheet. */
export interface WalkerSheetLayout {
  /** Engine facing index (0 down,1 left,2 up,3 right) -> sheet row. */
  rowForFacing: readonly [number, number, number, number];
  /** Sheet columns for the three poses. */
  idleCol: number;
  walkLCol: number;
  walkRCol: number;
}

export interface WalkerSheetOptions {
  cols?: number;
  rows?: number;
  cellW?: number;
  cellH?: number;
  layout?: WalkerSheetLayout;
}

/**
 * The Tuxemon character sheet: 3 columns x 4 rows of 16x32 cells.
 * Rows run down, left, RIGHT, up; columns run walk-L, idle, walk-R. The
 * engine facing order is down, left, UP, right, so rows 2 and 3 swap.
 * (Scout S1 §8: sprites/<name>.png 48x128; idle is the middle column.)
 */
export const TUXEMON_WALKER_LAYOUT: WalkerSheetLayout = {
  rowForFacing: [0, 1, 3, 2], // engine down,left,up,right <- sheet rows
  idleCol: 1,
  walkLCol: 0,
  walkRCol: 2,
};

/** Slice decoded walker pixels (default a Tuxemon 3x4 of 16x32 cells) into
 *  twelve frame PNGs in engine order. This pure form lets importers and
 *  tests use an already-decoded source without a second filesystem read. */
export function sliceWalkerSheet(
  png: SheetImage,
  opts: WalkerSheetOptions = {},
  source = "walker sheet",
): WalkerSheetFrames {
  const cellW = opts.cellW ?? 16;
  const cellH = opts.cellH ?? 32;
  const cols = opts.cols ?? 3;
  const rows = opts.rows ?? 4;
  const layout = opts.layout ?? TUXEMON_WALKER_LAYOUT;
  if (
    !Number.isInteger(cellW) || cellW < 1 ||
    !Number.isInteger(cellH) || cellH < 1 ||
    !Number.isInteger(cols) || cols < 1 ||
    !Number.isInteger(rows) || rows < 1
  ) {
    throw new Error(`${source}: walker grid and cell sizes must be positive integers`);
  }
  if (png.width !== cols * cellW || png.height !== rows * cellH) {
    throw new Error(`${source}: expected a ${cols}x${rows} sheet of ${cellW}x${cellH} cells, got ${png.width}x${png.height}`);
  }
  const poseColumns = [layout.idleCol, layout.walkLCol, layout.walkRCol];
  if (
    layout.rowForFacing.some((row) => !Number.isInteger(row) || row < 0 || row >= rows) ||
    poseColumns.some((col) => !Number.isInteger(col) || col < 0 || col >= cols)
  ) {
    throw new Error(`${source}: walker layout addresses a cell outside the ${cols}x${rows} sheet`);
  }
  const copy = (col: number, row: number): Buffer => {
    const out = new Uint8Array(cellW * cellH * 4);
    for (let y = 0; y < cellH; y++) {
      const src = ((row * cellH + y) * png.width + col * cellW) * 4;
      out.set(png.rgba.subarray(src, src + cellW * 4), y * cellW * 4);
    }
    return encodePNG(out, cellW, cellH);
  };
  const cut = (col: number): Buffer[] =>
    [0, 1, 2, 3].map((facing) => copy(col, layout.rowForFacing[facing]!));
  return {
    idle: cut(layout.idleCol),
    walkL: cut(layout.walkLCol),
    walkR: cut(layout.walkRCol),
    cellW,
    cellH,
  };
}

/** Decode and slice one grid walker sheet. Deterministic; the same sheet
 *  yields the same twelve PNG byte streams on every run. */
export async function loadWalkerSheet(
  path: string,
  opts: WalkerSheetOptions = {},
): Promise<WalkerSheetFrames> {
  const png = decodePng(new Uint8Array(await Bun.file(path).arrayBuffer()));
  return sliceWalkerSheet(png, opts, path);
}
