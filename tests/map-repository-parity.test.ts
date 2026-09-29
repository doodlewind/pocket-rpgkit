// A ProjectShell session must produce byte-identical reducer state to the
// equivalent inline project. Repository residency is derived data and must
// never leak into SessionState, saves, or rate-independent simulation.
import { describe, expect, test } from "bun:test";
import { createJsonMapRepository } from "../src/engine/map-repository.ts";
import { createSession, startSession, stepSession, type SessionState } from "../src/engine/session.ts";
import {
  canonicalJson,
  createSnapshot,
  decodeEnvelopeText,
  encodeEnvelope,
  fnv1aText,
} from "../src/engine/save.ts";
import { restoreSessionEnvelope, restoreSessionSnapshot } from "../src/engine/save-restore.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";
import type { MapDef, Project } from "../src/engine/types.ts";

const MAP_COUNT = 24;

function map(id: string, next: string, index: number): MapDef {
  return {
    id,
    name: id,
    width: 5,
    height: 5,
    sheets: ["tiles"],
    ground: new Array(25).fill("tiles.0"),
    events: [
      {
        id: "door",
        x: 1,
        y: 0,
        pages: [{
          trigger: "action",
          commands: [
            { op: "variable", id: "visits", set: { op: "add", value: 1 } },
            { op: "transfer", map: next, x: 1, y: 1, dir: "up", fade: 0.1 },
          ],
        }],
      },
      {
        id: "npc",
        x: 3,
        y: 3,
        pages: [{
          trigger: "action",
          moveType: "random",
          commands: [{ op: "switch", id: `seen_${index}`, value: true }],
        }],
      },
    ],
  };
}

function fixture(): Project {
  const ids = Array.from({ length: MAP_COUNT }, (_, index) =>
    `map_${String(index).padStart(2, "0")}`);
  return {
    format: "rpgkit-project/v1",
    title: "map repository parity",
    tileSize: 16,
    start: { map: ids[0]!, x: 1, y: 1, dir: "up" },
    sheets: [{ id: "tiles", pak: "tiles", cols: 1, rows: 1, defaultPassage: "pass" }],
    items: [],
    maps: ids.map((id, index) => map(id, ids[(index + 1) % ids.length]!, index)),
  };
}

function sharded(project: Project, hz: number) {
  const split = splitProjectMaps(project);
  const files = new Map(split.entries.map((entry) => [entry.path, entry.bytes]));
  const repository = createJsonMapRepository(split.shell.mapIndex, {
    read: (entry) => files.get(entry),
  });
  const session = createSession(split.shell, hz, repository);
  return { session, state: startSession(split.shell, session), shell: split.shell };
}

function inline(project: Project, hz: number) {
  const session = createSession(project, hz);
  return { session, state: startSession(project, session) };
}

function inputAt(frame: number, hz: number, walk = false) {
  const referenceTick = Math.floor(frame * 60 / hz);
  const tick = referenceTick % 60;
  if (tick === 0) return { buttons: 0, confirmEdge: true };
  if (walk && tick >= 8 && tick < 14) return { buttons: 0x0040 };
  if (walk && tick >= 24 && tick < 30) return { buttons: 0x0010 };
  return { buttons: 0 };
}

function semanticHash(state: SessionState): string {
  const { frame: _hostFrame, ...semantic } = state;
  return fnv1aText(canonicalJson(semantic));
}

describe("inline and sharded map parity", () => {
  test("every frame stays byte-identical through eviction and revisit", () => {
    const project = fixture();
    const a = inline(project, 60);
    const b = sharded(project, 60);
    let inlineState = a.state;
    let shardedState = b.state;
    const visited = new Set<string>([shardedState.mapId]);
    let transfers = 0;

    expect(canonicalJson(shardedState)).toBe(canonicalJson(inlineState));
    for (let frame = 0; frame < 60 * 40; frame++) {
      const input = inputAt(frame, 60, true);
      const before = shardedState.mapId;
      inlineState = stepSession(a.session, inlineState, input);
      shardedState = stepSession(b.session, shardedState, input);
      expect(canonicalJson(shardedState), `frame ${frame}`).toBe(canonicalJson(inlineState));
      visited.add(shardedState.mapId);
      if (shardedState.mapId !== before) transfers++;
      expect([...b.session.maps.keys()]).toEqual([shardedState.mapId]);
    }
    expect(visited.size).toBe(MAP_COUNT);
    expect(transfers).toBeGreaterThanOrEqual(30);
  });

  test("a save on an evicted map restores identically to inline", () => {
    const project = fixture();
    const a = inline(project, 60);
    const b = sharded(project, 60);
    let inlineState = a.state;
    let shardedState = b.state;
    for (let frame = 0; frame < 60 * 7; frame++) {
      const input = inputAt(frame, 60);
      inlineState = stepSession(a.session, inlineState, input);
      shardedState = stepSession(b.session, shardedState, input);
    }

    const savedMap = shardedState.mapId;
    const inlineSnapshot = createSnapshot(inlineState.mapId, inlineState.move, inlineState.interp, 0);
    const shardedSnapshot = createSnapshot(shardedState.mapId, shardedState.move, shardedState.interp, 0);
    const inlineEnvelope = encodeEnvelope(inlineSnapshot);
    const shardedEnvelope = encodeEnvelope(shardedSnapshot, b.session.content);
    expect(canonicalJson(shardedSnapshot)).toBe(canonicalJson(inlineSnapshot));
    expect(JSON.parse(shardedEnvelope).checksum).toBe(JSON.parse(inlineEnvelope).checksum);

    for (let frame = 60 * 7; frame < 60 * 12; frame++) {
      const input = inputAt(frame, 60);
      inlineState = stepSession(a.session, inlineState, input);
      shardedState = stepSession(b.session, shardedState, input);
    }
    expect(b.session.maps.has(savedMap)).toBe(false);

    const restoredInline = restoreSessionSnapshot(a.session, decodeEnvelopeText(inlineEnvelope));
    const restoredSharded = restoreSessionEnvelope(b.session, shardedEnvelope);
    expect(canonicalJson(restoredSharded)).toBe(canonicalJson(restoredInline));
    expect([...b.session.maps.keys()]).toEqual([savedMap]);

    let continuedInline = restoredInline;
    let continuedSharded = restoredSharded;
    for (let frame = 0; frame < 600; frame++) {
      const input = inputAt(frame, 60);
      continuedInline = stepSession(a.session, continuedInline, input);
      continuedSharded = stepSession(b.session, continuedSharded, input);
      expect(canonicalJson(continuedSharded), `post-restore frame ${frame}`)
        .toBe(canonicalJson(continuedInline));
    }
    expect(() => restoreSessionEnvelope(b.session, inlineEnvelope)).toThrow(/content identity/);
  });

  test("60/30/20/4 Hz each match inline and share one semantic hash", () => {
    const project = fixture();
    const hashes: string[] = [];
    for (const hz of [60, 30, 20, 4]) {
      const a = inline(project, hz);
      const b = sharded(project, hz);
      let inlineState = a.state;
      let shardedState = b.state;
      for (let frame = 0; frame < hz * 30; frame++) {
        const input = inputAt(frame, hz);
        inlineState = stepSession(a.session, inlineState, input);
        shardedState = stepSession(b.session, shardedState, input);
      }
      expect(canonicalJson(shardedState)).toBe(canonicalJson(inlineState));
      hashes.push(semanticHash(shardedState));
    }
    expect(new Set(hashes).size).toBe(1);
  });
});
