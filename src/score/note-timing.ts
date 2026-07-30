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
    && (mode === "jpw" || !entry.rest)));
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
  alignment: Fraction;
  beats: number;
  beams: number;
  dot: number;
}

const WRITTEN_DURATIONS: readonly WrittenDuration[] = [
  { value: new Fraction(4), alignment: new Fraction(4), beats: 4, beams: 0, dot: 0 },
  { value: new Fraction(3), alignment: new Fraction(1), beats: 2, beams: 0, dot: 1 },
  { value: new Fraction(2), alignment: new Fraction(1), beats: 2, beams: 0, dot: 0 },
  // Every exact quarter-note beat is a valid onset for a dotted quarter.
  // This lets a quarter plus its tied eighth continuation use one written
  // value instead of leaving an unnecessary gray continuation.
  { value: new Fraction(3, 2), alignment: new Fraction(1), beats: 1, beams: 0, dot: 1 },
  { value: new Fraction(1), alignment: new Fraction(1), beats: 1, beams: 0, dot: 0 },
  { value: new Fraction(3, 4), alignment: new Fraction(1), beats: 1, beams: 1, dot: 1 },
  { value: new Fraction(1, 2), alignment: new Fraction(1, 2), beats: 1, beams: 1, dot: 0 },
  { value: new Fraction(3, 8), alignment: new Fraction(1, 2), beats: 1, beams: 2, dot: 1 },
  { value: new Fraction(1, 4), alignment: new Fraction(1, 4), beats: 1, beams: 2, dot: 0 },
  { value: new Fraction(3, 16), alignment: new Fraction(1, 4), beats: 1, beams: 3, dot: 1 },
  { value: new Fraction(1, 8), alignment: new Fraction(1, 8), beats: 1, beams: 3, dot: 0 },
  { value: new Fraction(3, 32), alignment: new Fraction(1, 8), beats: 1, beams: 4, dot: 1 },
  { value: new Fraction(1, 16), alignment: new Fraction(1, 16), beats: 1, beams: 4, dot: 0 },
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
  note.displayText = source.displayText;
  note.displayOctave = source.displayOctave;
  note.displayAlter = source.displayAlter;
  note.displayHidden = source.displayHidden;
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
  const used = new Set<Note>();
  for (const next of right.notes) {
    if (next.rest) continue;
    const previous = left.notes.find((note) =>
      !note.rest && note.pitch === next.pitch && !used.has(note));
    if (!previous) continue;
    used.add(previous);
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

export interface NoteTimelineSelection {
  partIndex: number;
  note: Note;
  grace?: boolean;
}

export interface NoteTimelineMoveResult {
  changed: number;
  blocked: number;
}

export interface NoteTimelineMoveOptions {
  /**
   * JPW editing keeps silence explicit: moving right leaves a rest at the
   * vacated onset. Moving left may compress the preceding sound and merge at
   * the target grid point, provided the moved tone keeps its complete written
   * duration without overlapping the next retained attack.
   */
  preserveRests?: boolean;
}

export interface NoteDurationExtendResult {
  changed: number;
  blocked: number;
}

export interface NoteSegmentResizeResult {
  changed: number;
  blocked: number;
}

function isPureTieContinuation(chord: Chord): boolean {
  if (chord.generatedTimingContinuation || chord.transparentContinuation) return true;
  const sounding = chord.notes.filter((note) => !note.rest);
  return sounding.length > 0
    && chord.graceNotes.length === 0
    && !chord.arpeggio
    && sounding.every((note) => note.tieEnd && note.tiePrev !== null);
}

function removeChordIfEmpty(chord: Chord): void {
  if (chord.notes.some((note) => !note.rest) || chord.graceNotes.length > 0) return;
  chord.measure.entries = chord.measure.entries.filter((entry) => entry !== chord);
}

function detachMovedTieChain(note: Note): void {
  if (note.tiePrev) {
    note.tiePrev.tieNext = null;
    note.tiePrev.tieStart = false;
  }
  let cursor = note.tieNext;
  note.tiePrev = null;
  note.tieNext = null;
  note.tieStart = false;
  note.tieEnd = false;
  const visited = new Set<Note>();
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const next = cursor.tieNext;
    const chord = cursor.chord;
    chord.notes = chord.notes.filter((candidate) => candidate !== cursor);
    cursor.tiePrev = null;
    cursor.tieNext = null;
    cursor.tieStart = false;
    cursor.tieEnd = false;
    removeChordIfEmpty(chord);
    cursor = next;
  }
}

function makeTimelineRest(measure: Measure): Chord {
  const chord = new Chord(measure);
  chord.rest = true;
  const note = new Note(chord);
  note.rest = true;
  note.number = "0";
  note.pitch = 0;
  note.jpAlter = " ";
  chord.add(note);
  return chord;
}

function resetAttackNotation(chord: Chord): void {
  chord.generatedTimingContinuation = false;
  chord.transparentContinuation = false;
  chord.timingOriginal = null;
  chord.timingSourceIndex = null;
  chord.beamGroup = null;
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

function mergeTimelineAttacks(left: Chord, right: Chord): Chord {
  const leftSounding = left.notes.some((note) => !note.rest);
  const rightSounding = right.notes.some((note) => !note.rest);
  const target = leftSounding || !rightSounding ? left : right;
  const source = target === left ? right : left;
  if (source.notes.some((note) => !note.rest)) {
    target.notes = target.notes.filter((note) => !note.rest);
    target.rest = false;
  }
  const pitches = new Set(target.notes.filter((note) => !note.rest).map((note) => note.pitch));
  for (const note of source.notes) {
    if (note.rest && target.notes.some((candidate) => !candidate.rest)) continue;
    if (!note.rest && pitches.has(note.pitch)) continue;
    target.add(note);
    if (!note.rest) pitches.add(note.pitch);
  }
  for (const grace of source.graceNotes) {
    if (!target.graceNotes.some((note) => note.pitch === grace.pitch)) {
      grace.chord = target;
      target.graceNotes.push(grace);
    }
  }
  target.arpeggio = target.arpeggio || source.arpeggio;
  if (target.arpeggio || source.arpeggio) {
    const values = new Set([
      ...(target.arpeggioPitches ?? []),
      ...(source.arpeggioPitches ?? []),
    ]);
    target.arpeggioPitches = values.size > 0 ? [...values].sort((a, b) => a - b) : null;
  }
  target.slurStart = target.slurStart || source.slurStart;
  target.slurEnd = target.slurEnd || source.slurEnd;
  return target;
}

function existingTieSegmentDurations(chord: Chord): Fraction[] {
  const result: Fraction[] = [];
  const visited = new Set<Chord>();
  let cursor: Chord | null = chord;
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    if (cursor.duration && cursor.duration.compareTo(ZERO) > 0) {
      result.push(cursor.duration);
    }
    if (cursor.rest) break;
    const next: Chord | null =
      cursor.notes.find((note) => !note.rest)?.tieNext?.chord ?? null;
    if (!next || !isPureTieContinuation(next)) break;
    cursor = next;
  }
  return result;
}

function isMetricallyAligned(position: Fraction, alignment: Fraction): boolean {
  return position.div(alignment).denominator === 1;
}

function measureBeatDuration(measure: Measure): Fraction {
  const compound = measure.time.beatType === 8
    && measure.time.beats >= 6
    && measure.time.beats % 3 === 0;
  return compound
    ? new Fraction(3, 2)
    : new Fraction(4, measure.time.beatType);
}

function remainingInBeat(position: Fraction, beatDuration: Fraction): Fraction {
  const beat = Math.floor(position.div(beatDuration).toFloat() + 1e-10);
  return beatDuration.timesInt(beat + 1).minus(position);
}

function canWriteWithoutTie(
  written: WrittenDuration,
  position: Fraction,
  beatDuration: Fraction,
): boolean {
  // A regular half/whole/dotted value may span beats when it begins on its
  // natural metric boundary. Inside one beat, however, its onset need not be
  // aligned to its own note value: two sixteenths beginning on the second
  // sixteenth are still one eighth, and three are one dotted eighth. Split
  // only when the sound actually crosses the next beat boundary.
  return isMetricallyAligned(position, written.alignment)
    || written.value.compareTo(remainingInBeat(position, beatDuration)) <= 0;
}

/**
 * Spell a duration from its new metric position. A value that was readable at
 * the old onset can become misleading after an arrow-key move (for example a
 * dotted eighth beginning on the final sixteenth of a beat). In that case the
 * duration is split at the next rhythmic boundary and tied.
 */
function splitMetricalWrittenDuration(
  duration: Fraction,
  start: Fraction,
  beatDuration = new Fraction(1),
): Fraction[] {
  const result: Fraction[] = [];
  let position = start;
  let remaining = duration;
  let guard = 0;
  while (remaining.compareTo(ZERO) > 0 && guard++ < 1024) {
    const written = WRITTEN_DURATIONS.find((candidate) => {
      const leavesShortTail =
        candidate.value.equals(new Fraction(3, 2))
        && remaining.compareTo(new Fraction(3, 2)) > 0
        && remaining.compareTo(new Fraction(2)) < 0;
      return !leavesShortTail
        && candidate.value.compareTo(remaining) <= 0
        && canWriteWithoutTie(candidate, position, beatDuration);
    });
    const value = written?.value
      ?? (remaining.compareTo(MIN_DURATION) < 0 ? remaining : MIN_DURATION);
    result.push(value);
    position = position.plus(value);
    remaining = remaining.minus(value);
  }
  return result;
}

function splitWithPreferredSegments(
  duration: Fraction,
  preferred: Fraction[],
  start: Fraction,
  beatDuration: Fraction,
): Fraction[] {
  // Binary source segments are only a record of how the old text happened to
  // spell the sound. After moving an attack, re-spell their combined length
  // canonically: two tied sixteenths inside one beat become one eighth, and
  // beat-aligned two-/four-quarter spans become a half/whole note. Preserve
  // preferred pieces only for non-binary (for example triplet-derived) values
  // that the ordinary written-duration table cannot express exactly.
  const hasNonBinaryPreferred = preferred.some((value) =>
    !WRITTEN_DURATIONS.some((candidate) => candidate.value.equals(value)));
  if (!hasNonBinaryPreferred) {
    return splitMetricalWrittenDuration(duration, start, beatDuration);
  }

  const result: Fraction[] = [];
  let position = start;
  let remaining = duration;
  while (remaining.compareTo(ZERO) > 0) {
    const next = preferred[0];
    const written = next
      ? WRITTEN_DURATIONS.find((candidate) => candidate.value.equals(next))
      : undefined;
    if (next
      && next.compareTo(remaining) <= 0
      && (!written || canWriteWithoutTie(written, position, beatDuration))) {
      result.push(next);
      remaining = remaining.minus(next);
      position = position.plus(next);
      preferred.shift();
      continue;
    }
    const [piece] = splitMetricalWrittenDuration(remaining, position, beatDuration);
    if (!piece) break;
    result.push(piece);
    remaining = remaining.minus(piece);
    position = position.plus(piece);
    if (next) {
      if (piece.compareTo(next) < 0) preferred[0] = next.minus(piece);
      else preferred.shift();
    }
  }
  return result;
}

function rebuildPartTimeline(part: Part, boundaries: readonly MeasureBoundary[]): void {
  if (boundaries.length === 0) return;
  const attacks = part.measures.flatMap((measure) =>
    measure.entries
      .filter((entry): entry is Chord =>
        entry instanceof Chord
        && entry.notes.length > 0
        && !isPureTieContinuation(entry))
      .map((chord) => ({
        chord,
        start: measure.position.plus(chord.position),
        preferredDurations: existingTieSegmentDurations(chord),
      })));

  const firstStart = boundaries[0].start;
  const scoreEnd = boundaries[boundaries.length - 1].end;
  if (attacks.length === 0 || attacks.every(({ start }) => start.compareTo(firstStart) > 0)) {
    const rest = makeTimelineRest(boundaries[0].measure);
    rest.position = new Fraction(0);
    attacks.push({ chord: rest, start: firstStart, preferredDurations: [] });
  }

  attacks.sort((left, right) => left.start.compareTo(right.start));
  const grouped: Array<{
    chord: Chord;
    start: Fraction;
    preferredDurations: Fraction[];
  }> = [];
  for (const attack of attacks) {
    const previous = grouped[grouped.length - 1];
    if (previous && previous.start.equals(attack.start)) {
      const merged = mergeTimelineAttacks(previous.chord, attack.chord);
      if (merged === attack.chord) {
        previous.preferredDurations = attack.preferredDurations;
      }
      previous.chord = merged;
    } else {
      grouped.push({
        ...attack,
        preferredDurations: [...attack.preferredDurations],
      });
    }
  }

  for (const measure of part.measures) {
    measure.entries = measure.entries.filter((entry) => !(entry instanceof Chord));
  }

  grouped.forEach(({ chord, start, preferredDurations }, index) => {
    const end = grouped[index + 1]?.start ?? scoreEnd;
    if (end.compareTo(start) <= 0) return;
    resetAttackNotation(chord);
    const chain: Chord[] = [];
    let cursor = start;
    let remaining = end.minus(start);
    let firstPiece = true;

    while (remaining.compareTo(ZERO) > 0) {
      const boundary = boundaryAt(boundaries, cursor);
      if (!boundary) break;
      const available = boundary.end.minus(cursor);
      if (available.compareTo(ZERO) <= 0) break;
      const insideMeasure = remaining.compareTo(available) <= 0 ? remaining : available;
      const written = splitWithPreferredSegments(
        insideMeasure,
        preferredDurations,
        cursor.minus(boundary.start),
        measureBeatDuration(boundary.measure),
      );
      for (const duration of written) {
        const piece = firstPiece ? chord : continuationOf(chord, boundary.measure);
        firstPiece = false;
        piece.measure = boundary.measure;
        piece.position = cursor.minus(boundary.start);
        setWrittenDuration(piece, duration);
        // This rebuild is a committed notation rewrite, not the temporary
        // NoteTimingEdits overlay.  Keep every split rest/tie segment in the
        // JPW serializer so moving one attack cannot erase continuation
        // numbers or shorten the bar when the document is reparsed.
        piece.generatedTimingContinuation = false;
        boundary.measure.entries.push(piece);
        chain.push(piece);
        cursor = cursor.plus(duration);
        remaining = remaining.minus(duration);
      }
    }

    if (!chord.rest) {
      for (let piece = 0; piece + 1 < chain.length; piece++) {
        linkTie(chain[piece], chain[piece + 1]);
      }
    }
  });

  for (const boundary of boundaries) {
    boundary.measure.timingMinimumDuration = boundary.end.minus(boundary.start);
    sortMeasureEntries(boundary.measure);
  }
}

function isPlainMergeableRest(chord: Chord): boolean {
  return isRestChord(chord)
    && chord.graceNotes.length === 0
    && !chord.arpeggio
    && !chord.fermata
    && !chord.slurStart
    && !chord.slurEnd
    && chord.notes.every((note) =>
      !note.tupletBegin
      && !note.tupletEnd
      && !note.tieStart
      && !note.tieEnd);
}

/**
 * Combine adjacent ordinary JPW rests only inside one notated beat. For
 * example, two consecutive sixteenth rests become one eighth rest, while a
 * third sixteenth beginning on the next beat remains separate. Existing long
 * rests that already cross beats are left unchanged.
 */
function normalizePartRestSpelling(part: Part): void {
  for (const measure of part.measures) {
    const beatDuration = measureBeatDuration(measure);
    const chords = measure.entries
      .filter((entry): entry is Chord => entry instanceof Chord)
      .sort((left, right) => left.position.compareTo(right.position));
    const removed = new Set<Chord>();
    let index = 0;
    while (index < chords.length) {
      const first = chords[index];
      const firstDuration = first.duration;
      if (!firstDuration
        || firstDuration.compareTo(ZERO) <= 0
        || !isPlainMergeableRest(first)) {
        index++;
        continue;
      }
      const beatIndex = Math.floor(
        first.position.div(beatDuration).toFloat() + 1e-10,
      );
      const beatEnd = beatDuration.timesInt(beatIndex + 1);
      let end = first.position.plus(firstDuration);
      if (end.compareTo(beatEnd) > 0) {
        index++;
        continue;
      }

      const run = [first];
      let cursor = index + 1;
      while (cursor < chords.length) {
        const next = chords[cursor];
        const nextDuration = next.duration;
        if (!nextDuration
          || !isPlainMergeableRest(next)
          || !next.position.equals(end)) break;
        const nextEnd = next.position.plus(nextDuration);
        if (nextEnd.compareTo(beatEnd) > 0) break;
        run.push(next);
        end = nextEnd;
        cursor++;
      }

      if (run.length > 1) {
        const pieces = splitMetricalWrittenDuration(
          end.minus(first.position),
          first.position,
          beatDuration,
        );
        if (pieces.length < run.length) {
          let position = first.position;
          pieces.forEach((duration, pieceIndex) => {
            const target = run[pieceIndex];
            target.position = position;
            setWrittenDuration(target, duration);
            position = position.plus(duration);
          });
          for (let runIndex = pieces.length; runIndex < run.length; runIndex++) {
            removed.add(run[runIndex]);
          }
        }
      }
      index = cursor;
    }
    if (removed.size > 0) {
      measure.entries = measure.entries.filter((entry) =>
        !(entry instanceof Chord && removed.has(entry)));
      sortMeasureEntries(measure);
    }
  }
}

/**
 * Canonicalize JPW rhythmic spelling after import. Parenthesized repeated
 * pitches may have been serialized as one tiny segment per grid cell; keep
 * the same audible span, but merge every portion contained within a beat into
 * an eighth/dotted/long value and retain ties only at required beat or bar
 * boundaries. Adjacent rests use the same beat-local grouping rule.
 */
export function normalizeScoreRhythmicSpelling(score: Score): void {
  for (const part of score.parts) {
    const hasSemanticTie = part.measures.some((measure) =>
      measure.entries.some((entry) =>
        entry instanceof Chord
        && entry.notes.some((note) => note.tieStart || note.tieEnd)));
    if (hasSemanticTie) {
      const originalNoteOrder = new Map<Chord, Note[]>();
      for (const measure of part.measures) {
        for (const entry of measure.entries) {
          if (entry instanceof Chord) originalNoteOrder.set(entry, [...entry.notes]);
        }
      }
      rebuildPartTimeline(part, boundariesOf(part));
      for (const measure of part.measures) {
        for (const entry of measure.entries) {
          if (!(entry instanceof Chord)) continue;
          const original = originalNoteOrder.get(entry);
          if (!original) continue;
          const order = new Map(original.map((note, index) => [note, index]));
          entry.notes.sort((left, right) =>
            (order.get(left) ?? Number.MAX_SAFE_INTEGER)
            - (order.get(right) ?? Number.MAX_SAFE_INTEGER));
        }
      }
    }
    normalizePartRestSpelling(part);
  }
}

/**
 * Move only the selected sounding tones by one rhythmic step, then rebuild
 * each affected monophonic part on the original fixed bar timeline. A tone
 * landing on an existing attack becomes part of that vertical chord; vacated
 * spans are absorbed by the preceding event and bar-crossing spans are tied.
 */
export function moveScoreNotesOnTimeline(
  score: Score,
  rawSelections: readonly NoteTimelineSelection[],
  delta: Fraction,
  options: NoteTimelineMoveOptions = {},
): NoteTimelineMoveResult {
  if (delta.equals(0)) return { changed: 0, blocked: 0 };
  const selections = [...new Map(rawSelections.map((selection) => [
    selection.note,
    selection,
  ])).values()];
  const selectedNotes = new Set(selections.map((selection) => selection.note));
  const boundariesByPart = score.parts.map(boundariesOf);
  const moves: Array<{
    partIndex: number;
    note: Note;
    source: Chord;
    sourceStart: Fraction;
    sourceDuration: Fraction;
    duration: Fraction;
    target: Fraction;
  }> = [];
  let blocked = 0;

  for (const selection of selections) {
    if (selection.grace || selection.note.rest) {
      blocked++;
      continue;
    }
    const part = score.parts[selection.partIndex];
    const boundaries = boundariesByPart[selection.partIndex];
    if (!part || boundaries.length === 0 || !selection.note.chord.notes.includes(selection.note)) {
      blocked++;
      continue;
    }
    const start = selection.note.absoluteTick;
    const target = start.plus(delta);
    const first = boundaries[0].start;
    const end = boundaries[boundaries.length - 1].end;
    if (target.compareTo(first) < 0 || target.compareTo(end) >= 0) {
      blocked++;
      continue;
    }
    const sourceDuration = selection.note.chord.duration ?? MIN_DURATION;
    let duration = sourceDuration;
    if (options.preserveRests && delta.compareTo(ZERO) < 0) {
      const source = selection.note.chord;
      const sourceWillRemain = source.notes.some((note) =>
        !note.rest && !selectedNotes.has(note));
      // A tone that previously moved into a longer vertical chord must be
      // able to move back out at the currently selected grid value. Keep the
      // unselected chord at its existing duration, but give the detached tone
      // exactly one left-move step instead of inheriting the whole chord.
      if (sourceWillRemain) duration = delta.timesInt(-1);
      const attacks = part.measures.flatMap((measure) =>
        measure.entries
          .filter((entry): entry is Chord =>
            entry instanceof Chord
            && entry.notes.length > 0
            && !isPureTieContinuation(entry))
          .map((chord) => ({
            chord,
            start: measure.position.plus(chord.position),
          })))
        .sort((left, right) => left.start.compareTo(right.start));
      const nextBoundary = attacks.find(({ chord, start: attackStart }) =>
        attackStart.compareTo(target) > 0
        && (chord !== source || sourceWillRemain));
      // The moved tone keeps its written duration. It may compress the
      // preceding sound and merge at `target`, but it must not overlap the
      // next attack that remains in this monophonic row.
      if (nextBoundary && target.plus(duration).compareTo(nextBoundary.start) > 0) {
        blocked++;
        continue;
      }
    }
    moves.push({
      partIndex: selection.partIndex,
      note: selection.note,
      source: selection.note.chord,
      sourceStart: start,
      sourceDuration,
      duration,
      target,
    });
  }

  const affected = new Set<number>();
  for (const move of moves) {
    detachMovedTieChain(move.note);
    move.source.notes = move.source.notes.filter((note) => note !== move.note);
    if (move.source.arpeggioPitches) {
      move.source.arpeggioPitches = move.source.arpeggioPitches
        .filter((pitch) => pitch !== move.note.pitch);
      if (move.source.arpeggioPitches.length < 2) {
        move.source.arpeggio = false;
        move.source.arpeggioPitches = null;
      }
    }
    removeChordIfEmpty(move.source);
    affected.add(move.partIndex);
  }

  for (const move of moves) {
    const part = score.parts[move.partIndex];
    const boundaries = boundariesByPart[move.partIndex];
    const destination = boundaryAt(boundaries, move.target);
    if (!part || !destination) continue;
    let target = destination.measure.entries.find((entry): entry is Chord =>
      entry instanceof Chord
      && !isPureTieContinuation(entry)
      && destination.measure.position.plus(entry.position).equals(move.target));
    if (!target) {
      target = new Chord(destination.measure);
      target.position = move.target.minus(destination.start);
      target.voice = move.source.voice;
      target.stemUp = move.source.stemUp;
      destination.measure.entries.push(target);
    }
    if (target.notes.some((note) => note.rest)) {
      target.notes = target.notes.filter((note) => !note.rest);
      target.rest = false;
    }
    const existing = target.notes.find((note) => !note.rest && note.pitch === move.note.pitch);
    if (!existing) {
      move.note.chord = target;
      target.add(move.note);
    }
    if (options.preserveRests && delta.compareTo(ZERO) < 0) {
      // A left-moved tone defines the duration of the chord it joins.
      setWrittenDuration(target, move.duration);
    }
    if (!move.source.notes.some((note) => !note.rest)
      && move.source.graceNotes.length > 0) {
      for (const grace of move.source.graceNotes) {
        grace.chord = target;
        target.graceNotes.push(grace);
      }
      move.source.graceNotes = [];
    }
    if (!move.source.notes.some((note) => !note.rest) && move.source.arpeggio) {
      target.arpeggio = true;
      target.arpeggioPitches = move.source.arpeggioPitches
        ? [...move.source.arpeggioPitches]
        : null;
      move.source.arpeggio = false;
      move.source.arpeggioPitches = null;
    }
    removeChordIfEmpty(move.source);
  }

  if (options.preserveRests && delta.compareTo(ZERO) < 0) {
    const requestedBoundaries = new Map<string, {
      partIndex: number;
      at: Fraction;
    }>();
    for (const move of moves) {
      const movedEnd = move.target.plus(move.duration);
      requestedBoundaries.set(`${move.partIndex}:${movedEnd}`, {
        partIndex: move.partIndex,
        at: movedEnd,
      });
      // If this was one tone of a chord, the tones left behind keep the
      // chord's current duration when the selected tone moves again.
      if (move.source.notes.some((note) => !note.rest)) {
        const retainedEnd = move.sourceStart.plus(move.sourceDuration);
        requestedBoundaries.set(`${move.partIndex}:${retainedEnd}`, {
          partIndex: move.partIndex,
          at: retainedEnd,
        });
      }
    }
    for (const { partIndex, at } of requestedBoundaries.values()) {
      const boundaries = boundariesByPart[partIndex];
      const destination = boundaryAt(boundaries, at);
      if (!destination || at.equals(boundaries[boundaries.length - 1].end)) continue;
      const alreadyOccupied = destination.measure.entries.some((entry) =>
        entry instanceof Chord
        && !isPureTieContinuation(entry)
        && destination.measure.position.plus(entry.position).equals(at));
      if (alreadyOccupied) continue;
      const rest = makeTimelineRest(destination.measure);
      rest.position = at.minus(destination.start);
      destination.measure.entries.push(rest);
    }
  }

  if (options.preserveRests && delta.compareTo(ZERO) > 0) {
    const vacated = new Map<Chord, { partIndex: number; start: Fraction }>();
    for (const move of moves) {
      if (move.source.notes.some((note) => !note.rest)
        || move.source.graceNotes.length > 0) continue;
      vacated.set(move.source, {
        partIndex: move.partIndex,
        start: move.source.measure.position.plus(move.source.position),
      });
    }
    for (const { partIndex, start } of vacated.values()) {
      const boundaries = boundariesByPart[partIndex];
      const destination = boundaryAt(boundaries, start);
      if (!destination) continue;
      const alreadyOccupied = destination.measure.entries.some((entry) =>
        entry instanceof Chord
        && !isPureTieContinuation(entry)
        && destination.measure.position.plus(entry.position).equals(start));
      if (alreadyOccupied) continue;
      const rest = makeTimelineRest(destination.measure);
      rest.position = start.minus(destination.start);
      destination.measure.entries.push(rest);
    }
  }

  for (const partIndex of affected) {
    rebuildPartTimeline(score.parts[partIndex], boundariesByPart[partIndex]);
  }
  if (moves.length > 0) score.noteTimingEdits = [];
  return { changed: moves.length, blocked };
}

/**
 * Extend selected JPW attacks only by consuming an immediately following
 * rest. The rest onset moves right by `amount`; rebuilding the fixed timeline
 * lengthens the preceding sound and shortens/removes that rest without
 * overlapping the next sounding attack.
 */
export function extendScoreNotesIntoFollowingRests(
  score: Score,
  rawSelections: readonly NoteTimelineSelection[],
  amount: Fraction,
): NoteDurationExtendResult {
  if (amount.compareTo(ZERO) <= 0) return { changed: 0, blocked: 0 };
  const selections = [...new Map(rawSelections.map((selection) => {
    let root = selection.note;
    const visited = new Set<Note>();
    while (root.tiePrev && !visited.has(root)) {
      visited.add(root);
      root = root.tiePrev;
    }
    return [root.chord, { ...selection, note: root }] as const;
  })).values()];
  const boundariesByPart = score.parts.map(boundariesOf);
  const restMoves: Array<{
    partIndex: number;
    rest: Chord;
    target: Fraction;
  }> = [];
  let blocked = 0;

  for (const selection of selections) {
    if (selection.grace || selection.note.rest) {
      blocked++;
      continue;
    }
    const part = score.parts[selection.partIndex];
    const boundaries = boundariesByPart[selection.partIndex];
    if (!part || boundaries.length === 0) {
      blocked++;
      continue;
    }
    const scoreEnd = boundaries[boundaries.length - 1].end;
    const attacks = part.measures.flatMap((measure) =>
      measure.entries
        .filter((entry): entry is Chord =>
          entry instanceof Chord
          && entry.notes.length > 0
          && !isPureTieContinuation(entry))
        .map((chord) => ({
          chord,
          start: measure.position.plus(chord.position),
        })))
      .sort((left, right) => left.start.compareTo(right.start));
    const selectedIndex = attacks.findIndex(({ chord }) => chord === selection.note.chord);
    const following = attacks[selectedIndex + 1];
    if (selectedIndex < 0
      || !following
      || (!following.chord.rest
        && following.chord.notes.some((note) => !note.rest))) {
      blocked++;
      continue;
    }
    const nextStart = attacks[selectedIndex + 2]?.start ?? scoreEnd;
    const target = following.start.plus(amount);
    if (target.compareTo(nextStart) > 0 || target.compareTo(scoreEnd) > 0) {
      blocked++;
      continue;
    }
    restMoves.push({
      partIndex: selection.partIndex,
      rest: following.chord,
      target,
    });
  }

  const affected = new Set<number>();
  for (const move of restMoves) {
    const boundaries = boundariesByPart[move.partIndex];
    const destination = boundaryAt(boundaries, move.target);
    if (!destination) {
      blocked++;
      continue;
    }
    if (move.rest.measure !== destination.measure) {
      move.rest.measure.entries = move.rest.measure.entries
        .filter((entry) => entry !== move.rest);
      destination.measure.entries.push(move.rest);
      move.rest.measure = destination.measure;
    }
    move.rest.position = move.target.minus(destination.start);
    affected.add(move.partIndex);
  }

  for (const partIndex of affected) {
    rebuildPartTimeline(score.parts[partIndex], boundariesByPart[partIndex]);
  }
  if (restMoves.length > 0) score.noteTimingEdits = [];
  return { changed: restMoves.length, blocked };
}

function isRestChord(chord: Chord): boolean {
  return chord.rest || chord.notes.every((note) => note.rest);
}

function unlinkOutgoingTie(chord: Chord): void {
  const affected = new Set<Chord>();
  for (const note of chord.notes) {
    const next = note.tieNext;
    if (!next) continue;
    affected.add(next.chord);
    note.tieNext = null;
    note.tieStart = false;
    next.tiePrev = null;
    next.tieEnd = false;
  }
  for (const next of affected) {
    if (next.notes.every((note) => note.rest || note.tiePrev === null)) {
      next.transparentContinuation = false;
      next.generatedTimingContinuation = false;
    }
  }
}

function rewriteOneChordDuration(
  chord: Chord,
  duration: Fraction,
  boundaries: readonly MeasureBoundary[],
): boolean {
  const start = chord.measure.position.plus(chord.position);
  const pieces: Array<{
    measure: Measure;
    position: Fraction;
    duration: Fraction;
  }> = [];
  let cursor = start;
  let remaining = duration;
  while (remaining.compareTo(ZERO) > 0) {
    const boundary = boundaryAt(boundaries, cursor);
    if (!boundary) return false;
    const available = boundary.end.minus(cursor);
    if (available.compareTo(ZERO) <= 0) return false;
    const inside = remaining.compareTo(available) <= 0 ? remaining : available;
    for (const value of splitMetricalWrittenDuration(
      inside,
      cursor.minus(boundary.start),
      measureBeatDuration(boundary.measure),
    )) {
      pieces.push({
        measure: boundary.measure,
        position: cursor.minus(boundary.start),
        duration: value,
      });
      cursor = cursor.plus(value);
      remaining = remaining.minus(value);
    }
  }
  if (pieces.length === 0) return false;

  const originalTransparent = chord.transparentContinuation;
  const chain: Chord[] = [];
  pieces.forEach((piece, index) => {
    const target = index === 0 ? chord : continuationOf(chord, piece.measure);
    if (target.measure !== piece.measure) {
      target.measure.entries = target.measure.entries.filter((entry) => entry !== target);
      piece.measure.entries.push(target);
      target.measure = piece.measure;
    } else if (!piece.measure.entries.includes(target)) {
      piece.measure.entries.push(target);
    }
    target.position = piece.position;
    target.generatedTimingContinuation = false;
    target.transparentContinuation = index === 0
      ? originalTransparent
      : !target.rest;
    setWrittenDuration(target, piece.duration);
    chain.push(target);
  });
  for (let index = 0; index + 1 < chain.length; index++) {
    linkTie(chain[index], chain[index + 1]);
  }
  return true;
}

function outgoingTieChord(chord: Chord): Chord | null {
  for (const note of chord.notes) {
    if (!note.rest && note.tieNext) return note.tieNext.chord;
  }
  return null;
}

function tieChainFrom(chord: Chord): Chord[] {
  const result: Chord[] = [];
  const visited = new Set<Chord>();
  let cursor: Chord | null = chord;
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    result.push(cursor);
    const next = outgoingTieChord(cursor);
    if (!next || !isPureTieContinuation(next)) break;
    cursor = next;
  }
  return result;
}

function removeTieContinuation(chord: Chord): void {
  for (const note of chord.notes) {
    const previous = note.tiePrev;
    const next = note.tieNext;
    if (previous) {
      previous.tieNext = null;
      previous.tieStart = false;
    }
    if (next) {
      next.tiePrev = null;
      next.tieEnd = false;
    }
    note.tiePrev = null;
    note.tieNext = null;
    note.tieStart = false;
    note.tieEnd = false;
  }
  chord.measure.entries = chord.measure.entries.filter((entry) => entry !== chord);
}

/**
 * Shorten a selected tied sound from the audible end. When the selected root
 * has a continuation, Ctrl+Left removes/shortens that gray tail first instead
 * of detaching it and leaving a new black attack at the old position.
 */
function shrinkTieChainFrom(
  chord: Chord,
  amount: Fraction,
  boundaries: readonly MeasureBoundary[],
): Fraction | null {
  const chain = tieChainFrom(chord);
  const total = chain.reduce(
    (sum, piece) => sum.plus(piece.duration ?? ZERO),
    ZERO,
  );
  if (total.compareTo(amount) <= 0) return null;

  let remaining = amount;
  while (remaining.compareTo(ZERO) > 0) {
    const tail = chain[chain.length - 1];
    const duration = tail?.duration;
    if (!tail || !duration || duration.compareTo(ZERO) <= 0) return null;
    if (duration.compareTo(remaining) <= 0) {
      if (tail === chord) return null;
      remaining = remaining.minus(duration);
      chain.pop();
      removeTieContinuation(tail);
      continue;
    }
    const shortened = duration.minus(remaining);
    unlinkOutgoingTie(tail);
    if (!rewriteOneChordDuration(tail, shortened, boundaries)) return null;
    remaining = ZERO;
  }

  const rewrittenChain = tieChainFrom(chord);
  const last = rewrittenChain[rewrittenChain.length - 1];
  const lastDuration = last?.duration;
  if (!last || !lastDuration) return null;
  return last.measure.position.plus(last.position).plus(lastDuration);
}

/**
 * Resize exactly the written chord segment selected on the JPW page.
 *
 * Extending consumes an immediately following rest. If the selected attack
 * already has a written tie chain, extension is delegated to its final gray
 * continuation so the original black segment remains unchanged. Shrinking
 * inserts a rest into the released span. Other written tie segments retain
 * their positions and durations; a segment after the new rest becomes a
 * fresh black attack because a sounding tie cannot cross silence.
 */
export function resizeScoreNoteSegmentsWithRests(
  score: Score,
  rawSelections: readonly NoteTimelineSelection[],
  delta: Fraction,
): NoteSegmentResizeResult {
  if (delta.equals(0)) return { changed: 0, blocked: 0 };
  const extending = delta.compareTo(ZERO) > 0;
  const selections = [...new Map(rawSelections.map((selection) => {
    let note = selection.note;
    if (extending && !selection.grace && !note.rest) {
      const visited = new Set<Note>();
      while (note.tieNext && !visited.has(note)) {
        visited.add(note);
        const next = note.tieNext;
        if (!isPureTieContinuation(next.chord)) break;
        note = next;
      }
    }
    const delegated = note === selection.note
      ? selection
      : { ...selection, note };
    return [note.chord, delegated] as const;
  })).values()];
  const boundariesByPart = score.parts.map(boundariesOf);
  const amount = delta.compareTo(ZERO) < 0 ? delta.timesInt(-1) : delta;
  let changed = 0;
  let blocked = 0;

  for (const selection of selections) {
    if (selection.grace || selection.note.rest) {
      blocked++;
      continue;
    }
    const part = score.parts[selection.partIndex];
    const boundaries = boundariesByPart[selection.partIndex];
    const chord = selection.note.chord;
    const duration = chord.duration;
    if (!part || boundaries.length === 0 || !duration
      || !part.measures.some((measure) => measure.entries.includes(chord))) {
      blocked++;
      continue;
    }
    const start = chord.measure.position.plus(chord.position);
    const end = start.plus(duration);

    if (delta.compareTo(ZERO) > 0) {
      const following = part.measures
        .flatMap((measure) => measure.entries)
        .find((entry): entry is Chord =>
          entry instanceof Chord
          && isRestChord(entry)
          && entry.measure.position.plus(entry.position).equals(end));
      const restDuration = following?.duration;
      if (!following || !restDuration || restDuration.compareTo(amount) < 0
        || chord.notes.some((note) => note.tieNext !== null)) {
        blocked++;
        continue;
      }

      const restRemaining = restDuration.minus(amount);
      const restStart = end.plus(amount);
      if (restRemaining.compareTo(ZERO) <= 0) {
        following.measure.entries = following.measure.entries
          .filter((entry) => entry !== following);
      } else {
        const restBoundary = boundaryAt(boundaries, restStart);
        if (!restBoundary) {
          blocked++;
          continue;
        }
        if (following.measure !== restBoundary.measure) {
          following.measure.entries = following.measure.entries
            .filter((entry) => entry !== following);
          restBoundary.measure.entries.push(following);
          following.measure = restBoundary.measure;
        }
        following.position = restStart.minus(restBoundary.start);
        setWrittenDuration(following, restRemaining);
        following.generatedTimingContinuation = false;
      }
      if (!rewriteOneChordDuration(chord, duration.plus(amount), boundaries)) {
        blocked++;
        continue;
      }
      changed++;
      continue;
    }

    const chain = tieChainFrom(chord);
    const hasOutgoingContinuation = chain.length > 1;
    let restStart: Fraction;
    if (hasOutgoingContinuation) {
      const shortenedEnd = shrinkTieChainFrom(chord, amount, boundaries);
      if (!shortenedEnd) {
        blocked++;
        continue;
      }
      restStart = shortenedEnd;
    } else {
      if (duration.compareTo(amount) <= 0) {
        blocked++;
        continue;
      }
      const shortened = duration.minus(amount);
      restStart = start.plus(shortened);
      unlinkOutgoingTie(chord);
      if (!rewriteOneChordDuration(chord, shortened, boundaries)) {
        blocked++;
        continue;
      }
    }
    const restBoundary = boundaryAt(boundaries, restStart);
    if (!restBoundary) {
      blocked++;
      continue;
    }
    const rest = makeTimelineRest(restBoundary.measure);
    rest.position = restStart.minus(restBoundary.start);
    rest.generatedTimingContinuation = false;
    setWrittenDuration(rest, amount);
    restBoundary.measure.entries.push(rest);
    changed++;
  }

  if (changed > 0) {
    score.noteTimingEdits = [];
    for (const part of score.parts) {
      for (const measure of part.measures) sortMeasureEntries(measure);
    }
  }
  return { changed, blocked };
}
