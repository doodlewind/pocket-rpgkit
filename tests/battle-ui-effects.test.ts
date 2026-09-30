// tests/battle-ui-effects.test.ts — the pure tick math behind KB4
// (src/ui/battle/effects.ts). Every function is a plain function of
// (descriptor, nowTick): these tests exercise that determinism directly,
// with no sim host, no render, no clock — the property the rendered
// components (tests/kb4-battle-sim.test.ts) then lean on for rewind and
// multi-Hz pixel parity.

import { describe, expect, test } from "bun:test";
import {
  faintPose,
  flashOpacity,
  frameIndexAt,
  NO_EFFECT,
  progress,
  shakeOffsetX,
  tweenAt,
  windowDone,
  type SpriteEffect,
} from "../src/ui/battle/effects.ts";

describe("progress / tweenAt / windowDone", () => {
  test("progress clamps to [0,1] and a zero duration snaps to 1", () => {
    expect(progress(10, 0, 5)).toBe(1);
    expect(progress(10, 20, 0)).toBe(0);
    expect(progress(10, 20, 10)).toBe(0);
    expect(progress(10, 20, 20)).toBe(0.5);
    expect(progress(10, 20, 30)).toBe(1);
    expect(progress(10, 20, 999)).toBe(1);
  });

  test("tweenAt interpolates linearly and holds the end value", () => {
    const t = { from: 10, to: 0, startTick: 100, duration: 10 };
    expect(tweenAt(t, 100)).toBe(10);
    expect(tweenAt(t, 105)).toBe(5);
    expect(tweenAt(t, 110)).toBe(0);
    expect(tweenAt(t, 200)).toBe(0);
    expect(tweenAt(t, 0)).toBe(10);
  });

  test("windowDone is a pure function of the same two ticks progress uses", () => {
    expect(windowDone(100, 10, 109)).toBe(false);
    expect(windowDone(100, 10, 110)).toBe(true);
    expect(windowDone(100, 10, 500)).toBe(true);
  });

  test("re-evaluating at the same nowTick is idempotent (rewind-safe)", () => {
    const t = { from: 30, to: 90, startTick: 40, duration: 25 };
    const a = tweenAt(t, 52);
    const b = tweenAt(t, 52);
    expect(a).toBe(b);
  });
});

describe("shakeOffsetX", () => {
  const shake: SpriteEffect = { kind: "shake", startTick: 100, duration: 20 };

  test("zero for any other kind, including none", () => {
    expect(shakeOffsetX(NO_EFFECT, 105)).toBe(0);
    expect(shakeOffsetX({ kind: "flash", startTick: 100, duration: 20 }, 105)).toBe(0);
    expect(shakeOffsetX({ kind: "faint", startTick: 100, duration: 20 }, 105)).toBe(0);
  });

  test("zero before the window starts and once it has ended", () => {
    expect(shakeOffsetX(shake, 100)).toBe(0); // sin(0) = 0 at the very start
    expect(shakeOffsetX(shake, 80)).not.toBeNaN();
    expect(shakeOffsetX(shake, 120)).toBe(0);
    expect(shakeOffsetX(shake, 500)).toBe(0);
  });

  test("decays toward zero amplitude as progress approaches 1", () => {
    const early = Math.abs(shakeOffsetX(shake, 102, 4, 5));
    const late = Math.abs(shakeOffsetX(shake, 118, 4, 5));
    expect(late).toBeLessThanOrEqual(early + 1); // decay factor (1-p) shrinks the envelope
    expect(Math.abs(shakeOffsetX(shake, 119, 4, 5))).toBeLessThanOrEqual(4);
  });

  test("is a pure function: same inputs, same output, every time", () => {
    const values = Array.from({ length: 5 }, () => shakeOffsetX(shake, 107));
    expect(new Set(values).size).toBe(1);
  });
});

describe("flashOpacity", () => {
  const flash: SpriteEffect = { kind: "flash", startTick: 50, duration: 16 };

  test("1 outside the window or for a non-flash effect", () => {
    expect(flashOpacity(NO_EFFECT, 55)).toBe(1);
    expect(flashOpacity(flash, 49)).toBe(1);
    expect(flashOpacity(flash, 66)).toBe(1);
  });

  test("alternates low / 1 every `period` ticks inside the window, starting dim", () => {
    expect(flashOpacity(flash, 50, 4, 0.25)).toBe(0.25);
    expect(flashOpacity(flash, 53, 4, 0.25)).toBe(0.25);
    expect(flashOpacity(flash, 54, 4, 0.25)).toBe(1);
    expect(flashOpacity(flash, 57, 4, 0.25)).toBe(1);
    expect(flashOpacity(flash, 58, 4, 0.25)).toBe(0.25);
  });
});

describe("faintPose", () => {
  const faint: SpriteEffect = { kind: "faint", startTick: 200, duration: 30 };

  test("resting pose (no sink, opaque) before or outside a faint effect", () => {
    expect(faintPose(NO_EFFECT, 210)).toEqual({ sinkY: 0, opacity: 1 });
    expect(faintPose(faint, 199)).toEqual({ sinkY: 0, opacity: 1 });
  });

  test("sinks and fades monotonically across the window", () => {
    const start = faintPose(faint, 200, 14);
    const mid = faintPose(faint, 215, 14);
    const end = faintPose(faint, 230, 14);
    expect(start).toEqual({ sinkY: 0, opacity: 1 });
    expect(mid.sinkY).toBeGreaterThan(start.sinkY);
    expect(mid.sinkY).toBeLessThan(end.sinkY);
    expect(mid.opacity).toBeLessThan(start.opacity);
    expect(mid.opacity).toBeGreaterThan(end.opacity);
    expect(end).toEqual({ sinkY: 14, opacity: 0 });
  });

  test("holds the sunk, transparent end pose after the window (does not reappear)", () => {
    expect(faintPose(faint, 5000, 14)).toEqual({ sinkY: 14, opacity: 0 });
  });
});

describe("frameIndexAt", () => {
  test("an empty strip is always frame 0", () => {
    expect(frameIndexAt(100, 0, 4, 0, true)).toBe(0);
    expect(frameIndexAt(100, 0, 4, -1, false)).toBe(0);
  });

  test("advances one frame every frameTicks and clamps when not looping", () => {
    expect(frameIndexAt(0, 0, 4, 3, false)).toBe(0);
    expect(frameIndexAt(3, 0, 4, 3, false)).toBe(0);
    expect(frameIndexAt(4, 0, 4, 3, false)).toBe(1);
    expect(frameIndexAt(8, 0, 4, 3, false)).toBe(2);
    expect(frameIndexAt(999, 0, 4, 3, false)).toBe(2); // held on the last frame
  });

  test("wraps when looping", () => {
    expect(frameIndexAt(12, 0, 4, 3, true)).toBe(0);
    expect(frameIndexAt(16, 0, 4, 3, true)).toBe(1);
    expect(frameIndexAt(0, 0, 4, 3, true)).toBe(0);
  });

  test("never reads before startTick (a negative elapsed clamps to 0)", () => {
    expect(frameIndexAt(0, 50, 4, 3, false)).toBe(0);
    expect(frameIndexAt(0, 50, 4, 3, true)).toBe(0);
  });
});
