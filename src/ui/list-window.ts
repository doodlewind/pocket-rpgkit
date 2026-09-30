// src/ui/list-window.ts — stateless scroll window and label truncation for
// the kit's fixed-row list boxes (DialogBox choices, the shop box). No
// engine state stores a scroll offset: the visible window is a pure
// function of the live cursor index and the list's total length, so it
// can never desync from the reducer, and wrapping (bottom -> top, MV
// choice-cursor parity) recomputes the correct window with no leftover
// state from the previous frame.

/** First row index a `visible`-row window should show so that `index` is
 *  always inside it. Keeps the cursor one row from the window's top when
 *  there is room to scroll further up, and clamps at both ends. */
export function windowStart(index: number, total: number, visible: number): number {
  if (total <= visible) return 0;
  const maxStart = total - visible;
  let start = index - 1;
  if (start < 0) start = 0;
  if (start > maxStart) start = maxStart;
  return start;
}

/** Truncate a label to `max` characters, replacing the tail with "…" when
 *  it does not fit. The kit's framed boxes are a fixed pixel width, so an
 *  authored label longer than the box (schema now allows up to 32/24
 *  characters for choice/shop labels) must not overflow it. */
export function truncateLabel(label: string, max: number): string {
  if (label.length <= max) return label;
  if (max <= 1) return label.slice(0, max);
  return `${label.slice(0, max - 1)}…`;
}
