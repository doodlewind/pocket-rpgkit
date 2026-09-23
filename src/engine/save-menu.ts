// src/engine/save-menu.ts — P1⑤ save-menu navigation reducer.
//
// Pure data state + a pure fold: no Solid, no host calls. RpgKitApp owns
// the signal holding MenuState and performs the side effect a CONFIRM
// returns (write a slot, read a slot, open the code export, open the OSK);
// the reducer only decides the next page. A target without data.fs gets
// the two code rows only — the save code is then the sole channel.

export type MenuState =
  | { kind: "closed" }
  | { kind: "root"; index: number }
  | { kind: "slots-save"; index: number }
  | { kind: "slots-load"; index: number }
  | { kind: "code-export"; page: number }
  | { kind: "code-import" }
  | { kind: "message"; title: string; body: string; back: MenuState };

export type MenuAction = "up" | "down" | "confirm" | "back";

/** Side effects CONFIRM may ask the host to perform. The host applies the
 *  command (fs write/read, snapshot, OSK) and installs the returned next
 *  state itself — this reducer stays pure. */
export type MenuCommand =
  | { op: "save-slot"; slot: number }
  | { op: "load-slot"; slot: number }
  | { op: "open-export" }
  | { op: "open-import" };

export interface MenuStepResult {
  state: MenuState;
  command?: MenuCommand;
}

export const ROOT_FS: readonly { id: "slots-save" | "slots-load" | "code-export" | "code-import"; label: string }[] = [
  { id: "slots-save", label: "Save to slot" },
  { id: "slots-load", label: "Load from slot" },
  { id: "code-export", label: "Save code (export)" },
  { id: "code-import", label: "Load code (import)" },
];

export const ROOT_CODE: readonly { id: "code-export" | "code-import"; label: string }[] = [
  { id: "code-export", label: "Save code (export)" },
  { id: "code-import", label: "Load code (import)" },
];

const SLOT_MIN = 1;
const SLOT_MAX = 3;

function cycle(index: number, len: number, delta: number): number {
  return (index + delta + len) % len;
}

/**
 * Fold one pressed-edge action. `slotNonEmpty[slot-1]` gates CONFIRM on
 * the load page (an empty slot shows a message instead of issuing a load);
 * `codePages` pages the export screen.
 */
export function menuStep(
  state: MenuState,
  action: MenuAction,
  ctx: { hasFs: boolean; slotNonEmpty: readonly boolean[]; codePages: number },
): MenuStepResult {
  switch (state.kind) {
    case "closed":
      return { state };

    case "root": {
      const rows = ctx.hasFs ? ROOT_FS : ROOT_CODE;
      if (action === "up") return { state: { ...state, index: cycle(state.index, rows.length, -1) } };
      if (action === "down") return { state: { ...state, index: cycle(state.index, rows.length, 1) } };
      if (action === "back") return { state: { kind: "closed" } };
      if (action === "confirm") {
        const id = rows[state.index]!.id;
        if (id === "slots-save") return { state: { kind: "slots-save", index: 0 } };
        if (id === "slots-load") return { state: { kind: "slots-load", index: 0 } };
        if (id === "code-export") return { state: { kind: "code-export", page: 0 }, command: { op: "open-export" } };
        return { state: { kind: "code-import" }, command: { op: "open-import" } };
      }
      return { state };
    }

    case "slots-save": {
      if (action === "up") return { state: { ...state, index: cycle(state.index, 3, -1) } };
      if (action === "down") return { state: { ...state, index: cycle(state.index, 3, 1) } };
      if (action === "back") return { state: { kind: "root", index: 0 } };
      if (action === "confirm") {
        return {
          state: { kind: "slots-save", index: state.index },
          command: { op: "save-slot", slot: SLOT_MIN + state.index },
        };
      }
      return { state };
    }

    case "slots-load": {
      if (action === "up") return { state: { ...state, index: cycle(state.index, 3, -1) } };
      if (action === "down") return { state: { ...state, index: cycle(state.index, 3, 1) } };
      if (action === "back") return { state: { kind: "root", index: 1 } };
      if (action === "confirm") {
        const slot = SLOT_MIN + state.index;
        if (!ctx.slotNonEmpty[state.index]) {
          return {
            state: {
              kind: "message",
              title: `SLOT ${slot} IS EMPTY`,
              body: "Nothing to load there.",
              back: { kind: "slots-load", index: state.index },
            },
          };
        }
        return {
          state: { kind: "slots-load", index: state.index },
          command: { op: "load-slot", slot },
        };
      }
      return { state };
    }

    case "code-export": {
      // Up/Down page the code; CIRCLE or CROSS return to the root row.
      if (action === "up") return { state: { ...state, page: exportPage(state.page, ctx.codePages, -1) } };
      if (action === "down") return { state: { ...state, page: exportPage(state.page, ctx.codePages, 1) } };
      if (action === "confirm" || action === "back") {
        return { state: { kind: "root", index: ctx.hasFs ? 2 : 0 } };
      }
      return { state };
    }

    case "code-import":
      // The OSK owns confirm/back while open; only an explicit host back
      // reaches here.
      if (action === "back") return { state: { kind: "root", index: ctx.hasFs ? 3 : 1 } };
      return { state };

    case "message":
      if (action === "confirm" || action === "back") return { state: state.back };
      return { state };
  }
}

/** Page the export screen on up/down edges (clamped, so a one-page code
 *  stays put). Export back navigation is menuStep's back/confirm. */
export function exportPage(page: number, pages: number, delta: number): number {
  return Math.max(0, Math.min(pages - 1, page + delta));
}

export function slotInRange(slot: number): boolean {
  return Number.isInteger(slot) && slot >= SLOT_MIN && slot <= SLOT_MAX;
}
