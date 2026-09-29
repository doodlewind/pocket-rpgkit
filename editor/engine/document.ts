// editor/engine/document.ts — project document gate: parse, validate
// against src/data/schema.json, and canonical serialize. Pure TS (no
// host imports), so the same gate runs in bun unit tests and the guest.

import { validateSchema, type VError } from "../../src/engine/schema-validate.ts";
import type { Project } from "../../src/engine/types.ts";
import { PROJECT_SCHEMA } from "./projects.ts";

export interface LoadedProject {
  project: Project;
  errors: VError[];
}

/** Parse + validate a rpgkit-project/v1 document. A JSON syntax failure is
 *  one error at "$"; schema failures keep the parsed value so the caller
 *  can show the errors and refuse the export. */
export function loadProject(text: string): LoadedProject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { project: null as unknown as Project, errors: [{ path: "$", msg: `invalid JSON: ${(e as Error).message}` }] };
  }
  return { project: parsed as Project, errors: validateSchema(PROJECT_SCHEMA, parsed) };
}

/** Validate an in-memory project before export. */
export function validateProject(project: Project): VError[] {
  return validateSchema(PROJECT_SCHEMA, project);
}

/** Canonical wire form: 2-space indent + trailing LF, the exact spelling
 *  the example cookers emit data/*.json with. An untouched document
 *  re-serializes byte-for-byte (the round-trip test pins this). */
export function serializeProject(project: Project): string {
  return JSON.stringify(project, null, 2) + "\n";
}

/** Field-level semantic equality (JSON values): true when the two
 *  documents differ in nothing but formatting. */
export function semanticEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => semanticEqual(v, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as Record<string, unknown>).sort();
    const kb = Object.keys(b as Record<string, unknown>).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) =>
      semanticEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}
