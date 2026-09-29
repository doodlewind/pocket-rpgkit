import { mount } from "@pocketjs/framework";
import { GameView, type StreamedChunkLayerStats } from "../../../src/ui/index.ts";
import { GAME_ASSETS } from "./assets-game.ts";
import { STREAMED_PROJECT } from "./fixture-data.ts";

export interface StreamedFixtureStats {
  ground?: StreamedChunkLayerStats;
  upper?: StreamedChunkLayerStats;
}

declare global {
  // eslint-disable-next-line no-var
  var __streamedFixtureStats: StreamedFixtureStats | undefined;
  // eslint-disable-next-line no-var
  var __streamedLoadBudget: number | undefined;
}

const stats: StreamedFixtureStats = {};
globalThis.__streamedFixtureStats = stats;
if (globalThis.__streamedLoadBudget !== undefined) {
  GAME_ASSETS.stream!.loadBudget = globalThis.__streamedLoadBudget;
}

mount(() => (
  <GameView
    project={STREAMED_PROJECT}
    assets={GAME_ASSETS}
    onStreamStats={(layer, value) => {
      stats[layer] = value;
    }}
  />
));
