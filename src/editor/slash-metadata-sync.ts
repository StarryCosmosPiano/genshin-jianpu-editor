import { ChangeSet, EditorState, StateField, type ChangeDesc, type Extension } from "@codemirror/state";
import { Chord, type Score } from "../score/score";
import {
  embedSlashScoreOptions, notationAnnotationsFromScore, parseSlashScore,
  slashPitchShape, slashScoreSourceRows, slashSourcePosition,
  type NotationAnnotationData, type SlashScoreOptions,
} from "../slashscore";
import { scanSlashTextSyntax, type SlashTextContainer } from "../slashscore/text-syntax";
import { editableSlashOptions, type EditableDocumentFormat } from "./document-parser";
import { buildSlashSourceNotes, type JpwSourceNote } from "./note-selection";

type SymbolAnnotation = Extract<NotationAnnotationData, { type: "triplet" | "cross-arpeggio" | "ornament" }>;
type PositionMap = (position: number, association: -1 | 1) => number;
const metadataLine = /^[ \t]*\/\/[ \t]*@jpeditor[ \t]+\{[^\r\n]*\}[ \t]*$/m;

function symbolAnnotation(annotation: NotationAnnotationData): annotation is SymbolAnnotation {
  return annotation.type === "triplet" || annotation.type === "cross-arpeggio" || annotation.type === "ornament";
}

function annotationKey(annotation: SymbolAnnotation): string {
  return JSON.stringify([annotation.type, annotation.measure, annotation.offset,
    "part" in annotation ? annotation.part : annotation.pitches]);
}

function includesSource(container: SlashTextContainer, note: JpwSourceNote): boolean {
  return note.from >= container.bodyFrom && note.to <= container.bodyTo;
}

function arpeggioMembersMatch(
  annotation: Extract<NotationAnnotationData, { type: "cross-arpeggio" }>,
  container: SlashTextContainer,
  notes: readonly JpwSourceNote[],
): boolean {
  const expected = annotation.pitches.map((pitch) => `${pitch.part}:${pitch.pitch}`).sort();
  const actual = notes.filter((note) => !note.grace && includesSource(container, note))
    .map((note) => `${note.partIndex}:${note.note.pitch}`).sort();
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function annotationNotes(annotation: SymbolAnnotation, notes: readonly JpwSourceNote[]): JpwSourceNote[] {
  return notes.filter((source) => {
    if (source.chord.measure.index !== annotation.measure) return false;
    if (annotation.type === "cross-arpeggio") {
      return Math.abs(source.chord.position.toFloat() - annotation.offset) < 1e-7
        && annotation.pitches.some((pitch) => pitch.part === source.partIndex && pitch.pitch === source.note.pitch);
    }
    if (source.partIndex !== annotation.part) return false;
    const start = annotation.type === "triplet"
      ? source.note.tuplet?.first.chord.position.toFloat() ?? source.chord.position.toFloat()
      : source.chord.position.toFloat();
    return Math.abs(start - annotation.offset) < 1e-7;
  });
}

function relevantMode(annotation: SymbolAnnotation, container: SlashTextContainer): boolean {
  return annotation.type === "triplet" ? container.mode === "triplet"
    : annotation.type === "cross-arpeggio" ? container.mode === "arpeggio"
      : container.mode === "trill" || container.mode === "triplet";
}

function rhythmSignature(text: string, container: SlashTextContainer, options: SlashScoreOptions): string {
  let end = container.to;
  // In intrinsic notation the glyphs immediately after a bracket set its
  // actual budget. Editing them must invalidate an older timing override.
  while (end < text.length && options.symbolDurations[text[end]] !== undefined) end++;
  let body = text.slice(container.bodyFrom, container.bodyTo) + text.slice(container.to, end);
  body = slashPitchShape(body, options);
  return options.spaceDivision === null ? body.replace(/\s/g, "") : body.replace(/\t/g, "");
}

function scoreTimingSignature(score: Score): string {
  return JSON.stringify({
    parts: score.parts.map((part) => part.measures.map((measure) => ({
      time: [measure.time.beats, measure.time.beatType],
      entries: measure.entries.flatMap((entry) => entry instanceof Chord ? [{
        at: entry.position.toString(), duration: entry.duration?.toString(), rest: entry.rest,
        pitches: entry.notes.map((note) => [note.pitch, note.rest,
          note.tuplet?.scope, note.tuplet?.actualEnd?.toString(),
          note.tuplet?.writtenMemberDuration(entry.duration!).toString()]),
      }] : []),
    }))),
  });
}

/** Update the footer after a complete text edit without serializing any music
 * row. Existing explicit timing stays authoritative when only pitches change.
 * A null result means incomplete syntax or an unparseable draft: keep typing. */
export function synchronizeSlashMetadata(
  previous: string,
  text: string,
  selectedOptions: SlashScoreOptions,
  mapPosition: PositionMap,
): string | null {
  const beforeRows = slashScoreSourceRows(previous, selectedOptions.kind).map((row) => row.text);
  const afterRows = slashScoreSourceRows(text, selectedOptions.kind).map((row) => row.text);
  if (JSON.stringify(beforeRows) === JSON.stringify(afterRows)) return text;
  // A normal pitch edit has no metadata consequence unless an explicit
  // arpeggio stores its selected pitches. Avoid parsing a large score in the
  // synchronous keystroke filter just to emit the identical timing footer.
  const existingFooter = metadataLine.exec(text)?.[0];
  if (existingFooter && !existingFooter.includes('"cross-arpeggio"')
    && JSON.stringify(beforeRows.map((row) => slashPitchShape(row, selectedOptions)))
      === JSON.stringify(afterRows.map((row) => slashPitchShape(row, selectedOptions)))) return text;
  const options = editableSlashOptions(text, selectedOptions);
  const syntax = scanSlashTextSyntax(text, options);
  if (!syntax.complete) return null;
  const oldOptions = editableSlashOptions(previous, selectedOptions);
  const oldSyntax = scanSlashTextSyntax(previous, oldOptions);
  if (!syntax.containers.length && !oldSyntax.containers.length) return text;
  try {
    let oldNotes: JpwSourceNote[] = [];
    if (oldSyntax.containers.length && options.annotations?.some(symbolAnnotation)) {
      const oldParsed = parseSlashScore(previous, oldOptions);
      oldNotes = buildSlashSourceNotes(previous, oldOptions, oldParsed.score, oldParsed.sources);
    }
    const matches = new Map<SlashTextContainer, SlashTextContainer>();
    for (const old of oldSyntax.containers) {
      const replacement = syntax.containers.find((candidate) => candidate.mode === old.mode
        && candidate.from === mapPosition(old.from, 1) && candidate.to === mapPosition(old.to, -1));
      if (replacement) matches.set(old, replacement);
    }
    const owners = new Map<SymbolAnnotation, SlashTextContainer[]>();
    const retained = (options.annotations ?? []).filter((annotation) => {
      if (!symbolAnnotation(annotation)) return true;
      const notes = annotationNotes(annotation, oldNotes);
      let containers = oldSyntax.containers.filter((container) => relevantMode(annotation, container)
        && notes.some((note) => includesSource(container, note))
        && (annotation.type !== "cross-arpeggio" || arpeggioMembersMatch(annotation, container, oldNotes)));
      // Fully silent tuplets have no pitch-source mapping. Match their actual
      // beat/offset so multiple silent groups in one measure stay independent.
      if (!containers.length && annotation.type === "triplet" && notes.length === 0) {
        containers = oldSyntax.containers.filter((container) => {
          if (!relevantMode(annotation, container)) return false;
          const at = slashSourcePosition(previous, container.from, oldOptions);
          return at?.measure === annotation.measure && Math.abs(at.offset - annotation.offset) < 1 / 192;
        });
      }
      if (!containers.length) return true; // An explicit score-only annotation.
      owners.set(annotation, containers);
      return containers.every((old) => {
        const next = matches.get(old);
        if (!next) return false;
        // A changed arpeggio membership is regenerated from its visible
        // members; a pitch-only triplet edit preserves its exact timing.
        return annotation.type === "triplet"
          ? rhythmSignature(previous, old, oldOptions) === rhythmSignature(text, next, options)
          : previous.slice(old.bodyFrom, old.bodyTo) === text.slice(next.bodyFrom, next.bodyTo);
      });
    });
    options.annotations = retained;
    let parsed = parseSlashScore(text, options);
    // Move surviving annotations with their original source tokens when a
    // complete row/beat is inserted or moved. No movement is inferred from
    // a different pitch at the old musical coordinate.
    let newNotes = buildSlashSourceNotes(text, options, parsed.score, parsed.sources);
    let moved = false;
    options.annotations = retained.map((annotation) => {
      if (!symbolAnnotation(annotation) || !owners.has(annotation)) return annotation;
      const oldNote = annotationNotes(annotation, oldNotes)[0];
      const nextNote = oldNote ? newNotes.find((note) => note.from === mapPosition(oldNote.from, 1)
        && note.partIndex === oldNote.partIndex) : undefined;
      const container = owners.get(annotation)![0];
      const nextContainer = matches.get(container);
      const at = !oldNote && nextContainer ? slashSourcePosition(text, nextContainer.from, options) : null;
      if (!nextNote && !at) return annotation;
      const measure = nextNote?.chord.measure.index ?? at!.measure;
      const delta = nextNote && oldNote ? nextNote.chord.position.minus(oldNote.chord.position).toFloat()
        : at!.offset - annotation.offset;
      if (measure === annotation.measure && Math.abs(delta) < 1e-7) return annotation;
      moved = true;
      return { ...annotation, measure, offset: annotation.offset + delta,
        ...(annotation.type === "triplet" ? {
          ...(annotation.end !== undefined ? { end: annotation.end + delta } : {}),
          ...(annotation.ordinary ? { ordinary: annotation.ordinary.map((item) => ({ ...item, offset: item.offset + delta })) } : {}),
        } : {}),
      };
    });
    if (moved) {
      parsed = parseSlashScore(text, options);
      newNotes = buildSlashSourceNotes(text, options, parsed.score, parsed.sources);
    }
    const preservedKeys = new Set(options.annotations.filter(symbolAnnotation).map(annotationKey));
    const generated = notationAnnotationsFromScore(parsed.score, options).filter(symbolAnnotation)
      .filter((annotation) => !preservedKeys.has(annotationKey(annotation)))
      .map((annotation) => {
        if (annotation.type !== "cross-arpeggio") return annotation;
        const notes = annotationNotes(annotation, newNotes);
        const containers = syntax.containers.filter((container) => container.mode === "arpeggio"
          && notes.some((note) => includesSource(container, note))
          && arpeggioMembersMatch(annotation, container, newNotes));
        // Direction belongs to this source brace, not to the onset shared by
        // several independent rolled groups. Changed pitches are regenerated
        // above; carry only the old owner's explicitly chosen direction.
        for (const [old, sourceContainers] of owners) {
          if (old.type === "cross-arpeggio" && sourceContainers.some((container) => {
            const mapped = matches.get(container);
            return mapped !== undefined && containers.includes(mapped);
          })) return { ...annotation, direction: old.direction };
        }
        return annotation;
      });
    if (generated.length) {
      const candidate = { ...options, annotations: [...options.annotations, ...generated] };
      // Metadata may not bake noteTimingEdits into a second timing override.
      // Only persist a derived annotation when replay is musically identical.
      if (scoreTimingSignature(parseSlashScore(text, candidate).score) === scoreTimingSignature(parsed.score)) {
        options.annotations = candidate.annotations;
      }
    }
    const footer = metadataLine.exec(embedSlashScoreOptions("", options))![0];
    const existing = metadataLine.exec(text);
    if (existing) return text.slice(0, existing.index) + footer + text.slice(existing.index + existing[0].length);
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    return text + (text.endsWith("\n") ? "" : newline) + newline + footer + newline;
  } catch {
    return null;
  }
}

/** Attach generated metadata to the same CodeMirror transaction as typing.
 * The last complete source and its mapped positions survive half-entered
 * pairs, so deleting two bracket characters in separate keystrokes is safe. */
export function slashMetadataSync(readContext: () => {
  format: EditableDocumentFormat; options: SlashScoreOptions | null;
}): Extension {
  const stable = StateField.define<{ text: string; mapping: ChangeDesc }>({
    create: (state) => ({ text: state.doc.toString(), mapping: state.changes().desc }),
    update(value, transaction) {
      if (!transaction.docChanged) return value;
      const context = readContext();
      const text = transaction.newDoc.toString();
      if (context.format === "jpw" || !context.options || scanSlashTextSyntax(text, context.options).complete) {
        return { text, mapping: ChangeSet.empty(transaction.newDoc.length).desc };
      }
      return { text: value.text, mapping: value.mapping.composeDesc(transaction.changes.desc) };
    },
  });
  return [stable, EditorState.transactionFilter.of((transaction) => {
    if (!transaction.docChanged || !(transaction.isUserEvent("input") || transaction.isUserEvent("delete"))) return transaction;
    const context = readContext();
    if (context.format === "jpw" || !context.options) return transaction;
    const before = transaction.startState.doc.toString();
    const text = transaction.newDoc.toString();
    // Hand editing the metadata itself is already an explicit settings edit.
    if (metadataLine.exec(before)?.[0] !== metadataLine.exec(text)?.[0]) return transaction;
    const snapshot = transaction.startState.field(stable);
    const mapping = snapshot.mapping.composeDesc(transaction.changes.desc);
    const synchronized = synchronizeSlashMetadata(snapshot.text, text, context.options,
      (position, association) => mapping.mapPos(position, association));
    if (synchronized === null || synchronized === text) return transaction;
    let from = 0;
    while (from < text.length && from < synchronized.length && text[from] === synchronized[from]) from++;
    let end = text.length;
    let nextEnd = synchronized.length;
    while (end > from && nextEnd > from && text[end - 1] === synchronized[nextEnd - 1]) { end--; nextEnd--; }
    return [transaction, { changes: { from, to: end, insert: synchronized.slice(from, nextEnd) }, sequential: true }];
  })];
}
