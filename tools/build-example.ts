// tools/build-example.ts — build the example apps against the vendored
// PocketJS. External-project invocation:
//
//   bun tools/build-example.ts                 # every example
//   bun tools/build-example.ts sunstone grow   # just these
//
// Each example is one entry `examples/<name>/<name>.tsx`, so the build
// writes dist/<name>.js and dist/<name>.pak. Pass 1 resolves
// @pocketjs/framework/* into vendor/pocketjs/framework and walks every
// RELATIVE import from the entry (../../src/... included), so the Solid
// components in src/ui get their JSX transform even though they live
// outside the vendor tree. images.json / sprites.json are read from the
// example's own directory. Outputs land in this repo's dist/, never in the
// submodule.

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const EXAMPLES = ["meadow", "sunstone", "grow"] as const;

const root = resolve(import.meta.dir, "..");

const buildTs = join(root, "vendor", "pocketjs", "tools", "build.ts");

if (import.meta.main) await buildExamples(process.argv.slice(2));

async function buildExamples(wanted: string[]): Promise<void> {
  mkdirSync(join(root, "dist"), { recursive: true });
  for (const name of wanted) {
    if (!(EXAMPLES as readonly string[]).includes(name)) {
      console.error(`build-example: unknown example "${name}" (have: ${EXAMPLES.join(", ")})`);
      process.exit(2);
    }
  }
  for (const name of wanted.length ? wanted : EXAMPLES) {
    const entry = join(root, "examples", name, `${name}.tsx`);
    if (!existsSync(entry)) throw new Error(`build-example: missing ${entry}`);
    const proc = Bun.spawn({
      cmd: [process.execPath, buildTs, entry, `--project-root=${root}`, `--outdir=${join(root, "dist")}`],
      cwd: root,
      stdio: ["inherit", "inherit", "inherit"],
    });
    const exit = await proc.exited;
    if (exit !== 0) process.exit(exit);
  }
}
