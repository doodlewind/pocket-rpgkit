// src/ui/index.ts — Solid presentation components. Every component is pure
// presentation driven by engine reducer state; the host app owns signals and
// side effects.

export { DialogBox } from "./DialogBox.tsx";
export { PlayerSprite, playerImageKey, type PlayerFrames, type PlayerSpriteProps } from "./PlayerSprite.tsx";
export { SaveMenu, type SlotInfo, type SaveMenuProps } from "./SaveMenu.tsx";
