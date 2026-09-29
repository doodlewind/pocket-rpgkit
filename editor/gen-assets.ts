// editor/gen-assets.ts — build-time cooker for the tile-map editor.
//
//   bun editor/gen-assets.ts   (also run last by `bun run gen-assets`)
//
// Inputs (editor/sources.ts): the example documents and the examples' own
// source tile sheets under examples/*/assets/src (licenses in each
// example's ATTRIBUTION.md). Run it after the example cookers, which emit
// the documents.
//
// The pak pipeline binds whole baked IMG textures to Image nodes, and
// pak-baked images are what every host samples (the wasm sim and the wgpu
// desktop host alike; runtime texture uploads are not drawn by the Metal
// renderer), so the editor ships one 16x16 PNG per sheet cell. Outputs
// (committed; every byte is regenerated from the inputs):
//
//   assets/tile-<sheet>-<cell>.png   one PSM_8888 PNG per cell
//   images.json                      the PSM marks for those PNGs
//   engine/tile-keys.ts              tile id -> pak src literal
//   engine/sheets.ts                 sheet grid metadata + source files
//   engine/projects.ts               the bundled documents as TEXT (the
//                                    guest never reads repository files)
//                                    and a copy of src/data/schema.json
//                                    for the export gate
//
// Deterministic: outputs depend only on the committed inputs.

import { readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { loadTileCells } from "../tools/lib/bake.ts";
import { validateSchema } from "../src/engine/schema-validate.ts";
import type { Project } from "../src/engine/types.ts";
import { EDITOR_SOURCES } from "./sources.ts";

const HERE = new URL(".", import.meta.url).pathname; // editor/
const ROOT = resolve(HERE, "..");
const ASSETS = join(HERE, "assets");
const ENGINE = join(HERE, "engine");
mkdirSync(ASSETS, { recursive: true });

const TILE = 16;
const schemaText = readFileSync(join(ROOT, "src", "data", "schema.json"), "utf8").replace(/\r\n/g, "\n");
const schema = JSON.parse(schemaText) as Record<string, unknown>;

// --- documents --------------------------------------------------------------

interface SheetPlan {
  id: string;
  cols: number;
  rows: number;
  source: string;
  bytes: Buffer;
}

const sheets = new Map<string, SheetPlan>();
const docs: Array<{ id: string; title: string; file: string; json: string }> = [];

for (const src of EDITOR_SOURCES) {
  // Normalize to LF so a CRLF checkout cannot change guest bytes.
  const text = readFileSync(join(ROOT, src.document), "utf8").replace(/\r\n/g, "\n");
  const project = JSON.parse(text) as Project;
  const errors = validateSchema(schema, project);
  if (errors.length > 0) {
    throw new Error(`editor gen-assets: ${src.document} fails the v1 schema: ${errors[0]!.path} ${errors[0]!.msg}`);
  }
  for (const sheet of project.sheets) {
    const file = src.sheets[sheet.id];
    if (!file) throw new Error(`editor gen-assets: ${src.id} sheet "${sheet.id}" has no source PNG in editor/sources.ts`);
    const bytes = readFileSync(join(ROOT, file));
    const seen = sheets.get(sheet.id);
    if (seen) {
      // Tile art is keyed by sheet id, so two examples may share an id only
      // when they ship the same sheet.
      if (!seen.bytes.equals(bytes) || seen.cols !== sheet.cols || seen.rows !== sheet.rows) {
        throw new Error(`editor gen-assets: sheet "${sheet.id}" differs between ${seen.source} and ${file}`);
      }
      continue;
    }
    sheets.set(sheet.id, { id: sheet.id, cols: sheet.cols, rows: sheet.rows, source: file, bytes });
  }
  docs.push({ id: src.id, title: project.title, file: src.document, json: text });
}

// --- per-cell tile art ------------------------------------------------------

const imageMeta: Record<string, { psm: number }> = {};
const tileKeyRows: string[] = [];
const written = new Set<string>();

for (const sheet of sheets.values()) {
  const cells = await loadTileCells(join(ROOT, sheet.source), sheet.cols, sheet.rows, TILE);
  for (let cell = 0; cell < sheet.cols * sheet.rows; cell++) {
    const name = `tile-${sheet.id}-${cell}.png`;
    writeFileSync(join(ASSETS, name), encodePNG(cells.cell(cell), TILE, TILE));
    written.add(name);
    imageMeta[`assets/${name}`] = { psm: 3 }; // PSM_8888: exact Kenney colors
    tileKeyRows.push(`  ${JSON.stringify(`${sheet.id}.${cell}`)}: ${JSON.stringify(`assets/${name}`)},`);
  }
}
// A sheet dropped from the sources must not leave stale cells in the pak.
for (const name of readdirSync(ASSETS)) {
  if (/^tile-.+\.png$/.test(name) && !written.has(name)) rmSync(join(ASSETS, name));
}

writeFileSync(join(HERE, "images.json"), JSON.stringify(imageMeta, null, 2) + "\n");

// Static src literals so the build bakes every cell as a pak IMG entry: the
// bundler only collects complete string literals from the module graph, so
// a runtime "assets/tile-" + id expression would never bake.
writeFileSync(
  join(ENGINE, "tile-keys.ts"),
  `// AUTO-GENERATED by editor/gen-assets.ts — static tile id -> pak IMG src\n` +
    `// keys (one baked 16x16 PNG per sheet cell). Do not edit.\n\n` +
    `export const TILE_SRC: Record<string, string> = {\n${tileKeyRows.join("\n")}\n};\n`,
);

const sheetMeta = [...sheets.values()].map(({ id, cols, rows, source }) => ({ id, cols, rows, tile: TILE, source }));
writeFileSync(
  join(ENGINE, "sheets.ts"),
  `// AUTO-GENERATED by editor/gen-assets.ts — tile sheet grids and the\n` +
    `// example source file each sheet's cells were cut from. Do not edit.\n\n` +
    `export interface SheetMeta {\n  id: string;\n  cols: number;\n  rows: number;\n  tile: number;\n` +
    `  /** Repository path of the source sheet PNG. */\n  source: string;\n}\n\n` +
    `export const SHEETS: SheetMeta[] = ${JSON.stringify(sheetMeta, null, 2)};\n`,
);

writeFileSync(
  join(ENGINE, "projects.ts"),
  `// AUTO-GENERATED by editor/gen-assets.ts — the bundled project documents\n` +
    `// (the exact bytes of the example data files named in editor/sources.ts)\n` +
    `// and the v1 JSON Schema (src/data/schema.json) the export gate\n` +
    `// validates with. Do not edit by hand.\n\n` +
    `export interface BundledProject {\n  id: string;\n  title: string;\n` +
    `  /** Repository path of the document this text was read from. */\n  file: string;\n` +
    `  /** Canonical document text (JSON, 2-space indent, trailing LF). */\n  json: string;\n}\n\n` +
    `export const BUNDLED_PROJECTS: BundledProject[] = ${JSON.stringify(docs, null, 2)};\n\n` +
    `export const PROJECT_SCHEMA: Record<string, unknown> = ${schemaText.trimEnd()};\n`,
);

console.log(
  `editor gen-assets: ${written.size} tile image(s) from ${sheets.size} sheet(s), ` +
    `${docs.length} bundled document(s) ${docs.map((d) => `${d.id}=${d.json.length}B`).join(", ")}`,
);
