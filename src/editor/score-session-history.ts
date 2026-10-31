import { StateEffect } from "@codemirror/state";
import { invertedEffects } from "@codemirror/commands";
import type { InputCursorSnapshot, ScoreInteractionMode } from "./input-mode";
import type { InputTarget } from "./multi-input";

export interface ScoreSessionSnapshot {
  enabled: boolean;
  mode?: ScoreInteractionMode;
  cursor: InputCursorSnapshot | null;
  targets: InputTarget[];
}
export interface ScoreSessionChange { before: ScoreSessionSnapshot; after: ScoreSessionSnapshot }

/** An edit's exact UI targets travel with its CodeMirror history event. A
 * text-only undo does not invent a nearby replacement selection. */
export const scoreSessionChange = StateEffect.define<ScoreSessionChange>();
export const scoreSessionHistory = invertedEffects.of(transaction => transaction.effects.flatMap(effect =>
  effect.is(scoreSessionChange) ? [scoreSessionChange.of({ before: effect.value.after, after: effect.value.before })] : []));
