import { describe, expect, test } from "bun:test";
import {
  encodeStreamedLayer,
  pakManifest,
  streamManifestSource,
  type StreamEntry,
} from "../tools/lib/stream.ts";
import {
  TILESET_ABSENT,
  TILESET_DIR_ENTRY_SIZE,
  TILESET_HEADER_SIZE,
  packbitsDecode,
} from "../vendor/pocketjs/contracts/spec/spec.ts";

function rgbaChunk(px: number, pixel: (x: number, y: number) => readonly [number, number, number, number]): Uint8Array {
  const out = new Uint8Array(px * px * 4);
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) out.set(pixel(x, y), (y * px + x) * 4);
  }
  return out;
}

function decode(entry: StreamEntry, tile: number): Uint8Array | null {
  const bytes = entry.blob;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const w = dv.getUint16(8, true);
  const h = dv.getUint16(10, true);
  const paletteOff = dv.getUint32(16, true);
  const dirOff = dv.getUint32(20, true);
  const dataOff = dv.getUint32(24, true);
  expect(paletteOff).toBe(TILESET_HEADER_SIZE);
  const e = dirOff + tile * TILESET_DIR_ENTRY_SIZE;
  const off = dv.getUint32(e, true);
  const len = dv.getUint32(e + 4, true);
  if (off === TILESET_ABSENT) return null;
  const indices = packbitsDecode(bytes.subarray(dataOff + off, dataOff + off + len), w * h);
  expect(indices).not.toBeNull();
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < indices!.length; i++) {
    const word = dv.getUint32(paletteOff + indices![i]! * 4, true);
    out[i * 4] = word & 0xff;
    out[i * 4 + 1] = (word >>> 8) & 0xff;
    out[i * 4 + 2] = (word >>> 16) & 0xff;
    out[i * 4 + 3] = word >>> 24;
  }
  return out;
}

describe("streamed chunk encoder", () => {
  test("CLUT8 + RLE round-trips RGBA, reserves transparent index zero, and marks absent chunks", () => {
    const art = rgbaChunk(4, (x, y) => (x === y ? [250, 30, 80, 255] : [0, 0, 0, 0]));
    const absent = rgbaChunk(4, () => [91, 72, 53, 0]);
    const encoded = encodeStreamedLayer("roundtrip", [art, art.slice(), absent], 3, 1, { chunkPx: 4 });

    expect(encoded.report).toEqual({ colours: 2, split: false, absent: 1, entries: 1, bytes: encoded.entries[0]!.blob.length, quantized: 0 });
    expect(encoded.layer.refs).toEqual([
      "ui:tile.roundtrip#0",
      "ui:tile.roundtrip#1",
      null,
    ]);
    expect(decode(encoded.entries[0]!, 0)).toEqual(art);
    expect(decode(encoded.entries[0]!, 1)).toEqual(art);
    expect(decode(encoded.entries[0]!, 2)).toBeNull();
    const dv = new DataView(encoded.entries[0]!.blob.buffer);
    expect(dv.getUint32(TILESET_HEADER_SIZE, true)).toBe(0);
    expect(dv.getUint32(TILESET_HEADER_SIZE + TILESET_DIR_ENTRY_SIZE, true)).toBe(0);
    expect(dv.getUint32(dv.getUint32(16, true), true)).toBe(0);
  });

  test("same input emits byte-identical entries, pak rows, and GameAssets.stream source", () => {
    const chunks = [
      rgbaChunk(8, (x, y) => [x * 13, y * 17, (x + y) * 9, 255]),
      rgbaChunk(8, (x, y) => [x * 7, y * 11, (x ^ y) * 19, (x + y) % 3 ? 255 : 80]),
    ];
    const a = encodeStreamedLayer("stable", chunks, 2, 1, { chunkPx: 8 });
    const b = encodeStreamedLayer("stable", chunks, 2, 1, { chunkPx: 8 });
    expect(a.entries.map((e) => [...e.blob])).toEqual(b.entries.map((e) => [...e.blob]));
    expect(pakManifest(a.entries)).toEqual(pakManifest(b.entries));
    const map = { id: "wide", width: 2, height: 1, ground: a.layer, upper: a.layer };
    expect(streamManifestSource([map], { chunkPx: 8, tilePx: 8 })).toBe(
      streamManifestSource([map], { chunkPx: 8, tilePx: 8 }),
    );
  });

  test("a layer with more than 256 colours splits into exact per-chunk entries", () => {
    const colour = (n: number): readonly [number, number, number, number] =>
      [n & 0xff, (n >>> 8) & 0xff, 40 + (n % 173), 255];
    const left = rgbaChunk(16, (x, y) => colour(1 + ((y * 16 + x) % 200)));
    const right = rgbaChunk(16, (x, y) => colour(201 + ((y * 16 + x) % 200)));
    const encoded = encodeStreamedLayer("wide-palette", [left, right], 2, 1, { chunkPx: 16 });

    expect(encoded.report.colours).toBe(401);
    expect(encoded.report.split).toBe(true);
    expect(encoded.report.quantized).toBe(0);
    expect(encoded.entries.map((e) => e.key)).toEqual([
      "ui:tile.wide-palette-0",
      "ui:tile.wide-palette-1",
    ]);
    expect(encoded.layer.refs).toEqual([
      "ui:tile.wide-palette-0#0",
      "ui:tile.wide-palette-1#0",
    ]);
    expect(decode(encoded.entries[0]!, 0)).toEqual(left);
    expect(decode(encoded.entries[1]!, 0)).toEqual(right);
  });

  test("split layers reuse an identical chunk entry and all-transparent layers emit no blob", () => {
    const a = rgbaChunk(4, (x, y) => [x * 50 + 1, y * 50 + 2, 3, 255]);
    const b = rgbaChunk(4, (x, y) => [100 + x * 20, 100 + y * 20, 4, 255]);
    const split = encodeStreamedLayer("shared", [a, b, a.slice()], 3, 1, { chunkPx: 4, maxColours: 8 });
    expect(split.report.split).toBe(true);
    expect(split.entries).toHaveLength(2);
    expect(split.layer.refs[2]).toBe(split.layer.refs[0]);

    const empty = encodeStreamedLayer("empty", [new Uint8Array(4 * 4 * 4)], 1, 1, { chunkPx: 4 });
    expect(empty.entries).toEqual([]);
    expect(empty.layer.refs).toEqual([null]);
    expect(empty.report.absent).toBe(1);
  });
});
