// src/index.ts — Pocket RPG Kit: a reusable 2D tile-RPG runtime and the
// rpgkit-project/v1 format for PocketJS.
//
//   import { stepSession, createSession } from "pocket-rpgkit";
//   import { DialogBox } from "pocket-rpgkit/ui";
//   import schema from "pocket-rpgkit/schema" with { type: "json" };

export * from "./engine/index.ts";
// The UI palette and the speaker-prefix rule are plain TypeScript (no JSX),
// so non-UI modules can share them with the pocket-rpgkit/ui components.
export {
  DEFAULT_UI_THEME,
  resolveUiTheme,
  speakerLabel,
  splitSpeaker,
  type SpeakerSplit,
  type UiTheme,
} from "./ui/theme.ts";
