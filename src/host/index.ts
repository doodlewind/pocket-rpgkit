// src/host/index.ts — host adapters shipping with the component.

export {
  hasFsSave,
  fsSaveStore,
  saveSlotFs,
  loadSlotFs,
  listSlotsFs,
  type FsSlotInfo,
} from "./save-fs.ts";
export { loadAttractTape } from "./attract-tape.ts";
