// src/engine/map-repository.ts — validated, independently addressable maps.
//
// Map bytes and parsed MapDefs are derived cache data. They live here (or in
// Session's compile cache), never in SessionState. The canonical JSON and
// SHA-256 routines are host-neutral so Bun, QuickJS and a future web byte
// source all accept exactly the same entries.

import PROJECT_SCHEMA from "../data/schema.json";
import { canonicalJson, utf8Encode } from "./save.ts";
import { validateSchema, type VError } from "./schema-validate.ts";
import type {
  MapDef,
  MapIndexEntry,
  MapRepository,
  ProjectShell,
  ProjectSource,
} from "./types.ts";

const SHA256_INIT = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const;
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

const rotr = (v: number, n: number): number => (v >>> n) | (v << (32 - n));

/** SHA-256 over bytes, returned as 64 lowercase hex digits. */
export function sha256Bytes(input: Uint8Array): string {
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  const end = paddedLength - 8;
  bytes[end] = high >>> 24;
  bytes[end + 1] = high >>> 16;
  bytes[end + 2] = high >>> 8;
  bytes[end + 3] = high;
  bytes[end + 4] = low >>> 24;
  bytes[end + 5] = low >>> 16;
  bytes[end + 6] = low >>> 8;
  bytes[end + 7] = low;

  const h: number[] = [...SHA256_INIT];
  const w = new Uint32Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const p = offset + i * 4;
      w[i] = ((bytes[p]! << 24) | (bytes[p + 1]! << 16) | (bytes[p + 2]! << 8) | bytes[p + 3]!) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25);
      const ch = (e! & f!) ^ (~e! & g!);
      const t1 = (hh! + s1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const s0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22);
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d! + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a!) >>> 0;
    h[1] = (h[1]! + b!) >>> 0;
    h[2] = (h[2]! + c!) >>> 0;
    h[3] = (h[3]! + d!) >>> 0;
    h[4] = (h[4]! + e!) >>> 0;
    h[5] = (h[5]! + f!) >>> 0;
    h[6] = (h[6]! + g!) >>> 0;
    h[7] = (h[7]! + hh!) >>> 0;
  }
  return h.map((v) => v.toString(16).padStart(8, "0")).join("");
}

export const sha256Text = (text: string): string => sha256Bytes(utf8Encode(text));
export const canonicalMapJson = (map: MapDef): string => canonicalJson(map);
export const mapChecksum = (map: MapDef): string => sha256Text(canonicalMapJson(map));

/** The schema identity is conservative: any normative project-schema change
 * invalidates sharded saves, including command definitions reachable from a
 * map payload. A test derives this value from data/schema.json so schema edits
 * cannot silently leave the runtime identity stale. Keeping the digest as a
 * literal prevents every inline-project bundle from embedding the 27 KB
 * authoring schema merely to start a session. */
export const MAP_SCHEMA_HASH = "c8ca2ce77e5bff0af2d15f33863014d51dfb4acf4cef14fb678a17f7dc1ecba3";

export interface MapContentIdentity {
  manifest: string;
  schema: string;
}

function shellWithoutDeclaredHashes(shell: ProjectShell): Record<string, unknown> {
  const value = { ...shell } as Record<string, unknown>;
  delete value.mapManifestHash;
  delete value.mapSchemaHash;
  return value;
}

export function mapManifestHash(shell: ProjectShell): string {
  return sha256Text(canonicalJson(shellWithoutDeclaredHashes(shell)));
}

export function shellContentIdentity(shell: ProjectShell): MapContentIdentity {
  return {
    manifest: mapManifestHash(shell),
    schema: shell.mapSchemaHash ?? MAP_SCHEMA_HASH,
  };
}

export function isProjectShell(project: ProjectSource): project is ProjectShell {
  return "mapIndex" in project;
}

function formatErrors(errors: readonly VError[]): string {
  return errors.slice(0, 3).map((e) => `${e.path}: ${e.msg}`).join("; ");
}

/** Validate one acquired map against the normative map schema plus the
 * row-major/index bounds that JSON Schema cannot express. */
export function validateMapDef(map: unknown): asserts map is MapDef {
  const mapSchema = (PROJECT_SCHEMA as { $defs: { map: Record<string, unknown> } }).$defs.map;
  const errors = validateSchema(PROJECT_SCHEMA, map, mapSchema);
  if (errors.length > 0) throw new Error(`map repository: schema mismatch: ${formatErrors(errors)}`);
  const value = map as MapDef;
  const cells = value.width * value.height;
  if (value.ground.length !== cells) {
    throw new Error(`map repository: ${value.id} ground has ${value.ground.length} cells, expected ${cells}`);
  }
  for (const [index] of value.upper ?? []) {
    if (index < 0 || index >= cells) throw new Error(`map repository: ${value.id} upper index ${index} out of range`);
  }
  for (const [index] of value.passage ?? []) {
    if (index < 0 || index >= cells) throw new Error(`map repository: ${value.id} passage index ${index} out of range`);
  }
}

export function validateMapIndex(entries: readonly MapIndexEntry[]): Map<string, MapIndexEntry> {
  if (entries.length === 0) throw new Error("map repository: mapIndex must not be empty");
  const index = new Map<string, MapIndexEntry>();
  const names = new Set<string>();
  for (const meta of entries) {
    if (!meta.id || !meta.entry || !Number.isInteger(meta.width) || meta.width < 1 ||
      !Number.isInteger(meta.height) || meta.height < 1 || !/^[0-9a-f]{64}$/.test(meta.sha256)) {
      throw new Error(`map repository: invalid mapIndex entry ${JSON.stringify(meta.id)}`);
    }
    if (index.has(meta.id)) throw new Error(`map repository: duplicate map id ${meta.id}`);
    if (names.has(meta.entry)) throw new Error(`map repository: duplicate entry ${meta.entry}`);
    index.set(meta.id, meta);
    names.add(meta.entry);
  }
  return index;
}

export class MapNotReadyError extends Error {
  constructor(readonly mapId: string, readonly entry: string) {
    super(`map repository: ${mapId} is not ready (${entry})`);
    this.name = "MapNotReadyError";
  }
}

export interface MapEntrySource {
  read(entry: string): string | undefined;
  prepare?(entry: string): Promise<void>;
}

/** A validated repository over local strings or asynchronously prepared web
 * strings. Parsed maps are evicted exactly when releaseExcept requests it. */
export function createJsonMapRepository(
  entries: readonly MapIndexEntry[],
  source: MapEntrySource,
): MapRepository {
  const index = validateMapIndex(entries);
  const cache = new Map<string, MapDef>();
  return {
    meta: (id) => index.get(id),
    acquire(id) {
      const hit = cache.get(id);
      if (hit) return hit;
      const meta = index.get(id);
      if (!meta) throw new Error(`map repository: unknown map ${id}`);
      const text = source.read(meta.entry);
      if (text === undefined) throw new MapNotReadyError(id, meta.entry);
      if (sha256Text(text) !== meta.sha256) {
        throw new Error(`map repository: checksum mismatch for ${id} (${meta.entry})`);
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        throw new Error(`map repository: ${id} (${meta.entry}) is not JSON`);
      }
      validateMapDef(value);
      const map = value;
      if (map.id !== meta.id || map.width !== meta.width || map.height !== meta.height) {
        throw new Error(`map repository: metadata mismatch for ${id}`);
      }
      cache.set(id, map);
      return map;
    },
    releaseExcept(ids) {
      const keep = new Set(ids);
      for (const id of [...cache.keys()]) if (!keep.has(id)) cache.delete(id);
    },
    ...(source.prepare ? {
      prepare: async (id: string) => {
        const meta = index.get(id);
        if (!meta) throw new Error(`map repository: unknown map ${id}`);
        await source.prepare!(meta.entry);
      },
    } : {}),
  };
}
