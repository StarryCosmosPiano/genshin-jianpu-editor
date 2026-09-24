import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { invertedEffects, isolateHistory } from "@codemirror/commands";
import type { EditableDocumentFormat } from "./document-parser";
import type { SlashScoreOptions } from "../slashscore";

export interface DocumentContext {
  format: EditableDocumentFormat;
  options: SlashScoreOptions | null;
}

/** Parser settings belong to the same undo event as the source they interpret.
 * Keep a snapshot even for plain TXT that has no embedded settings yet. */
export function documentContextHistory(readContext: () => DocumentContext) {
  const restore = StateEffect.define<DocumentContext>();
  const field = StateField.define<DocumentContext>({
    create: () => structuredClone(readContext()),
    update(value, transaction) {
      for (const effect of transaction.effects) {
        if (effect.is(restore)) value = effect.value;
      }
      return value;
    },
  });
  return {
    field,
    extension: [
      field,
      EditorState.transactionExtender.of((transaction) => {
        if (!transaction.docChanged || transaction.effects.some((effect) => effect.is(restore))) {
          return null;
        }
        const context = structuredClone(readContext());
        const changed = JSON.stringify(context) !== JSON.stringify(transaction.startState.field(field));
        return {
          effects: restore.of(context),
          annotations: changed ? isolateHistory.of("full") : [],
        };
      }),
      invertedEffects.of((transaction) => transaction.effects.some((effect) => effect.is(restore))
        ? [restore.of(transaction.startState.field(field))]
        : []),
    ],
  };
}
