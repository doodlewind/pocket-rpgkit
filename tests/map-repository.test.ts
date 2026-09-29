import { describe, expect, test } from "bun:test";
import { AttractController } from "../src/engine/attract.ts";
import {
  MapNotReadyError,
  MAP_SCHEMA_HASH,
  createJsonMapRepository,
  mapChecksum,
  sha256Text,
} from "../src/engine/map-repository.ts";
import {
  createSession,
  prepareSessionMap,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import {
  canonicalJson,
  createSnapshot,
  encodeEnvelope,
  fnv1aText,
} from "../src/engine/save.ts";
import { restoreSessionEnvelope } from "../src/engine/save-restore.ts";
import { validateSchema } from "../src/engine/schema-validate.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";
import type { MapDef, Project } from "../src/engine/types.ts";
import schema from "../src/data/schema.json";

const MAP_COUNT = 24;

function map(id: string, next: string): MapDef {
  return {
    id,
    name: id,
    width: 4,
    height: 4,
    sheets: ["tiles"],
    ground: new Array(16).fill("tiles.0"),
    events: [{
      id: "door",
      x: 1,
      y: 0,
      pages: [{
        trigger: "action",
        commands: [{ op: "transfer", map: next, x: 1, y: 1, dir: "up" }],
      }],
    }],
  };
}

function fixture(): Project {
  const ids = Array.from({ length: MAP_COUNT }, (_, i) => `map_${String(i).padStart(2, "0")}`);
  return {
    format: "rpgkit-project/v1",
    title: "repository fixture",
    tileSize: 16,
    start: { map: ids[0]!, x: 1, y: 1, dir: "up" },
    sheets: [{ id: "tiles", pak: "tiles", cols: 1, rows: 1, defaultPassage: "pass" }],
    items: [],
    maps: ids.map((id, i) => map(id, ids[(i + 1) % ids.length]!)),
  };
}

interface Tracking {
  session: Session;
  reads: string[];
  releases: string[][];
  split: ReturnType<typeof splitProjectMaps>;
}

function trackingSession(project = fixture(), hz = 60): Tracking {
  const split = splitProjectMaps(project);
  const files = new Map(split.entries.map((entry) => [entry.path, entry.text]));
  const reads: string[] = [];
  const releases: string[][] = [];
  const base = createJsonMapRepository(split.shell.mapIndex, {
    read(entry) {
      reads.push(entry);
      return files.get(entry);
    },
  });
  const repository = {
    meta: base.meta,
    acquire: base.acquire,
    releaseExcept(ids: readonly string[]) {
      releases.push([...ids]);
      base.releaseExcept(ids);
    },
  };
  return { session: createSession(split.shell, hz, repository), reads, releases, split };
}

function pulse(session: Session, state: SessionState): SessionState {
  let next = stepSession(session, state, { buttons: 0, confirmEdge: true });
  next = stepSession(session, next, { buttons: 0 });
  return next;
}

function semanticState(state: SessionState): unknown {
  const { frame: _hostFrame, ...rest } = state;
  return rest;
}

describe("sharded map repository", () => {
  test("SHA-256 matches standard vectors", () => {
    expect(sha256Text("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Text("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(MAP_SCHEMA_HASH).toBe(sha256Text(canonicalJson(schema)));
  });

  test("the splitter emits sorted, byte-stable shell and map entries", () => {
    const project = fixture();
    project.maps.reverse();
    const a = splitProjectMaps(project);
    const b = splitProjectMaps(project);
    expect(a.shellText).toBe(b.shellText);
    expect(a.files.map((file) => [file.path, [...file.bytes]]))
      .toEqual(b.files.map((file) => [file.path, [...file.bytes]]));
    expect(a.shell.mapIndex.map((entry) => entry.id)).toEqual(
      [...a.shell.mapIndex.map((entry) => entry.id)].sort(),
    );
    expect(validateSchema(schema, a.shell)).toEqual([]);
    for (const entry of a.entries) {
      expect(entry.meta.sha256).toBe(sha256Text(entry.text));
      expect(entry.meta.sha256).toBe(mapChecksum(JSON.parse(entry.text)));
    }
  });

  test("startup acquires only the start map; transfers evict and revisits reacquire", () => {
    const { session, reads, releases, split } = trackingSession();
    let state = startSession(split.shell, session);
    expect(reads).toEqual(["maps/map_00.json"]);
    expect([...session.maps.keys()]).toEqual(["map_00"]);
    for (let i = 1; i <= MAP_COUNT; i++) {
      state = pulse(session, state);
      expect(state.mapId).toBe(`map_${String(i % MAP_COUNT).padStart(2, "0")}`);
      expect([...session.maps.keys()]).toEqual([state.mapId]);
      expect([...session.worlds.keys()]).toEqual([state.mapId]);
      expect([...session.tables.keys()]).toEqual([state.mapId]);
    }
    expect(reads).toHaveLength(MAP_COUNT + 1);
    expect(reads.at(-1)).toBe("maps/map_00.json");
    expect(releases.at(-1)).toEqual(["map_00"]);
  });

  test("a save restores onto an already released map and rejects another build", () => {
    const first = trackingSession();
    let state = startSession(first.split.shell, first.session);
    for (let i = 0; i < 7; i++) state = pulse(first.session, state);
    const savedMap = state.mapId;
    const envelope = encodeEnvelope(
      createSnapshot(state.mapId, state.move, state.interp, 0),
      first.session.content,
    );
    state = pulse(first.session, state);
    expect(first.session.maps.has(savedMap)).toBe(false);
    const restored = restoreSessionEnvelope(first.session, envelope);
    expect(restored.mapId).toBe(savedMap);
    expect([...first.session.maps.keys()]).toEqual([savedMap]);

    const changed = fixture();
    changed.maps[12]!.name = "changed content";
    const second = trackingSession(changed);
    const readsBefore = second.reads.length;
    expect(() => restoreSessionEnvelope(second.session, envelope)).toThrow(/manifest hash/);
    expect(second.reads).toHaveLength(readsBefore);
  });

  test("two runs and four host rates produce identical semantic hashes", () => {
    const drive = (hz: number): string => {
      const { session, split } = trackingSession(fixture(), hz);
      let state = startSession(split.shell, session);
      // One action edge every quarter second; each rate folds the same 60 Hz
      // reference duration and visits the same four maps.
      for (let second = 0; second < 4; second++) {
        state = stepSession(session, state, { buttons: 0, confirmEdge: true });
        for (let frame = 1; frame < hz; frame++) {
          state = stepSession(session, state, { buttons: 0 });
        }
      }
      return fnv1aText(canonicalJson(semanticState(state)));
    };
    const hashes = [60, 30, 20, 4].map(drive);
    expect(hashes).toEqual(new Array(4).fill(hashes[0]));
    expect(drive(60)).toBe(hashes[0]);
  });

  test("an async source pauses before transfer and retries the same input frame", async () => {
    const split = splitProjectMaps(fixture());
    const files = new Map(split.entries.map((entry) => [entry.path, entry.text]));
    const ready = new Set(["maps/map_00.json"]);
    const repository = createJsonMapRepository(split.shell.mapIndex, {
      read: (entry) => ready.has(entry) ? files.get(entry) : undefined,
      prepare: async (entry) => { ready.add(entry); },
    });
    const session = createSession(split.shell, 60, repository);
    const state = startSession(split.shell, session);
    const before = canonicalJson(state);
    const input = { buttons: 0, confirmEdge: true } as const;
    expect(() => stepSession(session, state, input)).toThrow(MapNotReadyError);
    expect(canonicalJson(state)).toBe(before);
    expect([...session.maps.keys()]).toEqual(["map_00"]);
    await prepareSessionMap(session, "map_01");
    const transferred = stepSession(session, state, input);
    expect(transferred.mapId).toBe("map_01");
    expect([...session.maps.keys()]).toEqual(["map_01"]);
  });

  test("an attract fold rolls back before an async map and retries exactly", async () => {
    const split = splitProjectMaps(fixture());
    const files = new Map(split.entries.map((entry) => [entry.path, entry.text]));
    const ready = new Set(["maps/map_00.json"]);
    const repository = createJsonMapRepository(split.shell.mapIndex, {
      read: (entry) => ready.has(entry) ? files.get(entry) : undefined,
      prepare: async (entry) => { ready.add(entry); },
    });
    const tape = new Array(15).fill(0);
    tape[0] = 0x2000;
    const controller = new AttractController(split.shell, tape, {
      hz: 4,
      maps: repository,
    });
    controller.startAttract();
    const before = canonicalJson({
      state: controller.state,
      status: controller.status(),
      length: controller.length,
      folded: controller.foldedMask(),
    });
    expect(() => controller.step(0)).toThrow(MapNotReadyError);
    expect(canonicalJson({
      state: controller.state,
      status: controller.status(),
      length: controller.length,
      folded: controller.foldedMask(),
    })).toBe(before);
    await prepareSessionMap(controller.getSession(), "map_01");
    const retried = controller.step(0);
    expect(retried.state.mapId).toBe("map_01");
    expect(controller.length).toBe(15);
    expect([...controller.getSession().maps.keys()]).toEqual(["map_01"]);
  });

  test("schema, metadata and checksum corruption are rejected before entry", () => {
    const split = splitProjectMaps(fixture());
    const start = split.entries[0]!;
    const badMap = JSON.parse(start.text) as MapDef;
    badMap.ground.pop();
    const badText = canonicalJson(badMap);
    const badIndex = split.shell.mapIndex.map((entry, index) => index === 0
      ? { ...entry, sha256: sha256Text(badText) }
      : entry);
    const repository = createJsonMapRepository(badIndex, {
      read: (entry) => entry === start.path ? badText : split.entries.find((item) => item.path === entry)?.text,
    });
    const shell = { ...split.shell, mapIndex: badIndex, mapManifestHash: undefined };
    expect(() => createSession(shell, 60, repository)).toThrow(/ground has 15 cells/);

    const checksumRepository = createJsonMapRepository(split.shell.mapIndex, {
      read: (entry) => entry === start.path ? `${start.text} ` : split.entries.find((item) => item.path === entry)?.text,
    });
    expect(() => createSession(split.shell, 60, checksumRepository)).toThrow(/checksum mismatch/);
  });
});

describe("sharded maps keep project system options", () => {
  test("worlds compiled on demand carry system.messageBlocksPlayer", () => {
    const project = { ...fixture(), system: { messageBlocksPlayer: true } };
    const inline = createSession(project, 60);
    expect([...inline.worlds.values()].every((w) => w.messageBlocksPlayer === true)).toBe(true);
    const { session, split } = trackingSession(project);
    let state = startSession(split.shell, session);
    expect(session.worlds.get("map_00")!.messageBlocksPlayer).toBe(true);
    state = pulse(session, state);
    for (let i = 0; i < 40 && state.mapId === "map_00"; i++) {
      state = stepSession(session, state, { buttons: 0 });
    }
    expect(state.mapId).toBe("map_01");
    expect(session.worlds.get("map_01")!.messageBlocksPlayer).toBe(true);
  });
});
