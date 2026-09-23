// src/ui/DialogBox.tsx — P1③ message layer: the typewriter dialog
// box and the choices box (docs/HIG.md §2.4 screen anatomy). The component is
// pure presentation: the interpreter reducer (engine/interpreter.ts) owns
// every word and the cursor; Solid signals only repaint when the visible
// string changes, so a fully-revealed box emits zero guest->core ops.
//
// Every row is its OWN fixed Text node (max four rows, the schema's
// commands.text.lines cap). One multiline Text repaints whole-document on
// every typed character and the framework's row pool leaves stale glyphs
// behind when the document shrinks; four independent row nodes change only
// their own line and nothing else.
//
//   ┌───────────────────────────┐  choices box (when modal=choices),
//   │  Read the weathered note? │    right-aligned above the message box
//   │  >Read note              │
//   │    Walk on                │
//   └───────────────────────────┘
//   ┌───────────────────────────┐  message box docked to the bottom
//   │ BRAMBLE MEADOW            │    of the 480x272 playfield
//   │ South: quiet grass....    │
//   │                   ○ next  │
//   └───────────────────────────┘

import { For, Show, type Accessor } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import type { Modal } from "../engine/interpreter.ts";

const RIM = "#5d7fa3";
const FILL = "#0b1626";
const INK = "#dce8ff";
const DIM = "#8aa4c4";
const ACCENT = "#ffe97a";

/** Slice the joined "line\nline" text to `revealed` chars; lines whose turn
 *  has not come render as empty strings (every row node stays mounted). */
function visibleLines(lines: string[], revealed: number): string[] {
  let left = revealed;
  return lines.map((line, i) => {
    if (left <= 0) return "";
    const take = Math.min(line.length, left);
    left -= take;
    if (i < lines.length - 1) left -= 1; // the joined "\n" separator
    return line.slice(0, take);
  });
}

const TEXT_ROWS = [0, 1, 2, 3];
const CHOICE_ROWS = [0, 1, 2, 3];

export function DialogBox(props: { modal: Accessor<Modal | null>; legend: Accessor<string> }) {
  const isChoice = () => props.modal()?.kind === "choices";
  const textLines = () => {
    const m = props.modal();
    if (m?.kind !== "text") return ["", "", "", ""];
    const visible = visibleLines(m.lines, m.revealed);
    return TEXT_ROWS.map((i) => visible[i] ?? "");
  };

  return (
    <View
      class="absolute left-0 right-0 bottom-0"
      style={{ posType: 1, height: 180 }}
      debugName="rpgkit-message-layer"
    >
      <Show when={props.modal()}>
        {/* Choices box: docked right, immediately above the message box.
            During choices the message box is hidden (the prompt lives in
            this box, MV parity). */}
        <Show when={isChoice()}>
          <View
            class="flex-col p-[2]"
            style={{ posType: 1, width: 248, height: 96, insetR: 12, insetB: 98, bgColor: RIM }}
            debugName="rpgkit-choices-box"
          >
            <View class="flex-col p-[6]" style={{ posType: 1, insetL: 2, insetT: 2, insetR: 2, insetB: 2, bgColor: FILL }}>
              <Text class="text-xs" style={{ textColor: DIM, lineHeight: 14, height: 14 }} debugName="rpgkit-choice-prompt">
                {`${isChoice() ? (props.modal() as Extract<Modal, { kind: "choices" }>).prompt : ""}`}
              </Text>
              <View class="flex-col" style={{ height: 4 }} />
              <For each={CHOICE_ROWS}>
                {(row) => {
                  const m = () => props.modal() as Extract<Modal, { kind: "choices" }> | null;
                  const exists = () => m()?.kind === "choices" && row < m()!.options.length;
                  const selected = () => exists() && m()!.index === row;
                  const label = () => (exists() ? `${selected() ? "> " : "  "}${m()!.options[row]}` : "");
                  return (
                    <Text
                      class="text-xs"
                      style={{ textColor: selected() ? ACCENT : INK, lineHeight: 14, height: 14 }}
                      debugName={`rpgkit-choice-${row}`}
                    >
                      {`${label()}`}
                    </Text>
                  );
                }}
              </For>
              <View class="flex-row justify-end" style={{ height: 14, insetT: 4 }}>
                <Text class="text-xs" style={{ textColor: DIM, lineHeight: 12, height: 12 }} debugName="rpgkit-choice-legend">
                  {`${props.legend()}`}
                </Text>
              </View>
            </View>
          </View>
        </Show>

        {/* Message box: two-tone rim + fill, four fixed text rows + legend. */}
        <Show when={!isChoice()}>
          <View
            class="flex-col p-[2]"
            style={{ posType: 1, height: 92, insetL: 8, insetR: 8, insetB: 8, bgColor: RIM }}
            debugName="rpgkit-message-box"
          >
            <View
              class="flex-col p-[8]"
              style={{ posType: 1, insetL: 2, insetT: 2, insetR: 2, insetB: 2, bgColor: FILL }}
            >
              <For each={TEXT_ROWS}>
                {(row) => (
                  <Text
                    class="text-xs"
                    style={{ textColor: INK, lineHeight: 15, height: 15 }}
                    debugName={`rpgkit-message-row-${row}`}
                  >
                    {`${textLines()[row]!}`}
                  </Text>
                )}
              </For>
              <View class="flex-row justify-end" style={{ height: 12 }}>
                <Text class="text-xs" style={{ textColor: DIM, lineHeight: 12, height: 12 }} debugName="rpgkit-message-legend">
                  {`${(() => {
                    const m = props.modal();
                    if (m?.kind !== "text") return "";
                    return m.complete ? props.legend() : "";
                  })()}`}
                </Text>
              </View>
            </View>
          </View>
        </Show>
      </Show>
    </View>
  );
}
