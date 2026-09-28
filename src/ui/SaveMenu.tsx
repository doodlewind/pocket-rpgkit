// src/ui/SaveMenu.tsx — P1⑤ save/load menu presentation.
//
// RpgKitApp owns engine/save-menu.ts's pure navigation state and performs
// the command a CONFIRM returns (fs write/read, snapshot build, OSK open);
// this component renders the current page. On a target without data.fs the
// root lists the two code rows only. The code export pages the URL-safe
// base64 of the same envelope the desktop writes; the code import runs the
// system OSK (@pocketjs/framework/osk), whose alphabet covers the code's
// A-Z a-z 0-9 - _. While the OSK is open its button block owns input.
//
// The panel is a Panel coloured by the `theme` prop (ui/theme.ts), over the
// theme's backdrop; `title` renames the root page ("POCKET RPG KIT — SAVE").

import { createMemo, For, Show, type Accessor } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { Osk } from "@pocketjs/framework/osk";
import type { OskController } from "@pocketjs/framework/osk";
import type { FsSlotInfo } from "../host/save-fs.ts";
import { ROOT_CODE, ROOT_FS, type MenuState } from "../engine/save-menu.ts";
import { Panel } from "./Panel.tsx";
import { resolveUiTheme, type UiTheme } from "./theme.ts";

export type SlotInfo = (FsSlotInfo | { slot: number; error: string } | null)[];

export interface SaveMenuProps {
  menu: Accessor<MenuState>;
  hasFs: boolean;
  slots: Accessor<SlotInfo>;
  saveCode: Accessor<string>;
  osk: OskController;
  legend: Accessor<string>;
  /** Panel and backdrop colours; missing keys keep DEFAULT_UI_THEME. */
  theme?: Partial<UiTheme>;
  /** Root page title (default "POCKET RPG KIT — SAVE"). */
  title?: string;
}

// Export pages: fixed-width rows of the code, ten rows per page.
const CODE_COLS = 24;
const CODE_ROWS = 10;

function codePages(code: string): string[] {
  const pages: string[] = [];
  for (let i = 0; i < code.length; i += CODE_COLS * CODE_ROWS) {
    pages.push(code.slice(i, i + CODE_COLS * CODE_ROWS));
  }
  return pages.length ? pages : [""];
}

function pageRows(page: string): string[] {
  const rows: string[] = [];
  for (let i = 0; i < CODE_ROWS; i++) {
    rows.push(page.slice(i * CODE_COLS, (i + 1) * CODE_COLS));
  }
  return rows;
}

function slotLabel(info: SlotInfo[number]): string {
  if (info === null) return "- empty";
  if ("error" in info) return "! damaged save";
  return `${info.map}  f${info.frame}`;
}

function isIndex(m: MenuState, i: number): boolean {
  return (m.kind === "root" || m.kind === "slots-save" || m.kind === "slots-load") && m.index === i;
}

export function SaveMenu(props: SaveMenuProps) {
  const pages = createMemo(() => codePages(props.saveCode()));
  const theme = createMemo(() => resolveUiTheme(props.theme));

  return (
    <Show when={props.menu().kind !== "closed"}>
      <View
        class="absolute inset-0 flex-row justify-center items-center"
        style={{ posType: 1, bgColor: theme().backdrop }}
        debugName="rpgkit-save-overlay"
      >
        <Panel
          theme={theme()}
          style={{ posType: 1, width: 420, height: 232 }}
          paperClass="flex-col grow p-[8]"
          debugName="rpgkit-save-panel"
        >
          {/* ROOT */}
          <Show when={props.menu().kind === "root"}>
            <Text class="text-sm" style={{ textColor: theme().accent, lineHeight: 18, height: 18 }} debugName="rpgkit-save-title">
              {props.title ?? "POCKET RPG KIT — SAVE"}
            </Text>
            <View style={{ height: 6 }} />
            <For each={props.hasFs ? ROOT_FS : ROOT_CODE}>
              {(row, i) => (
                <Text
                  class="text-sm"
                  style={{ textColor: isIndex(props.menu(), i()) ? theme().accent : theme().ink, lineHeight: 20, height: 20 }}
                  debugName={`rpgkit-save-root-${i()}`}
                >
                  {`${isIndex(props.menu(), i()) ? "> " : "  "}${row.label}`}
                </Text>
              )}
            </For>
            <View class="grow" />
            <Text class="text-xs" style={{ textColor: theme().dim, lineHeight: 14, height: 14 }} debugName="rpgkit-save-legend">
              {`${props.legend()}`}
            </Text>
          </Show>

          {/* SLOT LISTS */}
          <Show when={props.menu().kind === "slots-save" || props.menu().kind === "slots-load"}>
            {(() => {
              const m = props.menu();
              if (m.kind !== "slots-save" && m.kind !== "slots-load") return null;
              const saving = m.kind === "slots-save";
              return (
                <>
                  <Text class="text-sm" style={{ textColor: theme().accent, lineHeight: 18, height: 18 }} debugName="rpgkit-slot-title">
                    {saving ? "SAVE TO SLOT" : "LOAD FROM SLOT"}
                  </Text>
                  <View style={{ height: 6 }} />
                  <For each={[0, 1, 2]}>
                    {(row) => (
                      <Text
                        class="text-sm"
                        style={{ textColor: m.index === row ? theme().accent : theme().ink, lineHeight: 22, height: 22 }}
                        debugName={`rpgkit-slot-${row}`}
                      >
                        {`${m.index === row ? "> " : "  "}${row + 1}. ${slotLabel(props.slots()[row]!)}`}
                      </Text>
                    )}
                  </For>
                  <View class="grow" />
                  <Text class="text-xs" style={{ textColor: theme().dim, lineHeight: 14, height: 14 }} debugName="rpgkit-slot-legend">
                    {`${props.legend()}`}
                  </Text>
                </>
              );
            })()}
          </Show>

          {/* CODE EXPORT */}
          <Show when={props.menu().kind === "code-export"}>
            {(() => {
              const m = props.menu();
              if (m.kind !== "code-export") return null;
              const all = pages();
              const page = Math.min(m.page, all.length - 1);
              return (
                <>
                  <Text class="text-xs" style={{ textColor: theme().accent, lineHeight: 15, height: 15 }} debugName="rpgkit-code-title">
                    {`SAVE CODE — page ${page + 1}/${all.length}  (up/down: page)`}
                  </Text>
                  <View style={{ height: 4 }} />
                  <For each={pageRows(all[page]!)}>
                    {(line) => (
                      <Text class="text-xs" style={{ textColor: theme().ink, lineHeight: 15, height: 15 }} debugName="rpgkit-code-row">
                        {line}
                      </Text>
                    )}
                  </For>
                  <View class="grow" />
                  <Text class="text-xs" style={{ textColor: theme().dim, lineHeight: 14, height: 14 }} debugName="rpgkit-code-hint">
                    Write this code down; import it with "Load code". x: back.
                  </Text>
                </>
              );
            })()}
          </Show>

          {/* CODE IMPORT */}
          <Show when={props.menu().kind === "code-import"}>
            <Text class="text-sm" style={{ textColor: theme().accent, lineHeight: 18, height: 18 }} debugName="rpgkit-import-title">
              TYPE A SAVE CODE
            </Text>
            <View style={{ height: 4 }} />
            <Text class="text-xs" style={{ textColor: theme().ink, lineHeight: 15, height: 15 }} debugName="rpgkit-import-hint">
              The keyboard opens below; START commits, x cancels.
            </Text>
          </Show>

          {/* MESSAGE */}
          <Show when={props.menu().kind === "message"}>
            {(() => {
              const m = props.menu();
              if (m.kind !== "message") return null;
              return (
                <>
                  <View class="grow" />
                  <Text class="text-sm" style={{ textColor: theme().accent, lineHeight: 18, height: 18 }} debugName="rpgkit-message-title">
                    {m.title}
                  </Text>
                  <View style={{ height: 6 }} />
                  <Text class="text-sm" style={{ textColor: theme().ink, lineHeight: 18, height: 18 }} debugName="rpgkit-message-body">
                    {m.body}
                  </Text>
                  <View class="grow" />
                  <Text class="text-xs" style={{ textColor: theme().dim, lineHeight: 14, height: 14 }} debugName="rpgkit-message-legend">
                    {`${props.legend()}`}
                  </Text>
                </>
              );
            })()}
          </Show>
        </Panel>
      </View>
      {/* The system keyboard floats over the overlay while importing. */}
      <Osk osk={props.osk} />
    </Show>
  );
}
