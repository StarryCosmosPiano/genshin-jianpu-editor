// CodeMirror 6 highlighter for .jpwabc, driven by TokenData.parse (the same
// tokenizer the original used to colorize StyleClassedTextArea). Tokens are
// contiguous over the document, so offsets accumulate from token text lengths.

import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { TokenData, tokenClass } from "../jpword/tokens";

const markCache = new Map<string, Decoration>();
function mark(cls: string): Decoration {
  let m = markCache.get(cls);
  if (!m) {
    m = Decoration.mark({ class: cls });
    markCache.set(cls, m);
  }
  return m;
}

function buildDeco(view: EditorView): DecorationSet {
  const text = view.state.doc.toString();
  const len = text.length;
  const builder = new RangeSetBuilder<Decoration>();
  let data: TokenData;
  try {
    data = TokenData.parse(text);
  } catch {
    return builder.finish();
  }
  let pos = 0;
  for (const t of data.tokens) {
    const start = pos;
    let end = pos + t.text.length;
    pos = end;
    const cls = tokenClass[t.type];
    if (!cls || cls === "space") continue;
    if (start >= len) break;
    if (end > len) end = len;
    if (end <= start) continue;
    builder.add(start, end, mark(cls));
  }
  return builder.finish();
}

export const jpwHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDeco(view);
    }
    update(u: ViewUpdate): void {
      if (u.docChanged) this.decorations = buildDeco(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

export interface SourceHighlightRange {
  from: number;
  to: number;
}

/** Score picking owns this persistent source highlight independently of editor focus. */
export const setScoreSourceHighlights = StateEffect.define<readonly SourceHighlightRange[]>();

const scoreSourceMark = Decoration.mark({ class: "cm-score-source-selection" });

function sourceHighlightDecorations(ranges: readonly SourceHighlightRange[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of [...ranges].sort((a, b) => a.from - b.from || a.to - b.to)) {
    if (range.to > range.from) builder.add(range.from, range.to, scoreSourceMark);
  }
  return builder.finish();
}

export const scoreSourceHighlighter = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setScoreSourceHighlights)) next = sourceHighlightDecorations(effect.value);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export interface SlashVoiceHighlightRange {
  from: number;
  to: number;
  markerFrom: number;
  voiceIndex: number;
  color: string;
  decorateText: boolean;
  showMarker: boolean;
}

/** Dynamic TXT voice colors supplied by App after slash-score parsing. */
export const setSlashVoiceHighlights =
  StateEffect.define<readonly SlashVoiceHighlightRange[]>();

function voiceHighlightDecorations(ranges: readonly SlashVoiceHighlightRange[]): DecorationSet {
  const items: Array<{ from: number; to: number; decoration: Decoration }> = [];
  for (const range of ranges) {
    const color = /^#[\da-f]{6}$/i.test(range.color) ? range.color : "#dc2626";
    if (range.decorateText && range.to > range.from) {
      items.push({
        from: range.from,
        to: range.to,
        decoration: Decoration.mark({
          class: `cm-slash-voice cm-slash-voice-${range.voiceIndex}`,
          attributes: {
            "data-voice": `V${range.voiceIndex}`,
            style: `background-color:${color}20;border-bottom:2px solid ${color}88`,
          },
        }),
      });
    }
    if (range.showMarker && range.from > range.markerFrom) {
      items.push({
        from: range.markerFrom,
        to: range.from,
        decoration: Decoration.mark({
          class: "cm-slash-voice-marker",
          attributes: {
            "data-voice": `V${range.voiceIndex}`,
            style: `background-color:${color}35`,
          },
        }),
      });
    }
  }
  const builder = new RangeSetBuilder<Decoration>();
  for (const item of items.sort((left, right) =>
    left.from - right.from || left.to - right.to)) {
    builder.add(item.from, item.to, item.decoration);
  }
  return builder.finish();
}

export const slashVoiceHighlighter = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setSlashVoiceHighlights)) next = voiceHighlightDecorations(effect.value);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});
