// tools/desktop.ts — build an example for the PocketJS desktop host and run
// it in a window: macos-app on a Mac, linux-app elsewhere.
//
//   bun tools/desktop.ts sunstone              # build, then launch (Cmd+Q quits)
//   bun tools/desktop.ts grow --build-only     # bundle + release host, no window
//   bun tools/desktop.ts sunstone -- --quit-after 900   # extra host flags pass through
//
// PocketJS's own `bun run macos <app>` only knows apps inside its checkout,
// so this mirrors it for an external project: resolve the example's
// pocket.json against the desktop target with the vendored manifest
// resolver, build the bundle from that plan into dist/<target>/, build the
// portable Rust host, and start it with --js/--pak pointing at this repo's
// artifacts. Every host flag derives from the resolved plan.

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { validateAndResolveBuildPlan } from "../vendor/pocketjs/framework/src/manifest/resolve.ts";
import { EXAMPLES } from "./build-example.ts";

const root = resolve(import.meta.dir, "..");
const pocketjs = join(root, "vendor", "pocketjs");
const target = process.platform === "darwin" ? "macos-app" : "linux-app";

const argv = process.argv.slice(2).filter((a) => a !== "--");
const buildOnly = argv.includes("--build-only");
const rest = argv.filter((a) => a !== "--build-only");
const name = rest[0] && !rest[0].startsWith("--") ? rest.shift()! : "sunstone";
if (!(EXAMPLES as readonly string[]).includes(name)) {
  throw new Error(`desktop: unknown example "${name}" (have: ${EXAMPLES.join(", ")})`);
}

const manifest = await Bun.file(join(root, "examples", name, "pocket.json")).json();
const resolution = validateAndResolveBuildPlan(manifest, { target });
if (!resolution.ok) {
  throw new Error(
    `desktop: examples/${name}/pocket.json did not resolve against ${target}: ` +
      resolution.diagnostics.map((d) => `${d.path || "/"}: ${d.message}`).join("; "),
  );
}
const plan = resolution.plan;

const outdir = join(root, "dist", target);
mkdirSync(outdir, { recursive: true });
const planPath = join(root, ".pocket", target, `${plan.app.output}.plan.json`);
mkdirSync(resolve(planPath, ".."), { recursive: true });
await Bun.write(planPath, JSON.stringify(plan, null, 2) + "\n");
await $`bun ${join(pocketjs, "tools", "build.ts")} --plan=${planPath} --project-root=${root} --outdir=${outdir}`.cwd(root);
await $`cargo build --release`.cwd(join(pocketjs, "hosts", "desktop"));

const bin = join(pocketjs, "hosts", "desktop", "target", "release", "pocket-desktop-host");
if (buildOnly) {
  console.log(`desktop: built ${plan.app.output} for ${target} + release host (${bin})`);
  process.exit(0);
}

const flags = [
  "--app", plan.app.output,
  // The per-app data.fs root keys off the reverse-DNS app id.
  "--app-id", plan.app.id,
  "--title", plan.app.title,
  "--viewport", `${plan.viewport.logical[0]}x${plan.viewport.logical[1]}`,
  "--density", String(plan.viewport.rasterDensity),
  ...(plan.viewport.policy === "fixed" ? ["--fixed"] : []),
  ...(plan.companions.length > 0 ? ["--companions", plan.companions.join(",")] : []),
  "--js", join(outdir, `${plan.app.output}.js`),
  "--pak", join(outdir, `${plan.app.output}.pak`),
];
const env = { ...process.env, RUST_LOG: process.env.RUST_LOG ?? "info" };
await $`${bin} ${flags} ${rest}`.env(env);
