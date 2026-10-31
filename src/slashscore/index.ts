import { Fraction } from "../common/fraction";
import { chordArpeggioPitchGroups, setChordArpeggioPitchGroups } from "../score/arpeggio";
import {
  Chord,
  formatTempoBpm,
  Measure,
  MusicCommon,
  Note,
  Part,
  CrossPartArpeggio,
  ScoreTextMark,
  quarterBpmFromUnit,
  Score,
  tempoBpmForUnit,
  TempoMark,
  Tuplet,
  type TempoBeatUnit,
} from "../score/score";
import { midiToScore, detectMidiSlashGestures, importedMidiSlashGestures, type MidiSlashGesture } from "../midi";
import type {
  MidiImportOptions,
  MidiQuantizeDivision,
  MidiSlashOrdering,
  ParsedMidi,
  ParsedMidiNote,
} from "../midi/types";
import {
  applyNoteTimingEdits,
  applyExplicitNoteTies,
  noteTieAnnotations,
  normalizeExplicitNoteTies,
  partNeedsExplicitNoteTies,
  type ExplicitNoteTie,
  normalizeNoteTimingEdits,
  normalizeScoreRestSpelling,
  type NoteTimingEditData,
} from "../score/note-timing";
import { applyKeyChangeKeepingDegrees } from "../score/key-edit";
import { sliceBeatTupletEvents } from "./beat-sliced-tuplet";
import { normalizeHeaderTypography, type HeaderTypography } from "../score/header-typography";
import { projectSourceTimedRows } from "./add-slashes";

export type SlashScoreKind = "keyboard" | "number";
// A generated mixed binary/triplet cell may need one explicit 128th value.
// MIDI import UI quantization choices still stop at 64.
export type SlashDurationDivision = 4 | 8 | 16 | 32 | 64 | 128;
export type SlashGroupMode = "none" | "chord" | "subdivide" | "grace" | "arpeggio" | "triplet" | "trill";
export type SlashDelimiterId = "brace" | "bracket" | "bar" | "angle" | "paren";
/** Zero-width marker used by editable TXT scores to assign one pitch to a voice. */
export const SLASH_VOICE_SEPARATOR = "\u2063";
export const MAX_SLASH_VOICES = 9;
/**
 * Compact TXT occasionally needs to advance an otherwise empty half-cell
 * before the next real atom.  Encode that padding in an overlong invisible
 * voice-marker run instead of writing a visible, fake `0` rest.  Counts up to
 * MAX_SLASH_VOICES retain their historical voice meaning; every additional
 * block of MAX_SLASH_VOICES represents one compact half-cell of padding.
 */
function compactMarkerVoiceNumber(markerCount: number, voiceCount: number): number {
  if (markerCount <= 0) return voiceCount;
  const encodedVoice = (markerCount - 1) % MAX_SLASH_VOICES + 1;
  return clamp(encodedVoice, 1, voiceCount);
}

function compactMarkerPaddingCells(markerCount: number): number {
  return markerCount > MAX_SLASH_VOICES
    ? Math.floor((markerCount - 1) / MAX_SLASH_VOICES)
    : 0;
}

function compactMarkerBaseCount(markerCount: number): number {
  return markerCount > 0 ? (markerCount - 1) % MAX_SLASH_VOICES + 1 : 0;
}

/** Encode a reassigned atom's marker without discarding compact fine-cell
 * padding.  A marker run longer than nine separators carries both the target
 * voice (the remainder) and one or more hidden half-cell advances (the full
 * blocks).  Selection code must use this instead of plain `repeat(voice)` or
 * moving a note back to the default row changes its rhythmic position. */
export function slashVoiceMarker(
  markerCount: number,
  targetVoice: number,
  voiceCount: number,
): string {
  const enabled = Math.max(1, Math.min(MAX_SLASH_VOICES, Math.round(voiceCount)));
  const target = clamp(Math.round(targetVoice), 1, enabled);
  const padding = compactMarkerPaddingCells(Math.max(0, Math.round(markerCount)));
  if (padding === 0 && target === enabled) return "";
  return SLASH_VOICE_SEPARATOR.repeat(padding * MAX_SLASH_VOICES + target);
}
/** Backward-compatible name retained for callers that configured `{}`. */
export type SlashBraceMode = SlashGroupMode;

export interface SlashTempoMark {
  measure: number;
  offset: number;
  kind: "accel" | "rit" | "tempo";
  bpm: number | null;
}

export interface SlashKeyChange {
  /** Zero-based notated measure index. */
  measure: number;
  /** Quarter-note offset within the measure; legacy metadata defaults to 0. */
  offset?: number;
  fifths: number;
}

/** A binary voice atom printed inside a shared triplet bracket. Pitch and
 * rest content still come from TXT; only its independent timing is stored. */
export interface SlashOrdinaryTiming {
  part: number;
  offset: number;
  duration: number;
  rest: boolean;
}

/**
 * Extensible notation annotations kept in the TXT metadata comment.
 * Unknown annotation kinds are deliberately ignored when reading external
 * files so future versions can add annotations without breaking old builds.
 */
export type NotationAnnotationData =
  | ({ type: "note-tie"; measure: number; offset: number } & ExplicitNoteTie)
  | { type: "key"; measure: number; offset: number; fifths: number }
  | { type: "meter"; measure: number; beats: number; beatType: 2 | 4 | 8 | 16 }
  | { type: "tempo"; measure: number; offset: number; bpm: number; beatUnit?: TempoBeatUnit }
  | {
    type: "tempo-ramp";
    mode: "accel" | "rit";
    from: { measure: number; offset: number };
    to: { measure: number; offset: number };
    targetBpm: number;
    beatUnit?: TempoBeatUnit;
  }
  | {
    type: "ornament";
    part: number;
    measure: number;
    offset: number;
    kind: "upper-mordent" | "lower-mordent" | "trill";
    subdivision?: 8 | 16 | 32 | 64 | 128;
  }
  | {
    type: "cross-arpeggio";
    measure: number;
    offset: number;
    parts: number[];
    pitches: Array<{ part: number; pitch: number }>;
    direction: "up" | "down";
  }
  | {
    type: "slur";
    part: number;
    from: { measure: number; offset: number };
    to: { measure: number; offset: number };
  }
  | {
    /** A triplet created by the notation cursor belongs to one voice. */
    type: "triplet";
    part: number;
    voice: number;
    measure: number;
    offset: number;
    scope: "voice" | "all";
    /** Quarter-note offset of this voice's real 3:2 boundary. */
    end?: number;
    /** Printed member values, in order, before the 3:2 compression. */
    members?: number[];
    /** Silent members may be omitted from a compact overlapping bracket. */
    memberRests?: boolean[];
    /** Printed members that continue the immediately preceding same-voice sound. */
    memberContinuations?: boolean[];
    /** Binary cell value restored when the bracket is deleted. */
    restoreUnit?: number;
    /** Ordinary parallel atoms in source order, outside the 3:2 timing grid. */
    ordinary?: SlashOrdinaryTiming[];
    /** The visible long group is distributed across per-beat containers. */
    beatSlices?: boolean;
  }
  | { type: "text"; part: number; measure: number; offset: number; text: string };

export interface SlashScoreOptions {
  headerTypography?: HeaderTypography;
  kind: SlashScoreKind;
  /** Keyboard TXT only: show A-Z key labels without changing pitch semantics. */
  keyboardKeyLabels?: boolean;
  /** Keyboard-key view only: print tied continuation pitches as visual 0s. */
  keyboardTieAsZero?: boolean;
  /** Keyboard-key view only: hide tied continuation pitch labels entirely. */
  keyboardHideTieLabels?: boolean;
  /** V1..VN; an unmarked pitch belongs to the last/default voice VN. */
  voiceCount: number;
  /** One shared label is printed to the left of a multi-voice brace. */
  instrumentName?: string;
  title: string;
  subtitle: string;
  composer: string;
  arranger: string;
  lyricist: string;
  tempoBpm: number;
  tempoBeatUnit?: TempoBeatUnit;
  fifths: number;
  beats: number;
  beatType: number;
  symbolDurations: Record<string, SlashDurationDivision>;
  /** False keeps only symbol slot 1 active; true allows all configured symbols. */
  multiDurationSymbols?: boolean;
  /** null means formatting whitespace; otherwise literal spaces add duration to the adjacent sounding note. */
  spaceDivision: SlashDurationDivision | null;
  /** null preserves the legacy marker-only rhythm; otherwise every note/chord advances this duration itself. */
  noteDivision: SlashDurationDivision | null;
  /** True means every `/` segment is one complete measure rather than one beat group. */
  wholeMeasureGroups?: boolean;
  /** Imported literal rows keep their source spelling; slash marks do not truncate durations. */
  sourceTimedRows?: boolean;
  adjacentAsChord?: boolean;
  /** Write a completely empty slash group as ` - ` instead of duration markers. */
  emptyGroupsAsRests?: boolean;
  /** Whether keyboard/number TXT should preserve explicit rest tokens. */
  showExplicitRests?: boolean;
  braceMode: SlashBraceMode;
  /** Defaults to triplet when absent in an older saved options comment. */
  bracketMode?: SlashGroupMode;
  /** `|...|` (legacy `||...||` is still accepted), unassigned by default. */
  barMode?: SlashGroupMode;
  /** `<...>`, defaults to grace; legacy files may still map it to subdivision. */
  angleMode?: SlashGroupMode;
  /** `(...)`, defaults to an ordinary simultaneous chord. */
  parenMode?: SlashGroupMode;
  /** Stable chord text order chosen during MIDI-to-TXT conversion. */
  ordering?: MidiSlashOrdering;
  /** MIDI tempo annotations retained inside the editable TXT settings comment. */
  tempoMarks?: SlashTempoMark[];
  /** Mid-score key signatures retained inside the editable TXT settings comment. */
  keyChanges?: SlashKeyChange[];
  /** Optional future-facing notation annotations retained in metadata. */
  annotations?: NotationAnnotationData[];
  /** Direct score-pane rhythmic edits retained inside the TXT settings comment. */
  noteTimingEdits?: NoteTimingEditData[];
}

export interface SlashMeterSuggestion {
  beats: number;
  beatType: number;
  groupsPerMeasure: number;
  groupQuarterNotes: number;
  explicit: boolean;
  /** Evidence did not identify a conventional meter; the importer must ask. */
  requiresInput?: boolean;
}

export interface SlashScoreAnalysis {
  headerTypography?: HeaderTypography;
  detectedKind: SlashScoreKind;
  keyboardKeyLabels: boolean;
  keyboardTieAsZero: boolean;
  keyboardHideTieLabels: boolean;
  voiceCount: number;
  measureCount: number;
  commentCount: number;
  ignoredTagCount: number;
  observedSymbols: string[];
  observedDelimiters?: SlashDelimiterId[];
  requiresMeterInput?: boolean;
  /** Newly detected duration symbols must be assigned before importing. */
  requiresSymbolMapping?: boolean;
  timingInferred?: boolean;
  containsScoreSpaces: boolean;
  suggestedMappings: Record<string, SlashDurationDivision>;
  multiDurationSymbols: boolean;
  suggestedSpaceDivision: SlashDurationDivision | null;
  suggestedNoteDivision: SlashDurationDivision | null;
  /** The imported TXT uses one complete measure per `/` segment. */
  wholeMeasureGroups: boolean;
  sourceTimedRows?: boolean;
  adjacentAsChord?: boolean;
  emptyGroupsAsRests: boolean;
  showExplicitRests: boolean;
  meter: SlashMeterSuggestion;
  tempoBpm: number;
  tempoBeatUnit: TempoBeatUnit;
  fifths: number;
  title: string;
  subtitle: string;
  composer: string;
  arranger: string;
  lyricist: string;
  suggestedBraceMode: SlashBraceMode;
  suggestedBracketMode: SlashGroupMode;
  suggestedBarMode: SlashGroupMode;
  suggestedAngleMode: SlashGroupMode;
  suggestedParenMode: SlashGroupMode;
  ordering: MidiSlashOrdering;
  tempoMarks: SlashTempoMark[];
  keyChanges: SlashKeyChange[];
  annotations: NotationAnnotationData[];
  noteTimingEdits: NoteTimingEditData[];
  /** One long score line contains several measures and must be split from the chosen meter. */
  continuous: boolean;
}

export interface SlashScoreSummary {
  kind: SlashScoreKind;
  measures: number;
  /** Length of an opening pickup in quarter-note units; 0 means no pickup. */
  pickupQuarterNotes: number;
  /** Automatically inserted leading zero rests inside the opening slash group. */
  pickupRestCount: number;
  comments: number;
  ignoredTags: number;
  clippedGroups: number;
  ignoredCharacters: number;
  diagnostics: SlashScoreDiagnostic[];
  warnings: string[];
}

export interface SlashScoreDiagnostic {
  severity: "error" | "incomplete";
  /** One-based source line number shown in the editor gutter. */
  line: number;
  from: number;
  to: number;
  /** Zero-based rendered measures covered by this source-line problem. */
  measureIndices: number[];
  /** Exact rhythmic groups when the offending beat can be identified. */
  beatLocations: Array<{
    measureIndex: number;
    /** Zero-based beat/group inside the rendered measure; null means the full measure. */
    beatIndex: number | null;
    beatCount: number;
  }>;
  message: string;
}

export interface SlashScoreResult {
  score: Score;
  summary: SlashScoreSummary;
  /** Exact pitch tokens used for this parse, including effective text directives. */
  sources: SlashPitchSource[];
}

export interface MidiSlashExportOptions {
  sourceMidi?: ParsedMidi;
  braceMode: SlashGroupMode;
  bracketMode: SlashGroupMode;
  barMode?: SlashGroupMode;
  angleMode?: SlashGroupMode;
  parenMode?: SlashGroupMode;
  ordering?: MidiSlashOrdering;
  /** Keep written 0 rests. False extends the preceding attack through gaps. */
  showExplicitRests?: boolean;
  /** Input-mode measures whose visible rest cells must survive this one
   * serialization even when the document normally uses implicit sustain. */
  preserveExplicitRestMeasures?: readonly number[];
  /** Legacy caller hint; new output uses attached notes instead of a delimiter. */
  subdivisionMode?: SlashDelimiterId;
  /** Serialize one binary level finer by attaching adjacent pitch atoms. */
  compactSubdivision?: boolean;
  /** Canonical TXT spelling used when rewriting an editable slash score. */
  durationNotation?: Pick<
    SlashScoreOptions,
    "symbolDurations" | "multiDurationSymbols" | "spaceDivision"
    | "noteDivision" | "wholeMeasureGroups" | "emptyGroupsAsRests" | "showExplicitRests"
  >;
}

type SlashExportGroupModes = Pick<MidiSlashExportOptions, "braceMode" | "bracketMode"
  | "barMode" | "angleMode" | "parenMode">;

/** One editable pitch spelling in the original keyboard/number slash-score text. */
export interface SlashPitchSource {
  from: number;
  to: number;
  pitch: number;
  /** Grace pitches and their following main chord share an event index. */
  eventIndex: number;
  /** True when the spelling belongs to a non-metrical grace-note container. */
  grace: boolean;
  /** One-based V1..VN assignment derived from the preceding separators. */
  voiceIndex: number;
  /** Absolute start of the zero-width voice prefix; equals `from` when unmarked. */
  markerFrom: number;
  markerCount: number;
  /** The source pitch is physically inside a rhythmic triplet delimiter. */
  tripletSource?: boolean;
}

interface SourceLines {
  score: string[];
  comments: string[];
  ignoredTags: number;
}

function mapProjectedSources(sources: SlashPitchSource[], offsets: readonly number[]): SlashPitchSource[] {
  return sources.flatMap(source => {
    const from = offsets[source.from];
    const last = offsets[source.to - 1];
    if (from === undefined || last === undefined || from < 0 || last < from) return [];
    const marker = offsets[source.markerFrom];
    return [{ ...source, from, to: last + 1,
      markerFrom: marker !== undefined && marker >= 0 ? marker : from }];
  });
}

function mapProjectedDiagnostics(diagnostics: SlashScoreDiagnostic[], offsets: readonly number[], text: string): SlashScoreDiagnostic[] {
  return diagnostics.map(diagnostic => {
    const positions = offsets.slice(diagnostic.from, diagnostic.to).filter(position => position >= 0);
    const from = positions[0] ?? 0;
    const to = positions.length ? positions[positions.length - 1] + 1 : from;
    return { ...diagnostic, from, to, line: text.slice(0, from).split(/\r\n|\r|\n/).length };
  });
}

interface Directives {
  sourceTimedRows?: boolean;
  adjacentAsChord?: boolean;
  headerTypography?: HeaderTypography;
  kind: SlashScoreKind | null;
  keyboardKeyLabels: boolean | null;
  keyboardTieAsZero: boolean | null;
  keyboardHideTieLabels: boolean | null;
  voiceCount: number | null;
  instrumentName: string;
  beats: number | null;
  beatType: number | null;
  tempoBpm: number | null;
  tempoBeatUnit: TempoBeatUnit | null;
  fifths: number | null;
  title: string;
  subtitle: string;
  composer: string;
  arranger: string;
  lyricist: string;
  mappings: Record<string, SlashDurationDivision>;
  multiDurationSymbols: boolean | null;
  spaceDivision: SlashDurationDivision | null | undefined;
  noteDivision: SlashDurationDivision | null | undefined;
  wholeMeasureGroups: boolean | null;
  emptyGroupsAsRests: boolean | null;
  showExplicitRests: boolean | null;
  braceMode: SlashBraceMode | null;
  bracketMode: SlashGroupMode | null;
  barMode: SlashGroupMode | null;
  angleMode: SlashGroupMode | null;
  parenMode: SlashGroupMode | null;
  ordering: MidiSlashOrdering;
  tempoMarks: SlashTempoMark[];
  keyChanges: SlashKeyChange[];
  annotations: NotationAnnotationData[];
  noteTimingEdits: NoteTimingEditData[];
}

type SlashArpeggioGroup = Array<{ part: number; pitch: number }>;

interface TimedEvent {
  start: number;
  end: number;
  pitches: number[];
  /** Exact source `/` group, independent of whether that group fills one beat or one measure. */
  sourceGroupKey?: string;
  /** Absolute end of the source `/` group. */
  sourceGroupEnd?: number;
  /** Source duration contributions kept separate for readable multi-voice spelling. */
  writtenDurations?: number[];
  /** Leading duration in a slash group continues this preceding event. */
  continuationOf?: TimedEvent;
  /** A voice-only boundary added for readable sustain; it has no source token. */
  syntheticContinuation?: boolean;
  /** Non-metrical notes printed before this event. */
  gracePitches?: number[][];
  /** The event is a rolled chord and receives an arpeggio wave. */
  arpeggio?: boolean;
  /** Only this subset receives the wave when a simultaneous main pitch is present. */
  arpeggioPitches?: number[];
  arpeggioGroups?: SlashArpeggioGroup[];
  /** A semantic mordent/trill written as nested timing containers. */
  ornamentKind?: "upper-mordent" | "lower-mordent" | "trill";
  /** Zero-based part/voice index. Old single-voice events omit this field. */
  voiceIndex?: number;
  /** Voice-specific rests sharing this common rhythmic column. */
  restVoiceIndexes?: number[];
  /** Source fixed 3:2 container identity, retained through voice splitting. */
  tripletGroup?: string;
  /** Zero-based member number; nested subdivision may contain more than 3. */
  tripletIndex?: number;
  /** End of this atom before per-voice sustain extends the event. */
  tripletEnd?: number;
  /** This explicit member belongs to a container spanning slash beat groups. */
  tripletCrossBeat?: boolean;
  /** The per-beat metadata decoder already assigned this event's voice. */
  metadataVoice?: boolean;
  /** A complete printed beat supplies a stable, unsplit triplet ruler. */
  tripletBeatRuler?: boolean;
  /** Explicitly voice-marked TXT containers stay voice-local even when the
   * source has no persisted @jpeditor ownership annotation yet. */
  tripletScope?: "voice" | "all";
  /** A sustained ordinary note written on an existing shared 3:2 grid. */
  tripletSpelling?: boolean;
}

interface PitchToken {
  pitch: number;
  next: number;
}

const DIVISIONS: SlashDurationDivision[] = [4, 8, 16, 32, 64, 128];
const DEGREE_INTERVALS = [0, 2, 4, 5, 7, 9, 11];
const KEYBOARD_ROWS = ["ZXCVBNM", "ASDFGHJ", "QWERTYU"] as const;
const LINE_TAG_RE = /\[(?:line|end)\s*\d+\s*\]/gi;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mode(values: number[], fallback: number): number {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = fallback;
  let bestCount = -1;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && value < best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function stripLineTags(line: string): { text: string; count: number } {
  let count = 0;
  const text = line.replace(LINE_TAG_RE, () => {
    count++;
    return "";
  });
  return { text, count };
}

function looksLikeScoreLine(line: string, inScoreSection = false): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("；") || trimmed.startsWith(";")) return false;
  // `//3../4../` is a valid opening measure with two omitted slash groups,
  // while `// comment` and the persisted `// @jpeditor ...` header remain
  // comments. Requiring a score token immediately after the empty groups and
  // another later separator keeps those two uses unambiguous.
  if (trimmed.startsWith("//") && !/^\/+\s*(?:[\u2063\-+0-9A-Z#b({]).*\//.test(trimmed)) return false;
  if (/\d+\s*\/\s*\d+\s*拍/.test(trimmed)) return false;
  const slashCount = (line.match(/\//g) ?? []).length;
  if (slashCount < 1) return false;
  const withoutTags = line.replace(LINE_TAG_RE, "");
  if (!/[A-Z1-7]/.test(withoutTags)) {
    if (/^\s*(?:-|\u2063*\s*0)(?:\s|[.=*_~:·])*\//.test(withoutTags)) return true;
    // An all-rest tuplet starts with its configured bracket rather than with
    // the first zero (`[0.0.0.].../`). It is still an explicit score row and
    // must survive TXT save/reopen instead of being mistaken for prose.
    if (withoutTags.includes("0")
      && /^[\s\u20630()[\]{}<>|.=*_~:·/]+$/.test(withoutTags)) return true;
    // Explicit score sections can contain whole continuation measures or
    // a final short continuation group. A single closing slash still marks
    // score data; dropping it would shorten the preceding sustained note.
    return inScoreSection
      && slashCount >= 1
      && /^[\s.=*_~:·/]+$/.test(withoutTags);
  }
  const nonSpace = Array.from(withoutTags).filter((c) => !/\s/.test(c) && c !== SLASH_VOICE_SEPARATOR);
  const latinLike = nonSpace.filter((c) => /[A-Za-z0-9+\-#b♭♯/(){}<>|[\].=*_~,'：:]/.test(c)).length;
  return nonSpace.length === 0 || latinLike / nonSpace.length >= 0.72;
}

interface SourceLineRecord {
  raw: string;
  text: string;
  from: number;
  to: number;
  line: number;
  score: boolean;
  kind: SlashScoreKind | null;
  sectionKind: SlashScoreKind | null;
  ignoredTags: number;
}

function scoreLineKind(line: string): SlashScoreKind | null {
  const withoutTags = line.replace(LINE_TAG_RE, "");
  const keyboardCount = (withoutTags.match(/[A-Z]/g) ?? []).length;
  const numberCount = [...withoutTags.matchAll(/(?:[#♯b♭]?[+-]*)([1-7])(?!\d)/g)].length;
  if (keyboardCount === 0 && numberCount === 0) return null;
  if (keyboardCount === numberCount) return null;
  return keyboardCount > numberCount ? "keyboard" : "number";
}

function sourceLineRecords(text: string): SourceLineRecord[] {
  const records: SourceLineRecord[] = [];
  let lineFrom = text.startsWith("\uFEFF") ? 1 : 0;
  let sectionKind: SlashScoreKind | null = null;
  let lineNumber = 1;
  while (lineFrom <= text.length) {
    let lineTo = lineFrom;
    while (lineTo < text.length && text[lineTo] !== "\r" && text[lineTo] !== "\n") lineTo++;
    const raw = text.slice(lineFrom, lineTo);
    const header = raw.trim();
    if (/^键盘谱$/i.test(header)) sectionKind = "keyboard";
    else if (/^数字谱$/i.test(header)) sectionKind = "number";
    const stripped = stripLineTags(raw);
    const score = looksLikeScoreLine(stripped.text, sectionKind !== null);
    records.push({
      raw,
      text: stripped.text,
      from: lineFrom,
      to: lineTo,
      line: lineNumber,
      score,
      kind: score ? scoreLineKind(stripped.text) : null,
      sectionKind,
      ignoredTags: stripped.count,
    });
    if (lineTo >= text.length) break;
    lineFrom = lineTo + (text[lineTo] === "\r" && text[lineTo + 1] === "\n" ? 2 : 1);
    lineNumber++;
  }
  return records;
}

function scoreLineOwner(records: readonly SourceLineRecord[], index: number): SlashScoreKind | null {
  const record = records[index];
  if (record.kind) return record.kind;
  if (record.sectionKind) return record.sectionKind;
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    if (!records[cursor].score) continue;
    if (records[cursor].kind) return records[cursor].kind;
  }
  for (let cursor = index + 1; cursor < records.length; cursor++) {
    if (!records[cursor].score) continue;
    if (records[cursor].kind) return records[cursor].kind;
  }
  return null;
}

function selectedScoreLine(
  records: readonly SourceLineRecord[],
  index: number,
  kind?: SlashScoreKind,
): boolean {
  if (!records[index].score) return false;
  if (!kind) return true;
  const owner = scoreLineOwner(records, index);
  return owner === null || owner === kind;
}

/** Whether this TXT already contains real score rows for the requested kind. */
export function hasSlashScoreLines(text: string, kind: SlashScoreKind): boolean {
  const records = sourceLineRecords(text);
  return records.some((_record, index) => selectedScoreLine(records, index, kind));
}

/** Original accepted rows, shared with live TXT syntax/metadata maintenance. */
export function slashScoreSourceRows(text: string, kind: SlashScoreKind): Array<{
  from: number; to: number; text: string;
}> {
  const records = sourceLineRecords(text);
  return records.filter((_record, index) => selectedScoreLine(records, index, kind))
    .map((record) => ({ from: record.from, to: record.to, text: record.raw }));
}

/** Musical coordinate of a source container, including silent groups that
 * have no pitch-source mapping. Used to retain/remove their saved timing. */
export function slashSourcePosition(text: string, position: number, options: SlashScoreOptions): {
  measure: number; offset: number;
} | null {
  const records = sourceLineRecords(text);
  const rows = records.filter((_record, index) => selectedScoreLine(records, index, options.kind));
  const rowIndex = rows.findIndex((row) => position >= row.from && position <= row.to);
  if (rowIndex < 0) return null;
  const row = rows[rowIndex];
  let meter = { beats: options.beats, beatType: options.beatType };
  for (const record of records) {
    if (record.from >= row.from) break;
    const match = /^\s*(\d{1,2})\s*\/\s*(2|4|8|16)\s*拍\s*[：:]\s*$/.exec(record.raw);
    if (match) meter = { beats: Number(match[1]), beatType: Number(match[2]) };
  }
  const groupCount = groupsForMeter(meter as SlashMeterSuggestion);
  const groupLength = meter.beats * 4 / meter.beatType / groupCount;
  const whole = options.wholeMeasureGroups ?? slashGroupsUseWholeMeasures(
    rows.map((record) => record.text), options, groupLength, meter.beats * 4 / meter.beatType,
  );
  const preceding = row.raw.slice(0, position - row.from);
  const group = (preceding.match(/\//g) ?? []).length;
  const measure = whole
    ? rows.slice(0, rowIndex).reduce((sum, record) => sum + splitGroups(record.text).length, 0) + group
    : rows.length === 1 ? Math.floor(group / groupCount) : rowIndex;
  const groupOffset = whole ? 0 : group % groupCount * groupLength;
  const prefix = stripLineTags(preceding.slice(preceding.lastIndexOf("/") + 1)).text;
  return { measure, offset: groupOffset + segmentMarkerDuration(prefix,
    effectiveMappings(options), options.braceMode, options.noteDivision,
    options.bracketMode ?? "triplet", { ...options, durationMeasure: measure, durationOffset: groupOffset },
    undefined, false, options.voiceCount, false, false) };
}

export interface SlashDelimiterMigrationResult {
  text: string;
  changed: number;
}

/** Rewrite score-row delimiters by their former semantic role.  This is used
 * only after the user confirms a bracket-setting migration; comments and the
 * @jpeditor JSON are never touched. */
export function migrateSlashDelimiters(
  text: string,
  current: SlashScoreOptions,
  next: SlashScoreOptions,
): SlashDelimiterMigrationResult {
  const currentSpecs = slashDelimiterSpecs(current);
  const nextSpecs = slashDelimiterSpecs(next);
  let changed = 0;
  const rewrite = (source: string): string => {
    let result = "";
    for (let index = 0; index < source.length;) {
      const container = slashContainerAt(source, index, current);
      if (!container) {
        result += source[index];
        index++;
        continue;
      }
      const body = rewrite(source.slice(container.bodyFrom, container.bodyTo));
      const replacement = container.spec.mode === "none"
        ? null
        : nextSpecs.find((spec) => spec.mode === container.spec.mode) ?? null;
      const target = replacement ?? currentSpecs.find((spec) => spec.id === container.spec.id)!;
      if (target.open !== container.spec.open || target.close !== container.spec.close) changed++;
      result += target.open + body + target.close;
      index = container.end;
    }
    return result;
  };
  const lineEnding = text.includes("\r\n") ? "\r\n" : "\n";
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom ? text.slice(1) : text;
  const records = sourceLineRecords(body);
  const lines = records.map((record, index) =>
    selectedScoreLine(records, index, current.kind) ? rewrite(record.raw) : record.raw);
  return { text: bom + lines.join(lineEnding), changed };
}

export interface SlashDelimiterClearResult {
  text: string;
  options: SlashScoreOptions;
  removed: number;
}

/** Clearing a delimiter is an edit to its source syntax, not merely a parser
 * preference. Stage the entire rewrite before returning, so callers can keep
 * text and settings unchanged if a restored ordinary value does not fit. */
export function clearSlashDelimiters(
  text: string, current: SlashScoreOptions, next: SlashScoreOptions,
): SlashDelimiterClearResult {
  const disabled = new Set(slashDelimiterSpecs(current)
    .filter(spec => spec.mode !== "none"
      && slashDelimiterSpecs(next).find(target => target.id === spec.id)?.mode === "none")
    .map(spec => spec.id));
  const options = { ...next, symbolDurations: { ...next.symbolDurations } };
  if (!disabled.size) return { text, options, removed: 0 };
  const mappings = effectiveMappings(next);
  const ownUnit = next.noteDivision ? 4 / next.noteDivision : 0;
  const separator = next.spaceDivision ? "\t" : " ";
  const finest = Math.max(4, current.noteDivision ?? 4, ...Object.values(effectiveMappings(current)));
  const atomsFallback = 4 / finest;
  const records = sourceLineRecords(text);
  const selected = records.filter((_record, index) => selectedScoreLine(records, index, current.kind));
  const originalGroupLength = current.beats >= 6 && current.beatType === 8 && current.beats % 3 === 0
    ? 1.5 : 4 / current.beatType;
  const wholeMeasures = current.wholeMeasureGroups ?? slashGroupsUseWholeMeasures(
    selected.map(record => record.text), current, originalGroupLength, current.beats * 4 / current.beatType,
  );
  type ClearedRange = { measure: number; from: number; to: number; groupEnd: number;
    mode: SlashGroupMode; delta: number; part: number | null };
  const cleared: ClearedRange[] = [];
  const retainedOrnaments: { measure: number; offset: number }[] = [];
  let removed = 0;
  let reencoded = 0;
  let restoredTriplet = false;
  let measure = 0;
  let meter = { beats: current.beats, beatType: current.beatType };
  const exactDuration = (duration: number, line: number): string => {
    if (duration < -1e-8) throw new Error(`第 ${line} 行三连音成员比音符自身时值更短，请先把自身时值改到所需最短时值再取消括号。`);
    let remaining = Math.max(0, duration);
    let result = "";
    const alphabet = Object.entries(mappings).sort((a, b) => a[1] - b[1]);
    for (const [glyph, division] of alphabet) {
      const unit = 4 / division;
      const count = Math.floor((remaining + 1e-8) / unit);
      result += glyph.repeat(count);
      remaining -= count * unit;
    }
    if (remaining > 1e-8) {
      const required = [4, 8, 16, 32, 64, 128].find(value =>
        Math.abs(duration * value / 4 - Math.round(duration * value / 4)) < 1e-8) ?? 128;
      throw new Error(`第 ${line} 行取消三连音需要至少 ${required} 分音符时值，请先设置可精确表示的细单位；原文和设置未更改。`);
    }
    return result;
  };
  const spanDuration = (body: string, fillTail = true): number => segmentMarkerDuration(body,
    effectiveMappings(current), current.braceMode, current.noteDivision,
    current.bracketMode ?? "triplet", current, undefined, false, current.voiceCount, false, fillTail);
  const rewrite = (source: string, line: number, measureIndex: number, groupStart: number,
    groupEnd: number, origin = 0): string => {
    let result = "";
    for (let index = 0; index < source.length;) {
      const tag = /^\[(?:line|end)\s*\d+\s*\]/i.exec(source.slice(index));
      if (tag) { result += tag[0]; index += tag[0].length; continue; }
      const container = slashContainerAt(source, index, current);
      if (!container) { result += source[index]; index++; continue; }
      const rawBody = source.slice(container.bodyFrom, container.bodyTo);
      let containerEnd = container.end;
      const from = groupStart + origin + spanDuration(source.slice(0, index), false);
      const isDisabled = disabled.has(container.spec.id);
      const preserveTripletInBareSyntax = container.spec.mode === "triplet"
        && !isDisabled && slashUsesBareChords(next) && !slashUsesBareChords(current);
      if (container.spec.mode === "triplet" && (isDisabled || preserveTripletInBareSyntax)) {
        let nestedSubdivision = false;
        const checkNested = (body: string): void => {
          for (let cursor = 0; cursor < body.length;) {
            const nested = slashContainerAt(body, cursor, current);
            if (nested?.spec.mode === "triplet"
              && !semanticMordentAtom(body.slice(nested.bodyFrom, nested.bodyTo), current)) {
              throw new Error(`第 ${line} 行包含源解析不支持的嵌套节奏分组，无法精确恢复普通顺序时值，请先整理内层分组再取消；原文和设置未更改。`);
            }
            if (nested?.spec.mode === "subdivide") {
              nestedSubdivision = true;
              checkNested(body.slice(nested.bodyFrom, nested.bodyTo));
            }
            if (nested?.spec.mode === "triplet") nestedSubdivision = true;
            cursor = nested?.end ?? cursor + 1;
          }
        };
        checkNested(rawBody);
        const atoms = timedContainerAtoms(rawBody, current, atomsFallback,
          Array.from({ length: current.voiceCount }, (_unused, voice) => voice));
        if (isDisabled && current.noteDivision !== null) {
          const stored = current.annotations?.find((item): item is Extract<NotationAnnotationData, { type: "triplet" }> =>
            item.type === "triplet" && item.measure === measureIndex
            && Math.abs(item.offset - from) <= 1 / 192 && item.end !== undefined
            && (item.members?.length ?? 0) > 0);
          if (stored?.members?.length === atoms.length) {
            atoms.forEach((atom, index) => { atom.nominalDuration = stored.members![index]!; });
          } else if (!stored) {
            let budget = 4 / current.noteDivision;
            const sourceMappings = effectiveMappings(current);
            while (sourceMappings[source[containerEnd] ?? ""] !== undefined) {
              budget += 4 / sourceMappings[source[containerEnd]!]!;
              containerEnd++;
            }
            const weight = atoms.reduce((sum, atom) => sum + atom.nominalDuration, 0);
            // Removing 3:2 restores the members' written values, derived
            // from the whole bracket's real budget rather than its weights.
            if (weight > 1e-9) atoms.forEach((atom) => { atom.nominalDuration *= budget * 1.5 / weight; });
          }
        }
        // The source parser flattens subdivision members inside a tuplet.
        // Once the outer tuplet is removed, that still-enabled subdivision
        // applies its own half-value. Spell its members twice as long so only
        // the removed outer 3:2 ratio changes, while keeping every inner atom.
        let renderedAtoms = 0;
        const nestedPieces = (body: string, offset: number, depth: number): string => {
          let written = "";
          for (let cursor = 0; cursor < body.length;) {
            const nested = slashContainerAt(body, cursor, current);
            if (nested?.spec.mode === "subdivide") {
              const innerDisabled = disabled.has(nested.spec.id);
              const inner = nestedPieces(body.slice(nested.bodyFrom, nested.bodyTo),
                offset + nested.bodyFrom, depth + (innerDisabled ? 0 : 1));
              if (innerDisabled) removed++;
              written += (innerDisabled ? inner
                : nested.spec.open + inner + nested.spec.close) + separator;
              cursor = nested.end;
              continue;
            }
            const atomIndex = atoms.findIndex(atom => atom.sourceFrom === offset + cursor);
            if (atomIndex < 0) { cursor++; continue; }
            const atom = atoms[atomIndex]!;
            renderedAtoms++;
            let end = body.length;
            for (let scan = cursor + 1; scan < body.length;) {
              const following = slashContainerAt(body, scan, current);
              if (following?.spec.mode === "subdivide"
                || atoms.some(item => item.sourceFrom === offset + scan)) { end = scan; break; }
              scan = following?.end ?? scan + 1;
            }
            let token = "";
            const chunk = body.slice(cursor, end);
            for (let scan = 0; scan < chunk.length;) {
              const inner = slashContainerAt(chunk, scan, current);
              if (inner) {
                if (inner.spec.mode === "triplet") {
                  if (disabled.has(inner.spec.id)) {
                    const helperBody = chunk.slice(inner.bodyFrom, inner.bodyTo);
                    const main = semanticMordentAtom(helperBody, current)!;
                    token += helperBody.slice(main.from, main.to);
                    removed++;
                  } else {
                    retainedOrnaments.push({ measure: measureIndex, offset: from
                      + atoms.slice(0, atomIndex).reduce((sum, item) => sum + item.nominalDuration, 0) * 2 / 3 });
                    token += chunk.slice(scan, inner.end);
                  }
                } else token += rewrite(chunk.slice(scan, inner.end), line, measureIndex,
                  from, groupEnd, 0);
                scan = inner.end;
              } else if (effectiveMappings(current)[chunk[scan]] !== undefined
                || /\s/.test(chunk[scan])) scan++;
              else { token += chunk[scan]; scan++; }
            }
            const innerFactor = isDisabled && depth > 0 ? 2 : 1;
            written += token + exactDuration(atom.nominalDuration * innerFactor - ownUnit, line)
              + separator;
            cursor = end;
          }
          return written.endsWith(separator) ? written.slice(0, -separator.length) : written;
        };
        // Preserve each atom's original pitch/ornament spelling. Remove only
        // its outer duration glyphs, then spell the ordinary value explicitly.
        const pieces = nestedSubdivision ? [nestedPieces(rawBody, 0, 0)] : atoms.map((atom, atomIndex) => {
          const start = atom.sourceFrom ?? 0;
          const end = atoms[atomIndex + 1]?.sourceFrom ?? rawBody.length;
          const chunk = rawBody.slice(start, end);
          let token = "";
          for (let cursor = 0; cursor < chunk.length;) {
            const nested = slashContainerAt(chunk, cursor, current);
            if (nested) {
              token += rewrite(chunk.slice(cursor, nested.end), line, measureIndex,
                from, groupEnd, 0);
              cursor = nested.end;
            } else if (effectiveMappings(current)[chunk[cursor]] !== undefined
              || /\s/.test(chunk[cursor])) cursor++;
            else { token += chunk[cursor]; cursor++; }
          }
          return token + exactDuration(atom.nominalDuration - ownUnit, line);
        });
        if (nestedSubdivision && renderedAtoms !== atoms.length) {
          throw new Error(`第 ${line} 行嵌套节奏分组的成员无法完整恢复；原文和设置未更改。`);
        }
        if (!atoms.length) throw new Error(`第 ${line} 行三连音没有可恢复的普通音符，请先整理括号内容。`);
        const ordinaryLength = atoms.reduce((sum, atom) => sum + atom.nominalDuration, 0);
        const oldLength = ordinaryLength * 2 / 3;
        if (isDisabled) {
          cleared.push({ measure: measureIndex, from, to: from + oldLength, groupEnd,
            mode: "triplet", delta: ordinaryLength - oldLength,
            part: explicitTimedContainerVoice(rawBody) });
          result += pieces.join(separator);
          restoredTriplet = true;
          removed++;
        } else {
          result += container.spec.open + pieces.join(separator) + container.spec.close;
          reencoded++;
        }
      } else {
        const body = rewrite(rawBody, line, measureIndex, groupStart, groupEnd,
          origin + spanDuration(source.slice(0, index), false));
        if (isDisabled) {
          cleared.push({ measure: measureIndex, from,
            to: from + (container.spec.mode === "chord" ? 0 : spanDuration(rawBody)),
            groupEnd, mode: container.spec.mode, delta: 0,
            part: explicitTimedContainerVoice(rawBody) });
          result += body;
          removed++;
        } else result += container.spec.open + body + container.spec.close;
      }
      index = containerEnd;
    }
    return result;
  };
  const output = records.map((record, recordIndex) => {
    const meterMatch = /^\s*(\d{1,2})\s*\/\s*(2|4|8|16)\s*拍\s*[：:]\s*$/.exec(record.raw);
    if (meterMatch) meter = { beats: Number(meterMatch[1]), beatType: Number(meterMatch[2]) };
    if (!selectedScoreLine(records, recordIndex, current.kind)) return record.raw;
    const groupCount = groupsForMeter({ ...meter } as SlashMeterSuggestion);
    const length = meter.beats * 4 / meter.beatType;
    const capacity = wholeMeasures ? length : length / groupCount;
    const comment = /\s\/\/|[;；]/.exec(record.raw);
    const codeEnd = comment?.index ?? record.raw.length;
    const groups = record.raw.slice(0, codeEnd).split("/");
    const realGroups = splitGroups(record.raw.slice(0, codeEnd)).length;
    const continuous = selected.length === 1 && !wholeMeasures;
    const rewritten = groups.map((group, groupIndex) => {
      if (groupIndex >= realGroups) return group;
      const measureIndex = wholeMeasures ? measure + groupIndex
        : continuous ? measure + Math.floor(groupIndex / groupCount) : measure;
      const groupStart = wholeMeasures ? 0 : (groupIndex % groupCount) * capacity;
      const before = removed;
      const value = rewrite(group, record.line, measureIndex, groupStart, groupStart + capacity);
      if (removed > before && restoredTriplet && !current.sourceTimedRows) {
        const duration = segmentMarkerDuration(value, mappings, next.braceMode,
          next.noteDivision, next.bracketMode ?? "triplet", next,
          undefined, false, next.voiceCount);
        if (duration > capacity + 1e-8) {
          throw new Error(`第 ${record.line} 行第 ${groupIndex % groupCount + 1} 拍取消三连音后放不下，请先腾出空间再取消；原文和设置未更改。`);
        }
      }
      return value;
    });
    measure += wholeMeasures ? realGroups : continuous ? Math.ceil(realGroups / groupCount) : 1;
    return rewritten.join("/") + record.raw.slice(codeEnd);
  });
  if (!removed && !reencoded) return { text, options, removed: 0 };
  if (restoredTriplet) options.wholeMeasureGroups = wholeMeasures;
  if (slashUsesBareChords(options)) options.adjacentAsChord = true;
  const remap = (measureIndex: number, offset: number): number => {
    let moved = offset;
    for (const range of cleared.filter(item => item.mode === "triplet" && item.measure === measureIndex)) {
      if (offset >= range.to - 1e-8 && offset < range.groupEnd - 1e-8) moved += range.delta;
      else if (offset >= range.from && offset < range.to) moved += (offset - range.from) / 2;
    }
    return moved;
  };
  options.annotations = (next.annotations ?? current.annotations ?? []).filter(annotation => {
    if (annotation.type !== "triplet" && annotation.type !== "cross-arpeggio"
      && annotation.type !== "ornament") return true;
    if (annotation.type === "ornament" && retainedOrnaments.some(item =>
      item.measure === annotation.measure && Math.abs(item.offset - annotation.offset) < 1e-8)) return true;
    return !cleared.some(range => range.measure === annotation.measure
      && annotation.offset >= range.from - 1e-8
      && (Math.abs(annotation.offset - range.from) < 1e-8 || annotation.offset < range.to - 1e-8)
      && (range.part === null || !("part" in annotation) || annotation.part === range.part)
      && (annotation.type === "triplet" && range.mode === "triplet"
        || annotation.type === "cross-arpeggio" && range.mode === "arpeggio"
        || annotation.type === "ornament" && (range.mode === "trill"
          || range.mode === "triplet")));
  }).map(annotation => {
    if ("measure" in annotation && "offset" in annotation) return { ...annotation,
      offset: remap(annotation.measure, annotation.offset),
      ...(annotation.type === "triplet" && annotation.end !== undefined
        ? { end: remap(annotation.measure, annotation.end) } : {}) };
    if (annotation.type === "slur" || annotation.type === "tempo-ramp") return { ...annotation,
      from: { ...annotation.from, offset: remap(annotation.from.measure, annotation.from.offset) },
      to: { ...annotation.to, offset: remap(annotation.to.measure, annotation.to.offset) } };
    return annotation;
  });
  const lineEnding = text.includes("\r\n") ? "\r\n" : "\n";
  return { text: (text.startsWith("\uFEFF") ? "\uFEFF" : "") + output.join(lineEnding), options, removed };
}

function sourceLines(text: string, kind?: SlashScoreKind): SourceLines {
  const records = sourceLineRecords(text);
  return {
    score: records
      .filter((_record, index) => selectedScoreLine(records, index, kind))
      .map((record) => record.text),
    comments: records
      .filter((record) => !record.score && record.raw.trim())
      .map((record) => record.raw),
    ignoredTags: records.reduce((sum, record) => sum + record.ignoredTags, 0),
  };
}

/**
 * Replace only the active keyboard/number score lines while retaining titles,
 * comments, the other mixed notation kind, and all user-authored prose.
 */
export function replaceSlashScoreLines(
  text: string,
  replacement: string,
  kind: SlashScoreKind,
): string {
  const original = sourceLineRecords(text);
  const replacementRecords = sourceLineRecords(replacement);
  const meterLine = /^\s*\d{1,2}\s*\/\s*(?:2|4|8|16)\s*拍\s*[：:]\s*$/;
  const generatedIndexes = replacementRecords
    .map((_record, index) => selectedScoreLine(replacementRecords, index, kind) ? index : -1)
    .filter((index) => index >= 0);
  const openingMeterBefore = (
    records: readonly SourceLineRecord[],
    scoreIndex: number,
  ): number => {
    for (let index = scoreIndex - 1; index >= 0; index--) {
      if (meterLine.test(records[index].raw)) return index;
      // Do not borrow a meter from an earlier keyboard/number score section.
      if (selectedScoreLine(records, index, "keyboard")
        || selectedScoreLine(records, index, "number")) break;
    }
    return -1;
  };
  const generatedOpeningMeterIndex = generatedIndexes.length > 0
    ? openingMeterBefore(replacementRecords, generatedIndexes[0])
    : -1;
  const generatedOpeningMeter = generatedOpeningMeterIndex >= 0
    ? replacementRecords[generatedOpeningMeterIndex].raw
    : null;
  const generated = generatedIndexes.map((index, scoreIndex) => {
    const chunk: string[] = [];
    const previous = replacementRecords[index - 1];
    // The opening meter belongs to the document header. A meter immediately
    // before any later score row belongs to that row and must travel with it.
    if (scoreIndex > 0 && previous && meterLine.test(previous.raw)) chunk.push(previous.raw);
    chunk.push(replacementRecords[index].raw);
    return chunk;
  });
  const selected = original.map((_record, index) =>
    selectedScoreLine(original, index, kind));
  if (!selected.some(Boolean) || generated.length === 0) return text;
  const firstSelectedIndex = selected.findIndex(Boolean);
  const originalOpeningMeterIndex = openingMeterBefore(original, firstSelectedIndex);
  const lineEnding = text.includes("\r\n") ? "\r\n" : "\n";
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";

  const oldMidMeter = new Set<number>();
  let seenSelected = false;
  original.forEach((record, index) => {
    if (selected[index]) {
      seenSelected = true;
      return;
    }
    if (seenSelected && meterLine.test(record.raw)
      && selected.slice(index + 1).some(Boolean)) oldMidMeter.add(index);
  });

  // Map generated rows onto their existing rows one by one even when input
  // mode adds or removes a trailing draft measure.  The old fallback inserted
  // every generated row at the first score line; comments between measures
  // then moved behind the whole score and the first beat of the next section
  // could be merged into its neighbour. Extra generated rows belong after the
  // last original score row, before footer metadata.
  const lines: string[] = [];
  let cursor = 0;
  const lastSelectedIndex = selected.lastIndexOf(true);
  original.forEach((record, index) => {
    if (oldMidMeter.has(index)) return;
    if (selected[index]) {
      if (index === firstSelectedIndex
        && originalOpeningMeterIndex < 0
        && generatedOpeningMeter) lines.push(generatedOpeningMeter);
      const replacement = generated[cursor++];
      if (replacement) lines.push(...replacement);
      if (index === lastSelectedIndex) {
        while (cursor < generated.length) lines.push(...generated[cursor++]);
      }
      return;
    }
    if (index === originalOpeningMeterIndex && generatedOpeningMeter) {
      lines.push(generatedOpeningMeter);
    } else {
      lines.push(record.raw);
    }
  });
  return bom + lines.join(lineEnding);
}

/** Infer the minimum voice count from markers in real score lines only. */
export function inferSlashVoiceCount(text: string, kind?: SlashScoreKind): number {
  const lines = sourceLines(text, kind);
  let maxMarkers = 0;
  for (const line of lines.score) {
    const runs = line.matchAll(/\u2063+(?=(?:[#♯b♭]*[,+']*|[#♯b♭]*[+-]*)[A-Z0-7])/g);
    for (const run of runs) {
      maxMarkers = Math.max(maxMarkers, compactMarkerBaseCount(run[0].length));
    }
  }
  return clamp(maxMarkers + 1, 1, MAX_SLASH_VOICES);
}

function straySlashVoiceMarkerCount(text: string, kind?: SlashScoreKind): number {
  let stray = 0;
  for (const line of sourceLines(text, kind).score) {
    const all = (line.match(/\u2063/g) ?? []).length;
    const valid = [...line.matchAll(/\u2063+(?=(?:[#♯b♭]*[,+']*|[#♯b♭]*[+-]*)[A-Z0-7])/g)]
      .reduce((sum, match) => sum + match[0].length, 0);
    stray += Math.max(0, all - valid);
  }
  return stray;
}

function divisionFromText(value: string): SlashDurationDivision | null {
  const normalized = value.replace(/\s/g, "");
  const chinese: Array<[RegExp, SlashDurationDivision]> = [
    [/一百二十八分/, 128], [/六十四分/, 64], [/三十二分/, 32], [/十六分/, 16], [/八分/, 8], [/四分/, 4],
  ];
  for (const [pattern, division] of chinese) if (pattern.test(normalized)) return division;
  const numeric = /(?:^|[^\d])(128|64|32|16|8|4)\s*分/.exec(value);
  return numeric ? parseInt(numeric[1], 10) as SlashDurationDivision : null;
}

function keyToFifths(name: string): number | null {
  const normalized = name.trim().replace("♭", "b").replace("♯", "#").toUpperCase();
  const index = MusicCommon.keys.findIndex((key) => key.toUpperCase() === normalized);
  return index < 0 ? null : index - 7;
}

function finiteOffset(value: unknown): number | null {
  const offset = Number(value);
  return Number.isFinite(offset) && offset >= 0 ? Math.round(offset * 192) / 192 : null;
}

function validTempoUnit(value: unknown): value is TempoBeatUnit {
  return value === "quarter" || value === "dotted-quarter" || value === "eighth";
}

/** Drop malformed/unknown annotation objects from untrusted metadata. */
export function normalizeNotationAnnotations(value: unknown): NotationAnnotationData[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): NotationAnnotationData[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const type = record.type;
    if (type === "note-tie") {
      return normalizeExplicitNoteTies([record]).map(tie => ({ ...tie, type,
        measure: tie.from.measure, offset: Fraction.fromString(tie.from.offset).toFloat() }));
    }
    if (type === "meter") {
      const measure = Math.round(Number(record.measure));
      const beats = Math.round(Number(record.beats));
      const beatType = Math.round(Number(record.beatType));
      return Number.isFinite(measure) && measure > 0
        && Number.isFinite(beats) && beats >= 1 && beats <= 32
        && (beatType === 2 || beatType === 4 || beatType === 8 || beatType === 16)
        ? [{ type, measure, beats, beatType }]
        : [];
    }
    if (type === "key") {
      const measure = Math.round(Number(record.measure));
      const offset = finiteOffset(record.offset);
      const fifths = Math.round(Number(record.fifths));
      // Measures are zero-based in metadata. A mid-measure key change in the
      // opening bar is therefore `measure: 0` and must not be discarded (the
      // old `> 0` check changed the pitches but silently lost the visible
      // `1=X` marker on the subsequent TXT round trip).
      return Number.isFinite(measure) && measure >= 0 && offset !== null
        && Number.isFinite(fifths) && fifths >= -7 && fifths <= 7
        ? [{ type, measure, offset, fifths }]
        : [];
    }
    if (type === "tempo") {
      const measure = Math.round(Number(record.measure));
      const offset = finiteOffset(record.offset);
      const bpm = Math.round(Number(record.bpm) * 10) / 10;
      const beatUnit = record.beatUnit;
      return Number.isFinite(measure) && measure >= 0 && offset !== null
        && Number.isFinite(bpm) && bpm > 0
        && (beatUnit === undefined || validTempoUnit(beatUnit))
        ? [{ type, measure, offset, bpm, ...(beatUnit ? { beatUnit } : {}) }]
        : [];
    }
    if (type === "tempo-ramp") {
      const mode = record.mode;
      const from = record.from;
      const to = record.to;
      if ((mode !== "accel" && mode !== "rit")
        || !from || typeof from !== "object" || !to || typeof to !== "object") return [];
      const fromRecord = from as Record<string, unknown>;
      const toRecord = to as Record<string, unknown>;
      const fromMeasure = Math.round(Number(fromRecord.measure));
      const toMeasure = Math.round(Number(toRecord.measure));
      const fromOffset = finiteOffset(fromRecord.offset);
      const toOffset = finiteOffset(toRecord.offset);
      const targetBpm = Math.round(Number(record.targetBpm) * 10) / 10;
      const beatUnit = record.beatUnit;
      return Number.isFinite(fromMeasure) && fromMeasure >= 0
        && Number.isFinite(toMeasure) && toMeasure >= fromMeasure
        && fromOffset !== null && toOffset !== null
        && Number.isFinite(targetBpm) && targetBpm > 0
        && (beatUnit === undefined || validTempoUnit(beatUnit))
        ? [{ type, mode, from: { measure: fromMeasure, offset: fromOffset }, to: { measure: toMeasure, offset: toOffset }, targetBpm,
          ...(beatUnit ? { beatUnit } : {}) }]
        : [];
    }
    if (type === "text") {
      const part = Math.round(Number(record.part ?? 0));
      const measure = Math.round(Number(record.measure));
      const offset = finiteOffset(record.offset);
      return Number.isFinite(part) && part >= 0 && Number.isFinite(measure) && measure >= 0
        && offset !== null && typeof record.text === "string"
        ? [{ type, part, measure, offset, text: record.text }]
        : [];
    }
    if (type === "ornament") {
      const part = Math.round(Number(record.part));
      const measure = Math.round(Number(record.measure));
      const offset = finiteOffset(record.offset);
      const kind = record.kind;
      const subdivision = Number(record.subdivision);
      return Number.isFinite(part) && part >= 0 && Number.isFinite(measure) && measure >= 0
        && offset !== null
        && (kind === "upper-mordent" || kind === "lower-mordent"
          || (kind === "trill" && [8, 16, 32, 64, 128].includes(subdivision)))
        ? [{ type, part, measure, offset, kind, ...(kind === "trill"
          ? { subdivision: subdivision as 8 | 16 | 32 | 64 | 128 }
          : {}) }]
        : [];
    }
    if (type === "slur") {
      const part = Math.round(Number(record.part));
      const from = record.from && typeof record.from === "object"
        ? record.from as Record<string, unknown> : null;
      const to = record.to && typeof record.to === "object"
        ? record.to as Record<string, unknown> : null;
      const fromMeasure = Math.round(Number(from?.measure));
      const toMeasure = Math.round(Number(to?.measure));
      const fromOffset = finiteOffset(from?.offset);
      const toOffset = finiteOffset(to?.offset);
      return Number.isFinite(part) && part >= 0
        && Number.isFinite(fromMeasure) && fromMeasure >= 0 && fromOffset !== null
        && Number.isFinite(toMeasure) && toMeasure >= fromMeasure && toOffset !== null
        ? [{ type, part, from: { measure: fromMeasure, offset: fromOffset },
          to: { measure: toMeasure, offset: toOffset } }]
        : [];
    }
    if (type === "triplet") {
      const part = Math.round(Number(record.part));
      const voice = Math.round(Number(record.voice));
      const measure = Math.round(Number(record.measure));
      const offset = finiteOffset(record.offset);
      const end = finiteOffset(record.end);
      const members = Array.isArray(record.members)
        ? record.members.flatMap((value) => {
          const duration = Number(value);
          return Number.isFinite(duration) && duration > 0
            ? [Math.round(duration * 192) / 192]
            : [];
        })
        : [];
      const restoreUnitValue = Number(record.restoreUnit);
      const restoreUnit = Number.isFinite(restoreUnitValue) && restoreUnitValue > 0
        ? Math.round(restoreUnitValue * 192) / 192
        : null;
      const scope = record.scope === "all" ? "all" : "voice";
      const memberRests = Array.isArray(record.memberRests)
        && record.memberRests.length === members.length
        && record.memberRests.every((value) => typeof value === "boolean")
        ? record.memberRests as boolean[] : undefined;
      const memberContinuations = Array.isArray(record.memberContinuations)
        && record.memberContinuations.length === members.length
        && record.memberContinuations.every((value) => typeof value === "boolean")
        ? record.memberContinuations as boolean[] : undefined;
      const ordinary: SlashOrdinaryTiming[] = Array.isArray(record.ordinary)
        ? record.ordinary.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const entry = item as Record<string, unknown>;
          const part = Number(entry.part);
          const offset = finiteOffset(entry.offset);
          const duration = finiteOffset(entry.duration);
          return Number.isInteger(part) && part >= 0 && part < MAX_SLASH_VOICES
            && offset !== null && duration !== null && duration > 0
            ? [{ part, offset, duration, rest: entry.rest === true }]
            : [];
        }) : [];
      return Number.isFinite(part) && part >= 0
        && Number.isFinite(voice) && voice >= 1 && voice <= MAX_SLASH_VOICES
        && Number.isFinite(measure) && measure >= 0 && offset !== null
        ? [{
          type, part, voice, measure, offset, scope,
          ...(end !== null && end > offset ? { end } : {}),
          ...(members.length > 0 ? { members } : {}),
          ...(memberRests ? { memberRests } : {}),
          ...(memberContinuations ? { memberContinuations } : {}),
          ...(restoreUnit !== null ? { restoreUnit } : {}),
          ...(ordinary.length > 0 ? { ordinary } : {}),
          ...(record.beatSlices === true ? { beatSlices: true } : {}),
        }]
        : [];
    }
    if (type === "cross-arpeggio") {
      const measure = Math.round(Number(record.measure));
      const offset = finiteOffset(record.offset);
      const parts = Array.isArray(record.parts)
        ? record.parts.flatMap((part) => Number.isFinite(Number(part)) && Number(part) >= 0 ? [Math.round(Number(part))] : [])
        : [];
      const pitches = Array.isArray(record.pitches)
        ? record.pitches.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const value = item as Record<string, unknown>;
          const part = Number(value.part); const pitch = Number(value.pitch);
          return Number.isFinite(part) && part >= 0 && Number.isFinite(pitch) ? [{ part: Math.round(part), pitch: Math.round(pitch) }] : [];
        })
        : [];
      return Number.isFinite(measure) && measure >= 0 && offset !== null
        && (record.direction === "up" || record.direction === "down")
        ? [{ type, measure, offset, parts, pitches, direction: record.direction }]
        : [];
    }
    return [];
  });
}

export interface SlashReadableDirectives {
  keyChanges: SlashKeyChange[];
  tempoMarks: SlashTempoMark[];
  annotations: NotationAnnotationData[];
}

function parseLocation(value: string): { measure: number; offset: number } | null {
  const match = /^(\d+)@([\d.]+)$/.exec(value.trim());
  if (!match) return null;
  const measure = Number(match[1]);
  const offset = finiteOffset(match[2]);
  return Number.isFinite(measure) && measure >= 1 && offset !== null
    ? { measure: Math.round(measure) - 1, offset } : null;
}

/** Parse human-readable @key/@tempo comments; m is one-based, beat is quarter offset. */
export function parseSlashReadableDirectives(text: string): SlashReadableDirectives {
  const keyChanges: SlashKeyChange[] = [];
  const tempoMarks: SlashTempoMark[] = [];
  const annotations: NotationAnnotationData[] = [];
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const key = /^\s*\/\/\s*@key\s+m=(\d+)\s+beat=([\d.]+)\s+1=([#♯b♭]?[A-G])\s*$/i.exec(raw);
    if (key) {
      const measure = Number(key[1]);
      const offset = finiteOffset(key[2]);
      const fifths = keyToFifths(key[3]);
      if (Number.isFinite(measure) && measure >= 1 && offset !== null && fifths !== null) {
        const item = { measure: measure - 1, offset, fifths };
        keyChanges.push(item);
        annotations.push({ type: "key", ...item });
      }
      continue;
    }
    const ramp = /^\s*\/\/\s*@tempo\s+(accel|rit)\s+from=(\d+@[\d.]+)\s+to=(\d+@[\d.]+)\s+target=([\d.]+)\s*$/i.exec(raw);
    if (ramp) {
      const from = parseLocation(ramp[2]);
      const to = parseLocation(ramp[3]);
      const targetBpm = Math.round(Number(ramp[4]) * 10) / 10;
      if (from && to && Number.isFinite(targetBpm) && targetBpm > 0) {
        const mode = ramp[1].toLowerCase() as "accel" | "rit";
        annotations.push({ type: "tempo-ramp", mode, from, to, targetBpm });
        tempoMarks.push({ measure: from.measure, offset: from.offset, kind: mode, bpm: null });
        tempoMarks.push({ measure: to.measure, offset: to.offset, kind: "tempo", bpm: targetBpm });
      }
      continue;
    }
    const set = /^\s*\/\/\s*@tempo\s+set\s+m=(\d+)\s+beat=([\d.]+)\s+bpm=([\d.]+)\s*$/i.exec(raw);
    if (set) {
      const measure = Number(set[1]);
      const offset = finiteOffset(set[2]);
      const bpm = Math.round(Number(set[3]) * 10) / 10;
      if (Number.isFinite(measure) && measure >= 1 && offset !== null && Number.isFinite(bpm) && bpm > 0) {
        const item = { measure: measure - 1, offset, kind: "tempo" as const, bpm };
        tempoMarks.push(item);
        annotations.push({ type: "tempo", measure: item.measure, offset, bpm });
      }
      continue;
    }
    const textMark = /^\s*\/\/\s*@text\s+part=(\d+)\s+m=(\d+)\s+beat=([\d.]+)\s+text=(.*)$/i.exec(raw);
    if (textMark) {
      const part = Number(textMark[1]);
      const measure = Number(textMark[2]);
      const offset = finiteOffset(textMark[3]);
      if (Number.isFinite(part) && part >= 0 && Number.isFinite(measure) && measure >= 1 && offset !== null) {
        annotations.push({ type: "text", part: Math.round(part), measure: Math.round(measure) - 1, offset, text: textMark[4] });
      }
    }
  }
  return { keyChanges, tempoMarks, annotations };
}

/** Serialize structured annotations as stable, human-readable comment lines. */
export function serializeSlashReadableDirectives(annotations: readonly NotationAnnotationData[]): string[] {
  return normalizeNotationAnnotations(annotations).map((annotation) => {
    if (annotation.type === "key") {
      return `// @key m=${annotation.measure + 1} beat=${annotation.offset} 1=${MusicCommon.keys[annotation.fifths + 7]}`;
    }
    if (annotation.type === "tempo") {
      return `// @tempo set m=${annotation.measure + 1} beat=${annotation.offset} bpm=${formatTempoBpm(annotation.bpm)}`;
    }
    if (annotation.type === "tempo-ramp") {
      const from = `${annotation.from.measure + 1}@${annotation.from.offset}`;
      const to = `${annotation.to.measure + 1}@${annotation.to.offset}`;
      return `// @tempo ${annotation.mode} from=${from} to=${to} target=${formatTempoBpm(annotation.targetBpm)}`;
    }
    if (annotation.type === "text") {
      return `// @text part=${annotation.part} m=${annotation.measure + 1} beat=${annotation.offset} text=${annotation.text}`;
    }
    return "";
  });
}

/**
 * Serialize score annotations as the human-facing comments placed beside the
 * affected measure.  The machine-readable @key/@tempo records stay in the
 * header metadata; these comments are deliberately plain text so they are
 * safe to edit without changing playback semantics.
 */
export function serializeSlashHumanDirectives(annotations: readonly NotationAnnotationData[]): string[] {
  const beatLabel = (offset: number): string => {
    const value = Math.round((offset + 1) * 1000) / 1000;
    return String(value);
  };
  return normalizeNotationAnnotations(annotations).flatMap((annotation) => {
    if (annotation.type === "key") {
      const key = keyName(annotation.fifths);
      return [`// \"第${annotation.measure + 1}小节第${beatLabel(annotation.offset)}拍转调到${key}\"`];
    }
    if (annotation.type === "meter") {
      return [`// \"第${annotation.measure + 1}小节起改为${annotation.beats}/${annotation.beatType}拍\"`];
    }
    if (annotation.type === "tempo") {
      return [`// \"第${annotation.measure + 1}小节第${beatLabel(annotation.offset)}拍速度为${formatTempoBpm(annotation.bpm)}BPM\"`];
    }
    if (annotation.type === "tempo-ramp") {
      const fromMeasure = annotation.from.measure + 1;
      const toMeasure = annotation.to.measure + 1;
      const direction = annotation.mode === "rit" ? "渐慢" : "渐快";
      return [
        `// \"第${fromMeasure}小节第${beatLabel(annotation.from.offset)}拍到第${toMeasure}小节第${beatLabel(annotation.to.offset)}拍${direction}到${formatTempoBpm(annotation.targetBpm)}BPM\"`,
      ];
    }
    return [];
  });
}

function directiveValue(text: string, label: string): string {
  const match = new RegExp(`^\\s*(?:${label})\\s*[=：:]\\s*(.*?)\\s*$`, "i").exec(text);
  return match?.[1]?.trim() ?? "";
}

function readDirectives(text: string): Directives {
  const hasKeyboardHeader = /(?:^|\n)\s*键盘谱\s*(?:\n|$)/i.test(text);
  const hasNumberHeader = /(?:^|\n)\s*数字谱\s*(?:\n|$)/i.test(text);
  const result: Directives = {
    kind: hasKeyboardHeader ? "keyboard" : hasNumberHeader ? "number" : null,
    keyboardKeyLabels: null,
    keyboardTieAsZero: null,
    keyboardHideTieLabels: null,
    voiceCount: null,
    instrumentName: "",
    beats: null,
    beatType: null,
    tempoBpm: null,
    tempoBeatUnit: null,
    fifths: null,
    title: "",
    subtitle: "",
    composer: "",
    arranger: "",
    lyricist: "",
    mappings: {},
    multiDurationSymbols: null,
    spaceDivision: undefined,
    noteDivision: undefined,
    wholeMeasureGroups: null,
    emptyGroupsAsRests: null,
    showExplicitRests: null,
    braceMode: null,
    bracketMode: null,
    barMode: null,
    angleMode: null,
    parenMode: null,
    ordering: "pitch-asc",
    tempoMarks: [],
    keyChanges: [],
    annotations: [],
    noteTimingEdits: [],
  };
  const readable = parseSlashReadableDirectives(text);
  result.keyChanges = readable.keyChanges;
  result.tempoMarks = readable.tempoMarks;
  result.annotations = readable.annotations;
  const meter = /(?:^|\n)\s*(\d{1,2})\s*\/\s*(2|4|8|16)\s*拍?/m.exec(text);
  if (meter) {
    result.beats = clamp(parseInt(meter[1], 10), 1, 32);
    result.beatType = parseInt(meter[2], 10);
  }
  const bpm = /(\d{1,3}(?:\.\d)?)\s*BPM/i.exec(text);
  if (bpm) {
    const tempoLine = text.slice(
      Math.max(0, text.lastIndexOf("\n", bpm.index) + 1),
      text.indexOf("\n", bpm.index) < 0 ? text.length : text.indexOf("\n", bpm.index),
    );
    result.tempoBeatUnit = /附点四分音符|dotted[\s-]*quarter/i.test(tempoLine)
      ? "dotted-quarter"
      : /八分音符|eighth/i.test(tempoLine) ? "eighth" : "quarter";
    result.tempoBpm = quarterBpmFromUnit(
      clamp(parseFloat(bpm[1]), 0.1, 999),
      result.tempoBeatUnit,
    );
  }
  const key = /1\s*=\s*([#♯b♭]?[A-G])/i.exec(text);
  if (key) result.fifths = keyToFifths(key[1]);

  for (const line of text.replace(/\r/g, "").split("\n")) {
    result.title ||= directiveValue(line, "标题|Title");
    result.subtitle ||= directiveValue(line, "副标题|SubTitle");
    result.composer ||= directiveValue(line, "作曲|Composer");
    result.arranger ||= directiveValue(line, "编曲|Arranger");
    result.lyricist ||= directiveValue(line, "作词|Lyricist");
    result.instrumentName ||= directiveValue(line, "乐器|Instrument");
    const space = /^\s*空格\s*[=：:]\s*(.*?)\s*$/.exec(line);
    if (space) result.spaceDivision = divisionFromText(space[1]);
    const note = /^\s*(?:音符|音)自身时值\s*[=：:]\s*(.*?)\s*$/.exec(line);
    if (note) result.noteDivision = divisionFromText(note[1]);
    const dot = /^\s*点(?:号)?\s*[=：:]\s*(.*?)\s*$/.exec(line);
    if (dot) {
      const division = divisionFromText(dot[1]);
      if (division) result.mappings["."] = division;
    }
    const doubleDot = /^\s*两个点\s*[=：:]\s*(.*?)\s*$/.exec(line);
    if (doubleDot) {
      const combined = divisionFromText(doubleDot[1]);
      if (combined && combined < 128) result.mappings["."] = (combined * 2) as SlashDurationDivision;
    }
    const symbol = /^\s*符号\s*[（(](.*?)[）)]\s*[=：:]\s*(.*?)\s*$/.exec(line);
    if (symbol) {
      const division = divisionFromText(symbol[2]);
      const glyph = symbol[1] === "空格" ? " " : Array.from(symbol[1])[0];
      if (division && glyph) {
        if (glyph === " ") result.spaceDivision = division;
        else result.mappings[glyph] = division;
      }
    }
    // New documents name the exact duration glyph directly, for example
    // `. = 16分音符` or `+ = 16分音符`. Keep the legacy
    // `点 = ...` / `符号(+) = ...` spellings above for old files, but do
    // not silently fall back to the default dot value when the precise form is
    // present. Chinese/alphanumeric directive names and `1 = C` are excluded.
    const literalSymbol = /^\s*([^\sA-Za-z0-9\u3400-\u9fff])\s*[=：:]\s*(.*?)\s*$/.exec(line);
    if (literalSymbol) {
      const division = divisionFromText(literalSymbol[2]);
      const glyph = Array.from(literalSymbol[1])[0];
      if (division && glyph) result.mappings[glyph] = division;
    }
    const groupMode = (label: string): SlashGroupMode | null => {
      if (!line.includes(label)) return null;
      // The assigned mode is authoritative. Exported explanations such as
      // “琶音（按滚奏和弦处理）” must not override it with a later keyword.
      // Keep the legacy whole-line reader for directives without assignment.
      const assignment = line.match(new RegExp(`^\\s*${label}\\s*[=：:]\\s*(.*)$`));
      const modeText = assignment?.[1].split(/[（(]/, 1)[0].trim() || line;
      if (/(?:留空|忽略|不使用|无特殊功能)/.test(modeText)) return "none";
      if (/(?:和弦|同时按)/.test(modeText)) return "chord";
      if (/倚音/.test(modeText)) return "grace";
      if (/琶音/.test(modeText)) return "arpeggio";
      if (/三连音/.test(modeText)) return "triplet";
      if (/颤音|\bTr\b/i.test(modeText)) return "trill";
      if (/(?:细分|计拍|最低)/.test(modeText)) return "subdivide";
      return null;
    };
    result.braceMode = groupMode("花括号") ?? result.braceMode;
    result.bracketMode = groupMode("方括号") ?? result.bracketMode;
    result.barMode = groupMode("竖线括号") ?? result.barMode;
    result.angleMode = groupMode("尖括号") ?? result.angleMode;
    result.parenMode = groupMode("圆括号") ?? result.parenMode;
  }
  const stored = /(?:^|\n)\s*\/\/\s*@jpeditor\s+(\{[^\n]*\})\s*(?:\n|$)/.exec(text);
  if (stored) {
    try {
      type Stored = Partial<SlashScoreOptions> & {
        vc?: number; i?: string;
        k?: "k" | "n"; n?: string; u?: string; c?: string; a?: string; l?: string;
        kl?: boolean; kz?: boolean; kh?: boolean;
        bpm?: number; f?: number; m?: [number, number]; s?: Record<string, SlashDurationDivision>;
        bu?: TempoBeatUnit;
        sp?: SlashDurationDivision | null; nd?: SlashDurationDivision | null;
        wg?: boolean;
        st?: boolean; ac?: boolean;
        ms?: boolean;
        er?: boolean;
        ri?: boolean;
        b?: "n" | "c" | "g" | "s" | "a" | "t" | "r"; q?: "n" | "c" | "g" | "s" | "a" | "t" | "r";
        vb?: "n" | "c" | "g" | "s" | "a" | "t" | "r";
        x?: "n" | "c" | "g" | "s" | "a" | "t" | "r";
        p?: "n" | "c" | "g" | "s" | "a" | "t" | "r";
        o?: MidiSlashOrdering;
        tm?: SlashTempoMark[];
        kc?: SlashKeyChange[];
        an?: unknown;
        ne?: NoteTimingEditData[];
        ht?: unknown;
      };
      const value = JSON.parse(stored[1]) as Stored;
      result.headerTypography = normalizeHeaderTypography(value.headerTypography ?? value.ht);
      const storedKind = value.kind ?? (value.k === "k" ? "keyboard" : value.k === "n" ? "number" : undefined);
      if (storedKind === "keyboard" || storedKind === "number") result.kind = storedKind;
      const storedKeyboardKeyLabels = value.keyboardKeyLabels ?? value.kl;
      if (typeof storedKeyboardKeyLabels === "boolean") {
        result.keyboardKeyLabels = storedKeyboardKeyLabels;
      }
      const storedKeyboardTieAsZero = value.keyboardTieAsZero ?? value.kz;
      if (typeof storedKeyboardTieAsZero === "boolean") {
        result.keyboardTieAsZero = storedKeyboardTieAsZero;
      }
      const storedKeyboardHideTieLabels = value.keyboardHideTieLabels ?? value.kh;
      if (typeof storedKeyboardHideTieLabels === "boolean") {
        result.keyboardHideTieLabels = storedKeyboardHideTieLabels;
      }
      const storedVoiceCount = value.voiceCount ?? value.vc;
      if (Number.isFinite(storedVoiceCount)) {
        result.voiceCount = clamp(Math.round(storedVoiceCount!), 1, MAX_SLASH_VOICES);
      }
      const storedBeats = value.beats ?? value.m?.[0];
      const storedBeatType = value.beatType ?? value.m?.[1];
      if (Number.isFinite(storedBeats) && storedBeats! >= 1) result.beats = clamp(Math.round(storedBeats!), 1, 32);
      if ([2, 4, 8, 16].includes(storedBeatType ?? 0)) result.beatType = storedBeatType!;
      const storedTempo = value.tempoBpm ?? value.bpm;
      const storedTempoUnit = value.tempoBeatUnit ?? value.bu;
      const storedFifths = value.fifths ?? value.f;
      if (Number.isFinite(storedTempo)) {
        result.tempoBpm = clamp(Math.round(storedTempo! * 10) / 10, 0.1, 999);
      }
      if (storedTempoUnit === "quarter"
        || storedTempoUnit === "dotted-quarter"
        || storedTempoUnit === "eighth") {
        result.tempoBeatUnit = storedTempoUnit;
      }
      if (Number.isFinite(storedFifths)) result.fifths = clamp(Math.round(storedFifths!), -7, 7);
      if (typeof (value.title ?? value.n) === "string") result.title = value.title ?? value.n ?? "";
      if (typeof (value.subtitle ?? value.u) === "string") result.subtitle = value.subtitle ?? value.u ?? "";
      if (typeof (value.composer ?? value.c) === "string") result.composer = value.composer ?? value.c ?? "";
      if (typeof (value.arranger ?? value.a) === "string") result.arranger = value.arranger ?? value.a ?? "";
      if (typeof (value.lyricist ?? value.l) === "string") result.lyricist = value.lyricist ?? value.l ?? "";
      if (typeof (value.instrumentName ?? value.i) === "string") {
        result.instrumentName = value.instrumentName ?? value.i ?? "";
      }
      const storedMappings = value.symbolDurations ?? value.s;
      if (storedMappings && typeof storedMappings === "object") {
        result.mappings = {};
        for (const [symbol, division] of Object.entries(storedMappings)) {
          if (symbol && DIVISIONS.includes(division as SlashDurationDivision)) result.mappings[symbol] = division as SlashDurationDivision;
        }
      }
      const storedMultiSymbols = value.multiDurationSymbols ?? value.ms;
      if (typeof storedMultiSymbols === "boolean") {
        result.multiDurationSymbols = storedMultiSymbols;
      }
      const storedSpace = value.spaceDivision !== undefined ? value.spaceDivision : value.sp;
      if (storedSpace === null || DIVISIONS.includes(storedSpace as SlashDurationDivision)) {
        result.spaceDivision = storedSpace as SlashDurationDivision | null;
      }
      const storedNote = value.noteDivision !== undefined ? value.noteDivision : value.nd;
      if (storedNote === null || DIVISIONS.includes(storedNote as SlashDurationDivision)) {
        result.noteDivision = storedNote as SlashDurationDivision | null;
      }
      const storedWholeMeasureGroups = value.wholeMeasureGroups ?? value.wg;
      const sourceTimedRows = value.sourceTimedRows ?? value.st;
      const adjacentAsChord = value.adjacentAsChord ?? value.ac;
      if (typeof sourceTimedRows === "boolean") result.sourceTimedRows = sourceTimedRows;
      if (typeof adjacentAsChord === "boolean") result.adjacentAsChord = adjacentAsChord;
      if (typeof storedWholeMeasureGroups === "boolean") {
        result.wholeMeasureGroups = storedWholeMeasureGroups;
      }
      const storedEmptyGroups = value.emptyGroupsAsRests ?? value.er;
      if (typeof storedEmptyGroups === "boolean") {
        result.emptyGroupsAsRests = storedEmptyGroups;
      }
      const storedExplicitRests = value.showExplicitRests ?? value.ri;
      if (typeof storedExplicitRests === "boolean") {
        result.showExplicitRests = storedExplicitRests;
      }
      const compactMode = (value: unknown): SlashGroupMode | undefined =>
        value === "n" ? "none"
          : value === "c" ? "chord"
          : value === "g" ? "grace"
          : value === "s" ? "subdivide"
              : value === "a" ? "arpeggio"
              : value === "t" ? "triplet"
                : value === "r" ? "trill"
                : undefined;
      const validMode = (value: unknown): value is SlashGroupMode =>
        value === "none" || value === "chord" || value === "grace" || value === "subdivide"
        || value === "arpeggio" || value === "triplet" || value === "trill";
      const storedBrace = value.braceMode ?? compactMode(value.b);
      const storedBracket = value.bracketMode ?? compactMode(value.q);
      const storedBar = value.barMode ?? compactMode(value.vb);
      const storedAngle = value.angleMode ?? compactMode(value.x);
      const storedParen = value.parenMode ?? compactMode(value.p);
      if (validMode(storedBrace)) result.braceMode = storedBrace;
      if (validMode(storedBracket)) result.bracketMode = storedBracket;
      if (validMode(storedBar)) result.barMode = storedBar;
      if (validMode(storedAngle)) result.angleMode = storedAngle;
      if (validMode(storedParen)) result.parenMode = storedParen;
      const storedOrdering = value.ordering ?? value.o;
      if (storedOrdering === "voice-asc" || storedOrdering === "voice-desc"
        || storedOrdering === "pitch-asc" || storedOrdering === "pitch-desc") {
        result.ordering = storedOrdering;
      }
      const storedTempoMarks = value.tempoMarks ?? value.tm;
      if (Array.isArray(storedTempoMarks)) {
        result.tempoMarks = storedTempoMarks.flatMap((mark) => {
          if (!mark || typeof mark !== "object") return [];
          const measure = Math.round(Number(mark.measure));
          const offset = Number(mark.offset);
          const kind = mark.kind;
          const bpm = mark.bpm === null
            ? null
            : Math.round(Number(mark.bpm) * 10) / 10;
          if (!Number.isFinite(measure) || measure < 0 || !Number.isFinite(offset) || offset < 0) return [];
          if (kind !== "accel" && kind !== "rit" && kind !== "tempo") return [];
          if (kind === "tempo" && (!Number.isFinite(bpm) || (bpm ?? 0) < 1)) return [];
          return [{ measure, offset, kind, bpm }];
        });
      }
      const storedKeyChanges = value.keyChanges ?? value.kc;
      if (Array.isArray(storedKeyChanges)) {
        result.keyChanges = storedKeyChanges.flatMap((change) => {
          if (!change || typeof change !== "object") return [];
          const measure = Math.round(Number(change.measure));
          const offset = finiteOffset(change.offset ?? 0);
          const fifths = Math.round(Number(change.fifths));
          if (!Number.isFinite(measure) || measure < 0) return [];
          if (offset === null) return [];
          if (!Number.isFinite(fifths) || fifths < -7 || fifths > 7) return [];
          return [{ measure, offset, fifths }];
        });
      }
      if (Object.prototype.hasOwnProperty.call(value, "annotations")) {
        result.annotations = normalizeNotationAnnotations(value.annotations ?? value.an);
      } else if (Object.prototype.hasOwnProperty.call(value, "an")) {
        result.annotations = normalizeNotationAnnotations(value.an);
      }
      result.noteTimingEdits = normalizeNoteTimingEdits(value.noteTimingEdits ?? value.ne);
    } catch {
      // A damaged settings comment is ordinary ignored text; natural-language directives still work.
    }
  }
  return result;
}

function detectKind(text: string, lines: SourceLines, directive: Directives): SlashScoreKind {
  if (directive.kind) return directive.kind;
  const joined = lines.score.join("\n").replace(LINE_TAG_RE, "");
  const keyboardCount = (joined.match(/[A-Z]/g) ?? []).length;
  const numberCount = (joined.match(/[1-7]/g) ?? []).length;
  if (/键盘/i.test(text)) return "keyboard";
  if (/数字/i.test(text)) return "number";
  return keyboardCount > numberCount ? "keyboard" : "number";
}

function observedSymbols(lines: string[], kind?: SlashScoreKind): { symbols: string[]; spaces: boolean } {
  const found = new Set<string>();
  let spaces = false;
  for (const line of lines) {
    const hasDurationMinus = kind === "keyboard" && line.split("/")
      .some(group => group.includes("-") && !/^\s*-\s*$/.test(group));
    for (const char of Array.from(line)) {
      if (char === " ") { spaces = true; continue; }
      if (/\s/.test(char)) continue;
      if (char === SLASH_VOICE_SEPARATOR) continue;
      if (kind === "keyboard" && (char === "+" || char === "-")) {
        // A whole rest slash group is not a duration symbol.
        if (char !== "-" || hasDurationMinus) found.add(char);
        continue;
      }
      if (/[A-Za-z0-9+\-#♭♯/(){}<>|[\],']/.test(char)) continue;
      found.add(char);
    }
  }
  return { symbols: [...found], spaces };
}

function defaultDivisionForSymbol(symbol: string): SlashDurationDivision {
  if (symbol === "." || symbol === "=") return 8;
  if (symbol === "_") return 16;
  if (symbol === "*") return 32;
  if (symbol === "~") return 64;
  return 16;
}

function effectiveMappings(
  options: Pick<SlashScoreOptions, "symbolDurations" | "spaceDivision">
    & Partial<Pick<SlashScoreOptions, "multiDurationSymbols">>,
): Record<string, SlashDurationDivision> {
  const entries = Object.entries(options.symbolDurations);
  const enabled = options.multiDurationSymbols === false ? entries.slice(0, 1) : entries;
  const mappings = Object.fromEntries(enabled) as Record<string, SlashDurationDivision>;
  for (const reserved of ["{", "}", "[", "]", "<", ">", "|", "(", ")"]) {
    delete mappings[reserved];
  }
  // Tab is a formatting separator, including in legacy options comments.
  delete mappings["\t"];
  if (options.spaceDivision) mappings[" "] = options.spaceDivision;
  else delete mappings[" "];
  return mappings;
}

type SlashDelimiterModes = Pick<SlashScoreOptions, "braceMode" | "bracketMode"
  | "barMode" | "angleMode" | "parenMode">;

interface SlashDelimiterSpec {
  id: SlashDelimiterId;
  open: string;
  close: string;
  mode: SlashGroupMode;
}

function slashDelimiterSpecs(options: SlashDelimiterModes): SlashDelimiterSpec[] {
  return [
    { id: "bar", open: "|", close: "|", mode: options.barMode ?? "none" },
    { id: "brace", open: "{", close: "}", mode: options.braceMode },
    { id: "bracket", open: "[", close: "]", mode: options.bracketMode ?? "triplet" },
    { id: "angle", open: "<", close: ">", mode: options.angleMode ?? "grace" },
    { id: "paren", open: "(", close: ")", mode: options.parenMode ?? "chord" },
  ];
}

export function slashUsesBareChords(options: SlashDelimiterModes): boolean {
  return !slashDelimiterSpecs(options).some(spec => spec.mode === "chord");
}

function slashDelimiterAt(
  text: string,
  index: number,
  options: SlashDelimiterModes,
): SlashDelimiterSpec | null {
  // Files written before the single-bar spelling used `||A||`. Check the
  // legacy token first so the new one-character delimiter cannot consume its
  // first half as an empty container.
  if (text.startsWith("||", index)) {
    return { id: "bar", open: "||", close: "||", mode: options.barMode ?? "none" };
  }
  return slashDelimiterSpecs(options).find((spec) => text.startsWith(spec.open, index)) ?? null;
}

function slashContainerAt(
  text: string,
  index: number,
  options: SlashDelimiterModes,
): { spec: SlashDelimiterSpec; bodyFrom: number; bodyTo: number; end: number } | null {
  const first = slashDelimiterAt(text, index, options);
  if (!first) return null;
  const stack: SlashDelimiterSpec[] = [first];
  let cursor = index + first.open.length;
  while (cursor < text.length) {
    const top = stack[stack.length - 1];
    if (text.startsWith(top.close, cursor)) {
      stack.pop();
      const end = cursor + top.close.length;
      if (stack.length === 0) {
        return { spec: first, bodyFrom: index + first.open.length, bodyTo: cursor, end };
      }
      cursor = end;
      continue;
    }
    const nested = slashDelimiterAt(text, cursor, options);
    if (nested) {
      stack.push(nested);
      cursor += nested.open.length;
      continue;
    }
    cursor++;
  }
  return null;
}

/**
 * A finest-grid mordent is written as an outer subdivision container holding
 * an inner triplet container, for example `[{(AB)NB}]`. Return the inner body
 * only when the complete outer body has exactly that shape; ordinary nested
 * grace/arpeggio spelling must remain untouched.
 */
function nestedSubdivisionTripletBody(
  body: string,
  options: SlashDelimiterModes,
): { body: string; from: number; to: number } | null {
  let from = 0;
  let to = body.length;
  while (from < to && /\s/.test(body[from])) from++;
  while (to > from && /\s/.test(body[to - 1])) to--;
  const container = slashContainerAt(body, from, options);
  if (!container || container.end !== to || container.spec.mode !== "triplet") return null;
  return {
    body: body.slice(container.bodyFrom, container.bodyTo),
    from: container.bodyFrom,
    to: container.bodyTo,
  };
}

/**
 * Nested timing is also the compact TXT spelling used for a wave ornament:
 * `<[DFD]>` is one D with an upper mordent, not three timed notes.  Recognise
 * only the closed three-pitch ABA shape so ordinary nested triplets keep their
 * real duration and remain editable as three independent attacks.
 */
function nestedMordentBody(
  body: string,
  options: SlashScoreOptions,
  part?: number,
): { pitch: number; kind: "upper-mordent" | "lower-mordent" } | null {
  const nested = nestedSubdivisionTripletBody(body, {
    braceMode: options.braceMode,
    bracketMode: options.bracketMode,
    barMode: options.barMode,
    angleMode: options.angleMode,
    parenMode: options.parenMode,
  });
  if (!nested) return null;
  return directMordentBody(nested.body, options, part);
}

/** New compact wave spelling: the triplet container itself holds three
 * tightly attached ABA pitches (`[ASA]`).  Their one-level-finer member value
 * is supplied by adjacency; an ordinary marker after the container declares
 * the duration of the decorated main note (`[ASA].`). */
function directMordentBody(
  body: string,
  options: SlashScoreOptions,
  part?: number,
): { pitch: number; kind: "upper-mordent" | "lower-mordent" } | null {
  const pitchesForVoice = (text: string, voice: number): number[] => {
    const pitches: number[] = [];
    for (let index = 0; index < text.length;) {
      if (text[index] === SLASH_VOICE_SEPARATOR) {
        let after = index;
        while (text[after] === SLASH_VOICE_SEPARATOR) after++;
        const markerCount = after - index;
        const token = pitchAt(text, after, options);
        if (token) {
          if (clamp(markerCount, 1, options.voiceCount) - 1 === voice) pitches.push(token.pitch);
          index = token.next;
          continue;
        }
        index = after;
        continue;
      }
      const token = pitchAt(text, index, options);
      if (token) {
        if (options.voiceCount - 1 === voice) pitches.push(token.pitch);
        index = token.next;
        continue;
      }
      index++;
    }
    return pitches;
  };
  let pitches: number[];
  if (part === undefined) {
    pitches = pitchesIn(body, options);
  } else {
    const atoms: number[][] = [];
    for (let index = 0; index < body.length;) {
      const container = slashContainerAt(body, index, options);
      if (container) {
        if (container.spec.mode === "chord") {
          atoms.push(pitchesForVoice(body.slice(container.bodyFrom, container.bodyTo), part));
        }
        index = container.end;
        continue;
      }
      if (body[index] === SLASH_VOICE_SEPARATOR) {
        let after = index;
        while (body[after] === SLASH_VOICE_SEPARATOR) after++;
        const markerCount = after - index;
        const token = pitchAt(body, after, options);
        if (token) {
          atoms.push(clamp(markerCount, 1, options.voiceCount) - 1 === part ? [token.pitch] : []);
          index = token.next;
          continue;
        }
        index = after;
        continue;
      }
      const token = pitchAt(body, index, options);
      if (token) {
        atoms.push(options.voiceCount - 1 === part ? [token.pitch] : []);
        index = token.next;
        continue;
      }
      index++;
    }
    if (atoms.length !== 3 || atoms[1]?.length !== 1 || atoms[2]?.length !== 1) return null;
    const target = atoms[2]![0]!;
    if (!atoms[0]?.includes(target)) return null;
    pitches = [target, atoms[1]![0]!, target];
  }
  if (pitches.length !== 3 || pitches[0] !== pitches[2] || pitches[1] === pitches[0]) return null;
  return {
    pitch: pitches[0]!,
    kind: pitches[1]! > pitches[0]! ? "upper-mordent" : "lower-mordent",
  };
}

/** Preserve the complete simultaneous first atom of a semantic mordent. The
 * decorated voice may share that column with another voice in a chord; only
 * the two later ABA helper atoms are non-sounding. */
function firstMordentAtom(
  body: string,
  options: SlashScoreOptions,
): { from: number; to: number; pitches: number[] } | null {
  const mappings = effectiveMappings(options);
  let index = 0;
  while (index < body.length && (/\s/.test(body[index]!) || mappings[body[index]!] !== undefined)) index++;
  const container = slashContainerAt(body, index, options);
  if (container?.spec.mode === "chord") {
    return {
      from: index,
      to: container.end,
      pitches: pitchesIn(body.slice(container.bodyFrom, container.bodyTo), options),
    };
  }
  const from = index;
  while (body[index] === SLASH_VOICE_SEPARATOR) index++;
  const token = pitchAt(body, index, options);
  return token ? { from, to: token.next, pitches: [token.pitch] } : null;
}

/** Only metadata-owned ABA helpers collapse to one attack inside a shared tuplet. */
function semanticMordentAtom(body: string, options: SlashScoreOptions): ReturnType<typeof firstMordentAtom> {
  const owned = options.annotations?.some((annotation) => {
    if (annotation.type !== "ornament"
      || (annotation.kind !== "upper-mordent" && annotation.kind !== "lower-mordent")) return false;
    return directMordentBody(body, options, annotation.part)?.kind === annotation.kind;
  });
  return owned ? firstMordentAtom(body, options) : null;
}

/** Return the one explicitly marked non-default voice owning every timed atom
 * in a container. Such a container is a parallel voice lane: its duration
 * starts at the current shared cursor but must not push the default voice to
 * the right. A single unmarked pitch/rest makes the container shared. */
function explicitTimedContainerVoice(
  text: string,
): number | null {
  const voices: number[] = [];
  let pendingMarkers = 0;
  for (let index = 0; index < text.length;) {
    if (text[index] === SLASH_VOICE_SEPARATOR) {
      let after = index;
      while (text[after] === SLASH_VOICE_SEPARATOR) after++;
      pendingMarkers = after - index;
      index = after;
      continue;
    }
    if (/\s/.test(text[index] ?? "")) {
      index++;
      continue;
    }
    if (text[index] === "0") {
      if (pendingMarkers <= 0) return null;
      voices.push(pendingMarkers - 1);
      pendingMarkers = 0;
      index++;
      continue;
    }
    if (/[A-Z1-7]/.test(text[index])) {
      if (pendingMarkers <= 0) return null;
      voices.push(pendingMarkers - 1);
      pendingMarkers = 0;
      index++;
      continue;
    }
    index++;
  }
  if (voices.length === 0 || voices.some((voice) => voice !== voices[0])) return null;
  return voices[0];
}

/**
 * A normal unmarked pitch belongs to the final/default TXT voice. Inside a
 * voice-local timed container that absence is ambiguous with an all-voice
 * container, so generated text uses exactly `voiceCount` separators as an
 * internal explicit-default sentinel. Pitch parsing already clamps that run
 * back to the final voice; persisted @jpeditor metadata retains the real vc.
 */
function explicitDefaultTimedToken(token: string, voiceCount: number): string {
  const marker = SLASH_VOICE_SEPARATOR.repeat(voiceCount);
  return token.replace(
    /(\u2063*)((?:[#♯b♭]*[,+']*|[#♯b♭]*[+-]*)[A-Z0-7])/g,
    (whole, existing: string, pitch: string) => existing ? whole : marker + pitch,
  );
}

function segmentMarkerDuration(
  segment: string,
  mappings: Record<string, SlashDurationDivision>,
  braceMode: SlashBraceMode,
  noteDivision: SlashDurationDivision | null = null,
  bracketMode: SlashGroupMode = "triplet",
  extraModes: Partial<Pick<SlashScoreOptions, "barMode" | "angleMode" | "parenMode" | "annotations">>
    & { durationMeasure?: number; durationOffset?: number } = {},
  parallelGroupLimit?: number,
  semanticMordent = false,
  voiceCountHint?: number,
  sequentialTuplets = false,
  fillUnvaluedTail = true,
): number {
  let duration = 0;
  const pitchKind: SlashScoreKind = /[A-Z]/.test(segment) ? "keyboard" : "number";
  let parallelEnd = 0;
  let lastPitchEnd = -1;
  let trailingUnvaluedMain = false;
  const finest = Math.max(4, noteDivision ?? 4, ...Object.values(mappings));
  const minimumUnit = 4 / finest;
  const braceUnit = Math.max(4 / 128, minimumUnit / 2);
  const noteUnit = noteDivision ? 4 / noteDivision : 0;
  const modes: SlashDelimiterModes = {
    braceMode,
    bracketMode,
    barMode: extraModes.barMode,
    angleMode: extraModes.angleMode,
    parenMode: extraModes.parenMode,
  };
  const inferredVoiceCount = voiceCountHint ?? Math.max(1, ...[...segment.matchAll(/\u2063+/g)]
    .map((match) => compactMarkerBaseCount(match[0].length) + 1));
  const durationPitchOptions = {
    annotations: extraModes.annotations,
    symbolDurations: mappings,
    noteDivision: null,
    braceMode,
    bracketMode,
    barMode: extraModes.barMode,
    angleMode: extraModes.angleMode,
    parenMode: extraModes.parenMode,
    voiceCount: inferredVoiceCount,
    fifths: 0,
    kind: pitchKind,
  } as SlashScoreOptions;
  for (let index = 0; index < segment.length;) {
    const char = segment[index];
    const container = slashContainerAt(segment, index, modes);
    if (container) {
      const content = segment.slice(container.bodyFrom, container.bodyTo);
      const mode = container.spec.mode;
      if (mode === "chord") {
        const atom = compactTimedAtomAt(segment, index, durationPitchOptions)!;
        const nextAtom = adjacentCompactTimedAtomAfter(segment, atom.next, durationPitchOptions);
        const hasFollowingDuration = mappings[segment[atom.next] ?? ""] !== undefined;
        const implicitGrace = implicitGraceFollowerAt(
          segment,
          atom,
          { ...durationPitchOptions, noteDivision },
        ) !== null;
        if (noteUnit > 0 && /[A-Z1-7]|0/.test(content)) duration += noteUnit;
        else if (!implicitGrace && !hasFollowingDuration) {
          if (nextAtom) duration += minimumUnit;
          else trailingUnvaluedMain = true;
        }
        lastPitchEnd = atom.next;
        index = container.end;
        continue;
      }
      lastPitchEnd = -1;
      // A semantic mordent is serialized as `<[ABA]>.`: the nested helper
      // group is only the ornament spelling and the following ordinary mark
      // supplies its one-cell duration.  Count the wrapper as zero here, but
      // retain the legacy implicit-cell behavior for old `<[ABA]>N` text.
      const directMordentShape = mode === "triplet"
        && (() => {
          const pitches = content.split(SLASH_VOICE_SEPARATOR).join("")
            .match(/[A-Z1-7]/g) ?? [];
          const target = pitches[pitches.length - 1];
          const neighbour = pitches[pitches.length - 2];
          return pitches.length >= 3 && target !== neighbour
            && pitches.slice(0, -2).includes(target!);
        })();
      const nestedMordentShape = mode === "subdivide"
        && nestedSubdivisionTripletBody(content, modes) !== null
        && (() => {
          const pitches = content.split(SLASH_VOICE_SEPARATOR).join("")
            .match(/[A-Z1-7]/g) ?? [];
          return pitches.length >= 3 && pitches[0] === pitches[pitches.length - 1];
        })();
      const hasFollowingDuration = mappings[segment[container.end] ?? ""] !== undefined;
      if (semanticMordent && (directMordentShape || nestedMordentShape) && hasFollowingDuration) {
        index = container.end;
        continue;
      }
      // Use the same atom parser as the real score conversion for Triplets.
      // It understands mixed compact values such as `[01.]` and `[1.0]`;
      // duplicating that grammar here made diagnostics disagree with the
      // rendered score whenever an explicit value touched one fine cell.
      const nominal = mode === "triplet"
        ? timedContainerAtoms(content, {
          ...durationPitchOptions,
          noteDivision,
        }, minimumUnit, Array.from(
          { length: inferredVoiceCount },
          (_unused, voice) => voice,
        )).reduce((sum, atom) => sum + atom.nominalDuration, 0)
        : segmentMarkerDuration(
          content,
          mappings,
          braceMode,
          noteDivision,
          bracketMode,
          extraModes,
          undefined,
          false,
          inferredVoiceCount,
        );
      const atomCount = braceAtomsText(content, modes).length;
      let containerDuration = 0;
      if (mode === "triplet") {
        // With intrinsic timing the bracket is one timed unit. Its members
        // describe relative weights, not additional ordinary note values.
        containerDuration = noteUnit > 0 && atomCount > 0
          ? noteUnit
          : (nominal > 1e-8 ? nominal : atomCount * braceUnit) * 2 / 3;
      } else if (mode === "subdivide") {
        // An angle container around a triplet (`<[...]>`) has two nested
        // timing transforms: the inner 3:2 group occupies 2/3 of its
        // ordinary span, then the outer subdivision halves that span.  The
        // old fallback counted `braceAtomsText(content)` (which deliberately
        // does not flatten a triplet container), producing zero and making
        // the following atoms appear to be short by a quarter.  Calculate the
        // inner nominal atom span explicitly, preserving the selected TXT
        // grid (including an internal 128th subdivision).
        const nestedTriplet = nestedSubdivisionTripletBody(content, modes);
        const nestedAtomCount = nestedTriplet
          ? braceAtomsText(nestedTriplet.body, modes).length
          : 0;
        // A nested triplet is made from the next finer binary cell. When an
        // intrinsic TXT note value exists, use half of that value for each
        // member; otherwise `braceUnit` already is the finer cell.
        const nestedMemberUnit = noteUnit > 0 ? noteUnit / 2 : braceUnit;
        const innerSpan = nestedTriplet
          ? nestedAtomCount * nestedMemberUnit * 2 / 3
          : 0;
        // The inner 3:2 group already supplies the finer member grid.  The
        // outer angle is a notation container, not another temporal halving:
        // three finer members occupy one ordinary base cell (2/3 of their
        // nominal span).  Dividing `innerSpan` again was the source of the
        // 0.75-beat diagnostics for `<[ASA]>`.
        containerDuration = noteUnit > 0 && nestedAtomCount > 0
          ? noteUnit
          : innerSpan > 1e-8
          ? innerSpan
          : timedContainerAtoms(content, {
            ...durationPitchOptions, noteDivision,
          }, braceUnit).reduce((sum, atom) => sum + atom.nominalDuration, 0) / 2;
      } else if (mode === "none") {
        containerDuration = nominal > 1e-8 ? nominal : atomCount * braceUnit;
      }
      const parallelVoice = (mode === "triplet" || mode === "subdivide")
        ? explicitTimedContainerVoice(content)
        : null;
      const isParallel = inferredVoiceCount > 1 && parallelVoice !== null && !sequentialTuplets;
      let containerEnd = container.end;
      const metadataTiming = extraModes.annotations?.some((annotation) => annotation.type === "triplet"
        && annotation.end !== undefined && (annotation.members?.length ?? 0) > 0
        && (extraModes.durationMeasure === undefined || annotation.measure === extraModes.durationMeasure)
        && Math.abs(annotation.offset - ((extraModes.durationOffset ?? 0) + duration)) <= 1 / 192
        && (parallelVoice === null || annotation.scope === "all" || annotation.part === parallelVoice));
      const intrinsicTriplet = mode === "triplet"
        || mode === "subdivide" && nestedSubdivisionTripletBody(content, modes) !== null;
      if (isParallel && intrinsicTriplet && noteUnit > 0 && containerDuration > 1e-8 && !metadataTiming) {
        while (mappings[segment[containerEnd] ?? ""] !== undefined) {
          containerDuration += 4 / mappings[segment[containerEnd]!]!;
          containerEnd++;
        }
      }
      if (isParallel) {
        parallelEnd = Math.max(parallelEnd, duration + containerDuration);
      } else {
        duration += containerDuration;
      }
      // Grace notes and arpeggio signs decorate an adjacent sounding event;
      // their own contents do not lengthen the measure.
      index = containerEnd;
      continue;
    }
    if (char === SLASH_VOICE_SEPARATOR) {
      let after = index;
      while (segment[after] === SLASH_VOICE_SEPARATOR) after++;
      duration += compactMarkerPaddingCells(after - index) * minimumUnit;
      if (lastPitchEnd === index) {
        lastPitchEnd = after;
      } else {
        lastPitchEnd = -1;
      }
      index = after;
      continue;
    }
    const bare = bareChordAt(segment, index, durationPitchOptions);
    if (bare) {
      if (noteUnit > 0) duration += noteUnit;
      else if (mappings[segment[bare.next] ?? ""] === undefined) trailingUnvaluedMain = true;
      lastPitchEnd = bare.next;
      index = bare.next;
      continue;
    }
    // Without an intrinsic note value, tightly attached pitched atoms are
    // grace notes for the final pitched atom. Rests never become grace notes;
    // adjacent ordinary atoms use the configured minimum value, not a hidden
    // one-level-finer grid.
    if (noteDivision === null) {
      const atom = compactTimedAtomAt(segment, index, durationPitchOptions);
      if (atom) {
        const nextAtom = adjacentCompactTimedAtomAfter(segment, atom.next, durationPitchOptions);
        const hasFollowingDuration = mappings[segment[atom.next] ?? ""] !== undefined;
        const implicitGrace = implicitGraceFollowerAt(
          segment,
          atom,
          { ...durationPitchOptions, noteDivision },
        ) !== null;
        if (!implicitGrace && !hasFollowingDuration) {
          if (nextAtom) duration += minimumUnit;
          else trailingUnvaluedMain = true;
        }
        lastPitchEnd = atom.next;
        index = atom.next;
        continue;
      }
    }
    const division = mappings[char];
    if (division) {
      duration += 4 / division;
      trailingUnvaluedMain = false;
      lastPitchEnd = -1;
    }
    else if (noteUnit > 0 && char === "0") {
      duration += noteUnit;
    }
    else if (noteUnit > 0 && /[A-Z1-7]/.test(char)) {
      duration += noteUnit;
    }
    else {
      lastPitchEnd = -1;
    }
    index++;
  }
  if (trailingUnvaluedMain && fillUnvaluedTail) {
    duration = parallelGroupLimit !== undefined
      ? Math.max(duration, parallelGroupLimit)
      : duration + minimumUnit;
  }
  const combined = Math.max(duration, parallelEnd);
  // A separately marked upper voice may legitimately sustain across the next
  // slash boundary while the default voice completes this beat. At the
  // diagnostic call site, cap that parallel lane at the current slash group;
  // the parser keeps the real cross-boundary end and the measure guard in the
  // input command still prevents a tuplet from crossing a barline.
  return parallelGroupLimit !== undefined && parallelEnd > 1e-8
    ? Math.max(duration, Math.min(parallelGroupLimit, parallelEnd))
    : combined;
}

/** Count timed atoms without needing key/fifths conversion. */
function braceAtomsText(
  text: string,
  options: SlashDelimiterModes = {
    braceMode: "arpeggio",
    bracketMode: "triplet",
    barMode: "none",
    angleMode: "grace",
    parenMode: "chord",
  },
): string[] {
  const atoms: string[] = [];
  for (let index = 0; index < text.length;) {
    const container = slashContainerAt(text, index, options);
    if (container) {
      const body = text.slice(container.bodyFrom, container.bodyTo);
      if (container.spec.mode === "chord" && /[A-Z1-7]/.test(body)) {
        atoms.push(text.slice(index, container.end));
      }
      index = container.end;
      continue;
    }
    if (/[A-Z1-7]/.test(text[index]) || text[index] === "0") atoms.push(text[index]);
    index++;
  }
  return atoms;
}

function splitGroups(line: string): string[] {
  const groups = line.split("/");
  // Only discard the literal empty field created by a closing slash. A field
  // containing spaces can be a complete rhythmic group when space has a
  // configured duration and must survive import/rewrite round trips.
  while (groups.length > 0 && groups[groups.length - 1] === "") groups.pop();
  return groups;
}

function groupsForMeter(meter: SlashMeterSuggestion): number {
  // `/` separates beat groups. Compound meters group three eighth notes into
  // one dotted-quarter beat; simple meters use one group per written beat.
  // Do not derive this count from how many duration marks happen to follow a
  // note: a short note plus silence still occupies its complete slash group.
  return meter.beatType === 8 && meter.beats >= 6 && meter.beats % 3 === 0 ? meter.beats / 3 : meter.beats;
}

const COMMON_SLASH_METERS = new Set(["4/4", "3/4", "2/4", "6/8", "3/8", "9/8", "12/8", "2/2", "3/2"]);

function meterFromEvidence(
  groupCounts: number[], durations: number[], directive: Pick<Directives, "beats" | "beatType">,
): SlashMeterSuggestion {
  const groupsPerMeasure = mode(groupCounts, 4);
  const groupQuarterNotes = median(durations) || 1;
  if (directive.beats && directive.beatType) return {
    beats: directive.beats, beatType: directive.beatType, groupsPerMeasure, groupQuarterNotes,
    explicit: true, requiresInput: false,
  };
  const total = groupQuarterNotes * groupsPerMeasure;
  let best = { beats: 4, beatType: 4, score: Infinity };
  for (const beatType of [4, 8, 16, 2]) for (let beats = 1; beats <= 32; beats++) {
    const measure = beats * 4 / beatType;
    const expectedGroups = beatType === 8 && beats >= 6 && beats % 3 === 0 ? beats / 3 : beats;
    let score = Math.abs(measure - total) * 20 + Math.abs(expectedGroups - groupsPerMeasure) * 1.5;
    if (!COMMON_SLASH_METERS.has(`${beats}/${beatType}`)) score += 4;
    if (beatType === 4 && Math.abs(groupQuarterNotes - 1) < .08 && beats === groupsPerMeasure) score -= 4;
    if (beatType === 8 && beats >= 6 && beats % 3 === 0 && Math.abs(groupQuarterNotes - 1.5) < .08 && beats === groupsPerMeasure * 3) score -= 6;
    if (beatType === 8 && Math.abs(groupQuarterNotes - .5) < .08 && beats === groupsPerMeasure) score -= 4;
    if (score < best.score) best = { beats, beatType, score };
  }
  const suggestion = { beats: best.beats, beatType: best.beatType, groupsPerMeasure, groupQuarterNotes, explicit: false };
  const expectedGroups = groupsForMeter(suggestion);
  const target = best.beats * 4 / best.beatType / Math.max(1, expectedGroups);
  const matching = durations.filter(duration => Math.abs(duration - target) < .08).length;
  return { ...suggestion, requiresInput: !durations.length
    || !COMMON_SLASH_METERS.has(`${best.beats}/${best.beatType}`)
    || expectedGroups !== groupsPerMeasure
    || matching / durations.length < .55 };
}

/** Infer only from assigned containers. An unknown bracket is a pending user
 * choice, not evidence that its contents are triplets or simultaneous notes. */
function importTimingGroups(lines: string[], modes: SlashDelimiterModes): string[] {
  const unknown = slashDelimiterSpecs(modes).filter(spec => spec.mode === "none");
  return lines.flatMap(splitGroups).filter(group => !unknown.some(spec =>
    group.includes(spec.open) || group.includes(spec.close)));
}

function inferImportTiming(
  lines: string[], mappings: Record<string, SlashDurationDivision>, directive: Directives,
  modes: SlashDelimiterModes,
): { mappings: Record<string, SlashDurationDivision>; noteDivision: SlashDurationDivision | null;
  spaceDivision: SlashDurationDivision | null; meter: SlashMeterSuggestion; ambiguous?: boolean } | null {
  const groups = importTimingGroups(lines, modes);
  if (!groups.length) return null;
  const groupCounts = lines.map(line => splitGroups(line).length).filter(count => count > 0);
  const hasSpaces = groups.some(group => group.includes(" "));
  const symbols = Object.keys(mappings);
  const hasSymbols = symbols.length > 0;
  // Beyond three independent units the notation is under-constrained for a
  // small bounded search. Keep these actual symbols visible for manual input.
  if (symbols.length > 3) return null;
  const divisions: SlashDurationDivision[] = [4, 8, 16, 32, 64];
  const notes: Array<SlashDurationDivision | null> = hasSymbols ? [null, ...divisions] : divisions;
  const spaces: Array<SlashDurationDivision | null> = hasSpaces ? [null, ...divisions] : [null];
  let best: { score: number; evidence: number; result: NonNullable<ReturnType<typeof inferImportTiming>> } | null = null;
  const candidates: Array<{ evidence: number; result: NonNullable<ReturnType<typeof inferImportTiming>> }> = [];
  const assignments: Array<Record<string, SlashDurationDivision>> = [];
  const enumerate = (index: number, values: Record<string, SlashDurationDivision>): void => {
    if (index === symbols.length) { assignments.push({ ...values }); return; }
    for (const division of divisions) enumerate(index + 1, { ...values, [symbols[index]]: division });
  };
  enumerate(0, {});
  const shapes = new Map<string, number>();
  for (const group of groups) {
    const shape = group.replace(/[A-Z1-7]/g, "A");
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
  }
  for (const shifted of assignments) {
    for (const noteDivision of notes) for (const spaceDivision of spaces) {
      const effective = effectiveMappings({ symbolDurations: shifted, spaceDivision });
      const durations = [...shapes].flatMap(([group, count]) => {
        const duration = segmentMarkerDuration(group, effective, modes.braceMode,
          noteDivision, modes.bracketMode ?? "none", modes);
        return Array.from({ length: count }, () => duration);
      });
      const positive = durations.filter(duration => duration > 1e-8);
      const meter = meterFromEvidence(groupCounts, positive, directive);
      const expectedGroups = groupsForMeter(meter);
      const target = meter.beats * 4 / meter.beatType / Math.max(1, expectedGroups);
      const errors = durations.map(duration => Math.abs(duration - target) / target).sort((a, b) => a - b);
      // A few unfinished or irregular groups must not outweigh many exact
      // beats. Retain their diagnostics after choosing the dominant grid.
      const reliable = errors.slice(0, Math.max(1, Math.ceil(errors.length * .85)));
      let score = reliable.reduce((sum, error) => sum + Math.min(2, error), 0) / reliable.length * 20;
      score += Math.abs(expectedGroups - mode(groupCounts, 4)) * 3;
      if (!COMMON_SLASH_METERS.has(`${meter.beats}/${meter.beatType}`)) score += 6;
      if (meter.requiresInput) score += 8;
      // Equivalent grid scales favour ordinary quarter-note meters before
      // half-note or short-eighth alternatives (3/4 before 3/2 or 3/8).
      if (meter.beatType !== 4) score += .25;
      const evidence = score;
      if (noteDivision !== null && hasSymbols) score += .5;
      if (spaceDivision !== null) score += .15;
      if (noteDivision !== null && spaceDivision !== null && noteDivision !== spaceDivision) score += .2;
      score += symbols.reduce((sum, symbol) => sum + Math.abs(Math.log2(shifted[symbol] / mappings[symbol])), 0) * .01;
      const result = { mappings: shifted, noteDivision, spaceDivision, meter };
      candidates.push({ evidence, result });
      if (!best || score < best.score - 1e-8) best = { score, evidence, result };
    }
  }
  const equivalent = best ? candidates.filter(candidate => Math.abs(candidate.evidence - best!.evidence) < 1e-8
    && candidate.result.meter.beats === best!.result.meter.beats
    && candidate.result.meter.beatType === best!.result.meter.beatType) : [];
  const differentBareUnits = best && !hasSymbols && equivalent.some(candidate =>
    candidate.result.noteDivision !== best!.result.noteDivision || candidate.result.spaceDivision !== best!.result.spaceDivision);
  const timingSignature = (candidate: NonNullable<ReturnType<typeof inferImportTiming>>): string => {
    const options = { ...defaultSlashScoreOptions("keyboard"), ...modes, ...candidate,
      symbolDurations: candidate.mappings, multiDurationSymbols: true,
      beats: candidate.meter.beats, beatType: candidate.meter.beatType };
    const target = options.beats * 4 / options.beatType / groupsForMeter(candidate.meter);
    return JSON.stringify([...shapes.keys()].map(group => {
      const events: TimedEvent[] = [];
      parseGroup(group, 0, target, "inference", options, events, null);
      return events.map(event => [Math.round(event.start * 1e8), Math.round(event.end * 1e8), event.pitches.length]);
    }));
  };
  const bestSignature = best && hasSymbols && equivalent.length > 1 ? timingSignature(best.result) : null;
  const differentSymbolTiming = bestSignature !== null && equivalent.some(candidate => timingSignature(candidate.result) !== bestSignature);
  if (best && (differentBareUnits || differentSymbolTiming)) {
    // E.g. every group is `A `: quarter-note attacks with formatting spaces
    // and eighth-note attacks plus eighth-note spaces fit equally well.
    // Symbol combinations can likewise fit a whole beat while placing its
    // inner attacks differently. Only truly equivalent timelines may share
    // a recommendation; a name-based unit preference cannot resolve that.
    return { mappings: {}, noteDivision: null, spaceDivision: null,
      meter: { ...best.result.meter, requiresInput: !best.result.meter.explicit }, ambiguous: true };
  }
  return best?.result ?? null;
}

export function inferSlashMeter(
  text: string,
  symbolDurations: Record<string, SlashDurationDivision>,
  spaceDivision: SlashDurationDivision | null,
  braceMode: SlashBraceMode,
  noteDivision: SlashDurationDivision | null = null,
  bracketMode: SlashGroupMode = "triplet",
  kind?: SlashScoreKind,
  extraModes: Partial<Pick<SlashScoreOptions, "barMode" | "angleMode" | "parenMode">> = {},
): SlashMeterSuggestion {
  const directive = readDirectives(text);
  const allLines = sourceLines(text);
  const selectedKind = kind ?? detectKind(text, allLines, directive);
  const lines = sourceLines(text, selectedKind);
  const mappings = effectiveMappings({ symbolDurations, spaceDivision });
  const groupCounts = lines.score.map((line) => splitGroups(line).length).filter((count) => count > 0);
  const durations: number[] = [];
  for (const line of lines.score) {
    for (const group of splitGroups(line)) {
      const duration = segmentMarkerDuration(
        group,
        mappings,
        braceMode,
        noteDivision,
        bracketMode,
        extraModes,
      );
      if (duration > 1e-8) durations.push(duration);
    }
  }
  return meterFromEvidence(groupCounts, durations, directive);
}

export function analyzeSlashScore(text: string): SlashScoreAnalysis {
  const directive = readDirectives(text);
  const allLines = sourceLines(text);
  const detectedKind = detectKind(text, allLines, directive);
  const lines = sourceLines(text, detectedKind);
  const observed = observedSymbols(lines.score, detectedKind);
  let suggestedMappings: Record<string, SlashDurationDivision> = {};
  for (const symbol of observed.symbols) {
    suggestedMappings[symbol] = directive.mappings[symbol] ?? defaultDivisionForSymbol(symbol);
  }
  for (const [symbol, division] of Object.entries(directive.mappings)) suggestedMappings[symbol] = division;
  let savedOptions = false;
  let savedMappings = false;
  const stored = /(?:^|\n)\s*\/\/\s*@jpeditor\s+(\{[^\n]*\})\s*(?:\n|$)/.exec(text);
  if (stored) {
    try {
      const value = JSON.parse(stored[1]) as Record<string, unknown>;
      savedOptions = value !== null && typeof value === "object";
      savedMappings = savedOptions && (Object.prototype.hasOwnProperty.call(value, "symbolDurations")
        || Object.prototype.hasOwnProperty.call(value, "s"));
    } catch { /* ordinary comment */ }
  }
  if (savedMappings || Object.keys(directive.mappings).length > 0
    || directive.noteDivision !== undefined || directive.spaceDivision !== undefined) {
    // Explicit rules, including an intentionally empty saved mapping, are
    // authoritative. Any other observed glyph remains pending in the dialog.
    suggestedMappings = { ...directive.mappings };
  }
  let spaceDivision = directive.spaceDivision ?? null;
  let noteDivision = directive.noteDivision ?? null;
  const braceMode = directive.braceMode ?? (savedOptions ? "arpeggio" : "none");
  const bracketMode = directive.bracketMode ?? (savedOptions ? "triplet" : "none");
  const barMode = directive.barMode ?? "none";
  const angleMode = directive.angleMode ?? (savedOptions ? "grace" : "none");
  const parenMode = directive.parenMode ?? "chord";
  let meter = inferSlashMeter(
    text,
    suggestedMappings,
    spaceDivision,
    braceMode,
    noteDivision,
    bracketMode,
    detectedKind,
    { barMode, angleMode, parenMode },
  );
  let timingInferred = false;
  const explicitOrnamentRules = [directive.braceMode, directive.bracketMode, directive.barMode,
    directive.angleMode, directive.parenMode].some(mode => mode !== null && mode !== "none" && mode !== "chord");
  if (!savedOptions && directive.spaceDivision === undefined && directive.noteDivision === undefined
    && Object.keys(directive.mappings).length === 0 && !explicitOrnamentRules) {
    const timing = inferImportTiming(lines.score, suggestedMappings, directive,
      { braceMode, bracketMode, barMode, angleMode, parenMode });
    if (timing) {
      suggestedMappings = timing.meter.requiresInput ? {} : timing.mappings;
      spaceDivision = timing.spaceDivision;
      noteDivision = timing.noteDivision;
      meter = timing.meter;
      timingInferred = !meter.requiresInput && !timing.ambiguous;
    } else {
      suggestedMappings = {};
      meter = { ...meter, requiresInput: !meter.explicit };
    }
  }
  if (!meter.explicit && observed.symbols.some(symbol => suggestedMappings[symbol] === undefined)) {
    meter = { ...meter, requiresInput: true };
    timingInferred = false;
  }
  const rawGroupCount = lines.score.length === 1 ? splitGroups(lines.score[0]).length : 0;
  // A single unbroken run that would imply an unusually long simple meter is
  // more likely several measures without line/bar separators. Ask for a meter
  // in the dialog and use common 4/4 as the editable starting point.
  if (!meter.explicit && lines.score.length === 1 && meter.beatType === 4 && meter.beats > 6) {
    meter = { ...meter, beats: 4, beatType: 4, groupsPerMeasure: 4 };
  }
  const expectedGroups = groupsForMeter(meter);
  const firstGroupCount = rawGroupCount;
  const measureLength = meter.beats * 4 / meter.beatType;
  const wholeMeasureGroups = directive.wholeMeasureGroups ?? slashGroupsUseWholeMeasures(
    lines.score,
    { symbolDurations: suggestedMappings, spaceDivision, noteDivision, braceMode, bracketMode,
      barMode, angleMode, parenMode },
    measureLength / Math.max(1, expectedGroups),
    measureLength,
  );
  const continuous = lines.score.length === 1 && (wholeMeasureGroups ? firstGroupCount > 1 : firstGroupCount > expectedGroups);
  const measureCount = wholeMeasureGroups
    ? lines.score.reduce((sum, line) => sum + splitGroups(line).length, 0)
    : continuous ? Math.ceil(firstGroupCount / expectedGroups) : lines.score.length;
  const voiceCount = directive.voiceCount ?? inferSlashVoiceCount(text, detectedKind);
  return {
    detectedKind,
    keyboardKeyLabels: directive.keyboardKeyLabels ?? false,
    keyboardTieAsZero: directive.keyboardTieAsZero ?? false,
    keyboardHideTieLabels: directive.keyboardHideTieLabels ?? false,
    voiceCount,
    measureCount,
    commentCount: lines.comments.length,
    ignoredTagCount: lines.ignoredTags,
    observedSymbols: observed.symbols,
    observedDelimiters: slashDelimiterSpecs({ braceMode, bracketMode, barMode, angleMode, parenMode })
      .filter(spec => lines.score.some(line => line.includes(spec.open) || line.includes(spec.close)))
      .map(spec => spec.id),
    requiresMeterInput: meter.requiresInput ?? false,
    requiresSymbolMapping: !savedOptions && !explicitOrnamentRules
      && observed.symbols.some(symbol => suggestedMappings[symbol] === undefined),
    timingInferred,
    containsScoreSpaces: observed.spaces,
    suggestedMappings,
    multiDurationSymbols: directive.multiDurationSymbols
      ?? Object.keys(suggestedMappings).length > 1,
    suggestedSpaceDivision: spaceDivision,
    suggestedNoteDivision: noteDivision,
    wholeMeasureGroups,
    sourceTimedRows: directive.sourceTimedRows,
    adjacentAsChord: directive.adjacentAsChord,
    emptyGroupsAsRests: directive.emptyGroupsAsRests ?? false,
    showExplicitRests: directive.showExplicitRests ?? true,
    meter,
    tempoBpm: directive.tempoBpm ?? 90,
    tempoBeatUnit: directive.tempoBeatUnit ?? "quarter",
    fifths: directive.fifths ?? 0,
    title: directive.title,
    headerTypography: normalizeHeaderTypography(directive.headerTypography),
    subtitle: directive.subtitle,
    composer: directive.composer,
    arranger: directive.arranger,
    lyricist: directive.lyricist,
    suggestedBraceMode: braceMode,
    suggestedBracketMode: bracketMode,
    suggestedBarMode: barMode,
    suggestedAngleMode: angleMode,
    suggestedParenMode: parenMode,
    ordering: directive.ordering,
    tempoMarks: directive.tempoMarks,
    keyChanges: directive.keyChanges,
    annotations: directive.annotations,
    noteTimingEdits: directive.noteTimingEdits,
    continuous,
  };
}

export function defaultSlashScoreOptions(kind: SlashScoreKind, analysis?: SlashScoreAnalysis): SlashScoreOptions {
  return {
    kind,
    keyboardKeyLabels: analysis?.keyboardKeyLabels ?? false,
    keyboardTieAsZero: analysis?.keyboardTieAsZero ?? false,
    keyboardHideTieLabels: analysis?.keyboardHideTieLabels ?? false,
    voiceCount: analysis?.voiceCount ?? 1,
    instrumentName: "钢琴",
    title: analysis?.title ?? "",
    headerTypography: normalizeHeaderTypography(analysis?.headerTypography),
    subtitle: analysis?.subtitle ?? "",
    composer: analysis?.composer ?? "",
    arranger: analysis?.arranger ?? "",
    lyricist: analysis?.lyricist ?? "",
    tempoBpm: analysis?.tempoBpm ?? 90,
    tempoBeatUnit: analysis?.tempoBeatUnit ?? "quarter",
    fifths: analysis?.fifths ?? 0,
    beats: analysis?.meter.beats ?? 4,
    beatType: analysis?.meter.beatType ?? 4,
    symbolDurations: { ...(analysis?.suggestedMappings ?? { ".": 8 }) },
    multiDurationSymbols: analysis?.multiDurationSymbols ?? false,
    spaceDivision: analysis?.suggestedSpaceDivision ?? null,
    noteDivision: analysis?.suggestedNoteDivision ?? null,
    wholeMeasureGroups: analysis?.wholeMeasureGroups ? true : undefined,
    sourceTimedRows: analysis?.sourceTimedRows,
    adjacentAsChord: analysis?.adjacentAsChord,
    emptyGroupsAsRests: analysis?.emptyGroupsAsRests ?? false,
    showExplicitRests: analysis?.showExplicitRests ?? true,
    braceMode: analysis?.suggestedBraceMode ?? "arpeggio",
    bracketMode: analysis?.suggestedBracketMode ?? "triplet",
    barMode: analysis?.suggestedBarMode ?? "none",
    angleMode: analysis?.suggestedAngleMode ?? "grace",
    parenMode: analysis?.suggestedParenMode ?? "chord",
    ordering: analysis?.ordering ?? "pitch-asc",
    tempoMarks: analysis?.tempoMarks.map((mark) => ({ ...mark })) ?? [],
    keyChanges: analysis?.keyChanges.map((change) => ({ ...change })) ?? [],
    annotations: analysis?.annotations.map((annotation) => ({ ...annotation })) ?? [],
    noteTimingEdits: analysis?.noteTimingEdits.map((edit) => ({ ...edit })) ?? [],
  };
}

function tonicPitch(fifths: number): number {
  // JPW deliberately places tonic A/B (and their flat spellings) below
  // middle C, so one octave of numbered notation remains centred around C4.
  // Using only the pitch class here made `1=A` serialize as `-1`, even though
  // the source JPW pitch and the generated preview sounded the same.
  const key = MusicCommon.keys[clamp(Math.round(fifths) + 7, 0, MusicCommon.keys.length - 1)];
  return MusicCommon.getBasePitch(key);
}

function keyboardPitchAt(text: string, at: number, fifths: number): PitchToken | null {
  let index = at;
  let accidental = 0;
  if (text[index] === "#" || text[index] === "♯") { accidental = 1; index++; }
  else if (text[index] === "b" || text[index] === "♭") { accidental = -1; index++; }
  let extraOctave = 0;
  while (text[index] === "," || text[index] === "'") {
    extraOctave += text[index] === "'" ? 1 : -1;
    index++;
  }
  const letter = text[index]?.toUpperCase();
  if (!letter) return null;
  let row = -1;
  let degree = -1;
  for (let r = 0; r < KEYBOARD_ROWS.length; r++) {
    const found = KEYBOARD_ROWS[r].indexOf(letter);
    if (found >= 0) { row = r; degree = found; break; }
  }
  if (row < 0) return null;
  const octave = row - 1 + extraOctave;
  return { pitch: tonicPitch(fifths) + DEGREE_INTERVALS[degree] + octave * 12 + accidental, next: index + 1 };
}

function numberPitchAt(text: string, at: number, fifths: number): PitchToken | null {
  let index = at;
  let accidental = 0;
  if (text[index] === "#" || text[index] === "♯") { accidental = 1; index++; }
  else if (text[index] === "b" || text[index] === "♭") { accidental = -1; index++; }
  let octave = 0;
  while (text[index] === "+" || text[index] === "-") {
    octave += text[index] === "+" ? 1 : -1;
    index++;
  }
  const digit = text[index];
  if (!/[1-7]/.test(digit ?? "")) return null;
  const degree = parseInt(digit, 10) - 1;
  return { pitch: tonicPitch(fifths) + DEGREE_INTERVALS[degree] + octave * 12 + accidental, next: index + 1 };
}

function pitchAt(text: string, at: number, options: SlashScoreOptions): PitchToken | null {
  return options.kind === "keyboard" ? keyboardPitchAt(text, at, options.fifths) : numberPitchAt(text, at, options.fifths);
}

/** Compare source rhythm without confusing equivalent pitch spellings with
 * a duration edit. Share the real tokenizer, including lowercase keyboard
 * letters and the distinction between a flat prefix and a standalone B. */
export function slashPitchShape(text: string, options: SlashScoreOptions): string {
  let shape = "";
  for (let index = 0; index < text.length;) {
    const pitch = pitchAt(text, index, options);
    if (pitch) { shape += "N"; index = pitch.next; }
    else { shape += text[index]; index++; }
  }
  return shape;
}

function pitchVoiceAt(text: string, pitchIndex: number, options: SlashScoreOptions): number {
  let markerFrom = pitchIndex;
  while (markerFrom > 0 && text[markerFrom - 1] === SLASH_VOICE_SEPARATOR) markerFrom--;
  const count = pitchIndex - markerFrom;
  return compactMarkerVoiceNumber(count, options.voiceCount) - 1;
}

/** Return a directly attached following pitch. Invisible voice ownership may
 * sit between the two glyphs, but whitespace and visible punctuation break
 * the compact run. */
interface CompactTimedAtom {
  index: number;
  next: number;
  voice: number;
  pitch: PitchToken | null;
  rest: boolean;
  /** Generated compact TXT writes `voiceCount` separators before an
   * otherwise-unmarked default-voice atom.  The sentinel is invisible, but
   * distinguishes a real half-grid cell from an ordinary hand-written
   * cross-voice adjacency. */
  explicitDefault: boolean;
  /** Invisible fine cells encoded in reserved marker blocks before this atom. */
  paddingCells: number;
}

function compactMarkerCountBefore(text: string, index: number): number {
  let from = index;
  while (from > 0 && text[from - 1] === SLASH_VOICE_SEPARATOR) from--;
  return index - from;
}

function compactAtomsShareFineCell(
  leftVoice: number,
  leftRest: boolean,
  leftExplicitDefault: boolean,
  right: CompactTimedAtom,
): boolean {
  return leftRest || right.rest
    || leftVoice === right.voice
    || leftExplicitDefault
    || right.explicitDefault;
}

/** A compact TXT cell can be either a pitch or an explicit zero.  Voice
 * separators are ownership metadata and therefore do not break adjacency.
 * Treating only pitches as compact atoms made a generated `A0` lose both
 * 32nd cells on reload: the score serializer had correctly written a note
 * followed by its released fine rest, but the parser counted neither atom. */
function compactTimedAtomAt(
  text: string,
  at: number,
  options: SlashScoreOptions,
  allowBareChord = true,
): CompactTimedAtom | null {
  const pitch = pitchAt(text, at, options);
  if (pitch) {
    const bare = allowBareChord ? bareChordAt(text, at, options) : null;
    return {
      index: at,
      next: bare?.next ?? pitch.next,
      voice: pitchVoiceAt(text, at, options),
      pitch,
      rest: false,
      explicitDefault: options.voiceCount > 1
        && compactMarkerCountBefore(text, at) > 0
        && compactMarkerVoiceNumber(compactMarkerCountBefore(text, at), options.voiceCount)
          === options.voiceCount,
      paddingCells: compactMarkerPaddingCells(compactMarkerCountBefore(text, at)),
    };
  }
  if (text[at] === "0") {
    return {
      index: at,
      next: at + 1,
      voice: pitchVoiceAt(text, at, options),
      pitch: null,
      rest: true,
      explicitDefault: options.voiceCount > 1
        && compactMarkerCountBefore(text, at) > 0
        && compactMarkerVoiceNumber(compactMarkerCountBefore(text, at), options.voiceCount)
          === options.voiceCount,
      paddingCells: compactMarkerPaddingCells(compactMarkerCountBefore(text, at)),
    };
  }
  const container = slashContainerAt(text, at, options);
  if (!container || container.spec.mode !== "chord") return null;
  const body = text.slice(container.bodyFrom, container.bodyTo);
  const explicitVoice = explicitTimedContainerVoice(body);
  const mixedVoiceChord = body.includes(SLASH_VOICE_SEPARATOR)
    && explicitVoice === null;
  return {
    index: at,
    next: container.end,
    voice: explicitVoice ?? options.voiceCount - 1,
    pitch: null,
    rest: body.includes("0"),
    // A mixed-voice chord is one shared rhythmic column.  When it is tightly
    // followed by another atom, that adjacency is therefore an unambiguous
    // fine-cell sequence even if the following atom belongs to another voice.
    explicitDefault: mixedVoiceChord || options.voiceCount > 1
      && body.includes(SLASH_VOICE_SEPARATOR.repeat(options.voiceCount))
      && explicitVoice === options.voiceCount - 1,
    paddingCells: compactMarkerPaddingCells(compactMarkerCountBefore(text, at)),
  };
}

/** Without a configured chord container, physically touching pitches form
 * one simultaneous column. Whitespace, rests and duration marks end it. */
function bareChordAt(text: string, at: number, options: SlashScoreOptions):
  { next: number; pitches: number[] } | null {
  if (!slashUsesBareChords(options)) return null;
  const first = pitchAt(text, at, options);
  if (!first) return null;
  const pitches = [first.pitch];
  let next = first.next;
  while (next < text.length) {
    let cursor = next;
    while (text[cursor] === SLASH_VOICE_SEPARATOR) cursor++;
    const pitch = pitchAt(text, cursor, options);
    if (!pitch) break;
    pitches.push(pitch.pitch);
    next = pitch.next;
  }
  return pitches.length > 1 ? { next, pitches } : null;
}

function adjacentCompactTimedAtomAfter(
  text: string,
  at: number,
  options: SlashScoreOptions,
): CompactTimedAtom | null {
  let index = at;
  while (text[index] === SLASH_VOICE_SEPARATOR) index++;
  return compactTimedAtomAt(text, index, options);
}

function compactAtomHasPlayablePitch(
  text: string,
  atom: CompactTimedAtom,
  options: SlashScoreOptions,
): boolean {
  if (atom.pitch) return true;
  if (atom.rest) return false;
  const container = slashContainerAt(text, atom.index, options);
  return container?.spec.mode === "chord"
    && pitchesIn(text.slice(container.bodyFrom, container.bodyTo), options).length > 0;
}

/** In marker-only TXT, a tightly attached pitched atom decorates the next
 * pitched atom instead of creating a hidden half-grid value.  Duration marks,
 * whitespace, rests and voice changes break the implicit grace run. */
function implicitGraceFollowerAt(
  text: string,
  atom: CompactTimedAtom,
  options: SlashScoreOptions,
  blockedByLeadingDuration = false,
): CompactTimedAtom | null {
  if (!slashDelimiterSpecs(options).some(spec => spec.mode === "chord")) return null;
  if (options.noteDivision !== null
    || blockedByLeadingDuration
    || atom.rest
    || atom.paddingCells > 0
    || !compactAtomHasPlayablePitch(text, atom, options)) return null;
  const next = adjacentCompactTimedAtomAfter(text, atom.next, options);
  if (!next
    || next.rest
    || next.paddingCells > 0
    || !compactAtomHasPlayablePitch(text, next, options)) return null;
  return atom.voice === next.voice || atom.explicitDefault || next.explicitDefault
    ? next
    : null;
}

function startsBetweenCompactBaseCells(value: number, baseUnit: number): boolean {
  if (baseUnit <= 1e-9) return false;
  const cells = value / baseUnit;
  return Math.abs(cells - Math.round(cells)) > 1e-8;
}

/**
 * Locate every playable pitch in accepted score lines without rewriting the
 * user's TXT.  The returned absolute ranges let the rendered single-staff
 * score select and edit its exact keyboard/number source spelling.
 */
export function slashPitchSources(text: string, baseOptions: SlashScoreOptions): SlashPitchSource[] {
  const options = optionsWithDirectives(text, baseOptions);
  if (options.sourceTimedRows) {
    const projected = projectSourceTimedRows(text, options);
    return mapProjectedSources(slashPitchSources(projected.text, projected.options), projected.sourceOffsets);
  }
  const mappings = effectiveMappings(options);
  const result: SlashPitchSource[] = [];
  const lineRecords = sourceLineRecords(text);
  const selectedLineStarts = new Set(lineRecords
    .filter((_record, index) => selectedScoreLine(lineRecords, index, options.kind))
    .map((record) => record.from));
  let eventIndex = 0;
  let lineFrom = text.startsWith("\uFEFF") ? 1 : 0;

  while (lineFrom <= text.length) {
    let lineTo = lineFrom;
    while (lineTo < text.length && text[lineTo] !== "\r" && text[lineTo] !== "\n") lineTo++;
    const raw = text.slice(lineFrom, lineTo);
    if (selectedLineStarts.has(lineFrom)) {
      const tagRanges = [...raw.matchAll(/\[(?:line|end)\s*\d+\s*\]/gi)]
        .map((match) => [match.index ?? 0, (match.index ?? 0) + match[0].length] as const);
      const tagAt = (index: number): readonly [number, number] | undefined =>
        tagRanges.find(([from, to]) => index >= from && index < to);

      const appendRange = (
        from: number,
        to: number,
        sharedEvent: number,
        grace = false,
        tripletSource = false,
      ): void => {
        for (let index = from; index < to;) {
          const tag = tagAt(index);
          if (tag) { index = tag[1]; continue; }
          const token = pitchAt(raw, index, options);
          if (!token || token.next > to) { index++; continue; }
          let markerFrom = index;
          while (markerFrom > 0 && raw[markerFrom - 1] === SLASH_VOICE_SEPARATOR) markerFrom--;
          const markerCount = index - markerFrom;
          result.push({
            from: lineFrom + index,
            to: lineFrom + token.next,
            pitch: clamp(token.pitch, 0, 127),
            eventIndex: sharedEvent,
            grace,
            voiceIndex: markerCount > 0
              ? clamp(markerCount, 1, options.voiceCount)
              : options.voiceCount,
            markerFrom: lineFrom + markerFrom,
            markerCount,
            tripletSource,
          });
          index = token.next;
        }
      };
      let pendingArpeggioEvent: number | null = null;
      let mergeableEvent: number | null = null;
      const finishPendingArpeggio = (): void => {
        if (pendingArpeggioEvent === null) return;
        eventIndex = Math.max(eventIndex, pendingArpeggioEvent + 1);
        mergeableEvent = pendingArpeggioEvent;
        pendingArpeggioEvent = null;
      };
      const eventForAtom = (): number => {
        const sharedEvent = pendingArpeggioEvent ?? eventIndex;
        if (pendingArpeggioEvent !== null) {
          eventIndex = Math.max(eventIndex, sharedEvent + 1);
          pendingArpeggioEvent = null;
        } else {
          eventIndex++;
        }
        mergeableEvent = sharedEvent;
        return sharedEvent;
      };

      for (let index = 0; index < raw.length;) {
        const tag = tagAt(index);
        if (tag) {
          finishPendingArpeggio();
          mergeableEvent = null;
          index = tag[1];
          continue;
        }
        const container = slashContainerAt(raw, index, options);
        if (container) {
          const mode = container.spec.mode;
          if (mode === "arpeggio") {
            const sharedEvent: number = mergeableEvent ?? pendingArpeggioEvent ?? eventIndex;
            appendRange(container.bodyFrom, container.bodyTo, sharedEvent);
            if (mergeableEvent === null && pendingArpeggioEvent === null) {
              pendingArpeggioEvent = sharedEvent;
            }
            mergeableEvent = sharedEvent;
            index = container.end;
            continue;
          }
          if (mode === "chord") {
            const atom = compactTimedAtomAt(raw, index, options)!;
            const implicitGrace = implicitGraceFollowerAt(raw, atom, options) !== null;
            appendRange(
              container.bodyFrom,
              container.bodyTo,
              implicitGrace ? pendingArpeggioEvent ?? eventIndex : eventForAtom(),
              implicitGrace,
            );
            index = container.end;
            continue;
          }
          // A triplet container is a sequence of independent rhythmic atoms,
          // not one large chord.  Keep each atom's source event separate so
          // splitTimedEventsByVoice can assign marked pitches (U+2063) to
          // their original voices.  In particular, `[(1⁣3).⁣4.⁣3.]` must
          // expose V2:1 followed by V1:3,4,3 rather than one unvoiced event.
          const nestedTriplet = mode === "subdivide"
            ? nestedSubdivisionTripletBody(raw.slice(container.bodyFrom, container.bodyTo), options)
            : null;
          const rhythmicMode = nestedTriplet ? "triplet" : mode;
          // A nested `<[ABA]>` is the compact spelling of one semantic
          // mordent.  Its middle/return pitches are only glyph data; exposing
          // them as source pitches makes voice matching see a three-note V2
          // group and subsequently moves the rest of the measure to the
          // default voice.  Keep exactly the first attack (including its
          // invisible voice marker) in the source map.
          // Only metadata-backed nested triplets are ornaments.  A plain
          // `<[ABA]>` is still a real nested triplet and must retain all of
          // its source pitches.  Treating every ABA shape as a mordent makes
          // source-event matching skip the helper notes and can consequently
          // assign the rest of a multi-voice line to the default voice.
          const mordentMetadata = options.annotations?.find((annotation): annotation is Extract<NotationAnnotationData, { type: "ornament" }> =>
            annotation.type === "ornament"
            && (annotation.kind === "upper-mordent" || annotation.kind === "lower-mordent"));
          const semanticMordent = mordentMetadata && rhythmicMode === "triplet"
            && (mode === "triplet"
              ? directMordentBody(raw.slice(container.bodyFrom, container.bodyTo), options, mordentMetadata.part)
              : nestedMordentBody(raw.slice(container.bodyFrom, container.bodyTo), options, mordentMetadata.part));
          if (semanticMordent) {
            // A direct `[ASA]` has no nested container.  Its source range is
            // the outer body itself; using the old `?? 0` fallback made
            // `innerFrom === innerTo`, so firstMordentAtom() saw an empty
            // string and all three helper pitches leaked into the ordinary
            // event stream.  That shifted every following event index and
            // made correctly marked V1 notes map to an uncoloured V2 chord.
            const innerFrom = nestedTriplet
              ? container.bodyFrom + nestedTriplet.from
              : container.bodyFrom;
            const innerTo = nestedTriplet
              ? container.bodyFrom + nestedTriplet.to
              : container.bodyTo;
            const atom = firstMordentAtom(raw.slice(innerFrom, innerTo), options);
            if (atom) {
              appendRange(
                innerFrom + atom.from,
                innerFrom + atom.to,
                eventForAtom(),
                false,
                rhythmicMode === "triplet",
              );
              index = container.end;
              continue;
            }
          }
          if (rhythmicMode === "triplet" || rhythmicMode === "subdivide" || rhythmicMode === "none") {
            const atomFrom = nestedTriplet
              ? container.bodyFrom + nestedTriplet.from
              : container.bodyFrom;
            const atomTo = nestedTriplet
              ? container.bodyFrom + nestedTriplet.to
              : container.bodyTo;
            let cursor = atomFrom;
            let pendingRolledEvent: number | null = null;
            let mergeableTimedEvent: number | null = null;
            const finishTimedArpeggio = (): void => {
              if (pendingRolledEvent !== null) eventIndex = Math.max(eventIndex, pendingRolledEvent + 1);
              pendingRolledEvent = null;
            };
            const eventForTimedAtom = (): number => {
              const shared = pendingRolledEvent ?? eventForAtom();
              finishTimedArpeggio();
              mergeableTimedEvent = shared;
              return shared;
            };
            while (cursor < atomTo) {
              if (/\s/.test(raw[cursor]) || mappings[raw[cursor]]) {
                if (mappings[raw[cursor]]) {
                  finishTimedArpeggio();
                  mergeableTimedEvent = null;
                }
                cursor++;
                continue;
              }
              const atomContainer = slashContainerAt(raw, cursor, options);
              if (atomContainer && atomContainer.end <= atomTo && atomContainer.spec.mode === "arpeggio") {
                const shared: number = mergeableTimedEvent ?? pendingRolledEvent ?? eventIndex;
                appendRange(atomContainer.bodyFrom, atomContainer.bodyTo, shared, false, rhythmicMode === "triplet");
                if (mergeableTimedEvent === null && pendingRolledEvent === null) pendingRolledEvent = shared;
                mergeableTimedEvent = shared;
                cursor = atomContainer.end;
                continue;
              }
              if (atomContainer && atomContainer.end <= atomTo && atomContainer.spec.mode === "triplet") {
                const atom = semanticMordentAtom(raw.slice(atomContainer.bodyFrom, atomContainer.bodyTo), options);
                if (atom) {
                  appendRange(atomContainer.bodyFrom + atom.from, atomContainer.bodyFrom + atom.to,
                    eventForTimedAtom(), false, rhythmicMode === "triplet");
                  cursor = atomContainer.end;
                  continue;
                }
              }
              if (atomContainer && atomContainer.end <= atomTo
                && atomContainer.spec.mode === "chord") {
                  appendRange(
                    atomContainer.bodyFrom,
                    atomContainer.bodyTo,
                    eventForTimedAtom(),
                    false,
                    rhythmicMode === "triplet",
                  );
                  cursor = atomContainer.end;
                  continue;
              }
              const atom = pitchAt(raw, cursor, options);
              if (atom && atom.next <= atomTo) {
                const bare = bareChordAt(raw, cursor, options);
                if (bare && bare.next <= atomTo) {
                  appendRange(cursor, bare.next, eventForTimedAtom(), false, rhythmicMode === "triplet");
                  cursor = bare.next;
                  continue;
                }
                let from = cursor;
                while (from > atomFrom && raw[from - 1] === SLASH_VOICE_SEPARATOR) from--;
                appendRange(
                  from,
                  atom.next,
                  eventForTimedAtom(),
                  false,
                  rhythmicMode === "triplet",
                );
                cursor = atom.next;
                continue;
              }
              cursor++;
            }
            finishTimedArpeggio();
            index = container.end;
            continue;
          }
          // Grace notes are rendered as decorations on the following chord,
          // not as normal score entries.  Retain their exact source ranges,
          // but share the upcoming event index so they cannot consume the
          // following main-note mapping.
          if (mode === "grace") {
            appendRange(container.bodyFrom, container.bodyTo, pendingArpeggioEvent ?? eventIndex, true);
            index = container.end;
            continue;
          }
        }
        const token = pitchAt(raw, index, options);
        if (!token) {
          const char = raw[index];
          if (char !== SLASH_VOICE_SEPARATOR && !(/\s/.test(char) && !mappings[char])) {
            finishPendingArpeggio();
            mergeableEvent = null;
          }
          index++;
          continue;
        }
        const bare = bareChordAt(raw, index, options);
        if (bare) {
          appendRange(index, bare.next, eventForAtom());
          index = bare.next;
          continue;
        }
        let markerFrom = index;
        while (markerFrom > 0 && raw[markerFrom - 1] === SLASH_VOICE_SEPARATOR) markerFrom--;
        const markerCount = index - markerFrom;
        const atom = compactTimedAtomAt(raw, index, options)!;
        const implicitGrace = implicitGraceFollowerAt(raw, atom, options) !== null;
        const sharedEvent = implicitGrace
          ? pendingArpeggioEvent ?? eventIndex
          : eventForAtom();
        result.push({
          from: lineFrom + index,
          to: lineFrom + token.next,
          pitch: clamp(token.pitch, 0, 127),
          eventIndex: sharedEvent,
          grace: implicitGrace,
          voiceIndex: markerCount > 0
            ? clamp(markerCount, 1, options.voiceCount)
            : options.voiceCount,
          markerFrom: lineFrom + markerFrom,
          markerCount,
        });
        index = token.next;
        continue;
      }
      finishPendingArpeggio();
    }
    if (lineTo >= text.length) break;
    lineFrom = lineTo + (text[lineTo] === "\r" && text[lineTo + 1] === "\n" ? 2 : 1);
  }
  return result;
}

function pitchesIn(text: string, options: SlashScoreOptions): number[] {
  const pitches: number[] = [];
  for (let index = 0; index < text.length;) {
    const token = pitchAt(text, index, options);
    if (token) {
      pitches.push(clamp(token.pitch, 0, 127));
      index = token.next;
    } else {
      index++;
    }
  }
  // Keep repeated pitches while an interactively moved tone is selected.
  // `(335)` is a meaningful transient chord and is normalized to `(35)` only
  // when the score selection is released.
  return pitches;
}

/** Preserve per-pitch TXT ownership while reading a mixed-voice chord. */
function voicedPitchesIn(
  text: string,
  options: SlashScoreOptions,
): Array<{ pitch: number; voice: number }> {
  const pitches: Array<{ pitch: number; voice: number }> = [];
  for (let index = 0; index < text.length;) {
    const token = pitchAt(text, index, options);
    if (!token) {
      index++;
      continue;
    }
    pitches.push({
      pitch: clamp(token.pitch, 0, 127),
      voice: pitchVoiceAt(text, index, options),
    });
    index = token.next;
  }
  return pitches;
}

/** Read rolled member sets without flattening braces nested in a chord.
 * The configured delimiter modes, not literal brace characters, own semantics. */
function arpeggioGroupsInChord(text: string, options: SlashScoreOptions): SlashArpeggioGroup[] {
  const groups: SlashArpeggioGroup[] = [];
  for (let index = 0; index < text.length;) {
    const container = slashContainerAt(text, index, options);
    if (!container) { index++; continue; }
    const body = text.slice(container.bodyFrom, container.bodyTo);
    if (container.spec.mode === "arpeggio") {
      groups.push(voicedPitchesIn(body, options).map(item => ({ part: item.voice, pitch: item.pitch })));
    } else if (container.spec.mode === "chord" || container.spec.mode === "none") {
      groups.push(...arpeggioGroupsInChord(body, options));
    }
    index = container.end;
  }
  return groups.filter(group => group.length >= 2);
}

function containsPitchMultiplicity(
  actual: readonly number[],
  expected: readonly number[],
): boolean {
  const remaining = [...actual];
  for (const pitch of expected) {
    const index = remaining.indexOf(pitch);
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return true;
}

interface TimedAtom {
  pitches: number[];
  /** Original start, including a pending ornament/voice prefix. */
  sourceFrom?: number;
  /** Zero-based TXT voice for each item in `pitches`. */
  pitchVoices?: number[];
  nominalDuration: number;
  /** The temporary half-grid value inferred only because this atom touches
   * another compact atom.  A following explicit duration glyph replaces this
   * fallback instead of extending it. */
  compactImplicitDuration?: boolean;
  /** True when a printed duration glyph (or intrinsic note value) owns it. */
  explicitDuration?: boolean;
  restVoiceIndexes?: number[];
  gracePitches?: number[][];
  arpeggio?: boolean;
  arpeggioPitches?: number[];
  arpeggioGroups?: SlashArpeggioGroup[];
}

function timedContainerAtoms(
  text: string,
  options: SlashScoreOptions,
  fallback: number,
  unmarkedRestVoiceIndexes: readonly number[] = [options.voiceCount - 1],
): TimedAtom[] {
  const mappings = effectiveMappings(options);
  const noteUnit = options.noteDivision ? 4 / options.noteDivision : 0;
  const atoms: TimedAtom[] = [];
  const state: { active: TimedAtom | null } = { active: null };
  let leadingDuration = 0;
  let pendingGrace: number[][] = [];
  let pendingArpeggio: SlashArpeggioGroup[] = [];
  let tokenFrom = 0;
  let pendingSourceFrom: number | null = null;
  let lastPitchEnd = -1;
  let lastPitchVoice = -1;
  let lastAtomWasRest = false;
  let lastAtomExplicitDefault = false;
  let attachAfterExplicitDuration = false;

  const start = (
    pitches: number[],
    restVoiceIndexes: number[] = [],
    implicitDuration?: number,
    pitchVoices?: number[],
  ): void => {
    if (state.active) {
      if (state.active.nominalDuration <= 1e-9) state.active.nominalDuration = implicitDuration ?? fallback;
      atoms.push(state.active);
    }
    const rolledMembers = pendingArpeggio.flat();
    const rolled = rolledMembers.map(item => item.pitch);
    state.active = {
      sourceFrom: pendingSourceFrom ?? Math.max(0, tokenFrom - compactMarkerCountBefore(text, tokenFrom)),
      pitches: rolled.length > 0 ? [...rolled, ...pitches] : pitches,
      pitchVoices: pitchVoices && pitchVoices.length === pitches.length
        ? [...rolledMembers.map(item => item.part), ...pitchVoices]
        : undefined,
      nominalDuration: (implicitDuration ?? noteUnit) + leadingDuration,
      compactImplicitDuration: implicitDuration !== undefined || undefined,
      explicitDuration: noteUnit > 0 || undefined,
      restVoiceIndexes: restVoiceIndexes.length > 0
        ? [...new Set(restVoiceIndexes)]
        : undefined,
      gracePitches: pendingGrace.length > 0 ? pendingGrace : undefined,
      arpeggio: rolled.length > 0 || undefined,
      arpeggioPitches: rolled.length > 0 ? rolled : undefined,
      arpeggioGroups: pendingArpeggio.length > 0 ? pendingArpeggio : undefined,
    };
    leadingDuration = 0;
    pendingGrace = [];
    pendingArpeggio = [];
    pendingSourceFrom = null;
  };
  const restVoicesIn = (body: string): number[] => {
    const voices: number[] = [];
    for (let cursor = 0; cursor < body.length;) {
      if (body[cursor] === "0") {
        voices.push(...unmarkedRestVoiceIndexes);
        cursor++;
        continue;
      }
      if (body[cursor] !== SLASH_VOICE_SEPARATOR) {
        cursor++;
        continue;
      }
      let after = cursor;
      while (body[after] === SLASH_VOICE_SEPARATOR) after++;
      const count = after - cursor;
      while (/\s/.test(body[after] ?? "")) after++;
      if (body[after] === "0") voices.push(clamp(count, 1, options.voiceCount) - 1);
      cursor = Math.max(after + 1, cursor + 1);
    }
    return [...new Set(voices)];
  };
  for (let index = 0; index < text.length;) {
    tokenFrom = index;
    const division = mappings[text[index]];
    if (division) {
      if (pendingArpeggio.length > 0) start([], [], undefined, []);
      lastPitchEnd = -1;
      lastPitchVoice = -1;
      lastAtomWasRest = false;
      lastAtomExplicitDefault = false;
      lastAtomExplicitDefault = false;
      const amount = 4 / division;
      if (state.active) {
        if (state.active.compactImplicitDuration) {
          // In `ABC` each attached atom is one binary level finer than the
          // configured minimum.  If an atom carries an explicit marker, as
          // in `[01.]`, that marker declares its complete written value; the
          // inferred half-cell is only a fallback and must not be added a
          // second time.
          state.active.nominalDuration = amount;
          state.active.compactImplicitDuration = false;
        } else {
          state.active.nominalDuration += amount;
        }
        state.active.explicitDuration = true;
        attachAfterExplicitDuration = true;
      }
      else {
        leadingDuration += amount;
        attachAfterExplicitDuration = false;
      }
      index++;
      continue;
    }
    const container = slashContainerAt(text, index, options);
    if (container) {
      const body = text.slice(container.bodyFrom, container.bodyTo);
      const voicedPitches = voicedPitchesIn(body, options);
      const pitches = voicedPitches.map((item) => item.pitch);
      if (container.spec.mode === "chord") {
        const rests = restVoicesIn(body);
        const atom = compactTimedAtomAt(text, index, options, false)!;
        const nextAtom = adjacentCompactTimedAtomAfter(text, atom.next, options);
        const hasFollowingDuration = mappings[text[atom.next] ?? ""] !== undefined;
        const mayUseImplicitHalf = !hasFollowingDuration;
        const followsCompactAtom = lastPitchEnd === index
          && compactAtomsShareFineCell(
            lastPitchVoice,
            lastAtomWasRest,
            lastAtomExplicitDefault,
            atom,
          );
        const precedesCompactAtom = nextAtom !== null
          && compactAtomsShareFineCell(
            atom.voice,
            atom.rest,
            atom.explicitDefault,
            nextAtom,
          );
        const tightDuration = options.noteDivision === null
          && mayUseImplicitHalf
          && (followsCompactAtom || precedesCompactAtom || attachAfterExplicitDuration
            || atom.paddingCells > 0)
          ? fallback / 2
          : undefined;
        if (pitches.length > 0 || rests.length > 0) {
          start(pitches, rests, tightDuration, voicedPitches.map((item) => item.voice));
          if (state.active) {
            const nested = arpeggioGroupsInChord(body, options);
            if (nested.length > 0) state.active.arpeggioGroups = [...(state.active.arpeggioGroups ?? []), ...nested];
          }
        }
        attachAfterExplicitDuration = false;
        lastPitchEnd = atom.next;
        lastPitchVoice = atom.voice;
        lastAtomWasRest = atom.rest;
        lastAtomExplicitDefault = atom.explicitDefault;
      } else if (container.spec.mode === "triplet") {
        const main = semanticMordentAtom(body, options);
        if (main) {
          const voiced = voicedPitchesIn(body.slice(main.from, main.to), options);
          start(voiced.map(item => item.pitch), [], undefined, voiced.map(item => item.voice));
          lastPitchEnd = -1;
          lastPitchVoice = -1;
          lastAtomWasRest = false;
          lastAtomExplicitDefault = false;
        }
      } else if (container.spec.mode === "grace" && pitches.length > 0) {
        pendingSourceFrom ??= index;
        lastPitchEnd = -1;
        lastPitchVoice = -1;
        lastAtomWasRest = false;
        lastAtomExplicitDefault = false;
        pendingGrace.push(pitches);
      } else if (container.spec.mode === "arpeggio" && pitches.length > 0) {
        pendingSourceFrom ??= index;
        lastPitchEnd = -1;
        lastPitchVoice = -1;
        lastAtomWasRest = false;
        lastAtomExplicitDefault = false;
        const members = voicedPitches.map(item => ({ part: item.voice, pitch: item.pitch }));
        if (state.active && !state.active.explicitDuration && pendingArpeggio.length === 0) {
          const previousVoices = state.active.pitchVoices
            ?? state.active.pitches.map(() => options.voiceCount - 1);
          state.active.pitches.push(...pitches);
          state.active.pitchVoices = [...previousVoices, ...voicedPitches.map(item => item.voice)];
          state.active.arpeggioGroups = [...(state.active.arpeggioGroups ?? []), members];
        } else pendingArpeggio.push(members);
      } else if (container.spec.mode === "subdivide" || container.spec.mode === "none") {
        lastPitchEnd = -1;
        lastPitchVoice = -1;
        lastAtomWasRest = false;
        lastAtomExplicitDefault = false;
        const nested = timedContainerAtoms(body, options, fallback / 2, unmarkedRestVoiceIndexes);
        for (const atom of nested) {
          start(atom.pitches, atom.restVoiceIndexes ?? [], undefined, atom.pitchVoices);
          if (state.active) {
            state.active.nominalDuration = atom.nominalDuration;
            state.active.explicitDuration = atom.explicitDuration;
            state.active.sourceFrom = container.bodyFrom + (atom.sourceFrom ?? 0);
            state.active.arpeggioGroups = atom.arpeggioGroups;
          }
        }
      }
      if (container.spec.mode !== "grace" && container.spec.mode !== "arpeggio") {
        attachAfterExplicitDuration = false;
      }
      index = container.end;
      continue;
    }
    if (text[index] === "0") {
      const atom = compactTimedAtomAt(text, index, options)!;
      const nextAtom = adjacentCompactTimedAtomAfter(text, atom.next, options);
      const hasFollowingDuration = mappings[text[atom.next] ?? ""] !== undefined;
      const mayUseImplicitHalf = !hasFollowingDuration
        || atom.explicitDefault && startsBetweenCompactBaseCells(
          atoms.reduce((sum, item) => sum + item.nominalDuration,
            leadingDuration + (state.active?.nominalDuration ?? 0)),
          fallback,
        );
      const followsCompactAtom = lastPitchEnd === index
        && compactAtomsShareFineCell(
          lastPitchVoice,
          lastAtomWasRest,
          lastAtomExplicitDefault,
          atom,
        );
      const precedesCompactAtom = nextAtom !== null
        && compactAtomsShareFineCell(
          atom.voice,
          atom.rest,
          atom.explicitDefault,
          nextAtom,
        );
      const tightDuration = options.noteDivision === null
        && mayUseImplicitHalf
        && (followsCompactAtom || precedesCompactAtom || attachAfterExplicitDuration
          || atom.paddingCells > 0)
        ? fallback / 2
        : undefined;
      start([], [...unmarkedRestVoiceIndexes], tightDuration);
      attachAfterExplicitDuration = false;
      lastPitchEnd = atom.next;
      lastPitchVoice = atom.voice;
      lastAtomWasRest = true;
      lastAtomExplicitDefault = atom.explicitDefault;
      index++;
      continue;
    }
    if (text[index] === SLASH_VOICE_SEPARATOR) {
      let after = index;
      while (text[after] === SLASH_VOICE_SEPARATOR) after++;
      const markerEnd = after;
      const markerCount = after - index;
      while (/\s/.test(text[after] ?? "")) after++;
      if (text[after] === "0") {
        const atom = compactTimedAtomAt(text, after, options, false)!;
        const nextAtom = adjacentCompactTimedAtomAfter(text, atom.next, options);
        const hasFollowingDuration = mappings[text[atom.next] ?? ""] !== undefined;
        const mayUseImplicitHalf = !hasFollowingDuration
          || atom.explicitDefault && startsBetweenCompactBaseCells(
            atoms.reduce((sum, item) => sum + item.nominalDuration,
              leadingDuration + (state.active?.nominalDuration ?? 0)),
            fallback,
          );
        const followsCompactAtom = lastPitchEnd === index && after === markerEnd
          && compactAtomsShareFineCell(
            lastPitchVoice,
            lastAtomWasRest,
            lastAtomExplicitDefault,
            atom,
          );
        const precedesCompactAtom = nextAtom !== null
          && compactAtomsShareFineCell(
            atom.voice,
            atom.rest,
            atom.explicitDefault,
            nextAtom,
          );
        const tightDuration = options.noteDivision === null
          && mayUseImplicitHalf
          && (followsCompactAtom || precedesCompactAtom || attachAfterExplicitDuration
            || atom.paddingCells > 0)
          ? fallback / 2
          : undefined;
        start([], [clamp(markerCount, 1, options.voiceCount) - 1], tightDuration);
        attachAfterExplicitDuration = false;
        lastPitchEnd = atom.next;
        lastPitchVoice = atom.voice;
        lastAtomWasRest = true;
        lastAtomExplicitDefault = atom.explicitDefault;
        index = after + 1;
        continue;
      }
      if (!(lastPitchEnd === index && after === markerEnd)) {
        lastPitchEnd = -1;
        lastPitchVoice = -1;
        lastAtomWasRest = false;
        lastAtomExplicitDefault = false;
      } else {
        lastPitchEnd = after;
      }
      index = after;
      continue;
    }
    const pitch = pitchAt(text, index, options);
    if (pitch) {
      const atom = compactTimedAtomAt(text, index, options)!;
      const bare = bareChordAt(text, index, options);
      const voice = atom.voice;
      const nextAtom = adjacentCompactTimedAtomAfter(text, atom.next, options);
      const hasFollowingDuration = mappings[text[pitch.next] ?? ""] !== undefined;
      const mayUseImplicitHalf = !hasFollowingDuration;
      const followsCompactAtom = lastPitchEnd === index
        && compactAtomsShareFineCell(
          lastPitchVoice,
          lastAtomWasRest,
          lastAtomExplicitDefault,
          atom,
        );
      const precedesCompactAtom = nextAtom !== null
        && compactAtomsShareFineCell(
          voice,
          false,
          atom.explicitDefault,
          nextAtom,
        );
      const tightDuration = options.noteDivision === null
        && mayUseImplicitHalf
        && (followsCompactAtom || precedesCompactAtom || attachAfterExplicitDuration
          || atom.paddingCells > 0)
        ? fallback / 2
        : undefined;
      const voiced = bare ? voicedPitchesIn(text.slice(index, bare.next), options) : null;
      start(bare ? bare.pitches.map(value => clamp(value, 0, 127)) : [clamp(pitch.pitch, 0, 127)],
        [], tightDuration, voiced ? voiced.map(value => value.voice) : [voice]);
      attachAfterExplicitDuration = false;
      lastPitchEnd = atom.next;
      lastPitchVoice = voice;
      lastAtomWasRest = false;
      lastAtomExplicitDefault = atom.explicitDefault;
      index = atom.next;
      continue;
    }
    lastPitchEnd = -1;
    lastPitchVoice = -1;
    lastAtomWasRest = false;
    lastAtomExplicitDefault = false;
    attachAfterExplicitDuration = false;
    index++;
  }
  if (pendingArpeggio.length > 0) start([], [], undefined, []);
  if (state.active) {
    if (state.active.nominalDuration <= 1e-9) state.active.nominalDuration = fallback;
    atoms.push(state.active);
  }
  if (leadingDuration > 1e-9 && atoms.length > 0) atoms[0].nominalDuration += leadingDuration;
  return atoms;
}

function isRestOnlyGroup(group: string, options: SlashScoreOptions): boolean {
  // A slash group containing a rest marker and no playable pitch is a full
  // empty beat/group. Whitespace and duration markers around `-` therefore do
  // not change `-`, ` - ` or `-....` into sounding material. Numeric octave
  // prefixes such as `-1` remain notes because pitchesIn() finds their pitch.
  const hasRestMarker = group.includes("-") || group.includes("0");
  const hasVoicedRest = group.includes(SLASH_VOICE_SEPARATOR)
    && new RegExp(`${SLASH_VOICE_SEPARATOR}+\\s*0`).test(group);
  const hasRhythmicContainer = slashDelimiterSpecs(options).some((spec) =>
    group.includes(spec.open)
    && (spec.mode === "triplet" || spec.mode === "subdivide"));
  return hasRestMarker && !hasVoicedRest && !hasRhythmicContainer
    && pitchesIn(group, options).length === 0;
}

function groupHasContent(group: string, options: SlashScoreOptions): boolean {
  return isRestOnlyGroup(group, options)
    || pitchesIn(group, options).length > 0
    || slashDelimiterSpecs(options).some((spec) => group.includes(spec.open));
}

function parseGroup(
  group: string,
  absoluteStart: number,
  targetDuration: number,
  sourceGroupKey: string,
  options: SlashScoreOptions,
  events: TimedEvent[],
  previousEvent: TimedEvent | null,
  measureIndex = -1,
  groupOffset = 0,
  measureDuration = options.beats * 4 / options.beatType,
): { clipped: boolean; ignored: number; lastEvent: TimedEvent | null } {
  const mappings = effectiveMappings(options);
  if (isRestOnlyGroup(group, options)) {
    // A written 0 is a real rest in the default TXT voice.  It must survive
    // the MIDI-shaped intermediate timeline so it can stop the preceding
    // attack and later be materialized/merged in the Score.  Treating the
    // whole group as empty used to stretch a quarter entered after 3/4 -> 4/4
    // back to a whole note on the next parse.  A bare '-' keeps its historical
    // all-empty-group behaviour.
    const firstZero = group.indexOf("0");
    const hasLeadingDuration = firstZero >= 0
      && Array.from(group.slice(0, firstZero)).some((char) => mappings[char] !== undefined);
    if (firstZero >= 0 && !hasLeadingDuration) {
      const rest: TimedEvent = {
        start: absoluteStart,
        end: absoluteStart + targetDuration,
        pitches: [],
        restVoiceIndexes: [options.voiceCount - 1],
        sourceGroupKey,
        sourceGroupEnd: absoluteStart + targetDuration,
        writtenDurations: [targetDuration],
      };
      events.push(rest);
      return { clipped: false, ignored: 0, lastEvent: rest };
    }
    // `.0...` is not a full-beat rest: the leading duration belongs to the
    // preceding sound, and only the remaining portion is silent. Continue
    // through the normal character parser so it creates that continuation
    // before starting the explicit zero. A bare `-` keeps the historical
    // whole-empty-group shortcut.
    if (firstZero < 0) return { clipped: false, ignored: 0, lastEvent: null };
  }
  const finest = Math.max(4, options.noteDivision ?? 4, ...Object.values(mappings));
  const minimumUnit = 4 / finest;
  const braceUnit = Math.max(4 / 128, minimumUnit / 2);
  const noteUnit = options.noteDivision ? 4 / options.noteDivision : null;
  let cursor = 0;
  let ignored = 0;
  let clipped = false;
  let unattachedDuration = 0;
  let lastEvent: TimedEvent | null = null;
  let lastSharedEvent: TimedEvent | null = null;
  let pendingGrace: TimedAtom[] = [];
  let lastPitchEnd = -1;
  let parallelTupletSilence: { voiceIndex: number; from: number } | null = null;
  let hasOwnedParallelTuplet = false;
  const clearParallelTupletSilence = (voice: number | null): void => {
    if (parallelTupletSilence?.voiceIndex === voice) parallelTupletSilence = null;
  };
  const lastEventByVoice = new Map<number, TimedEvent>();
  let durationContinuationVoice: number | null = null;
  let active: {
    start: number;
    pitches: number[];
    hadDuration: boolean;
    durationPieces: number[];
    continuationOf: TimedEvent | null;
    gracePitches: number[][];
    arpeggio: boolean;
    arpeggioPitches: number[];
    arpeggioGroups?: SlashArpeggioGroup[];
    ornamentKind?: "upper-mordent" | "lower-mordent" | "trill";
    /** Voice owning a semantic ornament.  Without this, the ornament's
     * synthetic main note falls back to the default (last) TXT voice. */
    voiceIndex?: number;
    awaitingArpeggioMain: boolean;
    restVoiceIndexes: number[];
  } | null = null;

  const flush = (end: number, fillIfEmpty = false): void => {
    if (!active) return;
    let finish = end;
    if (finish <= active.start + 1e-9 && fillIfEmpty) finish = Math.min(targetDuration, active.start + minimumUnit);
    if (finish > active.start + 1e-9) {
      const total = finish - active.start;
      const writtenDurations: number[] = [];
      let written = 0;
      for (const piece of active.durationPieces) {
        const available = total - written;
        if (available <= 1e-9) break;
        const kept = Math.min(piece, available);
        if (kept > 1e-9) writtenDurations.push(kept);
        written += kept;
      }
      if (written < total - 1e-9) writtenDurations.push(total - written);
      const event: TimedEvent = {
        start: absoluteStart + active.start,
        end: absoluteStart + Math.min(targetDuration, finish),
        pitches: active.pitches,
        sourceGroupKey,
        sourceGroupEnd: absoluteStart + targetDuration,
      writtenDurations,
    };
      if (active.voiceIndex !== undefined) event.voiceIndex = active.voiceIndex;
      if (active.continuationOf) event.continuationOf = active.continuationOf;
      if (active.gracePitches.length > 0) event.gracePitches = active.gracePitches;
      if (active.arpeggio) event.arpeggio = true;
      if (active.arpeggioPitches.length > 0) {
        event.arpeggioPitches = [...active.arpeggioPitches];
      }
      if (active.arpeggioGroups?.length) event.arpeggioGroups = active.arpeggioGroups;
      if (active.ornamentKind) event.ornamentKind = active.ornamentKind;
      if (active.restVoiceIndexes.length > 0) {
        event.restVoiceIndexes = [...new Set(active.restVoiceIndexes)];
      }
      events.push(event);
      if (event.voiceIndex !== undefined) lastEventByVoice.set(event.voiceIndex, event);
      lastEvent = event;
      lastSharedEvent = event;
    }
    active = null;
  };

  const applyIntrinsicDuration = (): void => {
    if (!active || noteUnit === null) return;
    const before = cursor;
    const finish = cursor + noteUnit;
    if (finish > targetDuration + 1e-8) clipped = true;
    cursor = Math.min(targetDuration, finish);
    if (cursor > before + 1e-9) active.durationPieces.push(cursor - before);
    active.hadDuration = true;
  };

  const startNote = (
    pitches: number[],
    deferIntrinsicDuration = false,
    restVoiceIndexes: number[] = [],
    voiceIndex?: number,
    implicitDuration?: number,
  ): void => {
    if (active?.awaitingArpeggioMain && !active.hadDuration) {
      active.pitches = [...active.pitches, ...pitches];
      active.awaitingArpeggioMain = false;
      if (pendingGrace.length > 0) {
        active.gracePitches.push(...pendingGrace.map((atom) => atom.pitches));
        pendingGrace = [];
      }
      // A duration marker immediately before this note has already supplied
      // the note's intrinsic value through `unattachedDuration`.  Adding the
      // configured note value again made semantic ornaments such as
      // `.<[ASA]>` consume two cells instead of one (and consequently made
      // the following beat report a short/overfull duration).  Only apply the
      // implicit value when no explicit prefix duration was consumed.
      if (!deferIntrinsicDuration && !active.hadDuration) {
        if (implicitDuration !== undefined) {
          active.durationPieces.push(implicitDuration);
          active.hadDuration = true;
          cursor = Math.min(targetDuration, cursor + implicitDuration);
        } else applyIntrinsicDuration();
      }
      return;
    }
    if (active) {
      if (!active.hadDuration) {
        const finish = Math.min(targetDuration, cursor + minimumUnit);
        flush(finish, true);
        cursor = finish;
      } else {
        flush(cursor);
      }
    }
    const gracePitches = pendingGrace.map((atom) => atom.pitches);
    pendingGrace = [];
    active = {
      start: Math.max(0, cursor - unattachedDuration),
      pitches,
      hadDuration: unattachedDuration > 1e-9,
      durationPieces: unattachedDuration > 1e-9 ? [unattachedDuration] : [],
      continuationOf: null,
      gracePitches,
      arpeggio: false,
      arpeggioPitches: [],
      ornamentKind: undefined,
      voiceIndex,
      awaitingArpeggioMain: false,
      restVoiceIndexes,
    };
    unattachedDuration = 0;
    if (!deferIntrinsicDuration && !active.hadDuration) {
      if (implicitDuration !== undefined) {
        active.durationPieces.push(implicitDuration);
        active.hadDuration = true;
        cursor = Math.min(targetDuration, cursor + implicitDuration);
      } else applyIntrinsicDuration();
    }
  };

  for (let index = 0; index < group.length;) {
    const char = group[index];
    const division = mappings[char];
    if (division) {
      lastPitchEnd = -1;
      const amount = 4 / division;
      if (!active && durationContinuationVoice === null
        && (hasOwnedParallelTuplet || (previousEvent?.tripletScope === "voice"
          && previousEvent.end <= absoluteStart + cursor + 1e-8))) {
        // After an owned parallel bracket, bare duration glyphs advance the
        // shared ruler through the bracket and any following gap. They must
        // not become a duration prefix that backdates the next ordinary note.
        cursor = Math.min(targetDuration, cursor + amount);
        index++;
        continue;
      }
      // A duration mark immediately after `/` belongs to the preceding sound
      // when that sound reaches the group boundary.  Keep a separate faint
      // chord at the new rhythmic position so the notation exposes the grid.
      const silentAfterTuplet: { voiceIndex: number; from: number } | null = !active
        ? parallelTupletSilence
        : null;
      const markedContinuation = durationContinuationVoice === null
        ? null
        : lastEventByVoice.get(durationContinuationVoice) ?? null;
      const continuationSource: TimedEvent | null = silentAfterTuplet
        ? null
        : markedContinuation ?? (cursor <= 1e-9 ? previousEvent : lastSharedEvent);
      if (!active && continuationSource
          && Math.abs(continuationSource.end - (absoluteStart + cursor)) <= 1e-8) {
        active = {
          start: cursor,
          pitches: [...continuationSource.pitches],
          hadDuration: false,
          durationPieces: [],
          continuationOf: continuationSource,
          gracePitches: [],
          arpeggio: false,
          arpeggioPitches: [],
          awaitingArpeggioMain: false,
          restVoiceIndexes: continuationSource.restVoiceIndexes
            ? [...continuationSource.restVoiceIndexes]
            : [],
          voiceIndex: continuationSource.voiceIndex,
        };
      }
      durationContinuationVoice = null;
      const before = cursor;
      cursor = Math.min(targetDuration, cursor + amount);
      const current = active as {
        start: number;
        pitches: number[];
        hadDuration: boolean;
        durationPieces: number[];
        continuationOf: TimedEvent | null;
      } | null;
      if (current) {
        if (cursor > before + 1e-9) current.durationPieces.push(cursor - before);
        current.hadDuration = true;
      }
      else if (silentAfterTuplet) {
        const silenceStart = Math.max(before, silentAfterTuplet.from);
        if (cursor > silenceStart + 1e-9) {
          active = {
            start: silenceStart,
            pitches: [],
            hadDuration: true,
            durationPieces: [cursor - silenceStart],
            continuationOf: null,
            gracePitches: [],
            arpeggio: false,
            arpeggioPitches: [],
            voiceIndex: silentAfterTuplet.voiceIndex,
            awaitingArpeggioMain: false,
            restVoiceIndexes: [silentAfterTuplet.voiceIndex],
          };
        }
      }
      else if (markedContinuation && markedContinuation.end >= absoluteStart + cursor - 1e-8) {
        // Ordinary timing metadata can already include the sustain after the
        // shared bracket. Its marked suffix advances the common ruler only;
        // treating it as a prefix backdates the next attack into this gap.
      }
      else unattachedDuration += cursor - before;
      if (before + amount > targetDuration + 1e-8) clipped = true;
      index++;
      continue;
    }
    if (char === SLASH_VOICE_SEPARATOR) {
      let after = index;
      while (group[after] === SLASH_VOICE_SEPARATOR) after++;
      const markerEnd = after;
      const markerCount = after - index;
      while (/\s/.test(group[after] ?? "")) after++;
      if (group[after] === "0") {
        const atom = compactTimedAtomAt(group, after, options)!;
        const paddingCells = compactMarkerPaddingCells(markerCount);
        if (paddingCells > 0) {
          const before = cursor;
          cursor = Math.min(targetDuration, cursor + paddingCells * minimumUnit);
          if (active && cursor > before + 1e-9) {
            active.durationPieces.push(cursor - before);
            active.hadDuration = true;
          }
          if (before + paddingCells * minimumUnit > targetDuration + 1e-8) clipped = true;
        }
        startNote(
          [],
          false,
          [compactMarkerVoiceNumber(markerCount, options.voiceCount) - 1],
          undefined,
        );
        if (parallelTupletSilence?.voiceIndex === atom.voice) parallelTupletSilence = null;
        lastPitchEnd = atom.next;
        index = after + 1;
      } else {
        if (mappings[group[after] ?? ""] !== undefined) {
          durationContinuationVoice = compactMarkerVoiceNumber(
            markerCount,
            options.voiceCount,
          ) - 1;
        }
        if (lastPitchEnd === index && after === markerEnd) {
          lastPitchEnd = after;
        } else {
          lastPitchEnd = -1;
        }
        index = after;
      }
      continue;
    }
    if (/\s/.test(char)) {
      lastPitchEnd = -1;
      index++;
      continue;
    }
    const container = slashContainerAt(group, index, options);
    if (container) {
      const mode = container.spec.mode;
      const outerBody = group.slice(container.bodyFrom, container.bodyTo);
      if (mode === "chord") {
        const pitches = pitchesIn(outerBody, options);
        const restVoiceIndexes: number[] = [];
        for (let bodyCursor = 0; bodyCursor < outerBody.length;) {
          if (outerBody[bodyCursor] === "0") {
            restVoiceIndexes.push(options.voiceCount - 1);
            bodyCursor++;
            continue;
          }
          if (outerBody[bodyCursor] !== SLASH_VOICE_SEPARATOR) {
            bodyCursor++;
            continue;
          }
          let after = bodyCursor;
          while (outerBody[after] === SLASH_VOICE_SEPARATOR) after++;
          const markerCount = after - bodyCursor;
          while (/\s/.test(outerBody[after] ?? "")) after++;
          if (outerBody[after] === "0") {
            restVoiceIndexes.push(clamp(markerCount, 1, options.voiceCount) - 1);
          }
          bodyCursor = Math.max(after + 1, bodyCursor + 1);
        }
        const atom = compactTimedAtomAt(group, index, options)!;
        if (atom.paddingCells > 0) {
          const before = cursor;
          cursor = Math.min(targetDuration, cursor + atom.paddingCells * minimumUnit);
          if (active && cursor > before + 1e-9) {
            active.durationPieces.push(cursor - before);
            active.hadDuration = true;
          }
          if (before + atom.paddingCells * minimumUnit > targetDuration + 1e-8) clipped = true;
        }
        const implicitGrace = pitches.length > 0
          && restVoiceIndexes.length === 0
          && implicitGraceFollowerAt(
            group,
            atom,
            options,
            unattachedDuration > 1e-9,
          ) !== null;
        if (implicitGrace) {
          pendingGrace.push({ pitches, nominalDuration: 0 });
        } else if (pitches.length > 0 || restVoiceIndexes.length > 0) {
          startNote(pitches, false, restVoiceIndexes);
          const nested = arpeggioGroupsInChord(outerBody, options);
          if (active && nested.length > 0) {
            active.arpeggioGroups = [...(active.arpeggioGroups ?? []), ...nested];
          }
        }
        lastPitchEnd = atom.next;
        index = container.end;
        continue;
      }
      lastPitchEnd = -1;
      // `<[DFD]>` (and an explicitly configured trill container) is a
      // semantic ornament around one attack.  Do not let the three helper
      // pitches enter the rhythmic stream: they are rendered by the score's
      // ornament glyph and the source notation is retained in metadata.
      const semanticOrnament = (mode === "triplet" || mode === "subdivide")
        ? options.annotations?.find((annotation): annotation is Extract<NotationAnnotationData, { type: "ornament" }> =>
          annotation.type === "ornament"
          && annotation.measure === measureIndex
          // `groupOffset` is the beginning of the slash group; an ornament
          // container may occur after one or more duration markers/notes in
          // that group. Match its actual rhythmic cursor, otherwise the
          // metadata is missed and the ABA helper pitches become real notes.
          && Math.abs(annotation.offset - (groupOffset + cursor)) < 1 / 192)
        : undefined;
      const nestedMordent = semanticOrnament
        ? (mode === "triplet"
          ? directMordentBody(outerBody, options, semanticOrnament.part)
          : nestedMordentBody(outerBody, options, semanticOrnament.part))
        : null;
      if (nestedMordent) {
        if (active) flush(cursor, true);
        const atomBody = mode === "triplet"
          ? outerBody
          : nestedSubdivisionTripletBody(outerBody, options)?.body ?? outerBody;
        const atom = firstMordentAtom(atomBody, options);
        const hasFollowingDuration = mappings[group[container.end] ?? ""] !== undefined;
        startNote(
          atom?.pitches.length ? atom.pitches : [nestedMordent.pitch],
          hasFollowingDuration,
          [],
          semanticOrnament?.part,
        );
        if (active) {
          active.ornamentKind = nestedMordent.kind;
          // The helper pitches inside `<[...]>` carry the owning voice marker.
          // Keep the semantic attack in that same (zero-based) part instead
          // of falling back to the default/last voice on the next conversion.
          const ornamentVoice = explicitTimedContainerVoice(outerBody);
          if (ornamentVoice !== null) active.voiceIndex = ornamentVoice;
          // The helper ABA pitches are decorative, but the nested container
          // still occupies one ordinary finest-grid cell.  When no intrinsic
          // note value is configured, `startNote` cannot advance the cursor
          // by itself; leaving it at the same position makes the following
          // note steal the ornament's time and triggers a short-beat error.
          if (!active.hadDuration && !hasFollowingDuration) {
            const ornamentDuration = Math.min(targetDuration - cursor, minimumUnit);
            if (ornamentDuration > 1e-9) {
              active.durationPieces.push(ornamentDuration);
              active.hadDuration = true;
              cursor += ornamentDuration;
            }
          }
        }
        index = container.end;
        continue;
      }
      if (mode === "trill") {
        const trillPitches = pitchesIn(outerBody, options);
        if (trillPitches.length > 0) {
          if (active) flush(cursor, true);
          startNote([trillPitches[0]!]);
          if (active) active.ornamentKind = "trill";
        }
        index = container.end;
        continue;
      }
      const nestedTriplet = mode === "subdivide"
        ? nestedSubdivisionTripletBody(outerBody, options)
        : null;
      const rhythmicMode = nestedTriplet ? "triplet" : mode;
      const timedBody = nestedTriplet?.body ?? outerBody;
      const containerVoice = explicitTimedContainerVoice(outerBody);
      const storedTuplet = rhythmicMode === "triplet"
        ? options.annotations?.find((annotation): annotation is Extract<NotationAnnotationData, { type: "triplet" }> =>
          annotation.type === "triplet" && annotation.measure === measureIndex
          && annotation.end !== undefined && (annotation.members?.length ?? 0) > 0
          && (containerVoice === null || annotation.scope === "all" || annotation.part === containerVoice)
          && Math.abs(annotation.offset - (groupOffset + cursor)) <= 1 / 192)
        : undefined;
      let intrinsicContainer = rhythmicMode === "triplet" && noteUnit !== null && !storedTuplet;
      let leadingTripletDuration = 0;
      let timedBodyStart = 0;
      if (rhythmicMode === "triplet" && !intrinsicContainer) {
        while (mappings[timedBody[timedBodyStart] ?? ""] !== undefined) {
          leadingTripletDuration += 4 / mappings[timedBody[timedBodyStart]!]!;
          timedBodyStart++;
        }
      }
      const atoms = timedContainerAtoms(
        timedBody.slice(timedBodyStart),
        options,
        // A nested `<[...]>` triplet's unmarked atoms are members of the
        // ordinary finest cell, then the 1/3 factor below turns that nominal
        // cell into a 3:2 member. Using `braceUnit` here applied the
        // subdivision half too early and made an unmarked 16th triplet read
        // as 64ths. Explicit duration markers still override this fallback.
        nestedTriplet || rhythmicMode === "triplet" ? minimumUnit : braceUnit,
        // A triplet typed directly into TXT has no editor ownership metadata,
        // so its empty cells describe the shared rhythmic grid of every
        // enabled voice. Cursor-created groups write an explicit U+2063 before
        // their 0 and therefore retain their single-voice ownership here.
        rhythmicMode === "triplet"
          ? Array.from({ length: options.voiceCount }, (_unused, voice) => voice)
          : [options.voiceCount - 1],
      );
      if (atoms.length === 0) intrinsicContainer = false;
      if (mode === "grace") {
        if (active) flush(cursor, true);
        pendingGrace.push(...atoms);
      } else if (mode === "arpeggio") {
        const rolledMembers = voicedPitchesIn(outerBody, options)
          .map(item => ({ part: item.voice, pitch: item.pitch }));
        const rolledChord = rolledMembers.map(item => item.pitch);
        if (rolledChord.length > 0) {
          if (active && !active.hadDuration) {
            const stillAwaitingMain = active.awaitingArpeggioMain;
            active.pitches = [...active.pitches, ...rolledChord];
            active.arpeggio = true;
            active.arpeggioPitches = [...active.arpeggioPitches, ...rolledChord];
            active.arpeggioGroups = [...(active.arpeggioGroups ?? []), rolledMembers];
            active.awaitingArpeggioMain = stillAwaitingMain;
          } else {
            if (active) flush(cursor, true);
            startNote(rolledChord, true);
            if (active) {
              active.arpeggio = true;
              active.arpeggioPitches = [...rolledChord];
              active.arpeggioGroups = [rolledMembers];
              active.awaitingArpeggioMain = true;
            }
          }
        }
      } else {
        if (active) flush(cursor, true);
        const containerLocalStart = groupOffset + cursor;
        const allScopedTuplets = rhythmicMode === "triplet"
          ? (options.annotations ?? []).filter((annotation): annotation is Extract<
            NotationAnnotationData,
            { type: "triplet" }
          > => annotation.type === "triplet"
            && annotation.scope === "voice"
            && annotation.measure === measureIndex
            && annotation.end !== undefined
            && (annotation.members?.length ?? 0) > 0)
          : [];
        const sliced = allScopedTuplets.filter((annotation) => annotation.beatSlices
          && annotation.offset < groupOffset + targetDuration - 1e-8
          && annotation.end! > containerLocalStart + 1e-8);
        if (sliced.length > 0) {
          const restored = sliceBeatTupletEvents({
            atoms,
            annotations: sliced.map((annotation) => ({ ...annotation,
              end: annotation.end!, members: annotation.members! })),
            groupOffset, targetDuration, measureIndex, absoluteStart, sourceGroupKey,
          });
          for (const { sourceAtom, ...item } of restored) {
            const event: TimedEvent = { ...item,
              arpeggioGroups: (sourceAtom as TimedAtom | undefined)?.arpeggioGroups,
              metadataVoice: true,
              restVoiceIndexes: item.rest ? [item.voiceIndex] : undefined,
              sourceGroupKey, sourceGroupEnd: absoluteStart + targetDuration,
              writtenDurations: [item.end - item.start],
            };
            events.push(event);
            lastEventByVoice.set(event.voiceIndex!, event);
            lastEvent = event;
          }
          cursor = Math.max(cursor, Math.min(targetDuration,
            Math.max(...sliced.map((annotation) => annotation.end! - groupOffset))));
          index = container.end;
          lastPitchEnd = -1;
          continue;
        }
        // A shared visible bracket is allowed to contain overlapping
        // voice-local tuplets, but tuplets later in the same measure belong to
        // a different container.  The old whole-measure pool let those later
        // annotations contribute ordinary atoms to this bracket; with two
        // non-adjacent tuplets that could consume the first pitched member as
        // a rest on reload. Grow only the overlap-connected component seeded
        // at this container's exact start.
        const scopedTuplets: Extract<NotationAnnotationData, { type: "triplet" }>[] = [];
        const seed = allScopedTuplets.find((annotation) =>
          Math.abs(annotation.offset - containerLocalStart) <= 1 / 192);
        if (seed) {
          let clusterEnd = seed.end!;
          scopedTuplets.push(seed);
          for (let changed = true; changed;) {
            changed = false;
            for (const candidate of allScopedTuplets) {
              if (scopedTuplets.includes(candidate)
                || candidate.offset >= clusterEnd - 1 / 192
                || candidate.end! <= containerLocalStart + 1 / 192) continue;
              scopedTuplets.push(candidate);
              clusterEnd = Math.max(clusterEnd, candidate.end!);
              changed = true;
            }
          }
        }
        const containerLimit = Math.min(measureDuration - groupOffset,
          Math.max(targetDuration, ...scopedTuplets.map((annotation) => annotation.end! - groupOffset)));
        // One compact bracket may own several slash beat groups. Its members
        // and parallel binary events use that complete range; ordinary tokens
        // outside it still obey this slash group's original target duration.
        const metadataTimedContainer = scopedTuplets.length > 0
          && (explicitTimedContainerVoice(outerBody) === null || containerLimit > targetDuration + 1e-8);
        if (metadataTimedContainer) {
          for (const annotation of scopedTuplets) clearParallelTupletSilence(annotation.part);
          // One visible bracket may contain independent tuplets and ordinary
          // material from several voices. Advance each TXT voice on its own
          // ruler; @jpeditor supplies the exact 3:2 member values only for the
          // voices that actually own a tuplet. Mixed chords align the active
          // voice cursors, which makes forms such as [(AE)B(FC)G.] stable.
          const voiceCursors = Array.from({ length: options.voiceCount }, () => cursor);
          const memberIndexes = new Map<Extract<NotationAnnotationData, { type: "triplet" }>, number>();
          const ordinaryByVoice = new Map<number, SlashOrdinaryTiming[]>();
          for (const annotation of scopedTuplets) {
            for (const item of annotation.ordinary ?? []) {
              if (item.offset < containerLocalStart - 1 / 192) continue;
              const list = ordinaryByVoice.get(item.part) ?? [];
              if (!list.some((other) => Math.abs(other.offset - item.offset) < 1 / 192)) list.push(item);
              ordinaryByVoice.set(item.part, list);
            }
          }
          for (const list of ordinaryByVoice.values()) list.sort((left, right) => left.offset - right.offset);
          const ordinaryIndexes = new Map<number, number>();
          let latestEvent: TimedEvent | null = null;
          for (const atom of atoms) {
            const components = new Map<number, { pitches: number[]; rest: boolean }>();
            atom.pitches.forEach((pitch, pitchIndex) => {
              const voice = clamp(
                atom.pitchVoices?.[pitchIndex] ?? options.voiceCount - 1,
                0,
                options.voiceCount - 1,
              );
              const component = components.get(voice) ?? { pitches: [], rest: false };
              component.pitches.push(pitch);
              components.set(voice, component);
            });
            for (const voiceValue of atom.restVoiceIndexes ?? []) {
              const voice = clamp(voiceValue, 0, options.voiceCount - 1);
              const component = components.get(voice) ?? { pitches: [], rest: false };
              if (component.pitches.length === 0) component.rest = true;
              components.set(voice, component);
            }
            const voices = [...components.keys()];
            if (voices.length === 0) continue;
            let aligned = Math.max(...voices.map((voice) => voiceCursors[voice] ?? cursor));
            for (const voice of voices) {
              const next = scopedTuplets.find((annotation) => annotation.part === voice
                && annotation.offset >= groupOffset + (voiceCursors[voice] ?? cursor) - 1 / 192
                && annotation.offset <= groupOffset + aligned + 1 / 192);
              if (next) aligned = Math.max(aligned, next.offset - groupOffset);
            }
            for (const voice of voices) voiceCursors[voice] = aligned;

            for (const voice of voices) {
              const component = components.get(voice)!;
              let ordinaryIndex = ordinaryIndexes.get(voice) ?? 0;
              const ordinaryList = ordinaryByVoice.get(voice) ?? [];
              let candidate = ordinaryList[ordinaryIndex];
              // Another printed voice can advance this voice beyond an omitted
              // silent member. Restore that member before choosing the tuplet
              // for the next visible pitch, or the pitch inherits stale time.
              if (component.pitches.length > 0) {
                for (const annotation of scopedTuplets.filter((item) => item.part === voice)) {
                  let memberIndex = memberIndexes.get(annotation) ?? 0;
                  let memberStart = annotation.offset - groupOffset + annotation.members!
                    .slice(0, memberIndex).reduce((sum, value) => sum + value * 2 / 3, 0);
                  while (memberIndex < annotation.members!.length
                    && annotation.memberRests?.[memberIndex]
                    && memberStart + annotation.members![memberIndex]! * 2 / 3
                      <= (voiceCursors[voice] ?? cursor) + 1e-8) {
                    const finish = memberStart + annotation.members![memberIndex]! * 2 / 3;
                    const event: TimedEvent = {
                      start: absoluteStart + memberStart, end: absoluteStart + finish,
                      pitches: [], restVoiceIndexes: [voice], voiceIndex: voice,
                      sourceGroupKey, sourceGroupEnd: absoluteStart + containerLimit,
                      writtenDurations: [finish - memberStart], metadataVoice: true,
                      tripletGroup: `${sourceGroupKey}:triplet:${index}:v${voice}:${annotation.offset}`,
                      tripletIndex: memberIndex, tripletEnd: absoluteStart + finish,
                      tripletScope: "voice",
                      tripletCrossBeat: containerLimit > targetDuration + 1e-8,
                    };
                    if (!events.some((prior) => prior.voiceIndex === voice
                      && prior.pitches.length === 0
                      && Math.abs(prior.start - event.start) < 1e-8)) events.push(event);
                    memberIndex++;
                    memberIndexes.set(annotation, memberIndex);
                    memberStart = finish;
                  }
                }
              }
              const pendingTuplet = scopedTuplets.filter((item) => item.part === voice
                  && (memberIndexes.get(item) ?? 0) < item.members!.length)
                  .sort((left, right) => left.offset - right.offset)[0];
              const pendingStart = pendingTuplet
                ? pendingTuplet.offset + pendingTuplet.members!
                  .slice(0, memberIndexes.get(pendingTuplet) ?? 0)
                  .reduce((sum, value) => sum + value * 2 / 3, 0)
                : Infinity;
              // A shared bracket may omit an ordinary zero before its next
              // visible pitch. Do not let that queued rest block the pitched
              // ordinary event or make it consume a later Tuplet member.
              // Materialize the omitted rest at its persisted voice time.
              if (component.pitches.length > 0) {
                const nextOrdinaryPitch = ordinaryList.slice(ordinaryIndex + 1)
                  .find((item) => !item.rest)?.offset ?? Infinity;
                const nextPitchedStart = Math.min(pendingStart, nextOrdinaryPitch);
                while (candidate?.rest
                  && candidate.offset + candidate.duration <= nextPitchedStart + 1e-8) {
                  const restStart = candidate.offset - groupOffset;
                  const restEnd = restStart + candidate.duration;
                  if (restEnd > restStart + 1e-9
                    && !events.some((event) => event.voiceIndex === voice
                      && event.restVoiceIndexes?.includes(voice)
                      && Math.abs(event.start - (absoluteStart + restStart)) < 1e-8)) {
                    events.push({
                      start: absoluteStart + restStart, end: absoluteStart + restEnd,
                      pitches: [], restVoiceIndexes: [voice], voiceIndex: voice,
                      sourceGroupKey, sourceGroupEnd: absoluteStart + containerLimit,
                      writtenDurations: [candidate.duration], metadataVoice: true,
                    });
                  }
                  ordinaryIndex++;
                  ordinaryIndexes.set(voice, ordinaryIndex);
                  candidate = ordinaryList[ordinaryIndex];
                }
              }
              const ordinary = candidate && candidate.rest === (component.pitches.length === 0 && component.rest)
                && ((candidate.offset <= pendingStart + 1e-8
                  || (pendingTuplet && candidate.offset >= pendingTuplet.end! - 1e-8
                    && pendingTuplet.memberRests?.slice(memberIndexes.get(pendingTuplet) ?? 0)
                      .every((rest) => rest)
                    && (!candidate.rest || Math.abs(atom.nominalDuration
                      - pendingTuplet.members![memberIndexes.get(pendingTuplet) ?? 0]!) > 1e-8))))
                ? candidate : null;
              // Each annotated voice owns its next unconsumed member even
              // when its first onset falls between the other voice's cells.
              // A display cursor before that onset must not turn the member
              // into an ordinary note or shift it to the bracket's start.
              const annotation = ordinary ? null : pendingTuplet ?? null;
              const memberIndex = annotation ? memberIndexes.get(annotation) ?? 0 : -1;
              const printed = annotation?.members?.[memberIndex]
                ?? (atom.explicitDuration ? atom.nominalDuration : minimumUnit);
              const duration = ordinary?.duration ?? (annotation ? printed * 2 / 3 : printed);
              const start = ordinary ? ordinary.offset - groupOffset
                : annotation
                  ? annotation.offset - groupOffset
                    + annotation.members!.slice(0, memberIndex).reduce((sum, value) => sum + value * 2 / 3, 0)
                  : voiceCursors[voice] ?? aligned;
              // A voice's ordinary clock can extend beyond this printed
              // bracket. The container only bounds the shared TXT ruler; the
              // persisted ordinary timing owns its full note or rest span.
              const finish = ordinary ? start + duration : Math.min(containerLimit, start + duration);
              if (finish <= start + 1e-9) continue;
              const event: TimedEvent = {
                start: absoluteStart + start,
                end: absoluteStart + finish,
                pitches: component.pitches,
                arpeggioGroups: atom.arpeggioGroups,
                restVoiceIndexes: component.pitches.length === 0 && component.rest ? [voice] : undefined,
                sourceGroupKey,
                sourceGroupEnd: absoluteStart + containerLimit,
                writtenDurations: [finish - start],
                voiceIndex: voice,
                metadataVoice: true,
              };
              if (annotation) {
                event.tripletGroup = `${sourceGroupKey}:triplet:${index}:v${voice}:${annotation.offset}`;
                event.tripletIndex = memberIndex;
                event.tripletEnd = absoluteStart + finish;
                event.tripletScope = "voice";
                event.tripletCrossBeat = containerLimit > targetDuration + 1e-8;
                memberIndexes.set(annotation, memberIndex + 1);
              }
              if (ordinary) ordinaryIndexes.set(voice, ordinaryIndex + 1);
              events.push(event);
              lastEventByVoice.set(voice, event);
              latestEvent = !latestEvent || event.start >= latestEvent.start ? event : latestEvent;
              voiceCursors[voice] = finish;
            }
          }
          // A compact shared bracket can omit a parallel voice's ordinary 0
          // entirely. Its persisted timing still owns silence past the other
          // voice's last tuplet member, so restore unconsumed rests even when
          // there was no printed atom to consume them in the loop above.
          for (const [voice, list] of ordinaryByVoice) {
            for (const ordinary of list.slice(ordinaryIndexes.get(voice) ?? 0)) {
              if (!ordinary.rest) continue;
              const start = absoluteStart + ordinary.offset - groupOffset;
              const end = Math.min(absoluteStart + measureDuration - groupOffset,
                start + ordinary.duration);
              if (end <= start + 1e-9 || events.some((event) =>
                event.voiceIndex === voice && event.pitches.length === 0
                && Math.abs(event.start - start) < 1 / 192)) continue;
              const event: TimedEvent = {
                start, end, pitches: [], restVoiceIndexes: [voice],
                sourceGroupKey, sourceGroupEnd: absoluteStart + containerLimit,
                writtenDurations: [end - start], voiceIndex: voice, metadataVoice: true,
              };
              events.push(event);
              lastEventByVoice.set(voice, event);
              latestEvent = !latestEvent || event.start >= latestEvent.start ? event : latestEvent;
              voiceCursors[voice] = Math.max(voiceCursors[voice] ?? 0, end - absoluteStart);
            }
          }
          // Compact overlapping-voice serialization omits interior visible
          // zeroes when another tuplet voice already explains that column.
          // The voice-scoped metadata is authoritative, so materialize any
          // remaining members as real rests before leaving the container.
          // This keeps the long voice's bracket/end and input anchors intact
          // without reintroducing `(0W)`/duplicate `0` text.
          for (const annotation of scopedTuplets) {
            if (annotation.offset < containerLocalStart - 1 / 192
              || annotation.offset >= groupOffset + containerLimit - 1 / 384) continue;
            const voice = clamp(annotation.part, 0, options.voiceCount - 1);
            let memberIndex = memberIndexes.get(annotation) ?? 0;
            let start = annotation.offset - groupOffset + annotation.members!
              .slice(0, memberIndex).reduce((sum, value) => sum + value * 2 / 3, 0);
            const annotationEnd = Math.min(containerLimit, annotation.end! - groupOffset);
            while (memberIndex < (annotation.members?.length ?? 0)
              && start < annotationEnd - 1e-9) {
              const printed = annotation.members![memberIndex]!;
              const finish = Math.min(annotationEnd, start + printed * 2 / 3);
              if (finish <= start + 1e-9) break;
              const event: TimedEvent = {
                start: absoluteStart + start,
                end: absoluteStart + finish,
                pitches: [],
                restVoiceIndexes: [voice],
                sourceGroupKey,
                sourceGroupEnd: absoluteStart + containerLimit,
                writtenDurations: [finish - start],
                voiceIndex: voice,
                metadataVoice: true,
                tripletGroup: `${sourceGroupKey}:triplet:${index}:v${voice}:${annotation.offset}`,
                tripletIndex: memberIndex,
                tripletEnd: absoluteStart + finish,
                tripletScope: "voice",
                tripletCrossBeat: containerLimit > targetDuration + 1e-8,
              };
              events.push(event);
              lastEventByVoice.set(voice, event);
              latestEvent = !latestEvent || event.start >= latestEvent.start ? event : latestEvent;
              memberIndex++;
              memberIndexes.set(annotation, memberIndex);
              start = finish;
              voiceCursors[voice] = finish;
            }
          }
          cursor = ordinaryByVoice.size > 0 && memberIndexes.size > 0
            ? Math.max(cursor, Math.max(...[...memberIndexes.keys()].map((annotation) => annotation.end! - groupOffset)))
            : Math.max(cursor, ...voiceCursors);
          if (latestEvent) lastEvent = latestEvent;
          index = container.end;
          lastPitchEnd = -1;
          continue;
        }
        const nestedHasExplicitDuration = nestedTriplet !== null
          && Array.from(nestedTriplet.body).some((item) => mappings[item] !== undefined);
        let intrinsicEnd = container.end;
        let intrinsicBudget = noteUnit ?? 0;
        if (intrinsicContainer) {
          // Adjacent suffix markers (including mapped spaces) lengthen the
          // complete bracket before its duration is shared by the members.
          while (mappings[group[intrinsicEnd] ?? ""] !== undefined) {
            intrinsicBudget += 4 / mappings[group[intrinsicEnd]!]!;
            intrinsicEnd++;
          }
        }
        const nominalTotal = atoms.reduce((sum, atom) => sum + atom.nominalDuration, 0);
        const factor = intrinsicContainer && nominalTotal > 1e-9
          ? intrinsicBudget / nominalTotal
          : nestedTriplet
          // The inner adjacent atoms already carry the one-level-finer
          // duration.  The legacy outer subdivision wrapper is retained only
          // as a compatibility container, so it must not halve the triplet a
          // second time (which turned 32nd-triplet members into 64ths).
          ? (nestedHasExplicitDuration ? 1 / 3 : 2 / 3)
          : rhythmicMode === "triplet"
            ? 2 / 3
            : rhythmicMode === "subdivide" ? 1 / 2 : 1;
        const tripletGroup = rhythmicMode === "triplet"
          ? `${sourceGroupKey}:triplet:${index}`
          : undefined;
        const completeTripletBeat = tripletGroup !== undefined
          && atoms.every((atom) => atom.explicitDuration)
          && Math.abs((leadingTripletDuration + atoms.reduce((sum, atom) =>
            sum + atom.nominalDuration, 0)) * factor - targetDuration) < 1e-8;
        const explicitVoice = (rhythmicMode === "triplet" || rhythmicMode === "subdivide")
          ? explicitTimedContainerVoice(outerBody)
          : null;
        const parallelVoice = options.voiceCount > 1 ? explicitVoice : null;
        clearParallelTupletSilence(parallelVoice);
        if (leadingTripletDuration > 1e-9) {
          const finish = Math.min(targetDuration, cursor + leadingTripletDuration * factor);
          const source = lastEvent ?? previousEvent;
          if (source && source.end >= absoluteStart + cursor - 1e-8) {
            const continuation: TimedEvent = {
              start: absoluteStart + cursor, end: absoluteStart + finish,
              pitches: [...source.pitches], voiceIndex: source.voiceIndex,
              restVoiceIndexes: source.restVoiceIndexes,
              continuationOf: source, sourceGroupKey,
              sourceGroupEnd: absoluteStart + targetDuration,
              writtenDurations: [finish - cursor],
            };
            events.push(continuation);
            lastEvent = continuation;
          }
          cursor = finish;
        }
        let rhythmicCursor = cursor;
        let tripletIndex = 0;
        for (const atom of atoms) {
          const duration = storedTuplet?.members?.length === atoms.length
            ? storedTuplet.members[tripletIndex]! * 2 / 3
            : atom.nominalDuration * factor;
          const start = parallelVoice === null ? cursor : rhythmicCursor;
          const finish = parallelVoice === null
            ? Math.min(targetDuration, start + duration)
            : start + duration;
          if (finish > start + 1e-9) {
            const event: TimedEvent = {
              start: absoluteStart + start,
              end: absoluteStart + finish,
              pitches: atom.pitches,
              restVoiceIndexes: atom.pitches.length === 0
                ? atom.restVoiceIndexes ?? [options.voiceCount - 1]
                : atom.restVoiceIndexes,
              sourceGroupKey,
              sourceGroupEnd: absoluteStart + targetDuration,
              writtenDurations: [finish - start],
            };
            if (parallelVoice !== null) event.voiceIndex = parallelVoice;
            if (tripletGroup !== undefined) {
              event.tripletGroup = tripletGroup;
              event.tripletIndex = tripletIndex;
              event.tripletEnd = absoluteStart + finish;
              event.tripletScope = parallelVoice === null ? "all" : "voice";
              event.tripletBeatRuler = completeTripletBeat;
              tripletIndex++;
            }
            if (atom.gracePitches?.length) event.gracePitches = atom.gracePitches;
            if (atom.arpeggioGroups?.length) event.arpeggioGroups = atom.arpeggioGroups;
            if (atom.arpeggio) event.arpeggio = true;
            if (atom.arpeggioPitches?.length) {
              event.arpeggioPitches = atom.arpeggioPitches;
            }
            events.push(event);
            if (event.voiceIndex !== undefined) lastEventByVoice.set(event.voiceIndex, event);
            lastEvent = event;
            if (parallelVoice === null) lastSharedEvent = event;
          }
          if (parallelVoice === null && start + duration > targetDuration + 1e-8) clipped = true;
          if (parallelVoice === null) cursor = finish;
          else rhythmicCursor = finish;
        }
        const lastAtom = atoms[atoms.length - 1];
        const cursorOwnedParallelTriplet = rhythmicMode === "triplet"
          && parallelVoice !== null
          && options.annotations?.some((annotation) => annotation.type === "triplet"
            && annotation.part === parallelVoice
            && annotation.measure === measureIndex
            && Math.abs(annotation.offset - (groupOffset + cursor)) < 1 / 192);
        if (cursorOwnedParallelTriplet) hasOwnedParallelTuplet = true;
        if (cursorOwnedParallelTriplet
          && lastAtom
          && lastAtom.pitches.length === 0
          && (lastAtom.restVoiceIndexes ?? []).includes(parallelVoice)) {
          // Duration glyphs after a compact voice-local Tuplet advance the
          // shared ruler. If its last member is 0, that voice must remain
          // silent after the bracket; otherwise the previous pitched member
          // is materialized again as a fresh attack in the released gap.
          parallelTupletSilence = { voiceIndex: parallelVoice, from: rhythmicCursor };
        }
        if (intrinsicContainer) {
          index = intrinsicEnd;
          lastPitchEnd = -1;
          continue;
        }
      }
      index = container.end;
      lastPitchEnd = -1;
      continue;
    }
    if (char === "0") {
      const atom = compactTimedAtomAt(group, index, options)!;
      startNote(
        [],
        false,
        [options.voiceCount - 1],
        undefined,
      );
      if (parallelTupletSilence?.voiceIndex === atom.voice) parallelTupletSilence = null;
      lastPitchEnd = atom.next;
      index++;
      continue;
    }
    const pitch = pitchAt(group, index, options);
    if (pitch) {
      const atom = compactTimedAtomAt(group, index, options)!;
      const bare = bareChordAt(group, index, options);
      const implicitGrace = implicitGraceFollowerAt(
        group,
        atom,
        options,
        unattachedDuration > 1e-9,
      ) !== null;
      if (implicitGrace) {
        pendingGrace.push({
          pitches: [clamp(pitch.pitch, 0, 127)],
          nominalDuration: 0,
        });
      }
      else startNote(bare ? bare.pitches.map(value => clamp(value, 0, 127)) : [clamp(pitch.pitch, 0, 127)]);
      if (!implicitGrace && parallelTupletSilence?.voiceIndex === atom.voice) {
        parallelTupletSilence = null;
      }
      lastPitchEnd = pitch.next;
      index = atom.next;
      continue;
    }
    if (char !== "/" && char !== "-" && char !== "0" && char !== SLASH_VOICE_SEPARATOR) ignored++;
    lastPitchEnd = -1;
    index++;
  }
  if (active?.awaitingArpeggioMain && !active.hadDuration && noteUnit !== null) {
    active.awaitingArpeggioMain = false;
    applyIntrinsicDuration();
  }
  const remaining = active as {
    start: number;
    pitches: number[];
    hadDuration: boolean;
    durationPieces: number[];
    continuationOf: TimedEvent | null;
  } | null;
  if (remaining) {
    if (!remaining.hadDuration) flush(targetDuration, true);
    else flush(cursor);
  }
  if (pendingGrace.length > 0) {
    for (const atom of pendingGrace) {
      const finish = Math.min(targetDuration, cursor + braceUnit);
      if (finish <= cursor + 1e-9) break;
      const event: TimedEvent = {
        start: absoluteStart + cursor,
        end: absoluteStart + finish,
        pitches: atom.pitches,
        sourceGroupKey,
        sourceGroupEnd: absoluteStart + targetDuration,
        writtenDurations: [finish - cursor],
      };
      events.push(event);
      lastEvent = event;
      cursor = finish;
    }
  }
  return { clipped, ignored, lastEvent };
}

function optionsWithDirectives(text: string, base: SlashScoreOptions): SlashScoreOptions {
  const directive = readDirectives(text);
  return {
    ...base,
    headerTypography: normalizeHeaderTypography(base.headerTypography ?? directive.headerTypography),
    // The dialog is authoritative: directives only provide its initial values.
    // This lets a user deliberately reinterpret “点=八分” as 16th notes, or
    // supply a meter for a continuous score with no measure separators.
    kind: base.kind ?? directive.kind ?? "number",
    keyboardKeyLabels: base.keyboardKeyLabels
      ?? directive.keyboardKeyLabels
      ?? false,
    keyboardTieAsZero: base.keyboardTieAsZero
      ?? directive.keyboardTieAsZero
      ?? false,
    keyboardHideTieLabels: base.keyboardHideTieLabels
      ?? directive.keyboardHideTieLabels
      ?? false,
    voiceCount: clamp(
      Math.round(base.voiceCount ?? directive.voiceCount ?? inferSlashVoiceCount(
        text,
        base.kind ?? directive.kind ?? undefined,
      )),
      1,
      MAX_SLASH_VOICES,
    ),
    instrumentName: base.instrumentName?.trim() || directive.instrumentName.trim() || "钢琴",
    title: base.title || directive.title,
    subtitle: base.subtitle || directive.subtitle,
    composer: base.composer || directive.composer,
    arranger: base.arranger || directive.arranger,
    lyricist: base.lyricist || directive.lyricist,
    tempoBpm: base.tempoBpm,
    tempoBeatUnit: base.tempoBeatUnit ?? directive.tempoBeatUnit ?? "quarter",
    fifths: base.fifths,
    beats: base.beats,
    beatType: base.beatType,
    symbolDurations: { ...base.symbolDurations },
    multiDurationSymbols: base.multiDurationSymbols
      ?? directive.multiDurationSymbols
      ?? false,
    spaceDivision: base.spaceDivision,
    noteDivision: base.noteDivision,
    wholeMeasureGroups: base.wholeMeasureGroups
      ?? directive.wholeMeasureGroups
      ?? undefined,
    sourceTimedRows: base.sourceTimedRows ?? directive.sourceTimedRows,
    adjacentAsChord: base.adjacentAsChord ?? directive.adjacentAsChord,
    emptyGroupsAsRests: base.emptyGroupsAsRests
      ?? directive.emptyGroupsAsRests
      ?? false,
    showExplicitRests: base.showExplicitRests
      ?? directive.showExplicitRests
      ?? true,
    braceMode: base.braceMode,
    bracketMode: base.bracketMode ?? directive.bracketMode ?? "triplet",
    barMode: base.barMode ?? directive.barMode ?? "none",
    angleMode: base.angleMode ?? directive.angleMode ?? "grace",
    parenMode: base.parenMode ?? directive.parenMode ?? "chord",
    ordering: base.ordering ?? directive.ordering,
    tempoMarks: base.tempoMarks ?? directive.tempoMarks,
    keyChanges: base.keyChanges ?? directive.keyChanges,
    annotations: base.annotations ?? directive.annotations,
    noteTimingEdits: base.noteTimingEdits?.length
      ? base.noteTimingEdits
      : directive.noteTimingEdits,
  };
}

function readableQuarterLength(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

/**
 * Validate the editable slash-score time grid without refusing to render it.
 * A closed source row is a committed measure and therefore receives an error
 * when one beat is short/long. The final, not-yet-closed slash group is treated
 * as live typing instead: only its line number becomes yellow.
 */
export function slashScoreDiagnostics(
  text: string,
  baseOptions: SlashScoreOptions,
): SlashScoreDiagnostic[] {
  const options = optionsWithDirectives(text, baseOptions);
  if (options.sourceTimedRows) {
    const projected = projectSourceTimedRows(text, options);
    return mapProjectedDiagnostics(slashScoreDiagnostics(projected.text, projected.options), projected.sourceOffsets, text);
  }
  const records = sourceLineRecords(text);
  const meterLine = /^\s*(\d{1,2})\s*\/\s*(2|4|8|16)\s*拍\s*[：:]\s*$/;
  let activeMeter = {
    beats: options.beats,
    beatType: options.beatType as 2 | 4 | 8 | 16,
  };
  const selected: Array<{
    record: SourceLineRecord;
    meter: { beats: number; beatType: 2 | 4 | 8 | 16 };
  }> = [];
  records.forEach((record, index) => {
    const changed = meterLine.exec(record.raw);
    if (changed) {
      activeMeter = {
        beats: clamp(Number(changed[1]), 1, 32),
        beatType: Number(changed[2]) as 2 | 4 | 8 | 16,
      };
    }
    if (selectedScoreLine(records, index, options.kind)) {
      selected.push({ record, meter: { ...activeMeter } });
    }
  });
  if (selected.length === 0) return [];

  const delimiterDiagnostics: SlashScoreDiagnostic[] = [];
  selected.forEach(({ record }, selectedIndex) => {
    const scan = (from: number, to: number): void => {
      for (let cursor = from; cursor < to;) {
        const container = slashContainerAt(record.text, cursor, options);
        if (container && container.end <= to) {
          if (container.spec.mode === "none") {
            delimiterDiagnostics.push({
              severity: "error",
              line: record.line,
              from: record.from + cursor,
              to: record.from + container.end,
              measureIndices: [selectedIndex],
              beatLocations: [],
              message: `${container.spec.open}${container.spec.close} 尚未分配括号功能，请在乐谱设置中指定用途或删除该括号`,
            });
          }
          scan(container.bodyFrom, container.bodyTo);
          cursor = container.end;
          continue;
        }
        const disabled = slashDelimiterSpecs(options).find((spec) =>
          spec.mode === "none" && record.text.startsWith(spec.open, cursor));
        if (disabled) {
          delimiterDiagnostics.push({
            severity: "error",
            line: record.line,
            from: record.from + cursor,
            to: record.from + cursor + disabled.open.length,
            measureIndices: [selectedIndex],
            beatLocations: [],
            message: `${disabled.open}${disabled.close} 尚未分配括号功能且没有正确闭合`,
          });
          cursor += disabled.open.length;
        } else {
          cursor++;
        }
      }
    };
    scan(0, record.text.length);
  });

  const inferred = inferSlashMeter(
    text,
    options.symbolDurations,
    options.spaceDivision,
    options.braceMode,
    options.noteDivision,
    options.bracketMode ?? "triplet",
    options.kind,
    options,
  );
  const mappings = effectiveMappings(options);
  const diagnostics: SlashScoreDiagnostic[] = [...delimiterDiagnostics];
  let nextMeasure = 0;

  selected.forEach(({ record, meter }, recordIndex) => {
    const measureLength = meter.beats * 4 / meter.beatType;
    const expectedGroups = groupsForMeter({
      ...inferred,
      beats: meter.beats,
      beatType: meter.beatType,
    });
    const groupDuration = measureLength / Math.max(1, expectedGroups);
    const wholeMeasureGroups = options.wholeMeasureGroups ?? slashGroupsUseWholeMeasures(
      [record.text],
      options,
      groupDuration,
      measureLength,
    );
    const continuous = selected.length === 1
      && !wholeMeasureGroups
      && splitGroups(record.text).length > expectedGroups;
    const groups = splitGroups(record.text);
    const closed = record.text.trimEnd().endsWith("/");
    const errors: string[] = [];
    const errorMeasures = new Set<number>();
    const errorLocations = new Map<string, {
      measureIndex: number;
      beatIndex: number | null;
      beatCount: number;
    }>();
    const incompleteMeasures = new Set<number>();
    const firstHasSound = recordIndex === 0 && groups.some((group) =>
      groupHasContent(group, options) && !isRestOnlyGroup(group, options));
    const openingPickup = recordIndex === 0 && firstHasSound && (
      wholeMeasureGroups || (groups.length > 0 && groups.length < expectedGroups)
    );

    const measureForGroup = (groupIndex: number): number => {
      if (wholeMeasureGroups) return nextMeasure + groupIndex;
      if (continuous) return Math.floor(groupIndex / expectedGroups);
      return nextMeasure;
    };
    const targetForGroup = wholeMeasureGroups ? measureLength : groupDuration;
    const addErrorLocation = (
      measureIndex: number,
      beatIndex: number | null,
    ): void => {
      const normalizedBeat = beatIndex !== null
        && beatIndex >= 0
        && beatIndex < expectedGroups
        ? beatIndex
        : null;
      errorLocations.set(
        `${measureIndex}:${normalizedBeat === null ? "*" : normalizedBeat}`,
        {
          measureIndex,
          beatIndex: normalizedBeat,
          beatCount: Math.max(1, expectedGroups),
        },
      );
    };
    const beatForGroup = (groupIndex: number): number | null => {
      if (wholeMeasureGroups) return null;
      if (continuous) return groupIndex % expectedGroups;
      return groupIndex < expectedGroups ? groupIndex : null;
    };

    groups.forEach((group, groupIndex) => {
      const measureIndex = measureForGroup(groupIndex);
      const beatIndex = beatForGroup(groupIndex);
      const groupOffset = beatIndex === null ? 0 : beatIndex * groupDuration;
      const semanticMordentInGroup = options.annotations?.some((annotation) =>
        annotation.type === "ornament"
        && (annotation.kind === "upper-mordent" || annotation.kind === "lower-mordent")
        && annotation.measure === measureIndex
        && annotation.offset >= groupOffset - 1 / 192
        && annotation.offset < groupOffset + targetForGroup - 1 / 192) ?? false;
      let duration = segmentMarkerDuration(
        group,
        mappings,
        options.braceMode,
        options.noteDivision,
        options.bracketMode ?? "triplet",
        { ...options, durationMeasure: measureIndex, durationOffset: groupOffset },
        options.annotations?.some((annotation) => annotation.type === "triplet"
          && annotation.beatSlices && annotation.measure === measureIndex
          && annotation.offset < groupOffset + targetForGroup - 1e-8
          && annotation.end! > groupOffset + 1e-8) ? undefined : targetForGroup,
        semanticMordentInGroup,
        options.voiceCount,
        options.annotations?.some((annotation) => annotation.type === "triplet"
          && annotation.beatSlices && annotation.measure === measureIndex
          && annotation.offset < groupOffset + targetForGroup - 1e-8
          && annotation.end! > groupOffset + 1e-8),
      );
      const metadataTuplets = (options.annotations ?? []).filter((annotation): annotation is Extract<
        NotationAnnotationData,
        { type: "triplet" }
      > => annotation.type === "triplet"
        && annotation.end !== undefined
        && annotation.measure === measureIndex
        && annotation.offset < groupOffset + targetForGroup - 1 / 192
        && annotation.end > groupOffset + 1 / 192)
        .sort((left, right) => left.offset - right.offset || right.end! - left.end!);
      let tupletCorrection = 0;
      if (metadataTuplets.length > 0) {
        const clusters: Array<{ start: number; end: number; sliced: boolean }> = [];
        for (const annotation of metadataTuplets) {
          const previous = clusters[clusters.length - 1];
          if (previous && annotation.offset < previous.end - 1e-8) {
            previous.end = Math.max(previous.end, annotation.end!);
            previous.sliced ||= annotation.beatSlices === true;
          } else {
            clusters.push({ start: annotation.offset, end: annotation.end!, sliced: annotation.beatSlices === true });
          }
        }
        const containers: string[] = [];
        for (let cursor = 0; cursor < group.length;) {
          const container = slashContainerAt(group, cursor, options);
          if (!container) {
            cursor++;
            continue;
          }
          if (container.spec.mode === "triplet") {
            containers.push(group.slice(cursor, container.end));
          }
          cursor = container.end;
        }
        const startingClusters = clusters.filter((cluster) => cluster.sliced || cluster.start >= groupOffset - 1 / 192);
        for (let index = 0; index < Math.min(startingClusters.length, containers.length); index++) {
          const naive = segmentMarkerDuration(
            containers[index]!,
            mappings,
            options.braceMode,
            options.noteDivision,
            options.bracketMode ?? "triplet",
            options,
            undefined,
            false,
            options.voiceCount,
            startingClusters[index]!.sliced,
          );
          // A metadata-backed bracket may cover several slash beat groups.
          // The later groups keep their ruler placeholders; only charge this
          // group's intersection here, while still diagnosing extra suffixes.
          const cluster = startingClusters[index]!;
          const actual = cluster.end > measureLength + 1e-8
            ? cluster.end - cluster.start
            : Math.min(cluster.end, groupOffset + targetForGroup) - Math.max(cluster.start, groupOffset);
          duration += actual - naive;
          tupletCorrection += actual - naive;
        }
        // Separate printed triplet brackets contribute to one beat ruler.
        // The scalar scanner caps parallel voices before these brackets are
        // reconciled, so applying their differences afterward can invent a
        // short beat. Use its uncapped syntax duration when every complete
        // metadata cluster has exactly one printed bracket in this beat.
        // Suffix duration glyphs remain part of that syntax duration.
        const completeIndependentClusters = startingClusters.length >= 2
          && startingClusters.length === clusters.length
          && startingClusters.length === containers.length
          && clusters.every((cluster) => !cluster.sliced
            && cluster.start >= groupOffset - 1e-8
            && cluster.end <= groupOffset + targetForGroup + 1e-8)
          && metadataTuplets.every((annotation) =>
            (annotation.ordinary ?? []).every((ordinary) =>
              ordinary.offset + ordinary.duration <= groupOffset + targetForGroup + 1e-8));
        if (completeIndependentClusters) {
          duration = segmentMarkerDuration(
            group, mappings, options.braceMode, options.noteDivision,
            options.bracketMode ?? "triplet", { ...options, durationMeasure: measureIndex, durationOffset: groupOffset }, undefined,
            semanticMordentInGroup, options.voiceCount, false,
          ) + tupletCorrection;
        }
      }
      if (isRestOnlyGroup(group, options) || group.length === 0) {
        duration = targetForGroup;
      } else if (duration <= 1e-8 && groupHasContent(group, options)) {
        // A single unmarked pitch inherits the remainder of its slash group.
        duration = targetForGroup;
      }

      if (duration > targetForGroup + 1e-8) {
        errorMeasures.add(measureIndex);
        addErrorLocation(measureIndex, beatForGroup(groupIndex));
        errors.push(
          `第 ${groupIndex + 1} 拍写了 ${readableQuarterLength(duration)} 个四分音符，`
          + `超过 ${readableQuarterLength(targetForGroup)} 个四分音符`,
        );
        return;
      }
      if (duration >= targetForGroup - 1e-8) return;
      if (openingPickup && measureIndex === 0) return;
      const liveFinalGroup = !closed && groupIndex === groups.length - 1;
      if (liveFinalGroup) {
        incompleteMeasures.add(measureIndex);
      } else {
        errorMeasures.add(measureIndex);
        addErrorLocation(measureIndex, beatForGroup(groupIndex));
        errors.push(
          `第 ${groupIndex + 1} 拍只有 ${readableQuarterLength(duration)} 个四分音符，`
          + `应为 ${readableQuarterLength(targetForGroup)} 个四分音符`,
        );
      }
    });

    if (!wholeMeasureGroups) {
      const remainder = continuous ? groups.length % expectedGroups : groups.length;
      const structurallyShort = remainder > 0 && remainder < expectedGroups;
      if (structurallyShort && !openingPickup) {
        const measureIndex = continuous
          ? Math.floor(groups.length / expectedGroups)
          : nextMeasure;
        if (!closed) {
          incompleteMeasures.add(measureIndex);
        } else {
          errorMeasures.add(measureIndex);
          for (let beat = remainder; beat < expectedGroups; beat++) {
            addErrorLocation(measureIndex, beat);
          }
          errors.push(`小节只有 ${remainder}/${expectedGroups} 个拍组`);
        }
      }
      if (!continuous && groups.length > expectedGroups) {
        errorMeasures.add(nextMeasure);
        addErrorLocation(nextMeasure, null);
        errors.push(`一行包含 ${groups.length} 个拍组，当前拍号只允许 ${expectedGroups} 个`);
      }
    }

    if (!closed && errors.length === 0) {
      incompleteMeasures.add(measureForGroup(Math.max(0, groups.length - 1)));
    }

    if (errors.length > 0) {
      diagnostics.push({
        severity: "error",
        line: record.line,
        from: record.from,
        to: record.to,
        measureIndices: [...errorMeasures].sort((left, right) => left - right),
        beatLocations: errorLocations.size > 0
          ? [...errorLocations.values()]
          : [...errorMeasures].map((measureIndex) => ({
            measureIndex,
            beatIndex: null,
            beatCount: Math.max(1, expectedGroups),
          })),
        message: `第 ${record.line} 行小节时值错误：${errors.slice(0, 2).join("；")}`,
      });
    } else if (incompleteMeasures.size > 0) {
      diagnostics.push({
        severity: "incomplete",
        line: record.line,
        from: record.from,
        to: record.to,
        measureIndices: [...incompleteMeasures].sort((left, right) => left - right),
        beatLocations: [],
        message: `第 ${record.line} 行正在输入：当前拍尚未用 / 完成`,
      });
    }

    if (wholeMeasureGroups) nextMeasure += groups.length;
    else if (continuous) nextMeasure = Math.ceil(groups.length / expectedGroups);
    else nextMeasure++;
  });
  return diagnostics;
}

function splitTimedEventsByVoice(
  options: SlashScoreOptions,
  events: readonly TimedEvent[],
  sources: readonly SlashPitchSource[],
): TimedEvent[] {
  if (options.voiceCount <= 1) {
    const clones = new Map<TimedEvent, TimedEvent>();
    const result = events.map((event) => {
      const clone: TimedEvent = { ...event, voiceIndex: 0, continuationOf: undefined };
      clones.set(event, clone);
      return clone;
    });
    events.forEach((event, index) => {
      if (event.continuationOf) {
        result[index].continuationOf = clones.get(event.continuationOf);
      }
    });
    return result;
  }
  const sourceGroups = new Map<number, SlashPitchSource[]>();
  for (const source of sources) {
    const group = sourceGroups.get(source.eventIndex) ?? [];
    group.push(source);
    sourceGroups.set(source.eventIndex, group);
  }
  const consumed = new Set<number>();
  const result: TimedEvent[] = [];
  const splitBySource = new Map<TimedEvent, Map<number, TimedEvent>>();
  const authoritativeTupletPitches = new Map<number, Array<{ pitches: number[]; eventIndex: number }>>();
  const remember = (source: TimedEvent, voice: number, clone: TimedEvent): void => {
    const voices = splitBySource.get(source) ?? new Map<number, TimedEvent>();
    voices.set(voice, clone);
    splitBySource.set(source, voices);
  };
  // Metadata-backed voice-local Tuplets are already separated by voice in
  // parseGroup(). Preserve those authoritative events before matching the
  // ordinary pitch-source stream. A visible mixed atom such as `(A⁣W)` has
  // one Tuplet event for A and one parallel binary event for W; trying to
  // rematch A through the combined source chord can consume it as an earlier
  // equal pitch and erase the Tuplet's first member.
  events.forEach((event, index) => {
    if (event.continuationOf || event.voiceIndex === undefined
      || (!event.metadataVoice && (event.tripletGroup === undefined
        || event.voiceIndex !== options.voiceCount - 1))) return;
    const voice = clamp(event.voiceIndex, 0, options.voiceCount - 1);
    const clone: TimedEvent = {
      ...event,
      pitches: [...event.pitches],
      voiceIndex: voice,
      continuationOf: undefined,
      restVoiceIndexes: undefined,
    };
    result.push(clone);
    consumed.add(index);
    remember(event, voice, clone);
    if (event.pitches.length > 0) {
      const queue = authoritativeTupletPitches.get(voice) ?? [];
      queue.push({ pitches: [...event.pitches].sort((left, right) => left - right), eventIndex: index });
      authoritativeTupletPitches.set(voice, queue);
    }
  });
  let cursor = 0;
  for (const sources of sourceGroups.values()) {
    let main = sources.filter((source) => !source.grace);
    const completePitches = main.map((source) => source.pitch).sort((a, b) => a - b);
    const nextCommonEvent = events.findIndex((event, index) => index >= cursor
      && !consumed.has(index) && !event.continuationOf
      && event.pitches.length === completePitches.length
      && containsPitchMultiplicity(event.pitches, completePitches));
    let consumedOwnedThrough = cursor - 1;
    // The pre-pass above has already materialized each explicitly owned
    // default-voice Tuplet event. Remove exactly those source pitches before
    // matching the remaining ordinary timeline. Without this consumption a
    // newly filled member such as `[⁣⁣V.⁣⁣A.⁣⁣0.]` searched for that A again,
    // stole a later ordinary A event, and shifted every following V1 source.
    // Match per voice and by pitch multiset so a mixed visible atom can still
    // leave its non-Tuplet voice (for example G in `(V⁣G)`) to be processed.
    for (const [voice, queue] of authoritativeTupletPitches) {
      const pending = queue[0];
      if (!pending) continue;
      // An identical pitch in an earlier shared Tuplet belongs to that
      // actual source column, not to a later metadata-owned member. Keep the
      // source chronology when consuming the pre-materialized voice queue.
      if (nextCommonEvent >= 0 && nextCommonEvent < pending.eventIndex) continue;
      const expected = pending.pitches;
      const owned = main.filter((source) => source.tripletSource
        && source.voiceIndex === voice + 1);
      const actual = owned.map((source) => source.pitch).sort((left, right) => left - right);
      if (actual.length !== expected.length
        || !actual.every((pitch, index) => pitch === expected[index])) continue;
      const remaining = [...expected];
      main = main.filter((source) => {
        if (!source.tripletSource || source.voiceIndex !== voice + 1) return true;
        const pitchIndex = remaining.indexOf(source.pitch);
        if (pitchIndex < 0) return true;
        remaining.splice(pitchIndex, 1);
        return false;
      });
      queue.shift();
      consumedOwnedThrough = Math.max(consumedOwnedThrough, pending.eventIndex);
    }
    if (main.length === 0) {
      cursor = Math.max(cursor, consumedOwnedThrough + 1);
      continue;
    }
    const expected = main.map((source) => source.pitch).sort((a, b) => a - b);
    let matched = -1;
    for (let index = cursor; index < events.length; index++) {
      if (consumed.has(index) || events[index].continuationOf) continue;
      const actual = [...events[index].pitches].sort((a, b) => a - b);
      if (actual.length === expected.length && containsPitchMultiplicity(actual, expected)) {
        matched = index;
        break;
      }
    }
    if (matched < 0) {
      matched = events.findIndex((event, index) =>
        !consumed.has(index) && !event.continuationOf
        && event.pitches.length === expected.length
        && containsPitchMultiplicity(event.pitches, expected));
    }
    if (matched < 0) continue;
    consumed.add(matched);
    cursor = Math.max(cursor, matched + 1, consumedOwnedThrough + 1);
    const sourceEvent = events[matched];
    for (let voice = 1; voice <= options.voiceCount; voice++) {
      const pitches = main
        .filter((source) => source.voiceIndex === voice)
        .map((source) => source.pitch);
      const explicitRest = sourceEvent.restVoiceIndexes?.includes(voice - 1) ?? false;
      if (pitches.length === 0 && !explicitRest) continue;
      const gracePitches = sources
        .filter((source) => source.grace && source.voiceIndex === voice)
        .map((source) => [source.pitch]);
      const arpeggioPitches = sourceEvent.arpeggioPitches?.filter((pitch) => pitches.includes(pitch));
      const clone: TimedEvent = {
        ...sourceEvent,
        pitches: pitches.length > 0 ? pitches : [],
        voiceIndex: voice - 1,
        ornamentKind: sourceEvent.voiceIndex === undefined
          || sourceEvent.voiceIndex === voice - 1
          ? sourceEvent.ornamentKind
          : undefined,
        continuationOf: undefined,
        restVoiceIndexes: undefined,
        gracePitches: gracePitches.length > 0 ? gracePitches : undefined,
        arpeggioPitches: arpeggioPitches?.length ? arpeggioPitches : undefined,
        arpeggio: Boolean(sourceEvent.arpeggio && arpeggioPitches?.length),
      };
      result.push(clone);
      remember(sourceEvent, voice - 1, clone);
    }
  }
  events.forEach((event, index) => {
    if (!consumed.has(index) && !event.continuationOf) {
      const voices = event.restVoiceIndexes?.length
        ? [...new Set(event.restVoiceIndexes)]
        : [event.voiceIndex ?? options.voiceCount - 1];
      for (const rawVoice of voices) {
        const voice = clamp(rawVoice, 0, options.voiceCount - 1);
        const clone: TimedEvent = {
          ...event,
          pitches: event.restVoiceIndexes?.length ? [] : [...event.pitches],
          voiceIndex: voice,
          continuationOf: undefined,
          restVoiceIndexes: undefined,
        };
        result.push(clone);
        remember(event, voice, clone);
      }
    }
  });

  // A duration marker at the start of a slash group is an explicit visual
  // continuation.  It has no pitch token of its own, so copy the per-voice
  // pitches and ownership from the event it continues.  The previous
  // implementation dropped these events after splitting the common TXT
  // timeline, which made multi-voice conversions lose either the faint
  // continuation chord or its tie.
  for (const event of events) {
    if (!event.continuationOf) continue;
    const parents = splitBySource.get(event.continuationOf);
    if (!parents) continue;
    const continuations = new Map<number, TimedEvent>();
    for (const [voice, parent] of parents) {
      const clone: TimedEvent = {
        ...event,
        pitches: [...parent.pitches],
        voiceIndex: voice,
        continuationOf: parent,
        gracePitches: undefined,
        arpeggioPitches: undefined,
        arpeggioGroups: undefined,
        arpeggio: false,
        restVoiceIndexes: undefined,
      };
      result.push(clone);
      continuations.set(voice, clone);
    }
    splitBySource.set(event, continuations);
  }
  return result.sort((left, right) =>
    left.start - right.start ||
    (left.voiceIndex ?? 0) - (right.voiceIndex ?? 0) ||
    Number(Boolean(left.continuationOf)) - Number(Boolean(right.continuationOf)));
}

function continuationRoot(event: TimedEvent): TimedEvent {
  let result = event;
  const visited = new Set<TimedEvent>();
  while (result.continuationOf && !visited.has(result)) {
    visited.add(result);
    result = result.continuationOf;
  }
  return result;
}

const METRICAL_DURATION_VALUES = [
  { value: 4, alignment: 4 },
  // A dotted half may begin on any quarter-note beat as long as it remains
  // inside the measure. This lets a quarter + half continuation tail collapse
  // into one readable three-beat continuation.
  { value: 3, alignment: 1 },
  // Continuation tails may combine two adjacent quarter-note beats into one
  // half note from any exact beat, not only beats 1 and 3 of a 4/4 measure.
  { value: 2, alignment: 1 },
  // A dotted quarter is readable from every exact quarter-note beat.  A
  // quarter followed by its tied eighth continuation therefore collapses to
  // one dotted quarter instead of retaining a gray eighth at the next beat.
  { value: 1.5, alignment: 1 },
  { value: 1, alignment: 1 },
  { value: 0.75, alignment: 1 },
  { value: 0.5, alignment: 0.5 },
  { value: 0.375, alignment: 0.5 },
  { value: 0.25, alignment: 0.25 },
  { value: 0.1875, alignment: 0.25 },
  { value: 0.125, alignment: 0.125 },
  { value: 0.09375, alignment: 0.125 },
  { value: 0.0625, alignment: 0.0625 },
] as const;

/**
 * Return only the internal starts required to spell one sustained sound
 * metrically. A half/whole note on its legal beat has no internal boundary;
 * an off-beat or bar-crossing value receives the minimum readable tie chain.
 */
function metricalContinuationStarts(
  start: number,
  end: number,
  measureDuration: number,
  beatDuration: number,
): number[] {
  const starts: number[] = [];
  let cursor = Math.round(start * 192) / 192;
  const final = Math.round(end * 192) / 192;
  let guard = 0;
  while (cursor < final - 1e-8 && guard++ < 4096) {
    const measureIndex = Math.max(0, Math.floor((cursor + 1e-8) / measureDuration));
    const measureStart = measureIndex * measureDuration;
    const measureEnd = measureStart + measureDuration;
    const available = Math.min(final, measureEnd) - cursor;
    const local = cursor - measureStart;
    const beatIndex = Math.floor((local + 1e-8) / beatDuration);
    const nextBeat = Math.min(measureDuration, (beatIndex + 1) * beatDuration);
    const availableInBeat = Math.max(0, nextBeat - local);
    const written = METRICAL_DURATION_VALUES.find((candidate) => {
      const cell = local / candidate.alignment;
      // For a 1¾-beat span, quarter + tied dotted-eighth is clearer than
      // dotted-quarter + tied sixteenth.  Use the dotted quarter when it
      // exactly consumes the requested 1½ beats, not when it leaves that
      // unnecessarily short tail.
      const leavesShortTail =
        Math.abs(candidate.value - 1.5) <= 1e-8
        && available > 1.5 + 1e-8
        && available < 2 - 1e-8;
      return candidate.value <= available + 1e-8
        && !leavesShortTail
        && (
          Math.abs(cell - Math.round(cell)) <= 1e-8
          || candidate.value <= availableInBeat + 1e-8
        );
    });
    const value = written?.value ?? Math.min(available, 1 / 16);
    if (value <= 1e-9) break;
    cursor = Math.round((cursor + value) * 192) / 192;
    if (cursor < final - 1e-8) starts.push(cursor);
  }
  return starts;
}

type SlashMeasureMeter = { beats: number; beatType: 2 | 4 | 8 | 16 };

interface SharedTripletRegion {
  key: string;
  start: number;
  end: number;
}

function sharedTripletRegions(events: readonly TimedEvent[]): SharedTripletRegion[] {
  const regions = new Map<string, SharedTripletRegion>();
  for (const event of events) {
    if (!event.tripletGroup || event.tripletScope === "voice" && !event.tripletSpelling
      || event.continuationOf && !event.tripletSpelling) continue;
    const region = regions.get(event.tripletGroup) ?? {
      key: event.tripletGroup, start: event.start, end: event.tripletEnd ?? event.end,
    };
    region.start = Math.min(region.start, event.start);
    region.end = Math.max(region.end, event.tripletEnd ?? event.end);
    regions.set(region.key, region);
  }
  return [...regions.values()].sort((left, right) => left.start - right.start);
}

function isBinaryWrittenDuration(duration: number): boolean {
  return Math.abs(duration * 32 - Math.round(duration * 32)) <= 1e-8;
}

function metricalContinuationStartsByMeasure(
  start: number,
  end: number,
  options: SlashScoreOptions,
  measureStarts: readonly number[],
  measureMeters: readonly SlashMeasureMeter[],
): number[] {
  const fallback: SlashMeasureMeter = {
    beats: options.beats,
    beatType: options.beatType as 2 | 4 | 8 | 16,
  };
  if (measureStarts.length === 0) {
    const measureDuration = fallback.beats * 4 / fallback.beatType;
    const compound = fallback.beatType === 8
      && fallback.beats >= 6
      && fallback.beats % 3 === 0;
    const groups = Math.max(1, compound ? fallback.beats / 3 : fallback.beats);
    return metricalContinuationStarts(start, end, measureDuration, measureDuration / groups);
  }

  const starts: number[] = [];
  let cursor = start;
  let guard = 0;
  while (cursor < end - 1e-8 && guard++ < measureStarts.length + 8) {
    // The meter boundaries are sorted. Locate the last start at or before
    // cursor with the same tolerance as the former linear scan.
    let low = 0;
    let high = measureStarts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (measureStarts[middle] <= cursor + 1e-8) low = middle + 1;
      else high = middle;
    }
    const measureIndex = low > 0 ? low - 1 : measureStarts.length - 1;
    const meter = measureMeters[measureIndex] ?? fallback;
    const measureStart = measureStarts[measureIndex] ?? 0;
    const measureDuration = meter.beats * 4 / meter.beatType;
    const measureEnd = measureStarts[measureIndex + 1] ?? measureStart + measureDuration;
    const compound = meter.beatType === 8
      && meter.beats >= 6
      && meter.beats % 3 === 0;
    const groups = Math.max(1, compound ? meter.beats / 3 : meter.beats);
    const segmentEnd = Math.min(end, measureEnd);
    starts.push(...metricalContinuationStarts(
      cursor - measureStart,
      segmentEnd - measureStart,
      measureDuration,
      measureDuration / groups,
    ).map((value) => measureStart + value));
    if (segmentEnd < end - 1e-8) starts.push(segmentEnd);
    if (segmentEnd <= cursor + 1e-8) break;
    cursor = segmentEnd;
  }
  return [...new Set(starts.map((value) => Math.round(value * 192) / 192))]
    .filter((value) => value > start + 1e-8 && value < end - 1e-8)
    .sort((left, right) => left - right);
}

/** Ordinary sustained notes can enter a shared triplet before their next
 * attack. Spell that fractional tail on the known 3:2 clock instead of
 * greedily subtracting binary values (1/3 -> 1/4 + 1/16 + 1/48). */
function metricalContinuationStartsWithTuplets(
  start: number,
  end: number,
  options: SlashScoreOptions,
  measureStarts: readonly number[],
  measureMeters: readonly SlashMeasureMeter[],
  regions: readonly SharedTripletRegion[],
): number[] {
  const fractional = regions.flatMap((region) => {
    const from = Math.max(start, region.start), to = Math.min(end, region.end);
    return to > from + 1e-8 && !isBinaryWrittenDuration(to - from)
      && isBinaryWrittenDuration((to - from) * 1.5)
      ? [{ from, to }] : [];
  });
  if (fractional.length === 0) {
    return metricalContinuationStartsByMeasure(start, end, options, measureStarts, measureMeters);
  }
  const boundaries = [...new Set([start, end, ...fractional.flatMap((range) => [range.from, range.to])])]
    .sort((left, right) => left - right);
  const result: number[] = [];
  for (let index = 0; index + 1 < boundaries.length; index++) {
    const from = boundaries[index]!, to = boundaries[index + 1]!;
    if (from > start + 1e-8) result.push(from);
    if (!fractional.some((range) => from >= range.from - 1e-8 && to <= range.to + 1e-8)) {
      result.push(...metricalContinuationStartsByMeasure(from, to, options, measureStarts, measureMeters));
      continue;
    }
    let remaining = (to - from) * 1.5, cursor = from;
    const values = [...METRICAL_DURATION_VALUES.map((item) => item.value), 3 / 64, 1 / 32];
    for (const value of values) {
      while (remaining >= value - 1e-8) {
        remaining -= value;
        cursor += value * 2 / 3;
        if (cursor < to - 1e-8) result.push(cursor);
      }
    }
  }
  return [...new Set(result.map((value) => Math.round(value * 192) / 192))]
    .filter((value) => value > start + 1e-8 && value < end - 1e-8)
    .sort((left, right) => left - right);
}

/** Complete only voices whose sustained fractional values actually use the
 * shared triplet clock. A binary half note sounding underneath a triplet
 * remains a half note; a 2/3 + 1/3 accompaniment receives its own two-member
 * 3:2 spelling, including a source-less tied first member when necessary. */
function adoptSharedTripletSpelling(events: TimedEvent[], regions: readonly SharedTripletRegion[]): void {
  for (const region of regions) {
    const voices = new Set(events.filter((event) => event.start < region.end - 1e-8
      && event.end > region.start + 1e-8).map((event) => event.voiceIndex ?? 0));
    const sourceMemberCounts = new Map<number, number>();
    for (const event of events) {
      if (event.tripletGroup !== region.key || event.continuationOf) continue;
      const voice = event.voiceIndex ?? 0;
      sourceMemberCounts.set(voice, (sourceMemberCounts.get(voice) ?? 0) + 1);
    }
    const mostSourceMembers = Math.max(0, ...sourceMemberCounts.values());
    for (const voice of voices) {
      const members = events.filter((event) => (event.voiceIndex ?? 0) === voice
        && event.start >= region.start - 1e-8 && event.start < region.end - 1e-8)
        .sort((left, right) => left.start - right.start);
      if (members.length === 0 || Math.abs(members[0].start - region.start) > 1e-8) continue;
      // A shared printed bracket can overlap a separate voice-local tuplet.
      // That voice already owns its rhythm; do not fold its ordinary notes
      // and smaller tuplet into this region's different 3:2 clock.
      if (members.some((event) => event.tripletGroup && event.tripletGroup !== region.key)) continue;
      const spans = members.map((event) => Math.min(event.end, region.end) - event.start);
      if (!spans.some((span) => !isBinaryWrittenDuration(span))) {
        // The shared bracket can contain only the attack of a longer binary
        // accompaniment. Once another voice has been re-spelled, that lone
        // source atom must not become a one-member Tuplet plus a fractional
        // outside tail merely because the other group now has its own ID.
        for (const event of members) {
          if (event.tripletGroup !== region.key
            || (sourceMemberCounts.get(voice) ?? 0) >= mostSourceMembers
            || event.end <= (event.tripletEnd ?? event.end) + 1e-8
            || !isBinaryWrittenDuration(event.end - event.start)) continue;
          delete event.tripletGroup;
          delete event.tripletIndex;
          delete event.tripletEnd;
          delete event.tripletScope;
        }
        continue;
      }
      if (!spans.every((span) => span > 1e-8 && isBinaryWrittenDuration(span * 1.5))) continue;
      if (!members.some((event, index) => event.tripletGroup !== region.key
        || Math.abs((event.tripletEnd ?? event.end) - (event.start + spans[index]!)) > 1e-8)) continue;
      if (members.some((event, index) => index + 1 < members.length
        && Math.abs(event.start + spans[index]! - members[index + 1].start) > 1e-8)) continue;
      const key = `${region.key}:spelling:v${voice}`;
      members.forEach((event, index) => {
        event.tripletGroup = key;
        event.tripletIndex = index;
        event.tripletEnd = event.start + spans[index]!;
        event.tripletScope = "all";
        event.tripletSpelling = true;
      });
    }
  }
}

function restoreAnnotatedTripletContinuations(
  events: TimedEvent[],
  options: SlashScoreOptions,
  measureStarts: readonly number[],
): void {
  for (const annotation of options.annotations ?? []) {
    if (annotation.type !== "triplet" || !annotation.members
      || !annotation.memberContinuations?.some(Boolean)) continue;
    let start = (measureStarts[annotation.measure] ?? 0) + annotation.offset;
    for (let index = 0; index < annotation.members.length; index++) {
      const event = events.find((candidate) => candidate.voiceIndex === annotation.part
        && Math.abs(candidate.start - start) < 1e-8);
      if (event) event.tripletSpelling = true;
      if (annotation.memberContinuations[index]) {
        const previous = events.filter((candidate) => candidate.voiceIndex === annotation.part
          && candidate.start < start - 1e-8)
          .sort((left, right) => right.start - left.start)[0];
        if (event && event.pitches.length > 0 && previous && previous.end >= start - 1e-8
          && equalPitches([...event.pitches].sort((a, b) => a - b),
            [...previous.pitches].sort((a, b) => a - b))) {
          event.continuationOf = previous;
          event.syntheticContinuation = true;
          event.tripletSpelling = true;
        }
      }
      start += annotation.members[index]! * 2 / 3;
    }
  }
}

function splitVoicedWrittenDurations(
  events: readonly TimedEvent[],
  options: SlashScoreOptions,
): TimedEvent[] {
  if (options.voiceCount <= 1) return [...events];
  const result: TimedEvent[] = [];
  const firstByOriginal = new Map<TimedEvent, TimedEvent>();

  for (const event of events) {
    const total = event.end - event.start;
    if (total <= 1e-9) continue;
    let requested = event.writtenDurations?.filter((value) => value > 1e-9) ?? [total];
    const groupEdge = event.sourceGroupEnd;
    if (groupEdge !== undefined
      && groupEdge > event.start + 1e-9
      && groupEdge < event.end - 1e-9) {
      // A slash boundary is stronger than the adjacent intrinsic/symbol
      // contributions. Keep the attack readable up to that boundary, then
      // continue it faintly on the next group.
      requested = [groupEdge - event.start, event.end - groupEdge];
    }

    const pieces: number[] = [];
    let remaining = total;
    for (const value of requested) {
      if (remaining <= 1e-9) break;
      const kept = Math.min(value, remaining);
      if (kept > 1e-9) pieces.push(kept);
      remaining -= kept;
    }
    if (remaining > 1e-9) pieces.push(remaining);
    if (pieces.length === 0) pieces.push(total);

    let cursor = event.start;
    const first: TimedEvent = {
      ...event,
      end: cursor + pieces[0],
      writtenDurations: [pieces[0]],
    };
    firstByOriginal.set(event, first);
    result.push(first);
    cursor = first.end;
    let previous = first;
    for (const duration of pieces.slice(1)) {
      const continuation: TimedEvent = {
        ...event,
        start: cursor,
        end: cursor + duration,
        writtenDurations: [duration],
        continuationOf: previous,
        syntheticContinuation: true,
        gracePitches: undefined,
        arpeggio: false,
        arpeggioPitches: undefined,
        arpeggioGroups: undefined,
      };
      result.push(continuation);
      previous = continuation;
      cursor = continuation.end;
    }
  }

  for (const event of events) {
    if (!event.continuationOf) continue;
    const first = firstByOriginal.get(event);
    if (first) first.continuationOf = firstByOriginal.get(event.continuationOf)
      ?? event.continuationOf;
  }
  return result.sort((left, right) =>
    left.start - right.start
    || (left.voiceIndex ?? 0) - (right.voiceIndex ?? 0)
    || Number(Boolean(left.continuationOf)) - Number(Boolean(right.continuationOf)));
}

/**
 * TXT has one public time axis, while every marked voice sustains independently.
 * Every explicitly written pitch is a new attack, even when it repeats the
 * preceding pitch in the same slash group. Only the otherwise empty span until
 * that voice's next written attack is sustained, with source-less continuation
 * columns added at metrical boundaries. This distinction is required for a
 * JPW -> TXT round-trip: an explicitly repeated W remains a black W, while the
 * W generated at the following beat boundary is the gray tied destination.
 */
function addIndependentVoiceContinuations(
  events: readonly TimedEvent[],
  options: SlashScoreOptions,
  measureStarts: readonly number[],
  measureMeters: readonly SlashMeasureMeter[],
): TimedEvent[] {
  if (options.voiceCount <= 1) return [...events];
  const result = [...events];
  const tripletRegions = sharedTripletRegions(events);
  const sharedGroupEnds = new Map(tripletRegions.map((region) => [region.key, region.end]));
  const removed = new Set<TimedEvent>();
  const fallbackMeter: SlashMeasureMeter = {
    beats: options.beats,
    beatType: options.beatType as 2 | 4 | 8 | 16,
  };
  const lastMeter = measureMeters[measureMeters.length - 1] ?? fallbackMeter;
  const scoreEnd = measureStarts.length > 0
    ? (measureStarts[measureStarts.length - 1] ?? 0) + lastMeter.beats * 4 / lastMeter.beatType
    : fallbackMeter.beats * 4 / fallbackMeter.beatType;
  // Existing continuation chains are immutable while this pass visits other
  // attacks. Newly generated members belong only to the attack being handled
  // and are appended to its local chain below, so index the original members
  // once in result order instead of scanning every event for every attack.
  const continuationsByVoice = new Map<number, Map<TimedEvent, TimedEvent[]>>();
  for (const event of result) {
    if (!event.continuationOf) continue;
    const voice = event.voiceIndex ?? options.voiceCount - 1;
    let byRoot = continuationsByVoice.get(voice);
    if (!byRoot) {
      byRoot = new Map<TimedEvent, TimedEvent[]>();
      continuationsByVoice.set(voice, byRoot);
    }
    const root = continuationRoot(event);
    let chain = byRoot.get(root);
    if (!chain) {
      chain = [];
      byRoot.set(root, chain);
    }
    chain.push(event);
  }
  for (let voice = 0; voice < options.voiceCount; voice++) {
    const ordered = result
      .filter((event) => (event.voiceIndex ?? options.voiceCount - 1) === voice)
      .sort((left, right) =>
        left.start - right.start
        || Number(Boolean(left.continuationOf)) - Number(Boolean(right.continuationOf)));

    const attacks = ordered.filter((event) => !event.continuationOf);
    attacks.forEach((attack, index) => {
      let nextStart = attacks[index + 1]?.start ?? scoreEnd;
      const sourceChain = continuationsByVoice.get(voice)?.get(attack) ?? [];
      // A shared duration ruler can refer back past a voice-local tuplet.
      // A new attack in this voice ends the preceding sound: its printed
      // continuation must not survive underneath that attack or later notes.
      for (const continuation of sourceChain) {
        if (continuation.start >= nextStart - 1e-8) removed.add(continuation);
      }
      let chain = sourceChain
        .filter((event) => event.start > attack.start + 1e-8
          && event.start < nextStart - 1e-8);
      const memberEnd = attack.tripletBeatRuler ? nextStart
        : attack.tripletCrossBeat || attack.tripletScope === "voice"
          ? attack.tripletEnd : undefined;
      if (memberEnd !== undefined && memberEnd < nextStart - 1e-8
        && !chain.some((event) => !event.syntheticContinuation
          && Math.abs(event.start - memberEnd) <= 1e-8)) {
        // Empty time after an owned tuplet is silence unless TXT explicitly
        // continues that voice at the boundary. Do not manufacture a tie as
        // a side effect of preserving the member's unsplit duration.
        nextStart = memberEnd;
      }
      // Slash-group edges describe the compact TXT time grid, not mandatory
      // printed tie boundaries. Re-spell the complete sustained span against
      // the meter: a beat-aligned quarter + quarter becomes one half note and
      // a beat-aligned quarter + dotted-half becomes one whole note. The
      // metrical splitter still retains an internal boundary when the sound
      // starts off-beat or genuinely crosses a beat/bar in a value that cannot
      // be represented by one normal or dotted note.
      // The real 3:2 member is one indivisible rhythmic value. Splitting a
      // long member into binary metrical pieces produces tiny MIDI notes
      // whose quantization can leak into a later ordinary attack. Only the
      // sustain beyond the member's explicit boundary uses binary spelling.
      // A held member can continue into another shared 3:2 group. Keep
      // that boundary when its later fractional tail needs Tuplet spelling,
      // while an ordinary binary accompaniment remains one complete value.
      const sharedGroupEnd = attack.tripletBeatRuler && attack.tripletGroup
        ? sharedGroupEnds.get(attack.tripletGroup)
        : undefined;
      const fractionalTailStart = sharedGroupEnd !== undefined
        && tripletRegions.some((region) => {
          if (region.start < sharedGroupEnd - 1e-8 || region.start >= nextStart - 1e-8) return false;
          const span = Math.min(nextStart, region.end) - region.start;
          return !isBinaryWrittenDuration(span) && isBinaryWrittenDuration(span * 1.5);
        }) ? sharedGroupEnd : undefined;
      const ordinaryStart = Math.min(nextStart, Math.max(attack.start,
        fractionalTailStart ?? memberEnd ?? attack.start));
      const spanEdges = [ordinaryStart, nextStart];
      const requiredStarts: number[] = ordinaryStart > attack.start + 1e-8
        && ordinaryStart < nextStart - 1e-8 ? [ordinaryStart] : [];
      for (let span = 0; span + 1 < spanEdges.length; span++) {
        const spanStart = spanEdges[span];
        const spanEnd = spanEdges[span + 1];
        if (span > 0) requiredStarts.push(spanStart);
        requiredStarts.push(...metricalContinuationStartsWithTuplets(
          spanStart,
          spanEnd,
          options,
          measureStarts,
          measureMeters,
          tripletRegions,
        ));
      }
      const requiredKey = new Set(requiredStarts.map((value) => Math.round(value * 192)));

      // Source-less continuations are notation scaffolding. Keep only the
      // boundaries required by the metric spelling; explicitly written pitch
      // events are attacks and therefore never members of this chain.
      for (const continuation of chain) {
        if (!requiredKey.has(Math.round(continuation.start * 192))) {
          removed.add(continuation);
        }
      }
      chain = chain.filter((continuation) => !removed.has(continuation));

      for (const start of requiredStarts) {
        const hasStart = chain.some((continuation) =>
          Math.abs(continuation.start - start) <= 1e-8);
        if (hasStart) continue;
        const parent = [...chain]
          .filter((continuation) => continuation.start < start - 1e-8)
          .sort((left, right) => right.start - left.start)[0] ?? attack;
        const continuation: TimedEvent = {
          start,
          end: nextStart,
          pitches: [...attack.pitches],
          sourceGroupKey: attack.sourceGroupKey,
          sourceGroupEnd: attack.sourceGroupEnd,
          voiceIndex: voice,
          continuationOf: parent,
          syntheticContinuation: true,
        };
        result.push(continuation);
        chain.push(continuation);
      }
      chain.sort((left, right) => left.start - right.start);
      attack.end = chain[0]?.start ?? nextStart;
      chain.forEach((continuation, chainIndex) => {
        continuation.end = chain[chainIndex + 1]?.start ?? nextStart;
      });
    });
  }

  return result.filter((event) => !removed.has(event)).sort((left, right) =>
    left.start - right.start
    || (left.voiceIndex ?? 0) - (right.voiceIndex ?? 0)
    || Number(Boolean(left.continuationOf)) - Number(Boolean(right.continuationOf)));
}

function parsedMidiFromEvents(
  events: TimedEvent[],
  measures: number,
  options: SlashScoreOptions,
  measureMeters: readonly { beats: number; beatType: 2 | 4 | 8 | 16 }[] = [],
): ParsedMidi {
  const ppq = 960;
  const notes: ParsedMidiNote[] = [];
  const effectiveMeters = Array.from({ length: measures }, (_unused, index) =>
    measureMeters[index] ?? {
      beats: options.beats,
      beatType: options.beatType as 2 | 4 | 8 | 16,
    });
  const endQuarter = Math.max(1, effectiveMeters.reduce(
    (sum, meter) => sum + meter.beats * 4 / meter.beatType,
    0,
  ));
  const timeSignatures: Array<{ tick: number; beats: number; beatType: number }> = [];
  let meterStart = 0;
  effectiveMeters.forEach((meter, index) => {
    const previous = effectiveMeters[index - 1];
    if (index === 0 || !previous
      || previous.beats !== meter.beats
      || previous.beatType !== meter.beatType) {
      timeSignatures.push({
        tick: Math.round(meterStart * ppq),
        beats: meter.beats,
        beatType: meter.beatType,
      });
    }
    meterStart += meter.beats * 4 / meter.beatType;
  });
  if (options.voiceCount <= 1) {
    for (const event of events) {
      for (const pitch of event.pitches) {
        notes.push({
          startTick: Math.round(event.start * ppq),
          endTick: Math.max(Math.round(event.start * ppq) + 1, Math.round(event.end * ppq)),
          pitch,
          velocity: 88,
          channel: 0,
          track: 0,
        });
      }
    }
  } else {
    for (let voice = 0; voice < options.voiceCount; voice++) {
      const attacks = new Map<number, { start: number; end: number; pitches: number[] }>();
      for (const event of events) {
        if ((event.voiceIndex ?? options.voiceCount - 1) !== voice) continue;
        if (event.continuationOf) continue;
        const key = Math.round(event.start * 192);
        const attack = attacks.get(key) ?? { start: event.start, end: event.end, pitches: [] };
        attack.end = Math.max(attack.end, event.end);
        attack.pitches.push(...event.pitches);
        attacks.set(key, attack);
      }
      for (const event of events) {
        if ((event.voiceIndex ?? options.voiceCount - 1) !== voice || !event.continuationOf) continue;
        const root = continuationRoot(event);
        const attack = attacks.get(Math.round(root.start * 192));
        if (attack) attack.end = Math.max(attack.end, event.end);
      }
      const continuationStarts = [...new Set(events
        .filter((event) =>
          (event.voiceIndex ?? options.voiceCount - 1) === voice &&
          event.continuationOf)
        .map((event) => event.start))]
        .sort((left, right) => left - right);
      const ordered = [...attacks.values()].sort((left, right) => left.start - right.start);
      ordered.forEach((attack, index) => {
        // Per-voice events already include their legitimate continuation
        // chains. Respect that end, especially the silence after a closed
        // tuplet, instead of stretching its last pitch to the next attack.
        const end = Math.min(attack.end, ordered[index + 1]?.start ?? endQuarter);
        const boundaries = [
          attack.start,
          ...continuationStarts.filter((start) =>
            start > attack.start + 1e-8 && start < end - 1e-8),
          end,
        ];
        for (let segment = 0; segment + 1 < boundaries.length; segment++) {
          const startTick = Math.round(boundaries[segment] * ppq);
          const endTick = Math.max(startTick + 1, Math.round(boundaries[segment + 1] * ppq));
          for (const pitch of attack.pitches) {
            notes.push({
              startTick,
              endTick,
              pitch,
              velocity: 88,
              channel: voice,
              track: voice,
            });
          }
        }
      });
    }
  }
  return {
    format: options.voiceCount > 1 ? 1 : 0,
    ppq,
    trackCount: options.voiceCount,
    title: options.title,
    tracks: Array.from({ length: options.voiceCount }, (_unused, voice) => ({
      index: voice,
      name: options.voiceCount > 1
        ? `${options.instrumentName?.trim() || "钢琴"} V${voice + 1}`
        : options.kind === "keyboard" ? "键盘谱" : "数字谱",
      noteCount: notes.filter((note) => note.track === voice).length,
    })),
    notes,
    tempos: [{ tick: 0, bpm: options.tempoBpm }],
    timeSignatures,
    keySignatures: [{ tick: 0, fifths: options.fifths, minor: false }],
    ignoredEvents: 0,
    endTick: Math.round(endQuarter * ppq),
  };
}

interface PositionedChord {
  chord: Chord;
  partIndex: number;
  start: number;
  end: number;
  pitches: number[];
}

function chordPitches(chord: Chord): number[] {
  return chord.notes.filter((note) => !note.rest).map((note) => note.pitch).sort((a, b) => a - b);
}

/** Restore repeated pitches that the MIDI quantizer intentionally simplifies. */
function restoreSlashDuplicatePitches(score: Score, events: readonly TimedEvent[]): void {
  for (const event of events) {
    const desired = new Map<number, number>();
    for (const pitch of event.pitches) desired.set(pitch, (desired.get(pitch) ?? 0) + 1);
    if (![...desired.values()].some((count) => count > 1)) continue;
    const partIndex = clamp(event.voiceIndex ?? 0, 0, Math.max(0, score.parts.length - 1));
    const part = score.parts[partIndex];
    if (!part) continue;
    const chord = part.measures.flatMap((measure) => measure.entries
      .filter((entry): entry is Chord => entry instanceof Chord && !entry.rest)
      .map((entry) => ({
        entry,
        start: measure.position.toFloat() + entry.position.toFloat(),
      })))
      .find(({ start }) => Math.abs(start - event.start) <= 1e-8)?.entry;
    if (!chord) continue;
    for (const [pitch, count] of desired) {
      const matching = chord.notes.filter((note) => !note.rest && note.pitch === pitch);
      const template = matching[0];
      if (!template) continue;
      for (let index = matching.length; index < count; index++) {
        const duplicate = new Note(chord);
        duplicate.pitch = template.pitch;
        duplicate.step = template.step;
        duplicate.alter = template.alter;
        duplicate.octave = template.octave;
        duplicate.number = template.number;
        duplicate.jpOctave = template.jpOctave;
        duplicate.jpAlter = template.jpAlter;
        duplicate.displayText = template.displayText;
        duplicate.displayOctave = template.displayOctave;
        duplicate.displayAlter = template.displayAlter;
        duplicate.displayHidden = template.displayHidden;
        chord.add(duplicate);
      }
    }
  }
}

function equalPitches(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((pitch, index) => pitch === right[index]);
}

function linkContinuation(left: Chord, right: Chord): void {
  if (left === right) return;
  const used = new Set<Note>();
  for (const next of right.notes) {
    const previous = left.notes.find((note) =>
      !note.rest && note.pitch === next.pitch && !used.has(note));
    if (!previous || next.rest) continue;
    used.add(previous);
    previous.tieStart = true;
    previous.tieNext = next;
    next.tieEnd = true;
    next.tiePrev = previous;
  }
}

/** Re-apply slash-score continuation semantics after the MIDI quantizer built the editable Score. */
function applySlashContinuations(score: Score, events: readonly TimedEvent[]): void {
  const chords: PositionedChord[] = [];
  for (let partIndex = 0; partIndex < score.parts.length; partIndex++) {
    const part = score.parts[partIndex];
    for (const measure of part.measures) {
      const measureStart = measure.position.toFloat();
      for (const entry of measure.entries) {
        if (!(entry instanceof Chord) || entry.rest || !entry.duration) continue;
        const start = measureStart + entry.position.toFloat();
        chords.push({
          chord: entry,
          partIndex,
          start,
          end: start + entry.duration.toFloat(),
          pitches: chordPitches(entry),
        });
      }
    }
  }
  chords.sort((a, b) => a.start - b.start || a.end - b.end);
  const chordsByVoice = new Map<number, PositionedChord[]>();
  for (const item of chords) {
    let voiced = chordsByVoice.get(item.partIndex);
    if (!voiced) {
      voiced = [];
      chordsByVoice.set(item.partIndex, voiced);
    }
    voiced.push(item);
  }
  const firstChordAtOrAfter = (items: readonly PositionedChord[], start: number): number => {
    let low = 0;
    let high = items.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (items[middle].start < start) low = middle + 1;
      else high = middle;
    }
    return low;
  };

  const eventLastChord = new Map<TimedEvent, Chord>();
  for (const event of events) {
    const pitches = [...event.pitches].sort((a, b) => a - b);
    const voice = clamp(event.voiceIndex ?? 0, 0, Math.max(0, score.parts.length - 1));
    const voiced = chordsByVoice.get(voice) ?? [];
    let matching: PositionedChord[] = [];
    for (let index = firstChordAtOrAfter(voiced, event.start - 1e-8);
      index < voiced.length && voiced[index].start < event.end - 1e-8; index++) {
      const item = voiced[index];
      if (item.end <= event.end + 1e-8 && equalPitches(item.pitches, pitches)) {
        matching.push(item);
      }
    }
    if (matching.length === 0) {
      // Multi-voice TXT lets one voice sustain while another attacks.  Its
      // common source event can therefore end before the rebuilt per-voice MIDI
      // note does; keep the chord at the attack position as the tie-chain
      // anchor even when its reconstructed duration is longer.  The same rule
      // applies to an explicit continuation column whose voice remains active
      // after the common slash group ends.
      for (let index = firstChordAtOrAfter(voiced, event.start - 1e-8);
        index < voiced.length && voiced[index].start <= event.start + 1e-8; index++) {
        const item = voiced[index];
        if (Math.abs(item.start - event.start) <= 1e-8
          && equalPitches(item.pitches, pitches)) matching.push(item);
      }
    }
    if (matching.length === 0) continue;

    if (event.continuationOf) {
      const rootEvent = continuationRoot(event);
      let previous = eventLastChord.get(event.continuationOf)
        ?? eventLastChord.get(rootEvent)
        ??
        [...chords].reverse().find((item) =>
          item.partIndex === voice &&
          Math.abs(item.end - event.start) <= 1e-8 &&
          equalPitches(item.pitches, pitches))?.chord ?? null;
      for (let index = 0; index < matching.length; index++) {
        const item = matching[index];
        item.chord.transparentContinuation = true;
        item.chord.generatedTimingContinuation = true;
        item.chord.persistGeneratedContinuation = true;
        // A continuation split into several notated values is one tie chain,
        // not the generic slur used by the MIDI readability simplifier.
        item.chord.slurStart = false;
        item.chord.slurEnd = false;
        item.chord.slurEndChord = null;
        if (previous) linkContinuation(previous, item.chord);
        previous = item.chord;
      }
      eventLastChord.set(rootEvent, matching[matching.length - 1].chord);
    }
    eventLastChord.set(event, matching[matching.length - 1].chord);
  }

  // Preserve which MIDI-written pieces are continuation tails before replacing
  // the provisional links. Rebuilding them chronologically avoids self-links or
  // backward cycles when a voice has both source-duration and group-edge splits.
  for (const item of chords) {
    const sounding = item.chord.notes.filter((note) => !note.rest);
    if (sounding.length > 0
      && sounding.every((note) => note.tieEnd && note.tiePrev !== null)) {
      item.chord.transparentContinuation = true;
    }
  }
  for (const item of chords) {
    for (const note of item.chord.notes) {
      note.tieStart = false;
      note.tieEnd = false;
      note.tiePrev = null;
      note.tieNext = null;
    }
  }
  for (const item of chords) {
    if (!item.chord.transparentContinuation) continue;
    const adjacent = [...chords].reverse().find((candidate) =>
      candidate.partIndex === item.partIndex
      && candidate.chord !== item.chord
      && candidate.start < item.start - 1e-8
      && Math.abs(candidate.end - item.start) <= 1e-8);
    // Never search past a more recent different attack merely because an
    // older chord happens to have the same pitch. A tie may continue only the
    // immediately adjacent sounding event in this voice.
    if (adjacent && equalPitches(adjacent.pitches, item.pitches)) {
      linkContinuation(adjacent.chord, item.chord);
      item.chord.slurStart = false;
      item.chord.slurEnd = false;
      item.chord.slurEndChord = null;
    } else {
      item.chord.transparentContinuation = false;
      item.chord.generatedTimingContinuation = false;
      item.chord.persistGeneratedContinuation = false;
    }
  }

  // Every continuation here is source-less: explicitly written repeated
  // pitches remain normal attacks. Generated gray tails are excluded from
  // source-text selection matching.
  for (const item of chords) {
    if (!item.chord.transparentContinuation) continue;
    item.chord.generatedTimingContinuation = true;
    item.chord.persistGeneratedContinuation = true;
  }
}

function slashFraction(value: number): Fraction {
  return new Fraction(Math.round(value * 192), 192);
}

function setSlashWrittenDuration(chord: Chord, duration: number): void {
  const values = [
    { value: 4, beats: 4, beams: 0, dot: 0 },
    { value: 3, beats: 2, beams: 0, dot: 1 },
    { value: 2, beats: 2, beams: 0, dot: 0 },
    { value: 1.5, beats: 1, beams: 0, dot: 1 },
    { value: 1, beats: 1, beams: 0, dot: 0 },
    { value: 0.75, beats: 1, beams: 1, dot: 1 },
    { value: 0.5, beats: 1, beams: 1, dot: 0 },
    { value: 0.375, beats: 1, beams: 2, dot: 1 },
    { value: 0.25, beats: 1, beams: 2, dot: 0 },
    { value: 0.1875, beats: 1, beams: 3, dot: 1 },
    { value: 0.125, beats: 1, beams: 3, dot: 0 },
    { value: 0.09375, beats: 1, beams: 4, dot: 1 },
    { value: 0.0625, beats: 1, beams: 4, dot: 0 },
  ];
  const exact = values.find((item) => Math.abs(item.value - duration) <= 1 / 384);
  chord.beats = exact?.beats ?? 1;
  chord.beams = exact?.beams ?? Math.max(0, Math.min(6,
    Math.round(Math.log2(1 / Math.max(1 / 64, duration)))));
  chord.dot = exact?.dot ?? 0;
}

function detachSlashChord(chord: Chord): void {
  for (const note of chord.notes) {
    if (note.tiePrev) {
      note.tiePrev.tieNext = null;
      note.tiePrev.tieStart = false;
    }
    if (note.tieNext) {
      note.tieNext.tiePrev = null;
      note.tieNext.tieEnd = false;
    }
    note.tiePrev = null;
    note.tieNext = null;
    note.tieStart = false;
    note.tieEnd = false;
  }
}

/**
 * Restore fixed 3:2 notation lost by the intermediate MIDI representation.
 *
 * The ordinary MIDI quantizer deliberately uses a binary grid.  A voiced TXT
 * triplet such as `[(A⁣B).⁣N.⁣B.]` can therefore merge the latter two V1
 * attacks into one sixteenth chord.  Rebuild the three explicitly declared
 * attacks from their source events, then recreate the return note's sustain as
 * normal tied continuations.  This keeps both the visible tuplet and a stable
 * second TXT save without special-casing one song.
 */
function applySlashTuplets(
  score: Score,
  events: readonly TimedEvent[],
  annotations: readonly NotationAnnotationData[] = [],
): void {
  const groups = new Map<string, TimedEvent[]>();
  for (const event of events) {
    if (!event.tripletGroup || event.tripletIndex === undefined
      || event.continuationOf && !event.tripletSpelling) continue;
    const key = `${event.tripletGroup}:${event.voiceIndex ?? 0}`;
    const list = groups.get(key) ?? [];
    list.push(event);
    groups.set(key, list);
  }
  const normalizedAnnotations = normalizeNotationAnnotations(annotations);
  const mordentAnnotations = normalizedAnnotations.filter((annotation): annotation is Extract<
    NotationAnnotationData,
    { type: "ornament" }
  > => annotation.type === "ornament"
    && (annotation.kind === "upper-mordent" || annotation.kind === "lower-mordent"));
  const ownership = normalizedAnnotations.flatMap((annotation): Array<
    Extract<NotationAnnotationData, { type: "triplet" }>
  > => {
    if (annotation.type === "triplet") return [annotation];
    // TXT mordents are visibly realized as a fixed triplet, but their source
    // Score stores the semantic ornament rather than a Tuplet object. Treat
    // that generated container as belonging to the ornament's voice so a
    // save/reopen cycle does not inject rests into every accompaniment voice.
    if (annotation.type === "ornament") {
      return [{
        type: "triplet",
        part: annotation.part,
        voice: score.parts[annotation.part]?.voiceIndex ?? annotation.part + 1,
        measure: annotation.measure,
        offset: annotation.offset,
        scope: "voice",
      }];
    }
    return [];
  });
  const groupOwners = new Map<string, Extract<NotationAnnotationData, { type: "triplet" }> | null>();
  const mordentGroups = new Set<string>();
  for (const source of groups.values()) {
    const groupId = source[0]?.tripletGroup;
    if (!groupId || groupOwners.has(groupId)) continue;
    const start = Math.min(...source.map((event) => event.start));
    const referencePart = score.parts[0];
    const measure = [...(referencePart?.measures ?? [])].reverse().find((item) =>
      item.position.toFloat() <= start + 1e-8);
    const localOffset = measure ? start - measure.position.toFloat() : start;
    const sourceVoiceIndex = clamp(
      source[0]?.voiceIndex ?? 0,
      0,
      Math.max(0, score.parts.length - 1),
    );
    const owner = measure
      ? ownership.find((item) => item.measure === measure.index
        && item.part === sourceVoiceIndex
        && Math.abs(item.offset - localOffset) <= 1 / 192) ?? null
      : null;
    groupOwners.set(groupId, owner);
    if (measure && mordentAnnotations.some((item) => item.measure === measure.index
      && Math.abs(item.offset - localOffset) <= 1 / 192)) {
      mordentGroups.add(groupId);
    }
  }
  const maxMembersByGroup = new Map<string, number>();
  for (const list of groups.values()) {
    const id = list[0]?.tripletGroup;
    if (!id) continue;
    maxMembersByGroup.set(id, Math.max(maxMembersByGroup.get(id) ?? 0, list.length));
  }
  for (const source of groups.values()) {
    const ordered = [...source].sort((left, right) =>
      (left.tripletIndex ?? 0) - (right.tripletIndex ?? 0));
    // A serialized tuplet is not necessarily three visible events.  A
    // subdivision can preserve six 32nd members, and a mixed-duration group
    // can contain an eighth followed by a sixteenth.  The event metadata
    // carries each member's real span, so do not discard groups merely because
    // their member count is not exactly three.
    if (ordered.length < 1) continue;
    const groupId = ordered[0].tripletGroup!;
    // A shorter accompaniment stream still follows the common compressed
    // timeline, but does not need visible synthetic rest members. Keep the
    // complete voice as the bracket owner so TXT round trips stay compact.
    if (ordered.length < (maxMembersByGroup.get(groupId) ?? ordered.length)) continue;
    const voiceIndex = clamp(ordered[0].voiceIndex ?? 0, 0, Math.max(0, score.parts.length - 1));
    if (!ordered.every((event) => (event.voiceIndex ?? 0) === voiceIndex)) continue;
    const part = score.parts[voiceIndex];
    if (!part) continue;
    const owner = groupOwners.get(groupId) ?? null;
    if (owner?.scope === "voice"
      && (owner.part !== voiceIndex || owner.voice !== (part.voiceIndex ?? voiceIndex + 1))) {
      // A cursor-created TXT triplet may enclose simultaneous material from
      // another staff, but its persisted annotation deliberately owns only
      // the active voice.  Do not turn the other complete voice stream into
      // a second visible tuplet merely because it shares the text container.
      continue;
    }
    const groupStart = ordered[0].start;
    // Never infer an equal cell merely from there being exactly three
    // visible atoms.  A legal 3:2 container can spell unequal members (for
    // example 8th + 16th + 8th), and each parser event already records the
    // end of its own compressed atom.  The old three-member shortcut used
    // the shortest onset gap for every atom, truncating longer members and
    // shifting everything after the tuplet on the next TXT round-trip.
    const memberSpans = ordered.map((event) => Math.max(
      1 / 192,
      (event.tripletEnd ?? event.end) - event.start,
    ));
    const groupEnd = Math.max(...ordered.map((event, index) =>
      event.start + memberSpans[index]!,
    ));
    if (!(groupEnd > groupStart + 1 / 384)) continue;
    const rootOf = (event: TimedEvent): TimedEvent => {
      let root = event;
      const seen = new Set<TimedEvent>();
      while (root.continuationOf && !seen.has(root)) {
        seen.add(root);
        root = root.continuationOf;
      }
      return root;
    };
    const returnEvent = ordered[ordered.length - 1];
    const voiceScopedTuplet = owner?.scope === "voice"
      || ordered.every((event) => event.tripletScope === "voice");
    const rootedContinuations = events.filter((event) =>
      event !== returnEvent && rootOf(event) === returnEvent);
    // Only a continuation that actually leaves the Tuplet at its semantic
    // boundary is a real outside tie. The binary bridge can stretch the last
    // member past `groupEnd` and then split off a tiny continuation at that
    // rounded endpoint; accepting that artifact turns the following voiced
    // rest into another attack of the return pitch on TXT reload.
    const hasBoundaryContinuation = !voiceScopedTuplet || rootedContinuations.some((event) =>
      Math.abs(event.start - groupEnd) <= 1 / 192);
    const returnContinuations = hasBoundaryContinuation ? rootedContinuations : [];
    const quantizerArtifactEnd = voiceScopedTuplet
      && !hasBoundaryContinuation && rootedContinuations.length > 0
      ? Math.max(...rootedContinuations.map((event) => event.end))
      : null;
    const sustainEnd = returnEvent.pitches.length > 0
      ? Math.max(
        groupEnd,
        ...(voiceScopedTuplet ? [] : [returnEvent.end]),
        ...returnContinuations.map((event) => event.end),
      )
      : groupEnd;
    const preceding = Boolean(ordered[0].continuationOf)
      && ordered[0].pitches.length > 0
      ? part.measures.flatMap((measure) => measure.entries)
        .filter((entry): entry is Chord => entry instanceof Chord && !entry.rest)
        .find((entry) => {
          const absoluteEnd = entry.measure.position.toFloat()
            + entry.position.toFloat()
            + (entry.duration?.toFloat() ?? 0);
          if (Math.abs(absoluteEnd - groupStart) > 1e-8) return false;
          const pitches = entry.notes.filter((note) => !note.rest).map((note) => note.pitch);
          return pitches.length === ordered[0].pitches.length
            && ordered[0].pitches.every((pitch) => pitches.includes(pitch));
        }) ?? null
      : null;
    // The intermediate binary MIDI quantizer may merge the return pitch's
    // synthetic continuation into the real attack exactly at `sustainEnd`.
    // Keep only pitches that are explicitly attacked at that boundary.  This
    // is especially important for a TXT mordent immediately followed by a
    // different note: deleting the ornament must restore the original note,
    // not leave the return pitch inside the following chord.
    const boundaryAttackEvents = events
      .filter((event) => (event.voiceIndex ?? 0) === voiceIndex
        && !event.continuationOf
        && event.pitches.length > 0
        && Math.abs(event.start - sustainEnd) <= 1e-8);
    const boundaryAttacks = boundaryAttackEvents.flatMap((event) => event.pitches);
    const boundaryEnd = boundaryAttackEvents.length > 0
      ? Math.max(...boundaryAttackEvents.map((event) => event.end))
      : sustainEnd;
    const artifactBoundaryAttackEvents = quantizerArtifactEnd === null
      ? []
      : events.filter((event) => (event.voiceIndex ?? 0) === voiceIndex
        && !event.continuationOf
        && event.pitches.length > 0
        && Math.abs(event.start - quantizerArtifactEnd) <= 1e-8);
    const artifactBoundaryAttacks = artifactBoundaryAttackEvents.flatMap((event) => event.pitches);
    const artifactBoundaryEnd = artifactBoundaryAttackEvents.length > 0
      ? Math.max(...artifactBoundaryAttackEvents.map((event) => event.end))
      : quantizerArtifactEnd;
    const silentTupletBoundary = boundaryAttackEvents.length === 0
      && (returnEvent.pitches.length === 0
        || (voiceScopedTuplet && sustainEnd <= groupEnd + 1e-8));
    const oldNotes = new Map<number, Note>();
    for (const measure of part.measures) {
      for (const entry of measure.entries) {
        if (!(entry instanceof Chord)) continue;
        const absolute = measure.position.toFloat() + entry.position.toFloat();
        if (boundaryAttacks.length > 0 && Math.abs(absolute - sustainEnd) <= 1e-8) {
          const remaining = [...boundaryAttacks];
          const retained = entry.notes.filter((note) => {
            if (note.rest) return false;
            const index = remaining.indexOf(note.pitch);
            if (index < 0) return false;
            remaining.splice(index, 1);
            return true;
          });
          if (retained.length > 0 && retained.length < entry.notes.length) {
            entry.notes = retained;
            entry.rest = false;
          }
          if (retained.length > 0 && boundaryEnd > sustainEnd + 1e-8) {
            entry.duration = slashFraction(boundaryEnd - sustainEnd);
            setSlashWrittenDuration(entry, boundaryEnd - sustainEnd);
          }
        }
        if (quantizerArtifactEnd !== null
          && Math.abs(absolute - quantizerArtifactEnd) <= 1e-8
          && artifactBoundaryAttacks.length > 0) {
          const remaining = [...artifactBoundaryAttacks];
          const retained = entry.notes.filter((note) => {
            if (note.rest) return false;
            const index = remaining.indexOf(note.pitch);
            if (index < 0) return false;
            remaining.splice(index, 1);
            return true;
          });
          if (retained.length > 0 && retained.length < entry.notes.length) {
            entry.notes = retained;
            entry.rest = false;
          }
          if (retained.length > 0
            && artifactBoundaryEnd !== null
            && artifactBoundaryEnd > quantizerArtifactEnd + 1e-8) {
            entry.duration = slashFraction(artifactBoundaryEnd - quantizerArtifactEnd);
            setSlashWrittenDuration(entry, artifactBoundaryEnd - quantizerArtifactEnd);
          }
        }
        if (absolute < groupStart - 1e-8 || absolute >= sustainEnd - 1e-8) continue;
        for (const note of entry.notes) {
          if (!note.rest && !oldNotes.has(note.pitch)) oldNotes.set(note.pitch, note);
        }
        detachSlashChord(entry);
      }
      measure.entries = measure.entries.filter((entry) => {
        if (!(entry instanceof Chord)) return true;
        const absolute = measure.position.toFloat() + entry.position.toFloat();
        if (silentTupletBoundary
          && !entry.rest
          && Math.abs(absolute - sustainEnd) <= 1e-8) {
          // The binary MIDI bridge may round the last sounding Tuplet member
          // up to the container boundary and leave a fresh-looking pitch
          // there. An explicit final rest, or a closed voice-scoped Tuplet
          // whose following duration is assigned to another voice, means
          // this lane is silent; drop that quantizer artifact instead of
          // rendering an extra attack/continuation.
          detachSlashChord(entry);
          return false;
        }
        if (quantizerArtifactEnd !== null
          && artifactBoundaryAttacks.length === 0
          && !entry.rest
          && Math.abs(absolute - quantizerArtifactEnd) <= 1e-8) {
          detachSlashChord(entry);
          return false;
        }
        if (absolute > sustainEnd + 1e-8
          && absolute < boundaryEnd - 1e-8) {
          // The boundary attack was restored to its exact source duration.
          // Remove every provisional piece inside that span, including tied
          // pitched fragments left by the binary bridge, not just rests.
          // Otherwise its former tail becomes a second attack underneath it.
          detachSlashChord(entry);
          return false;
        }
        const end = absolute + (entry.duration?.toFloat() ?? 0);
        if (entry.rest && absolute >= groupStart - 1e-8
          && absolute < sustainEnd - 1e-8 && end > sustainEnd + 1e-8) {
          // Exact source timing may store the inner tuplet rest and its
          // ordinary tail as one fraction. Rebuild only the covered interval;
          // retain the remaining silence after the tuplet boundary.
          entry.position = slashFraction(sustainEnd - measure.position.toFloat());
          entry.duration = slashFraction(end - sustainEnd);
          setSlashWrittenDuration(entry, end - sustainEnd);
          return true;
        }
        return absolute < groupStart - 1e-8 || absolute >= sustainEnd - 1e-8;
      });
    }
    const measureAt = (absolute: number): Measure | null => [...part.measures].reverse().find((measure) =>
      absolute >= measure.position.toFloat() - 1e-8) ?? null;
    const makeChord = (
      absolute: number,
      duration: number,
      pitches: readonly number[],
      writtenDuration: number,
      continuation: boolean,
    ): Chord | null => {
      const measure = measureAt(absolute);
      if (!measure) return null;
      const chord = new Chord(measure);
      chord.position = slashFraction(absolute - measure.position.toFloat());
      chord.duration = slashFraction(duration);
      chord.voice = 1;
      chord.rest = false;
      chord.generatedTimingContinuation = continuation;
      chord.persistGeneratedContinuation = continuation;
      chord.transparentContinuation = continuation;
      setSlashWrittenDuration(chord, writtenDuration);
      if (pitches.length === 0) {
        chord.rest = true;
        const rest = new Note(chord);
        rest.rest = true;
        rest.number = "0";
        chord.add(rest);
        measure.add(chord);
        return chord;
      }
      for (const pitch of pitches) {
        const template = oldNotes.get(pitch);
        const note = template ? new Note(chord) : slashGraceNote(chord, pitch);
        if (template) {
          note.pitch = template.pitch;
          note.step = template.step;
          note.alter = template.alter;
          note.octave = template.octave;
          note.number = template.number;
          note.jpOctave = template.jpOctave;
          note.jpAlter = template.jpAlter;
          note.displayText = template.displayText;
          note.displayOctave = template.displayOctave;
          note.displayAlter = template.displayAlter;
          note.displayHidden = template.displayHidden;
        }
        chord.add(note);
      }
      measure.add(chord);
      return chord;
    };
    const tripletChords = ordered.map((event, index) => makeChord(
      event.start,
      memberSpans[index]!,
      event.pitches,
      memberSpans[index]! * 1.5,
      Boolean(event.continuationOf),
    )).filter((chord): chord is Chord => chord !== null);
    if (tripletChords.length !== ordered.length) continue;
    const first = tripletChords[0].notes[0];
    const last = tripletChords[tripletChords.length - 1].notes[0];
    if (!first || !last) continue;
    const tuplet = new Tuplet(first, last);
    tuplet.partIndex = voiceIndex;
    tuplet.voiceIndex = score.parts[voiceIndex]?.voiceIndex ?? voiceIndex + 1;
    tuplet.scope = owner?.scope
      ?? (ordered.every((event) => event.tripletScope === "voice") ? "voice" : "all");
    tuplet.ornamentProxy = mordentGroups.has(groupId);
    tuplet.writtenUnit = slashFraction(
      (groupEnd - groupStart) / Math.max(1, tuplet.ratioDenominator),
    );
    tuplet.binaryRestoreUnit = owner?.restoreUnit
      ? slashFraction(owner.restoreUnit)
      : tuplet.writtenUnit;
    for (const chord of tripletChords) {
      chord.notes.forEach((note) => {
        note.tuplet = tuplet;
      });
    }
    tuplet.refreshTiming();
    if (!tuplet.ornamentProxy) {
      first.tupletBegin = true;
      last.tupletEnd = true;
    }
    if (preceding && !tripletChords[0].rest) {
      linkContinuation(preceding, tripletChords[0]);
      tripletChords[0].transparentContinuation = true;
    }

    let previous = tripletChords[tripletChords.length - 1];
    const tailOptions = { beats: part.measures[0]?.time.beats ?? 4,
      beatType: part.measures[0]?.time.beatType ?? 4 } as SlashScoreOptions;
    const tailBoundaries = [groupEnd, ...metricalContinuationStartsByMeasure(
      groupEnd, sustainEnd, tailOptions,
      part.measures.map((measure) => measure.position.toFloat()),
      part.measures.map((measure) => ({ beats: measure.time.beats,
        beatType: measure.time.beatType as SlashMeasureMeter["beatType"] })),
    ), sustainEnd];
    for (let index = 0; returnEvent.pitches.length > 0 && index + 1 < tailBoundaries.length; index++) {
      const cursor = tailBoundaries[index]!, end = tailBoundaries[index + 1]!;
      if (end <= cursor + 1e-8) continue;
      const continuation = makeChord(
        cursor,
        end - cursor,
        returnEvent.pitches,
        end - cursor,
        true,
      );
      if (!continuation) break;
      linkContinuation(previous, continuation);
      previous = continuation;
    }
    for (const measure of part.measures) {
      measure.entries.sort((left, right) => left.position.compareTo(right.position));
    }
  }
}

/** Materialize ordinary TXT zeroes after the MIDI-shaped intermediate score
 * has been built. MIDI has no rest events, so without this pass an explicit
 * `0..` immediately after a Tuplet becomes empty time and is later restored
 * as a gray continuation of the Tuplet's last pitch. */
function applySlashExplicitRests(score: Score, events: readonly TimedEvent[]): void {
  const rests = events.filter((event) =>
    !event.tripletGroup
    && event.pitches.length === 0
    && event.end > event.start + 1e-8
    && (!continuationRoot(event).tripletGroup
      || event.start >= (continuationRoot(event).tripletEnd ?? event.start) - 1e-8));
  // A rest split at a slash boundary is still silence in every segment.
  for (const event of rests) {
    const partIndex = clamp(event.voiceIndex ?? 0, 0, Math.max(0, score.parts.length - 1));
    const part = score.parts[partIndex];
    if (!part) continue;
    for (const measure of part.measures) {
      const measureStart = measure.position.toFloat();
      const measureEnd = measureStart + measure.time.beats * 4 / measure.time.beatType;
      const start = Math.max(event.start, measureStart);
      const end = Math.min(event.end, measureEnd);
      if (end <= start + 1e-8) continue;

      const retained: typeof measure.entries = [];
      for (const entry of measure.entries) {
        if (!(entry instanceof Chord)) {
          retained.push(entry);
          continue;
        }
        const chordStart = measureStart + entry.position.toFloat();
        const chordEnd = chordStart + (entry.duration?.toFloat() ?? 0);
        if (chordEnd <= start + 1e-8 || chordStart >= end - 1e-8) {
          retained.push(entry);
          continue;
        }
        if (!entry.rest && chordStart < start - 1e-8) {
          const duration = start - chordStart;
          entry.duration = slashFraction(duration);
          setSlashWrittenDuration(entry, duration);
          for (const note of entry.notes) {
            const next = note.tieNext;
            if (next) {
              next.tiePrev = null;
              next.tieEnd = false;
            }
            note.tieNext = null;
            note.tieStart = false;
          }
          retained.push(entry);
          continue;
        }
        detachSlashChord(entry);
      }
      measure.entries = retained;

      const rest = new Chord(measure);
      rest.position = slashFraction(start - measureStart);
      rest.duration = slashFraction(end - start);
      rest.rest = true;
      rest.voice = 1;
      setSlashWrittenDuration(rest, end - start);
      const note = new Note(rest);
      note.rest = true;
      note.number = "0";
      rest.add(note);
      measure.add(rest);
      measure.entries.sort((left, right) => left.position.compareTo(right.position));
    }
  }
}

/** A variable (one- or two-member) tuplet can end in a held pitch whose
 * remaining binary value is written immediately after the closing bracket.
 * Compact TXT has no visible tie token, so restore the semantic continuation
 * when that adjacent attack is the same pitch. Three-attack tuplets remain
 * untouched: a repeated pitch after an ordinary ABC group is a real attack. */
function linkSlashVariableTupletTails(score: Score): void {
  for (const part of score.parts) {
    for (const measure of part.measures) {
      const chords = measure.entries
        .filter((entry): entry is Chord => entry instanceof Chord && !entry.rest)
        .sort((left, right) => left.position.compareTo(right.position));
      const tuplets = new Set(chords.flatMap((chord) => chord.notes
        .map((note) => note.tuplet)
        .filter((tuplet): tuplet is Tuplet => tuplet !== null)));
      for (const tuplet of tuplets) {
        const members = chords.filter((chord) => chord.notes.some((note) => note.tuplet === tuplet));
        if (members.length >= 3 || members.length === 0) continue;
        const last = tuplet.last.chord;
        const end = last.position.plus(last.duration ?? new Fraction(0));
        const next = chords.find((chord) => chord !== last && chord.position.equals(end));
        // A following Tuplet owns its attacks, including a repeated pitch.
        // Only an ordinary outside tail can use this legacy inference.
        if (!next || next.notes.some((note) => note.tuplet && note.tuplet !== tuplet)) continue;
        if (tuplet.scope === "voice"
          && !next.transparentContinuation
          && !next.generatedTimingContinuation) continue;
        const available = next.notes.filter((note) => !note.rest && note.tiePrev === null);
        for (const source of last.notes.filter((note) => !note.rest && note.tieNext === null)) {
          const index = available.findIndex((note) => note.pitch === source.pitch);
          if (index < 0) continue;
          const target = available.splice(index, 1)[0];
          source.tieStart = true;
          source.tieNext = target;
          target.tieEnd = true;
          target.tiePrev = source;
          next.transparentContinuation = true;
        }
      }
    }
  }
}

function slashGraceNote(chord: Chord, pitch: number): Note {
  const value = slashPitch(pitch, chord.measure.key.fifths);
  const note = new Note(chord);
  note.pitch = pitch;
  note.number = String(value.degree + 1);
  note.jpOctave = value.octave;
  note.jpAlter = value.accidental > 0 ? "#" : value.accidental < 0 ? "b" : " ";
  return note;
}

function sameArpeggioMembers(
  left: readonly { part: number; pitch: number }[],
  right: readonly { part: number; pitch: number }[],
): boolean {
  const keys = (members: readonly { part: number; pitch: number }[]): string[] =>
    members.map(item => `${item.part}:${item.pitch}`).sort();
  const a = keys(left), b = keys(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Restore non-metrical slash-score decorations after MIDI quantization. */
function applySlashOrnaments(score: Score, events: readonly TimedEvent[]): void {
  const chords: PositionedChord[] = [];
  for (let partIndex = 0; partIndex < score.parts.length; partIndex++) {
    const part = score.parts[partIndex];
    for (const measure of part.measures) {
      const measureStart = measure.position.toFloat();
      for (const entry of measure.entries) {
        if (!(entry instanceof Chord) || entry.rest || !entry.duration) continue;
        const start = measureStart + entry.position.toFloat();
        chords.push({
          chord: entry,
          partIndex,
          start,
          end: start + entry.duration.toFloat(),
          pitches: chordPitches(entry),
        });
      }
    }
  }

  const seenArpeggioGroups = new Set<SlashArpeggioGroup>();
  for (const event of events) {
    // A source group is shared by every voice clone. Resolve it exactly once
    // against the completed score so an upper-only subset stays local while
    // a genuinely cross-part subset becomes one spanning semantic mark.
    for (const members of event.arpeggioGroups ?? []) {
      if (seenArpeggioGroups.has(members)) continue;
      seenArpeggioGroups.add(members);
      const available = chords.filter(item => Math.abs(item.start - event.start) <= 1e-8)
        .flatMap(item => item.chord.notes.filter(note => !note.rest)
          .map(note => ({ item, note })));
      const selected = members.flatMap(member => {
        const index = available.findIndex(({ item, note }) =>
          item.partIndex === member.part && note.pitch === member.pitch);
        return index < 0 ? [] : [available.splice(index, 1)[0]];
      });
      if (selected.length < 2) continue;
      const parts = [...new Set(selected.map(({ item }) => item.partIndex))].sort((a, b) => a - b);
      if (parts.length === 1) {
        const target = selected[0].item.chord;
        setChordArpeggioPitchGroups(target, [
          ...chordArpeggioPitchGroups(target), selected.map(({ note }) => note.pitch),
        ]);
      } else {
        const first = selected[0].item.chord;
        const mark = new CrossPartArpeggio();
        mark.measure = first.measure.index;
        mark.offset = first.position;
        mark.parts = parts;
        mark.pitches = selected.map(({ item, note }) => ({ part: item.partIndex, pitch: note.pitch }));
        score.crossPartArpeggios.push(mark);
      }
    }
    if ((!event.arpeggio || event.arpeggioGroups?.length)
      && (!event.gracePitches || event.gracePitches.length === 0)
      && !event.ornamentKind) continue;
    const pitches = [...event.pitches].sort((left, right) => left - right);
    const rolledPitches = [...(event.arpeggioPitches ?? event.pitches)]
      .sort((left, right) => left - right);
    const aligned = chords.filter((item) =>
      Math.abs(item.start - event.start) <= 1e-8
      && (event.voiceIndex === undefined || item.partIndex === event.voiceIndex));
    const exact = aligned.find((item) => equalPitches(item.pitches, pitches));
    // A simultaneous parenthesized chord and rolled container are quantized
    // into one written vertical chord. In that case the rolled pitches are a
    // subset of the chord rather than an exact match.
    const containing = event.arpeggio
      ? aligned.find((item) => pitches.every((pitch) => item.pitches.includes(pitch)))
      : undefined;
    const target = (exact ?? containing)?.chord;
    if (!target) continue;
    if (event.arpeggio && !event.arpeggioGroups?.length && rolledPitches.length >= 2) {
      setChordArpeggioPitchGroups(target, [...chordArpeggioPitchGroups(target), rolledPitches]);
    }
    if (event.gracePitches?.length) {
      target.graceNotes = event.gracePitches
        .flatMap((group) => group.map((pitch) => slashGraceNote(target, pitch)));
    }
    const realTuplet = target.notes.some((note) => note.tuplet && !note.tuplet.ornamentProxy);
    if (event.ornamentKind && !realTuplet
      && !target.ornaments.some((item) => item.kind === event.ornamentKind)) {
      target.ornaments.push(event.ornamentKind === "trill"
        ? { kind: "trill", subdivision: 32 }
        : { kind: event.ornamentKind });
    }
  }
}

function applySlashTempoMarks(score: Score, marks: readonly SlashTempoMark[]): void {
  const parsed = marks.flatMap((source) => {
    if (source.measure < 0 || source.measure >= (score.parts[0]?.measures.length ?? 0)) return [];
    const mark = new TempoMark();
    mark.measure = source.measure;
    mark.offset = new Fraction(Math.round(source.offset * 192), 192);
    mark.kind = source.kind;
    mark.bpm = source.kind === "tempo" && source.bpm !== null
      ? Math.max(0.1, Math.round(source.bpm * 10) / 10)
      : null;
    return [mark];
  });
  for (const mark of parsed) {
    if (!score.tempoMarks.some((existing) => existing.measure === mark.measure
      && existing.offset.equals(mark.offset) && existing.kind === mark.kind && existing.bpm === mark.bpm)) {
      score.tempoMarks.push(mark);
    }
  }
}

function applySlashKeyChanges(
  score: Score,
  openingFifths: number,
  changes: readonly SlashKeyChange[],
): void {
  const valid = changes.flatMap((change): SlashKeyChange[] => {
    const measure = Math.round(change.measure);
    const offset = finiteOffset(change.offset ?? 0);
    const fifths = clamp(Math.round(change.fifths), -7, 7);
    return measure >= 0 && offset !== null ? [{ measure, offset, fifths }] : [];
  }).sort((left, right) => left.measure - right.measure || (left.offset ?? 0) - (right.offset ?? 0));

  // TXT pitches are scale degrees. A local `1 = G` therefore keeps the
  // visible letter/number and transposes the sounding MIDI pitch from that
  // cursor onward. Re-initialising the note from its old absolute pitch did
  // the opposite: playback stayed in C while the displayed degree changed.
  for (const change of valid) {
    applyKeyChangeKeepingDegrees(
      score,
      0,
      change.measure,
      new Fraction(Math.round((change.offset ?? 0) * 192), 192),
      change.fifths,
    );
  }

  const byMeasure = new Map(valid
    .filter((change) => Math.abs(change.offset ?? 0) < 1 / 192)
    .map((change) => [change.measure, change] as const));
  for (const part of score.parts) {
    let fifths = clamp(Math.round(openingFifths), -7, 7);
    for (const measure of part.measures) {
      const changed = byMeasure.get(measure.index);
      if (changed !== undefined) fifths = changed.fifths;
      measure.key.fifths = fifths;
      measure.keyChange = measure.index > 0 && changed !== undefined;
    }
  }
}

function applySlashAnnotations(score: Score, annotations: readonly NotationAnnotationData[]): void {
  const normalized = normalizeNotationAnnotations(annotations);
  const meters = normalized
    .filter((annotation): annotation is Extract<NotationAnnotationData, { type: "meter" }> =>
      annotation.type === "meter")
    .sort((left, right) => left.measure - right.measure);
  for (const part of score.parts) {
    meters.forEach((meter, meterIndex) => {
      const endMeasure = meters[meterIndex + 1]?.measure ?? part.measures.length;
      for (let index = meter.measure; index < Math.min(endMeasure, part.measures.length); index++) {
        const measure = part.measures[index];
        measure.time.beats = meter.beats;
        measure.time.beatType = meter.beatType;
        measure.timeChange = index === meter.measure;
        measure.timingMinimumDuration = null;
        const length = new Fraction(meter.beats * 4, meter.beatType);
        measure.entries = measure.entries.filter((entry) => {
          if (!(entry instanceof Chord)) return true;
          if (entry.position.compareTo(length) >= 0) return false;
          if (entry.duration && entry.position.plus(entry.duration).compareTo(length) > 0) {
            entry.duration = length.minus(entry.position);
          }
          return true;
        });
      }
    });
    let position = new Fraction(0);
    for (const measure of part.measures) {
      measure.position = position;
      position = position.plus(new Fraction(measure.time.beats * 4, measure.time.beatType));
    }
  }
  const chordAt = (part: number, measure: number, offset: number): Chord | null =>
    score.parts[part]?.measures[measure]?.entries.find((entry): entry is Chord =>
      entry instanceof Chord && Math.abs(entry.position.toFloat() - offset) < 1 / 192) ?? null;
  const keyChanges = normalized
    .filter((annotation): annotation is Extract<NotationAnnotationData, { type: "key" }> =>
      annotation.type === "key")
    .map((annotation) => ({
      measure: annotation.measure,
      offset: annotation.offset,
      fifths: annotation.fifths,
    }));
  if (keyChanges.length > 0) {
    applySlashKeyChanges(score, score.parts[0]?.measures[0]?.key.fifths ?? 0, keyChanges);
  }
  for (const annotation of normalized) {
    if (annotation.type === "key") {
      continue;
    } else if (annotation.type === "tempo") {
      applySlashTempoMarks(score, [{
        measure: annotation.measure,
        offset: annotation.offset,
        kind: "tempo",
        bpm: annotation.bpm,
      }]);
    } else if (annotation.type === "tempo-ramp") {
      applySlashTempoMarks(score, [
        { measure: annotation.from.measure, offset: annotation.from.offset, kind: annotation.mode, bpm: null },
        { measure: annotation.to.measure, offset: annotation.to.offset, kind: "tempo", bpm: annotation.targetBpm },
      ]);
    } else if (annotation.type === "ornament") {
      const chord = chordAt(annotation.part, annotation.measure, annotation.offset);
      if (!chord || chord.notes.some((note) => note.tuplet && !note.tuplet.ornamentProxy)) continue;
      const ornament = annotation.kind === "trill"
        ? { kind: "trill" as const, subdivision: annotation.subdivision ?? 32 }
        : { kind: annotation.kind };
      if (!chord.ornaments.some((item) => item.kind === ornament.kind
        && (item.kind !== "trill" || item.subdivision === ornament.subdivision))) {
        chord.ornaments.push(ornament);
      }
    } else if (annotation.type === "slur") {
      const from = chordAt(annotation.part, annotation.from.measure, annotation.from.offset);
      const to = chordAt(annotation.part, annotation.to.measure, annotation.to.offset);
      if (from && to && from !== to) {
        from.slurStart = true;
        from.slurEndChord = to;
        to.slurEnd = true;
      }
    } else if (annotation.type === "triplet") {
      const chord = chordAt(annotation.part, annotation.measure, annotation.offset);
      const tuplets = new Set(chord?.notes.flatMap((note) => note.tuplet ? [note.tuplet] : []) ?? []);
      for (const tuplet of tuplets) {
        tuplet.partIndex = annotation.part;
        tuplet.voiceIndex = annotation.voice;
        tuplet.scope = annotation.scope;
        if (annotation.restoreUnit) tuplet.binaryRestoreUnit = slashFraction(annotation.restoreUnit);
      }
    } else if (annotation.type === "cross-arpeggio") {
      for (const partIndex of annotation.parts) {
        const chord = chordAt(partIndex, annotation.measure, annotation.offset);
        if (!chord) continue;
        // Remove only a legacy local copy of these selected members. Other
        // independent local braces at the same column remain independent.
        const selectedPitches = annotation.pitches.filter(item => item.part === partIndex)
          .map(item => item.pitch);
        setChordArpeggioPitchGroups(chord, chordArpeggioPitchGroups(chord)
          .filter(group => !containsPitchMultiplicity(selectedPitches, group)));
      }
      const existing = score.crossPartArpeggios.find((mark) => mark.measure === annotation.measure
        && mark.offset.equals(new Fraction(Math.round(annotation.offset * 192), 192))
        && sameArpeggioMembers(mark.pitches, annotation.pitches));
      if (existing) existing.direction = annotation.direction;
      else {
        const mark = new CrossPartArpeggio();
        mark.measure = annotation.measure;
        mark.offset = new Fraction(Math.round(annotation.offset * 192), 192);
        mark.parts = [...annotation.parts];
        mark.pitches = annotation.pitches.map((pitch) => ({ ...pitch }));
        mark.direction = annotation.direction;
        score.crossPartArpeggios.push(mark);
      }
    } else if (annotation.type === "text") {
      if (!score.textMarks.some((mark) => mark.partIndex === annotation.part
        && mark.measure === annotation.measure && mark.offset.toFloat() === annotation.offset
        && mark.text === annotation.text)) {
        const mark = new ScoreTextMark();
        mark.partIndex = annotation.part;
        mark.measure = annotation.measure;
        mark.offset = new Fraction(Math.round(annotation.offset * 192), 192);
        mark.text = annotation.text;
        score.textMarks.push(mark);
      }
    }
  }
  // Exact note ties refer to the final key spelling and absolute measure
  // positions, after all structural annotations have been applied.
  applyExplicitNoteTies(score, normalized.filter(annotation => annotation.type === "note-tie"));
}

function finestQuantize(options: SlashScoreOptions): MidiQuantizeDivision {
  let division = Math.max(4, options.noteDivision ?? 4, ...Object.values(effectiveMappings(options)));
  if (slashDelimiterSpecs(options).some((spec) => spec.mode === "subdivide")) {
    // Legacy explicit subdivision containers retain one internal binary level;
    // ordinary adjacency no longer raises the document quantization.
    division = Math.min(128, division * 2);
  }
  // A shared bracket can place a binary attack between two tuplet members
  // using the compact half-cell spelling. Keep that metadata's finer ruler
  // through the MIDI intermediate model too: rounding a 3/8-quarter offset
  // on a 16th grid moved it to 1/2 and ejected the attack on the next save.
  for (const annotation of options.annotations ?? []) {
    if (annotation.type !== "triplet") continue;
    for (const ordinary of annotation.ordinary ?? []) {
      for (const value of [ordinary.offset, ordinary.duration]) {
        const exact = [4, 8, 16, 32, 64, 128].find((candidate) =>
          Math.abs(value * candidate / 4 - Math.round(value * candidate / 4)) < 1e-8);
        if (exact) division = Math.max(division, exact);
      }
    }
  }
  return ([4, 8, 16, 32, 64, 128] as MidiQuantizeDivision[]).includes(division as MidiQuantizeDivision)
    ? division as MidiQuantizeDivision
    : 64;
}

function slashGroupsUseWholeMeasures(
  lines: readonly string[],
  options: Pick<SlashScoreOptions, "symbolDurations" | "spaceDivision" | "noteDivision"
    | "braceMode" | "bracketMode" | "barMode" | "angleMode" | "parenMode">,
  normalGroupDuration: number,
  measureLength: number,
): boolean {
  if (!options.noteDivision) return false;
  const mappings = effectiveMappings(options);
  const durations = lines.flatMap((line) => splitGroups(line))
    .map((group) => segmentMarkerDuration(
      group,
      mappings,
      options.braceMode,
      options.noteDivision,
      options.bracketMode ?? "triplet",
      options,
    ))
    .filter((duration) => duration > 1e-8);
  if (durations.length === 0 || durations.some((duration) => duration > measureLength + 1e-8)) return false;
  const overflowing = durations.filter((duration) => duration > normalGroupDuration + 1e-8).length;
  return overflowing >= Math.ceil(durations.length / 2) && median(durations) > normalGroupDuration + 1e-8;
}

function makePickupRest(measure: Measure, position: Fraction, duration: Fraction): Chord {
  let beams = 4;
  let cells = Math.max(1, Math.round(duration.toFloat() * (1 << beams)));
  while (beams > 0 && cells % 2 === 0) {
    cells /= 2;
    beams--;
  }
  let dot = 0;
  if (cells === 3) {
    if (beams > 0) {
      cells = 1;
      beams--;
    } else {
      cells = 2;
    }
    dot = 1;
  }
  const chord = new Chord(measure);
  chord.position = position;
  chord.duration = duration;
  chord.beats = cells;
  chord.beams = beams;
  chord.dot = dot;
  chord.voice = 1;
  chord.rest = true;
  const note = new Note(chord);
  note.rest = true;
  note.number = "0";
  chord.add(note);
  return chord;
}

/** Keep TXT-declared silent tail measures and completely empty voices alive
 * in the Score model. MIDI note events alone cannot express a bar containing
 * only rests, so the MIDI conversion otherwise stops before rows such as
 * `(⁣00)..../...` and the input-mode placeholder never reaches layout. */
function ensureSlashMeasureSpan(
  score: Score,
  measureCount: number,
  measureMeters: readonly { beats: number; beatType: 2 | 4 | 8 | 16 }[],
  measureStarts: readonly number[],
  voiceCount: number,
  instrumentName: string,
  openingFifths: number,
): void {
  while (score.parts.length < voiceCount) score.parts.push(new Part());
  for (let partIndex = 0; partIndex < voiceCount; partIndex++) {
    const part = score.parts[partIndex];
    part.voiceIndex = partIndex + 1;
    if (!part.instrumentName.trim()) part.instrumentName = instrumentName;
    while (part.measures.length < measureCount) {
      const index = part.measures.length;
      const meter = measureMeters[index] ?? measureMeters[measureMeters.length - 1]
        ?? { beats: 4, beatType: 4 as const };
      const measure = new Measure(index);
      measure.time.beats = meter.beats;
      measure.time.beatType = meter.beatType;
      measure.position = new Fraction(Math.round((measureStarts[index] ?? 0) * 192), 192);
      measure.key.fifths = part.measures[index - 1]?.key.fifths ?? openingFifths;
      measure.displayNumber = index + 1;
      part.measures.push(measure);
    }
    for (let index = 0; index < measureCount; index++) {
      const measure = part.measures[index];
      const meter = measureMeters[index] ?? {
        beats: measure.time.beats,
        beatType: measure.time.beatType as 2 | 4 | 8 | 16,
      };
      measure.time.beats = meter.beats;
      measure.time.beatType = meter.beatType;
      measure.position = new Fraction(Math.round((measureStarts[index] ?? measure.position.toFloat()) * 192), 192);
      if (measure.entries.some((entry) => entry instanceof Chord)) continue;
      const beat = new Fraction(4, meter.beatType);
      for (let beatIndex = 0; beatIndex < meter.beats; beatIndex++) {
        measure.add(makePickupRest(measure, beat.timesInt(beatIndex), beat));
      }
    }
  }
}

function applyOpeningPickup(
  score: Score,
  fullMeasure: Fraction,
  pickupDuration: Fraction,
  leadingFill: Fraction,
  fillDivision: SlashDurationDivision,
): { duration: number; rests: number } {
  const firstMeasures = score.parts.map((part) => part.measures[0]).filter((measure) => measure !== undefined);
  if (firstMeasures.length === 0) return { duration: 0, rests: 0 };
  const hasSound = firstMeasures.some((measure) => measure.entries.some((entry) =>
    entry instanceof Chord && !entry.rest && entry.duration !== undefined));
  if (!hasSound || pickupDuration.compareTo(new Fraction(0)) <= 0 ||
      pickupDuration.compareTo(fullMeasure) > 0) return { duration: 0, rests: 0 };
  const unit = new Fraction(4, fillDivision);
  const shortfall = fullMeasure.minus(pickupDuration);
  let reportedRests = 0;
  for (let partIndex = 0; partIndex < score.parts.length; partIndex++) {
    const measures = score.parts[partIndex].measures;
    const first = measures[0];
    if (!first) continue;
    const retained: Chord[] = [];
    for (const entry of first.entries) {
      if (!(entry instanceof Chord) || entry.duration === undefined) continue;
      if (entry.position.compareTo(pickupDuration) >= 0) continue;
      const end = entry.position.plus(entry.duration);
      if (end.compareTo(pickupDuration) > 0) entry.duration = pickupDuration.minus(entry.position);
      const insideAutomaticFill = entry.rest && entry.position.compareTo(leadingFill) < 0 &&
        entry.position.plus(entry.duration).compareTo(leadingFill) <= 0;
      if (!insideAutomaticFill) retained.push(entry);
    }
    const inserted: Chord[] = [];
    let cursor = new Fraction(0);
    while (cursor.plus(unit).compareTo(leadingFill) <= 0) {
      inserted.push(makePickupRest(first, cursor, unit));
      cursor = cursor.plus(unit);
    }
    if (cursor.compareTo(leadingFill) < 0) {
      inserted.push(makePickupRest(first, cursor, leadingFill.minus(cursor)));
    }
    if (partIndex === 0) reportedRests = inserted.length;
    first.entries = [...inserted, ...retained].sort((a, b) => a.position.compareTo(b.position));
    first.pickup = true;
    first.displayNumber = null;
    for (let index = 1; index < measures.length; index++) {
      measures[index].position = measures[index].position.minus(shortfall);
      measures[index].displayNumber = index;
    }
  }
  return { duration: pickupDuration.toFloat(), rests: reportedRests };
}

export function parseSlashScore(text: string, baseOptions: SlashScoreOptions): SlashScoreResult {
  const options = optionsWithDirectives(text, baseOptions);
  if (options.sourceTimedRows) {
    const projected = projectSourceTimedRows(text, options);
    const parsed = parseSlashScore(projected.text, projected.options);
    const original = sourceLines(text, options.kind);
    parsed.summary.comments = original.comments.length;
    parsed.summary.ignoredTags = original.ignoredTags;
    parsed.sources = mapProjectedSources(parsed.sources, projected.sourceOffsets);
    parsed.summary.diagnostics = mapProjectedDiagnostics(parsed.summary.diagnostics, projected.sourceOffsets, text);
    return parsed;
  }
  const lines = sourceLines(text, options.kind);
  if (lines.score.length === 0) throw new Error("没有找到斜杠谱小节；每个有效小节需单独一行并包含 / 分隔");
  const measureLength = options.beats * 4 / options.beatType;
  const inferred = inferSlashMeter(
    text,
    options.symbolDurations,
    options.spaceDivision,
    options.braceMode,
    options.noteDivision,
    options.bracketMode ?? "triplet",
    options.kind,
    options,
  );
  const expectedGroups = groupsForMeter({ ...inferred, beats: options.beats, beatType: options.beatType });
  const groupDuration = measureLength / Math.max(1, expectedGroups);
  const wholeMeasureGroups = options.wholeMeasureGroups
    ?? slashGroupsUseWholeMeasures(lines.score, options, groupDuration, measureLength);
  const logicalMeasures: string[][] = [];
  // A TXT file may change meter between rows (`3/4拍:` / `4/4拍:`).  Keep the
  // row-local meter alongside the rows; otherwise the parser uses the final
  // dialog meter for every row and silently drops/merges the last measure.
  const meterLine = /^\s*(\d{1,2})\s*\/\s*(2|4|8|16)\s*拍\s*[：:]\s*$/;
  const rowMeters: Array<{ beats: number; beatType: 2 | 4 | 8 | 16 }> = [];
  const records = sourceLineRecords(text);
  let activeRowMeter = {
    beats: options.beats,
    beatType: options.beatType as 2 | 4 | 8 | 16,
  };
  for (const [recordIndex, record] of records.entries()) {
    const changed = meterLine.exec(record.raw);
    if (changed) {
      activeRowMeter = {
        beats: clamp(Number(changed[1]), 1, 32),
        beatType: Number(changed[2]) as 2 | 4 | 8 | 16,
      };
    }
    if (record.score && selectedScoreLine(records, recordIndex, options.kind)) {
      rowMeters.push(activeRowMeter);
    }
  }
  const measureMeters: Array<{ beats: number; beatType: 2 | 4 | 8 | 16 }> = [];
  if (wholeMeasureGroups) {
    for (let rowIndex = 0; rowIndex < lines.score.length; rowIndex++) {
      const line = lines.score[rowIndex];
      const rowMeter = rowMeters[rowIndex] ?? activeRowMeter;
      for (const group of splitGroups(line)) {
        logicalMeasures.push([group]);
        measureMeters.push(rowMeter);
      }
    }
  } else if (lines.score.length === 1) {
    const groups = splitGroups(lines.score[0]);
    if (groups.length > expectedGroups) {
      for (let index = 0; index < groups.length; index += expectedGroups) {
        logicalMeasures.push(groups.slice(index, index + expectedGroups));
        measureMeters.push(rowMeters[0] ?? activeRowMeter);
      }
    } else {
      logicalMeasures.push(groups);
      measureMeters.push(rowMeters[0] ?? activeRowMeter);
    }
  } else {
    for (let rowIndex = 0; rowIndex < lines.score.length; rowIndex++) {
      logicalMeasures.push(splitGroups(lines.score[rowIndex]));
      measureMeters.push(rowMeters[rowIndex] ?? activeRowMeter);
    }
  }
  const firstGroups = logicalMeasures[0] ?? [];
  const firstMeter = measureMeters[0] ?? {
    beats: options.beats,
    beatType: options.beatType as 2 | 4 | 8 | 16,
  };
  const firstMeasureLength = firstMeter.beats * 4 / firstMeter.beatType;
  const firstExpectedGroups = groupsForMeter({
    ...inferred,
    beats: firstMeter.beats,
    beatType: firstMeter.beatType,
  });
  const firstGroupDuration = firstMeasureLength / Math.max(1, firstExpectedGroups);
  const firstHasSound = firstGroups.some((group) => groupHasContent(group, options) && !isRestOnlyGroup(group, options));
  const structurallyShortOpening = !wholeMeasureGroups && firstHasSound &&
    firstGroups.length > 0 && firstGroups.length < firstExpectedGroups;
  let pickupTargetQuarterNotes = structurallyShortOpening
    ? Math.min(firstMeasureLength, firstGroups.length * firstGroupDuration)
    : 0;
  let leadingPickupFillQuarterNotes = 0;
  const events: TimedEvent[] = [];
  let previousEvent: TimedEvent | null = null;
  let clippedGroups = 0;
  let ignoredCharacters = 0;
  const diagnostics = slashScoreDiagnostics(text, options);
  const warnings: string[] = [];
  if (wholeMeasureGroups) warnings.push("已按音符和空格自身时值，将每个 / 分段识别为一小节");

  const measureStarts: number[] = [];
  let elapsed = 0;
  for (const meterSpec of measureMeters) {
    measureStarts.push(elapsed);
    elapsed += meterSpec.beats * 4 / meterSpec.beatType;
  }
  logicalMeasures.forEach((groups, measureIndex) => {
    const meterSpec = measureMeters[measureIndex] ?? {
      beats: options.beats,
      beatType: options.beatType as 2 | 4 | 8 | 16,
    };
    const localMeasureLength = meterSpec.beats * 4 / meterSpec.beatType;
    const localExpectedGroups = groupsForMeter({
      ...inferred,
      beats: meterSpec.beats,
      beatType: meterSpec.beatType,
    });
    const localGroupDuration = localMeasureLength / Math.max(1, localExpectedGroups);
    const absoluteMeasureStart = measureStarts[measureIndex] ?? measureIndex * measureLength;
    groups.forEach((group, groupIndex) => {
      const groupStart = wholeMeasureGroups ? 0 : groupIndex * localGroupDuration;
      if (groupStart >= localMeasureLength - 1e-8) {
        if (groupHasContent(group, options) && !isRestOnlyGroup(group, options)) clippedGroups++;
        return;
      }
      const target = Math.min(wholeMeasureGroups ? localMeasureLength : localGroupDuration, localMeasureLength - groupStart);
      const eventStartIndex = events.length;
      const result = parseGroup(
        group,
        absoluteMeasureStart + groupStart,
        target,
        `${measureIndex}:${groupIndex}`,
        options,
        events,
        previousEvent,
        measureIndex,
        groupStart,
        localMeasureLength,
      );
      if (measureIndex === 0 && groupIndex === 0 && events.length > eventStartIndex) {
        const groupEvents = events.slice(eventStartIndex);
        const targetEnd = groupStart + target;
        const latestEnd = Math.max(...groupEvents.map((event) => event.end));
        const shift = Math.max(0, targetEnd - latestEnd);
        const mappings = effectiveMappings(options);
        const leadingChar = Array.from(group).find((char) => !/\s/.test(char) || mappings[char]);
        const startsWithDuration = leadingChar !== undefined && mappings[leadingChar] !== undefined;
        const implicitOpeningFill = options.noteDivision !== null && !startsWithDuration;
        const rightAlignOpening = structurallyShortOpening || wholeMeasureGroups || implicitOpeningFill;
        if (rightAlignOpening && shift > 1e-8) {
          for (const event of groupEvents) {
            event.start += shift;
            event.end += shift;
          }
          leadingPickupFillQuarterNotes = shift;
          if (wholeMeasureGroups) pickupTargetQuarterNotes = target;
        }
      }
      previousEvent = result.lastEvent;
      if (result.clipped) clippedGroups++;
      ignoredCharacters += result.ignored;
    });
  });
  // Explicitly voiced brackets do not use the metadataTimedContainer branch.
  // Restore ordinary silence following their final member from the same
  // persisted timing used by merged brackets. Some shared rulers omit the 0
  // while a different voice sounds across the boundary.
  for (const annotation of options.annotations ?? []) {
    if (annotation.type !== "triplet" || annotation.scope !== "voice"
      || annotation.end === undefined) continue;
    const measureStart = measureStarts[annotation.measure];
    const meter = measureMeters[annotation.measure];
    if (measureStart === undefined || !meter) continue;
    const measureEnd = measureStart + meter.beats * 4 / meter.beatType;
    for (const ordinary of annotation.ordinary ?? []) {
      if (!ordinary.rest || ordinary.part !== annotation.part
        || ordinary.offset < annotation.end - 1e-8) continue;
      const start = measureStart + ordinary.offset;
      const end = Math.min(measureEnd, start + ordinary.duration);
      if (end <= start + 1e-8) continue;
      const sameVoice = (event: TimedEvent): boolean => event.voiceIndex === ordinary.part
        || (event.restVoiceIndexes ?? []).includes(ordinary.part);
      if (events.some((event) => !event.continuationOf && sameVoice(event) && event.pitches.length > 0
        && Math.abs(event.start - start) < 1 / 192)) continue;
      const existing = events.find((event) => sameVoice(event) && event.pitches.length === 0
        && Math.abs(event.start - start) < 1 / 192);
      if (existing) { existing.end = Math.max(existing.end, end); continue; }
      events.push({ start, end, pitches: [], voiceIndex: ordinary.part,
        restVoiceIndexes: [ordinary.part], metadataVoice: true,
        writtenDurations: [end - start] });
    }
  }
  const firstEvents = events.filter((event) => event.start < measureLength - 1e-8 && event.end > 1e-8);
  const pickupCandidate = pickupTargetQuarterNotes > 1e-8 && firstEvents.length > 0;
  if (clippedGroups > 0) warnings.push(`${clippedGroups} 个拍组超过所选拍号，已在拍组边界截齐`);
  if (ignoredCharacters > 0) warnings.push(`${ignoredCharacters} 个未映射字符已按注释忽略`);
  const sources = slashPitchSources(text, options);
  const maxMarkerCount = sources.reduce((largest, source) =>
    Math.max(largest, source.markerCount), 0);
  if (maxMarkerCount >= options.voiceCount) {
    warnings.push(`发现 ${maxMarkerCount} 个连续声部标记，但当前仅启用 ${options.voiceCount} 个声部；超出部分已并入默认声部`);
  }
  const strayMarkers = straySlashVoiceMarkerCount(text, options.kind);
  if (strayMarkers > 0) warnings.push(`${strayMarkers} 个后面没有音高的声部标记已忽略`);

  if (!wholeMeasureGroups && lines.score.length === 1 && logicalMeasures.length > 1) warnings.push(`原文没有小节换行，已按 ${options.beats}/${options.beatType} 自动分成 ${logicalMeasures.length} 小节`);
  const splitEvents = splitTimedEventsByVoice(options, events, sources);
  // A parallel ordinary value can outlast a voice-local bracket. In an
  // explicitly voiced bracket the visible shared ruler only supplies its
  // first part; the annotation retains the original note's full endpoint.
  for (const annotation of options.annotations ?? []) {
    if (annotation.type !== "triplet" || annotation.end === undefined) continue;
    const measureStart = measureStarts[annotation.measure];
    const meter = measureMeters[annotation.measure];
    if (measureStart === undefined || !meter) continue;
    const measureEnd = measureStart + meter.beats * 4 / meter.beatType;
    for (const ordinary of annotation.ordinary ?? []) {
      if (ordinary.rest || ordinary.offset + ordinary.duration <= annotation.end + 1e-8) continue;
      const start = measureStart + ordinary.offset;
      const end = Math.min(measureEnd, start + ordinary.duration);
      const attack = splitEvents.find((event) => event.voiceIndex === ordinary.part
        && !event.continuationOf && event.pitches.length > 0
        && Math.abs(event.start - start) < 1 / 192);
      if (!attack) continue;
      if (end > attack.end) attack.end = end;
      // The shared ruler can print its following 0 at the bracket boundary
      // even though this ordinary voice is still sounding. Keep only the
      // part of that rest after its persisted note-off.
      for (let index = splitEvents.length - 1; index >= 0; index--) {
        const rest = splitEvents[index]!;
        if (rest.voiceIndex !== ordinary.part || rest.pitches.length > 0
          || rest.tripletGroup || rest.start < start - 1e-8
          || rest.start >= end - 1e-8) continue;
        if (rest.end <= end + 1e-8) { splitEvents.splice(index, 1); continue; }
        rest.start = end;
        rest.writtenDurations = [rest.end - end];
      }
    }
  }
  restoreAnnotatedTripletContinuations(splitEvents, options, measureStarts);
  const tripletSpellingRegions = sharedTripletRegions(splitEvents);
  const voicedEvents = addIndependentVoiceContinuations(
    splitVoicedWrittenDurations(
      splitEvents,
      options,
    ),
    options,
    measureStarts,
    measureMeters,
  );
  adoptSharedTripletSpelling(voicedEvents, tripletSpellingRegions);
  const parsed = parsedMidiFromEvents(
    voicedEvents,
    logicalMeasures.length,
    options,
    measureMeters,
  );
  // The slash rows define the authoritative measure span.  Quantization and
  // voice-continuation synthesis may leave a note-off a few ticks beyond the
  // row edge; letting that leak into MIDI measure-bound inference creates a
  // phantom second measure on a fixed four-group row (notably a voiced
  // `[...triplet...]` group).  Keep the musical timeline at the declared row
  // length while retaining all note attacks inside it.
  if (measureStarts.length > 0) parsed.endTick = Math.round(elapsed * 960);
  const instrumentName = options.instrumentName?.trim() || "钢琴";
  const openingMeter = measureMeters[0] ?? {
    beats: options.beats,
    beatType: options.beatType as 2 | 4 | 8 | 16,
  };
  const midiOptions: MidiImportOptions = {
    quantize: finestQuantize(options),
    // Merely assigning one delimiter to "triplet" must not make the MIDI
    // bridge reinterpret ordinary binary 128th subdivisions as a nearby
    // triplet grid. Explicit TXT triplet atoms already carry tripletGroup.
    detectTriplets: voicedEvents.some((event) => event.tripletGroup !== undefined),
    handMode: "single",
    splitPitch: 60,
    fifths: options.fifths,
    beats: openingMeter.beats,
    beatType: openingMeter.beatType,
    tempoBpm: options.tempoBpm,
    tempoBeatUnit: options.tempoBeatUnit,
    title: options.title || (options.kind === "keyboard" ? "键盘谱" : "数字谱"),
    subtitle: options.subtitle,
    composer: options.composer,
    arranger: options.arranger,
    lyricist: options.lyricist,
    instrumentName: options.voiceCount > 1 ? instrumentName : "",
    scoreMode: options.voiceCount > 1 ? "ensemble" : "hands",
    trackAssignments: options.voiceCount > 1
      ? Array.from({ length: options.voiceCount }, (_unused, voice) => ({
        track: voice,
        instrumentName,
        voice: voice + 1,
      }))
      : undefined,
    preserveSourceRhythmSpelling: true,
  };
  const imported = midiToScore(parsed, midiOptions);
  imported.score.headerTypography = normalizeHeaderTypography(options.headerTypography);
  // TXT meter rows and the score-settings meter are explicit notation, not
  // the legacy MIDI convention where a short opening time signature encodes
  // an anacrusis. Layout calls normalizeOpeningPickup() again, so preserve the
  // restored row-local opening meter across that later pass.
  imported.score.openingMeterIsAuthoritative = true;
  // The slash row count is authoritative.  A voiced explicit triplet can
  // leave a quantizer continuation exactly at the row edge; do not let that
  // synthetic note create a phantom trailing measure in the editable Score.
  for (const part of imported.score.parts) {
    while (part.measures.length > logicalMeasures.length) part.measures.pop();
    part.measures.forEach((measure, index) => {
      const meter = measureMeters[index];
      if (!meter) return;
      measure.time.beats = meter.beats;
      measure.time.beatType = meter.beatType;
      const previous = measureMeters[index - 1];
      measure.timeChange = index > 0 && Boolean(previous)
        && (previous!.beats !== meter.beats || previous!.beatType !== meter.beatType);
      // `midiToScore` treats a shorter first signature followed by a longer
      // one as a legacy pickup encoding. In TXT an explicit `3/4拍:` row is
      // authoritative, so a complete three-group opening measure is not a
      // pickup merely because the next row returns to 4/4.
      if (index === 0 && !structurallyShortOpening) {
        measure.pickup = false;
        if (measure.displayNumber === null) measure.displayNumber = 1;
      }
    });
  }
  ensureSlashMeasureSpan(
    imported.score,
    logicalMeasures.length,
    measureMeters,
    measureStarts,
    options.voiceCount,
    instrumentName,
    options.fifths,
  );
  if (options.voiceCount === 2) {
    imported.score.ensemble = false;
    imported.score.piano = true;
    imported.score.instrumentName = instrumentName;
    imported.score.parts[0].hand = "right";
    imported.score.parts[1].hand = "left";
  } else if (options.voiceCount <= 1) {
    imported.score.piano = false;
    imported.score.instrumentName = "";
  }
  restoreSlashDuplicatePitches(imported.score, voicedEvents);
  applySlashTuplets(imported.score, voicedEvents, options.annotations ?? []);
  // Tuplet reconstruction removes pitches introduced by binary quantization
  // at the following attack. Match and link ordinary continuations only after
  // that cleanup, when the adjacent chords contain their actual pitches.
  applySlashContinuations(imported.score, voicedEvents);
  // A written 0 remains authoritative even when the export preference hides
  // ordinary rests. Input drafts deliberately retain these cells; dropping
  // one after a tuplet loses the editable silence at its binary boundary.
  applySlashExplicitRests(imported.score, voicedEvents);
  linkSlashVariableTupletTails(imported.score);
  applySlashOrnaments(imported.score, voicedEvents);
  applySlashTempoMarks(imported.score, options.tempoMarks ?? []);
  applySlashKeyChanges(imported.score, options.fifths, options.keyChanges ?? []);
  const rowMeterAnnotations: NotationAnnotationData[] = [];
  for (let index = 1; index < measureMeters.length; index++) {
    const previous = measureMeters[index - 1];
    const current = measureMeters[index];
    if (current && previous
      && (current.beats !== previous.beats || current.beatType !== previous.beatType)) {
      rowMeterAnnotations.push({
        type: "meter",
        measure: index,
        beats: current.beats,
        beatType: current.beatType,
      });
    }
  }
  applySlashAnnotations(imported.score, [
    ...(options.annotations ?? []),
    ...rowMeterAnnotations,
  ]);
  const pickupRestDivision = (options.noteDivision ?? Math.min(
    64,
    Math.max(4, ...Object.values(effectiveMappings(options))),
  )) as SlashDurationDivision;
  const pickup = pickupCandidate
    ? applyOpeningPickup(
      imported.score,
      new Fraction(options.beats * 4, options.beatType),
      new Fraction(Math.round(pickupTargetQuarterNotes * 192), 192),
      new Fraction(Math.round(leadingPickupFillQuarterNotes * 192), 192),
      pickupRestDivision,
    )
    : { duration: 0, rests: 0 };
  const pickupQuarterNotes = pickup.duration;
  if (pickupQuarterNotes > 0) {
    const readableDuration = Number(pickupQuarterNotes.toFixed(3));
    warnings.push(`识别到 ${readableDuration} 个四分音符的弱起小节；弱起不计入正式小节号`);
  }
  if (pickup.rests > 0) warnings.push(`弱起首拍已在音符前自动补 ${pickup.rests} 个 0`);
  imported.score.parts.forEach((part) => part.measures.forEach((measure) => {
    // Portrait single-staff pages remain readable with three measures per
    // system; twelve measures form a balanced four-system page.
    const formalNumber = measure.displayNumber;
    measure.newSystem = formalNumber !== null && formalNumber > 1 && (formalNumber - 1) % 3 === 0;
    // Page breaks remain automatic so changing the global vertical system gap
    // can pull following systems back into usable space on the previous page.
    measure.newPage = false;
  }));
  applyNoteTimingEdits(imported.score, options.noteTimingEdits ?? [], "slash");
  normalizeScoreRestSpelling(imported.score);
  // `midiToScore()` builds its repeat/play range before
  // ensureSlashMeasureSpan() restores TXT-declared all-rest tail measures.
  // Layout follows playData when present, so without rebuilding it the tail
  // existed in the model and source text but was invisible on the page.
  imported.score.parseRepeatInf();
  if (options.kind === "keyboard" && options.keyboardKeyLabels) {
    applyKeyboardKeyLabels(
      imported.score,
      options.keyboardTieAsZero ?? false,
      options.keyboardHideTieLabels ?? false,
    );
  }
  return {
    score: imported.score,
    sources,
    summary: {
      kind: options.kind,
      measures: logicalMeasures.length,
      pickupQuarterNotes,
      pickupRestCount: pickup.rests,
      comments: lines.comments.length,
      ignoredTags: lines.ignoredTags,
      clippedGroups,
      ignoredCharacters,
      diagnostics,
      warnings,
    },
  };
}

function slashPitch(pitch: number, fifths: number): { degree: number; octave: number; accidental: number } {
  const relative = pitch - tonicPitch(fifths);
  let best = { degree: 0, octave: Math.floor(relative / 12), accidental: 0, cost: Infinity };
  for (let octave = Math.floor(relative / 12) - 1; octave <= Math.floor(relative / 12) + 1; octave++) {
    for (let degree = 0; degree < 7; degree++) {
      const accidental = relative - (octave * 12 + DEGREE_INTERVALS[degree]);
      const cost = Math.abs(accidental) + (Math.abs(accidental) > 1 ? 20 : 0);
      if (cost < best.cost) best = { degree, octave, accidental, cost };
    }
  }
  return best;
}

/** Apply a notation-only keyboard-key view. The numeric pitch spelling stays
 *  intact so ties, playback, source selection and JPW/MIDI export are unchanged. */
export function applyKeyboardKeyLabels(
  score: Score,
  tieAsZero: boolean,
  hideTieLabels: boolean,
): void {
  const apply = (note: Note, fifths: number, continuation = false): void => {
    if (note.rest) return;
    const value = slashPitch(note.pitch, fifths);
    const rowIndex = clamp(value.octave + 1, 0, KEYBOARD_ROWS.length - 1);
    note.displayText = KEYBOARD_ROWS[rowIndex][value.degree];
    note.displayOctave = value.octave < -1
      ? value.octave + 1
      : value.octave > 1 ? value.octave - 1 : 0;
    note.displayHidden = continuation && hideTieLabels;
    if (continuation && tieAsZero && !hideTieLabels) {
      note.displayText = "0";
      note.displayOctave = 0;
      note.displayAlter = " ";
    }
  };
  for (const part of score.parts) {
    for (const measure of part.measures) {
      for (const entry of measure.entries) {
        if (!(entry instanceof Chord)) continue;
        for (const note of entry.notes) {
          apply(
            note,
            measure.key.fifths,
            note.tieEnd || entry.transparentContinuation || entry.generatedTimingContinuation,
          );
        }
        for (const note of entry.graceNotes) apply(note, measure.key.fifths);
      }
    }
  }
}

function accidentalPrefix(accidental: number): string {
  return accidental > 0 ? "#".repeat(accidental) : accidental < 0 ? "b".repeat(-accidental) : "";
}

function numericPitchValue(pitch: number, fifths: number): string {
  const value = slashPitch(pitch, fifths);
  const octave = value.octave > 0 ? "+".repeat(value.octave) : "-".repeat(-value.octave);
  return accidentalPrefix(value.accidental) + octave + String(value.degree + 1);
}

function keyboardPitchValue(pitch: number, fifths: number): string {
  const value = slashPitch(pitch, fifths);
  let octave = value.octave;
  let prefix = "";
  if (octave < -1) { prefix = ",".repeat(-octave - 1); octave = -1; }
  else if (octave > 1) { prefix = "'".repeat(octave - 1); octave = 1; }
  const row = KEYBOARD_ROWS[octave + 1];
  return accidentalPrefix(value.accidental) + prefix + row[value.degree];
}

function chordToken(chord: Chord, kind: SlashScoreKind): string {
  const fifths = chord.measure.key.fifths;
  const values = chord.notes.filter((note) => !note.rest)
    .map((note) => kind === "keyboard" ? keyboardPitchValue(note.pitch, fifths) : numericPitchValue(note.pitch, fifths));
  if (values.length === 0) return "";
  return values.length === 1 ? values[0] : `(${values.join("")})`;
}

interface OutputEvent {
  start: number;
  end: number;
  chords: Chord[];
  /** One-based source part for each chord, parallel to `chords`. */
  voiceIndexes?: number[];
  /** One-based voices whose rests begin at this column. */
  restVoiceIndexes?: number[];
  specialToken?: string;
  /** The token already contains all duration marks, as with `[A..B..C..]`. */
  embeddedDuration?: number;
  /** A cursor-created tuplet advances only its explicitly marked TXT voice. */
  parallelVoiceTuplet?: boolean;
  /** Voice whose ordinary sound continues after a merged visible Tuplet. */
  continuationVoiceAfterEmbedded?: number;
  hidden?: boolean;
  /** Sound began in an earlier slash group; emit only continuation markers. */
  continued?: boolean;
  /** MIDI note-on pitches at this column, excluding split note-off continuations. */
  explicitPitches?: number[];
  /** One shared arpeggio selected across two or more rendered parts. */
  crossArpeggioGroups?: Array<Array<{ part: number; pitch: number }>>;
}

/** Return the diatonic neighbour used by the compact TXT mordent spelling. */
function ornamentNeighbour(note: Note, kind: "upper-mordent" | "lower-mordent"): number {
  const value = slashPitch(note.pitch, note.chord.measure.key.fifths);
  const step = kind === "upper-mordent" ? 1 : -1;
  let degree = value.degree + step;
  let octave = value.octave;
  if (degree < 0) { degree = 6; octave--; }
  if (degree > 6) { degree = 0; octave++; }
  return tonicPitch(note.chord.measure.key.fifths) + DEGREE_INTERVALS[degree] + octave * 12;
}

/**
 * TXT has no standalone mordent token.  When one of the configured group
 * delimiters is a triplet, encode the ornament as three fixed 3:2 atoms:
 * the written chord, its diatonic neighbour, and the written note again.
 * The voice prefix is repeated on generated atoms so a multi-voice line keeps
 * its original assignment after parsing.
 */
function slashMordentToken(
  event: OutputEvent,
  token: string,
  kind: SlashScoreKind,
  fifths: number,
  voiceCount: number,
  groups: SlashExportGroupModes,
  durationText?: (duration: number) => string,
  nominalUnit?: number,
  embeddedInTuplet = false,
): string {
  // Wave ornaments use the canonical `[ABA]` spelling only when square
  // brackets are explicitly assigned to triplets.  Other triplet delimiters
  // remain available for real tuplets but do not silently change ornament
  // syntax.
  const tripletDelimiter = groups.bracketMode === "triplet"
    ? (["[", "]"] as const)
    : null;
  if (!tripletDelimiter) return token;
  // Membership belongs to the decorated chord's voice, not to every other
  // chord sharing its printed column.
  for (let chordIndex = 0; chordIndex < event.chords.length; chordIndex++) {
    const chord = event.chords[chordIndex]!;
    const ornament = chord.ornaments.find((item) =>
      item.kind === "upper-mordent" || item.kind === "lower-mordent");
    if (!ornament) continue;
    const notes = chord.notes.filter((note) => !note.rest);
    if (notes.length === 0) continue;
    // A stored TXT document keeps the semantic ornament in @jpeditor while
    // its visible spelling is already an explicit three-note tuplet.  Do not
    // expand that same ornament again on the next edit/save cycle.
    if (notes.some((note) => note.tupletBegin || note.tupletEnd || note.tuplet !== null)) continue;
    const target = ornament.kind === "upper-mordent"
      ? notes.reduce((left, right) => left.pitch >= right.pitch ? left : right)
      : notes.reduce((left, right) => left.pitch <= right.pitch ? left : right);
    const neighbour = ornamentNeighbour(target, ornament.kind);
    const voice = clamp(event.voiceIndexes?.[chordIndex] ?? voiceCount, 1, voiceCount);
    const prefix = voice === voiceCount ? "" : SLASH_VOICE_SEPARATOR.repeat(voice);
    const value = (pitch: number): string => prefix + (kind === "keyboard"
      ? keyboardPitchValue(pitch, fifths)
      : numericPitchValue(pitch, fifths));
    // Realize the mordent at the selected text grid, then let the returned
    // target pitch sustain through the remainder of the original value.  A
    // 3:2 group of three nominal grid cells occupies two cells in real time.
    // Using half of a long source note here used to turn one whole-note
    // ornament into a four-quarter tuplet and then append the sustain again.
    const sourceDuration = Math.max(1 / 192, event.end - event.start);
    // The compact TXT grid no longer needs a dedicated subdivision bracket.
    // Three attached pitches are one binary level finer than the configured
    // minimum, while the ordinary marker after the group declares the main
    // note's real written duration: `[ASA].` when `.` is a sixteenth.  The
    // metadata makes these helpers semantic, so a configured intrinsic note
    // value can disable general attached-note subdivision without exposing
    // S/A as three sounding notes.
    const triplet = `${tripletDelimiter[0]}${token}${value(neighbour)}${value(target.pitch)}${tripletDelimiter[1]}`;
    if (embeddedInTuplet) return triplet;
    const writtenDuration = Math.min(sourceDuration, Math.max(1 / 192, nominalUnit ?? sourceDuration));
    const outerDuration = durationText?.(writtenDuration) ?? "";
    if (!outerDuration) return token;
    event.embeddedDuration = writtenDuration;
    return `${triplet}${outerDuration}`;
  }
  return token;
}

/** The inverse of a bracket's intrinsic budget and relative member weights. */
function intrinsicTupletSpelling(
  chain: readonly Chord[],
  noteUnit: number,
  glyphUnit: number,
): { weights: number[]; extra: number } | null {
  if (noteUnit <= 1e-9 || chain.length === 0) return null;
  const spans = chain.map((chord) => chord.duration ?? new Fraction(0));
  const span = spans.reduce((sum, value) => sum + value.toFloat(), 0);
  const extra = span - noteUnit;
  const onGrid = (value: number): boolean => value >= -1e-8
    && (Math.abs(value) < 1e-8 || Number.isFinite(glyphUnit)
      && Math.abs(value / glyphUnit - Math.round(value / glyphUnit)) < 1e-7);
  if (!onGrid(extra) || spans.some((value) => value.numerator <= 0)) return null;
  const gcd = (left: number, right: number): number => {
    while (right !== 0) [left, right] = [right, left % right];
    return Math.abs(left);
  };
  let denominator = 1;
  for (const value of spans) {
    denominator = denominator / gcd(denominator, value.denominator) * value.denominator;
    if (!Number.isSafeInteger(denominator)) return null;
  }
  const counts = spans.map((value) => value.numerator * denominator / value.denominator);
  const divisor = counts.reduce((common, value) => gcd(common, value));
  const weights = counts.map((value) => value / divisor * noteUnit);
  if (weights.some((value) => !onGrid(value - noteUnit))) return null;
  // Members express relative weights; only the complete bracket owns the
  // intrinsic value. Keep ordinary ratios compact (ABC or A.BC), and put the
  // remaining elapsed value outside the bracket exactly once.
  return { weights, extra: Math.max(0, extra) };
}

/** Re-encode semantic tuplets and retain their real span on the TXT timeline. */
function preserveScoreTuplets(
  events: OutputEvent[],
  measures: readonly (Measure | undefined)[],
  durationText: (duration: number) => string,
  baseUnit: number,
  noteUnit: number,
  kind: SlashScoreKind,
  fifthsAt: (offset: number) => number,
  voiceCount: number,
  ordering: MidiSlashOrdering,
  groups: SlashExportGroupModes,
  preserveExplicitRests: boolean,
  beatDuration: number,
  glyphUnit: number,
): OutputEvent[] {
  const delimiter = delimiterFor("triplet", groups);
  if (!delimiter) return events;
  const subdivisionDelimiter = delimiterFor("subdivide", groups);
  const hidden = new Set<OutputEvent>();
  type TupletExportInfo = {
    tuplet: Tuplet;
    measure: Measure;
    partIndex: number;
    voice: number;
    chain: Chord[];
    start: number;
    end: number;
  };
  const infos: TupletExportInfo[] = [];
  const seenTuplets = new Set<Tuplet>();
  measures.forEach((measure, partIndex) => {
    if (!measure) return;
    for (const entry of measure.entries) {
      if (!(entry instanceof Chord)) continue;
      for (const note of entry.notes) {
        const tuplet = note.tuplet;
        if (!tuplet || tuplet.ornamentProxy || seenTuplets.has(tuplet)) continue;
        seenTuplets.add(tuplet);
        const chain = tuplet.memberChords().filter((chord) => chord.measure === measure);
        if (chain.length === 0) continue;
        const start = tuplet.actualStart?.toFloat() ?? chain[0]!.position.toFloat();
        const end = tuplet.actualEnd?.toFloat() ?? Math.max(...chain.map((chord) =>
          chord.position.plus(chord.duration ?? new Fraction(1, 192)).toFloat()));
        infos.push({
          tuplet,
          measure,
          partIndex,
          voice: clamp(tuplet.voiceIndex ?? partIndex + 1, 1, voiceCount),
          chain,
          start,
          end,
        });
      }
    }
  });
  const handledTuplets = new Set<Tuplet>();
  const scoped = infos.filter((info) => info.tuplet.scope === "voice")
    .sort((left, right) => left.start - right.start || right.end - left.end);
  for (let at = 0; at < scoped.length;) {
    const cluster: TupletExportInfo[] = [scoped[at]!];
    let clusterStart = scoped[at]!.start;
    let clusterEnd = scoped[at]!.end;
    let cursor = at + 1;
    while (cursor < scoped.length && scoped[cursor]!.start < clusterEnd - 1e-8) {
      cluster.push(scoped[cursor]!);
      clusterStart = Math.min(clusterStart, scoped[cursor]!.start);
      clusterEnd = Math.max(clusterEnd, scoped[cursor]!.end);
      cursor++;
    }
    at = cursor;
    const tupleVoices = new Set(cluster.map((info) => info.voice));
    const relevant = events.filter((event) => event.start >= clusterStart - 1e-8
      && event.start < clusterEnd - 1e-8);
    const parallelEvents = relevant.filter((event) =>
      (event.voiceIndexes ?? []).some((voice) => !tupleVoices.has(voice))
      || (event.restVoiceIndexes ?? []).some((voice) => !tupleVoices.has(voice)));
    // A normal binary voice may begin between two compressed 3:2 members.
    // It still belongs inside the one visible bracket: ordering the real
    // starts naturally places a 1/2-beat attack between the 1/3 and 2/3
    // members, while the persisted voice-scoped Tuplet metadata keeps the
    // two timelines independent on reload.
    // Shared TXT is a placement guide, not the ordinary voice's clock. A
    // longer first tuplet member must not eject its shorter binary partner
    // from the bracket. Ordinary offsets/durations are restored separately
    // from metadata, including when their first attack starts inside the
    // group rather than together with its first member.
    const mergeParallelMaterial = parallelEvents.length > 0;
    const crossesBeat = Math.floor((clusterStart + 1e-8) / beatDuration)
      !== Math.floor((clusterEnd - 1e-8) / beatDuration);
    if (crossesBeat && noteUnit <= baseUnit + 1e-8) {
      // A slash is a real beat boundary for plain TXT readers. Keep the
      // rhythmic ruler in every covered beat, instead of packing the whole
      // group into the first bracket and leaving later beats as placeholders.
      // Only the printed columns snap; annotations retain both voice clocks.
      const step = baseUnit * 2 / 3;
      for (let beat = Math.floor(clusterStart / beatDuration);
        beat * beatDuration < clusterEnd - 1e-8; beat++) {
        const start = Math.max(clusterStart, beat * beatDuration);
        const end = Math.min(clusterEnd, (beat + 1) * beatDuration);
        const columns = new Map<number, OutputEvent>();
        for (const source of relevant) {
          if (source.start < start - 1e-8 || source.start >= end - 1e-8) continue;
          if (source.chords.length === 0 && !(source.restVoiceIndexes?.length)) continue;
          const snapped = Math.max(start, Math.min(end - step,
            start + Math.round((source.start - start) / step) * step));
          // A printed column may snap, but distinct real attacks are never
          // merged into a chord, even when their printed positions coincide.
          const key = Math.round(source.start * 192) / 192;
          let column = columns.get(key);
          if (!column) {
            column = { start: snapped, end: snapped, chords: [], voiceIndexes: [], restVoiceIndexes: [] };
            columns.set(key, column);
          }
          column.chords.push(...source.chords);
          column.voiceIndexes!.push(...source.voiceIndexes ?? []);
          column.restVoiceIndexes!.push(...source.restVoiceIndexes ?? []);
        }
        const ordered = [...columns.values()].sort((a, b) => a.start - b.start);
        let body = durationText(((ordered[0]?.start ?? end) - start) * 1.5);
        let written = ((ordered[0]?.start ?? end) - start) * 1.5;
        ordered.forEach((column, index) => {
          let token = outputToken(column, kind, fifthsAt(column.start), voiceCount,
            ordering, groups, durationText, undefined, true) || "0";
          token = slashMordentToken(column, token, kind, fifthsAt(column.start), voiceCount,
            groups, undefined, undefined, true);
          token = explicitDefaultTimedToken(token, voiceCount);
          const next = ordered[index + 1]?.start ?? end;
          // Distinct attacks can share a snapped position. Tight adjacency
          // still consumes a half-cell, so debit it from the following cell
          // instead of adding it on top of an already full beat's markers.
          const remaining = (next - start) * 1.5 - written;
          const nominal = noteUnit <= 1e-9 && remaining < baseUnit - 1e-8
            ? baseUnit / 2
            : Math.max(noteUnit, Math.floor((remaining + 1e-8) / baseUnit) * baseUnit);
          if (index > 0 && !delimiterFor("chord", groups)) body += "\t";
          body += token + (noteUnit <= 1e-9 && nominal < baseUnit - 1e-8
            ? "" : durationText(Math.max(0, nominal - noteUnit)));
          written += nominal;
        });
        events.push({ start, end, chords: [], voiceIndexes: [],
          specialToken: `${delimiter[0]}${body}${delimiter[1]}`,
          embeddedDuration: end - start, parallelVoiceTuplet: false });
      }
      for (const event of relevant) hidden.add(event);
      for (const info of cluster) handledTuplets.add(info.tuplet);
      continue;
    }
    if (cluster.length === 1 && !mergeParallelMaterial) continue;

    const starts = [...new Set([
      ...cluster.flatMap((info) => info.chain.map((chord) => chord.position.toFloat())),
      ...relevant.filter((event) => event.chords.length > 0
        || (event.restVoiceIndexes?.length ?? 0) > 0).map((event) => event.start),
    ].map((value) => Math.round(value * 192) / 192))].sort((left, right) => left - right);
    const atoms: string[] = [];
    for (const start of starts) {
      const sources = events.filter((event) => Math.abs(event.start - start) < 1 / 192);
      const synthetic: OutputEvent = sources.length > 0 ? {
        ...sources[0],
        end: Math.max(...sources.map((event) => event.end)),
        chords: sources.flatMap((event) => event.chords),
        voiceIndexes: sources.flatMap((event) => event.voiceIndexes ?? []),
        restVoiceIndexes: [...new Set(sources.flatMap((event) => event.restVoiceIndexes ?? []))],
        specialToken: undefined,
        embeddedDuration: undefined,
        parallelVoiceTuplet: false,
        continuationVoiceAfterEmbedded: undefined,
        explicitPitches: undefined,
        crossArpeggioGroups: sources.flatMap(event => event.crossArpeggioGroups ?? []),
      } : {
        start,
        end: start + 1 / 192,
        chords: [],
        voiceIndexes: [],
        restVoiceIndexes: [],
      };
      synthetic.restVoiceIndexes = (synthetic.restVoiceIndexes ?? []).filter((voice) =>
        !cluster.some((info) => info.voice === voice
          && start < info.start - 1 / 192
          && info.start < clusterEnd - 1 / 192));
      if (synthetic.chords.length === 0 && synthetic.restVoiceIndexes.length === 0) {
        synthetic.specialToken = undefined;
      }
      for (const info of cluster) {
        const member = info.chain.find((chord) => Math.abs(chord.position.toFloat() - start) < 1 / 192);
        if (!member) continue;
        if (member.rest) {
          synthetic.restVoiceIndexes = [...new Set([...(synthetic.restVoiceIndexes ?? []), info.voice])];
        } else if (!synthetic.chords.includes(member)) {
          synthetic.chords.push(member);
          synthetic.voiceIndexes = [...(synthetic.voiceIndexes ?? []), info.voice];
        }
      }
      // A voice-local tuplet may have a silent member in a column where
      // another member of the same merged cluster is sounding.  That gap is
      // implicit in the shared bracket; printing it as a chord zero creates
      // `(0W)`/`(VG)0` and changes the compact TXT timing after reload.  Keep
      // rests when the complete cluster column is silent, and preserve rests
      // from voices outside this cluster.
      const clusterSounding = synthetic.chords.some((chord, chordIndex) => {
        const voice = synthetic.voiceIndexes?.[chordIndex];
        return voice !== undefined && tupleVoices.has(voice)
          && chord.notes.some((note) => !note.rest);
      });
      const coveredByClusterSound = cluster.some((info) => info.chain.some((chord) =>
        !chord.rest
        && chord.notes.some((note) => !note.rest)
        && chord.position.toFloat() < start - 1e-8
        && chord.position.plus(chord.duration ?? new Fraction(0)).toFloat() > start + 1e-8));
      const laterSounding = cluster.some((info) => info.chain.some((chord) =>
        chord.position.toFloat() > start + 1e-8
        && chord.position.toFloat() < clusterEnd - 1e-8
        && !chord.rest
        && chord.notes.some((note) => !note.rest)));
      const mayHideRestVoice = (voice: number): boolean => !cluster.some((info) =>
        info.voice === voice && info.chain.some((chord) =>
          chord.position.toFloat() > start + 1e-8
          && chord.position.toFloat() < clusterEnd - 1e-8
          && !chord.rest
          && chord.notes.some((note) => !note.rest)));
      if (clusterSounding || coveredByClusterSound) {
        synthetic.restVoiceIndexes = (synthetic.restVoiceIndexes ?? [])
          .filter((voice) => !tupleVoices.has(voice) || !mayHideRestVoice(voice));
      } else if (laterSounding) {
        synthetic.restVoiceIndexes = (synthetic.restVoiceIndexes ?? [])
          .filter((voice) => !tupleVoices.has(voice) || !mayHideRestVoice(voice));
      }
      if ((laterSounding || coveredByClusterSound)
        && synthetic.chords.length === 0
        && (synthetic.restVoiceIndexes?.length ?? 0) === 0) {
        // The voice-local metadata retains this silent member's exact grid.
        // Writing a visible fallback `0` here produces `(VG)0(0W)0`; omit the
        // interior all-silent column and keep only the final real rest atom.
        // This is the compact shared-bracket spelling users expect, while a
        // metadata-assisted reload still restores both independent tuplets.
        continue;
      }
      let token = outputToken(
        synthetic,
        kind,
        fifthsAt(start),
        voiceCount,
        ordering,
        groups,
        durationText,
        undefined,
        true,
      ) || "0";
      token = slashMordentToken(synthetic, token, kind, fifthsAt(start), voiceCount,
        groups, undefined, undefined, true);
      if (tupleVoices.has(voiceCount)) {
        // In a mixed bracket the otherwise-unmarked default voice is
        // ambiguous with ordinary parallel material. Prefix only those
        // unmarked atoms; already marked V1…Vn tokens remain untouched.
        token = explicitDefaultTimedToken(token, voiceCount);
      }
      const defaultVoiceTupleRestOnly = synthetic.chords.length === 0
        && cluster.some((info) => info.voice === voiceCount
          && info.chain.some((chord) => chord.rest
            && Math.abs(chord.position.toFloat() - start) < 1 / 192));
      if (defaultVoiceTupleRestOnly) {
        // Bare adjacent zeroes inside a marker-only bracket are otherwise
        // read as compact padding/grace syntax.  Mark a default-voice Tuplet
        // rest with the explicit-default sentinel just like the single-Tuplet
        // writer does, so `[A00]` yields all three real members on reload.
        token = explicitDefaultTimedToken(token, voiceCount);
      }
      const nominals = cluster.flatMap((info) => info.chain.flatMap((chord) =>
        Math.abs(chord.position.toFloat() - start) < 1 / 192
          ? [info.tuplet.writtenMemberDuration(
            chord.duration ?? new Fraction(1, 192),
          ).toFloat()]
          : []));
      const attached = noteUnit <= 1e-9 && nominals.some((duration) => duration < baseUnit - 1e-8);
      const printed = nominals.length > 0
        ? Math.max(...nominals)
        : Math.max(baseUnit, Math.min(clusterEnd - start, synthetic.end - synthetic.start));
      // An ordinary attack inserted between Tuplet members is ordered by its
      // real start and uses tight adjacency for its partial span. Giving it a
      // full base marker here moved the following Tuplet member and produced
      // `[A.D.A..]` plus an extra zero after the bracket.
      const parallelOnlyStart = nominals.length === 0;
      atoms.push(token + (attached || parallelOnlyStart
        ? ""
        : durationText(Math.max(0, printed - noteUnit))));
    }
    if (atoms.length === 0) continue;
    let first = events.find((event) => Math.abs(event.start - clusterStart) < 1 / 192);
    if (!first) {
      first = {
        start: clusterStart,
        end: clusterEnd,
        chords: [],
        voiceIndexes: [],
        restVoiceIndexes: [],
      };
      events.push(first);
    }
    first.specialToken = `${delimiter[0]}${atoms.join(delimiterFor("chord", groups) ? "" : "\t")}${delimiter[1]}`;
    first.embeddedDuration = clusterEnd - clusterStart;
    first.end = Math.max(first.end, clusterEnd);
    first.parallelVoiceTuplet = false;
    const continuingParallel = parallelEvents
      .filter((event) => event.start < clusterEnd - 1e-8 && event.end > clusterEnd + 1e-8)
      .sort((left, right) => right.start - left.start);
    const continuingVoices = [...new Set(continuingParallel.flatMap((event) =>
      (event.voiceIndexes ?? []).filter((voice) => !tupleVoices.has(voice))))];
    first.continuationVoiceAfterEmbedded = continuingVoices.length === 1
      ? continuingVoices[0]
      : undefined;
    for (const event of relevant) {
      if (event !== first) hidden.add(event);
    }
    for (const info of cluster) handledTuplets.add(info.tuplet);
  }
  for (let partIndex = 0; partIndex < measures.length; partIndex++) {
    const measure = measures[partIndex];
    if (!measure) continue;
    const entries = measure.entries
      .filter((entry): entry is Chord => entry instanceof Chord
        && entry.notes.some((note) => note.tuplet !== null))
      .sort((left, right) => left.position.compareTo(right.position));
    for (let index = 0; index < entries.length; index++) {
      const begin = entries[index];
      const tuplet = begin.notes.find((note) => note.tuplet !== null
        && (note.tupletBegin
          || (note.tuplet.ornamentProxy && note.tuplet.first === note)))?.tuplet;
      if (!tuplet) continue;
      if (handledTuplets.has(tuplet)) continue;
      const endsTuplet = (chord: Chord): boolean => chord.notes.some((note) =>
        note.tuplet === tuplet
        && (note.tupletEnd || (tuplet.ornamentProxy && tuplet.last === note)));
      const chain: Chord[] = [begin];
      for (let cursor = index + 1; cursor < entries.length; cursor++) {
        const chord = entries[cursor];
        if (!chord.notes.some((note) => note.tuplet === tuplet)) continue;
        chain.push(chord);
        if (endsTuplet(chord)) break;
      }
      if (!endsTuplet(chain[chain.length - 1])) continue;
      const tupletVoice = clamp(tuplet.voiceIndex ?? partIndex + 1, 1, voiceCount);
      const chainEnd = chain[chain.length - 1].position
        .plus(chain[chain.length - 1].duration ?? new Fraction(0)).toFloat();
      if (tuplet.scope === "all" && events.some((event) => !hidden.has(event)
        && event.specialToken?.startsWith(delimiter[0])
        && event.embeddedDuration !== undefined
        && event.start <= begin.position.toFloat() + 1e-8
        && event.start + event.embeddedDuration >= chainEnd - 1e-8)) {
        // The earlier voice already wrote this shared clock and its real
        // attacks. A derived accompaniment Tuplet adds only notation; do not
        // materialize its now-hidden atoms a second time after the bracket.
        index += chain.length - 1;
        continue;
      }
      const matched = chain.map((chord) => events.find((event) =>
        // `measureEvents()` uses measure-local offsets; the current measure is
        // already selected by the caller, so do not add its absolute position.
        !hidden.has(event) && Math.abs(event.start - chord.position.toFloat()) < 1 / 192
        && (event.chords.includes(chord)
          || chord.rest && (event.restVoiceIndexes ?? []).includes(tupletVoice))));
      const materialized = matched.map((event, chordIndex): OutputEvent => event ?? (() => {
        const chord = chain[chordIndex];
        const rest = chord.rest || chord.notes.every((note) => note.rest);
        // A source-less tied member shares the original column with the
        // other voice's real attack. Reuse that event so a second voice's
        // readable Tuplet cannot emit another full bracket at the same beat.
        if (chord.transparentContinuation && tuplet.scope === "all") {
          const shared = events.find((candidate) => !hidden.has(candidate)
            && Math.abs(candidate.start - chord.position.toFloat()) < 1 / 192);
          if (shared) return shared;
        }
        const synthetic: OutputEvent = {
          start: chord.position.toFloat(),
          end: chord.position.plus(chord.duration ?? new Fraction(1, 192)).toFloat(),
          chords: rest || chord.transparentContinuation ? [] : [chord],
          voiceIndexes: rest || chord.transparentContinuation ? [] : [tupletVoice],
          restVoiceIndexes: rest ? [tupletVoice] : [],
          specialToken: rest && voiceCount <= 1 ? "0" : undefined,
        };
        events.push(synthetic);
        return synthetic;
      })());
      const first = materialized[0];
      // A synchronized event may be visited again for another voice. The
      // first pass already emitted every simultaneous pitch in its atom, so
      // wrapping the same shared event again would create `[[...]]`.
      if (first.specialToken?.startsWith(delimiter[0])
        || (subdivisionDelimiter
          && first.specialToken?.startsWith(`${subdivisionDelimiter[0]}${delimiter[0]}`))) continue;
      const nominalDurations = chain.map((chord, chordIndex) => {
        const output = materialized[chordIndex];
        const actual = Math.max(
          1 / 192,
          chord.duration?.toFloat() ?? output.end - output.start,
        );
        return actual * 1.5;
      });
      const intrinsic = tuplet.scope === "all" && !tuplet.ornamentProxy
        && !chain.some((chord) => chord.transparentContinuation)
        && !(tuplet.last.tieNext && !chain.includes(tuplet.last.tieNext.chord))
        ? intrinsicTupletSpelling(chain, noteUnit, glyphUnit)
        : null;
      // With marker-only rhythm, attached atoms are the one-level-finer grid.
      // A 32nd-note triplet on a 16th-note document is therefore `[ABC]`, not
      // the removed `<[ABC]>` subdivision wrapper. Intrinsic note values turn
      // this shorthand off because every pitch already owns its configured
      // duration.
      const useAttachedSubdivision = noteUnit <= 1e-9
        && nominalDurations.some((duration) => duration < baseUnit - 1e-8);
      const splitParallelVoices = tuplet.scope === "voice" && !tuplet.ornamentProxy;
      const eventForVoice = (output: OutputEvent, includeTupletVoice: boolean): OutputEvent => {
        if (!splitParallelVoices) {
          return includeTupletVoice
            ? {
              ...output,
              specialToken: undefined,
              embeddedDuration: undefined,
              parallelVoiceTuplet: false,
              explicitPitches: undefined,
            }
            : {
              ...output,
              chords: [],
              voiceIndexes: [],
              restVoiceIndexes: [],
              specialToken: undefined,
            };
        }
        const chords: Chord[] = [];
        const voiceIndexes: number[] = [];
        output.chords.forEach((chord, chordIndex) => {
          const voice = output.voiceIndexes?.[chordIndex] ?? voiceCount;
          if ((voice === tupletVoice) !== includeTupletVoice) return;
          chords.push(chord);
          voiceIndexes.push(voice);
        });
        return {
          ...output,
          chords,
          voiceIndexes,
          restVoiceIndexes: (output.restVoiceIndexes ?? []).filter((voice) =>
            (voice === tupletVoice) === includeTupletVoice),
          specialToken: undefined,
          embeddedDuration: undefined,
          parallelVoiceTuplet: false,
          explicitPitches: undefined,
        };
      };
      const residualized = new Set<OutputEvent>();
      for (const output of materialized) {
        if (!splitParallelVoices) break;
        if (residualized.has(output)) continue;
        residualized.add(output);
        const residual = eventForVoice(output, false);
        if (residual.chords.length > 0 || (residual.restVoiceIndexes?.length ?? 0) > 0) {
          events.push(residual);
        }
      }
      const atoms = materialized.map((_event, chordIndex) => {
        const output = eventForVoice(materialized[chordIndex], true);
        let token = outputToken(
          output,
          kind,
          fifthsAt(output.start),
          voiceCount,
          ordering,
          groups,
          durationText,
          undefined,
          true,
        ) || (chain[chordIndex].transparentContinuation ? "" : "0");
        if (splitParallelVoices && voiceCount > 1 && tupletVoice === voiceCount) {
          token = explicitDefaultTimedToken(token, voiceCount);
        }
        // A common event can also contain a longer note from another voice at
        // the first triplet column. Use this tuplet voice's own nominal value,
        // then subtract the intrinsic note/chord/rest value exactly once.
        // Without this subtraction `Q.` (eighth with a 16th intrinsic value)
        // became `Q..`, inflating every triplet atom on the next parse.
        const nominal = nominalDurations[chordIndex];
        const containerNominal = intrinsic?.weights[chordIndex] ?? nominal;
        // A semantic ABA mordent deliberately uses the container's implicit
        // finest-grid members (`<[ASA]>`). Re-emitting explicit duration
        // glyphs after reload changes it to `<[A.S.A.]>` and makes subsequent
        // saves depend on the toolbar state even though the timing is equal.
        // Compact attachment only describes atoms that are actually one
        // binary level finer than the document grid.  Once one member is
        // lengthened, suppressing every suffix turns e.g. `[010]` into
        // ambiguous `[01]`; a reload then reads both remaining members as
        // equal 32nd-triplet cells and shortens the whole group.  Keep the
        // compact spelling for the fine atoms, but write the longer member's
        // own duration marker (`[01.]` on a 16th-note document).
        const attachedSubdivisionAtom = useAttachedSubdivision
          && nominal < baseUnit - 1e-8;
        return token + (tuplet.ornamentProxy || attachedSubdivisionAtom
          ? ""
          : durationText(Math.max(0, containerNominal - noteUnit)));
      }).join(!delimiterFor("chord", groups) && !tuplet.ornamentProxy ? "\t" : "");
      const tripletToken = `${delimiter[0]}${atoms}${delimiter[1]}`
        + (intrinsic ? durationText(intrinsic.extra) : "");
      first.specialToken = tripletToken;
      first.embeddedDuration = chain.reduce((sum, chord) =>
        sum + Math.max(1 / 192, chord.duration?.toFloat() ?? 0), 0);
      if (!tuplet.ornamentProxy) first.end = Math.max(first.end, first.start + first.embeddedDuration);
      first.parallelVoiceTuplet = tuplet.scope === "voice"
        && voiceCount > 1
        && explicitTimedContainerVoice(atoms) !== null;
      // The last member may have an explicit tie continuation regardless of
      // how many members the tuplet contains (including 6×32 subdivisions).
      // Rely on the semantic tie rather than the historical three-member
      // count; a repeated pitch without tieNext remains a fresh attack.
      const tailCandidate = tuplet.last.tieNext?.chord ?? null;
      const tail = tuplet.ornamentProxy || tailCandidate?.generatedTimingContinuation
        ? null
        : tailCandidate;
      if (tail && tail.measure === measure && !chain.includes(tail)) {
        const tailEvent = events.find((event) =>
          Math.abs(event.start - tail.position.toFloat()) < 1 / 192);
        if (tailEvent && !tailEvent.chords.includes(tail)) {
          tailEvent.chords.push(tail);
          tailEvent.voiceIndexes = [...(tailEvent.voiceIndexes ?? []), tupletVoice];
          tailEvent.specialToken = undefined;
        }
      }
      materialized.slice(1).forEach((event) => hidden.add(event));
      index += chain.length - 1;
    }
  }
  const visible = events.filter((event) => !hidden.has(event));
  if (preserveExplicitRests) {
    // A bare duration glyph after a Tuplet means "keep sustaining the last
    // pitch" in TXT.  Therefore an ordinary rest beginning at the Tuplet
    // boundary (or after its tied outside continuation) must remain an
    // explicit zero; otherwise save/reload silently stretches the pitch.
    // Tuplet-owned zeroes are already encoded inside the bracket and are not
    // added a second time here. When the final member itself is zero, its
    // following silence may also stay on the shared ruler without another 0.
    measures.forEach((measure, partIndex) => {
      if (!measure) return;
      for (const entry of measure.entries) {
        if (!(entry instanceof Chord)
          || !entry.rest
          || entry.notes.some((note) => note.tuplet !== null)) continue;
        const start = entry.position.toFloat();
        const end = entry.position.plus(entry.duration ?? new Fraction(1, 192)).toFloat();
        // Shared containers already carry every parallel attack/rest beginning
        // inside their span. Re-inserting that rest after the bracket advances
        // the shared cursor twice and can overfill an otherwise valid beat.
        if (visible.some((event) => event.embeddedDuration !== undefined
          && !event.parallelVoiceTuplet && event.specialToken !== undefined
          && event.specialToken !== "0" && event.start <= start + 1e-8
          && event.start + event.embeddedDuration > start + 1e-8)) continue;
        const followsSameVoiceTupletBoundary = measure.entries.some((candidate) =>
          candidate instanceof Chord
          && candidate.position.plus(candidate.duration ?? new Fraction(0)).equals(entry.position)
          && candidate.notes.some((note) => note.tuplet !== null
            && note.tupletEnd
            && clamp(note.tuplet.voiceIndex ?? partIndex + 1, 1, voiceCount) === partIndex + 1));
        const parallelSoundAcrossBoundary = measures.some((parallel, parallelPartIndex) =>
          parallelPartIndex !== partIndex && parallel?.entries.some((candidate) => {
            if (!(candidate instanceof Chord) || candidate.rest) return false;
            const candidateEnd = candidate.position.plus(candidate.duration ?? new Fraction(0));
            return candidate.position.compareTo(entry.position) < 0
              && candidateEnd.compareTo(entry.position) > 0;
          }));
        // A rest before a fresh attack later in this slash beat is a real
        // separation in its own voice. Clearing its zero would turn the
        // preceding ruler into a prefix of that later note on reload.
        const groupEnd = (Math.floor((start + 1e-8) / beatDuration) + 1) * beatDuration;
        const laterAttackInGroup = measure.entries.some((candidate) =>
          candidate instanceof Chord && !candidate.rest
          && !candidate.generatedTimingContinuation
          && !candidate.transparentContinuation
          && candidate.notes.some((note) => !note.rest && !note.tieEnd)
          && candidate.position.toFloat() > start + 1e-8
          && candidate.position.toFloat() < groupEnd - 1e-8);
        if (followsSameVoiceTupletBoundary && parallelSoundAcrossBoundary
          && !laterAttackInGroup) {
          // When another voice crosses the Tuplet boundary, it receives an
          // explicit continuation prefix, so this lane is already known to
          // stop at the bracket. Otherwise preserve the following rest:
          // removing it makes a later filled final member sustain on reload.
          // Remove only this voice's explicit rest payload; retaining the
          // empty timing event still advances the common cursor and preserves
          // simultaneous notes/rests from all other voices.
          const continuation = visible.find((candidate) => Math.abs(candidate.start - start) < 1 / 192);
          if (continuation) {
            continuation.end = Math.max(continuation.end, end);
            continuation.restVoiceIndexes = (continuation.restVoiceIndexes ?? [])
              .filter((voice) => voice !== partIndex + 1);
            if (continuation.chords.length === 0
              && continuation.restVoiceIndexes.length === 0
              && (continuation.specialToken === undefined || continuation.specialToken === "0")) {
              continuation.specialToken = undefined;
            }
          }
          continue;
        }
        let event = visible.find((candidate) => Math.abs(candidate.start - start) < 1 / 192);
        if (!event) {
          event = {
            start,
            end,
            chords: [],
            voiceIndexes: [],
            restVoiceIndexes: [],
          };
          visible.push(event);
        }
        event.end = Math.max(event.end, end);
        const voice = partIndex + 1;
        event.restVoiceIndexes = [...new Set([...(event.restVoiceIndexes ?? []), voice])];
        if (event.chords.length === 0 && event.specialToken === undefined) event.specialToken = "0";
      }
    });
    visible.sort((left, right) => left.start - right.start);
  }
  return visible;
}

function measureEvents(score: Score, measureIndex: number): OutputEvent[] {
  const grouped = new Map<number, {
    start: number;
    attackEnds: number[];
    restEnds: number[];
    continuationEnds: number[];
    chords: Chord[];
    voiceIndexes: number[];
    restVoiceIndexes: number[];
  }>();
  for (let partIndex = 0; partIndex < score.parts.length; partIndex++) {
    const activeAttacks = new Map<number, { key: number; end: number }>();
    const part = score.parts[partIndex];
    const measure = part.measures[measureIndex];
    if (!measure) continue;
    // A chord subset can stop while another member sustains. Keep its real
    // written segments; explicit note-tie annotations reconnect only the
    // continuing occurrences after parsing the normal visible TXT atoms.
    const explicitMemberTies = partNeedsExplicitNoteTies(part);
    const chords = measure.entries.filter((entry): entry is Chord => entry instanceof Chord)
      .sort((left, right) => left.position.compareTo(right.position));
    for (const entry of chords) {
      const rest = entry.rest || entry.notes.every((note) => note.rest);
      const sounding = entry.notes.filter((note) => !note.rest);
      // A transparent slash continuation or an explicit JPW tie-stop advances
      // the common time axis but must not become a new keyboard/number attack.
      const continuation = !explicitMemberTies && (entry.transparentContinuation
        || (entry.graceNotes.every((note) => note.rest)
          && !entry.arpeggio
          && sounding.length > 0
          && sounding.every((note) => note.tieEnd)));
      const start = entry.position.toFloat();
      const duration = entry.duration?.toFloat() ?? 0.25;
      const key = Math.round(start * 192);
      const item = grouped.get(key) ?? {
        start,
        attackEnds: [],
        restEnds: [],
        continuationEnds: [],
        chords: [],
        voiceIndexes: [],
        restVoiceIndexes: [],
      };
      if ((!explicitMemberTies && entry.generatedTimingContinuation) || continuation) {
        // Split tie segments are one sounding attack. Keep their final end on
        // the original event so a later slash group sees active sound rather
        // than converting its continuation into a rest or empty beat.
        let attached = false;
        for (const note of sounding) {
          const active = activeAttacks.get(note.pitch);
          const root = active && active.end >= start - 1 / 192
            ? grouped.get(active.key) : undefined;
          if (!root || !active) continue;
          root.attackEnds.push(start + duration);
          active.end = Math.max(active.end, start + duration);
          attached = true;
        }
        if (!attached) {
          item.continuationEnds.push(start + duration);
          grouped.set(key, item);
        }
        continue;
      } else if (rest) {
        item.restEnds.push(start + duration);
        item.restVoiceIndexes.push(partIndex + 1);
      } else {
        item.attackEnds.push(start + duration);
        item.chords.push(entry);
        item.voiceIndexes.push(partIndex + 1);
        for (const note of sounding) activeAttacks.set(note.pitch, { key, end: start + duration });
      }
      grouped.set(key, item);
    }
  }
  return [...grouped.values()]
    .map((item): OutputEvent => {
      const ends = [...item.attackEnds, ...item.restEnds, ...item.continuationEnds];
      return {
        start: item.start,
        // Multiple voices can overlap for different lengths. The slash text
        // needs one common cursor, so retain the longest active span and emit
        // at most one continuation marker at a following group boundary.
        end: Math.max(item.start + 1 / 192, ...ends),
        chords: item.chords,
        voiceIndexes: item.voiceIndexes,
        restVoiceIndexes: item.restVoiceIndexes,
        specialToken: item.chords.length === 0
          ? item.restEnds.length > 0 ? "0" : ""
          : undefined,
      };
    })
    .sort((a, b) => a.start - b.start);
}

function compareOutputPitch(
  left: { pitch: number; voice: number; order: number },
  right: { pitch: number; voice: number; order: number },
  ordering: MidiSlashOrdering,
): number {
  if (ordering === "voice-asc" || ordering === "voice-desc") {
    const voice = ordering === "voice-asc"
      ? left.voice - right.voice
      : right.voice - left.voice;
    if (voice !== 0) return voice;
    return left.pitch - right.pitch || left.order - right.order;
  }
  const pitch = ordering === "pitch-desc"
    ? right.pitch - left.pitch
    : left.pitch - right.pitch;
  return pitch || left.voice - right.voice || left.order - right.order;
}

function outputToken(
  event: OutputEvent,
  kind: SlashScoreKind,
  fifths: number,
  voiceCount = 1,
  ordering: MidiSlashOrdering = "pitch-asc",
  groups: SlashExportGroupModes = {
    braceMode: "arpeggio",
    bracketMode: "triplet",
    barMode: "none",
    angleMode: "grace",
    parenMode: "chord",
  },
  durationText?: (duration: number) => string,
  ornamentUnit?: number,
  suppressMordent = false,
  implicitGrace = false,
): string {
  if (event.specialToken !== undefined
    && (event.specialToken !== "0" || voiceCount <= 1)) return event.specialToken;
  let token = "";
  const chordTokenFromValues = (values: readonly string[]): string => {
    if (values.length <= 1) return values[0] ?? "";
    const delimiter = delimiterFor("chord", groups);
    return delimiter ? `${delimiter[0]}${values.join("")}${delimiter[1]}` : values.join("");
  };
  if (event.explicitPitches) {
    token = chordTokenFromValues(pitchValues(
      event.explicitPitches,
      kind,
      fifths,
      ordering === "pitch-desc",
    ));
  } else if (voiceCount > 1 && event.voiceIndexes?.length === event.chords.length) {
    const pitched = event.chords.flatMap((chord, chordIndex) => {
      const voice = clamp(event.voiceIndexes![chordIndex], 1, voiceCount);
      return chord.notes
        .filter((note) => !note.rest)
        .map((note, noteIndex) => ({
          pitch: note.pitch,
          voice,
          order: chordIndex * 1000 + noteIndex,
        }));
    });
    const rests = [...new Set(event.restVoiceIndexes ?? [])].map((voice, index) => ({
      pitch: ordering === "pitch-desc" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY,
      voice: clamp(voice, 1, voiceCount),
      order: -1000 + index,
      rest: true,
    }));
    const values = [...pitched.map((value) => ({ ...value, rest: false })), ...rests]
      .sort((left, right) => compareOutputPitch(left, right, ordering))
      .map(({ pitch, voice, rest }) => {
        const prefix = voice === voiceCount ? "" : SLASH_VOICE_SEPARATOR.repeat(voice);
        return prefix + (rest ? "0" : kind === "keyboard"
          ? keyboardPitchValue(pitch, fifths)
          : numericPitchValue(pitch, fifths));
      });
    token = chordTokenFromValues(values);
  } else {
    const notes = event.chords.flatMap((chord) => chord.notes.filter((note) => !note.rest));
    const fake = event.chords[0];
    if (!fake) return "";
    const values = [...notes].sort((a, b) =>
      ordering === "pitch-desc" ? b.pitch - a.pitch : a.pitch - b.pitch)
      .map((note) => kind === "keyboard" ? keyboardPitchValue(note.pitch, fifths) : numericPitchValue(note.pitch, fifths));
    token = chordTokenFromValues(values);
  }

  const arpeggioDelimiter = delimiterFor("arpeggio", groups);
  const hasLocalArpeggio = event.chords.some((chord) => chord.arpeggio);
  if ((hasLocalArpeggio || (event.crossArpeggioGroups?.length ?? 0) > 0)
    && arpeggioDelimiter) {
    type MainOccurrence = {
      pitch: number;
      voice: number;
      order: number;
      chordIndex: number;
    };
    type ArpeggioComponent = {
      text: string;
      pitch: number;
      voice: number;
      order: number;
    };
    const occurrences: MainOccurrence[] = event.chords.flatMap((chord, chordIndex) => {
      const voice = clamp(event.voiceIndexes?.[chordIndex] ?? voiceCount, 1, voiceCount);
      return chord.notes.filter((note) => !note.rest).map((note, noteIndex) => ({
        pitch: note.pitch,
        voice,
        order: chordIndex * 1000 + noteIndex,
        chordIndex,
      }));
    });
    const groupedIndexes: number[][] = [];
    for (const crossMembers of event.crossArpeggioGroups ?? []) {
      const available = crossMembers.map((item) => ({ ...item }));
      const indexes: number[] = [];
      const used = new Set(groupedIndexes.flat());
      occurrences.forEach((occurrence, index) => {
        if (used.has(index)) return;
        const match = available.findIndex((item) =>
          item.part === occurrence.voice - 1 && item.pitch === occurrence.pitch);
        if (match < 0) return;
        available.splice(match, 1);
        indexes.push(index);
      });
      if (indexes.length >= 2) groupedIndexes.push(indexes);
    }
    event.chords.forEach((chord, chordIndex) => {
      const used = new Set(groupedIndexes.flat());
      for (const requested of chordArpeggioPitchGroups(chord)) {
        const remaining = [...requested];
        const indexes: number[] = [];
        occurrences.forEach((occurrence, index) => {
          if (occurrence.chordIndex !== chordIndex || used.has(index)) return;
          const match = remaining.indexOf(occurrence.pitch);
          if (match < 0) return;
          remaining.splice(match, 1);
          indexes.push(index);
          used.add(index);
        });
        if (indexes.length >= 2) groupedIndexes.push(indexes);
      }
    });
    const selected = new Set(groupedIndexes.flat());
    const pitchText = (occurrence: MainOccurrence): string => {
      const prefix = occurrence.voice === voiceCount
        ? ""
        : SLASH_VOICE_SEPARATOR.repeat(occurrence.voice);
      return prefix + (kind === "keyboard"
        ? keyboardPitchValue(occurrence.pitch, fifths)
        : numericPitchValue(occurrence.pitch, fifths));
    };
    const components: ArpeggioComponent[] = groupedIndexes.map((indexes) => {
      const values = indexes.map((index) => occurrences[index])
        .sort((left, right) => compareOutputPitch(left, right, ordering));
      const first = values[0];
      return {
        text: `${arpeggioDelimiter[0]}${values.map(pitchText).join("")}${arpeggioDelimiter[1]}`,
        pitch: first.pitch,
        voice: first.voice,
        order: first.order,
      };
    });
    occurrences.forEach((occurrence, index) => {
      if (selected.has(index)) return;
      components.push({ ...occurrence, text: pitchText(occurrence) });
    });
    for (const [index, voiceValue] of [...new Set(event.restVoiceIndexes ?? [])].entries()) {
      const voice = clamp(voiceValue, 1, voiceCount);
      components.push({
        text: `${voice === voiceCount ? "" : SLASH_VOICE_SEPARATOR.repeat(voice)}0`,
        pitch: ordering === "pitch-desc" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY,
        voice,
        order: -1000 + index,
      });
    }
    components.sort((left, right) => compareOutputPitch(left, right, ordering));
    if (components.length > 0) {
      const chordDelimiter = delimiterFor("chord", groups);
      token = components.length === 1
        ? components[0].text
        : chordDelimiter ? `${chordDelimiter[0]}${components.map((component) => component.text).join("")}${chordDelimiter[1]}`
          : components.map(component => component.text).join("");
    }
  }

  const grace = event.chords.flatMap((chord) =>
    chord.graceNotes.filter((note) => !note.rest).map((note) => note.pitch));
  const graceDelimiter = delimiterFor("grace", groups);
  if (grace.length > 0) {
    const usedOccurrences = new Set<number>();
    const graceToken = implicitGrace
      ? grace.map((pitch) => voicedPitchesToken(
        [pitch],
        event,
        kind,
        fifths,
        voiceCount,
        ordering,
        groups,
        usedOccurrences,
      )).join("")
      : voicedPitchesToken(
        grace,
        event,
        kind,
        fifths,
        voiceCount,
        ordering,
        groups,
        usedOccurrences,
      );
    if (implicitGrace) token = graceToken + token;
    else if (graceDelimiter) {
      token = `${graceDelimiter[0]}${graceToken}${graceDelimiter[1]}${token}`;
    }
  }
  return suppressMordent ? token : slashMordentToken(
    event,
    token,
    kind,
    fifths,
    voiceCount,
    groups,
    durationText,
    ornamentUnit,
  );
}

/**
 * Serialize one slash group on the configured base grid while attaching
 * cells that contain an attack halfway through the base value. For example,
 * with "." = 16th, `AB` represents two 32nd-note attacks without changing
 * the persisted meaning of ".".
 */
function attachedSubdivisionGroupText(
  events: readonly OutputEvent[],
  start: number,
  end: number,
  baseUnit: number,
  noteUnit: number,
  symbol: string,
  kind: SlashScoreKind,
  fifthsAt: (offset: number) => number,
  voiceCount: number,
  ordering: MidiSlashOrdering,
  groups: SlashExportGroupModes,
): string {
  const fineUnit = baseUnit / 2;
  const fineCellCount = Math.max(2, Math.round((end - start) / fineUnit));
  const byFineCell = new Map<number, OutputEvent>();
  for (const event of events) {
    const fineCell = Math.round((Math.max(start, event.start) - start) / fineUnit);
    if (fineCell < 0 || fineCell >= fineCellCount) continue;
    const aligned = start + fineCell * fineUnit;
    if (Math.abs(event.start - aligned) > fineUnit * 0.24 && !event.continued) continue;
    const previous = byFineCell.get(fineCell);
    if (!previous || (previous.continued && !event.continued)) {
      byFineCell.set(fineCell, event);
    }
  }

  const tokenFor = (event: OutputEvent | undefined): string => {
    if (!event || event.continued) return "";
    // The active toolbar may request the fine grid for ordinary note entry,
    // but semantic ornaments still derive their member value from the TXT
    // document's base grid. Passing that base here prevents a mordent from
    // being serialized as `[ASA]` on one toolbar value and `<[ASA]>` on
    // another, or from receiving the outer subdivision twice.
    const token = outputToken(
      event,
      kind,
      fifthsAt(event.start),
      voiceCount,
      ordering,
      groups,
      undefined,
      baseUnit,
      false,
      noteUnit <= 1e-9,
    );
    // A default-voice rest following an empty compact half-cell must be
    // distinguishable from the zero used only as that cell's visual padding.
    // The extra separators are invisible and clamp back to the default voice
    // during parsing, so the user still sees the familiar adjacent `00`.
    if (voiceCount > 1
      && token === "0"
      && event.chords.length === 0
      && event.restVoiceIndexes?.includes(voiceCount)) {
      return SLASH_VOICE_SEPARATOR.repeat(voiceCount) + token;
    }
    const defaultVoiceOnly = voiceCount > 1
      && event.chords.length > 0
      && event.chords.every((_chord, index) =>
        (event.voiceIndexes?.[index] ?? voiceCount) === voiceCount)
      && (event.restVoiceIndexes ?? []).every((voice) => voice === voiceCount);
    if (defaultVoiceOnly) {
      // Compact half-cells normally derive their duration from adjacent
      // atoms.  When this default-voice attack sits next to another voice,
      // an unmarked token is indistinguishable from ordinary sequential TXT.
      // Mark every pitch with the invisible explicit-default sentinel so a
      // later parse can retain the generated half-grid timing exactly.
      return explicitDefaultTimedToken(token, voiceCount);
    }
    return token;
  };

  const continuationVoicePrefix = (event: OutputEvent | undefined): string => {
    if (!event) return SLASH_VOICE_SEPARATOR;
    const voices = event.chords.length === 0
      ? event.restVoiceIndexes ?? []
      : event.voiceIndexes ?? [];
    const unique = [...new Set(voices)];
    return unique.length === 1
      ? SLASH_VOICE_SEPARATOR.repeat(clamp(unique[0], 1, voiceCount))
      : SLASH_VOICE_SEPARATOR;
  };

  let out = "";
  for (let fineCell = 0; fineCell < fineCellCount;) {
    const firstEvent = byFineCell.get(fineCell);
    let first = tokenFor(firstEvent);
    if (first && firstEvent?.embeddedDuration !== undefined) {
      out += first;
      if (firstEvent.parallelVoiceTuplet) {
        // The nested container advances only its marked voice. Keep walking
        // the same shared binary cells so the other voice receives its own
        // continuation/attack spacing after the container token.
        first = "";
      } else {
        const occupiedFineCells = Math.max(
          2,
          Math.round(firstEvent.embeddedDuration / fineUnit),
        );
        fineCell += occupiedFineCells;
        continue;
      }
    }
    const secondEvent = byFineCell.get(fineCell + 1);
    const second = tokenFor(secondEvent);
    if (second) {
      const secondSpan = secondEvent
        ? Math.max(1, Math.round((Math.min(end, secondEvent.end) - secondEvent.start) / fineUnit))
        : 1;
      const secondHasInteriorAttack = Array.from(
        { length: Math.max(0, secondSpan - 1) },
        (_unused, index) => fineCell + 2 + index,
      ).some((cell) => byFineCell.has(cell));
      if (first && secondSpan === 3 && !secondHasInteriorAttack) {
        // One fine cell plus one configured cell is a dotted value at the
        // compact boundary (for example 32nd rest + 16th rest).  The invisible
        // separator keeps the following symbol additive, so this round-trips
        // as one dotted-16th event without writing a second visible zero.
        out += first + second + continuationVoicePrefix(secondEvent) + symbol;
        fineCell += 4;
        continue;
      }
      if (first && secondSpan === 2 && !secondHasInteriorAttack) {
        // The second atom already occupies one complete configured cell.  Give
        // it that explicit value (`0.` / `N.`) and skip its empty continuation
        // half instead of serializing the continuation as another visible 0.
        out += first + second + symbol;
        fineCell += 3;
        continue;
      }
      // A zero atom advances the first half-cell when no sound begins there.
      // It is timeline padding only; per-voice sustain is rebuilt separately.
      const restVoices = [...new Set(secondEvent?.restVoiceIndexes ?? [])];
      const secondLeadingMarkers = second.match(/^\u2063*/)?.[0].length ?? 0;
      const invisiblePadding = !first
        && secondEvent?.chords.length === 0
        && restVoices.length > 0
        ? SLASH_VOICE_SEPARATOR.repeat(
          MAX_SLASH_VOICES + (secondLeadingMarkers > 0 ? 0 : 1),
        )
        : "";
      // A single-voice rest already carries its invisible owner prefix; a
      // multi-voice rest container does not.  Complete one reserved marker
      // block in either case so the preceding empty half-cell advances without
      // inventing a visible default-voice `0` beside the real rest atom.
      out += invisiblePadding ? invisiblePadding + second : `${first || "0"}${second}`;
      fineCell += 2;
    } else if (first && noteUnit > 1e-8) {
      out += first;
      fineCell += Math.max(2, Math.round(noteUnit / fineUnit));
    } else {
      const previousFineEvent = byFineCell.get(fineCell - 1);
      const cellStart = start + fineCell * fineUnit;
      const additiveContinuation = !first
        && fineCell % 2 === 0
        && previousFineEvent !== undefined
        && previousFineEvent.end > cellStart + 1e-8;
      // An atom beginning in the preceding half-cell needs the following base
      // symbol additively (`(0V)⁣.` = 32nd + 16th).  A normal atom beginning in
      // this cell already owns the symbol as its complete value (`⁣0.` = 16th),
      // so only the former receives the invisible disambiguating separator.
      out += first
        + (additiveContinuation ? continuationVoicePrefix(previousFineEvent) : "")
        + symbol;
      fineCell += 2;
    }
  }
  return out;
}

function pitchValues(
  pitches: readonly number[],
  kind: SlashScoreKind,
  fifths: number,
  descending = false,
): string[] {
  return [...new Set(pitches)].sort((a, b) => descending ? b - a : a - b)
    .map((pitch) => kind === "keyboard" ? keyboardPitchValue(pitch, fifths) : numericPitchValue(pitch, fifths));
}

interface EventPitchOccurrence {
  pitch: number;
  voice: number;
  grace: boolean;
}

function collapseInternalRestEvents(events: readonly OutputEvent[]): OutputEvent[] {
  const result: OutputEvent[] = [];
  let previousSound: OutputEvent | null = null;
  for (const source of events) {
    const event: OutputEvent = {
      ...source,
      chords: [...source.chords],
      voiceIndexes: source.voiceIndexes ? [...source.voiceIndexes] : undefined,
      restVoiceIndexes: source.restVoiceIndexes ? [...source.restVoiceIndexes] : undefined,
    };
    if (event.chords.length > 0) {
      // A simultaneous rest in another TXT voice is implicit when rests are
      // hidden; retain only the sounding attack at this common time column.
      event.restVoiceIndexes = [];
      result.push(event);
      previousSound = event;
      continue;
    }
    const explicitRest = event.specialToken === "0" || (event.restVoiceIndexes?.length ?? 0) > 0;
    if (!explicitRest || previousSound === null) {
      // Leading silence cannot be represented by extending an earlier note.
      result.push(event);
      continue;
    }
    previousSound.end = Math.max(previousSound.end, event.end);
  }
  return result;
}

/** Preserve pitch multiplicity across voices; equal notes in V1/V2 are not one note. */
function eventPitchOccurrences(event: OutputEvent, voiceCount: number): EventPitchOccurrence[] {
  return event.chords.flatMap((chord, chordIndex) => {
    const voice = clamp(event.voiceIndexes?.[chordIndex] ?? voiceCount, 1, voiceCount);
    return [
      ...chord.graceNotes
        .filter((note) => !note.rest)
        .map((note) => ({ pitch: note.pitch, voice, grace: true })),
      ...chord.notes
        .filter((note) => !note.rest)
        .map((note) => ({ pitch: note.pitch, voice, grace: false })),
    ];
  });
}

function eventVoiceForPitch(event: OutputEvent, pitch: number, voiceCount: number): number {
  return eventPitchOccurrences(event, voiceCount).find((item) => item.pitch === pitch)?.voice
    ?? clamp(event.voiceIndexes?.[0] ?? voiceCount, 1, voiceCount);
}

function voicedPitchesToken(
  pitches: readonly number[],
  event: OutputEvent,
  kind: SlashScoreKind,
  fifths: number,
  voiceCount: number,
  ordering: MidiSlashOrdering,
  groups: SlashExportGroupModes,
  usedOccurrences: Set<number> = new Set<number>(),
): string {
  const occurrences = eventPitchOccurrences(event, voiceCount);
  if (voiceCount <= 1) {
    for (const pitch of pitches) {
      const occurrenceIndex = occurrences.findIndex((item, index) =>
        !usedOccurrences.has(index) && item.pitch === pitch);
      if (occurrenceIndex >= 0) usedOccurrences.add(occurrenceIndex);
    }
    const values = pitchValues(pitches, kind, fifths, ordering === "pitch-desc");
    const delimiter = delimiterFor("chord", groups);
    return values.length <= 1 ? values[0] ?? "" : delimiter ? `${delimiter[0]}${values.join("")}${delimiter[1]}` : values.join("");
  }
  const values = pitches.map((pitch, order) => {
    const occurrenceIndex = occurrences.findIndex((item, index) =>
      !usedOccurrences.has(index) && item.pitch === pitch);
    if (occurrenceIndex >= 0) usedOccurrences.add(occurrenceIndex);
    return {
      pitch,
      voice: occurrenceIndex >= 0
        ? occurrences[occurrenceIndex].voice
        : eventVoiceForPitch(event, pitch, voiceCount),
      order,
    };
  }).sort((left, right) => compareOutputPitch(left, right, ordering))
    .map(({ pitch, voice }) => {
      const prefix = voice === voiceCount ? "" : SLASH_VOICE_SEPARATOR.repeat(voice);
      const value = kind === "keyboard"
        ? keyboardPitchValue(pitch, fifths)
        : numericPitchValue(pitch, fifths);
      return prefix + value;
    });
  const delimiter = delimiterFor("chord", groups);
  return values.length <= 1 ? values[0] ?? "" : delimiter ? `${delimiter[0]}${values.join("")}${delimiter[1]}` : values.join("");
}

function eventPitches(event: OutputEvent): number[] {
  if (event.explicitPitches) return [...event.explicitPitches];
  return event.chords.flatMap((chord) =>
    chord.notes.filter((note) => !note.rest).map((note) => note.pitch));
}

function midiOnsetPitchMap(
  parsed: ParsedMidi,
  division: SlashDurationDivision,
  gestures: readonly MidiSlashGesture[],
): Map<number, Set<number>> {
  const unit = 4 / division;
  const result = new Map<number, Set<number>>();
  const add = (quarter: number, pitches: readonly number[]): void => {
    const key = Math.round(quarter * 192);
    const values = result.get(key) ?? new Set<number>();
    for (const pitch of pitches) values.add(pitch);
    result.set(key, values);
  };
  const exactStarts = new Map<ParsedMidiNote, number>();
  for (const gesture of gestures) {
    if (gesture.kind !== "triplet") continue;
    for (const event of gesture.events) {
      for (const source of event.sourceNotes ?? []) exactStarts.set(source, event.start);
    }
  }
  for (const note of parsed.notes) {
    // Register a source attack once. Keeping both its old binary position and
    // its tuplet position copied that pitch into a neighbouring accompaniment.
    add(exactStarts.get(note) ?? Math.round((note.startTick / parsed.ppq) / unit) * unit, [note.pitch]);
  }
  return result;
}

function retainMidiOnsets(
  events: readonly OutputEvent[],
  measureStart: number,
  onsetPitches: ReadonlyMap<number, Set<number>>,
  preserveVoices: boolean,
  firstMidiOnsetKey: number,
): OutputEvent[] {
  const result: OutputEvent[] = [];
  for (const event of events) {
    const key = Math.round((measureStart + event.start) * 192);
    const pitches = onsetPitches.get(key);
    if (!pitches || pitches.size === 0) {
      // Before the first MIDI attack there is no earlier sound for a bare
      // duration prefix to continue. Keep the source rest explicitly so the
      // TXT parser cannot backdate the first note into that silent interval.
      if (key < firstMidiOnsetKey && (event.specialToken === "0"
        || (event.restVoiceIndexes?.length ?? 0) > 0)) result.push({ ...event });
      continue;
    }
    result.push(preserveVoices
      ? { ...event, explicitPitches: undefined }
      : { ...event, explicitPitches: [...pitches].sort((a, b) => a - b) });
  }
  return result;
}

function delimiterFor(
  mode: SlashGroupMode,
  options: SlashExportGroupModes,
): readonly [string, string] | null {
  const specs = slashDelimiterSpecs({
    braceMode: options.braceMode,
    bracketMode: options.bracketMode,
    barMode: options.barMode,
    angleMode: options.angleMode,
    parenMode: options.parenMode,
  });
  const preferred: Partial<Record<SlashGroupMode, SlashDelimiterId>> = {
    chord: "paren", triplet: "bracket", arpeggio: "brace", grace: "angle",
  };
  const spec = specs.find((candidate) => candidate.mode === mode && candidate.id === preferred[mode])
    ?? specs.find((candidate) => candidate.mode === mode);
  return spec ? [spec.open, spec.close] : null;
}

function nearestEvent(
  events: readonly OutputEvent[],
  localStart: number,
  tolerance: number,
): OutputEvent | null {
  let best: OutputEvent | null = null;
  let bestError = Infinity;
  for (const event of events) {
    if (event.hidden) continue;
    const error = Math.abs(event.start - localStart);
    if (error <= tolerance && error < bestError) {
      best = event;
      bestError = error;
    }
  }
  return best;
}

function applyMidiSlashGestures(
  events: OutputEvent[],
  measureStart: number,
  measureLength: number,
  gestures: readonly MidiSlashGesture[],
  options: MidiSlashExportOptions,
  kind: SlashScoreKind,
  fifths: number,
  division: SlashDurationDivision,
  symbol: string,
  voiceCount: number,
  ordering: MidiSlashOrdering,
  durationText: (duration: number) => string,
): OutputEvent[] {
  const unit = 4 / division;
  const measureEnd = measureStart + measureLength;
  const localGestures = gestures.filter((gesture) =>
    gesture.anchor >= measureStart - 1e-8 && gesture.anchor < measureEnd - 1e-8);

  for (const gesture of localGestures) {
    const delimiter = delimiterFor(gesture.kind, options);
    if (!delimiter) continue;
    const [opening, closing] = delimiter;
    const localAnchor = gesture.anchor - measureStart;

    if (gesture.kind === "arpeggio") {
      const target = nearestEvent(events, localAnchor, unit * 0.51);
      if (!target) continue;
      const usedOccurrences = new Set<number>();
      const atoms = gesture.events
        .map((event) => voicedPitchesToken(
          event.pitches,
          target,
          kind,
          fifths,
          voiceCount,
          ordering,
          options,
          usedOccurrences,
        ))
        .join("");
      const extra = eventPitchOccurrences(target, voiceCount)
        .filter((item, index) => !item.grace && !usedOccurrences.has(index))
        .map((item) => item.pitch);
      target.specialToken = `${opening}${atoms}${closing}` +
        voicedPitchesToken(
          extra,
          target,
          kind,
          fifths,
          voiceCount,
          ordering,
          options,
          usedOccurrences,
        );
      continue;
    }

    if (gesture.kind === "grace") {
      const target = nearestEvent(events, localAnchor, unit * 0.51);
      if (!target || gesture.events.length < 2) continue;
      const graceEvents = gesture.events.slice(0, -1);
      const mainPitches = new Set(gesture.events[gesture.events.length - 1].pitches);
      const gracePitches = new Set(graceEvents.flatMap((event) => event.pitches));
      const retained = eventPitches(target).filter((pitch) =>
        mainPitches.has(pitch) || !gracePitches.has(pitch));
      const usedOccurrences = new Set<number>();
      const graceText = graceEvents
        .map((event) => voicedPitchesToken(
          event.pitches,
          target,
          kind,
          fifths,
          voiceCount,
          ordering,
          options,
          usedOccurrences,
        ))
        .join("");
      target.specialToken = `${opening}${graceText}${closing}` +
        voicedPitchesToken(
          retained,
          target,
          kind,
          fifths,
          voiceCount,
          ordering,
          options,
          usedOccurrences,
        );
      for (const source of graceEvents) {
        const quantized = Math.round(source.start / unit) * unit - measureStart;
        const separate = nearestEvent(events, quantized, unit * 0.2);
        if (separate && separate !== target) {
          const separatePitches = eventPitches(separate);
          if (separatePitches.every((pitch) => gracePitches.has(pitch))) separate.hidden = true;
        }
      }
      continue;
    }

    if (gesture.kind === "triplet" && gesture.events.length === 3) {
      const nominalDivision = gesture.division ?? division;
      const nominal = 4 / nominalDivision;
      const cell = nominal * 2 / 3;
      const matched = gesture.events.map((_source, index) =>
        nearestEvent(events, localAnchor + index * cell, Math.max(1 / 192, cell * 0.24)));
      // An export group must consume the same three actual attack columns.
      // Never invent missing members from the first column: doing so duplicates
      // the still-visible notes and can assign them to the wrong part.
      if (matched.some((event) => !event) || new Set(matched).size !== 3) continue;
      const first = matched[0]!;
      const groupEnd = Math.min(measureLength, localAnchor + nominal * 2);
      const extraAttacks = events.filter((event) => !event.hidden
        && event.start >= localAnchor - 1e-8 && event.start < groupEnd - 1e-8
        && !matched.includes(event) && event.chords.some((chord) => !chord.rest));
      if (extraAttacks.length > 0 && voiceCount > 1) {
        // A straight accompaniment inside the tuplet span is a parallel lane,
        // not additional time after the full 3:2 group. Only voices containing
        // all three attacks can be taken out of the ordinary timeline.
        const tripletVoices = [...new Set(first.voiceIndexes ?? [])].filter((voice) =>
          matched.every((event) => event!.voiceIndexes?.includes(voice))
          && !extraAttacks.some((event) => event.voiceIndexes?.includes(voice)));
        if (tripletVoices.length > 0) {
          const markerCount = Math.max(1, Math.round(nominal / unit));
          const overlays: OutputEvent[] = [];
          for (const voice of tripletVoices) {
            const members = matched.map((event) => {
              const chords = event!.chords.filter((_chord, index) => event!.voiceIndexes?.[index] === voice);
              return { ...event!, chords, voiceIndexes: chords.map(() => voice),
                restVoiceIndexes: [], explicitPitches: undefined, specialToken: undefined };
            });
            const atoms = members.map((member) => {
              let token = voicedPitchesToken(eventPitches(member), member, kind, fifths,
                voiceCount, ordering, options);
              // The default (last) part also needs an explicit marker here;
              // otherwise the parser correctly treats this as a global group.
              if (voice === voiceCount) token = explicitDefaultTimedToken(token, voiceCount);
              return token + symbol.repeat(markerCount);
            }).join("");
            overlays.push({ ...members[0], start: localAnchor, end: groupEnd,
              specialToken: `${opening}${atoms}${closing}`,
              embeddedDuration: groupEnd - localAnchor, parallelVoiceTuplet: true });
          }
          for (const event of matched) {
            const retained = event!.chords.map((chord, index) => ({ chord, voice: event!.voiceIndexes?.[index] ?? voiceCount }))
              .filter((item) => !tripletVoices.includes(item.voice));
            event!.chords = retained.map((item) => item.chord);
            event!.voiceIndexes = retained.map((item) => item.voice);
            event!.restVoiceIndexes = event!.restVoiceIndexes?.filter((voice) => !tripletVoices.includes(voice));
            event!.explicitPitches = undefined;
            if (event!.chords.length === 0 && !event!.restVoiceIndexes?.length) event!.hidden = true;
          }
          const ordinary = events.filter((event) => !event.hidden && !event.parallelVoiceTuplet)
            .sort((left, right) => left.start - right.start);
          for (let index = 0; index < ordinary.length; index++) {
            ordinary[index].end = ordinary[index + 1]?.start ?? measureLength;
          }
          events.push(...overlays);
          continue;
        }
      }
      if (extraAttacks.length > 0) {
        // A deliberately flattened one-part score has no independent lane.
        // Encode the union of attacks on the 3:2 clock, including the shorter
        // member where the ordinary grid intersects it. Fine duration glyphs
        // are declared by scoreToSlashScore before any rows are written.
        const columns = [...matched.map((event) => event!), ...extraAttacks]
          .sort((left, right) => left.start - right.start);
        const atoms = columns.map((event, index) => {
          const next = columns[index + 1]?.start ?? groupEnd;
          return voicedPitchesToken(eventPitches(event), event, kind, fifths,
            voiceCount, ordering, options) + durationText((next - event.start) * 1.5);
        }).join("");
        first.specialToken = `${opening}${atoms}${closing}`;
        first.embeddedDuration = groupEnd - localAnchor;
        first.end = groupEnd;
        for (const event of columns) if (event !== first) event.hidden = true;
        continue;
      }
      const markerCount = Math.max(1, Math.round(nominal / unit));
      const usedByEvent = new Map<OutputEvent, Set<number>>();
      const atoms = gesture.events.map((source, index) => {
        const matchedEvent = matched[index] ?? first;
        const sounding = matched[index] ? eventPitches(matched[index]!) : source.pitches;
        const usedOccurrences = usedByEvent.get(matchedEvent) ?? new Set<number>();
        usedByEvent.set(matchedEvent, usedOccurrences);
        const token = voiceCount > 1 && (matchedEvent.restVoiceIndexes?.length ?? 0) > 0
          && delimiterFor("chord", options) !== null
          ? outputToken({ ...matchedEvent, specialToken: undefined }, kind, fifths,
            voiceCount, ordering, options)
          : voicedPitchesToken(
            sounding,
            matchedEvent,
            kind,
            fifths,
            voiceCount,
            ordering,
            options,
            usedOccurrences,
          );
        // A rest at a cross-hand member ends the previous note in that voice.
        // Omitting it makes the earlier note sustain until this voice's next
        // pitched member, even though the shared clock already reached here.
        // The chord delimiter keeps this rest simultaneous with the attack.
        return token + symbol.repeat(markerCount);
      }).join("");
      first.specialToken = `${opening}${atoms}${closing}`;
      first.embeddedDuration = nominal * 2;
      first.end = Math.min(measureLength, localAnchor + nominal * 2);
      for (const event of matched.slice(1)) if (event && event !== first) event.hidden = true;
    }
  }
  return events.filter((event) => !event.hidden).sort((a, b) =>
    a.start - b.start || Number(!!b.parallelVoiceTuplet) - Number(!!a.parallelVoiceTuplet));
}

function keyName(fifths: number): string {
  const name = MusicCommon.keys[clamp(fifths + 7, 0, 14)];
  return name.startsWith("#") || name.startsWith("b")
    ? `${name.slice(1)}${name[0]}`
    : name;
}

/** Resolve the sounding key at one exact TXT cursor. Measure.key is only the
 * bar-opening cache; a mid-bar KeyMark must take effect for later events in
 * the same bar and continue into following bars. */
function scoreFifthsAt(
  score: Score,
  measure: number,
  offset: number,
  openingFifths: number,
): number {
  let fifths = score.parts[0]?.measures[measure]?.key.fifths ?? openingFifths;
  const marks = [...score.keyMarks]
    .filter((mark) => mark.measure < measure
      || mark.measure === measure && mark.offset.toFloat() <= offset + 1 / 384)
    .sort((left, right) => left.measure - right.measure || left.offset.compareTo(right.offset));
  if (marks.length > 0) fifths = marks[marks.length - 1]!.fifths;
  return fifths;
}

function slashGroupDirective(label: string, mode: SlashGroupMode): string | null {
  if (mode === "none") return null;
  const description = mode === "chord"
      ? "和弦（括号内音符同时发声）"
    : mode === "grace"
    ? "倚音（装饰音不增加小节拍长）"
    : mode === "arpeggio"
      ? "琶音（括号内两个及以上音按滚奏和弦处理）"
      : mode === "triplet"
        ? "三连音（括号内三个时值按 3:2 压缩）"
        : mode === "trill"
          ? "颤音（括号内音符仅作装饰，不增加小节拍长）"
          : "细分（最低时值再除以2并计入拍长）";
  return `${label} = ${description}`;
}

interface DurationGlyph {
  glyph: string;
  quarterNotes: number;
  order: number;
}

function serializationDurationGlyphs(
  division: SlashDurationDivision,
  symbol: string,
  notation?: MidiSlashExportOptions["durationNotation"],
): DurationGlyph[] {
  const mappings = notation
    ? effectiveMappings(notation)
    : { [symbol]: division } as Record<string, SlashDurationDivision>;
  const result = Object.entries(mappings)
    .filter(([glyph, value]) =>
      Array.from(glyph).length === 1 && DIVISIONS.includes(value))
    .map(([glyph, value], order) => ({
      glyph,
      quarterNotes: 4 / value,
      order,
    }))
    .sort((left, right) =>
      right.quarterNotes - left.quarterNotes || left.order - right.order);
  if (result.length === 0) {
    result.push({ glyph: symbol, quarterNotes: 4 / division, order: 0 });
  }
  return result;
}

/**
 * Use the fewest configured duration glyphs while retaining their slot order.
 * With "."=eighth and space=sixteenth this deliberately writes one dot
 * instead of two spaces; changing "." to "=" therefore rewrites every
 * equivalent duration consistently.
 */
function encodeSlashDuration(
  duration: number,
  glyphs: readonly DurationGlyph[],
  fallbackUnit: number,
  fallbackGlyph: string,
): string {
  let remaining = Math.max(0, Math.round(duration * 192) / 192);
  let result = "";
  let guard = 0;
  while (remaining > 1e-8 && guard++ < 1024) {
    const glyph = glyphs.find((candidate) =>
      candidate.quarterNotes <= remaining + 1e-8);
    if (glyph) {
      result += glyph.glyph;
      remaining = Math.max(
        0,
        Math.round((remaining - glyph.quarterNotes) * 192) / 192,
      );
      continue;
    }
    const count = Math.max(1, Math.round(remaining / fallbackUnit));
    result += fallbackGlyph.repeat(count);
    remaining = 0;
  }
  return result;
}

export function scoreToSlashScore(
  score: Score,
  kind: SlashScoreKind,
  division: SlashDurationDivision,
  symbol = ".",
  midiExport?: MidiSlashExportOptions,
  voiceCount?: number,
): string {
  // A multi-part Score already carries the requested text voices.  Callers
  // such as the standalone MIDI→TXT converter historically omitted the last
  // argument, which silently fell back to one voice and flattened independent
  // hands into same-time chords.  Keep the explicit argument authoritative,
  // while making the safe default preserve every existing Part.
  const requestedVoiceCount = voiceCount ?? score.parts.length;
  voiceCount = clamp(Math.round(requestedVoiceCount || 1), 1, MAX_SLASH_VOICES);
  const firstMeasure = score.parts[0]?.measures[0];
  const beats = firstMeasure?.time.beats ?? 4;
  const beatType = firstMeasure?.time.beatType ?? 4;
  const fifths = firstMeasure?.key.fifths ?? 0;
  const unit = 4 / division;
  const durationNotation = midiExport?.durationNotation;
  const durationGlyphs = serializationDurationGlyphs(
    division,
    symbol,
    durationNotation,
  );
  const noteUnit = durationNotation?.noteDivision
    ? 4 / durationNotation.noteDivision
    : 0;
  const wholeMeasureGroups = durationNotation?.wholeMeasureGroups ?? false;
  const durationText = (duration: number): string =>
    encodeSlashDuration(duration, durationGlyphs, unit, symbol);
  const measureCount = Math.max(0, ...score.parts.map((part) => part.measures.length));
  const braceMode = midiExport?.braceMode ?? "arpeggio";
  const bracketMode = midiExport?.bracketMode ?? "triplet";
  // Legacy files may still parse an explicitly stored subdivision mode, but
  // new serialization no longer assigns any delimiter to that role.
  const barMode = midiExport?.barMode ?? "none";
  const angleMode = midiExport?.angleMode
    ?? (braceMode === "grace" || bracketMode === "grace" || barMode === "grace"
      ? "none"
      : "grace");
  const parenMode = midiExport?.parenMode ?? "chord";
  const exportGroups: SlashExportGroupModes = {
    braceMode,
    bracketMode,
    barMode,
    angleMode,
    parenMode,
  };
  if (!delimiterFor("chord", exportGroups)) {
    // An implicit fine-cell run is ambiguous with a bare chord. Require a
    // real duration spelling before separating preserved tuplet members.
    for (const part of score.parts) for (const measure of part.measures) for (const entry of measure.entries) {
      if (!(entry instanceof Chord) || !entry.notes.some(note => note.tuplet && !note.tuplet.ornamentProxy)) continue;
      let remaining = Math.max(0, (entry.duration?.toFloat() ?? 0) * 1.5 - noteUnit);
      for (const glyph of durationGlyphs) remaining -= Math.floor((remaining + 1e-8) / glyph.quarterNotes) * glyph.quarterNotes;
      if (remaining > 1e-8) throw new Error("没有和弦括号时，三连音成员需要可精确表示的显式时值；请先设置所需更细单位。");
    }
  }
  const ordering = midiExport?.ordering ?? "pitch-asc";
  const detectedGestures = midiExport?.sourceMidi
    ? importedMidiSlashGestures(score, midiExport.sourceMidi)
      ?? detectMidiSlashGestures(midiExport.sourceMidi, division)
    : null;
  const midiGestures = detectedGestures
    ? [...detectedGestures.grace, ...detectedGestures.arpeggio, ...detectedGestures.triplet]
    : [];
  const midiOnsets = midiExport?.sourceMidi
    ? midiOnsetPitchMap(midiExport.sourceMidi, division, midiGestures)
    : null;
  // MIDI onset keys use a 1/192-quarter clock. Calculate the leading-silence
  // boundary once, shared by every measure and the triplet precision probe.
  let firstMidiOnsetKey = Infinity;
  if (midiOnsets) {
    for (const key of midiOnsets.keys()) firstMidiOnsetKey = Math.min(firstMidiOnsetKey, key);
  }
  const additionalDurationDirectives: string[] = [];
  if (midiExport?.sourceMidi && midiOnsets && detectedGestures) {
    const needsFinerValue = detectedGestures.triplet.some((gesture) => {
      const measureIndex = score.parts[0]?.measures.findIndex((measure) =>
        measure.position.toFloat() <= gesture.anchor + 1e-8
        && measure.position.toFloat() + measure.time.beats * 4 / measure.time.beatType > gesture.anchor + 1e-8) ?? -1;
      if (measureIndex < 0) return false;
      const start = score.parts[0].measures[measureIndex].position.toFloat();
      const columns = retainMidiOnsets(measureEvents(score, measureIndex), start, midiOnsets, voiceCount > 1, firstMidiOnsetKey)
        .filter((event) => event.chords.length > 0 && event.start >= gesture.anchor - start - 1e-8
          && event.start < gesture.end - start - 1e-8);
      const members = gesture.events.map((member) => columns.find((event) =>
        Math.abs(event.start + start - member.start) < 1 / 192));
      const extras = columns.filter((event) => !members.includes(event));
      if (extras.length === 0) return false;
      const commonVoices = [...new Set(members[0]?.voiceIndexes ?? [])].filter((voice) =>
        members.every((event) => event?.voiceIndexes?.includes(voice))
        && extras.every((event) => !event.voiceIndexes?.includes(voice)));
      if (voiceCount > 1 && commonVoices.length > 0) return false;
      return columns.some((event, index) => {
        const next = columns[index + 1]?.start ?? gesture.end - start;
        const cells = (next - event.start) * 1.5 / unit;
        return Math.abs(cells - Math.round(cells)) > 1e-8;
      });
    });
    if (needsFinerValue && !durationGlyphs.some((glyph) => glyph.quarterNotes <= unit / 2 + 1e-8)) {
      if (division >= 128) throw new Error("混合三连音需要比 128 分音符更细的时值，当前文本谱无法精确表示。");
      const fineSymbol = ["=", ":", "_", "*", "~", "·", "+", "-"].find((glyph) => !durationGlyphs.some((item) => item.glyph === glyph));
      if (!fineSymbol) throw new Error("混合三连音需要一个未占用的更细时值符号，请减少自定义时值符号后重试。");
      durationGlyphs.push({ glyph: fineSymbol, quarterNotes: unit / 2, order: durationGlyphs.length });
      durationGlyphs.sort((left, right) => right.quarterNotes - left.quarterNotes || left.order - right.order);
      additionalDurationDirectives.push(`${fineSymbol} = ${division * 2}分音符`);
    }
  }
  const lines: string[] = [
    kind === "keyboard" ? "键盘谱" : "数字谱",
    "// 每行一小节，/ 分隔拍组；未识别的其他文字作为注释保留。",
    `标题 = ${score.title || (kind === "keyboard" ? "键盘谱" : "数字谱")}`,
  ];
  if (score.subtitle) lines.push(`副标题 = ${score.subtitle}`);
  if (score.composer) lines.push(`作曲 = ${score.composer}`);
  if (score.arranger) lines.push(`编曲 = ${score.arranger}`);
  if (score.lyricist) lines.push(`作词 = ${score.lyricist}`);
  const groupDirectives = [
    slashGroupDirective("花括号", braceMode),
    slashGroupDirective("方括号", bracketMode),
    slashGroupDirective("竖线括号", barMode),
    slashGroupDirective("尖括号", angleMode),
    slashGroupDirective("圆括号", parenMode),
  ].filter((line): line is string => line !== null);
  lines.push(
    `1 = ${keyName(fifths)}`,
    `${beats}/${beatType}拍：`,
    (() => {
      const unit = score.tempoBeatUnit === "eighth"
        ? "八分音符"
        : score.tempoBeatUnit === "dotted-quarter" ? "附点四分音符" : "四分音符";
      const bpm = formatTempoBpm(tempoBpmForUnit(score.tempoBpm, score.tempoBeatUnit));
      return `速度 = 每分钟${bpm}${unit}(${bpm} BPM)`;
    })(),
    symbol === " " ? `空格 = ${division}分音符` : `${symbol || "符号"} = ${division}分音符`,
    ...additionalDurationDirectives,
    ...groupDirectives,
    "",
  );

  for (let measureIndex = 0; measureIndex < measureCount; measureIndex++) {
    const measure = score.parts[0]?.measures[measureIndex];
    const measureStart = measure?.position.toFloat() ?? measureIndex * beats * 4 / beatType;
    const measureBeats = measure?.time.beats ?? beats;
    const measureBeatType = measure?.time.beatType ?? beatType;
    const measureLength = measureBeats * 4 / measureBeatType;
    const compound = measureBeatType === 8
      && measureBeats >= 6
      && measureBeats % 3 === 0;
    const groups = wholeMeasureGroups ? 1 : compound ? measureBeats / 3 : measureBeats;
    const groupDuration = wholeMeasureGroups
      ? measureLength
      : compound ? 1.5 : 4 / measureBeatType;
    const fifthsAt = (offset: number): number =>
      scoreFifthsAt(score, measureIndex, offset, fifths);
    let events = measureEvents(score, measureIndex);
    for (const mark of score.crossPartArpeggios.filter((item) => item.measure === measureIndex)) {
      const event = events.find((item) => Math.abs(item.start - mark.offset.toFloat()) < 1 / 192);
      if (event) {
        (event.crossArpeggioGroups ??= []).push(mark.pitches.map(pitch => ({ ...pitch })));
      }
    }
    const explicitRestPreference = midiExport?.showExplicitRests
      ?? durationNotation?.showExplicitRests;
    const preserveInputRests = midiExport?.preserveExplicitRestMeasures?.includes(measureIndex) ?? false;
    const keepExplicitRests = preserveInputRests || (explicitRestPreference ?? voiceCount > 1);
    const preserveLeadingSilence = explicitRestPreference === false;
    if (!keepExplicitRests) events = collapseInternalRestEvents(events);
    if (midiExport?.sourceMidi) {
      events = retainMidiOnsets(events, measureStart, midiOnsets!, voiceCount > 1, firstMidiOnsetKey);
      // Slash scores express sustain with their own adjacent rhythm symbols.
      // Ignore MIDI note-off/pedal length and hold each onset until the next
      // onset (or the end of the measure) before serializing.
      for (let index = 0; index < events.length; index++) {
        events[index].end = events[index + 1]?.start ?? measureLength;
      }
      events = applyMidiSlashGestures(
        events,
        measureStart,
        measureLength,
        midiGestures,
        { ...midiExport, ...exportGroups },
        kind,
        fifthsAt(0),
        division,
        symbol,
        voiceCount,
        ordering,
        durationText,
      );
    }
    // JPW/text conversion can contain explicit tuplets even when no source
    // MIDI gesture metadata is available. Keep the visual 3:2 bracket and
    // its fixed nominal member duration in the generated TXT.
    if (!midiExport?.sourceMidi) {
      events = preserveScoreTuplets(
        events,
        score.parts.map((part) => part.measures[measureIndex]),
        durationText,
        unit,
        noteUnit,
        kind,
        fifthsAt,
        voiceCount,
        ordering,
        exportGroups,
        keepExplicitRests,
        groupDuration,
        durationNotation
          ? Math.min(...Object.values(effectiveMappings(durationNotation)).map((value) => 4 / value))
          : Math.min(...durationGlyphs.map((glyph) => glyph.quarterNotes)),
      );
    }
    // A tie entering this measure has no attack event in measureEvents():
    // the preceding measure owns its root. Keep its transparent continuation
    // sounding when draft-rest preservation is enabled for this measure.
    const continuationSpans = score.parts.flatMap((part) =>
      (part.measures[measureIndex]?.entries ?? [])
        .filter((entry): entry is Chord => entry instanceof Chord
          && !entry.rest && entry.notes.some((note) => !note.rest)
          && (entry.generatedTimingContinuation || entry.transparentContinuation
            || entry.notes.filter((note) => !note.rest).every((note) => note.tieEnd)))
        .map((entry) => ({
          start: entry.position.toFloat(),
          end: entry.position.plus(entry.duration ?? new Fraction(1, 192)).toFloat(),
        })));
    // A beat-sliced voice Tuplet can hide the shared source event for a
    // parallel whole note. Keep its original sounding span when deciding
    // whether an otherwise empty beat needs a draft rest.
    const sourceSoundSpans = score.parts.flatMap((part, partIndex) =>
      (part.measures[measureIndex]?.entries ?? [])
        .filter((entry): entry is Chord => entry instanceof Chord
          && !entry.rest && entry.notes.some((note) => !note.rest))
        .map((entry) => ({
          voice: clamp(partIndex + 1, 1, voiceCount),
          start: entry.position.toFloat(),
          end: entry.position.plus(entry.duration ?? new Fraction(1, 192)).toFloat(),
        })));
    const silentVoicesAt = (position: number): number[] => {
      const sounding = new Set(sourceSoundSpans
        .filter((span) => span.start <= position + 1e-8 && span.end > position + 1e-8)
        .map((span) => span.voice));
      return Array.from({ length: voiceCount }, (_unused, index) => index + 1)
        .filter((voice) => !sounding.has(voice));
    };
    const segments: string[] = [];
    for (let groupIndex = 0; groupIndex < groups; groupIndex++) {
      const start = groupIndex * groupDuration;
      const end = start + groupDuration;
      const attacks = events
        .filter((item) => item.start >= start - 1e-8 && item.start < end - 1e-8)
        .map((item): OutputEvent => ({ ...item, continued: false }));
      const activeBeforeGroup = events
        .filter((item) => item.start < start - 1e-8 && item.end > start + 1e-8);
      const inGroup: OutputEvent[] = [...attacks];
      if (activeBeforeGroup.length > 0
        && (attacks[0]?.start ?? end) > start + 1e-8) {
        const latest = activeBeforeGroup.reduce((left, right) =>
          right.start > left.start ? right : left);
        inGroup.push({
          ...latest,
          start,
          end: Math.max(...activeBeforeGroup.map((item) => item.end)),
          embeddedDuration: latest.embeddedDuration === undefined ? undefined
            : Math.max(0, latest.start + latest.embeddedDuration - start),
          continued: true,
        });
      }
      inGroup.sort((a, b) => a.start - b.start || Number(Boolean(b.continued)) - Number(Boolean(a.continued)));
      const hasNewSound = attacks.some((event) =>
        event.chords.some((chord) =>
          chord.notes.some((note) => !note.rest)))
        || (voiceCount > 1 && attacks.some((event) =>
          (event.restVoiceIndexes?.length ?? 0) > 0))
        || attacks.some((event) => event.specialToken !== undefined
          && event.specialToken !== "" && event.specialToken !== "0");
      const soundingIntoGroup = activeBeforeGroup.some((event) =>
        event.chords.some((chord) => chord.notes.some((note) => !note.rest)))
        || continuationSpans.some((span) =>
          span.start <= start + 1e-8 && span.end > start + 1e-8);
      // A held note needs the normal continuation writer even when this beat
      // contains no fresh attack. The rest-only shortcut would truncate it.
      if (!hasNewSound && !soundingIntoGroup) {
        const coveredByContainer = activeBeforeGroup.some((event) =>
          event.embeddedDuration !== undefined && !event.parallelVoiceTuplet
          && event.start + event.embeddedDuration >= end - 1e-8);
        if (coveredByContainer) {
          // These events are already inside the earlier shared bracket.
          // Keep the slash ruler without inventing a new rest/attack here.
          segments.push(durationText(groupDuration) || symbol);
          continue;
        }
        if (preserveInputRests) {
          // The visible event may have been hidden by a beat-sliced Tuplet.
          // Derive each voice's actual silence from the source Score: a V1
          // rest must not stop a V2 whole note, and a bare ruler must not
          // extend V1's final pitched member through an empty following beat.
          const voices = silentVoicesAt(start);
          if (voices.length === 0) {
            segments.push(durationText(groupDuration) || symbol);
            continue;
          }
          const restEvent: OutputEvent = {
            start,
            end,
            chords: [],
            voiceIndexes: [],
            restVoiceIndexes: voices,
            specialToken: "0",
          };
          const token = outputToken(restEvent, kind, fifthsAt(start), voiceCount, ordering, {
            ...exportGroups,
          }) || "0";
          segments.push(token + durationText(Math.max(0, groupDuration - noteUnit)));
          continue;
        }
        const leadingSilence = !events.some((event) => event.chords.length > 0
          && event.start < start - 1e-8);
        const writtenRest = (keepExplicitRests || (preserveLeadingSilence && leadingSilence))
          ? attacks.find((event) => event.specialToken === "0"
            || (event.restVoiceIndexes?.length ?? 0) > 0)
          : undefined;
        if (writtenRest) {
          const token = outputToken(writtenRest, kind, fifthsAt(start), voiceCount, ordering, {
            ...exportGroups,
          }) || "0";
          segments.push(token + durationText(Math.max(0, groupDuration - noteUnit)));
          continue;
        }
        segments.push(durationNotation?.emptyGroupsAsRests
          ? " - "
          : durationText(groupDuration) || symbol);
        continue;
      }
      if (inGroup.length === 0) {
        segments.push(durationText(groupDuration) || symbol);
        continue;
      }
      const isAttachedHalfCell = (value: number): boolean => {
        const cells = (Math.max(start, Math.min(end, value)) - start) / unit;
        return Math.abs(cells - Math.round(cells)) > 1e-8
          && Math.abs(cells * 2 - Math.round(cells * 2)) <= 1e-8;
      };
      const hasAttachedHalfGrid = noteUnit <= 1e-9 && inGroup.some((event) =>
        isAttachedHalfCell(event.start) || isAttachedHalfCell(event.end));
      // Ordinary tight adjacency now denotes grace notes, never a hidden
      // half-grid. Keep the legacy writer referenced for old internal tooling,
      // but do not emit its ambiguous spelling into new TXT documents.
      const allowLegacyAttachedSubdivision = false;
      if (allowLegacyAttachedSubdivision
        && (midiExport?.subdivisionMode || hasAttachedHalfGrid)) {
        segments.push(attachedSubdivisionGroupText(
          inGroup,
          start,
          end,
          unit,
          noteUnit,
          symbol,
          kind,
          fifthsAt,
          voiceCount,
          ordering,
          exportGroups,
        ));
        continue;
      }
      let cursor = start;
      let out = "";
      let continuationMarkerVoice: number | null = null;
      const appendMarkers = (duration: number) => {
        if (duration > 1e-9 && continuationMarkerVoice !== null) {
          out += SLASH_VOICE_SEPARATOR.repeat(clamp(
            continuationMarkerVoice,
            1,
            voiceCount,
          ));
          continuationMarkerVoice = null;
        }
        out += durationText(Math.max(0, duration));
      };
      inGroup.forEach((event, eventIndex) => {
        const eventStart = Math.max(start, event.start);
        if (eventStart > cursor + 1e-8) appendMarkers(eventStart - cursor);
        const token = event.continued
          ? ""
          : outputToken(event, kind, fifthsAt(eventStart), voiceCount, ordering, {
            ...exportGroups,
          }, durationText, unit, false, noteUnit <= 1e-9 && delimiterFor("chord", exportGroups) !== null);
        if (token) {
          continuationMarkerVoice = null;
          if (out && !delimiterFor("chord", exportGroups)) out += durationNotation?.spaceDivision ? "\t" : " ";
          out += token;
        }
        if (event.embeddedDuration !== undefined) {
          if (event.parallelVoiceTuplet) {
            cursor = Math.max(cursor, eventStart);
            return;
          }
          const occupied = Math.min(end - eventStart, event.embeddedDuration);
          cursor = Math.max(cursor, eventStart + occupied);
          continuationMarkerVoice = event.continuationVoiceAfterEmbedded ?? null;
          return;
        }
        const nextStart = inGroup[eventIndex + 1]?.start ?? end;
        const eventEnd = Math.min(end, event.end, nextStart);
        const intrinsic = token && !event.continued ? noteUnit : 0;
        appendMarkers(Math.max(0, eventEnd - eventStart - intrinsic));
        cursor = Math.max(cursor, eventEnd);
      });
      if (cursor < end - 1e-8) {
        const trailingSound = inGroup.some((event) => event.chords.length > 0
          && Math.abs(event.end - cursor) < 1e-8);
        const parallelTupletRuler = inGroup.some((event) =>
          event.parallelVoiceTuplet && event.embeddedDuration !== undefined);
        const silentVoices = silentVoicesAt(cursor);
        if (trailingSound && !parallelTupletRuler && silentVoices.length > 0) {
          // A short attack can leave real silence at the end of a slash group
          // without a Chord rest in the Score. Bare ruler marks would extend
          // that attack, so terminate it with an explicit zero first.
          out += outputToken({ start: cursor, end, chords: [], voiceIndexes: [],
            restVoiceIndexes: silentVoices, specialToken: "0" },
          kind, fifthsAt(cursor), voiceCount, ordering, exportGroups) || "0";
          continuationMarkerVoice = null;
          appendMarkers(Math.max(0, end - cursor - noteUnit));
        } else {
          appendMarkers(end - cursor);
        }
      }
      segments.push(out || durationText(groupDuration) || symbol);
    }
    const previousMeasure = measureIndex > 0 ? score.parts[0]?.measures[measureIndex - 1] : undefined;
    if (measure && previousMeasure
      && (measure.time.beats !== previousMeasure.time.beats
        || measure.time.beatType !== previousMeasure.time.beatType)) {
      lines.push(`${measure.time.beats}/${measure.time.beatType}拍:`);
    }
    lines.push(segments.join("/") + "/");
  }
  return lines.join("\n") + "\n";
}

export function slashScoreTemplate(kind: SlashScoreKind): string {
  return [
    kind === "keyboard" ? "键盘谱" : "数字谱",
    "// 这里可以写任意说明；只有含 / 的有效谱行会被读取。",
    "标题 = 未命名",
    "1 = C",
    "4/4拍：",
    "速度 = 每分钟90四分音符(90 BPM)",
    ". = 8分音符",
    "花括号 = 琶音（括号内音符按滚奏和弦处理）",
    "方括号 = 三连音（括号内三个时值按 3:2 压缩）",
    "尖括号 = 倚音（装饰音不增加小节拍长）",
    "圆括号 = 和弦（括号内音符同时发声）",
    "",
    "-/-/-/-/",
    "",
  ].join("\n");
}

/** Persist dialog choices inside a normal ignored TXT comment without deleting any user text. */
export function embedSlashScoreOptions(text: string, options: SlashScoreOptions): string {
  const clean = stripSlashScoreOptions(text);
  const stored: Record<string, unknown> = {
    v: 2,
    vc: clamp(Math.round(options.voiceCount || 1), 1, MAX_SLASH_VOICES),
    k: options.kind === "keyboard" ? "k" : "n",
    kl: options.keyboardKeyLabels ?? false,
    kz: options.keyboardTieAsZero ?? false,
    kh: options.keyboardHideTieLabels ?? false,
    n: options.title,
    bpm: options.tempoBpm,
    bu: options.tempoBeatUnit,
    f: options.fifths,
    m: [options.beats, options.beatType],
    s: { ...options.symbolDurations },
    ms: options.multiDurationSymbols ?? false,
    sp: options.spaceDivision,
    nd: options.noteDivision,
    er: options.emptyGroupsAsRests ?? false,
    ri: options.showExplicitRests ?? true,
    b: compactSlashGroupMode(options.braceMode),
    q: compactSlashGroupMode(options.bracketMode ?? "triplet"),
    vb: compactSlashGroupMode(options.barMode ?? "none"),
    x: compactSlashGroupMode(options.angleMode ?? "grace"),
    p: compactSlashGroupMode(options.parenMode ?? "chord"),
    o: options.ordering ?? "pitch-asc",
  };
  if (options.wholeMeasureGroups) stored.wg = true;
  if (options.sourceTimedRows) {
    stored.st = true;
    stored.ac = options.adjacentAsChord ?? true;
  }
  if (options.instrumentName?.trim()) stored.i = options.instrumentName.trim();
  if (options.subtitle) stored.u = options.subtitle;
  if (options.composer) stored.c = options.composer;
  if (options.arranger) stored.a = options.arranger;
  if (options.lyricist) stored.l = options.lyricist;
  const headerTypography = normalizeHeaderTypography(options.headerTypography);
  if (headerTypography) stored.ht = headerTypography;
  if (options.tempoMarks?.length) {
    stored.tm = options.tempoMarks.map((mark) => ({ ...mark }));
  }
  if (options.keyChanges?.length) {
    stored.kc = options.keyChanges.map((change) => ({ ...change }));
  }
  const annotations = normalizeNotationAnnotations(options.annotations);
  if (annotations.length > 0) stored.an = annotations;
  if (options.noteTimingEdits?.length) {
    stored.ne = normalizeNoteTimingEdits(options.noteTimingEdits).map((edit) => ({ ...edit }));
  }
  const line = `// @jpeditor ${JSON.stringify(stored)}`;
  // Keep the machine-readable state at the end of the document.  Apart from
  // being easier to inspect, this is important when rows are inserted: the
  // metadata must move with the document footer instead of becoming part of a
  // score section or being mistaken for a comment between measures.
  const lines = clean.replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((item) => !/^\s*\/\/\s*@jpeditor\s+\{/.test(item));
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  lines.push("", line);
  return lines.join("\n") + "\n";
}

/** Convert Score-level input annotations into the compact TXT metadata union. */
export function notationAnnotationsFromScore(
  score: Score,
  intrinsicNotation?: SlashScoreOptions,
): NotationAnnotationData[] {
  const result: NotationAnnotationData[] = noteTieAnnotations(score).map(tie => ({
    ...tie, type: "note-tie", measure: tie.from.measure,
    offset: Fraction.fromString(tie.from.offset).toFloat(),
  }));
  for (const measure of score.parts[0]?.measures ?? []) {
    if (measure.index > 0 && measure.timeChange) {
      result.push({
        type: "meter",
        measure: measure.index,
        beats: measure.time.beats,
        beatType: measure.time.beatType as 2 | 4 | 8 | 16,
      });
    }
  }
  for (const mark of score.keyMarks) {
    if (mark.measure < 0) continue;
    result.push({ type: "key", measure: mark.measure, offset: mark.offset.toFloat(), fifths: mark.fifths });
  }
  const tempo = [...score.tempoMarks]
    .filter((mark) => !mark.softDeleted)
    .sort((a, b) => a.measure - b.measure || a.offset.compareTo(b.offset));
  const consumedTempo = new Set<TempoMark>();
  for (const mark of tempo) {
    if (consumedTempo.has(mark)) continue;
    if (mark.kind === "accel" || mark.kind === "rit") {
      const target = tempo.find((candidate) => candidate.kind === "tempo"
        && candidate.bpm !== null
        && (candidate.measure > mark.measure
          || candidate.measure === mark.measure && candidate.offset.compareTo(mark.offset) > 0));
      if (target) {
        consumedTempo.add(target);
        result.push({
          type: "tempo-ramp",
          mode: mark.kind,
          from: { measure: mark.measure, offset: mark.offset.toFloat() },
          to: { measure: target.measure, offset: target.offset.toFloat() },
          targetBpm: target.bpm!,
        });
      }
      continue;
    }
    if (mark.bpm !== null) {
      result.push({ type: "tempo", measure: mark.measure, offset: mark.offset.toFloat(), bpm: mark.bpm });
    }
  }
  score.parts.forEach((part, partIndex) => part.measures.forEach((measure) => {
    measure.entries.forEach((entry) => {
      if (!(entry instanceof Chord)) return;
      if (entry.notes.some((note) => note.tuplet && !note.tuplet.ornamentProxy)) return;
      for (const ornament of entry.ornaments) {
        result.push({
          type: "ornament",
          part: partIndex,
          measure: measure.index,
          offset: entry.position.toFloat(),
          kind: ornament.kind,
          ...(ornament.kind === "trill" ? { subdivision: ornament.subdivision } : {}),
        });
      }
    });
  }));
  const persistedTuplets = new Set<Tuplet>();
  score.parts.forEach((part, partIndex) => part.measures.forEach((measure) => {
    measure.entries.forEach((entry) => {
      if (!(entry instanceof Chord)) return;
      for (const note of entry.notes) {
        const tuplet = note.tuplet;
        if (!tuplet || tuplet.ornamentProxy || persistedTuplets.has(tuplet)) continue;
        const first = tuplet.first.chord;
        const members = tuplet.memberChords();
        const intrinsicUnit = intrinsicNotation?.noteDivision
          ? 4 / intrinsicNotation.noteDivision : 0;
        const intrinsicGlyphUnit = intrinsicNotation
          ? Math.min(...Object.values(effectiveMappings(intrinsicNotation)).map((division) => 4 / division))
          : Infinity;
        // A bracket shorter than the chosen intrinsic value, or a member
        // ratio unavailable on the configured glyph grid, needs explicit
        // timing metadata. Ordinary representable all-voice groups use the
        // visible bracket budget and must not also receive a timing override.
        const needsIntrinsicTiming = intrinsicUnit > 1e-9 && !intrinsicTupletSpelling(
          members, intrinsicUnit, intrinsicGlyphUnit,
        );
        const hasOutsideContinuation = intrinsicUnit > 1e-9
          && tuplet.last.tieNext !== null && !members.includes(tuplet.last.tieNext.chord);
        if (tuplet.scope !== "voice" && !members.some((chord) => chord.transparentContinuation)
          && !needsIntrinsicTiming && !hasOutsideContinuation) continue;
        persistedTuplets.add(tuplet);
        const actualEnd = tuplet.actualEnd
          ?? members.reduce((latest, chord) => {
            const end = chord.position.plus(chord.duration ?? new Fraction(0));
            return end.compareTo(latest) > 0 ? end : latest;
          }, first.position);
        const beat = measure.time.beatType === 8 && measure.time.beats >= 6
          && measure.time.beats % 3 === 0 ? 1.5 : 4 / measure.time.beatType;
        const restCutoff = (Math.floor(actualEnd.toFloat() / beat + 1e-10) + 1) * beat;
        const parallelCrossesEnd = score.parts.some((otherPart, otherIndex) =>
          otherIndex !== partIndex && (otherPart.measures[measure.index]?.entries ?? []).some((candidate) =>
            candidate instanceof Chord && !candidate.rest
            && candidate.position.compareTo(actualEnd) < 0
            && candidate.position.plus(candidate.duration ?? new Fraction(0)).compareTo(actualEnd) > 0));
        result.push({
          type: "triplet",
          part: tuplet.partIndex ?? partIndex,
          voice: tuplet.voiceIndex ?? part.voiceIndex ?? partIndex + 1,
          measure: first.measure.index,
          offset: first.position.toFloat(),
          scope: tuplet.scope,
          end: actualEnd.toFloat(),
          members: members.map((chord) => tuplet.writtenMemberDuration(
            chord.duration ?? new Fraction(0),
          ).toFloat()),
          memberRests: members.map((chord) => chord.rest),
          ...(members.some((chord) => chord.transparentContinuation)
            ? { memberContinuations: members.map((chord) => chord.transparentContinuation) } : {}),
          restoreUnit: (tuplet.binaryRestoreUnit ?? tuplet.writtenUnit ?? new Fraction(0)).toFloat(),
          ordinary: score.parts.flatMap((parallelPart, parallelIndex) =>
            (parallelPart.measures[measure.index]?.entries ?? []).flatMap((entry): SlashOrdinaryTiming[] => {
              if (!(entry instanceof Chord) || entry.generatedTimingContinuation
                || entry.notes.some((note) => note.tuplet)
                || entry.position.compareTo(first.position) < 0
                || !entry.duration) return [];
              const followingRest = parallelIndex === partIndex && parallelCrossesEnd
                && entry.rest && entry.position.compareTo(actualEnd) >= 0
                && entry.position.toFloat() < restCutoff - 1e-8;
              if (entry.position.compareTo(actualEnd) >= 0 && !followingRest) return [];
              return [{ part: parallelIndex, offset: entry.position.toFloat(),
                duration: entry.duration.toFloat(), rest: entry.rest }];
            })),
        });
      }
    });
  }));
  for (const mark of score.crossPartArpeggios) {
    result.push({
      type: "cross-arpeggio",
      measure: mark.measure,
      offset: mark.offset.toFloat(),
      parts: [...mark.parts],
      pitches: mark.pitches.map((pitch) => ({ ...pitch })),
      direction: mark.direction,
    });
  }
  for (const mark of score.textMarks) {
    result.push({
      type: "text",
      part: mark.partIndex,
      measure: mark.measure,
      offset: mark.offset.toFloat(),
      text: mark.text,
    });
  }
  // Persist explicit slurs as source coordinates.  The endpoint is stored on
  // the opening chord by the score model, so this also round-trips slurs that
  // cross a barline or a system boundary.
  score.parts.forEach((part, partIndex) => part.measures.forEach((measure) => {
    measure.entries.forEach((entry) => {
      if (!(entry instanceof Chord) || !entry.slurStart || !entry.slurEndChord) return;
      const end = entry.slurEndChord;
      result.push({
        type: "slur",
        part: partIndex,
        from: { measure: measure.index, offset: entry.position.toFloat() },
        to: { measure: end.measure.index, offset: end.position.toFloat() },
      });
    });
  }));
  return normalizeNotationAnnotations(result);
}

/** Embed Score annotations while preserving the caller's other TXT options. */
export function embedSlashScoreOptionsFromScore(
  text: string,
  score: Score,
  options: SlashScoreOptions,
): string {
  const annotations = notationAnnotationsFromScore(score, options);
  const rows = sourceLines(text, options.kind).score;
  for (const annotation of annotations) {
    if (annotation.type !== "triplet" || annotation.end === undefined
      || options.wholeMeasureGroups) continue;
    const measure = score.parts[annotation.part]?.measures[annotation.measure];
    if (!measure) continue;
    const beat = measure.time.beatType === 8 && measure.time.beats >= 6
      && measure.time.beats % 3 === 0 ? 1.5 : 4 / measure.time.beatType;
    const first = Math.floor((annotation.offset + 1e-8) / beat);
    const last = Math.floor((annotation.end - 1e-8) / beat);
    if (last <= first) continue;
    const groups = splitGroups(rows[annotation.measure] ?? "");
    const delimiters = slashDelimiterSpecs(options).filter((spec) => spec.mode === "triplet");
    if (groups.slice(first, last + 1).length === last - first + 1
      && groups.slice(first, last + 1).every((group) => delimiters.some((spec) =>
        group.includes(spec.open) && group.includes(spec.close)))) annotation.beatSlices = true;
  }
  // A shorter voice-owned group inside a sliced long group uses those same
  // printed beat slices even if it never crosses a slash itself.
  const tuplets = annotations.filter((annotation): annotation is Extract<NotationAnnotationData, { type: "triplet" }> =>
    annotation.type === "triplet" && annotation.end !== undefined)
    .sort((a, b) => a.measure - b.measure || a.offset - b.offset);
  for (let first = 0; first < tuplets.length;) {
    let end = tuplets[first]!.end!;
    let sliced = tuplets[first]!.beatSlices === true;
    let next = first + 1;
    while (next < tuplets.length && tuplets[next]!.measure === tuplets[first]!.measure
      && tuplets[next]!.offset < end - 1e-8) {
      end = Math.max(end, tuplets[next]!.end!);
      sliced ||= tuplets[next]!.beatSlices === true;
      next++;
    }
    if (sliced) for (let member = first; member < next; member++) tuplets[member]!.beatSlices = true;
    first = next;
  }
  const embedded = embedSlashScoreOptions(text, {
    ...options,
    headerTypography: normalizeHeaderTypography(score.headerTypography),
    annotations,
  });
  // Keep all machine directives together with the metadata header.  Older
  // versions inserted them beside the affected measure, which made a TXT
  // file hard to read and caused the directives to be mistaken for score
  // comments by other editors.
  const cleaned = embedded
    .replace(
      /^\s*\/\/\s*@(key|tempo|text)\b[^\r\n]*(?:\r?\n|$)/gmi,
      "",
    )
    .replace(
      /^\s*\/\/\s*"(?:第[\d.]+拍转调到[^"\r\n]+|第\d+小节第[\d.]+拍转调到[^"\r\n]+|第\d+小节起改为\d+\/(?:2|4|8|16)拍|第\d+小节第[\d.]+拍速度为[\d.]+BPM|\d+到\d+小节渐(?:快|慢)到[\d.]+BPM|第\d+小节第[\d.]+拍到第\d+小节第[\d.]+拍渐(?:快|慢)到[\d.]+BPM)"\s*(?:\r?\n|$)/gm,
      "",
    );
  const lines = cleaned.split(/\r?\n/);
  const records = sourceLineRecords(cleaned);
  const scoreLines = records
    .map((record, index) => selectedScoreLine(records, index, options.kind) ? record.line - 1 : -1)
    .filter((line) => line >= 0);
  const byMeasure = new Map<number, string[]>();
  for (const annotation of annotations) {
    if (annotation.type === "ornament" || annotation.type === "cross-arpeggio"
      || annotation.type === "slur") continue;
    const measure = annotation.type === "tempo-ramp"
      ? annotation.from.measure
      : annotation.measure;
    const directive = serializeSlashHumanDirectives([annotation])[0];
    if (!directive) continue;
    const group = byMeasure.get(measure) ?? [];
    if (!group.includes(directive)) group.push(directive);
    byMeasure.set(measure, group);
  }
  for (const [measure, directives] of [...byMeasure].sort((left, right) => right[0] - left[0])) {
    const line = scoreLines[Math.max(0, Math.min(scoreLines.length - 1, measure))];
    if (line !== undefined) lines.splice(line, 0, ...directives);
  }
  // `embedSlashScoreOptions` has already written @jpeditor at the footer.
  // Append the readable @key/@tempo records beside it, with exactly one blank
  // line separating all metadata from the final score row.
  const machine = normalizeNotationAnnotations(annotations)
    .filter((annotation) => annotation.type === "key"
      || annotation.type === "tempo"
      || annotation.type === "tempo-ramp")
    .flatMap((annotation) => serializeSlashReadableDirectives([annotation]));
  const lineEnding = cleaned.includes("\r\n") ? "\r\n" : "\n";
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  const footerIndex = lines.findIndex((line) => /^\s*\/\/\s*@jpeditor\s+\{/.test(line));
  if (footerIndex >= 0) {
    const footer = lines.splice(footerIndex, lines.length - footerIndex);
    const jp = footer.filter((line) => /^\s*\/\/\s*@jpeditor\s+\{/.test(line));
    // `embedSlashScoreOptions()` already inserted its separator before the
    // footer.  Remove it before rebuilding the combined footer, otherwise
    // every edit grows the gap by one extra empty line.
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    // Keep the machine settings first; readable @key/@tempo directives are
    // supplementary and must follow the @jpeditor record at the footer.
    lines.push("", ...jp, ...machine);
  } else if (machine.length > 0) {
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push("", ...machine);
  }
  return lines.join(lineEnding) + lineEnding;
}

/** Remove only the persisted editor settings comment and keep every score/comment line unchanged. */
export function stripSlashScoreOptions(text: string): string {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom ? text.slice(1) : text;
  return bom + body.replace(
    /^[ \t]*\/\/[ \t]*@jpeditor[ \t]+\{[^\r\n]*\}[ \t]*(?:\r?\n|$)/gm,
    "",
  );
}

/**
 * Keep the human-readable TXT rhythm declarations in sync with the settings
 * comment. Changing "." to "=" updates both the score rows and the visible
 * `点/符号/空格` declaration instead of leaving contradictory instructions.
 */
export function rewriteSlashDurationDirectives(
  text: string,
  options: Pick<
    SlashScoreOptions,
    "symbolDurations" | "multiDurationSymbols" | "spaceDivision" | "noteDivision"
  >,
): string {
  const lineEnding = text.includes("\r\n") ? "\r\n" : "\n";
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom ? text.slice(1) : text;
  const lines = body.split(/\r?\n/);
  const durationDirective = /^\s*(?:点|两个点|符号\s*[（(].*?[）)]|空格|音符(?:自身时值)?|音自身时值|[^\sA-Za-z0-9\u3400-\u9fff])\s*[=＝：:]/i;
  const found = lines.flatMap((line, index) =>
    durationDirective.test(line) ? [index] : []);
  const tempoIndex = lines.findIndex((line) =>
    /^\s*(?:速度|Tempo)\s*[=＝：:]/i.test(line));
  const insertion = found[0] ?? (tempoIndex >= 0 ? tempoIndex + 1 : 0);
  const retained = lines.filter((line) => !durationDirective.test(line));
  const removedBeforeInsertion = found.filter((index) => index < insertion).length;
  const at = Math.max(0, Math.min(
    retained.length,
    insertion - removedBeforeInsertion,
  ));

  const configured = Object.entries(options.symbolDurations);
  const active = options.multiDurationSymbols === false
    ? configured.slice(0, 1)
    : configured;
  const directives = active.flatMap(([glyph, division]) => {
    const value = Array.from(glyph)[0];
    if (!value || value === " ") return [];
    return [`${value} = ${division}分音符`];
  });
  if (options.spaceDivision) {
    directives.push(`空格 = ${options.spaceDivision}分音符`);
  }
  if (options.noteDivision) {
    directives.push(`音符自身时值 = ${options.noteDivision}分音符`);
  }
  retained.splice(at, 0, ...directives);
  return bom + retained.join(lineEnding);
}

export interface SlashVoiceMigration {
  text: string;
  from: number;
  to: number;
  mergedVoices: number[];
  /** Options after part/voice-index migration, ready for the caller to keep. */
  options: SlashScoreOptions;
}

/**
 * Change N while keeping unmarked notes on the current default row. Increasing
 * therefore moves the old default material to the newly created last voice;
 * explicitly marked upper voices retain their indexes. Decreasing merges
 * removed rows into the new unmarked default row.
 */
export function migrateSlashVoiceCount(
  text: string,
  options: SlashScoreOptions,
  requested: number,
): SlashVoiceMigration {
  const from = clamp(Math.round(options.voiceCount), 1, MAX_SLASH_VOICES);
  const to = clamp(Math.round(requested), 1, MAX_SLASH_VOICES);
  if (from === to) {
    const nextOptions = {
      ...options,
      voiceCount: to,
      annotations: options.annotations?.map((annotation) => ({ ...annotation })),
      noteTimingEdits: options.noteTimingEdits?.map((edit) => ({ ...edit })),
    };
    return {
      text: embedSlashScoreOptions(text, nextOptions),
      from,
      to,
      mergedVoices: [],
      options: nextOptions,
    };
  }
  // Rewrite every marker-bearing atom, including voice-specific rests and
  // continuation markers. `slashPitchSources()` only indexes pitches, so
  // using it here left a `⁣0` behind when V2 was merged into V1; the parser
  // then reported a stray marker and could restore the rest on the wrong row.
  const markerChanges: Array<{ from: number; to: number; insert: string }> = [];
  if (to !== from) {
    const records = sourceLineRecords(text);
    const mappings = effectiveMappings(options);
    for (const [recordIndex, record] of records.entries()) {
      if (!selectedScoreLine(records, recordIndex, options.kind)) continue;
      for (const match of record.raw.matchAll(/\u2063+/g)) {
        const markerFrom = (match.index ?? 0);
        const markerTo = markerFrom + match[0].length;
        let cursor = markerTo;
        while (/\s/.test(record.raw[cursor] ?? "")) cursor++;
        const next = record.raw[cursor] ?? "";
        // A marker before an ordinary score atom is migratable.  Unknown
        // marker uses are retained so prose-like content is not damaged.
        const atom = pitchAt(record.raw, cursor, options) !== null
          || next === "0" || mappings[next] !== undefined;
        if (!atom) continue;
        const markerVoice = compactMarkerBaseCount(match[0].length);
        const targetVoice = to > from && markerVoice === from
          ? to
          : markerVoice > to ? to : markerVoice;
        if (targetVoice !== markerVoice) markerChanges.push({
          from: record.from + markerFrom,
          to: record.from + markerTo,
          insert: slashVoiceMarker(match[0].length, targetVoice, to),
        });
      }
    }
  }
  let migrated = text;
  for (const change of markerChanges.sort((left, right) => right.from - left.from || right.to - left.to)) {
    migrated = migrated.slice(0, change.from) + change.insert + migrated.slice(change.to);
  }
  const remapPart = (part: number): number => {
    const index = clamp(Math.round(part), 0, Math.max(0, from - 1));
    if (to > from && index === from - 1) return to - 1;
    return index >= to ? to - 1 : index;
  };
  const remapVoice = (voice: number): number => remapPart(Math.max(0, voice - 1)) + 1;
  const migratedAnnotations = (options.annotations ?? []).flatMap((annotation): NotationAnnotationData[] => {
    if (annotation.type === "cross-arpeggio") {
      const parts = [...new Set(annotation.parts.map(remapPart))];
      const pitches = annotation.pitches.map((item) => ({ ...item, part: remapPart(item.part) }));
      return [{ ...annotation, parts, pitches }];
    }
    if (annotation.type === "ornament" || annotation.type === "slur"
      || annotation.type === "text") {
      return [{ ...annotation, part: remapPart(annotation.part) }];
    }
    if (annotation.type === "triplet") {
      return [{ ...annotation, part: remapPart(annotation.part), voice: remapVoice(annotation.voice),
        ...(annotation.ordinary ? { ordinary: annotation.ordinary.map((item) => ({ ...item, part: remapPart(item.part) })) } : {}) }];
    }
    return [{ ...annotation }];
  });
  const migratedEdits = (options.noteTimingEdits ?? []).map((edit) => ({
    ...edit,
    part: remapPart(edit.part),
  }));
  const nextOptions = {
    ...options,
    voiceCount: to,
    annotations: migratedAnnotations,
    noteTimingEdits: migratedEdits,
  };
  return {
    text: embedSlashScoreOptions(migrated, nextOptions),
    from,
    to,
    mergedVoices: to < from
      ? Array.from({ length: from - to + 1 }, (_unused, index) => to + index)
      : [],
    options: nextOptions,
  };
}

/** Collapse a compact TXT score to one voice while retaining all attacks. */
export function stripSlashVoiceMarkers(text: string, options?: SlashScoreOptions): string {
  const clean = text.split(SLASH_VOICE_SEPARATOR).join("");
  return options
    ? embedSlashScoreOptions(clean, { ...options, voiceCount: 1 })
    : clean.replace(
      /(^\s*\/\/\s*@jpeditor\s+)(\{[^\n]*\})/m,
      (_all, prefix: string, json: string) => {
        try {
          const value = JSON.parse(json) as Record<string, unknown>;
          value.v = 2;
          value.vc = 1;
          return prefix + JSON.stringify(value);
        } catch {
          return prefix + json;
        }
      },
    );
}

function compactSlashGroupMode(mode: SlashGroupMode): "n" | "c" | "g" | "s" | "a" | "t" | "r" {
  return mode === "none" ? "n"
    : mode === "chord" ? "c"
    : mode === "grace" ? "g"
      : mode === "subdivide" ? "s"
      : mode === "arpeggio" ? "a"
        : mode === "triplet" ? "t" : "r";
}

/** Kept public for tests and UI summaries. */
export function slashChordToken(chord: Chord, kind: SlashScoreKind): string {
  return chordToken(chord, kind);
}
