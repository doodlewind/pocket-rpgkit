// tools/build-example.ts — build the example apps and the sim test
// fixtures against the vendored PocketJS. External-project invocation:
//
//   bun tools/build-example.ts                 # every example and fixture
//   bun tools/build-example.ts sunstone grow   # just these
//
// Each example is one entry `examples/<name>/<name>.tsx` and each test
// fixture one entry `tests/fixtures/<name>/<name>.tsx`, so the build writes
// dist/<name>.js and dist/<name>.pak. A fixture's gen-assets.ts, when it
// has one, runs first and writes the fixture's procedural art. Pass 1
// resolves @pocketjs/framework/* into vendor/pocketjs/framework and walks
// every RELATIVE import from the entry (../../src/... included), so the
// Solid components in src/ui get their JSX transform even though they live
// outside the vendor tree. images.json / sprites.json are read from the
// entry's own directory. Outputs land in this repo's dist/, never in the
// submodule.

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const EXAMPLES = ["meadow", "sunstone", "grow"] as const;
/** Small apps that exist only for the sim suites. */
export const FIXTURES = ["ui-theme"] as const;

const root = resolve(import.meta.dir, "..");

const buildTs = join(root, "vendor", "pocketjs", "tools", "build.ts");

if (import.meta.main) await buildExamples(process.argv.slice(2));

function isFixture(name: string): boolean {
  return (FIXTURES as readonly string[]).includes(name);
}

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn({ cmd, cwd: root, stdio: ["inherit", "inherit", "inherit"] });
  const exit = await proc.exited;
  if (exit !== 0) process.exit(exit);
}

async function buildExamples(wanted: string[]): Promise<void> {
  mkdirSync(join(root, "dist"), { recursive: true });
  const known: readonly string[] = [...EXAMPLES, ...FIXTURES];
  for (const name of wanted) {
    if (!known.includes(name)) {
      console.error(`build-example: unknown example "${name}" (have: ${known.join(", ")})`);
      process.exit(2);
    }
  }
  for (const name of wanted.length ? wanted : known) {
    const dir = isFixture(name) ? join(root, "tests", "fixtures", name) : join(root, "examples", name);
    const entry = join(dir, `${name}.tsx`);
    if (!existsSync(entry)) throw new Error(`build-example: missing ${entry}`);
    const gen = join(dir, "gen-assets.ts");
    if (isFixture(name) && existsSync(gen)) await run([process.execPath, gen]);
    await run([process.execPath, buildTs, entry, `--project-root=${root}`, `--outdir=${join(root, "dist")}`]);
  }
}
