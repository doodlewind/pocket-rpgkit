// tests/fixtures/ui-theme/scenes.ts — the named scenes of the ui-theme sim
// fixture, shared by the fixture app (ui-theme.tsx) and its test
// (tests/ui-theme-sim.test.ts). Every string the components display is a
// literal here, reachable from the fixture entry, so the build bakes its
// glyphs; the test only passes scene names.

import type { Modal } from "../../../src/engine/interpreter.ts";
import type { MenuState } from "../../../src/engine/save-menu.ts";
import type { SlotInfo } from "../../../src/ui/SaveMenu.tsx";
import type { UiTheme } from "../../../src/ui/theme.ts";

function text(lines: string[], revealed?: number): Modal {
  const total = lines.join("\n").length;
  const shown = revealed ?? total;
  return { kind: "text", fiber: "fixture", lines, total, revealed: shown, complete: shown >= total };
}

const SPEAKER = ["KEEPER: The lamp is lit tonight.", "Climb while the light holds."];

export const MODALS = {
  none: null,
  plain: text(["The road north is closed.", "Snow on the pass since dawn.", "Rest here until the plow comes."]),
  speaker: text(SPEAKER),
  // The speaker text without its prefix, as a plain line: the glyph
  // reference for the stripped speaker line.
  stripped: text(["The lamp is lit tonight.", "Climb while the light holds."]),
  clerk: text(["CLERK: Two letters for the farm.", "Sign here, please."]),
  // "KEEPER: " is 8 characters: 13 revealed shows five typed letters...
  typing: text(SPEAKER, 13),
  // ...which must look like this line fully revealed.
  typed: text(["The l"]),
  // Still inside the name prefix: nothing typed yet.
  prefix: text(SPEAKER, 5),
  // MAYOR has no portrait: a plain line.
  unknown: text(["MAYOR: Welcome to the valley.", "Mind the ice on the bridge."]),
  choices: {
    kind: "choices",
    fiber: "fixture",
    prompt: "Take the mountain road?",
    options: ["Climb now", "Wait for dawn", "Turn back"],
    index: 1,
    cancellable: true,
  },
} satisfies Record<string, Modal | null>;

export const MENUS = {
  closed: { kind: "closed" },
  root: { kind: "root", index: 1 },
  slots: { kind: "slots-save", index: 0 },
  code: { kind: "code-export", page: 0 },
  message: { kind: "message", title: "SAVED - SLOT 1", body: "Your progress is stored.", back: { kind: "root", index: 0 } },
} satisfies Record<string, MenuState>;

export const THEMES = {
  default: undefined,
  // Every colour replaced, with the optional rim ring.
  parchment: {
    border: "#7a4a2a",
    rim: "#e8a050",
    paper: "#f4ecd8",
    ink: "#302820",
    dim: "#8a6040",
    accent: "#c03020",
    backdrop: "#101418",
  },
  // A partial override without a rim: the rest stays the kit default.
  slate: { border: "#c0c8d0", paper: "#2a3a4a" },
} satisfies Record<string, Partial<UiTheme> | undefined>;

/** Portraits written by gen-assets.ts (faces.ts). */
export const FACES: Record<string, string> = {
  KEEPER: "assets/face-keeper.png",
  CLERK: "assets/face-clerk.png",
};

export const SAVE_TITLE = "FIELD OFFICE - SAVE";
export const SLOTS: SlotInfo = [{ slot: 1, map: "hub", frame: 1200, checksum: "00000000" }, null, { slot: 3, error: "bad checksum" }];
export const CODE = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_".repeat(6);

export interface FixtureScene {
  modal?: keyof typeof MODALS;
  menu?: keyof typeof MENUS;
  theme?: keyof typeof THEMES;
  /** Pass FACES to the DialogBox. */
  faces?: boolean;
  /** Pass SAVE_TITLE to the SaveMenu. */
  title?: boolean;
}
