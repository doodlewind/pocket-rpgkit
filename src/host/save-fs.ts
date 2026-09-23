// src/host/save-fs.ts — P1⑤ desktop save store over @pocketjs/framework/fs.
//
// The desktop host (hosts/desktop/src/fs.rs) binds the app's own data root
// as globalThis.fs and registers data.fs for linux-app/macos-app. Saves
// land at save/slot-N.json under that root. On every target without the
// module mounted (web-app, the sim host unless a test mounts one) fsHost()
// is null: the UI then runs the save-code fallback (engine/save.ts)
// instead of calling here. The adapter is the SaveStore port from
// engine/save.ts plus a slot lister for the menu.

import { file, fsHost, write } from "@pocketjs/framework/fs";
import {
  loadFromStore,
  saveToStore,
  slotPath,
  summarizeEnvelope,
  type SaveSnapshot,
  type SaveStore,
  type SlotSummary,
} from "../engine/save.ts";

export interface FsSlotInfo extends SlotSummary {
  checksum: string;
}

/** True when a host mounted the fs module (desktop linux-app/macos-app). */
export function hasFsSave(): boolean {
  return fsHost() !== null;
}

class FsSaveStore implements SaveStore {
  exists(slot: number): boolean {
    return file(slotPath(slot)).exists();
  }
  read(slot: number): string | null {
    const f = file(slotPath(slot));
    if (!f.exists()) return null;
    return f.text();
  }
  write(slot: number, envelope: string): void {
    // Bun.write semantics: truncates and creates the save/ parent.
    write(slotPath(slot), envelope);
  }
}

let store: FsSaveStore | null = null;

/** The fs-backed store, or null where the host mounted no fs module. */
export function fsSaveStore(): SaveStore | null {
  if (!hasFsSave()) return null;
  store ??= new FsSaveStore();
  return store;
}

export function saveSlotFs(slot: number, snapshot: SaveSnapshot): void {
  const s = fsSaveStore();
  if (!s) throw new Error("save: fs module is not mounted on this target");
  saveToStore(s, slot, snapshot);
}

export function loadSlotFs(slot: number): SaveSnapshot {
  const s = fsSaveStore();
  if (!s) throw new Error("save: fs module is not mounted on this target");
  return loadFromStore(s, slot);
}

/** Summaries of the three fixed slots; null entries are empty slots.
 *  A file that fails checksum/version is listed as a slot with an error
 *  code so the menu can show it as corrupt rather than silently empty. */
export function listSlotsFs(): (FsSlotInfo | { slot: number; error: string } | null)[] {
  const s = fsSaveStore();
  if (!s) return [null, null, null];
  return [1, 2, 3].map((slot) => {
    const text = s.read(slot);
    if (text === null) return null;
    try {
      return { ...summarizeEnvelope(slot, text) };
    } catch (e) {
      return { slot, error: (e as Error).message };
    }
  });
}
