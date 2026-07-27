import { Fraction } from "../common/fraction";
import { Chord, Measure, Note, type Part, type Score } from "./score";

export type NoteTimingDivision = 1 | 2 | 4 | 8 | 16 | 32 | 64;
export type NoteTimingSourceMode = "jpw" | "slash";

/**
 * A persistent rhythmic edit keyed by the original editable chord order in a
 * part. `move` and `duration` are deltas in quarter-note units.
 */
export interface NoteTimingEditData {
  part: number;
  chord: number;
  move: string;
  duration: string;
}

const ZERO = new Fraction(0);
const MIN_DURATION = new Fraction(1, 16); // one 64th note in quarter-note units

function safeFraction(value: unknown): Fraction | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!/^-?\d+(?:\/[1-9]\d*)?$/.test(text)) return null;
  const result = Fraction.fromString(text);
  return Number.isFinite(result.toFloat()) && Math.abs(result.toFloat()) <= 4096
    ? result
    : null;
}

function normalizedEdit(value: unknown): NoteTimingEditData | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<NoteTimingEditData> & {
    p?: number;
    c?: number;
    m?: string | number;
    d?: string | number;
  };
  const part = Math.round(Number(candidate.part ?? candidate.p));
  const chord = Math.round(Number(candidate.chord ?? candidate.c));
  const move = safeFraction(candidate.move ?? candidate.m ?? "0");
  const duration = safeFraction(candidate.duration ?? candidate.d ?? "0");
  if (!Number.isFinite(part) || part < 0 || !Number.isFinite(chord) || chord < 0
    || !move || !duration) return null;
  if (move.equals(0) && duration.equals(0)) return null;
  return {
    part,
    chord,
    move: move.toString(),
    duration: duration.toString(),
  };
}

/** Validate, de-duplicate, and sort timing edits read from JSON metadata. */
export function normalizeNoteTimingEdits(value: unknown): NoteTimingEditData[] {
  if (!Array.isArray(value)) return [];
  const byKey = new Map<string, NoteTimingEditData>();
  for (const item of value) {
    const edit = normalizedEdit(item);
    if (edit) byKey.set(noteTimingEditKey(edit.part, edit.chord), edit);
  }
  return [...byKey.values()].sort((left, right) =>
    left.part - right.part || left.chord - right.chord);
}

/**
 * JPW stores the same data in one compact Title value:
 * `1:3@1/4,0;2:7@0,1/8` (part/chord indexes are one-based on disk).
 */
export function parseJpwNoteTimingEdits(value: string | null | undefined): NoteTimingEditData[] {
  if (!value?.trim()) return [];
  const edits: NoteTimingEditData[] = [];
  for (const token of value.split(";")) {
    const match = /^(\d+):(\d+)@([^,]+),(.+)$/.exec(token.trim());
    if (!match) continue;
    const edit = normalizedEdit({
      part: parseInt(match[1], 10) - 1,
      chord: parseInt(match[2], 10) - 1,
      move: match[3],
      duration: match[4],
    });
    if (edit) edits.push(edit);
  }
  return normalizeNoteTimingEdits(edits);
}

export function serializeJpwNoteTimingEdits(edits: readonly NoteTimingEditData[]): string {
  return normalizeNoteTimingEdits(edits).map((edit) =>
    `${edit.part + 1}:${edit.chord + 1}@${edit.move},${edit.duration}`).join(";");
}

export function noteTimingEditKey(part: number, chord: number): string {
  return `${part}:${chord}`;
}

export function noteTimingStep(division: NoteTimingDivision): Fraction {
  return new Fraction(4, division);
}

/** Chords whose order is stable against generated rests and tie continuations. */
export function editableTimingChords(
  part: Part,
  mode: NoteTimingSourceMode,
): Chord[] {
  return part.measures.flatMap((measure) => measure.entries.filter((entry): entry is Chord =>
    entry instanceof Chord
    && !entry.generatedTimingContinuation
    && (mode === "jpw" || (!entry.rest && !entry.transparentContinuation))));
}

interface MeasureBoundary {
  measure: Measure;
  start: Fraction;
  end: Fraction;
}

interface ChordSnapshot {
  chord: Chord;
  part: Part;
  partIndex: number;
  chordIndex: number;
  start: Fraction;
  duration: Fraction;
}

function boundariesOf(part: Part): MeasureBoundary[] {
  const durations = part.measures.map((measure) => measure.duration);
  return part.measures.map((measure, index) => {
    const start = measure.position;
    const next = part.measures[index + 1]?.position;
    const ownEnd = start.plus(durations[index]);
    const end = next && next.compareTo(start) > 0 ? next : ownEnd;
    // Moving the last attack earlier must not pull the barline or following
    // systems left, so retain the original notated measure span.
    measure.timingMinimumDuration = durations[index];
    return { measure, start, end };
  });
}

function boundaryAt(
  boundaries: readonly MeasureBoundary[],
  absolute: Fraction,
): MeasureBoundary | null {
  for (let index = 0; index < boundaries.length; index++) {
    const boundary = boundaries[index];
    const final = index === boundaries.length - 1;
    if (absolute.compareTo(boundary.start) >= 0
      && (absolute.compareTo(boundary.end) < 0 || (final && absolute.compareTo(boundary.end) <= 0))) {
      return boundary;
    }
  }
  return null;
}

function clampFraction(value: Fraction, minimum: Fraction, maximum: Fraction): Fraction {
  if (value.compareTo(minimum) < 0) return minimum;
  if (value.compareTo(maximum) > 0) return maximum;
  return value;
}

interface WrittenDuration {
  value: Fraction;
  beats: number;
  beams: number;
  dot: number;
}

const WRITTEN_DURATIONS: readonly WrittenDuration[] = [
  { value: new Fraction(4), beats: 4, beams: 0, dot: 0 },
  { value: new Fraction(3), beats: 3, beams: 0, dot: 0 },
  { value: new Fraction(2), beats: 2, beams: 0, dot: 0 },
  { value: new Fraction(3, 2), beats: 1, beams: 0, dot: 1 },
  { value: new Fraction(1), beats: 1, beams: 0, dot: 0 },
  { value: new Fraction(3, 4), beats: 1, beams: 1, dot: 1 },
  { value: new Fraction(1, 2), beats: 1, beams: 1, dot: 0 },
  { value: new Fraction(3, 8), beats: 1, beams: 2, dot: 1 },
  { value: new Fraction(1, 4), beats: 1, beams: 2, dot: 0 },
  { value: new Fraction(3, 16), beats: 1, beams: 3, dot: 1 },
  { value: new Fraction(1, 8), beats: 1, beams: 3, dot: 0 },
  { value: new Fraction(3, 32), beats: 1, beams: 4, dot: 1 },
  { value: new Fraction(1, 16), beats: 1, beams: 4, dot: 0 },
];

function splitWrittenDuration(duration: Fraction): Fraction[] {
  const result: Fraction[] = [];
  let remaining = duration;
  for (const written of WRITTEN_DURATIONS) {
    while (remaining.compareTo(written.value) >= 0) {
      result.push(written.value);
      remaining = remaining.minus(written.value);
    }
  }
  // Triplet-derived material can leave a non-binary tail. Preserve its exact
  // playback length even though its visual fallback uses the nearest beam.
  if (remaining.compareTo(ZERO) > 0) result.push(remaining);
  return result;
}

function setWrittenDuration(chord: Chord, duration: Fraction): void {
  const exact = WRITTEN_DURATIONS.find((item) => item.value.equals(duration));
  chord.duration = duration;
  chord.beamGroup = null;
  if (exact) {
    chord.beats = exact.beats;
    chord.beams = exact.beams;
    chord.dot = exact.dot;
    return;
  }
  const value = Math.max(MIN_DURATION.toFloat(), duration.toFloat());
  const beams = Math.max(0, Math.min(6, Math.round(Math.log2(1 / value))));
  chord.beats = 1;
  chord.beams = beams;
  chord.dot = 0;
}

function cloneNote(source: Note, chord: Chord): Note {
  const note = new Note(chord);
  note.softDeleted = source.softDeleted;
  note.pitch = source.pitch;
  note.step = source.step;
  note.alter = source.alter;
  note.octave = source.octave;
  note.rest = source.rest;
  note.jpOctave = source.jpOctave;
  note.jpAlter = source.jpAlter;
  note.number = source.number;
  return note;
}

function continuationOf(source: Chord, measure: Measure): Chord {
  const chord = new Chord(measure);
  chord.generatedTimingContinuation = true;
  chord.transparentContinuation = !source.rest;
  chord.voice = source.voice;
  chord.stemUp = source.stemUp;
  chord.rest = source.rest;
  for (const note of source.notes) chord.add(cloneNote(note, chord));
  return chord;
}

function linkTie(left: Chord, right: Chord): void {
  for (const next of right.notes) {
    if (next.rest) continue;
    const previous = left.notes.find((note) => !note.rest && note.pitch === next.pitch);
    if (!previous) continue;
    previous.tieStart = true;
    previous.tieNext = next;
    next.tieEnd = true;
    next.tiePrev = previous;
  }
}

function sortMeasureEntries(measure: Measure): void {
  measure.entries.sort((left, right) => {
    const position = left.position.compareTo(right.position);
    if (position !== 0) return position;
    if (left instanceof Chord && !(right instanceof Chord)) return -1;
    if (!(left instanceof Chord) && right instanceof Chord) return 1;
    return 0;
  });
}

function moveChord(
  snapshot: ChordSnapshot,
  target: Fraction,
  boundaries: readonly MeasureBoundary[],
): void {
  const destination = boundaryAt(boundaries, target);
  if (!destination) return;
  const oldMeasure = snapshot.chord.measure;
  if (oldMeasure !== destination.measure) {
    oldMeasure.entries = oldMeasure.entries.filter((entry) => entry !== snapshot.chord);
    destination.measure.entries.push(snapshot.chord);
    snapshot.chord.measure = destination.measure;
  }
  snapshot.chord.position = target.minus(destination.start);
}

function applyDuration(
  snapshot: ChordSnapshot,
  duration: Fraction,
  boundaries: readonly MeasureBoundary[],
): void {
  const chord = snapshot.chord;
  const start = chord.measure.position.plus(chord.position);
  const originalNext = chord.notes.map((note) => note.tieNext);
  const originalTieStart = chord.notes.map((note) => note.tieStart);
  const pieces: Array<{ measure: Measure; position: Fraction; duration: Fraction }> = [];
  let cursor = start;
  let remaining = duration;
  while (remaining.compareTo(ZERO) > 0) {
    const boundary = boundaryAt(boundaries, cursor);
    if (!boundary) break;
    const available = boundary.end.minus(cursor);
    if (available.compareTo(ZERO) <= 0) break;
    const insideMeasure = remaining.compareTo(available) <= 0 ? remaining : available;
    for (const value of splitWrittenDuration(insideMeasure)) {
      pieces.push({
        measure: boundary.measure,
        position: cursor.minus(boundary.start),
        duration: value,
      });
      cursor = cursor.plus(value);
      remaining = remaining.minus(value);
    }
  }
  if (pieces.length === 0) return;

  const chain: Chord[] = [chord];
  chord.measure = pieces[0].measure;
  chord.position = pieces[0].position;
  if (!chord.measure.entries.includes(chord)) chord.measure.entries.push(chord);
  setWrittenDuration(chord, pieces[0].duration);
  for (const piece of pieces.slice(1)) {
    const continuation = continuationOf(chord, piece.measure);
    continuation.position = piece.position;
    setWrittenDuration(continuation, piece.duration);
    piece.measure.entries.push(continuation);
    chain.push(continuation);
  }

  if (chain.length > 1 && !chord.rest) {
    for (let index = 0; index < chain.length - 1; index++) {
      linkTie(chain[index], chain[index + 1]);
    }
    const last = chain[chain.length - 1];
    last.notes.forEach((note, noteIndex) => {
      const next = originalNext[noteIndex];
      if (!next) return;
      note.tieStart = true;
      note.tieNext = next;
      next.tieEnd = true;
      next.tiePrev = note;
    });
  } else {
    chord.notes.forEach((note, index) => {
      note.tieStart = originalTieStart[index];
      note.tieNext = originalNext[index];
    });
  }
}

/**
 * Apply persisted edits after parsing. The original source chord remains the
 * first rendered segment, so score selection continues to map to its text.
 */
export function applyNoteTimingEdits(
  score: Score,
  rawEdits: readonly NoteTimingEditData[],
  mode: NoteTimingSourceMode,
): void {
  const edits = normalizeNoteTimingEdits(rawEdits);
  score.noteTimingEdits = edits;
  if (edits.length === 0) return;

  const boundariesByPart = score.parts.map(boundariesOf);
  const snapshots: ChordSnapshot[] = score.parts.flatMap((part, partIndex) =>
    editableTimingChords(part, mode).map((chord, chordIndex) => {
      chord.timingSourceIndex = chordIndex;
      chord.timingOriginal = {
        measureIndex: chord.measure.index,
        position: chord.position,
        beats: chord.beats,
        beams: chord.beams,
        dot: chord.dot,
        tieStart: chord.notes[0]?.tieStart ?? false,
        tieEnd: chord.notes[0]?.tieEnd ?? false,
      };
      return {
        chord,
        part,
        partIndex,
        chordIndex,
        start: chord.measure.position.plus(chord.position),
        duration: chord.duration ?? MIN_DURATION,
      };
    }));
  const editByKey = new Map(edits.map((edit) => [
    noteTimingEditKey(edit.part, edit.chord),
    edit,
  ]));

  for (const snapshot of snapshots) {
    const edit = editByKey.get(noteTimingEditKey(snapshot.partIndex, snapshot.chordIndex));
    if (!edit) continue;
    const boundaries = boundariesByPart[snapshot.partIndex];
    const first = boundaries[0]?.start;
    const end = boundaries[boundaries.length - 1]?.end;
    if (!first || !end) continue;
    const move = Fraction.fromString(edit.move);
    const latest = end.minus(MIN_DURATION);
    const target = clampFraction(snapshot.start.plus(move), first, latest);
    moveChord(snapshot, target, boundaries);
  }

  for (const snapshot of snapshots) {
    const edit = editByKey.get(noteTimingEditKey(snapshot.partIndex, snapshot.chordIndex));
    if (!edit || edit.duration === "0") continue;
    const boundaries = boundariesByPart[snapshot.partIndex];
    const end = boundaries[boundaries.length - 1]?.end;
    if (!end) continue;
    const start = snapshot.chord.measure.position.plus(snapshot.chord.position);
    const requested = snapshot.duration.plus(Fraction.fromString(edit.duration));
    const maximum = end.minus(start);
    const duration = clampFraction(requested, MIN_DURATION, maximum);
    applyDuration(snapshot, duration, boundaries);
  }

  for (const part of score.parts) {
    for (const measure of part.measures) sortMeasureEntries(measure);
  }
}
