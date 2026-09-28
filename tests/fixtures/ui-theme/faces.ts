// tests/fixtures/ui-theme/faces.ts — procedural 64x64 speaker portraits for
// the ui-theme sim fixture. No art assets: each face is a framed flat-colour
// drawing (frame ring, backdrop, hair, skin oval, two eyes), fully opaque so
// the sim test can compare the framebuffer against these exact pixels.
// gen-assets.ts writes them as assets/face-<name>.png before the fixture
// build (pak images must be power-of-two, so the canvas is 64x64).

export const FACE_PX = 64;

type Rgb = readonly [number, number, number];

export interface FacePalette {
  frame: Rgb;
  backdrop: Rgb;
  hair: Rgb;
  skin: Rgb;
  eye: Rgb;
}

/** Two speakers with disjoint palettes, so a test can tell WHICH portrait
 *  the dialog picked, not just that one is showing. */
export const FACE_PALETTES = {
  keeper: {
    frame: [0x1f, 0x6f, 0x5c],
    backdrop: [0x9c, 0xd8, 0xe8],
    hair: [0x5a, 0x34, 0x1c],
    skin: [0xf0, 0xc0, 0x90],
    eye: [0x10, 0x10, 0x30],
  },
  clerk: {
    frame: [0x7a, 0x1e, 0x3c],
    backdrop: [0xf4, 0xe0, 0x7c],
    hair: [0x22, 0x22, 0x22],
    skin: [0xd8, 0x98, 0x70],
    eye: [0x30, 0x10, 0x10],
  },
} as const satisfies Record<string, FacePalette>;

export type FaceName = keyof typeof FACE_PALETTES;

/** RGBA bytes of one portrait. */
export function faceRgba(name: FaceName): Uint8Array {
  const p = FACE_PALETTES[name];
  const out = new Uint8Array(FACE_PX * FACE_PX * 4);
  for (let y = 0; y < FACE_PX; y++) {
    for (let x = 0; x < FACE_PX; x++) {
      let c: Rgb = p.backdrop;
      const ring = Math.min(x, y, FACE_PX - 1 - x, FACE_PX - 1 - y);
      const dx = (x - 31.5) / 17;
      const dy = (y - 36) / 21;
      if (ring < 3) c = p.frame;
      else if (dx * dx + dy * dy <= 1) {
        c = y < 26 ? p.hair : p.skin;
        const eyeRow = y >= 33 && y < 37;
        if (eyeRow && ((x >= 23 && x < 27) || (x >= 37 && x < 41))) c = p.eye;
      }
      const i = (y * FACE_PX + x) * 4;
      out[i] = c[0];
      out[i + 1] = c[1];
      out[i + 2] = c[2];
      out[i + 3] = 255;
    }
  }
  return out;
}
