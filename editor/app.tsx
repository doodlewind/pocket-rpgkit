// editor/app.tsx — the tile-map editor shell.
//
//   root View (dark, overflow-hidden)
//     header row      LAYER DOC < >      UNDO REDO SAVE
//     [no-svc banner] gamepad-mode legend, only without a companion
//     PalettePanel    eraser + every sheet cell of the current map
//     Canvas          ground, event markers, upper star cells, cursor
//     status bar      doc / map / layer / selection / mode / save result
//
// Input has TWO live modes, neither silent:
//   - rpgkit-editor companion (desktop host, --companions rpgkit-editor):
//     real mouse + keyboard arrive as svc JSON lines (svc.ts). Left click
//     paints, right click / shift erases, drag strokes, wheel scrolls the
//     palette, cmd+z / cmd+shift+z / cmd+s drive undo/redo/save.
//   - no companion (goldens, hosts/sim without injected ops, browsers): a
//     visible amber banner names the controls and the same editor runs from
//     buttons: d-pad moves the cursor across canvas/palette/header, CIRCLE
//     paints, CROSS erases, SQUARE/TRIANGLE undo/redo, L/R switch maps,
//     SELECT toggles the layer, START saves. A missing companion must
//     never leave a window whose buttons are silently dead.
//
// Documents: the editor boots on the first bundled example document
// (engine/projects.ts; a copy saved on data.fs wins). With the companion,
// the host's --file arrives as a {t:"load"} line and replaces it; from
// then on SAVE writes that file and DOC stays on it, so the open document
// can never be saved over a different project's file.

import { batch, createMemo, createSignal, For } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { getOps, hostViewport } from "@pocketjs/framework/host";
import { BTN } from "@pocketjs/framework/input";
import type { Project, TileId } from "../src/engine/types.ts";
import {
  canRedo,
  canUndo,
  createEditorState,
  currentMap,
  eventMarkers,
  exportProject,
  paintCell,
  paletteTiles,
  redo,
  selectLayer,
  selectMap,
  selectTile,
  slotForTile,
  strokeEnd,
  strokeStart,
  undo,
  markSaved,
  type EditorState,
} from "./engine/model.ts";
import { loadProject, serializeProject, validateProject } from "./engine/document.ts";
import { BUNDLED_PROJECTS } from "./engine/projects.ts";
import { createTileTextures } from "./engine/textures.ts";
import {
  HEADER_H,
  STATUS_H,
  PAL_COLS,
  PAL_GRID_TOP,
  PAL_PITCH,
  PAL_W,
  clampCam,
  fittedView,
  headerButtons,
  hitTest,
} from "./engine/layout.ts";
import { HEADER_ORDER, initialCursor, stepCursor, type Cursor } from "./engine/cursor.ts";
import { connectSvc, type HostLine, type Svc } from "./svc.ts";
import { hasFs, readProject, writeProject } from "./store.ts";
import { Banner, HeaderButton, PalettePanel, type PaletteThumb } from "./ui/panels.tsx";
import { Canvas } from "./ui/canvas.tsx";
import { DIM, GOOD, BAD } from "./ui/panels.tsx";

type Notice = { kind: "info" | "good" | "bad"; text: string };

// Fallback logical viewport when the host reports none (the fixed 480x272
// profile the goldens and the sim tests boot at).
const SCREEN_W = 480;
const SCREEN_H = 272;

interface DocSlot {
  id: string;
  project: Project;
}

function bootDoc(index: number): DocSlot {
  const bundled = BUNDLED_PROJECTS[index]!;
  // A previously exported copy on data.fs wins over the bundled document.
  const onFs = readProject(bundled.id);
  if (onFs && "text" in onFs) {
    const loaded = loadProject(onFs.text);
    if (loaded.errors.length === 0) return { id: bundled.id, project: loaded.project };
  }
  return { id: bundled.id, project: loadProject(bundled.json).project };
}

export function EditorApp(): JSX.Element {
  const svc: Svc | null = connectSvc();
  const fsOk = hasFs();

  const vp0 = hostViewport(getOps());
  const [vp, setVp] = createSignal(vp0 ? { w: vp0.w, h: vp0.h } : { w: SCREEN_W, h: SCREEN_H });
  const [docIndex, setDocIndex] = createSignal(0);
  const [doc, setDoc] = createSignal<DocSlot>(bootDoc(0));
  const [editor, setEditor] = createSignal<EditorState>(createEditorState(doc().project));
  const [cam, setCam] = createSignal({ x: 0, y: 0 });
  const [notice, setNotice] = createSignal<Notice>({
    kind: "info",
    text: svc
      ? fsOk
        ? "POINTER MODE (companion): LEFT PAINT, RIGHT/SHIFT ERASE"
        : "POINTER MODE (companion; no data.fs: SAVE GOES TO THE HOST FILE)"
      : "NO COMPANION - GAMEPAD MODE (SEE BANNER)",
  });
  const [palScroll, setPalScroll] = createSignal(0);
  const [hover, setHover] = createSignal<{ x: number; y: number } | null>(null);
  const [cursor, setCursor] = createSignal<Cursor>(initialCursor(0, 0));
  const [savedText, setSavedText] = createSignal<string | null>(null);
  const [loadNotice, setLoadNotice] = createSignal<string | null>(null);
  /** True once the host's --file document is open: SAVE writes that file,
   *  so DOC must not swap another project in under it. */
  const [hostFile, setHostFile] = createSignal(false);

  const tileTextures = createTileTextures();

  const map = createMemo(() => currentMap(editor()));
  const markers = createMemo(() => eventMarkers(map()));
  // Content-compared: a paint stroke replaces the project object, but the
  // palette (and the 133 thumbnail nodes under it) only changes with the
  // map's sheets.
  const palette = createMemo(() => paletteTiles(editor()), undefined, { equals: sameTiles });
  const selectedSlot = createMemo(() => slotForTile(palette(), editor().tile));
  const banner = createMemo(() => svc === null);
  const fit = createMemo(() => fittedView(vp().w, vp().h, banner()));
  const viewCols = () => fit().cols;
  const viewRows = () => fit().rows;

  const texKey = (tile: TileId): string => (tile === null ? "" : tileTextures.key(tile) ?? "");

  const thumbs = createMemo<PaletteThumb[]>(() =>
    palette().map((tile, slot) => ({
      slot,
      tileKey: tile,
      src: texKey(tile),
      label: tile ?? "erase",
    })),
  );

  const clampCameraTo = (state: EditorState, next: { x: number; y: number }) => {
    const m = currentMap(state);
    return {
      x: clampCam(next.x, m.width, viewCols()),
      y: clampCam(next.y, m.height, viewRows()),
    };
  };

  const resetForProject = (project: Project, message: Notice): void => {
    batch(() => {
      setEditor(createEditorState(project));
      setCam({ x: 0, y: 0 });
      setCursor(initialCursor(0, 0));
      setHover(null);
      setPalScroll(0);
      setNotice(message);
    });
  };

  const switchDoc = (): void => {
    if (hostFile()) {
      setNotice({ kind: "bad", text: "DOC IS THE HOST --file; RELAUNCH TO OPEN ANOTHER PROJECT" });
      return;
    }
    const nextIndex = (docIndex() + 1) % BUNDLED_PROJECTS.length;
    setDocIndex(nextIndex);
    const slot = bootDoc(nextIndex);
    setDoc(slot);
    setSavedText(null);
    resetForProject(slot.project, { kind: "info", text: `OPENED ${slot.id}: ${slot.project.title}` });
  };

  const switchMap = (delta: number): void => {
    const e = editor();
    const count = e.project.maps.length;
    const next = (e.mapIndex + delta + count) % count;
    if (next === e.mapIndex) return;
    const switched = selectMap(e, next);
    batch(() => {
      setEditor(switched);
      setCam(clampCameraTo(switched, cam()));
    });
  };

  const performSave = (): void => {
    let e = editor();
    if (e.stroke) {
      e = strokeEnd(e);
      setEditor(e);
    }
    const candidate = exportProject(e);
    const errors = validateProject(candidate);
    if (errors.length > 0) {
      setNotice({
        kind: "bad",
        text: `EXPORT REFUSED: ${errors.length} schema error(s), first: ${errors[0]!.path} ${errors[0]!.msg}`,
      });
      return;
    }
    const text = serializeProject(candidate);
    if (svc) {
      // The desktop host persists {t:"save"} lines atomically to --file.
      svc.save(text);
      setSavedText(text);
      setEditor(markSaved(editor()));
      setNotice({ kind: "good", text: `SAVED ${text.length} bytes TO HOST FILE` });
      return;
    }
    if (fsOk) {
      const result = writeProject(doc().id, text);
      if ("error" in result) {
        setNotice({ kind: "bad", text: `SAVE FAILED: ${result.error}` });
        return;
      }
      setSavedText(text);
      setEditor(markSaved(editor()));
      setNotice({ kind: "good", text: `SAVED ${result.bytes} bytes TO ${result.path}` });
      return;
    }
    // Explicit, visible failure: no silent drop (the fs API's same rule).
    setNotice({
      kind: "bad",
      text: "NO SAVE CHANNEL: RELAUNCH WITH THE rpgkit-editor COMPANION OR A DATA.FS HOST",
    });
  };

  const toggleLayer = (): void => {
    const e = editor();
    const next = selectLayer(e, e.layer === "ground" ? "upper" : "ground");
    setEditor(next);
    setNotice({ kind: "info", text: `LAYER: ${next.layer.toUpperCase()}` });
  };

  const activateHeader = (index: number): void => {
    const id = HEADER_ORDER[index];
    if (id === undefined) return;
    if (id === "layer") toggleLayer();
    else if (id === "doc") switchDoc();
    else if (id === "mapprev") switchMap(-1);
    else if (id === "mapnext") switchMap(1);
    else if (id === "undo") {
      const e = editor();
      if (canUndo(e)) {
        const u = undo(e);
        batch(() => {
          setEditor(u);
          setCam(clampCameraTo(u, cam()));
        });
      }
    } else if (id === "redo") {
      const e = editor();
      if (canRedo(e)) {
        const r = redo(e);
        batch(() => {
          setEditor(r);
          setCam(clampCameraTo(r, cam()));
        });
      }
    } else if (id === "save") performSave();
  };

  const pickPalette = (slot: number): void => {
    const tile = palette()[slot] ?? null;
    setEditor(selectTile(editor(), tile));
    setNotice({ kind: "info", text: tile === null ? "ERASER SELECTED" : `TILE ${tile}` });
  };

  // --- pointer interaction ------------------------------------------------
  // false      no button held
  // "paint"    primary held (left)
  // "erase"    secondary/shift held
  let pointerDown: false | "paint" | "erase" = false;

  const cellPaint = (tx: number, ty: number): void => {
    const e = editor();
    const m = currentMap(e);
    if (tx < 0 || ty < 0 || tx >= m.width || ty >= m.height) return;
    setEditor(paintCell(e, ty * m.width + tx));
  };

  const hitAt = (x: number, y: number) => {
    const m = map();
    return hitTest(x, y, vp().w, vp().h, fit().frame, cam().x, cam().y, palette().length, palScroll(), {
      w: m.width,
      h: m.height,
    });
  };

  const handleMouseLine = (m: HostLine): void => {
    if (m.t !== "mouse") return;
    // A bare release (host Reset on focus loss) ends the stroke anywhere.
    if (m.x === undefined || m.y === undefined) {
      if (pointerDown) {
        setEditor(strokeEnd(editor()));
        pointerDown = false;
      }
      return;
    }
    const x = m.x | 0;
    const y = m.y | 0;
    if (m.d) {
      const erase = m.b === 2 || m.sh === true;
      const kind: "paint" | "erase" = erase ? "erase" : "paint";
      if (!pointerDown) {
        // Press edge: buttons and palette slots activate only here, so a
        // drag that starts on the header does not repaint the map.
        pointerDown = kind;
        const hit = hitAt(x, y);
        if (hit?.kind === "button") {
          activateHeader(HEADER_ORDER.indexOf(hit.id));
          return;
        }
        if (hit?.kind === "palette") {
          pickPalette(hit.slot);
          return;
        }
        if (hit?.kind === "cell") {
          setEditor(strokeStart(editor(), erase));
          setHover({ x: hit.tx, y: hit.ty });
          cellPaint(hit.tx, hit.ty);
        }
      } else {
        // Held move: only canvas cells extend the stroke.
        const hit = hitAt(x, y);
        if (hit?.kind === "cell") {
          setHover({ x: hit.tx, y: hit.ty });
          cellPaint(hit.tx, hit.ty);
        }
      }
    } else if (pointerDown) {
      setEditor(strokeEnd(editor()));
      pointerDown = false;
    }
    if (!m.d) {
      const hit = hitAt(x, y);
      setHover(hit?.kind === "cell" ? { x: hit.tx, y: hit.ty } : null);
    }
  };

  // --- buttons interaction (always live; the gamepad mode without svc) ---
  let prevButtons = 0;
  let strokeOpen = false;

  const stepButtons = (buttons: number): void => {
    const edge = buttons & ~prevButtons;
    const released = prevButtons & ~buttons;
    // With a pointer companion the host ALSO mirrors keys as buttons
    // (vendor/pocketjs/hosts/desktop/src/buttons.rs: z/x/a/s map to
    // CROSS/CIRCLE/SQUARE/TRIANGLE), so a cmd+z chord would undo AND erase
    // and a plain "z" would erase the cell under the cursor.
    // Pointer mode therefore lets buttons move the cursor only; activation
    // comes from the mouse and cmd-key chords. The gamepad fallback (no
    // companion) keeps the full button vocabulary.
    const pointerMode = svc !== null;
    let cur = cursor();
    let c = cam();
    const moveWorld = (dir: 0 | 1 | 2 | 3) => {
      const r = stepCursor(cur, dir, {
        mapW: map().width,
        mapH: map().height,
        viewCols: viewCols(),
        viewRows: viewRows(),
        camX: c.x,
        camY: c.y,
        paletteSize: palette().length,
        headerSize: HEADER_ORDER.length,
      });
      cur = r.cursor;
      c = { x: r.camX, y: r.camY };
    };
    if (edge & BTN.UP) moveWorld(2);
    if (edge & BTN.DOWN) moveWorld(0);
    if (edge & BTN.LEFT) moveWorld(1);
    if (edge & BTN.RIGHT) moveWorld(3);
    if (!pointerMode) {
      if (edge & BTN.SELECT) toggleLayer();
      if (edge & BTN.LTRIGGER) switchMap(-1);
      if (edge & BTN.RTRIGGER) switchMap(1);
      if (edge & BTN.SQUARE) activateHeader(HEADER_ORDER.indexOf("undo"));
      if (edge & BTN.TRIANGLE) activateHeader(HEADER_ORDER.indexOf("redo"));
      if (edge & BTN.START) performSave();
    }

    if (!pointerMode && edge & (BTN.CIRCLE | BTN.CROSS)) {
      const erase = (edge & BTN.CROSS) !== 0;
      if (cur.zone === "palette") {
        if (!erase) pickPalette(cur.slot);
      } else if (cur.zone === "header") {
        if (!erase) activateHeader(cur.button);
      } else if (!strokeOpen) {
        strokeOpen = true;
        setEditor(strokeStart(editor(), erase));
      }
    }
    if (!pointerMode && strokeOpen && cur.zone === "canvas" && (buttons & (BTN.CIRCLE | BTN.CROSS))) {
      const m = map();
      if (cur.tx < m.width && cur.ty < m.height) {
        setEditor((e) => paintCell(e, cur.ty * m.width + cur.tx));
      }
    }
    if (!pointerMode && released & (BTN.CIRCLE | BTN.CROSS) && strokeOpen) {
      setEditor((e) => strokeEnd(e));
      strokeOpen = false;
    }

    batch(() => {
      setCursor(cur);
      if (c.x !== cam().x || c.y !== cam().y) setCam(c);
      // Keep the gamepad cursor's palette row inside the scrolled strip.
      if (cur.zone === "palette") {
        const rowTop = Math.floor(cur.slot / PAL_COLS) * PAL_PITCH;
        const view = vp().h - HEADER_H - STATUS_H - PAL_GRID_TOP - PAL_PITCH;
        const y = palScroll();
        if (rowTop < y) setPalScroll(rowTop);
        else if (rowTop > y + view) setPalScroll(Math.max(0, rowTop - view));
      }
    });
    prevButtons = buttons;
  };

  // --- per-frame pump -----------------------------------------------------
  onFrame((buttons) => {
    if (svc) {
      for (const line of svc.poll()) {
        if (line.t === "resize" && line.w !== undefined && line.h !== undefined) {
          setVp({ w: line.w, h: line.h });
        } else if (line.t === "load" && typeof line.text === "string") {
          const text = line.text;
          const loaded = loadProject(text);
          if (loaded.errors.length === 0) {
            // Name the slot after the bundled example the file came from
            // (the launcher points --file at an example document).
            const match = BUNDLED_PROJECTS.findIndex((b) => b.title === loaded.project.title);
            if (match >= 0) setDocIndex(match);
            setDoc({ id: match >= 0 ? BUNDLED_PROJECTS[match]!.id : "file", project: loaded.project });
            setHostFile(true);
            setSavedText(text);
            setLoadNotice(`HOST FILE ${text.length} bytes`);
            resetForProject(loaded.project, { kind: "info", text: `LOADED ${text.length} bytes FROM HOST FILE` });
          } else {
            setNotice({
              kind: "bad",
              text: `HOST FILE REJECTED: ${loaded.errors[0]!.path} ${loaded.errors[0]!.msg}`,
            });
          }
        } else if (line.t === "mouse") {
          handleMouseLine(line);
        } else if (line.t === "scroll" && typeof line.dy === "number") {
          // Clamp so the last palette row can reach the panel bottom but
          // the strip never scrolls into emptiness.
          const panelH = vp().h - HEADER_H - STATUS_H;
          const stripH = PAL_GRID_TOP + Math.ceil(palette().length / PAL_COLS) * PAL_PITCH;
          const max = Math.max(0, stripH - panelH);
          setPalScroll((y) => Math.max(0, Math.min(max, y + Math.sign(line.dy!) * 16)));
        } else if (line.t === "key") {
          const name = line.k ?? "";
          if (line.cmd && (name === "z" || name === "Z")) {
            activateHeader(HEADER_ORDER.indexOf(line.sh ? "redo" : "undo"));
          } else if (line.cmd && (name === "y" || name === "Y")) {
            activateHeader(HEADER_ORDER.indexOf("redo"));
          } else if (line.cmd && (name === "s" || name === "S")) {
            performSave();
          } else if (name === "Undo") activateHeader(HEADER_ORDER.indexOf("undo"));
          else if (name === "Redo") activateHeader(HEADER_ORDER.indexOf("redo"));
        }
      }
    }
    stepButtons(buttons);
  });

  // --- test/dev hooks -----------------------------------------------------
  (globalThis as Record<string, unknown>).__rpgkitEditorState = () => ({
    editor: editor(),
    cam: cam(),
    cursor: cursor(),
    hover: hover(),
    notice: notice(),
    hasSvc: svc !== null,
    hasFs: fsOk,
    docId: doc().id,
    savedText: savedText(),
    loadNotice: loadNotice(),
    hostFile: hostFile(),
    uploaded: tileTextures.uploaded(),
  });
  (globalThis as Record<string, unknown>).__rpgkitEditorInject = (json: string) => {
    const loaded = loadProject(json);
    if (loaded.errors.length > 0) return { ok: false, errors: loaded.errors };
    resetForProject(loaded.project, { kind: "info", text: "INJECTED PROJECT JSON" });
    return { ok: true };
  };
  (globalThis as Record<string, unknown>).__rpgkitEditorExport = (): unknown => {
    const e = editor();
    const candidate = exportProject(e);
    return {
      ok: validateProject(candidate).length === 0,
      errors: validateProject(candidate),
      text: serializeProject(candidate),
    };
  };

  const buttonsRow = createMemo(() => headerButtons(vp().w));

  const statusLine = (): string => {
    const e = editor();
    const m = currentMap(e);
    const dirty = e.dirty ? "*" : "";
    const mode = svc ? "PTR" : "PAD";
    const sel = e.tile ?? "ERASE";
    const h = hover();
    const pos = h ? ` ${h.x},${h.y}` : "";
    return `${mode} | ${doc().id}${dirty} | ${m.id} ${m.width}x${m.height} | ${e.layer.toUpperCase()} | ${sel}${pos} | ${notice().text}`;
  };

  return (
    <View class="w-full h-full" style={{ bgColor: "#10131b" }} debugName="editor-root">
      <View
        class="absolute flex-row items-center"
        style={{ posType: 1, insetL: 0, insetT: 0, width: vp().w, height: HEADER_H, bgColor: "#1b2230" }}
        debugName="editor-header"
      >
        <For each={buttonsRow()}>
          {(b, i) => (
            <HeaderButton
              label={headerLabel(b.id)}
              x={b.x}
              w={b.w}
              focus={cursor().zone === "header" && cursor().button === i()}
              enabled={headerEnabled(b.id, editor(), hostFile())}
            />
          )}
        </For>
      </View>

      {banner() ? <Banner width={Math.max(0, vp().w - PAL_W)} /> : null}

      <PalettePanel
        thumbs={thumbs()}
        selectedSlot={selectedSlot() < 0 ? 0 : selectedSlot()}
        cursorSlot={cursor().zone === "palette" ? cursor().slot : -1}
        scrollY={palScroll()}
        panelH={vp().h - HEADER_H - STATUS_H}
      />

      <Canvas
        map={map()}
        upper={editor().upperDense[editor().mapIndex]!}
        camX={cam().x}
        camY={cam().y}
        cols={viewCols()}
        rows={viewRows()}
        frame={fit().frame}
        texKey={texKey}
        events={markers()}
        hover={hover()}
        cursorZone={cursor().zone}
        cursor={cursor().zone === "canvas" ? { x: cursor().tx, y: cursor().ty } : { x: -99, y: -99 }}
      />

      <View
        class="absolute flex-row items-center"
        style={{
          posType: 1,
          insetL: 0,
          insetT: vp().h - STATUS_H,
          width: vp().w,
          height: STATUS_H,
          bgColor: "#1b2230",
        }}
        debugName="editor-status"
      >
        <Text
          class="text-xs"
          style={{
            insetL: 4,
            textColor: notice().kind === "bad" ? BAD : notice().kind === "good" ? GOOD : DIM,
            lineHeight: 12,
            height: 12,
          }}
        >
          {statusLine()}
        </Text>
      </View>
    </View>
  );
}

function headerLabel(id: (typeof HEADER_ORDER)[number]): string {
  if (id === "layer") return "LAYER";
  if (id === "doc") return "DOC";
  if (id === "mapprev") return "<";
  if (id === "mapnext") return ">";
  if (id === "undo") return "UNDO";
  if (id === "redo") return "REDO";
  return "SAVE";
}

function headerEnabled(id: (typeof HEADER_ORDER)[number], e: EditorState, hostFile: boolean): boolean {
  if (id === "doc") return !hostFile;
  if (id === "undo") return canUndo(e);
  if (id === "redo") return canRedo(e);
  return true;
}

function sameTiles(a: TileId[], b: TileId[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}
