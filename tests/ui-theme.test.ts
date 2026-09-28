// tests/ui-theme.test.ts — the pure halves of the themeable UI
// (src/ui/theme.ts): theme resolution and the speaker-prefix rule that
// DialogBox portraits use. The rendered behaviour is ui-theme-sim.test.ts.

import { describe, expect, test } from "bun:test";
import { DEFAULT_UI_THEME, resolveUiTheme, speakerLabel, splitSpeaker } from "../src/index.ts";

describe("resolveUiTheme", () => {
  test("no theme is the kit default, without a rim", () => {
    expect(resolveUiTheme()).toEqual({ ...DEFAULT_UI_THEME });
    expect(resolveUiTheme().rim).toBeUndefined();
    expect(resolveUiTheme({})).toEqual({ ...DEFAULT_UI_THEME });
  });

  test("set keys override, missing and undefined keys keep the default", () => {
    const t = resolveUiTheme({ paper: "#f4ecd8", rim: "#e8a050", ink: undefined });
    expect(t.paper).toBe("#f4ecd8");
    expect(t.rim).toBe("#e8a050");
    expect(t.ink).toBe(DEFAULT_UI_THEME.ink);
    expect(t.border).toBe(DEFAULT_UI_THEME.border);
  });

  test("the result is a fresh object; the default is frozen", () => {
    const t = resolveUiTheme();
    t.paper = "#000000";
    expect(DEFAULT_UI_THEME.paper).toBe("#0b1626");
    expect(Object.isFrozen(DEFAULT_UI_THEME)).toBe(true);
  });
});

describe("splitSpeaker", () => {
  const faces = { KEEPER: "assets/face-keeper.png", POSTMASTER: "assets/face-postmaster.png" };

  test("a known speaker's prefix is split off, with its length", () => {
    expect(splitSpeaker("KEEPER: The lamp is lit.", faces)).toEqual({ name: "KEEPER", rest: "The lamp is lit.", cut: 8 });
    expect(splitSpeaker("POSTMASTER: ", faces)).toEqual({ name: "POSTMASTER", rest: "", cut: 12 });
  });

  test("anything else is a plain line", () => {
    const plain = (line: string) => ({ name: null, rest: line, cut: 0 });
    for (const line of [
      "MAYOR: Not in the faces table.",
      "Keeper: not all caps.",
      "KEEPER:no space after the colon.",
      "K: one letter is not a name.",
      " KEEPER: leading space.",
      "The KEEPER: mid-line.",
      "",
    ]) {
      expect(splitSpeaker(line, faces), line).toEqual(plain(line));
    }
    expect(splitSpeaker("KEEPER: hi", {})).toEqual(plain("KEEPER: hi"));
  });

  test("speakerLabel capitalises the name", () => {
    expect(speakerLabel("POSTMASTER")).toBe("Postmaster");
    expect(speakerLabel("KEEPER")).toBe("Keeper");
  });
});
