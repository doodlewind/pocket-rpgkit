// tools/lib/animated.ts — deterministic build-time cooking of animated map
// tiles. A game's cooker groups each map's animated cells into distinct
// frame SEQUENCES (a torch flame, a water edge, a portal): identical
// sequences across the whole game share one sprite atlas, exactly as the
// streamed chunk encoder shares identical blocks. This module emits, per
// distinct sequence:
//
//   - a power-of-two-wide RGBA atlas strip (frames in one row, PSM_8888 —
//     sprites must stay 8888; a 4444 atlas shifts the very pixels it
//     animates, Scout S2 §5),
//   - the sprites.json row { cols, rows:1, frames, step, psm:3 } the
//     PocketJS pak pass turns into a ui:sprite.<name> SPRITE entry,
//
// plus the GameAssets.animated source literal (cell x/y, above/below band,
// and the shared atlas name) the runtime mounts. Pure RGBA + deterministic
// ordering: two runs produce byte-identical files.
//
// Frame duration. sprites.json `step` is host vblanks at the 60 Hz
// reference; a sequence authored in milliseconds converts with
// round(ms/1000*hz). Per S2 §4.5 a sequence with unequal per-frame
// durations uses its FIRST frame's duration for the whole cycle (the core
// auto-plays one constant step). The animated tile is render-only: it is
// never reducer state, so it cannot change simulation determinism.

import { encodePNG } from "../../vendor/pocketjs/tests/png.ts";
import { TILE } from "../../src/engine/tiles.ts";

/** Reference rate the core steps sprites at (motion-clock MOTION_HZ). */
const REFERENCE_HZ = 60;
/** sprites.json PSM value for RGBA 8888 (contracts/spec PSM). */
const PSM_8888 = 3;

export interface AnimationSequenceInput {
  /** Stable per-sequence identity used only for error messages. */
  id: string;
  /** Row-major 16x16 RGBA frames, in playback order. */
  frames: readonly { rgba: Uint8Array; durationMs?: number }[];
}

/** A cooked, game-wide-shared sprite atlas for one distinct sequence. */
export interface AnimatedAtlas {
  /** Registered sprite name: the value GameAssets.animated[*].sprite uses
   *  and a key in sprites.json (a .png asset path). */
  name: string;
  /** Atlas file path relative to the app directory. */
  file: string;
  /** Encoded atlas PNG bytes to write to `file`. */
  png: Uint8Array;
  /** sprites.json metadata row. */
  meta: { cols: number; rows: number; frames: number; step: number; psm: number };
  /** Number of animation frames (<= cols). */
  frames: number;
  /** Reference vblanks each frame is held. */
  step: number;
}

export interface AnimatedCookOptions {
  /** Cell edge in px (default 16). */
  tile?: number;
  /** Reference vblanks per second for ms->step conversion (default 60). */
  hz?: number;
  /** Directory under the app for atlas files (default "assets/anim"). */
  directory?: string;
  /** File stem prefix (default "anim"). */
  prefix?: string;
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function stepFor(frames: AnimationSequenceInput["frames"], hz: number): number {
  const first = frames[0];
  if (!first || first.durationMs === undefined) return 1;
  return Math.max(1, Math.round((first.durationMs / 1000) * hz));
}

/** A signature that merges equal pixel sequences with equal timing. */
function signature(frames: AnimationSequenceInput["frames"], step: number): string {
  const parts = [`s${step}`, `n${frames.length}`];
  for (const f of frames) parts.push(Buffer.from(f.rgba).toString("base64"));
  return parts.join("|");
}

/** Cook every distinct sequence into a shared atlas. Input order defines
 *  atlas numbering (the first occurrence of a new signature gets the next
 *  index), so a stable input order yields stable bytes. */
export function cookAnimationAtlases(
  sequences: readonly AnimationSequenceInput[],
  opts: AnimatedCookOptions = {},
): {
  atlases: AnimatedAtlas[];
  /** Input sequence id -> registered atlas name. */
  atlasFor: ReadonlyMap<string, string>;
  /** The sprites.json object: name -> meta. */
  spritesJson: Record<string, { cols: number; rows: number; frames: number; step: number; psm: number }>;
} {
  const tile = opts.tile ?? TILE;
  const hz = opts.hz ?? REFERENCE_HZ;
  const directory = (opts.directory ?? "assets/anim").replace(/\/$/, "");
  const prefix = opts.prefix ?? "anim";
  const expected = tile * tile * 4;

  const atlases: AnimatedAtlas[] = [];
  const atlasFor = new Map<string, string>();
  const bySignature = new Map<string, AnimatedAtlas>();

  sequences.forEach((seq) => {
    if (!seq.frames.length) throw new Error(`animated ${seq.id}: a sequence needs at least one frame`);
    const step = stepFor(seq.frames, hz);
    const sig = signature(seq.frames, step);
    const existing = bySignature.get(sig);
    if (existing) {
      atlasFor.set(seq.id, existing.name);
      return;
    }
    const frames = seq.frames.length;
    const cols = nextPow2(frames);
    const width = cols * tile;
    const rgba = new Uint8Array(width * tile * 4);
    seq.frames.forEach((frame, i) => {
      if (frame.rgba.length !== expected) {
        throw new Error(`animated ${seq.id} frame ${i}: got ${frame.rgba.length} RGBA bytes, want ${expected}`);
      }
      for (let y = 0; y < tile; y++) {
        rgba.set(frame.rgba.subarray(y * tile * 4, (y + 1) * tile * 4), (y * width + i * tile) * 4);
      }
    });
    const index = atlases.length;
    const file = `${directory}/${prefix}-${index}.png`;
    const atlas: AnimatedAtlas = {
      name: file,
      file,
      png: encodePNG(rgba, width, tile),
      meta: { cols, rows: 1, frames, step, psm: PSM_8888 },
      frames,
      step,
    };
    atlases.push(atlas);
    bySignature.set(sig, atlas);
    atlasFor.set(seq.id, atlas.name);
  });

  const spritesJson: Record<string, AnimatedAtlas["meta"]> = {};
  for (const atlas of atlases) spritesJson[atlas.name] = atlas.meta;
  return { atlases, atlasFor, spritesJson };
}

/** A render-only animated tile placement as emitted into GameAssets. */
export interface AnimatedTileSpec {
  x: number;
  y: number;
  above: boolean;
  /** Registered atlas name (the cooked sequence's sprite). */
  sprite: string;
}

export interface AnimatedMapTiles {
  id: string;
  tiles: readonly AnimatedTileSpec[];
}

/** Deterministic GameAssets.animated object-literal source. Maps with no
 *  tiles are omitted. */
export function animatedManifestSource(maps: readonly AnimatedMapTiles[]): string {
  const q = JSON.stringify;
  const entry = (id: string, value: string): string =>
    id === "__proto__" ? `  [${q(id)}]: ${value},` : `  ${q(id)}: ${value},`;
  const rows = maps
    .filter((m) => m.tiles.length > 0)
    .map((m) =>
      entry(
        m.id,
        `[\n${m.tiles
          .map((t) => `    { x: ${t.x}, y: ${t.y}, above: ${t.above}, sprite: ${q(t.sprite)} },`)
          .join("\n")}\n  ]`,
      ),
    );
  return `{\n${rows.join("\n")}\n}`;
}
