// tests/list-window.test.ts — the pure scroll-window and label-truncation
// helpers behind T2-9 (>4 choices) and the T2-10 shop box row list
// (src/ui/list-window.ts). The rendered behaviour is ui-theme-sim.test.ts.

import { describe, expect, test } from "bun:test";
import { truncateLabel, windowStart } from "../src/ui/list-window.ts";

describe("windowStart", () => {
  test("a list no longer than the visible count never scrolls", () => {
    for (let total = 0; total <= 4; total++) {
      for (let index = 0; index < Math.max(1, total); index++) {
        expect(windowStart(index, total, 4)).toBe(0);
      }
    }
  });

  test("the cursor stays one row from the top while there is room above", () => {
    // 8 items, 4 visible: index 2 -> start 1 (index at window row 1).
    expect(windowStart(2, 8, 4)).toBe(1);
    expect(windowStart(3, 8, 4)).toBe(2);
    expect(windowStart(5, 8, 4)).toBe(4);
  });

  test("clamps at both ends: never negative, never past the last full window", () => {
    expect(windowStart(0, 8, 4)).toBe(0);
    expect(windowStart(1, 8, 4)).toBe(0);
    expect(windowStart(7, 8, 4)).toBe(4); // maxStart = 8 - 4
    expect(windowStart(6, 8, 4)).toBe(4);
  });

  test("the cursor is always inside [start, start+visible)", () => {
    for (let total = 1; total <= 20; total++) {
      for (let index = 0; index < total; index++) {
        const start = windowStart(index, total, 4);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(start).toBeLessThanOrEqual(Math.max(0, total - 4));
        expect(index).toBeGreaterThanOrEqual(start);
        expect(index).toBeLessThan(start + 4);
      }
    }
  });
});

describe("truncateLabel", () => {
  test("a label within budget is unchanged", () => {
    expect(truncateLabel("Iron Key", 24)).toBe("Iron Key");
    expect(truncateLabel("", 24)).toBe("");
    expect(truncateLabel("exactly24charactersxxxx", 24).length).toBeLessThanOrEqual(24);
  });

  test("a longer label truncates with a trailing ellipsis, within budget", () => {
    const long = "A label far too long to fit the choices box at all";
    const out = truncateLabel(long, 24);
    expect(out.length).toBe(24);
    expect(out.endsWith("…")).toBe(true);
    expect(out.slice(0, -1)).toBe(long.slice(0, 23));
  });

  test("a budget of 1 or less still returns at most that many characters", () => {
    expect(truncateLabel("hello", 1).length).toBeLessThanOrEqual(1);
    expect(truncateLabel("hello", 0).length).toBe(0);
  });
});
