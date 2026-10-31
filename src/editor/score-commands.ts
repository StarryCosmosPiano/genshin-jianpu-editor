import { Fraction } from "../common/fraction";
import type { NoteTimingDivision } from "../score/note-timing";
import type { ScoreInteractionMode } from "./input-mode";
import { inputKeyAt } from "./input-mode";
import { Chord, Key, MusicCommon, type Note, type Score } from "../score/score";
import { dedupeInputTargets, inputTargetFromNote, inputTargetChord, type InputTarget } from "./multi-input";
import { staffLetterPitch, staffPitchSpec, type StaffPitchSpec } from "./staff-edit";
import { ensureInputMeasure } from "../score/input-edit";

export type ScoreSurface = "jianpu" | "staff";
export type ScoreSelectionMode = "single" | "multiple" | "range" | "marquee";
export type ScoreDegree = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type ScoreLetter = "C" | "D" | "E" | "F" | "G" | "A" | "B";
export type ScoreMarkKind = "tempo" | "accel" | "rit" | "key" | "meter" | "text"
  | "upper-mordent" | "lower-mordent" | "trill" | "fermata" | "grace" | "arpeggio"
  | "cross-arpeggio" | "triplet" | "slur";
export interface ScoreObjectRef { revision: number; id: string }
export interface ScoreNoteRef { revision: number; id: string }
export interface ScoreInputPosition {
  partIndex: number;
  measureIndex: number;
  /** Exact quarter-note offset, never a rounded screen coordinate. */
  offset: string;
  midi?: number;
  step?: string;
  octave?: number;
  gridDivision?: NoteTimingDivision;
}
export interface ScoreTouchCandidate {
  kind: "note" | "object";
  ref: ScoreNoteRef | ScoreObjectRef;
  label: string;
  partIndex: number;
  measureIndex: number;
  offset: string;
  distance: number;
}
export interface ScoreObjectSummary {
  ref: ScoreObjectRef;
  kind: string;
  label: string;
  selected: boolean;
  editable: boolean;
}
export interface ScoreCommandAvailability { enabled: boolean; reason?: string; checked?: boolean }

/** UI intent, independent of physical keyboard bindings and pointer events. */
export type ScoreCommand =
  | { type: "start-input"; at?: "selection" | "start" | "end" }
  | { type: "set-mode"; mode: ScoreInteractionMode }
  | { type: "set-auto-advance"; enabled: boolean }
  | { type: "set-selection-mode"; mode: ScoreSelectionMode }
  | { type: "input-degree"; degree: ScoreDegree; /** Absolute jianpu register; omitted keeps each target's register. */ octave?: number }
  | { type: "input-letter"; letter: ScoreLetter; octave?: number; accidental?: -1 | 0 | 1 }
  | { type: "confirm-input" }
  | { type: "move-cursor"; direction: "left" | "right" | "up" | "down"; by?: "grid" | "duration" }
  | { type: "advance" }
  | { type: "move-note"; direction: "earlier" | "later" | "part-up" | "part-down" }
  | { type: "pitch"; movement: "octave" | "diatonic" | "semitone"; delta: -1 | 1 }
  | { type: "resize-note"; delta: -1 | 1 }
  | { type: "set-duration"; division: NoteTimingDivision | null; target?: "pending" | "selection" }
  | { type: "set-grid"; division: NoteTimingDivision | null }
  | { type: "toggle-dot"; target: "grid" | "pending" | "selection" }
  | { type: "prepare-chord"; side: "above" | "below" }
  | { type: "finish-chord" }
  | { type: "select-part"; partIndex: number }
  | { type: "assign-voice"; voice: number }
  | { type: "set-position"; position: ScoreInputPosition }
  | { type: "select-notes"; refs: readonly ScoreNoteRef[]; additive?: boolean; range?: boolean }
  | { type: "select-object"; ref: ScoreObjectRef }
  | { type: "edit-object"; ref?: ScoreObjectRef }
  | { type: "delete-object"; ref?: ScoreObjectRef }
  | { type: "add-mark"; kind: ScoreMarkKind }
  | { type: "insert-measure"; side: "before" | "after" }
  | { type: "delete-measures" }
  | { type: "clear-selection" }
  | { type: "delete" }
  | { type: "undo" }
  | { type: "redo" };

export interface ScoreEditorState {
  revision: number;
  surface: ScoreSurface;
  mode: ScoreInteractionMode;
  ready: boolean;
  reason: string;
  autoAdvance: boolean;
  selectionMode: ScoreSelectionMode;
  chordSide: "above" | "below" | null;
  cursor: (ScoreInputPosition & { target: "note" | "ghost"; degree: number;
    jpOctave: number; lane: "rest" | "above" | "below" }) | null;
  selection: { kind: "none" | "notes" | "objects" | "mixed"; count: number; noteCount: number; objectCount: number };
  duration: { division: NoteTimingDivision; automatic: boolean; dotted: boolean; canDot: boolean };
  grid: { division: NoteTimingDivision; automatic: boolean; dotted: boolean };
  availableDivisions: readonly NoteTimingDivision[];
  parts: readonly { index: number; label: string }[];
  voiceCount: number;
  objects: readonly ScoreObjectSummary[];
  actions: Record<string, ScoreCommandAvailability>;
}

/** Stable semantic position key shared by the panel and selection commands. */
export function scorePositionKey(position: Pick<ScoreInputPosition, "partIndex" | "measureIndex" | "offset">): string {
  return `${position.partIndex}/${position.measureIndex}/${Fraction.fromString(position.offset).toString()}`;
}

export function validScoreInputPosition(position: ScoreInputPosition): boolean {
  if (!Number.isInteger(position.partIndex) || position.partIndex < 0
    || !Number.isInteger(position.measureIndex) || position.measureIndex < 0) return false;
  try {
    const value = Fraction.fromString(position.offset);
    return Number.isFinite(value.toFloat()) && value.compareTo(new Fraction(0)) >= 0
      && (position.midi === undefined || Number.isInteger(position.midi) && position.midi >= 0 && position.midi <= 127);
  } catch { return false; }
}

/** Preparing a chord is a cursor edit. It cannot modify or leave its source
 * part, even when the selected tone is already the highest/lowest voice. */
export function prepareScoreChordTargets(score: Score, targets: readonly InputTarget[], side: "above" | "below"): InputTarget[] {
  const groups = new Map<string, InputTarget>();
  for (const target of targets) if (!groups.has(scorePositionKey(target))) groups.set(scorePositionKey(target), target);
  return dedupeInputTargets([...groups.values()].map(target => {
    const chord = inputTargetChord(score, target);
    const notes = chord?.notes.filter(note => !note.rest).sort((a, b) => a.pitch - b.pitch) ?? [];
    const anchor = side === "above" ? notes[notes.length - 1] : notes[0];
    const base = anchor ? inputTargetFromNote(score, target.partIndex, anchor, target.division) : target;
    return { ...base, kind: "ghost" as const, toneIndex: null, lane: anchor ? side : "rest" as const,
      anchorToneIndex: anchor && chord ? chord.notes.indexOf(anchor) : null,
      anchorPitch: anchor?.pitch ?? base.anchorPitch, focusPitch: anchor?.pitch ?? base.focusPitch,
      anchorDegree: anchor ? Number(anchor.number) || 1 : base.anchorDegree,
      anchorOctave: anchor?.jpOctave ?? base.anchorOctave, octaveOffset: 0 };
  }));
}

/** Named screen keys keep the current written register. The physical C–B
 * shortcuts intentionally retain staffLetterPitch's preceding-attack rule. */
export function scoreScreenLetterPitch(score: Score, target: InputTarget, note: Note | null,
  letter: ScoreLetter, octave?: number, accidental?: -1 | 0 | 1): StaffPitchSpec {
  const fifths = inputKeyAt(score, target.partIndex, target.measureIndex, Fraction.fromString(target.offset)).fifths;
  const reference = note?.pitch ?? target.focusPitch ?? target.anchorPitch;
  const register = octave ?? target.staffOctave
    ?? (reference !== null ? staffPitchSpec(score, target, reference).octave : staffLetterPitch(score, target, letter).octave);
  const alter = accidental ?? MusicCommon.getAlter(letter, fifths);
  return staffPitchSpec(score, target, (register + 1) * 12 + MusicCommon.stepToPitch(letter) + alter,
    { step: letter, octave: register });
}

/** Labels do not expose model objects to UI consumers. */
export function scoreCommandNoteLabel(note: Note, partLabel: string, measureIndex: number, offset: Fraction): string {
  const register = note.jpOctave > 0 ? `高${note.jpOctave}组` : note.jpOctave < 0 ? `低${-note.jpOctave}组` : "中音";
  return `${partLabel} · 第${measureIndex + 1}小节 ${offset.plus(new Fraction(1)).toString()}拍 · ${note.rest ? "休止" : `${register} ${note.jpAlter.trim()}${note.number}`}`;
}

export function scoreChordsAtPosition(score: Score, position: ScoreInputPosition): Chord[] {
  const measure = score.parts[position.partIndex]?.measures[position.measureIndex];
  const offset = Fraction.fromString(position.offset);
  return measure?.entries.filter((entry): entry is Chord => entry instanceof Chord && entry.position.equals(offset)) ?? [];
}

/** Advance is an explicit editing action at the score tail. A newly required
 * bar belongs to the same disposable transaction as the entered note. */
export function advanceScoreInputTarget(score: Score, target: InputTarget, duration: Fraction): InputTarget {
  let measureIndex = target.measureIndex;
  let offset = Fraction.fromString(target.offset).plus(duration);
  let guard = 0;
  while (guard++ < 1024) {
    const measure = score.parts[target.partIndex]?.measures[measureIndex];
    if (!measure) break;
    const length = new Fraction(measure.time.beats * 4, measure.time.beatType);
    if (offset.compareTo(length) < 0) break;
    offset = offset.minus(length); measureIndex++;
    for (let part = 0; part < score.parts.length; part++) {
      const previousCount = score.parts[part].measures.length;
      ensureInputMeasure(score, part, measureIndex);
      for (let index = previousCount; index < score.parts[part].measures.length; index++) {
        const previous = score.parts[part].measures[index - 1];
        if (previous) score.parts[part].measures[index].key = Object.assign(new Key(), inputKeyAt(score, part,
          index - 1, new Fraction(previous.time.beats * 4, previous.time.beatType)));
      }
    }
  }
  score.parseRepeatInf();
  const pending: InputTarget = { ...target, measureIndex, offset: offset.toString(), kind: "ghost", toneIndex: null,
    lane: "rest", verticalIndex: 0, anchorToneIndex: null };
  const next = inputTargetChord(score, pending)?.notes.filter(note => !note.rest)
    .sort((a, b) => Math.abs(a.pitch - (target.focusPitch ?? target.anchorPitch ?? a.pitch))
      - Math.abs(b.pitch - (target.focusPitch ?? target.anchorPitch ?? b.pitch)) || a.pitch - b.pitch)[0];
  return next ? inputTargetFromNote(score, target.partIndex, next, target.division) : pending;
}
