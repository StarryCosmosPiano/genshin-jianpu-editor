import { JpwFile, LayoutSection } from "../jpword/jpwfile";
import { fromJpw } from "../score/jpwimport";
import type { Score } from "../score/score";
import {
  analyzeSlashScore,
  normalizeNotationAnnotations,
  parseSlashScore,
  type SlashScoreDiagnostic,
  type SlashScoreKind,
  type SlashScoreOptions,
  type SlashPitchSource,
} from "../slashscore";

export type EditableDocumentFormat = "jpw" | SlashScoreKind;

export interface EditableDocumentParseResult {
  score: Score;
  /** Optional `.Layout` break directive consumed by the layout engine. */
  breakDescription: string | null;
  slashTimingDiagnostics: SlashScoreDiagnostic[];
  /** Pitch-source scan from the same effective options as the parsed TXT score. */
  slashSources: SlashPitchSource[] | null;
  /** Updated TXT options whose score annotations came from undoable metadata. */
  slashOptions: SlashScoreOptions | null;
}

/**
 * Parse one editable source document into the shared Score model.
 *
 * This boundary deliberately performs no DOM work and owns no App state. A
 * null result means that the source is syntactically incomplete; semantic
 * parser errors are allowed to bubble so the controller can report them.
 */
export function parseEditableDocument(
  text: string,
  format: EditableDocumentFormat,
  slashOptions: SlashScoreOptions | null,
): EditableDocumentParseResult | null {
  if (format === "jpw") {
    const file = JpwFile.fromString(text);
    if (!file) return null;
    const score = fromJpw(file);
    if (!score) return null;
    return {
      score,
      breakDescription: file.getSection(LayoutSection)?.desc ?? null,
      slashTimingDiagnostics: [],
      slashSources: null,
      slashOptions: null,
    };
  }

  if (!slashOptions) return null;
  const analysis = analyzeSlashScore(text);
  const options: SlashScoreOptions = {
    ...slashOptions,
    symbolDurations: { ...slashOptions.symbolDurations },
    wholeMeasureGroups: slashOptions.wholeMeasureGroups
      ?? (analysis.wholeMeasureGroups ? true : undefined),
    // Right-click notation commands serialize these arrays into the TXT
    // metadata comment.  Always re-read them from the current document so a
    // CodeMirror undo/redo restores the score object as well as the comment
    // text; keeping the controller's newer arrays made reverted tempo, meter,
    // key and ornament objects remain visible after Ctrl+Z.
    tempoMarks: analysis.tempoMarks.map((mark) => ({ ...mark })),
    keyChanges: analysis.keyChanges.map((change) => ({ ...change })),
    annotations: normalizeNotationAnnotations(analysis.annotations),
    noteTimingEdits: analysis.noteTimingEdits.map((edit) => ({ ...edit })),
  };
  const parsed = parseSlashScore(text, options);
  return {
    score: parsed.score,
    breakDescription: null,
    slashTimingDiagnostics: parsed.summary.diagnostics,
    slashSources: parsed.sources,
    slashOptions: options,
  };
}
