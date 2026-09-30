// tests/k4-shop.test.ts — T2-10 shop: buy/sell over gold and item counts,
// price resolution (goods override vs. the item's own catalog price, sell
// always independent of a shop's override), the 99-item backpack cap, and
// determinism (multi-hz agreement, mid-shop JSON round-trip).

import { describe, expect, test } from "bun:test";
import {
  createInterpState,
  createSwitchState,
  createWorld,
  SHOP_ITEM_CAP,
  stepInterp,
  type InterpInput,
  type InterpState,
  type ShopModal,
} from "../src/engine/interpreter.ts";
import { createSession, startSession, stepSession, type SessionState } from "../src/engine/session.ts";
import { validateSchema } from "../src/engine/schema-validate.ts";
import schema from "../src/data/schema.json" with { type: "json" };
import type { Command, GameEvent, Item, MapDef, Project, ShopGood, TileId } from "../src/engine/types.ts";

const MAP_ID = "v";
const GRASS: TileId = "town.0";
const NO_EDGE = { confirmEdge: false, cancelEdge: false, upEdge: false, downEdge: false };

function iinput(partial: Partial<InterpInput> = {}): InterpInput {
  const cell = partial.playerCell ?? { x: 10, y: 10 };
  return { ...NO_EDGE, playerCell: cell, prevCell: partial.prevCell ?? cell, facing: partial.facing ?? 2, ...partial };
}
function imap(events: GameEvent[]): MapDef {
  return { id: MAP_ID, name: "t", width: 20, height: 13, sheets: ["town"], ground: Array(260).fill(GRASS), events };
}
function shopEvent(
  goods: ShopGood[],
  opts: { sell?: boolean; id?: string; sellList?: "disable" | "hide" } = {},
): GameEvent {
  return {
    id: "e", x: 10, y: 10,
    pages: [{
      trigger: "action", sprite: null,
      commands: [
        { op: "shop", id: opts.id ?? "shop", goods, sell: opts.sell ?? true, sellList: opts.sellList },
        { op: "variable", id: "afterShop", set: { op: "set", value: 1 } },
      ],
    }],
  };
}
function modal(s: InterpState): ShopModal {
  expect(s.modal?.kind).toBe("shop");
  return s.modal as ShopModal;
}

describe("T2-10 shop — opening and row content", () => {
  test("opens a buy-stage modal: goods in authored order, then sell, then leave", () => {
    const items: Item[] = [{ id: "torch", name: "Torch", sprite: "t.0", price: 50 }];
    const w = createWorld(imap([shopEvent([{ item: "key", price: 10 }, { item: "torch" }])]), [], 60, { items });
    let s = createInterpState(createSwitchState({ gold: 5 }));
    s = stepInterp(w, s, iinput({ confirmEdge: true }));
    const m = modal(s);
    expect(m.gold).toBe(5);
    expect(m.stage).toBe("buy");
    expect(m.index).toBe(0);
    expect(m.sell).toBe(true);
    expect(m.rows).toEqual([
      { kind: "item", item: "key", price: 10, owned: 0, canAfford: false, atCap: false, stock: null, sellable: true },
      // falls back to the catalog price
      { kind: "item", item: "torch", price: 50, owned: 0, canAfford: false, atCap: false, stock: null, sellable: true },
      { kind: "sell" },
      { kind: "leave" },
    ]);
  });

  test("an item absent from goods.price AND the catalog prices at 0", () => {
    const w = createWorld(imap([shopEvent([{ item: "junk" }])]));
    let s = createInterpState(createSwitchState({ gold: 0 }));
    s = stepInterp(w, s, iinput({ confirmEdge: true }));
    expect(modal(s).rows[0]).toMatchObject({ item: "junk", price: 0, canAfford: true });
  });

  test("sell:false hides the sell control row", () => {
    const w = createWorld(imap([shopEvent([{ item: "key", price: 1 }], { sell: false })]));
    let s = createInterpState();
    s = stepInterp(w, s, iinput({ confirmEdge: true }));
    const m = modal(s);
    expect(m.sell).toBe(false);
    expect(m.rows.map((r) => r.kind)).toEqual(["item", "leave"]);
  });
});

describe("T2-10 shop — buying", () => {
  test("buying an affordable item spends gold and adds one unit; repeat confirms buy more", () => {
    const w = createWorld(imap([shopEvent([{ item: "key", price: 10 }])]));
    let s = createInterpState(createSwitchState({ gold: 25 }));
    s = stepInterp(w, s, iinput({ confirmEdge: true })); // open, cursor on "key"
    s = stepInterp(w, s, iinput({ confirmEdge: true })); // buy #1
    expect(s.sw.gold).toBe(15);
    expect(s.sw.items.key).toBe(1);
    s = stepInterp(w, s, iinput({ confirmEdge: true })); // buy #2
    expect(s.sw.gold).toBe(5);
    expect(s.sw.items.key).toBe(2);
    expect(s.modal?.kind).toBe("shop"); // still open
  });

  test("insufficient gold refuses the purchase without changing state", () => {
    const w = createWorld(imap([shopEvent([{ item: "key", price: 10 }])]));
    let s = createInterpState(createSwitchState({ gold: 5 }));
    s = stepInterp(w, s, iinput({ confirmEdge: true }));
    s = stepInterp(w, s, iinput({ confirmEdge: true }));
    expect(s.sw.gold).toBe(5);
    expect(s.sw.items.key ?? 0).toBe(0);
    expect(modal(s).rows[0]).toMatchObject({ canAfford: false });
  });

  test(`the backpack cap (${SHOP_ITEM_CAP}) refuses a purchase even with unlimited gold`, () => {
    const w = createWorld(imap([shopEvent([{ item: "key", price: 1 }])]));
    let s = createInterpState(createSwitchState({ gold: 1_000_000, items: { key: SHOP_ITEM_CAP } }));
    s = stepInterp(w, s, iinput({ confirmEdge: true }));
    expect(modal(s).rows[0]).toMatchObject({ owned: SHOP_ITEM_CAP, atCap: true });
    s = stepInterp(w, s, iinput({ confirmEdge: true }));
    expect(s.sw.items.key).toBe(SHOP_ITEM_CAP);
    expect(s.sw.gold).toBe(1_000_000);
  });

  test("one under the cap can still be bought, landing exactly at the cap", () => {
    const w = createWorld(imap([shopEvent([{ item: "key", price: 1 }])]));
    let s = createInterpState(createSwitchState({ gold: 10, items: { key: SHOP_ITEM_CAP - 1 } }));
    s = stepInterp(w, s, iinput({ confirmEdge: true }));
    s = stepInterp(w, s, iinput({ confirmEdge: true }));
    expect(s.sw.items.key).toBe(SHOP_ITEM_CAP);
  });

  test("a shop's goods price overrides the item's own catalog price for buying", () => {
    const items: Item[] = [{ id: "torch", name: "Torch", sprite: "t.0", price: 50 }];
    const w = createWorld(imap([shopEvent([{ item: "torch", price: 5 }])]), [], 60, { items });
    let s = createInterpState(createSwitchState({ gold: 5 }));
    s = stepInterp(w, s, iinput({ confirmEdge: true }));
    expect(modal(s).rows[0]).toMatchObject({ price: 5 });
    s = stepInterp(w, s, iinput({ confirmEdge: true }));
    expect(s.sw.gold).toBe(0);
    expect(s.sw.items.torch).toBe(1);
  });
});

describe("T2-10 shop — selling", () => {
  function sellSetup(torchPrice: number, shopOverridePrice?: number) {
    const items: Item[] = [{ id: "torch", name: "Torch", sprite: "t.0", price: torchPrice }];
    const goods = shopOverridePrice === undefined ? [{ item: "torch" }] : [{ item: "torch", price: shopOverridePrice }];
    const w = createWorld(imap([shopEvent(goods)]), [], 60, { items });
    let s = createInterpState(createSwitchState({ gold: 0, items: { torch: 3 } }));
    s = stepInterp(w, s, iinput({ confirmEdge: true })); // open, buy stage, cursor 0 (torch)
    s = stepInterp(w, s, iinput({ downEdge: true })); // cursor -> "sell" row
    s = stepInterp(w, s, iinput({ confirmEdge: true })); // enter sell stage
    expect(modal(s).stage).toBe("sell");
    return { w, s };
  }

  test("sells for floor(item.price / 2), independent of a shop's buy-price override", () => {
    const { w, s: s0 } = sellSetup(50, 999); // the shop sells torches for 999, but that must not affect selling
    let s = s0;
    expect(modal(s).rows[0]).toMatchObject({ item: "torch", price: 25, owned: 3 });
    s = stepInterp(w, s, iinput({ confirmEdge: true })); // sell one
    expect(s.sw.gold).toBe(25);
    expect(s.sw.items.torch).toBe(2);
  });

  test("an odd base price floors the sell price", () => {
    const { w, s: s0 } = sellSetup(5);
    let s = s0;
    expect(modal(s).rows[0]).toMatchObject({ price: 2 }); // floor(5/2)
    s = stepInterp(w, s, iinput({ confirmEdge: true }));
    expect(s.sw.gold).toBe(2);
  });

  test("selling to zero drops the row from the sell list on the next render", () => {
    const items: Item[] = [{ id: "torch", name: "Torch", sprite: "t.0", price: 4 }];
    const w = createWorld(imap([shopEvent([{ item: "torch" }])]), [], 60, { items });
    let s = createInterpState(createSwitchState({ gold: 0, items: { torch: 1 } }));
    s = stepInterp(w, s, iinput({ confirmEdge: true }));
    s = stepInterp(w, s, iinput({ downEdge: true }));
    s = stepInterp(w, s, iinput({ confirmEdge: true })); // sell stage, one row + back
    expect(modal(s).rows.map((r) => r.kind)).toEqual(["item", "back"]);
    s = stepInterp(w, s, iinput({ confirmEdge: true })); // sell the last one
    expect(s.sw.items.torch).toBe(0);
    expect(modal(s).rows.map((r) => r.kind)).toEqual(["back"]);
  });

  test("cancel returns from sell to buy; cancel again leaves the shop", () => {
    const { w, s: s0 } = sellSetup(10);
    let s = stepInterp(w, s0, iinput({ cancelEdge: true }));
    expect(modal(s).stage).toBe("buy");
    expect(modal(s).index).toBe(0);
    expect(s.sw.self["v/e"]).toBeUndefined(); // still open, not erased/left
    s = stepInterp(w, s, iinput({ cancelEdge: true }));
    expect(s.modal).toBeNull();
    expect(s.sw.variables.afterShop).toBe(1); // the fiber continued past the shop command
  });
});

describe("T2-10 shop — leaving", () => {
  test("the trailing 'leave' row closes the shop and the fiber continues", () => {
    const w = createWorld(imap([shopEvent([{ item: "key", price: 1 }])]));
    let s = createInterpState();
    s = stepInterp(w, s, iinput({ confirmEdge: true })); // open, cursor on "key"
    s = stepInterp(w, s, iinput({ upEdge: true })); // wrap up to "leave" (last row)
    expect(modal(s).rows[modal(s).index]).toEqual({ kind: "leave" });
    s = stepInterp(w, s, iinput({ confirmEdge: true }));
    expect(s.modal).toBeNull();
    expect(s.sw.variables.afterShop).toBe(1);
  });
});

describe("T2-10/B1 shop — per-shop sellPrice override", () => {
  test("a shop's sellPrice overrides floor(item.price/2) for an item it lists", () => {
    const items: Item[] = [{ id: "torch", name: "Torch", sprite: "t.0", price: 50 }]; // base sell would be 25
    const w = createWorld(imap([shopEvent([{ item: "torch", sellPrice: 40 }])]), [], 60, { items });
    let s = createInterpState(createSwitchState({ gold: 0, items: { torch: 1 } }));
    s = stepInterp(w, s, iinput({ confirmEdge: true })); // open, buy stage
    s = stepInterp(w, s, iinput({ downEdge: true })); // cursor -> sell
    s = stepInterp(w, s, iinput({ confirmEdge: true })); // enter sell stage
    expect(modal(s).rows[0]).toMatchObject({ item: "torch", price: 40 });
    s = stepInterp(w, s, iinput({ confirmEdge: true })); // sell
    expect(s.sw.gold).toBe(40);
  });

  test("an item this shop does not list still sells at floor(item.price/2)", () => {
    const items: Item[] = [
      { id: "torch", name: "Torch", sprite: "t.0", price: 50 },
      { id: "key", name: "Key", sprite: "t.0", price: 10 },
    ];
    const w = createWorld(imap([shopEvent([{ item: "torch", sellPrice: 40 }])]), [], 60, { items });
    let s = createInterpState(createSwitchState({ gold: 0, items: { torch: 1, key: 1 } }));
    s = stepInterp(w, s, iinput({ confirmEdge: true }));
    s = stepInterp(w, s, iinput({ downEdge: true }));
    s = stepInterp(w, s, iinput({ confirmEdge: true }));
    const keyRow = modal(s).rows.find((r) => r.kind === "item" && r.item === "key");
    expect(keyRow).toMatchObject({ price: 5 });
  });
});

describe("T2-10/B1 shop — finite stock", () => {
  test("a buy decrements stock; reaching zero disables the row even with gold and room", () => {
    const w = createWorld(imap([shopEvent([{ item: "key", price: 1, stock: 2 }])]));
    let s = createInterpState(createSwitchState({ gold: 100 }));
    s = stepInterp(w, s, iinput({ confirmEdge: true })); // open
    expect(modal(s).rows[0]).toMatchObject({ stock: 2, atCap: false });
    s = stepInterp(w, s, iinput({ confirmEdge: true })); // buy #1
    expect(modal(s).rows[0]).toMatchObject({ stock: 1, atCap: false });
    s = stepInterp(w, s, iinput({ confirmEdge: true })); // buy #2: stock hits 0
    expect(modal(s).rows[0]).toMatchObject({ stock: 0, atCap: true });
    const goldBefore = s.sw.gold;
    s = stepInterp(w, s, iinput({ confirmEdge: true })); // refused: out of stock
    expect(s.sw.gold).toBe(goldBefore);
    expect(s.sw.items.key).toBe(2);
  });

  test("selling an item back at a shop that lists it with stock restocks that shop's counter", () => {
    const w = createWorld(imap([shopEvent([{ item: "key", price: 1, sellPrice: 1, stock: 1 }])]));
    let s = createInterpState(createSwitchState({ gold: 100, items: { key: 1 } }));
    s = stepInterp(w, s, iinput({ confirmEdge: true })); // open, cursor 0 (buy row for key)
    s = stepInterp(w, s, iinput({ confirmEdge: true })); // buy the only unit: stock 1 -> 0
    expect(modal(s).rows[0]).toMatchObject({ stock: 0, atCap: true });
    s = stepInterp(w, s, iinput({ downEdge: true })); // cursor -> sell
    s = stepInterp(w, s, iinput({ confirmEdge: true })); // enter sell stage
    s = stepInterp(w, s, iinput({ confirmEdge: true })); // sell the key back
    s = stepInterp(w, s, iinput({ cancelEdge: true })); // back to buy
    expect(modal(s).rows[0]).toMatchObject({ stock: 1, atCap: false }); // restocked
  });

  test("live stock is keyed by shop id + item id and survives a JSON round-trip", () => {
    const w = createWorld(imap([shopEvent([{ item: "key", price: 1, stock: 3 }], { id: "north" })]));
    let s = createInterpState(createSwitchState({ gold: 100 }));
    s = stepInterp(w, s, iinput({ confirmEdge: true }));
    s = stepInterp(w, s, iinput({ confirmEdge: true })); // stock 3 -> 2
    expect(s.sw.shopStock["north:key"]).toBe(2);
    const restored = JSON.parse(JSON.stringify(s)) as InterpState;
    expect(restored.sw.shopStock).toEqual(s.sw.shopStock);
  });
});

describe("T2-10/B1 shop — condition-gated goods rows", () => {
  test("a row whose condition fails is hidden; satisfying it reveals it on the next render", () => {
    const w = createWorld(imap([shopEvent([
      { item: "key", price: 1 },
      { item: "torch", price: 2, condition: { switch: "unlocked" } },
    ])]));
    let s = createInterpState(createSwitchState({ gold: 10 }));
    s = stepInterp(w, s, iinput({ confirmEdge: true }));
    expect(modal(s).rows.map((r) => (r.kind === "item" ? r.item : r.kind))).toEqual(["key", "sell", "leave"]);
    s.sw.switches.unlocked = true;
    s = stepInterp(w, s, iinput());
    expect(modal(s).rows.map((r) => (r.kind === "item" ? r.item : r.kind))).toEqual(["key", "torch", "sell", "leave"]);
  });
});

describe("T2-10/B4 shop — unsellable rows", () => {
  test("sellList:'disable' (default) lists a zero-price item dimmed; confirming it does nothing", () => {
    const items: Item[] = [
      { id: "note", name: "Note", sprite: "t.0" }, // no price: effective sell price 0
      { id: "key", name: "Key", sprite: "t.0", price: 4 }, // sellable, unaffected by note's row
    ];
    const w = createWorld(imap([shopEvent([{ item: "key", price: 1 }])]), [], 60, { items });
    let s = createInterpState(createSwitchState({ gold: 0, items: { note: 1, key: 1 } }));
    s = stepInterp(w, s, iinput({ confirmEdge: true }));
    s = stepInterp(w, s, iinput({ downEdge: true }));
    s = stepInterp(w, s, iinput({ confirmEdge: true })); // sell stage
    const noteRow = modal(s).rows.find((r) => r.kind === "item" && r.item === "note");
    expect(noteRow).toMatchObject({ price: 0, sellable: false });
    // Sell-stage rows sort by item id ("key" < "note"); walk the cursor to
    // "note" without confirming anything along the way.
    while (modal(s).rows[modal(s).index]?.kind !== "item" || (modal(s).rows[modal(s).index] as { item?: string }).item !== "note") {
      s = stepInterp(w, s, iinput({ downEdge: true }));
    }
    const before = { gold: s.sw.gold, note: s.sw.items.note };
    s = stepInterp(w, s, iinput({ confirmEdge: true })); // confirm on the disabled row: no-op
    expect(s.sw.gold).toBe(before.gold);
    expect(s.sw.items.note).toBe(before.note);
  });

  test("sellList:'hide' omits an unsellable item from the sell tab entirely", () => {
    const items: Item[] = [
      { id: "note", name: "Note", sprite: "t.0" }, // no price: effective sell price 0, unsellable
      { id: "key", name: "Key", sprite: "t.0", price: 4 }, // sells for floor(4/2) = 2
    ];
    const w = createWorld(
      imap([shopEvent([{ item: "key", price: 1 }], { sellList: "hide" })]),
      [], 60, { items },
    );
    let s = createInterpState(createSwitchState({ gold: 0, items: { note: 1, key: 1 } }));
    s = stepInterp(w, s, iinput({ confirmEdge: true }));
    s = stepInterp(w, s, iinput({ downEdge: true }));
    s = stepInterp(w, s, iinput({ confirmEdge: true })); // sell stage
    expect(modal(s).rows.some((r) => r.kind === "item" && r.item === "note")).toBe(false);
    expect(modal(s).rows.map((r) => r.kind)).toEqual(["item", "back"]); // only "key" plus back
  });

  test("Item.sellable:false is unsellable even at a positive effective price", () => {
    const items: Item[] = [{ id: "heirloom", name: "Heirloom", sprite: "t.0", price: 100, sellable: false }];
    const w = createWorld(imap([shopEvent([{ item: "key", price: 1 }])]), [], 60, { items });
    let s = createInterpState(createSwitchState({ gold: 0, items: { heirloom: 1 } }));
    s = stepInterp(w, s, iinput({ confirmEdge: true }));
    s = stepInterp(w, s, iinput({ downEdge: true }));
    s = stepInterp(w, s, iinput({ confirmEdge: true }));
    expect(modal(s).rows[0]).toMatchObject({ item: "heirloom", price: 50, sellable: false });
  });
});

describe("T2-10/B1 shop — configurable backpack cap", () => {
  test("system.inventory.maxPerItem overrides the default 99 cap", () => {
    const w = createWorld(imap([shopEvent([{ item: "key", price: 1 }])]), [], 60, { inventory: { maxPerItem: 2 } });
    let s = createInterpState(createSwitchState({ gold: 100, items: { key: 2 } }));
    s = stepInterp(w, s, iinput({ confirmEdge: true }));
    expect(modal(s).rows[0]).toMatchObject({ owned: 2, atCap: true });
  });

  test("system.inventory.maxKinds refuses a new item kind even under maxPerItem and with gold to spare", () => {
    const w = createWorld(
      imap([shopEvent([{ item: "key", price: 1 }, { item: "torch", price: 1 }])]),
      [], 60, { inventory: { maxKinds: 1 } },
    );
    let s = createInterpState(createSwitchState({ gold: 100, items: { key: 1 } })); // 1 kind held already
    s = stepInterp(w, s, iinput({ confirmEdge: true }));
    const rows = modal(s).rows;
    expect(rows.find((r) => r.kind === "item" && r.item === "key")).toMatchObject({ atCap: false }); // same kind: fine
    expect(rows.find((r) => r.kind === "item" && r.item === "torch")).toMatchObject({ atCap: true }); // a NEW kind: refused
  });
});

describe("T2-10 shop — determinism", () => {
  function project(): Project {
    // The shop's goods price (10) and the item's own catalog price (also
    // 10, so selling nets floor(10/2) = 5) are authored to match: selling
    // does not read the shop's price, only World.items.
    const npc = shopEvent([{ item: "key", price: 10 }]);
    return {
      format: "rpgkit-project/v1", title: "t", tileSize: 16,
      start: { map: "a", x: 10, y: 11, dir: "up" },
      initialGold: 100,
      sheets: [{ id: "town", cols: 12, rows: 11, defaultPassage: "pass" }],
      items: [{ id: "key", name: "Key", sprite: "town.0", price: 10 }],
      maps: [{ id: "a", name: "a", width: 20, height: 13, sheets: ["town"], ground: new Array(260).fill(GRASS), events: [npc] }],
    };
  }
  // A full open/buy/sell/leave interaction as a scripted button sequence:
  // one host frame per input, matching the confirm/up/down/cancel edges
  // stepSession expects.
  const SCRIPT: Array<Partial<{ confirmEdge: boolean; cancelEdge: boolean; upEdge: boolean; downEdge: boolean }>> = [
    { confirmEdge: true }, // open shop (action fires facing the NPC)
    { confirmEdge: true }, // buy one key (gold 100 -> 90, key 0 -> 1)
    { confirmEdge: true }, // buy another (gold 90 -> 80, key 1 -> 2)
    { downEdge: true }, // cursor -> sell
    { confirmEdge: true }, // enter sell stage
    { confirmEdge: true }, // sell one key back (price/2 = 5; gold 80 -> 85, key 2 -> 1)
    { cancelEdge: true }, // back to buy
    { upEdge: true }, // cursor -> leave
    { confirmEdge: true }, // leave
  ];

  test("the same script folds to identical gold/items at 60/30/20/4 hz", () => {
    const finals: Array<{ gold: number; items: Record<string, number> }> = [];
    for (const hz of [60, 30, 20, 4]) {
      const p = project();
      const sess = createSession(p, hz);
      let s = startSession(p, sess);
      for (const edge of SCRIPT) {
        s = stepSession(sess, s, { buttons: 0, ...edge });
        // Hold the shop open across host frames with no edges until the
        // modal reflects the effect, matching how a real host paces input.
      }
      finals.push({ gold: s.sw.gold, items: { ...s.sw.items } });
    }
    for (const f of finals.slice(1)) expect(f).toEqual(finals[0]);
    expect(finals[0]).toEqual({ gold: 85, items: { key: 1 } });
  });

  test("a session serialized mid-shop (JSON round-trip) resumes and folds identically", () => {
    const p = project();
    const sess = createSession(p, 60);
    let s = startSession(p, sess);
    s = stepSession(sess, s, { buttons: 0, confirmEdge: true }); // open
    s = stepSession(sess, s, { buttons: 0, confirmEdge: true }); // buy one
    expect(s.interp.modal?.kind).toBe("shop");
    expect(s.sw.items.key).toBe(1);

    const restored = JSON.parse(JSON.stringify(s)) as SessionState;
    expect(restored.interp.modal).toEqual(s.interp.modal);

    let a = s;
    let b = restored;
    for (const edge of SCRIPT.slice(2)) {
      a = stepSession(sess, a, { buttons: 0, ...edge });
      b = stepSession(sess, b, { buttons: 0, ...edge });
    }
    expect(JSON.parse(JSON.stringify(b))).toEqual(JSON.parse(JSON.stringify(a)));
    expect(a.sw.gold).toBe(85);
    expect(a.sw.items.key).toBe(1);
    expect(a.interp.modal).toBeNull();
  });
});

describe("T2-10 schema: goods and the item price field", () => {
  const project = (goods: ShopGood[], sell?: boolean, itemPrice?: number, shopId = "s"): Project => ({
    format: "rpgkit-project/v1", title: "t", tileSize: 16,
    start: { map: "a", x: 0, y: 0, dir: "down" },
    sheets: [{ id: "t", pak: "chunks", cols: 1, rows: 1 }],
    items: itemPrice === undefined ? [] : [{ id: "torch", name: "Torch", sprite: "t.0", price: itemPrice }],
    maps: [{
      id: "a", name: "a", width: 1, height: 1, sheets: ["t"], ground: ["t.0"],
      events: [{
        id: "e", x: 0, y: 0,
        pages: [{ trigger: "action", commands: [{ op: "shop", id: shopId, goods, ...(sell === undefined ? {} : { sell }) }] }],
      }],
    }],
  });

  test("a shop with goods (with/without a price override) and sell validates", () => {
    expect(validateSchema(schema, project([{ item: "key" }, { item: "torch", price: 10 }]))).toEqual([]);
    expect(validateSchema(schema, project([{ item: "key" }], false))).toEqual([]);
  });

  test("an empty goods list, or a negative price, is rejected", () => {
    expect(validateSchema(schema, project([])).length).toBeGreaterThan(0);
    expect(validateSchema(schema, project([{ item: "key", price: -1 }])).length).toBeGreaterThan(0);
  });

  test("a shop command without an id is rejected", () => {
    const p = project([{ item: "key" }]);
    delete (p.maps[0]!.events![0]!.pages[0]!.commands[0] as { id?: string }).id;
    expect(validateSchema(schema, p).length).toBeGreaterThan(0);
  });

  test("an item's own price field is optional and, when present, a non-negative integer", () => {
    expect(validateSchema(schema, project([{ item: "torch" }], undefined, 10))).toEqual([]);
    expect(validateSchema(schema, project([{ item: "torch" }], undefined, 0))).toEqual([]);
  });
});

describe("T2-10/B1 schema: sellPrice, stock, condition, sellList, item.sellable, system.inventory", () => {
  const project = (goods: ShopGood[], extra: Partial<Command & { op: "shop" }> = {}): Project => ({
    format: "rpgkit-project/v1", title: "t", tileSize: 16,
    start: { map: "a", x: 0, y: 0, dir: "down" },
    sheets: [{ id: "t", pak: "chunks", cols: 1, rows: 1 }],
    items: [],
    maps: [{
      id: "a", name: "a", width: 1, height: 1, sheets: ["t"], ground: ["t.0"],
      events: [{
        id: "e", x: 0, y: 0,
        pages: [{ trigger: "action", commands: [{ op: "shop", id: "s", goods, ...extra } as unknown as Command] }],
      }],
    }],
  });

  test("sellPrice and stock validate as non-negative integers", () => {
    expect(validateSchema(schema, project([{ item: "key", sellPrice: 3, stock: 5 }]))).toEqual([]);
    expect(validateSchema(schema, project([{ item: "key", sellPrice: -1 }])).length).toBeGreaterThan(0);
    expect(validateSchema(schema, project([{ item: "key", stock: -1 }])).length).toBeGreaterThan(0);
  });

  test("condition reuses the page-condition shape", () => {
    expect(validateSchema(schema, project([{ item: "key", condition: { switch: "opened" } }]))).toEqual([]);
    expect(validateSchema(schema, project([
      { item: "key", condition: { all: [{ kind: "variable", id: "v", op: ">=", value: 1 }] } },
    ]))).toEqual([]);
    expect(validateSchema(schema, project([{ item: "key", condition: {} }])).length).toBeGreaterThan(0); // minProperties: 1
  });

  test("sellList accepts 'disable'/'hide' and rejects anything else", () => {
    expect(validateSchema(schema, project([{ item: "key" }], { sellList: "disable" }))).toEqual([]);
    expect(validateSchema(schema, project([{ item: "key" }], { sellList: "hide" }))).toEqual([]);
    expect(validateSchema(schema, project([{ item: "key" }], { sellList: "delete" } as never)).length).toBeGreaterThan(0);
  });

  test("Item.sellable is an optional boolean", () => {
    const p: Project = {
      format: "rpgkit-project/v1", title: "t", tileSize: 16,
      start: { map: "a", x: 0, y: 0, dir: "down" },
      sheets: [{ id: "t", pak: "chunks", cols: 1, rows: 1 }],
      items: [{ id: "note", name: "Note", sprite: "t.0", sellable: false }],
      maps: [{ id: "a", name: "a", width: 1, height: 1, sheets: ["t"], ground: ["t.0"], events: [] }],
    };
    expect(validateSchema(schema, p)).toEqual([]);
  });

  test("Project.system.inventory.maxPerItem/maxKinds validate as positive integers", () => {
    const withInventory = (inventory: unknown): Project => ({
      format: "rpgkit-project/v1", title: "t", tileSize: 16,
      start: { map: "a", x: 0, y: 0, dir: "down" },
      sheets: [{ id: "t", pak: "chunks", cols: 1, rows: 1 }],
      items: [],
      system: { inventory } as Project["system"],
      maps: [{ id: "a", name: "a", width: 1, height: 1, sheets: ["t"], ground: ["t.0"], events: [] }],
    });
    expect(validateSchema(schema, withInventory({ maxPerItem: 20, maxKinds: 8 }))).toEqual([]);
    expect(validateSchema(schema, withInventory({ maxPerItem: 0 })).length).toBeGreaterThan(0);
  });
});
