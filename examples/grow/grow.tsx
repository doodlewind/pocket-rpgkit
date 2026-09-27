// @title Pocket RPG Kit — rule-grown settlement + timeline
// examples/grow/grow.tsx — four connected settlements grow to the right
// from one seeded rule set; the bottom timeline scrubs the growth (every
// tick is a pure re-grow from the seed), SQUARE grows a new seed, and
// CIRCLE on the finished village hands it to the normal playable session
// as a generated rpgkit-project/v1 document (grow-project.ts).
import { mount } from "@pocketjs/framework";
import { GrowView } from "./GrowView.tsx";

mount(() => <GrowView />);
