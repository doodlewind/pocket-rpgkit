// @title Pocket RPG Kit Editor (tile painting + project I/O)
// editor/editor.tsx — entry of the tile-map editor app (dist/editor.js,
// dist/editor.pak). `bun run editor [sunstone|meadow]` opens it on the
// PocketJS desktop host with the rpgkit-editor companion; see README.md.
import { mount } from "@pocketjs/framework";
import { EditorApp } from "./app.tsx";

mount(() => <EditorApp />);
