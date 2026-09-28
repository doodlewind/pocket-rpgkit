// tests/ui-theme-sim.test.ts — themeable DialogBox / SaveMenu and speaker
// portraits, through the built ui-theme fixture (tests/fixtures/ui-theme)
// on the deterministic wasm sim host.
//
//   1. DEFAULT   without theme/faces every scene hashes exactly as it did
//                before the components took a theme: the pins were captured
//                on the pre-theme build and are cross-checked against the
//                committed PNGs (tests/goldens/ui-default.*).
//   2. THEME     a non-default theme paints its border, rim, paper, ink,
//                dim, accent and backdrop colours where the frame, text and
//                overlay are; a partial theme keeps the rest default.
//   3. FACES     a known speaker's line shows THAT speaker's portrait pixel
//                for pixel, a name tab on the frame, and the text without
//                its prefix; the reveal is offset by the prefix length.
//   4. PLAIN     non-speaker lines and unknown names render byte-identically
//                to the no-faces box.
//
// Frame geometry (480x272 screen, message layer docked to the bottom):
//   message box  x 8..471, y 172..263   border 2 px, rim ring at inset 2
//   portrait     x 18..81, y 182..245   (box + frame 2 + padding 8)
//   text column  x >= 90 with a portrait (72 px column), x >= 18 without
//   name tab     x >= 20, y 159..173 (160..174 with a rim: it covers the
//                whole frame, border and rim)
//   choices box  x 220..467, y 78..173
//   save panel   x 30..449, y 20..251   centered 420x232
//
// Needs `bun run build:example` (builds the fixture) and the wasm core;
// without them the cases register as skips.

import { beforeAll, describe, expect, test } from "bun:test";
import { bootWorld, fnv1a, treeHasText, type SimWorld } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { DEFAULT_UI_THEME } from "../src/ui/theme.ts";
import { FACE_PX, faceRgba, FACE_PALETTES } from "./fixtures/ui-theme/faces.ts";
import { SAVE_TITLE, THEMES, type FixtureScene } from "./fixtures/ui-theme/scenes.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";

const preflight = appPreflight("ui-theme");
if (!preflight.ok) console.warn(`ui-theme sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;

const PARCHMENT = THEMES.parchment;
const SLATE = THEMES.slate;

const W = 480;
type Rgb = readonly [number, number, number];
const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as unknown as Rgb;
const at = (fb: Uint8Array, x: number, y: number): Rgb => {
  const i = (y * W + x) * 4;
  return [fb[i]!, fb[i + 1]!, fb[i + 2]!];
};
const hexOf = (c: Rgb): string => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
const hexAt = (fb: Uint8Array, x: number, y: number): string => hexOf(at(fb, x, y));
/** Pixels of exactly `hex` in [x0,x1) x [y0,y1). */
function count(fb: Uint8Array, hex: string, x0: number, x1: number, y0: number, y1: number): number {
  const [r, g, b] = rgb(hex);
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      if (fb[i] === r && fb[i + 1] === g && fb[i + 2] === b) n++;
    }
  }
  return n;
}
/** Pixels in the rectangle that are not `hex` (glyphs, art, anything). */
const notCount = (fb: Uint8Array, hex: string, x0: number, x1: number, y0: number, y1: number): number =>
  (x1 - x0) * (y1 - y0) - count(fb, hex, x0, x1, y0, y1);
/** Positions of the pixels that are exactly `hex` (full-coverage glyph
 *  cores when `hex` is a text colour). */
function mask(fb: Uint8Array, hex: string, x0: number, x1: number, y0: number, y1: number): number[] {
  const out: number[] = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (hexAt(fb, x, y) === hex) out.push(y * W + x);
  return out;
}
/** A w x h block of the frame starting at (x, y), RGBA bytes. */
function crop(fb: Uint8Array, x: number, y: number, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) out.set(fb.subarray(((y + row) * W + x) * 4, ((y + row) * W + x + w) * 4), row * w * 4);
  return out;
}

/** The four frame rings of a box: every pixel on the outer 2 px ring is
 *  `border`; the next ring is `ring` (the rim, or the paper). */
function expectFrame(fb: Uint8Array, box: { x0: number; x1: number; y0: number; y1: number }, border: string, ring: string): void {
  const { x0, x1, y0, y1 } = box;
  const w = x1 - x0;
  const h = y1 - y0;
  // Outer two rows/columns, then the ring just inside.
  expect(count(fb, border, x0, x1, y0, y0 + 2)).toBe(w * 2);
  expect(count(fb, border, x0, x1, y1 - 2, y1)).toBe(w * 2);
  expect(count(fb, border, x0, x0 + 2, y0, y1)).toBe(h * 2);
  expect(count(fb, border, x1 - 2, x1, y0, y1)).toBe(h * 2);
  expect(count(fb, ring, x0 + 2, x1 - 2, y0 + 2, y0 + 3)).toBe(w - 4);
  expect(count(fb, ring, x0 + 2, x1 - 2, y1 - 3, y1 - 2)).toBe(w - 4);
  expect(count(fb, ring, x0 + 2, x0 + 3, y0 + 2, y1 - 2)).toBe(h - 4);
  expect(count(fb, ring, x1 - 3, x1 - 2, y0 + 2, y1 - 2)).toBe(h - 4);
}

const MSG = { x0: 8, x1: 472, y0: 172, y1: 264 };
const CHOICES = { x0: 220, x1: 468, y0: 78, y1: 174 };
const SAVE = { x0: 30, x1: 450, y0: 20, y1: 252 };
const FACE = { x: 18, y: 182 };
const ROWS = { y0: 182, y1: 242 }; // four 15 px text rows
// The "next" legend, right-aligned under the text. The scenes' texts have
// three lines or fewer and an empty row takes no height, so it sits on
// the fourth row's line.
const LEGEND = [420, 462, 227, 242] as const;
const TEXT_X = { plain: 18, portrait: 90 };

let world: SimWorld;
let opCount = 0;

/** Render one scene from a clean screen (both components unmounted). */
function shot(scene: FixtureScene): Uint8Array {
  show({});
  return show(scene);
}
/** Switch to a scene WITHOUT clearing first (a mounted box stays mounted). */
function show(scene: FixtureScene): Uint8Array {
  (globalThis as { __uiFixture?: { show(s: FixtureScene): void } }).__uiFixture!.show(scene);
  world.frame(0);
  world.tick();
  return world.render().slice();
}

simDescribe("ui theme — built fixture on the sim host", () => {
  beforeAll(async () => {
    world = await bootWorld(appBundle("ui-theme"), 60, undefined, (ops) => {
      for (const [name, fn] of Object.entries(ops)) {
        if (typeof fn !== "function") continue;
        ops[name] = (...args: unknown[]) => {
          opCount++;
          return (fn as (...a: unknown[]) => unknown).apply(ops, args);
        };
      }
    });
    world.frame(0);
    world.tick();
  });

  // Captured on the build BEFORE DialogBox/SaveMenu took a theme (the
  // components still had their colours as constants).
  const DEFAULT_PINS: Record<string, [FixtureScene, string]> = {
    plain: [{ modal: "plain" }, "e4663bbb"],
    choices: [{ modal: "choices" }, "b48e4476"],
    speaker: [{ modal: "speaker" }, "46169520"],
    typing: [{ modal: "typing" }, "45d47e65"],
    unknown: [{ modal: "unknown" }, "e098841d"],
    "save-root": [{ menu: "root" }, "f11324b4"],
    "save-slots": [{ menu: "slots" }, "6dfecb21"],
    "save-code": [{ menu: "code" }, "2d663238"],
    "save-message": [{ menu: "message" }, "957a3521"],
  };

  test("no theme and no faces: every scene is the pre-theme frame, byte for byte", async () => {
    for (const [name, [scene, hash]] of Object.entries(DEFAULT_PINS)) {
      expect(fnv1a(shot(scene)), name).toBe(hash);
      const png = new Uint8Array(await Bun.file(new URL(`./goldens/ui-default.${name}.png`, import.meta.url)).arrayBuffer());
      expect(fnv1a(decodePng(png).rgba), `${name} PNG`).toBe(hash);
    }
    // Without faces a speaker line is just text: the prefix stays.
    shot({ modal: "speaker" });
    expect(treeHasText(world.getTree(), "KEEPER: The lamp is lit tonight.")).toBe(true);
  });

  test("the default frame is the kit palette: steel border, navy paper, pale ink", () => {
    const fb = shot({ modal: "plain" });
    const d = DEFAULT_UI_THEME;
    expectFrame(fb, MSG, d.border, d.paper);
    expect(count(fb, d.ink, 18, 300, ROWS.y0, ROWS.y1)).toBeGreaterThan(150);
  });

  test("a full theme paints border, rim, paper, ink and dim on the message box", () => {
    const fb = shot({ modal: "plain", theme: "parchment" });
    expectFrame(fb, MSG, PARCHMENT.border, PARCHMENT.rim);
    // Inside the rim it is paper, except where glyphs are.
    const inner = (MSG.x1 - MSG.x0 - 6) * (MSG.y1 - MSG.y0 - 6);
    expect(count(fb, PARCHMENT.paper, MSG.x0 + 3, MSG.x1 - 3, MSG.y0 + 3, MSG.y1 - 3) / inner).toBeGreaterThan(0.9);
    // Rows in ink, the "next" legend (bottom right) in dim, nothing default.
    expect(count(fb, PARCHMENT.ink, 18, 300, ROWS.y0, ROWS.y1)).toBeGreaterThan(150);
    expect(count(fb, PARCHMENT.dim, ...LEGEND)).toBeGreaterThan(4);
    expect(count(fb, PARCHMENT.ink, ...LEGEND)).toBe(0);
    for (const c of [DEFAULT_UI_THEME.border, DEFAULT_UI_THEME.paper, DEFAULT_UI_THEME.ink]) {
      expect(count(fb, c, MSG.x0, MSG.x1, MSG.y0, MSG.y1), c).toBe(0);
    }
    // The rim is paint only: the glyphs sit on the same pixels as without it.
    const plain = shot({ modal: "plain" });
    expect(mask(fb, PARCHMENT.ink, 18, 300, ROWS.y0, ROWS.y1)).toEqual(
      mask(plain, DEFAULT_UI_THEME.ink, 18, 300, ROWS.y0, ROWS.y1),
    );
  });

  test("the choices box takes the theme: frame, prompt in dim, selected row in accent", () => {
    const fb = shot({ modal: "choices", theme: "parchment" });
    expectFrame(fb, CHOICES, PARCHMENT.border, PARCHMENT.rim);
    // Content from (228, 86): prompt row y 86..99, a 4 px gap, then 14 px
    // option rows from y 104. Index 1 ("> Wait for dawn") is selected.
    expect(count(fb, PARCHMENT.dim, 228, 460, 86, 100)).toBeGreaterThan(30);
    expect(count(fb, PARCHMENT.ink, 228, 460, 104, 118)).toBeGreaterThan(20);
    expect(count(fb, PARCHMENT.accent, 228, 460, 104, 118)).toBe(0);
    expect(count(fb, PARCHMENT.accent, 228, 460, 118, 132)).toBeGreaterThan(15);
    expect(count(fb, PARCHMENT.ink, 228, 460, 118, 132)).toBe(0);
  });

  test("a partial theme without a rim keeps the other colours default", () => {
    const fb = shot({ modal: "plain", theme: "slate" });
    // No rim: paper directly inside the border.
    expectFrame(fb, MSG, SLATE.border, SLATE.paper);
    expect(count(fb, DEFAULT_UI_THEME.ink, 18, 300, ROWS.y0, ROWS.y1)).toBeGreaterThan(150);
    expect(count(fb, DEFAULT_UI_THEME.dim, ...LEGEND)).toBeGreaterThan(4);
  });

  test("the save menu takes the theme and the title", () => {
    const fb = shot({ menu: "root", theme: "parchment", title: true });
    expect(hexAt(fb, 4, 4)).toBe(PARCHMENT.backdrop);
    expect(hexAt(fb, 470, 260)).toBe(PARCHMENT.backdrop);
    expectFrame(fb, SAVE, PARCHMENT.border, PARCHMENT.rim);
    // Title band (y 30..48) in accent; row 1 "> Load from slot" selected.
    expect(count(fb, PARCHMENT.accent, 40, 300, 30, 48)).toBeGreaterThan(60);
    expect(count(fb, PARCHMENT.ink, 40, 300, 54, 74)).toBeGreaterThan(20);
    expect(count(fb, PARCHMENT.accent, 40, 300, 74, 94)).toBeGreaterThan(25);
    expect(count(fb, PARCHMENT.ink, 40, 300, 74, 94)).toBe(0);
    expect(count(fb, PARCHMENT.dim, 40, 300, 228, 242)).toBeGreaterThan(4);
    const tree = world.getTree();
    expect(treeHasText(tree, SAVE_TITLE)).toBe(true);
    expect(treeHasText(tree, "POCKET RPG KIT")).toBe(false);

    const slate = shot({ menu: "slots", theme: "slate" });
    expect(hexAt(slate, 4, 4)).toBe(DEFAULT_UI_THEME.backdrop);
    expectFrame(slate, SAVE, SLATE.border, SLATE.paper);
    expect(count(slate, DEFAULT_UI_THEME.accent, 40, 300, 30, 48)).toBeGreaterThan(60);
  });

  test("a speaker line shows that speaker's portrait and name tab, and the text without the prefix", () => {
    for (const [scene, face, label] of [
      [{ modal: "speaker", faces: true }, "keeper", "Keeper"],
      [{ modal: "clerk", faces: true }, "clerk", "Clerk"],
    ] as const) {
      const fb = shot(scene);
      // The portrait: the procedural 64x64 image, every pixel.
      expect(fnv1a(crop(fb, FACE.x, FACE.y, FACE_PX, FACE_PX)), face).toBe(fnv1a(faceRgba(face)));
      const other = face === "keeper" ? FACE_PALETTES.clerk.frame : FACE_PALETTES.keeper.frame;
      expect(count(fb, hexOf(other), 0, W, 0, 272)).toBe(0);
      // The name tab: border-coloured plate on the frame, paper glyphs.
      const d = DEFAULT_UI_THEME;
      expect(count(fb, d.border, 20, 26, 159, 172)).toBe(6 * 13);
      expect(count(fb, d.paper, 20, 120, 159, 172)).toBeGreaterThan(10);
      expect(count(fb, "#000000", 0, 20, 159, 172)).toBe(20 * 13);
      const tree = world.getTree();
      expect(treeHasText(tree, label), label).toBe(true);
      expect(treeHasText(tree, face.toUpperCase() + ":"), "prefix gone").toBe(false);
    }

    // The stripped text is the same glyphs, shifted right by the 72 px
    // portrait column: compare the row band against the plain-text scene.
    const spoken = shot({ modal: "speaker", faces: true });
    const plain = shot({ modal: "stripped", faces: true });
    expect(notCount(plain, DEFAULT_UI_THEME.paper, 18, 300, ROWS.y0, ROWS.y1)).toBeGreaterThan(300);
    expect(fnv1a(crop(spoken, TEXT_X.portrait, ROWS.y0, 300, ROWS.y1 - ROWS.y0))).toBe(
      fnv1a(crop(plain, TEXT_X.plain, ROWS.y0, 300, ROWS.y1 - ROWS.y0)),
    );
  });

  test("the reveal skips the name prefix", () => {
    // 13 revealed = "KEEPER: " (8) + "The l": five letters, as if "The l"
    // were the whole line.
    const typing = shot({ modal: "typing", faces: true });
    expect(treeHasText(world.getTree(), "The l")).toBe(true);
    const typed = shot({ modal: "typed", faces: true });
    expect(fnv1a(crop(typing, TEXT_X.portrait, ROWS.y0, 300, ROWS.y1 - ROWS.y0))).toBe(
      fnv1a(crop(typed, TEXT_X.plain, ROWS.y0, 300, ROWS.y1 - ROWS.y0)),
    );
    // 5 revealed is still inside "KEEPER: ": portrait and tab, no text yet.
    const prefix = shot({ modal: "prefix", faces: true });
    expect(fnv1a(crop(prefix, FACE.x, FACE.y, FACE_PX, FACE_PX))).toBe(fnv1a(faceRgba("keeper")));
    expect(count(prefix, DEFAULT_UI_THEME.border, 20, 26, 159, 172)).toBe(6 * 13);
    expect(notCount(prefix, DEFAULT_UI_THEME.paper, TEXT_X.portrait, 462, ROWS.y0, 254)).toBe(0);
  });

  test("the portrait and tab take the theme: tab on border and rim, paper text", () => {
    const fb = shot({ modal: "speaker", theme: "parchment", faces: true });
    // The frame, except where the tab (x 20..72) covers its top edge.
    expect(count(fb, PARCHMENT.border, MSG.x0, MSG.x0 + 2, MSG.y0, MSG.y1)).toBe(2 * 92);
    expect(count(fb, PARCHMENT.rim, MSG.x0 + 2, MSG.x0 + 3, MSG.y0 + 2, MSG.y1 - 2)).toBe(88);
    expect(count(fb, PARCHMENT.border, MSG.x0, MSG.x1, MSG.y1 - 2, MSG.y1)).toBe(2 * 464);
    expect(count(fb, PARCHMENT.border, 80, MSG.x1, MSG.y0, MSG.y0 + 2)).toBe(2 * 392);
    expect(count(fb, PARCHMENT.rim, 80, MSG.x1 - 2, MSG.y0 + 2, MSG.y0 + 3)).toBe(390);
    expect(fnv1a(crop(fb, FACE.x, FACE.y, FACE_PX, FACE_PX))).toBe(fnv1a(faceRgba("keeper")));
    // With a rim the tab covers the whole 3 px frame: y 160..174.
    expect(count(fb, PARCHMENT.border, 20, 26, 160, 175)).toBe(6 * 15);
    expect(count(fb, "#000000", 20, 26, 159, 160)).toBe(6);
    expect(count(fb, PARCHMENT.paper, 20, 120, 160, 172)).toBeGreaterThan(10);
    expect(count(fb, PARCHMENT.ink, TEXT_X.portrait, 400, ROWS.y0, ROWS.y1)).toBeGreaterThan(150);
  });

  test("with faces, plain lines and unknown names render exactly as without", () => {
    for (const modal of ["plain", "unknown", "stripped"] as const) {
      expect(fnv1a(shot({ modal, faces: true })), modal).toBe(fnv1a(shot({ modal })));
    }
    for (const theme of ["parchment", "slate"] as const) {
      expect(fnv1a(shot({ modal: "unknown", theme, faces: true })), theme).toBe(fnv1a(shot({ modal: "unknown", theme })));
    }
    // MAYOR has no portrait: the prefix stays, no tab, no face.
    const fb = shot({ modal: "unknown", faces: true });
    expect(treeHasText(world.getTree(), "MAYOR: Welcome to the valley.")).toBe(true);
    expect(count(fb, "#000000", 0, W, 150, 172)).toBe(W * 22);
    expect(count(fb, hexOf(FACE_PALETTES.keeper.frame), 0, W, 0, 272)).toBe(0);
  });

  test("changing the theme on an open box repaints it like a fresh one", () => {
    // Rim on -> off -> on while the box stays mounted: the renderer never
    // unsets a style key, so the paper layer must be swapped, not patched.
    const fresh = {
      parchment: fnv1a(shot({ modal: "speaker", theme: "parchment", faces: true })),
      slate: fnv1a(shot({ modal: "speaker", theme: "slate", faces: true })),
      none: fnv1a(shot({ modal: "speaker", faces: true })),
    };
    shot({ modal: "speaker", theme: "parchment", faces: true });
    expect(fnv1a(show({ modal: "speaker", faces: true }))).toBe(fresh.none);
    expect(fnv1a(show({ modal: "speaker", theme: "slate", faces: true }))).toBe(fresh.slate);
    expect(fnv1a(show({ modal: "speaker", theme: "parchment", faces: true }))).toBe(fresh.parchment);
    // Faces off on the open box: back to the plain speaker line.
    expect(fnv1a(show({ modal: "speaker", theme: "parchment" }))).toBe(fnv1a(shot({ modal: "speaker", theme: "parchment" })));
  });

  test("an open, fully revealed portrait box emits no ops on idle frames", () => {
    shot({ modal: "speaker", theme: "parchment", faces: true });
    opCount = 0;
    for (let i = 0; i < 3; i++) {
      world.frame(0);
      world.tick();
    }
    expect(opCount).toBe(0);
  });
});
