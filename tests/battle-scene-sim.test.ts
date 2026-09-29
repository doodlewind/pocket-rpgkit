import { describe, expect, test } from "bun:test";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { treeHasText } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import { bootGameWorld, installGameSimIsolation } from "./helpers/sim-session.ts";

const preflight = appPreflight("r2-ui");
if (!preflight.ok) console.warn(`battle scene sim test skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
installGameSimIsolation();

simDescribe("GameView battle scene host", () => {
  test("hides the map, renders only reducer state plus resolution, then restores the map", async () => {
    const world = await bootGameWorld(appBundle("r2-ui"), 60, { __r2Battle: true });
    const step = (buttons = 0): void => {
      world.frame(buttons, 0x8080);
      world.tick();
    };
    step();

    expect(world.probes().state.scene?.kind).toBe("battle");
    let tree = world.getTree();
    expect(treeHasText(tree, "TOY BATTLE")).toBe(true);
    expect(treeHasText(tree, "480x272")).toBe(true);
    expect(JSON.stringify(tree)).toContain("toy-battle-scene");
    expect(JSON.stringify(tree)).not.toContain("rpgkit-world-frame");
    const frame = world.render();
    expect([...frame.subarray(0, 4)]).toEqual([0x39, 0x16, 0x4f, 0xff]);

    step(BTN.CIRCLE);
    step();
    for (let i = 0; i < 16; i++) step();
    expect(world.probes().state.scene).toBeNull();
    expect(world.probes().state.sw.switches["battle-ui-won"]).toBe(true);
    tree = world.getTree();
    expect(treeHasText(tree, "TOY BATTLE")).toBe(false);
    expect(JSON.stringify(tree)).toContain("rpgkit-world-frame");
  });

  test("shows a fatal content error and keeps the reducer frozen", async () => {
    const world = await bootGameWorld(appBundle("r2-ui"), 60, { __r2FatalTransfer: true });
    const step = (): void => {
      world.frame(0, 0x8080);
      world.tick();
    };
    step();

    const failed = structuredClone(world.probes().state);
    expect(failed.interp.error).toEqual({
      kind: "content",
      message: "transfer in r2-ui-field/fatal-transfer: map variable must hold a non-empty string",
    });
    const tree = world.getTree();
    expect(treeHasText(tree, "EVENT ERROR")).toBe(true);
    expect(treeHasText(tree, "transfer in r2-ui-field/fatal-transfer:")).toBe(true);
    expect(JSON.stringify(tree)).toContain("rpgkit-fatal-error");

    step();
    const frozen = world.probes().state;
    expect(frozen.frame).toBeGreaterThan(failed.frame);
    expect(frozen.interp).toEqual(failed.interp);
    expect(frozen.move).toEqual(failed.move);
  });
});
