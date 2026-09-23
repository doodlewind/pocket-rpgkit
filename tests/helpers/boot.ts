// tests/helpers/boot.ts — boot the built example bundle (dist/app.js) on
// PocketJS's deterministic wasm sim host from the vendored submodule.
//
// This mirrors vendor/pocketjs/hosts/sim/sim.ts bootWorld for an external
// project: the bundle and pak live in THIS repo's dist/, and the wasm core
// lives in vendor/pocketjs/hosts/web. Every frame is one transaction; two
// runs of the same button tape produce byte-identical framebuffers.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { createWasmUi } from "../../vendor/pocketjs/hosts/web/wasm-ops.js";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DIST = join(ROOT, "dist");
const WASM_PATH = join(ROOT, "vendor", "pocketjs", "hosts", "web", "pocketjs.wasm");

let wasmBytes: ArrayBuffer | undefined;

/** Whether the example sim tests can run: they need the built bundle
 *  (`bun run build:example`) and the vendored wasm core
 *  (`bun run build:wasm`). A fresh `bun install && bun test` reports the
 *  reducer suites green and skips these with the missing-artifact reason. */
export function simPreflight(): { ok: true } | { ok: false; reason: string } {
  const bundle = join(DIST, "app.js");
  if (!existsSync(bundle)) {
    return { ok: false, reason: `missing ${bundle} — run \`bun run build:example\`` };
  }
  if (!existsSync(WASM_PATH)) {
    return { ok: false, reason: `missing ${WASM_PATH} — run \`bun run build:wasm\`` };
  }
  return { ok: true };
}

export interface SimWorld {
  frame: (buttons: number, analog?: number) => void;
  tick: () => void;
  render: () => Uint8Array;
  resizeViewport: (w: number, h: number) => void;
}

/** FNV-1a 32 over RGBA bytes, identical to vendor hosts/sim sim.ts fnv1a. */
export function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export async function bootExample(
  hz = 60,
  extraGlobals?: Record<string, unknown>,
  viewport: { width: number; height: number } = { width: 480, height: 272 },
): Promise<SimWorld> {
  for (const [path, hint] of [
    [join(DIST, "app.js"), "run `bun run build:example`"],
    [WASM_PATH, "run `(cd vendor/pocketjs && bun tools/wasm.ts)`"],
  ] as const) {
    if (!existsSync(path)) throw new Error(`missing ${path} — ${hint}`);
  }
  wasmBytes ??= await Bun.file(WASM_PATH).arrayBuffer();
  const wasm = await createWasmUi(wasmBytes, viewport);
  const g = globalThis as Record<string, unknown>;
  g.ui = wasm.ops;
  g.__pak = existsSync(join(DIST, "app.pak"))
    ? await Bun.file(join(DIST, "app.pak")).arrayBuffer()
    : undefined;
  g.frame = undefined;
  g.offload = undefined;
  g.audio = undefined;
  g.db = undefined;
  g.fs = undefined;
  g.__pocketApp = "app";
  g.__simHz = hz;
  const inbox: unknown[] = [];
  const outbox: unknown[] = [];
  g.__pocketEffectTrace = (): void => {};
  g.__pocketEffectDriver = undefined;
  g.__pocketDevtoolsTransport = {
    send: (line: unknown) => outbox.push(line),
    recv: () => (inbox.length ? (inbox.shift() as unknown) : null),
  };
  if (extraGlobals) Object.assign(g, extraGlobals);
  (0, eval)(await Bun.file(join(DIST, "app.js")).text());
  const appFrame = g.frame as ((buttons: number, analog?: number) => void) | undefined;
  if (typeof appFrame !== "function") {
    throw new Error("sim: example bundle did not install globalThis.frame");
  }
  return {
    frame: (buttons, analog) => appFrame(buttons, analog),
    tick: wasm.tick,
    render: () => wasm.renderScaled(1),
    resizeViewport: (w, h) => {
      wasm.resizeViewport(w, h);
      (g.__pocketResizeViewport as ((w: number, h: number) => void) | undefined)?.(w, h);
    },
  };
}

export interface ExampleState {
  frame: number;
  mapId: string;
  move: { tx: number; ty: number; px: number; py: number; facing: number; phase: number; walking: boolean };
  sw: { gold: number; items: Record<string, number>; switches: Record<string, boolean> };
  interp: { modal: unknown; cues: unknown[]; frame: number };
}

/** The live reducer state the example app exposes. */
export function exampleState(): any {
  return (globalThis as any).__rpgkitExample.state() as ExampleState;
}
