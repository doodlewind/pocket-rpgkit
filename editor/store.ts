// editor/store.ts — project documents on data.fs. The portable desktop
// host mounts the per-app data root as globalThis.fs
// (vendor/pocketjs/hosts/desktop/src/fs.rs, registered as data.fs for
// linux-app/macos-app); the sim host mounts hosts/sim/fs.ts in tests. Editors live at
// projects/<id>.json under that root. Targets without the module (web
// playground, goldens) return null and the caller keeps the bundled
// document, reporting the degradation in the status bar.

import { file, fsHost, write } from "@pocketjs/framework/fs";

export const PROJECT_DIR = "projects";

export function projectPath(id: string): string {
  return `${PROJECT_DIR}/${id}.json`;
}

export function hasFs(): boolean {
  return fsHost() !== null;
}

/** Read an edited document from fs. Returns null when the module is absent
 *  OR the file does not exist; a parse/IO failure becomes an error string so
 *  the UI can show it instead of silently booting the bundled copy. */
export function readProject(id: string): { text: string } | { error: string } | null {
  if (!hasFs()) return null;
  const f = file(projectPath(id));
  if (!f.exists()) return null;
  try {
    return { text: f.text() };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export function writeProject(id: string, text: string): { ok: true; path: string; bytes: number } | { error: string } {
  if (!hasFs()) return { error: "data.fs not mounted on this host" };
  try {
    const bytes = write(projectPath(id), text);
    return { ok: true as const, path: projectPath(id), bytes };
  } catch (e) {
    return { error: (e as Error).message };
  }
}
