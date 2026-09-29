// tools/lib/stream.ts — deterministic build-time encoding for viewport-
// streamed map chunks. Each layer becomes one CLUT8 + PackBits TILESET pak
// entry while its colours fit one palette; a wider layer falls back to one
// palette/entry per non-empty chunk. Runtime refs always name the exact pak
// key and tile index that loadTileTexture() consumes.

import { encodeTilesetEntry, type TilesetTile } from "../../vendor/pocketjs/framework/compiler/pak.ts";
import { TILESET_FLAG_RLE, keyTileset } from "../../vendor/pocketjs/contracts/spec/spec.ts";
import { TILE } from "../../src/engine/tiles.ts";

/** Streaming uses smaller chunks than the legacy 512px baked-image path. */
export const STREAM_CHUNK_PX = 256;

export interface StreamedLayer {
  /** Base TILESET key. Split layers append `-<chunk index>` to this key. */
  key: string;
  /** Row-major `ui:tile.*#<tile>` refs; null means a fully transparent chunk. */
  refs: readonly (string | null)[];
  columns: number;
  rows: number;
}

export interface StreamEntry {
  /** Full pak key (`ui:tile.*`). */
  key: string;
  /** Complete TILESET entry bytes, ready for an app's pak.json. */
  blob: Uint8Array;
}

export interface StreamEncodeReport {
  /** Distinct layer colours including the reserved transparent colour. */
  colours: number;
  /** Whether the layer exceeded one palette and was split by chunk. */
  split: boolean;
  /** Fully transparent chunks, represented by null refs. */
  absent: number;
  /** Emitted TILESET entries (zero for an entirely transparent layer). */
  entries: number;
  /** Total bytes across emitted entries. */
  bytes: number;
  /** Chunks whose own colour count exceeded maxColours and were quantized. */
  quantized: number;
}

export interface StreamEncodeOptions {
  /** Power-of-two RGBA chunk edge; defaults to 256. */
  chunkPx?: number;
  /** Palette colours including transparent index 0; defaults to 256. */
  maxColours?: number;
}

export interface EncodedStreamedLayer {
  entries: StreamEntry[];
  layer: StreamedLayer;
  report: StreamEncodeReport;
}

const TRANSPARENT = 0;

/** RGBA bytes -> the ABGR u32 word stored in a PocketJS CLUT. */
function abgr(r: number, g: number, b: number, a: number): number {
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/** Alpha-zero texels are one canonical transparent colour regardless of RGB. */
function pixelWord(rgba: Uint8Array, offset: number): number {
  return rgba[offset + 3] === 0
    ? TRANSPARENT
    : abgr(rgba[offset]!, rgba[offset + 1]!, rgba[offset + 2]!, rgba[offset + 3]!);
}

function addColours(into: Map<number, number>, rgba: Uint8Array): void {
  for (let i = 0; i < rgba.length; i += 4) {
    const word = pixelWord(rgba, i);
    into.set(word, (into.get(word) ?? 0) + 1);
  }
}

function colourCensus(rgba: Uint8Array): Map<number, number> {
  const out = new Map<number, number>();
  addColours(out, rgba);
  // Index zero is reserved even when an opaque chunk does not use it.
  if (!out.has(TRANSPARENT)) out.set(TRANSPARENT, 0);
  return out;
}

function isAbsent(rgba: Uint8Array): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 0) return false;
  return true;
}

interface Palette {
  words: Uint32Array;
  indices: Map<number, number>;
  quantized: boolean;
}

/** Deterministic exact palette when possible, nearest-colour fallback when a
 * single chunk itself is wider than CLUT8. Frequency wins, then ABGR value;
 * nearest matching includes alpha so translucent edges stay sensible. */
function makePalette(census: Map<number, number>, maxColours: number): Palette {
  const ranked = [...census]
    .filter(([word]) => word !== TRANSPARENT)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const keep = ranked.slice(0, maxColours - 1);
  const words = new Uint32Array(256);
  const indices = new Map<number, number>([[TRANSPARENT, 0]]);
  for (let i = 0; i < keep.length; i++) {
    words[i + 1] = keep[i]![0];
    indices.set(keep[i]![0], i + 1);
  }

  const quantized = ranked.length > keep.length;
  for (const [word] of ranked.slice(keep.length)) {
    const r = word & 0xff;
    const g = (word >>> 8) & 0xff;
    const b = (word >>> 16) & 0xff;
    const a = word >>> 24;
    let best = 1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 1; i <= keep.length; i++) {
      const candidate = words[i]!;
      const dr = r - (candidate & 0xff);
      const dg = g - ((candidate >>> 8) & 0xff);
      const db = b - ((candidate >>> 16) & 0xff);
      const da = a - (candidate >>> 24);
      const distance = dr * dr + dg * dg + db * db + da * da;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    indices.set(word, best);
  }
  return { words, indices, quantized };
}

function indexedPixels(rgba: Uint8Array, palette: Palette): Uint8Array {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    out[p] = palette.indices.get(pixelWord(rgba, i))!;
  }
  return out;
}

function validateName(name: string): void {
  if (!name || name.includes("#")) throw new Error(`stream: invalid layer name ${JSON.stringify(name)}`);
}

/** Encode one row-major RGBA chunk layer into TILESET entry blobs and refs. */
export function encodeStreamedLayer(
  name: string,
  chunks: readonly Uint8Array[],
  columns: number,
  rows: number,
  opts: StreamEncodeOptions = {},
): EncodedStreamedLayer {
  validateName(name);
  const chunkPx = opts.chunkPx ?? STREAM_CHUNK_PX;
  const maxColours = opts.maxColours ?? 256;
  if (!Number.isInteger(chunkPx) || chunkPx < 1 || chunkPx > 512 || (chunkPx & (chunkPx - 1)) !== 0) {
    throw new Error(`stream: chunkPx must be a power of two in 1..512, got ${chunkPx}`);
  }
  if (!Number.isInteger(maxColours) || maxColours < 2 || maxColours > 256) {
    throw new Error(`stream: maxColours must be an integer in 2..256, got ${maxColours}`);
  }
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1) {
    throw new Error(`stream: bad chunk grid ${columns}x${rows}`);
  }
  if (chunks.length !== columns * rows) {
    throw new Error(`stream: ${chunks.length} chunks != grid ${columns}x${rows}`);
  }
  const expectedBytes = chunkPx * chunkPx * 4;
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i]!.length !== expectedBytes) {
      throw new Error(`stream: chunk ${i} has ${chunks[i]!.length} RGBA bytes, want ${expectedBytes}`);
    }
  }

  const layerCensus = new Map<number, number>();
  for (const chunk of chunks) addColours(layerCensus, chunk);
  if (!layerCensus.has(TRANSPARENT)) layerCensus.set(TRANSPARENT, 0);
  const split = layerCensus.size > maxColours;
  const baseKey = keyTileset(name);
  const entries: StreamEntry[] = [];
  const refs: (string | null)[] = new Array(chunks.length).fill(null);
  let absent = 0;
  let quantized = 0;

  if (!split) {
    const palette = makePalette(layerCensus, maxColours);
    const tiles: TilesetTile[] = chunks.map((chunk, i) => {
      if (isAbsent(chunk)) {
        absent++;
        return { kind: "absent" };
      }
      refs[i] = `${baseKey}#${i}`;
      return { kind: "pixels", indices: indexedPixels(chunk, palette) };
    });
    if (absent !== chunks.length) {
      entries.push({
        key: baseKey,
        blob: encodeTilesetEntry({
          tileW: chunkPx,
          tileH: chunkPx,
          cols: columns,
          rows,
          flags: TILESET_FLAG_RLE,
          palette: palette.words,
          tiles,
        }),
      });
    }
  } else {
    // A split layer uses one palette per chunk. Identical RGBA chunks reuse
    // the first complete entry/ref, preserving byte sharing across the layer
    // even though their palettes can no longer be shared globally.
    const refByPixels = new Map<string, string>();
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      if (isAbsent(chunk)) {
        absent++;
        continue;
      }
      const signatureBytes = chunk.slice();
      for (let p = 0; p < signatureBytes.length; p += 4) {
        if (signatureBytes[p + 3] === 0) {
          signatureBytes[p] = 0;
          signatureBytes[p + 1] = 0;
          signatureBytes[p + 2] = 0;
        }
      }
      const signature = Buffer.from(signatureBytes).toString("base64");
      const shared = refByPixels.get(signature);
      if (shared) {
        refs[i] = shared;
        continue;
      }
      const palette = makePalette(colourCensus(chunk), maxColours);
      if (palette.quantized) quantized++;
      const key = keyTileset(`${name}-${i}`);
      const blob = encodeTilesetEntry({
        tileW: chunkPx,
        tileH: chunkPx,
        cols: 1,
        rows: 1,
        flags: TILESET_FLAG_RLE,
        palette: palette.words,
        tiles: [{ kind: "pixels", indices: indexedPixels(chunk, palette) }],
      });
      const ref = `${key}#0`;
      entries.push({ key, blob });
      refs[i] = ref;
      refByPixels.set(signature, ref);
    }
  }

  return {
    entries,
    layer: { key: baseKey, refs, columns, rows },
    report: {
      colours: layerCensus.size,
      split,
      absent,
      entries: entries.length,
      bytes: entries.reduce((sum, entry) => sum + entry.blob.length, 0),
      quantized,
    },
  };
}

export interface StreamManifestMap {
  id: string;
  /** Map dimensions in 16px project tiles. */
  width: number;
  height: number;
  ground: StreamedLayer;
  upper: StreamedLayer;
}

export interface StreamManifestOptions {
  chunkPx?: number;
  tilePx?: number;
  /** Optional runtime prefetch margin in pixels (default is one tile). */
  margin?: number;
  /** Optional texture uploads per layer per frame (default is unlimited). */
  loadBudget?: number;
}

function objectEntry(key: string, value: string): string {
  return key === "__proto__"
    ? `    [${JSON.stringify(key)}]: ${value},`
    : `    ${JSON.stringify(key)}: ${value},`;
}

/** Emit a deterministic object-literal source suitable for `stream:` inside
 * a generated GameAssets value. Map dimensions are in project tiles. */
export function streamManifestSource(
  maps: readonly StreamManifestMap[],
  opts: StreamManifestOptions = {},
): string {
  const chunkPx = opts.chunkPx ?? STREAM_CHUNK_PX;
  const tilePx = opts.tilePx ?? TILE;
  const ids = new Set<string>();
  for (const map of maps) {
    if (ids.has(map.id)) throw new Error(`stream manifest: duplicate map id ${JSON.stringify(map.id)}`);
    ids.add(map.id);
    const columns = Math.ceil((map.width * tilePx) / chunkPx);
    const rows = Math.ceil((map.height * tilePx) / chunkPx);
    for (const [kind, layer] of [["ground", map.ground], ["upper", map.upper]] as const) {
      if (layer.columns !== columns || layer.rows !== rows || layer.refs.length !== columns * rows) {
        throw new Error(
          `stream manifest: ${map.id} ${kind} is ${layer.columns}x${layer.rows}/${layer.refs.length}, want ${columns}x${rows}`,
        );
      }
    }
  }
  const table = (value: (map: StreamManifestMap) => string): string =>
    maps.map((map) => objectEntry(map.id, value(map))).join("\n");
  const optional = [
    opts.margin === undefined ? "" : `  margin: ${opts.margin},\n`,
    opts.loadBudget === undefined ? "" : `  loadBudget: ${opts.loadBudget},\n`,
  ].join("");
  return (
    `{\n` +
    `  chunkPx: ${chunkPx},\n` +
    optional +
    `  ground: {\n${table((map) => JSON.stringify(map.ground.refs))}\n  },\n` +
    `  upper: {\n${table((map) => JSON.stringify(map.upper.refs))}\n  },\n` +
    `  columns: {\n${table((map) => String(map.ground.columns))}\n  },\n` +
    `}`
  );
}

export interface PakManifestEntry {
  key: string;
  file: string;
}

/** Deterministic filename for a raw TILESET entry under an app directory. */
export function streamEntryFile(key: string, directory = "assets/stream"): string {
  const prefix = "ui:tile.";
  if (!key.startsWith(prefix) || key.length === prefix.length) {
    throw new Error(`stream pak: expected a ${prefix} key, got ${JSON.stringify(key)}`);
  }
  const stem = key.slice(prefix.length).replace(/[^A-Za-z0-9._-]/g, "_");
  return `${directory.replace(/\/$/, "")}/${stem}.pkts`;
}

/** Build the app-level pak.json rows for encoded stream entries. */
export function pakManifest(
  entries: readonly StreamEntry[],
  opts: { directory?: string } = {},
): PakManifestEntry[] {
  // Compare UTF-16 code units directly instead of using localeCompare, whose
  // collation can differ with the host's ICU/locale and spoil build stability.
  const sorted = [...entries].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const keys = new Set<string>();
  const files = new Set<string>();
  return sorted.map((entry) => {
    if (keys.has(entry.key)) throw new Error(`stream pak: duplicate key ${entry.key}`);
    keys.add(entry.key);
    const file = streamEntryFile(entry.key, opts.directory);
    if (files.has(file)) throw new Error(`stream pak: filename collision at ${file}`);
    files.add(file);
    return { key: entry.key, file };
  });
}
