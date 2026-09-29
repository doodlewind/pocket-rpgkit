// editor/ui/canvas.tsx — the map canvas: ground cell grid, the upper star
// layer, event markers (display only; event editing is not implemented
// yet), and the pointer hover / gamepad cursor rings on top. Cells are real
// Image nodes bound to the pak-baked 16x16 tile images
// (engine/tile-keys.ts); an empty src binds no texture and the core skips
// the node, so a void ground cell leaves the map fill visible.

import { createMemo, For, Index } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import type { MapDef, TileId } from "../../src/engine/types.ts";
import { TILE, mapOffset, type FrameGeom } from "../engine/layout.ts";
import type { DenseUpper } from "../engine/model.ts";
import { INK, MARKER } from "./panels.tsx";

export interface CanvasProps {
  map: MapDef;
  upper: DenseUpper;
  camX: number;
  camY: number;
  /** Fitted window (tile count + screen rect). */
  cols: number;
  rows: number;
  frame: FrameGeom;
  /** Resolve a tile id to its baked pak image key ("" = none). */
  texKey: (tile: TileId) => string;
  events: { id: string; x: number; y: number }[];
  /** Crosshair tile in world coords, or null when the pointer is elsewhere. */
  hover: { x: number; y: number } | null;
  cursorZone: "canvas" | "palette" | "header";
  cursor: { x: number; y: number };
}

/** "vx,vy,id" — a primitive list key for the event markers, so <For> keeps
 *  the node of every marker whose position and id did not change. */
const cellKey = (vx: number, vy: number, payload: string): string => `${vx},${vy},${payload}`;
function splitKey(key: string): { vx: number; vy: number; payload: string } {
  const a = key.indexOf(",");
  const b = key.indexOf(",", a + 1);
  return { vx: Number(key.slice(0, a)), vy: Number(key.slice(a + 1, b)), payload: key.slice(b + 1) };
}

export function Canvas(props: CanvasProps): JSX.Element {
  // Dense fixed-size ground window: one tile id (or null) per screen cell,
  // row-major. <Index> keeps one Image per screen slot and its item signal
  // compares by value, so a repaint re-binds exactly the painted cell and a
  // pan re-binds only the slots whose tile changed.
  const groundTiles = createMemo<(TileId | null)[]>(() => {
    const out: (TileId | null)[] = [];
    const m = props.map;
    for (let vy = 0; vy < props.rows; vy++) {
      for (let vx = 0; vx < props.cols; vx++) {
        const wx = props.camX + vx;
        const wy = props.camY + vy;
        out.push(wx < m.width && wy < m.height ? (m.ground[wy * m.width + wx] ?? null) : null);
      }
    }
    return out;
  });

  // The star layer, windowed the same way: an empty slot binds no image
  // (the core skips it), so a repaint, a pan or a map switch re-binds only
  // the slots whose tile changed instead of remounting star cells.
  const upperTiles = createMemo<(TileId | null)[]>(() => {
    const out: (TileId | null)[] = [];
    const m = props.map;
    for (let vy = 0; vy < props.rows; vy++) {
      for (let vx = 0; vx < props.cols; vx++) {
        const wx = props.camX + vx;
        const wy = props.camY + vy;
        out.push(wx < m.width && wy < m.height ? (props.upper[wy * m.width + wx] ?? null) : null);
      }
    }
    return out;
  });

  const keyOf = (tile: TileId | null): string => (tile === null ? "" : props.texKey(tile));

  // Smaller-than-window maps center inside the frame (the runtime's
  // centerOffset/letterbox rule; engine/layout.mapOffset, floor split —
  // hitTest applies the same offset to pointer hits).
  const offX = createMemo(() => mapOffset(props.map.width, props.cols) * TILE);
  const offY = createMemo(() => mapOffset(props.map.height, props.rows) * TILE);

  const eventKeys = createMemo<string[]>(() =>
    props.events
      .filter(
        (e) =>
          e.x >= props.camX &&
          e.x < props.camX + props.cols &&
          e.y >= props.camY &&
          e.y < props.camY + props.rows &&
          e.x < props.map.width &&
          e.y < props.map.height,
      )
      .map((e) => cellKey(e.x - props.camX, e.y - props.camY, e.id)),
  );

  return (
    <View
      class="absolute"
      style={{
        posType: 1,
        insetL: props.frame.x,
        insetT: props.frame.y,
        width: props.frame.w,
        height: props.frame.h,
        bgColor: "#000000",
        borderWidth: 1,
        borderColor: "#3a4458",
        overflow: 1,
      }}
      debugName="editor-canvas-frame"
    >
      {/* The map rectangle: opaque dark indigo, so a smaller map's black
          frame margin is visibly distinct from its own fill. Every layer is
          its child, positioned in window-cell space, so a letterbox change
          (switching to a narrower map) moves one node instead of restyling
          every cell. */}
      <View
        class="absolute"
        style={{
          posType: 1,
          insetL: offX(),
          insetT: offY(),
          width: Math.min(props.map.width, props.cols) * TILE,
          height: Math.min(props.map.height, props.rows) * TILE,
          bgColor: "#14161e",
        }}
        debugName="editor-map"
      >
        <Index each={groundTiles()}>
          {(tile, i) => (
            <Image
              class="absolute"
              style={{
                posType: 1,
                insetL: (i % props.cols) * TILE,
                insetT: Math.floor(i / props.cols) * TILE,
                width: TILE,
                height: TILE,
              }}
              src={keyOf(tile())}
            />
          )}
        </Index>

        <Index each={upperTiles()}>
          {(tile, i) => (
            <Image
              class="absolute"
              style={{
                posType: 1,
                insetL: (i % props.cols) * TILE,
                insetT: Math.floor(i / props.cols) * TILE,
                width: TILE,
                height: TILE,
              }}
              src={keyOf(tile())}
            />
          )}
        </Index>

        {/* Event markers draw above both tile layers, translucent, so an event
            under an opaque star tile (meadow's flowerbed) stays visible and the
            tile art still shows through. Display only: editing events is not
            implemented yet. */}
        <For each={eventKeys()}>
          {(key) => {
            const e = splitKey(key);
            return (
              <View
                class="absolute flex-row items-center justify-center"
                style={{
                  posType: 1,
                  insetL: e.vx * TILE,
                  insetT: e.vy * TILE,
                  width: TILE,
                  height: TILE,
                  bgColor: MARKER,
                  borderWidth: 1,
                  borderColor: "#ffd5e6",
                  opacity: 0.7,
                }}
                debugName={`editor-event-${e.payload}`}
              >
                <Text class="text-xs" style={{ textColor: INK, lineHeight: 10, height: 10 }}>
                  !
                </Text>
              </View>
            );
          }}
        </For>

        {props.hover && (
          <View
            class="absolute"
            style={{
              posType: 1,
              insetL: (props.hover.x - props.camX) * TILE,
              insetT: (props.hover.y - props.camY) * TILE,
              width: TILE,
              height: TILE,
              borderWidth: 1,
              borderColor: "#5fd38a",
            }}
          />
        )}

        {props.cursorZone === "canvas" && (
          <View
            class="absolute"
            style={{
              posType: 1,
              insetL: (props.cursor.x - props.camX) * TILE,
              insetT: (props.cursor.y - props.camY) * TILE,
              width: TILE,
              height: TILE,
              borderWidth: 1,
              borderColor: "#ffd24a",
            }}
            debugName="editor-cursor"
          />
        )}
      </View>
    </View>
  );
}
