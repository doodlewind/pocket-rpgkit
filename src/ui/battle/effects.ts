// src/ui/battle/effects.ts — pure, tick-driven math behind the battle UI
// kit (KB4). Every function here takes the caller's own reference-tick
// cursor (nowTick) and a small descriptor recorded in SessionState.scene
// and returns a plain number/offset; none of them read a clock or hold
// state of their own. A battle rules module (KB3, or a game's own reducer)
// writes the descriptor once when an effect starts; the presentation layer
// (StatBar, SpriteSlot, FrameStrip) re-derives the same pixels from the
// same descriptor at ANY nowTick, including one replayed from frame 0 by
// the kit's L-key rewind (engine/attract.ts) or folded at a different host
// Hz — the descriptor's ticks are the fixed 60 Hz reference, never a host
// frame count.

/** A linear interpolation window: `from` at startTick, `to` once `duration`
 *  reference ticks have elapsed, held after. duration 0 snaps to `to`. */
export interface Tween {
  from: number;
  to: number;
  startTick: number;
  duration: number;
}

/** progress in [0,1] for `nowTick` in a tween/effect window that started
 *  at `startTick` and lasts `duration` reference ticks. */
export function progress(startTick: number, duration: number, nowTick: number): number {
  if (duration <= 0) return 1;
  const p = (nowTick - startTick) / duration;
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

/** The interpolated value of a Tween at `nowTick`. */
export function tweenAt(t: Readonly<Tween>, nowTick: number): number {
  const p = progress(t.startTick, t.duration, nowTick);
  return t.from + (t.to - t.from) * p;
}

/** true once `nowTick` has passed a window's end (progress reaches 1 and
 *  stays there); a caller advances phase off this rather than a countdown. */
export function windowDone(startTick: number, duration: number, nowTick: number): boolean {
  return nowTick - startTick >= duration;
}

export type EffectKind = "none" | "shake" | "flash" | "faint";

/** A sprite-slot effect descriptor: what it is and when it started. `none`
 *  is the resting state every SpriteSlot renders between effects. */
export interface SpriteEffect {
  kind: EffectKind;
  startTick: number;
  duration: number;
}

export const NO_EFFECT: Readonly<SpriteEffect> = Object.freeze({ kind: "none", startTick: 0, duration: 0 });

/** Horizontal shake offset in px: a decaying sine, deterministic in
 *  (startTick, nowTick) alone. Zero once the window ends or outside
 *  `kind: "shake"`, so a SpriteSlot can add it to its base position
 *  unconditionally. */
export function shakeOffsetX(effect: Readonly<SpriteEffect>, nowTick: number, amplitude = 4, cycles = 5): number {
  if (effect.kind !== "shake") return 0;
  const p = progress(effect.startTick, effect.duration, nowTick);
  if (p >= 1) return 0;
  return Math.round(Math.sin(p * Math.PI * 2 * cycles) * amplitude * (1 - p));
}

/** Flash opacity: alternates 1 / `low` every `period` reference ticks while
 *  the window is open, 1 otherwise (before, after, or any other kind). */
export function flashOpacity(effect: Readonly<SpriteEffect>, nowTick: number, period = 4, low = 0.25): number {
  if (effect.kind !== "flash") return 1;
  const elapsed = nowTick - effect.startTick;
  if (elapsed < 0 || elapsed >= effect.duration) return 1;
  return Math.floor(elapsed / period) % 2 === 0 ? low : 1;
}

export interface FaintPose {
  /** Downward pixel offset, 0 at the window's start growing to `maxSink`. */
  sinkY: number;
  /** 1 at the window's start fading to 0, held there after. */
  opacity: number;
}

/** Sink-and-fade pose for a defeated actor: before the window it is fully
 *  visible at rest (sinkY 0, opacity 1); once the window ends it stays at
 *  the sunk, transparent end pose rather than reappearing. */
export function faintPose(effect: Readonly<SpriteEffect>, nowTick: number, maxSink = 14): FaintPose {
  if (effect.kind !== "faint") return { sinkY: 0, opacity: 1 };
  const p = progress(effect.startTick, effect.duration, nowTick);
  return { sinkY: Math.round(p * maxSink), opacity: 1 - p };
}

/** Filled pixel width for a `current`/`max` fraction, clamped to [0, width]
 *  and rounded so a StatBar always shows a whole pixel count. Free of any
 *  UI-framework import (unlike StatBar.tsx, which re-exports it) so a test
 *  can cross-check a rendered bar's width without pulling in JSX. */
export function barFillWidth(current: number, max: number, width: number): number {
  if (max <= 0) return 0;
  const frac = current / max;
  const clamped = frac < 0 ? 0 : frac > 1 ? 1 : frac;
  return Math.round(clamped * width);
}

/** Discrete frame index for a baked frame strip: floor(elapsed / frameTicks),
 *  wrapped when `loop`, clamped to the last frame otherwise. `count <= 0`
 *  always answers 0 so a caller can pass an empty strip safely. */
export function frameIndexAt(
  nowTick: number,
  startTick: number,
  frameTicks: number,
  count: number,
  loop: boolean,
): number {
  if (count <= 0) return 0;
  const elapsed = Math.max(0, nowTick - startTick);
  const raw = Math.floor(elapsed / Math.max(1, frameTicks));
  return loop ? raw % count : Math.min(raw, count - 1);
}
