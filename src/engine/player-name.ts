// src/engine/player-name.ts — the player's name and the {name} text token.
//
// The name lives in the switch bank (interpreter.ts SwitchState.playerName),
// so it is part of every save snapshot and survives transfers. A fresh
// session seeds it from Project.playerName (a game-configurable default);
// there is no rename op in rpgkit-project/v1 yet, but substituting at fold
// time instead of compile time keeps that door open without recompiling the
// map programs.
//
// Substitution runs inside the reducer when a text or choices modal is
// built. The typewriter reveal is counted over the EXPANDED string, so a
// 3-letter name and the 6-character "{name}" token type out over the right
// number of ticks. Pure and fold-only: no host clock, so it replays
// identically at every host rate.

/** The in-text token replaced with the player's name. */
export const NAME_TOKEN = "{name}";

/** Name a fresh playthrough uses when a project sets no playerName. */
export const DEFAULT_PLAYER_NAME = "Player";

/** Replace every literal {name} token with `name`. Other braces pass
 *  through unchanged; a name containing "{name}" is substituted once (the
 *  result is not rescanned), so expansion always terminates. */
export function substitutePlayerName(text: string, name: string): string {
  if (!text.includes(NAME_TOKEN)) return text;
  return text.split(NAME_TOKEN).join(name);
}

/** Apply the name token to every line of a text page. */
export function substituteLines(lines: readonly string[], name: string): string[] {
  return lines.map((line) => substitutePlayerName(line, name));
}
