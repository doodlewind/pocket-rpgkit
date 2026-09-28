// tests/fixtures/ui-theme/gen-assets.ts — write the fixture's procedural
// portraits (faces.ts) to assets/face-<name>.png. tools/build-example.ts
// runs this before building the fixture; the PNGs are build outputs and
// stay out of git (.gitignore).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodePNG } from "../../../vendor/pocketjs/tests/png.ts";
import { FACE_PALETTES, FACE_PX, faceRgba, type FaceName } from "./faces.ts";

const OUT = join(new URL(".", import.meta.url).pathname, "assets");
mkdirSync(OUT, { recursive: true });
for (const name of Object.keys(FACE_PALETTES) as FaceName[]) {
  writeFileSync(join(OUT, `face-${name}.png`), encodePNG(faceRgba(name), FACE_PX, FACE_PX));
}
