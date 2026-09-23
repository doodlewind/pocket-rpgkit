// tools/build-example.ts — build the minimal example app against the
// vendored PocketJS. External-project invocation:
//
//   bun vendor/pocketjs/tools/build.ts <entry> --project-root=<this repo>
//
// pass 1 resolves @pocketjs/framework/* into vendor/pocketjs/framework and
// walks every RELATIVE import from the entry (../src/... included), so the
// Solid components in src/ui get their JSX transform even though they live
// outside the vendor tree. Outputs land in this repo's dist/, never in the
// submodule.

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
mkdirSync(join(root, "dist"), { recursive: true });

const buildTs = join(root, "vendor", "pocketjs", "tools", "build.ts");
const entry = join(root, "example", "app.tsx");
const args = [
  buildTs,
  entry,
  `--project-root=${root}`,
  `--outdir=${join(root, "dist")}`,
];

const proc = Bun.spawn({
  cmd: [process.execPath, ...args],
  cwd: root,
  stdio: ["inherit", "inherit", "inherit"],
});
const exit = await proc.exited;
if (exit !== 0) process.exit(exit);
