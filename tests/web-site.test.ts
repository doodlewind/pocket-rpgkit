// tests/web-site.test.ts — the web site builder (tools/web.ts) without a
// browser and without building bundles: game discovery, the metadata
// table's fallbacks, viewport policy, the key table, screen sizing, and
// the pages' URLs. tools/web-verify.ts plays the built site in Chrome.

import { describe, expect, test } from "bun:test";
import { EXAMPLES } from "../tools/build-example.ts";
import {
  cardOrder,
  defaultGameIds,
  KIT_ROOT,
  loadSiteConfig,
  parseSiteConfig,
  renderLanding,
  renderPlayer,
  resolveGame,
  shortTitle,
  viewportFor,
  type PlayerConfig,
  type WebGame,
} from "../tools/web.ts";
import { fitViewport, type ViewportConfig } from "../tools/web/fit.ts";
import { BTN, KEYMAP, keyMasks, keysFor, withKeys } from "../tools/web/keys.ts";

const config = loadSiteConfig(KIT_ROOT);
const site = { title: config.title!, intro: config.intro!, source: config.source! };

function playerConfig(game: WebGame): PlayerConfig {
  return {
    id: game.id,
    app: game.plan.app.output,
    bundle: `${game.plan.app.output}.js`,
    pak: `${game.plan.app.output}.pak`,
    wasm: "../pocketjs.wasm",
    viewport: game.viewport,
    rasterDensity: game.plan.viewport.rasterDensity,
    companions: [...game.plan.companions],
    simHz: 60,
    keys: keyMasks(game.keymap),
  };
}

/** Every src/href in a page, minus data: URIs. */
function urls(html: string): string[] {
  return [...html.matchAll(/\b(?:src|href)="([^"]*)"/g)].map((m) => m[1]!).filter((u) => !u.startsWith("data:"));
}

describe("games", () => {
  test("with no names, this repository builds every example in EXAMPLES", () => {
    expect(defaultGameIds(KIT_ROOT)).toEqual([...EXAMPLES]);
  });

  test("cards follow the metadata table, then the rest in build order", () => {
    // "later" stands for an example with no web.json entry yet.
    expect(cardOrder(["meadow", "sunstone", "later", "grow", "wander"], config)).toEqual(["sunstone", "grow", "wander", "meadow", "later"]);
    expect(cardOrder(["later", "meadow"], config)).toEqual(["meadow", "later"]);
  });

  test("every example resolves against web-app", () => {
    for (const id of EXAMPLES) {
      const game = resolveGame(KIT_ROOT, config, id);
      expect(game.plan.target.id).toBe("web-app");
      expect(game.title.length).toBeGreaterThan(0);
      expect(game.controls.length).toBeGreaterThan(0);
    }
  });

  test("viewports: sunstone pinned fixed, grow dynamic from its plan, meadow fixed", () => {
    expect(resolveGame(KIT_ROOT, config, "sunstone").viewport).toEqual({ policy: "fixed", logical: [480, 272] });
    expect(resolveGame(KIT_ROOT, config, "grow").viewport).toEqual({
      policy: "dynamic", default: [960, 544], min: [480, 272], max: [4096, 4096],
    });
    expect(resolveGame(KIT_ROOT, config, "meadow").viewport).toEqual({ policy: "fixed", logical: [480, 272] });
  });

  test("a game without a table entry gets a plain card", () => {
    const game = resolveGame(KIT_ROOT, {}, "meadow");
    expect(game.title).toBe("Pocket RPG Kit — Mini Meadow");
    expect(resolveGame(KIT_ROOT, { title: "Pocket RPG Kit" }, "meadow").title).toBe("Mini Meadow");
    expect(game.description).toBe("");
    expect(game.preview).toBeUndefined();
    expect(game.controls.map((c) => c.button)).toEqual(["DPAD", "CIRCLE", "CROSS"]);
  });

  test("an unknown game names the examples it looked for", () => {
    expect(() => resolveGame(KIT_ROOT, config, "nope")).toThrow(/no pocket\.json for "nope".*sunstone/);
  });

  test("the table is validated", () => {
    const parse = (value: unknown) => () => parseSiteConfig(value, "web.json");
    expect(parse({ games: [{ id: "meadow" }] })).toThrow(/table keyed by game id/);
    expect(parse({ games: { "../x": {} } })).toThrow(/not a usable game id/);
    expect(parse({ games: { meadow: { controls: [{ button: "TURBO", action: "x" }] } } })).toThrow(/known button/);
    expect(parse({ games: { meadow: { keys: { KeyA: "TURBO" } } } })).toThrow(/not a button/);
    expect(parse({ games: { meadow: { viewport: "stretch" } } })).toThrow(/"fixed" or "dynamic"/);
    expect(parse({ games: { meadow: {} } })()).toEqual({ games: { meadow: {} } });
  });

  test("viewportFor: dynamic-only manifests, and pins the manifest cannot honor", () => {
    const grow = resolveGame(KIT_ROOT, config, "grow");
    const dynamicOnly = { app: { viewport: { dynamic: { default: [960, 544], min: [480, 272], max: [2048, 2048] } } } };
    expect(viewportFor(dynamicOnly, grow.plan)).toEqual({ policy: "dynamic", default: [960, 544], min: [480, 272], max: [2048, 2048] });
    expect(() => viewportFor(dynamicOnly, grow.plan, "fixed")).toThrow(/pins a fixed viewport/);
    expect(shortTitle("Pocket RPG Kit — Wander", "Pocket RPG Kit")).toBe("Wander");
    expect(shortTitle("Alpine Post", "Pocket RPG Kit")).toBe("Alpine Post");
  });
});

describe("pages", () => {
  const games = cardOrder([...EXAMPLES], config).map((id) => resolveGame(KIT_ROOT, config, id));

  test("the landing page links every game with relative URLs", () => {
    const html = renderLanding(site, games.map((game) => ({ game, preview: [480, 272] as [number, number] })));
    for (const game of games) {
      expect(html).toContain(`href="${game.id}/"`);
      expect(html).toContain(`src="${game.id}/preview.png"`);
    }
    for (const url of urls(html)) expect(url.startsWith("/") || url.startsWith("./..")).toBe(false);
    expect(urls(html)).toContain("site.css");
  });

  test("a card without a preview gets a placeholder, not a broken image", () => {
    const html = renderLanding(site, [{ game: games[0]! }]);
    expect(html).not.toContain("preview.png");
    expect(html).toContain('class="no-preview"');
  });

  test("player pages load everything relative to the page", () => {
    for (const game of games) {
      const html = renderPlayer(site, game, playerConfig(game), true);
      const links = urls(html);
      expect(links).toContain("../site.css");
      expect(links).toContain("../player.js");
      expect(links).toContain("../");
      expect(links).toContain("ATTRIBUTION.txt");
      for (const url of links) {
        if (/^https:\/\//.test(url)) continue;
        expect(url.startsWith("/")).toBe(false);
      }
      const json = /<script type="application\/json" id="pocket-game">(.*?)<\/script>/s.exec(html)![1]!;
      const parsed = JSON.parse(json) as PlayerConfig;
      expect(parsed.wasm).toBe("../pocketjs.wasm");
      expect(parsed.bundle).toBe(`${game.plan.app.output}.js`);
      expect(parsed.viewport).toEqual(game.viewport);
      expect(parsed.keys.KeyA).toBe(BTN.CIRCLE);
      expect(html).toContain(`data-viewport="${game.viewport.policy}"`);
    }
  });

  test("text is escaped and the settings cannot close their script tag", () => {
    const game = { ...games[0]!, title: "<b>A&B</b>", description: '"</script>"' };
    const html = renderPlayer(site, game, { ...playerConfig(game), app: "</script><x>" }, false);
    expect(html).toContain("&lt;b&gt;A&amp;B&lt;/b&gt;");
    expect(html.match(/<\/script>/g)!.length).toBe(2);
    expect(html).not.toContain("ATTRIBUTION.txt");
  });

  test("the controls print the keys that press each button", () => {
    const grow = games.find((g) => g.id === "grow")!;
    const html = renderPlayer(site, grow, playerConfig(grow), true);
    expect(html).toContain("<kbd>←</kbd> <kbd>→</kbd></th><td>Step the timeline");
    expect(html).toContain("<kbd>A</kbd> <kbd>Enter</kbd> <kbd>Z</kbd></th><td>Walk into the finished village");
    expect(html).toContain('data-button="TRIANGLE">X</button>');
  });
});

describe("keys", () => {
  test("letter keys match the web-app glyphs; Enter and Z also confirm", () => {
    expect(keysFor("CIRCLE")).toEqual(["A", "Enter", "Z"]);
    expect(keysFor("CROSS")).toEqual(["B", "Esc", "Backspace"]);
    expect(keysFor("TRIANGLE")).toEqual(["X"]);
    expect(keysFor("SQUARE")).toEqual(["Y"]);
    expect(keysFor("DPAD")).toEqual(["Arrow keys"]);
    expect(keyMasks().Space).toBe(BTN.START);
    expect(Object.keys(KEYMAP)).not.toContain("Tab");
  });

  test("a game can rebind and unbind keys", () => {
    const keymap = withKeys({ KeyA: "SQUARE", KeyY: null, Tab: "SELECT" });
    expect(keysFor("SQUARE", keymap)).toEqual(["A"]);
    expect(keysFor("CIRCLE", keymap)).toEqual(["Enter", "Z"]);
    expect(keysFor("SELECT", keymap)).toEqual(["Shift", "Tab"]);
    expect(keyMasks(keymap).KeyY).toBeUndefined();
    expect(() => withKeys({ "Key A": "CIRCLE" })).toThrow(/KeyboardEvent\.code/);
  });
});

describe("screen sizing", () => {
  const fixed: ViewportConfig = { policy: "fixed", logical: [480, 272] };
  const dynamic: ViewportConfig = { policy: "dynamic", default: [960, 544], min: [480, 272], max: [4096, 4096] };

  test("fixed: the largest whole scale that fits, in device pixels", () => {
    expect(fitViewport(fixed, 1408, 894, 1)).toEqual({ size: [480, 272], k: 2 });
    expect(fitViewport(fixed, 1408, 894, 2)).toEqual({ size: [480, 272], k: 5 });
    // 1.25: 3 device pixels per game pixel = 1152 CSS px, not 2.5x smeared.
    expect(fitViewport(fixed, 1408, 894, 1.25)).toEqual({ size: [480, 272], k: 3 });
    expect(fitViewport(fixed, 358, 600, 3)).toEqual({ size: [480, 272], k: 2 });
    expect(fitViewport(fixed, 300, 600, 1).k).toBe(0);
  });

  test("dynamic: the viewport follows the area at the largest scale above the minimum", () => {
    for (const [w, h, dpr] of [[1408, 894, 1], [1408, 894, 2], [968, 600, 1], [358, 700, 3], [2528, 794, 1], [1000, 700, 1.25]] as const) {
      const { size, k } = fitViewport(dynamic, w, h, dpr);
      const deviceW = Math.floor(w * dpr);
      const deviceH = Math.floor(Math.min(h, (w * 544) / 960) * dpr);
      expect(k).toBeGreaterThanOrEqual(1);
      expect(size[0]).toBeGreaterThanOrEqual(480);
      expect(size[1]).toBeGreaterThanOrEqual(272);
      expect(size[0] * k).toBeLessThanOrEqual(deviceW);
      expect(size[1] * k).toBeLessThanOrEqual(deviceH);
      // One step larger would drop below the minimum.
      expect(Math.floor(deviceW / (k + 1)) < 480 || Math.floor(deviceH / (k + 1)) < 272).toBe(true);
      // Never taller than the default shape.
      expect(size[1] / size[0]).toBeLessThanOrEqual(544 / 960 + 0.01);
    }
    expect(fitViewport(dynamic, 1408, 894, 1)).toEqual({ size: [704, 398], k: 2 });
    expect(fitViewport(dynamic, 300, 200, 1)).toEqual({ size: [480, 272], k: 0 });
    expect(fitViewport({ ...dynamic, max: [600, 300] }, 1408, 894, 1)).toEqual({ size: [600, 300], k: 2 });
  });
});
