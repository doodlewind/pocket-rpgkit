import { mount } from "@pocketjs/framework";
import {
  GameView,
  type AnimatedTilesStats,
} from "../../../src/ui/index.ts";
import { GAME_ASSETS } from "./assets-game.ts";
import { R2_UI_PROJECT } from "./fixture-data.ts";

export interface R2UiStats {
  below?: AnimatedTilesStats;
  above?: AnimatedTilesStats;
}

declare global {
  // eslint-disable-next-line no-var
  var __r2UiStats: R2UiStats | undefined;
}

const stats: R2UiStats = {};
globalThis.__r2UiStats = stats;

mount(() => (
  <GameView
    project={R2_UI_PROJECT}
    assets={GAME_ASSETS}
    onAnimatedStats={(layer, value) => {
      stats[layer] = value;
    }}
  />
));
