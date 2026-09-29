// tools/web/keys.ts — the browser player's keyboard table. tools/web.ts
// reads it to print each page's controls; tools/web/player.js reads it to
// turn keys into the button mask. Both work from this one table, so the
// printed controls always match what the keys do.
//
// The web-app target labels its buttons with the "letters" glyph set
// (vendor/pocketjs/contracts/spec/modality.ts): CIRCLE reads "A", CROSS
// "B", TRIANGLE "X", SQUARE "Y". The letter keys press those buttons, so a
// prompt such as "A next" in a dialog means the A key. Enter and Z also
// press CIRCLE, which framework actions bind to "confirm", as in
// PocketJS's own web host (hosts/web/engine.js). Escape and Backspace also
// press CROSS ("back"). Tab stays with the browser, so keyboard users can
// still leave the game.

import { BTN } from "../../vendor/pocketjs/contracts/spec/spec.ts";
import { BUTTON_GLYPHS as SHELL_GLYPHS } from "../../vendor/pocketjs/contracts/spec/modality.ts";

export { BTN };

/** A button the player can press, by its BTN name. */
export type ButtonName = Exclude<keyof typeof BTN, "ZL" | "ZR">;

/** What a control line names: one button, or the whole d-pad. */
export type ControlButton = ButtonName | "DPAD";

export const BUTTON_NAMES: readonly ButtonName[] = [
  "UP", "DOWN", "LEFT", "RIGHT",
  "CIRCLE", "CROSS", "TRIANGLE", "SQUARE",
  "LTRIGGER", "RTRIGGER", "SELECT", "START",
];

/** KeyboardEvent.code -> button, in the order the controls list keys.
 *  Physical key positions, so the table also works on other layouts. */
export const KEYMAP: Readonly<Record<string, ButtonName>> = {
  ArrowUp: "UP",
  ArrowDown: "DOWN",
  ArrowLeft: "LEFT",
  ArrowRight: "RIGHT",
  KeyA: "CIRCLE",
  Enter: "CIRCLE",
  KeyZ: "CIRCLE",
  KeyB: "CROSS",
  Escape: "CROSS",
  Backspace: "CROSS",
  KeyX: "TRIANGLE",
  KeyY: "SQUARE",
  KeyL: "LTRIGGER",
  KeyQ: "LTRIGGER",
  KeyR: "RTRIGGER",
  KeyE: "RTRIGGER",
  ShiftLeft: "SELECT",
  ShiftRight: "SELECT",
  Space: "START",
};

const KEY_LABELS: Readonly<Record<string, string>> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Esc",
  ShiftLeft: "Shift",
  ShiftRight: "Shift",
};

/** Labels on the on-screen touch buttons: the glyphs the game itself prints. */
export const BUTTON_GLYPHS: Readonly<Record<ButtonName, string>> = {
  UP: "▲",
  DOWN: "▼",
  LEFT: "◀",
  RIGHT: "▶",
  CIRCLE: SHELL_GLYPHS.letters.circle,
  CROSS: SHELL_GLYPHS.letters.cross,
  TRIANGLE: SHELL_GLYPHS.letters.triangle,
  SQUARE: SHELL_GLYPHS.letters.square,
  LTRIGGER: SHELL_GLYPHS.letters.ltrigger,
  RTRIGGER: SHELL_GLYPHS.letters.rtrigger,
  SELECT: "Select",
  START: "Start",
};

export function isControlButton(value: unknown): value is ControlButton {
  return value === "DPAD" || (BUTTON_NAMES as readonly unknown[]).includes(value);
}

export type Keymap = Readonly<Record<string, ButtonName>>;

const KEY_CODE = /^[A-Za-z][A-Za-z0-9]*$/;

/**
 * KEYMAP with a game's own changes: `code: "BUTTON"` binds a key, and
 * `code: null` unbinds it. A game whose on-screen prompts name other keys
 * (Alpine Post prints the desktop host's "A HELP") uses this so the prompts
 * stay true on the web.
 */
export function withKeys(overrides: Readonly<Record<string, string | null>> = {}): Keymap {
  const keymap: Record<string, ButtonName> = { ...KEYMAP };
  for (const [code, button] of Object.entries(overrides)) {
    if (!KEY_CODE.test(code)) throw new Error(`"${code}" is not a KeyboardEvent.code (e.g. "KeyA", "Tab")`);
    if (button === null) {
      delete keymap[code];
      continue;
    }
    if (!(BUTTON_NAMES as readonly string[]).includes(button)) {
      throw new Error(`${code}: "${button}" is not a button (${BUTTON_NAMES.join(", ")})`);
    }
    keymap[code] = button as ButtonName;
  }
  return keymap;
}

/** The keyboard keys that press `button`, as printed labels, in table order. */
export function keysFor(button: ControlButton, keymap: Keymap = KEYMAP): string[] {
  if (button === "DPAD") return ["Arrow keys"];
  const labels: string[] = [];
  for (const [code, name] of Object.entries(keymap)) {
    if (name !== button) continue;
    const label = KEY_LABELS[code] ?? code.replace(/^(Key|Digit)/, "");
    if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}

/** code -> button mask, the form the player's key handler wants. */
export function keyMasks(keymap: Keymap = KEYMAP): Record<string, number> {
  const masks: Record<string, number> = {};
  for (const [code, name] of Object.entries(keymap)) masks[code] = BTN[name];
  return masks;
}
