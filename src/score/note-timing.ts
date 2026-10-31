import { Fraction } from "../common/fraction";
import { AccidentalStat, Chord, CrossPartArpeggio, Measure, Note, type Part, type Score, type Tuplet } from "./score";
import { chordArpeggioNoteGroups, chordArpeggioPitchGroups, setChordArpeggioPitchGroups } from "./arpeggio";
import { spellPitch } from "./musicxml-export";

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
   * the target grid point. When that grid point already contains an attack,
   * the moved tone adopts the target attack's duration.
   */
  preserveRests?: boolean;
  /** Move the complete sounding tie chain as one logical attack. */
  moveWholeTieChain?: boolean;
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

/** A rest is one rhythmic event, never a vertical chord. Older move paths
 * could merge two rests with the same onset by appending both zero Notes;
 * JPW then serialized that as `[00]`. Keep exactly one canonical zero while
 * retaining the Chord's rhythmic and layout properties. */
function collapseRestNotes(chord: Chord): void {
  if (!chord.rest && chord.notes.some((note) => !note.rest)) return;
  let note = chord.notes.find((candidate) => candidate.rest);
  if (!note) {
    note = new Note(chord);
    note.rest = true;
    note.number = "0";
    note.pitch = 0;
    note.jpAlter = " ";
  }
  note.chord = chord;
  note.rest = true;
  note.number = "0";
  chord.notes = [note];
  chord.rest = true;
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
  const arpeggioGroups = [...chordArpeggioPitchGroups(left), ...chordArpeggioPitchGroups(right)];
  const target = leftSounding || !rightSounding ? left : right;
  const source = target === left ? right : left;
  const mergeOrdinaryRestOnset = !leftSounding && !rightSounding
    && [...left.notes, ...right.notes].every((note) =>
      note.tuplet === null && !note.tupletBegin && !note.tupletEnd);
  if (mergeOrdinaryRestOnset) {
    // Two silence boundaries may legitimately meet after a fine-grid Alt
    // move (the relocated note's trailing rest reaches the next beat rest).
    // They describe one rest onset, not a two-note zero chord.
    collapseRestNotes(target);
  }
  if (source.notes.some((note) => !note.rest)) {
    target.notes = target.notes.filter((note) => !note.rest);
    target.rest = false;
  }
  const pitches = new Set(target.notes.filter((note) => !note.rest).map((note) => note.pitch));
  for (const note of mergeOrdinaryRestOnset ? [] : source.notes) {
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
  setChordArpeggioPitchGroups(target, arpeggioGroups);
  target.slurStart = target.slurStart || source.slurStart;
  target.slurEnd = target.slurEnd || source.slurEnd;
  return target;
}

/** Return the first attack and the written duration of its complete tie chain. */
function tieChainRootAndDuration(note: Note): { root: Note; duration: Fraction } {
  let root = note;
  const visited = new Set<Note>();
  while (root.tiePrev && !visited.has(root)) {
    visited.add(root);
    root = root.tiePrev;
  }
  let duration = ZERO;
  let cursor: Note | null = root;
  visited.clear();
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    duration = duration.plus(cursor.chord.duration ?? MIN_DURATION);
    cursor = cursor.tieNext;
  }
  return { root, duration };
}

/**
 * Collapse equal pitches inside one vertical chord after an interactive move
 * has been committed. During selection we deliberately keep duplicates (for
 * example moving 3 onto [35] temporarily produces [335]); deselection calls
 * this helper to return the score to its canonical [35] spelling.
 */
export function mergeDuplicateChordPitches(score: Score): number {
  let removed = 0;
  for (const part of score.parts) {
    for (const measure of part.measures) {
      for (const entry of [...measure.entries]) {
        if (!(entry instanceof Chord) || entry.rest || isPureTieContinuation(entry)) continue;
        const firstByPitch = new Map<number, Note>();
        for (const note of [...entry.notes]) {
          if (note.rest) continue;
          const first = firstByPitch.get(note.pitch);
          if (!first) {
            firstByPitch.set(note.pitch, note);
            continue;
          }
          for (const lyric of note.lyrics) {
            if (!first.lyrics.some((candidate) =>
              candidate.number === lyric.number && candidate.text === lyric.text)) {
              first.lyrics.push(lyric);
            }
          }
          detachMovedTieChain(note);
          entry.notes = entry.notes.filter((candidate) => candidate !== note);
          removed++;
        }
        setChordArpeggioPitchGroups(entry, chordArpeggioPitchGroups(entry));
        removeChordIfEmpty(entry);
      }
    }
  }
  return removed;
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

/** Structural arrow-key edits bake the live timeline. Once the JSON timing
 * overlay is cleared, no Chord may keep its pre-overlay serialization
 * snapshot or JPW output can silently restore the old duration. */
function clearStructuralTimingSnapshots(score: Score): void {
  for (const part of score.parts) {
    for (const measure of part.measures) {
      for (const entry of measure.entries) {
        if (!(entry instanceof Chord)) continue;
        entry.timingOriginal = null;
        entry.timingSourceIndex = null;
      }
    }
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
      note.tuplet === null
      && !note.tupletBegin
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
    for (const entry of measure.entries) {
      if (entry instanceof Chord && isPlainMergeableRest(entry)) collapseRestNotes(entry);
    }
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

/** Canonicalize only ordinary rests, without rebuilding sounding tie chains.
 * This is safe for compact TXT scores whose independent voices and tuplets
 * have already been reconstructed by the slash-score parser. */
export function normalizeScoreRestSpelling(score: Score): void {
  for (const part of score.parts) normalizePartRestSpelling(part);
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
    // Tuplet members live on a compressed real timeline. `rebuildPartTimeline`
    // rewrites the *whole part*, not only the semantic tie that triggered it;
    // allowing it to run when any Tuplet is present therefore feeds an actual
    // value such as 1/6 into the ordinary binary speller. It is then drawn as
    // a 32nd and compressed by 3:2 again on the next JPW parse, so every input
    // appears to halve the group and shorten the bar. Keep the complete part
    // verbatim whenever it contains a Tuplet. The interactive Tuplet editor
    // and JPW parser already provide canonical member/tie spelling.
    const hasTuplet = part.measures.some((measure) =>
      measure.entries.some((entry) =>
        entry instanceof Chord
        && entry.notes.some((note) => note.tuplet !== null
          || note.tupletBegin
          || note.tupletEnd)));
    if (hasSemanticTie && !hasTuplet && !partNeedsExplicitNoteTies(part)) {
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
  }
  normalizeScoreRestSpelling(score);
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
  const selections = [...new Map(rawSelections.map((selection) => {
    if (!options.moveWholeTieChain || selection.grace || selection.note.rest) {
      return [selection.note, selection] as const;
    }
    const chain = tieChainRootAndDuration(selection.note);
    return [chain.root, { ...selection, note: chain.root } as NoteTimelineSelection] as const;
  })).values()];
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
    wholeTieChain: boolean;
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
    const sourceDuration = options.moveWholeTieChain
      ? tieChainRootAndDuration(selection.note).duration
      : selection.note.chord.duration ?? MIN_DURATION;
    let duration = sourceDuration;
    if (options.moveWholeTieChain) {
      // A whole tie chain keeps its total sounding span. Do not shorten it to
      // the destination attack or to the one-step gap used by single-tone
      // chord moves.
      const nextAttack = part.measures.flatMap((measure) => measure.entries)
        .filter((entry): entry is Chord => entry instanceof Chord
          && entry.notes.some((note) => !note.rest)
          && !isPureTieContinuation(entry)
          && entry !== selection.note.chord
          && entry.measure.position.plus(entry.position).compareTo(target) > 0)
        .map((entry) => entry.measure.position.plus(entry.position))
        .sort((left, right) => left.compareTo(right))[0];
      if (nextAttack && target.plus(duration).compareTo(nextAttack) > 0) {
        blocked++;
        continue;
      }
    } else if (options.preserveRests && delta.compareTo(ZERO) < 0) {
      const source = selection.note.chord;
      const sourceWillRemain = source.notes.some((note) =>
        !note.rest && !selectedNotes.has(note));
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
      const targetIndex = attacks.findIndex(({ start: attackStart }) =>
        attackStart.equals(target));
      if (targetIndex >= 0) {
        // Joining an occupied rhythmic column adopts that column's existing
        // span. Its next attack can be the source chord that is about to be
        // vacated; the explicit boundary inserted below preserves the value.
        const targetEnd = attacks.slice(targetIndex + 1).find(({ start: attackStart }) =>
          attackStart.compareTo(target) > 0)?.start ?? end;
        duration = targetEnd.minus(target);
      } else if (sourceWillRemain) {
        // Detaching one tone from a chord into an empty grid column uses the
        // active movement step and leaves the other chord tones unchanged.
        duration = delta.timesInt(-1);
      } else {
        // An empty target may sit closer to a retained attack than the old
        // written value. Compress to the available span instead of blocking.
        const nextBoundary = attacks.find(({ chord, start: attackStart }) =>
          attackStart.compareTo(target) > 0 && chord !== source);
        if (nextBoundary) {
          const available = nextBoundary.start.minus(target);
          if (available.compareTo(duration) < 0) duration = available;
        }
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
      wholeTieChain: Boolean(options.moveWholeTieChain),
    });
  }

  const movingArpeggios = new Map(moves.map(move => [move.source, chordArpeggioNoteGroups(move.source)]));
  const affected = new Set<number>();
  for (const move of moves) {
    detachMovedTieChain(move.note);
    move.source.notes = move.source.notes.filter((note) => note !== move.note);
    setChordArpeggioPitchGroups(move.source, chordArpeggioPitchGroups(move.source));
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
    // Keep equal pitches as distinct selected tones until the selection is
    // released. This makes 3 moved onto [35] visibly become [335] and lets a
    // following arrow key move that selected tone back out again.
    move.note.chord = target;
    target.add(move.note);
    if (move.wholeTieChain) {
      // The old continuation chords were removed by detachMovedTieChain().
      // Re-split the captured total duration at the destination so barline
      // crossings recreate transparent segments and a continuous tie chain.
      rewriteOneChordDuration(target, move.duration, boundaries);
      // Explicit rests that overlap the relocated logical attack would make
      // rebuildPartTimeline truncate the newly rebuilt continuation chain.
      // Consume only the intersecting span: a left move can land in the
      // second half of a voice-owned rest, and deleting that whole rest loses
      // the untouched first half (TXT then has to invent an unvoiced `0`).
      const chainStart = move.target;
      const chainEnd = move.target.plus(move.duration);
      const overlappingRests = part.measures.flatMap((measure) =>
        measure.entries.filter((entry): entry is Chord => {
          if (!(entry instanceof Chord) || !isRestChord(entry)) return false;
          const start = measure.position.plus(entry.position);
          const end = start.plus(entry.duration ?? ZERO);
          return end.compareTo(chainStart) > 0 && start.compareTo(chainEnd) < 0;
        }));
      for (const rest of overlappingRests) {
        const restStart = rest.measure.position.plus(rest.position);
        const restEnd = restStart.plus(rest.duration ?? ZERO);
        rest.measure.entries = rest.measure.entries.filter((entry) => entry !== rest);
        const fragments: Array<{ start: Fraction; duration: Fraction }> = [];
        if (restStart.compareTo(chainStart) < 0) {
          fragments.push({ start: restStart, duration: chainStart.minus(restStart) });
        }
        if (restEnd.compareTo(chainEnd) > 0) {
          fragments.push({ start: chainEnd, duration: restEnd.minus(chainEnd) });
        }
        fragments.forEach((fragment, index) => {
          const boundary = boundaryAt(boundaries, fragment.start);
          if (!boundary || fragment.duration.compareTo(ZERO) <= 0) return;
          const targetRest = index === 0 ? rest : makeTimelineRest(boundary.measure);
          targetRest.measure = boundary.measure;
          targetRest.position = fragment.start.minus(boundary.start);
          targetRest.generatedTimingContinuation = false;
          targetRest.transparentContinuation = false;
          collapseRestNotes(targetRest);
          rewriteOneChordDuration(targetRest, fragment.duration, boundaries);
        });
      }
      const scoreEnd = boundaries[boundaries.length - 1]?.end;
      if (scoreEnd && chainEnd.compareTo(scoreEnd) < 0) {
        const restBoundary = boundaryAt(boundaries, chainEnd);
        if (restBoundary) {
          const rest = makeTimelineRest(restBoundary.measure);
          rest.position = chainEnd.minus(restBoundary.start);
          rest.duration = scoreEnd.minus(chainEnd);
          restBoundary.measure.entries.push(rest);
        }
      }
    } else if (options.preserveRests && delta.compareTo(ZERO) < 0) {
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

    removeChordIfEmpty(move.source);
  }

  for (const [source, groups] of movingArpeggios) for (const group of groups) {
    const byChord = new Map<Chord, number[]>();
    for (const note of group) {
      if (note.chord === source || !note.chord.notes.includes(note)) continue;
      const pitches = byChord.get(note.chord) ?? [];
      pitches.push(note.pitch);
      byChord.set(note.chord, pitches);
    }
    for (const [chord, pitches] of byChord) if (pitches.length >= 2)
      setChordArpeggioPitchGroups(chord, [...chordArpeggioPitchGroups(chord), pitches]);
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
    const part = score.parts[partIndex];
    rebuildPartTimeline(part, boundariesByPart[partIndex]);
    // A fine right move can release one 32nd rest immediately after an
    // existing 32nd rest.  The rebuilt timeline is rhythmically correct but
    // still contains two adjacent rest attacks, so compact TXT writes `00`
    // instead of the canonical one-cell `0.` spelling.  Fuse only within the
    // current notated beat, using the same rule as duration edits/deletion.
    normalizePartRestSpelling(part);
  }
  if (moves.length > 0) {
    score.noteTimingEdits = [];
    clearStructuralTimingSnapshots(score);
  }
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
      const allEntries = part.measures.flatMap((measure) => measure.entries);
      const consumed: Array<{
        rest: Chord;
        start: Fraction;
        duration: Fraction;
        amount: Fraction;
      }> = [];
      let restCursor = end;
      let amountRemaining = amount;
      while (amountRemaining.compareTo(ZERO) > 0) {
        const following = allEntries.find((entry): entry is Chord =>
          entry instanceof Chord
          && isPlainMergeableRest(entry)
          && entry.measure.position.plus(entry.position).equals(restCursor));
        const restDuration = following?.duration;
        if (!following || !restDuration || restDuration.compareTo(ZERO) <= 0) break;
        const used = restDuration.compareTo(amountRemaining) < 0
          ? restDuration
          : amountRemaining;
        consumed.push({ rest: following, start: restCursor, duration: restDuration, amount: used });
        restCursor = restCursor.plus(used);
        amountRemaining = amountRemaining.minus(used);
        if (used.compareTo(restDuration) < 0) break;
      }
      if (amountRemaining.compareTo(ZERO) > 0
        || chord.notes.some((note) => note.tieNext !== null)) {
        blocked++;
        continue;
      }

      if (!rewriteOneChordDuration(chord, duration.plus(amount), boundaries)) {
        blocked++;
        continue;
      }
      for (const item of consumed) {
        const restRemaining = item.duration.minus(item.amount);
        if (restRemaining.compareTo(ZERO) <= 0) {
          item.rest.measure.entries = item.rest.measure.entries
            .filter((entry) => entry !== item.rest);
          continue;
        }
        const restStart = item.start.plus(item.amount);
        const restBoundary = boundaryAt(boundaries, restStart);
        if (!restBoundary) continue;
        if (item.rest.measure !== restBoundary.measure) {
          item.rest.measure.entries = item.rest.measure.entries
            .filter((entry) => entry !== item.rest);
          restBoundary.measure.entries.push(item.rest);
          item.rest.measure = restBoundary.measure;
        }
        item.rest.position = restStart.minus(restBoundary.start);
        collapseRestNotes(item.rest);
        // Fine extensions commonly leave 7/8 or 15/16 of a quarter beat.
        // Neither is one JPW duration token.  Reuse the metrical rewriter so
        // the remainder becomes exact binary/dotted rest pieces instead of a
        // guessed quarter rest that changes the bar on save/reparse.
        if (!rewriteOneChordDuration(item.rest, restRemaining, boundaries)) {
          blocked++;
          continue;
        }
        item.rest.generatedTimingContinuation = false;
      }
      normalizePartRestSpelling(part);
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
    // Repeated fine-grid shrinking releases one short rest at a time. Merge
    // those adjacent pieces immediately inside the beat, just as the extend
    // path normalizes the remainder it leaves behind. Without this step a
    // 32nd + dotted-32nd tail reached TXT as several overlapping zero atoms,
    // eventually changing the bar length and preventing the inverse extend.
    normalizePartRestSpelling(part);
    changed++;
  }

  if (changed > 0) {
    score.noteTimingEdits = [];
    clearStructuralTimingSnapshots(score);
    for (const part of score.parts) {
      for (const measure of part.measures) sortMeasureEntries(measure);
    }
  }
  return { changed, blocked };
}

/** Ordinary JPW parentheses describe complete repeated chords. A partial
 * chord tie needs explicit note occurrences so an unselected tone cannot
 * inherit another member's duration when the text is opened again. */
export function partNeedsExplicitNoteTies(part: Part): boolean {
  return part.measures.some(measure => measure.entries.some(entry => {
    if (!(entry instanceof Chord)) return false;
    const tones = entry.notes.filter(note => !note.rest);
    return (['tiePrev', 'tieNext'] as const).some(direction => {
      const linked = tones.filter(note => note[direction] !== null);
      if (!linked.length) return false;
      const destination = linked[0][direction]!.chord;
      const others = destination.notes.filter(note => !note.rest);
      return linked.length !== tones.length || others.length !== tones.length
        || linked.some(note => note[direction]!.chord !== destination)
        // Rebuilding a repeated chord from one spelling would overwrite a
        // continuation's local degree across a key change on the next save.
        || linked.some(note => note.number !== note[direction]!.number
          || note.jpOctave !== note[direction]!.jpOctave
          || note.jpAlter !== note[direction]!.jpAlter)
        || new Set(linked.map(note => note[direction])).size !== others.length;
    });
  }));
}

export interface ExplicitNoteTieEndpoint {
  measure: number;
  offset: string;
  pitch: number;
  occurrence: number;
}
export interface ExplicitNoteTie {
  part: number;
  from: ExplicitNoteTieEndpoint;
  to: ExplicitNoteTieEndpoint;
}

export function noteTieAnnotations(score: Score): ExplicitNoteTie[] {
  const endpoint = (part: Part, note: Note): ExplicitNoteTieEndpoint => ({
    measure: part.measures.indexOf(note.chord.measure), offset: note.chord.position.toString(),
    pitch: note.pitch, occurrence: note.chord.notes.slice(0, note.chord.notes.indexOf(note))
      .filter(other => !other.rest && other.pitch === note.pitch).length,
  });
  return score.parts.flatMap((part, partIndex) => !partNeedsExplicitNoteTies(part) ? []
    : part.measures.flatMap(measure => measure.entries.flatMap(entry => !(entry instanceof Chord) ? []
      : entry.notes.flatMap(note => note.rest || !note.tieNext ? [] : [{
        part: partIndex, from: endpoint(part, note), to: endpoint(part, note.tieNext),
      }]))));
}

/** Restore only exact, contiguous, one-to-one endpoints. Unknown or stale
 * annotations are ignored; hand-written slur inference remains unchanged. */
export function applyExplicitNoteTies(score: Score, raw: unknown): void {
  if (!Array.isArray(raw) || raw.length === 0) return;
  const touched = new Set<Chord>();
  const endpoint = (part: Part, value: unknown): Note | null => {
    if (!value || typeof value !== 'object') return null;
    const item = value as Partial<ExplicitNoteTieEndpoint>;
    if (!Number.isInteger(item.measure) || item.measure! < 0
      || !Number.isInteger(item.pitch) || !Number.isInteger(item.occurrence) || item.occurrence! < 0) return null;
    const at = safeFraction(item.offset);
    if (!at || at.compareTo(ZERO) < 0) return null;
    const chord = part.measures[item.measure!]?.entries.find((entry): entry is Chord =>
      entry instanceof Chord && entry.position.equals(at));
    return chord?.notes.filter(note => !note.rest && note.pitch === item.pitch)[item.occurrence!] ?? null;
  };
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const item = value as Partial<ExplicitNoteTie>;
    if (!Number.isInteger(item.part) || item.part! < 0) continue;
    const part = score.parts[item.part!];
    if (!part) continue;
    const from = endpoint(part, item.from);
    const to = endpoint(part, item.to);
    if (!from || !to || from === to || from.pitch !== to.pitch || !from.chord.duration
      || !from.absoluteTick.plus(from.chord.duration).equals(to.absoluteTick)
      || (from.tieNext && from.tieNext !== to) || (to.tiePrev && to.tiePrev !== from)) continue;
    from.tieNext = to;
    from.tieStart = true;
    to.tiePrev = from;
    to.tieEnd = true;
    touched.add(from.chord);
    touched.add(to.chord);
  }
  for (const chord of touched)
    chord.transparentContinuation = !chord.rest && chord.notes.length > 0
      && chord.notes.every(note => !note.rest && note.tiePrev !== null);
}

/** Logical attacks, including repeated equal pitches as separate occurrences.
 * Used by timing edit transactions to verify every selected and unselected
 * onset/end after the actual document serializer/parser round trip. */
export function scoreNoteTimingFingerprint(score: Score): string {
  const values: Array<{ part: number; pitch: number; start: string; end: string }> = [];
  score.parts.forEach((part, partIndex) => {
    for (const measure of part.measures) for (const entry of measure.entries) {
      if (!(entry instanceof Chord)) continue;
      for (const note of entry.notes) {
        if (note.rest || note.softDeleted || note.tiePrev) continue;
        let tail = note;
        const seen = new Set<Note>();
        while (tail.tieNext && !seen.has(tail)) { seen.add(tail); tail = tail.tieNext; }
        values.push({ part: partIndex, pitch: note.pitch, start: note.absoluteTick.toString(),
          end: tail.absoluteTick.plus(tail.chord.duration ?? ZERO).toString() });
      }
    }
  });
  return JSON.stringify(values.sort((a, b) => a.part - b.part || a.pitch - b.pitch
    || Fraction.fromString(a.start).compareTo(Fraction.fromString(b.start))
    || Fraction.fromString(a.end).compareTo(Fraction.fromString(b.end))));
}

interface MemberTimingSpan {
  root: Note;
  members: Array<{ note: Note; spelling: Note; fifths: number; start: Fraction; end: Fraction }>;
  start: Fraction;
  end: Fraction;
  oldStart: Fraction;
  oldEnd: Fraction;
}
interface MemberTimingChord {
  chord: Chord;
  start: Fraction;
  end: Fraction;
  groups: Note[][];
}
interface MemberTimingPart {
  score: Score;
  part: Part;
  boundaries: MeasureBoundary[];
  spans: MemberTimingSpan[];
  chords: MemberTimingChord[];
  tuplets: Array<{ tuplet: Tuplet; start: Fraction; end: Fraction }>;
}
interface MemberTimingCell {
  boundary: MeasureBoundary;
  start: Fraction;
  end: Fraction;
  written: Fraction;
  tuplet: Tuplet | null;
  spans: MemberTimingSpan[];
}
export interface NoteMemberTimingResult {
  changed: number;
  /** An ordinary duration limit keeps this member unchanged, while the
   * remaining same-onset members may still be committed in one transaction. */
  skipped: number;
  blocked: number;
  reason?: 'boundary' | 'incompatible-target';
}

function memberTimingKeyAt(score: Score, measure: Measure, offset: Fraction): number {
  const marks = score.keyMarks.filter(mark => mark.measure < measure.index
    || mark.measure === measure.index && mark.offset.compareTo(offset) <= 0)
    .sort((a, b) => a.measure - b.measure || a.offset.compareTo(b.offset));
  return marks[marks.length - 1]?.fifths ?? measure.key.fifths;
}

function captureMemberTimingPart(score: Score, part: Part): MemberTimingPart {
  const chords = part.measures.flatMap(measure => measure.entries.flatMap(entry =>
    entry instanceof Chord && entry.duration && entry.duration.compareTo(ZERO) > 0 ? [{
      chord: entry, start: measure.position.plus(entry.position),
      end: measure.position.plus(entry.position).plus(entry.duration),
      groups: chordArpeggioNoteGroups(entry),
    }] : []));
  const spans: MemberTimingSpan[] = [];
  const seen = new Set<Note>();
  for (const { chord } of chords) for (const note of chord.notes) {
    if (note.rest || seen.has(note)) continue;
    const { root } = tieChainRootAndDuration(note);
    const members: MemberTimingSpan['members'] = [];
    let member: Note | null = root;
    while (member && !seen.has(member)) {
      seen.add(member);
      members.push({ note: member, spelling: cloneNote(member, member.chord),
        fifths: memberTimingKeyAt(score, member.chord.measure, member.chord.position), start: member.absoluteTick,
        end: member.absoluteTick.plus(member.chord.duration ?? ZERO) });
      member = member.tieNext;
    }
    if (!members.length) continue;
    const start = members[0].start;
    const end = members[members.length - 1].end;
    spans.push({ root, members, start, end, oldStart: start, oldEnd: end });
  }
  const tupletMap = new Map<Tuplet, { tuplet: Tuplet; start: Fraction; end: Fraction }>();
  for (const item of chords) for (const note of item.chord.notes) {
    if (!note.tuplet) continue;
    const existing = tupletMap.get(note.tuplet);
    if (!existing) tupletMap.set(note.tuplet, { tuplet: note.tuplet, start: item.start, end: item.end });
    else {
      if (item.start.compareTo(existing.start) < 0) existing.start = item.start;
      if (item.end.compareTo(existing.end) > 0) existing.end = item.end;
    }
  }
  return { score, part, boundaries: boundariesOf(part), spans, chords, tuplets: [...tupletMap.values()] };
}

/** Reusing a numbered spelling under a new tonic changes its sounding pitch.
 * Only changed keys need a fresh spelling; same-key enharmonics stay exact. */
function respellMemberTimingNote(note: Note, fromFifths: number, toFifths: number): void {
  if (fromFifths === toFifths) return;
  const canonical = new Note(note.chord);
  canonical.pitch = note.pitch;
  Object.assign(canonical, spellPitch(canonical, toFifths));
  canonical.init(toFifths, new AccidentalStat(toFifths));
  note.step = canonical.step; note.alter = canonical.alter; note.octave = canonical.octave;
  note.number = canonical.number; note.jpOctave = canonical.jpOctave; note.jpAlter = canonical.jpAlter;
  if (note.displayOctave !== null) note.displayOctave = note.jpOctave;
  if (note.displayAlter !== null) note.displayAlter = note.jpAlter;
}

function memberTimingNotation(state: MemberTimingPart, start: Fraction, end: Fraction) {
  const spans = new Map(state.spans.flatMap(span => span.members.map(member => [member.note, span] as const)));
  return state.chords.filter(item => item.start.compareTo(end) < 0 && item.end.compareTo(start) > 0).map(item => {
    const attacks = item.chord.notes.filter(note => !note.rest && !note.tiePrev)
      .map(note => spans.get(note)).filter((span): span is MemberTimingSpan => Boolean(span));
    const moved = attacks.length > 0 && attacks.every(span => !span.start.equals(span.oldStart))
      && attacks.every(span => span.start.equals(attacks[0].start));
    return { ...item, at: moved ? attacks[0].start : item.start };
  });
}

/** One written column cannot carry two distinct grace sequences or slur
 * starts/ends. Reject those collisions while every model object is untouched. */
function compatibleMemberTimingNotation(sources: ReturnType<typeof memberTimingNotation>): boolean {
  const groups = new Map<string, typeof sources>();
  for (const source of sources) {
    const group = groups.get(source.at.toString()) ?? [];
    group.push(source); groups.set(source.at.toString(), group);
  }
  return [...groups.values()].every(group => {
    if (group.filter(item => item.chord.graceNotes.length > 0).length > 1
      || group.filter(item => item.chord.slurStart).length > 1
      || group.filter(item => item.chord.slurEnd).length > 1) return false;
    const ornaments = new Map<string, string>();
    for (const { chord } of group) for (const ornament of chord.ornaments) {
      const value = JSON.stringify(ornament);
      if (ornaments.has(ornament.kind) && ornaments.get(ornament.kind) !== value) return false;
      ornaments.set(ornament.kind, value);
    }
    return true;
  });
}

function memberTimingDomain(state: MemberTimingPart, start: Fraction, end: Fraction): Tuplet | null | undefined {
  const overlapping = state.tuplets.filter(group => group.start.compareTo(end) < 0 && group.end.compareTo(start) > 0);
  if (!overlapping.length) return null;
  return overlapping.length === 1 && overlapping[0].start.compareTo(start) <= 0
    && overlapping[0].end.compareTo(end) >= 0 ? overlapping[0].tuplet : undefined;
}

/** Build the smallest affected interval, split at every original boundary
 * and changed member endpoint. Equal pitches remain separate span identities. */
function planMemberTimingCells(state: MemberTimingPart): {
  start: Fraction; end: Fraction; cells: MemberTimingCell[]; notation: ReturnType<typeof memberTimingNotation>;
} | null {
  const changed = state.spans.filter(span => !span.start.equals(span.oldStart) || !span.end.equals(span.oldEnd));
  if (!changed.length) return null;
  const endpoints = changed.flatMap(span => [span.start, span.end, span.oldStart, span.oldEnd])
    .sort((a, b) => a.compareTo(b));
  let start = endpoints[0];
  let end = endpoints[endpoints.length - 1];
  // A retained chord crossing the edge must be partitioned too, otherwise
  // two independent written columns would overlap after the edit.
  for (let pass = 0; pass < 2; pass++) for (const item of state.chords) {
    if (item.start.compareTo(end) >= 0 || item.end.compareTo(start) <= 0) continue;
    if (item.start.compareTo(start) < 0) start = item.start;
    if (item.end.compareTo(end) > 0) end = item.end;
  }
  const cuts = new Map<string, Fraction>([[start.toString(), start], [end.toString(), end]]);
  const cut = (value: Fraction): void => {
    if (value.compareTo(start) > 0 && value.compareTo(end) < 0) cuts.set(value.toString(), value);
  };
  for (const item of state.chords) { cut(item.start); cut(item.end); }
  for (const span of state.spans) { cut(span.start); cut(span.end); }
  for (const boundary of state.boundaries) { cut(boundary.start); cut(boundary.end); }
  for (const group of state.tuplets) { cut(group.start); cut(group.end); }
  const sorted = [...cuts.values()].sort((a, b) => a.compareTo(b));
  const cells: MemberTimingCell[] = [];
  for (let index = 0; index + 1 < sorted.length; index++) {
    const at = sorted[index];
    const until = sorted[index + 1];
    const boundary = boundaryAt(state.boundaries, at);
    const tuplet = memberTimingDomain(state, at, until);
    if (!boundary || until.compareTo(boundary.end) > 0 || tuplet === undefined) return null;
    const actual = until.minus(at);
    const written = tuplet ? tuplet.writtenMemberDuration(actual) : actual;
    const pieces = tuplet ? splitWrittenDuration(written)
      : splitMetricalWrittenDuration(written, at.minus(boundary.start), measureBeatDuration(boundary.measure));
    if (pieces.some(piece => !WRITTEN_DURATIONS.some(value => value.value.equals(piece)))) return null;
    const spans = state.spans.filter(span => span.start.compareTo(at) <= 0 && span.end.compareTo(until) >= 0);
    let cursor = at;
    for (const piece of pieces) {
      const pieceEnd = cursor.plus(tuplet ? tuplet.actualMemberDuration(piece) : piece);
      cells.push({ boundary, start: cursor, end: pieceEnd, written: piece, tuplet, spans });
      cursor = pieceEnd;
    }
    if (!cursor.equals(until)) return null;
  }
  const notation = memberTimingNotation(state, start, end);
  if (!compatibleMemberTimingNotation(notation)) return null;
  return { start, end, cells, notation };
}

function commitMemberTimingCells(state: MemberTimingPart,
  plan: NonNullable<ReturnType<typeof planMemberTimingCells>>): void {
  const removed = new Set(state.chords.filter(item => item.start.compareTo(plan.end) < 0
    && item.end.compareTo(plan.start) > 0).map(item => item.chord));
  const assigned = new Map<MemberTimingSpan, Array<{ note: Note; start: Fraction; end: Fraction }>>();
  const noteSpans = new Map<Note, MemberTimingSpan>();
  for (const span of state.spans) {
    assigned.set(span, span.members.filter(member => !removed.has(member.note.chord)));
    for (const member of span.members) noteSpans.set(member.note, span);
  }
  // Capture chord-level marks before root notes receive their new chords.
  // Marks stay with retained attack members; moving a complete attack carries
  // its marks to the new onset. Rolled subsets are assigned separately below.
  const notation = plan.notation;
  for (const measure of state.part.measures)
    measure.entries = measure.entries.filter(entry => !(entry instanceof Chord && removed.has(entry)));
  const newChords: Chord[] = [];
  const replacements = new Map<Chord, Chord>();
  const used = new Set<Note>();
  for (const cell of plan.cells) {
    const chord = new Chord(cell.boundary.measure);
    chord.position = cell.start.minus(cell.boundary.start);
    setWrittenDuration(chord, cell.written);
    chord.duration = cell.end.minus(cell.start);
    const sources = notation.filter(item => item.at.equals(cell.start));
    const source = sources[0];
    const context = source?.chord ?? state.chords.find(item => item.start.compareTo(cell.start) <= 0
      && item.end.compareTo(cell.start) > 0)?.chord;
    if (context) { chord.voice = context.voice; chord.stemUp = context.stemUp; }
    for (const item of sources) {
      if (item.chord.graceNotes.length) {
        const fromKey = memberTimingKeyAt(state.score, item.chord.measure, item.chord.position);
        chord.graceNotes = item.chord.graceNotes;
        for (const grace of chord.graceNotes) {
          respellMemberTimingNote(grace, fromKey, memberTimingKeyAt(state.score, chord.measure, chord.position));
          grace.chord = chord;
        }
      }
      chord.fermata ||= item.chord.fermata;
      for (const ornament of item.chord.ornaments)
        if (!chord.ornaments.some(existing => JSON.stringify(existing) === JSON.stringify(ornament)))
          chord.ornaments.push({ ...ornament });
      chord.slurStart ||= item.chord.slurStart;
      chord.slurEnd ||= item.chord.slurEnd;
      if (item.chord.slurEndChord) chord.slurEndChord = item.chord.slurEndChord;
      replacements.set(item.chord, chord);
    }
    for (const span of cell.spans) {
      const old = span.members.find(member => member.start.equals(cell.start));
      const reusable = cell.start.equals(span.start) ? span.root : old?.note;
      const spelling = span.members.find(member => member.start.compareTo(cell.start) <= 0
        && member.end.compareTo(cell.start) > 0) ?? span.members[0];
      const note = reusable && !used.has(reusable) ? reusable : cloneNote(spelling.spelling, chord);
      const fromKey = reusable === span.root ? span.members[0].fifths : old?.fifths ?? spelling.fifths;
      respellMemberTimingNote(note, fromKey, memberTimingKeyAt(state.score, chord.measure, chord.position));
      used.add(note);
      note.tuplet = cell.tuplet;
      note.tupletBegin = false;
      note.tupletEnd = false;
      chord.add(note);
      assigned.get(span)!.push({ note, start: cell.start, end: cell.end });
    }
    if (!chord.notes.length) {
      chord.rest = true;
      const rest = new Note(chord);
      rest.rest = true;
      rest.number = '0';
      rest.tuplet = cell.tuplet;
      chord.add(rest);
    }
    chord.measure.entries.push(chord);
    newChords.push(chord);
  }
  for (const [span, members] of assigned) {
    if (!span.members.some(member => removed.has(member.note.chord))
      && !members.some(member => used.has(member.note))) continue;
    members.sort((a, b) => a.start.compareTo(b.start));
    for (const member of span.members) {
      member.note.tiePrev = null; member.note.tieNext = null;
      member.note.tieStart = false; member.note.tieEnd = false;
    }
    for (let index = 0; index < members.length; index++) {
      const member = members[index];
      member.note.tiePrev = null; member.note.tieNext = null;
      member.note.tieStart = false; member.note.tieEnd = false;
      const previous = members[index - 1];
      if (previous && previous.end.equals(member.start)) {
        previous.note.tieNext = member.note; previous.note.tieStart = true;
        member.note.tiePrev = previous.note; member.note.tieEnd = true;
      }
    }
  }
  for (const item of state.chords) for (const group of item.groups) {
    if (!removed.has(item.chord)) continue;
    const byChord = new Map<Chord, number[]>();
    for (const note of group) {
      const span = noteSpans.get(note);
      const attack = span && assigned.get(span)?.find(member => member.start.equals(span.start))?.note;
      if (!attack) continue;
      const values = byChord.get(attack.chord) ?? [];
      values.push(attack.pitch);
      byChord.set(attack.chord, values);
    }
    for (const [chord, pitches] of byChord) if (pitches.length >= 2)
      setChordArpeggioPitchGroups(chord, [...chordArpeggioPitchGroups(chord), pitches]);
  }
  for (const chord of newChords)
    chord.transparentContinuation = !chord.rest && chord.notes.every(note => note.tiePrev !== null);
  for (const measure of state.part.measures) {
    sortMeasureEntries(measure);
    for (const entry of measure.entries) if (entry instanceof Chord && entry.slurEndChord)
      entry.slurEndChord = replacements.get(entry.slurEndChord) ?? entry.slurEndChord;
  }
  for (const { tuplet } of state.tuplets) {
    const members = state.part.measures.flatMap(measure => measure.entries.filter((entry): entry is Chord =>
      entry instanceof Chord && entry.notes.some(note => note.tuplet === tuplet)));
    if (!members.length) continue;
    for (const chord of members) for (const note of chord.notes) {
      note.tupletBegin = false; note.tupletEnd = false;
    }
    const first = members[0]; const last = members[members.length - 1];
    tuplet.first = first.notes[0]; tuplet.last = last.notes[0];
    for (const note of first.notes) note.tupletBegin = true;
    for (const note of last.notes) note.tupletEnd = true;
    tuplet.refreshTiming();
  }
  normalizePartRestSpelling(state.part);
}

/** Exact same-onset note-member timing. Planning is atomic; ordinary duration
 * limits alone are skipped. Other attacks, equal-pitch occurrences and every
 * unselected note's original start/end remain independent of chord slicing. */
export function editSameOnsetNoteTimings(score: Score, selections: readonly NoteTimelineSelection[],
  operation: 'resize' | 'move', delta: Fraction, writtenDurationFor?: (note: Note) => Fraction): NoteMemberTimingResult {
  const fail = (reason: NonNullable<NoteMemberTimingResult['reason']>): NoteMemberTimingResult =>
    ({ changed: 0, skipped: 0, blocked: 1, reason });
  if (!selections.length || delta.equals(ZERO) && !writtenDurationFor) return { changed: 0, skipped: 0, blocked: 0 };
  const crossArpeggios = operation === 'move' ? captureCrossArpeggioMembers(score) : [];
  const states = new Map<number, MemberTimingPart>();
  const selected = new Map<Note, { state: MemberTimingPart; span: MemberTimingSpan }>();
  for (const selection of selections) {
    const part = score.parts[selection.partIndex];
    if (!part || selection.grace || selection.note.rest || !selection.note.chord.notes.includes(selection.note))
      return fail('incompatible-target');
    let state = states.get(selection.partIndex);
    if (!state) { state = captureMemberTimingPart(score, part); states.set(selection.partIndex, state); }
    const span = state.spans.find(item => item.members.some(member => member.note === selection.note));
    if (!span || !span.members.every((member, index) => member.note.pitch === span.root.pitch
      && member.end.compareTo(member.start) > 0
      && (index === 0 || span.members[index - 1].end.equals(member.start)))) return fail('incompatible-target');
    selected.set(span.root, { state, span });
  }
  const commonStart = [...selected.values()][0].span.start;
  if ([...selected.values()].some(({ span }) => !span.start.equals(commonStart))) return fail('incompatible-target');
  let changed = 0;
  let skipped = 0;
  let movement: Fraction | null = null;
  for (const { state, span } of selected.values()) {
    const first = state.boundaries[0]?.start;
    const end = state.boundaries[state.boundaries.length - 1]?.end;
    if (!first || !end) return fail('boundary');
    const tailTuplet = span.members[span.members.length - 1].note.tuplet;
    const sourceDomain = memberTimingDomain(state, span.oldStart, span.oldEnd);
    if ((operation === 'move' || writtenDurationFor) && sourceDomain === undefined) return fail('incompatible-target');
    const domain = operation === 'move' || writtenDurationFor ? sourceDomain : tailTuplet;
    const wanted = writtenDurationFor?.(span.root);
    if (wanted && (!Number.isFinite(wanted.toFloat()) || wanted.compareTo(ZERO) <= 0)) return fail('boundary');
    const step = wanted
      ? (domain ? domain.actualMemberDuration(wanted) : wanted).minus(span.oldEnd.minus(span.oldStart))
      : domain ? domain.actualMemberDuration(domain.writtenUnit ?? delta.timesInt(delta.compareTo(ZERO) < 0 ? -1 : 1))
        .timesInt(delta.compareTo(ZERO) < 0 ? -1 : 1) : delta;
    if (step.equals(ZERO)) continue;
    const nextStart = operation === 'move' ? span.oldStart.plus(step) : span.oldStart;
    const nextEnd = span.oldEnd.plus(step);
    let limited = nextStart.compareTo(first) < 0 || nextEnd.compareTo(end) > 0 || nextEnd.compareTo(nextStart) <= 0;
    if (operation === 'move') {
      if (movement && !movement.equals(step)) return fail('incompatible-target');
      movement = step;
      if (memberTimingDomain(state, nextStart, nextEnd) !== sourceDomain) return fail('boundary');
      const nextAttack = state.spans.filter(other => other !== span && !selected.has(other.root)
        && !other.oldStart.equals(span.oldStart) && other.oldStart.compareTo(nextStart) > 0)
        .sort((a, b) => a.oldStart.compareTo(b.oldStart))[0];
      limited ||= Boolean(nextAttack && nextEnd.compareTo(nextAttack.oldStart) > 0);
      if (limited) return fail('boundary');
    } else if (step.compareTo(ZERO) > 0) {
      const nextAttack = state.spans.filter(other => other !== span && other.oldStart.compareTo(span.oldStart) > 0
        && other.oldStart.compareTo(span.oldEnd) >= 0).sort((a, b) => a.oldStart.compareTo(b.oldStart))[0];
      limited ||= Boolean(nextAttack && nextEnd.compareTo(nextAttack.oldStart) > 0);
      limited ||= memberTimingDomain(state, span.oldEnd, nextEnd) !== tailTuplet;
      limited ||= state.chords.some(item => item.chord.rest && !isPlainMergeableRest(item.chord)
        && !tailTuplet && item.start.compareTo(nextEnd) < 0 && item.end.compareTo(span.oldEnd) > 0);
    } else {
      // A resize cannot consume a complete tuplet domain or invent a binary
      // tail at a non-binary boundary. The group itself stays fixed in time.
      const removedDomain = memberTimingDomain(state, nextEnd, span.oldEnd);
      limited ||= removedDomain !== tailTuplet;
    }
    if (limited) { skipped++; continue; }
    span.start = nextStart;
    span.end = nextEnd;
    changed++;
  }
  if (!changed) return { changed: 0, skipped, blocked: 0 };
  // Local rolls only support upward playback. Reject a downward cross-part
  // roll's conversion to local groups while this is still an uncommitted plan.
  // Complete rolls and surviving cross-part subsets retain their direction.
  for (const { mark, members } of crossArpeggios) {
    if (mark.direction !== 'down') continue;
    const groups = new Map<string, number[]>();
    let moved = false;
    for (const member of members) {
      const at = selected.get(member.note)?.span.start ?? member.start;
      moved ||= !at.equals(member.start);
      const parts = groups.get(at.toString()) ?? [];
      parts.push(member.part);
      groups.set(at.toString(), parts);
    }
    if (moved && [...groups.values()].some(parts => parts.length >= 2 && new Set(parts).size === 1))
      return fail('incompatible-target');
  }
  const plans = [...states.values()].map(state => ({ state, plan: planMemberTimingCells(state) }));
  if (plans.some(({ state, plan }) => !plan && state.spans.some(span =>
    !span.start.equals(span.oldStart) || !span.end.equals(span.oldEnd)))) return fail('incompatible-target');
  for (const { state, plan } of plans) if (plan) commitMemberTimingCells(state, plan);
  restoreMovedCrossArpeggios(score, crossArpeggios);
  score.noteTimingEdits = [];
  clearStructuralTimingSnapshots(score);
  return { changed, skipped, blocked: 0 };
}

/** Shared JPW/TXT metadata validation; fractions stay exact on disk. */
export function normalizeExplicitNoteTies(raw: unknown): ExplicitNoteTie[] {
  if (!Array.isArray(raw)) return [];
  const endpoint = (rawEndpoint: unknown): ExplicitNoteTieEndpoint | null => {
    if (!rawEndpoint || typeof rawEndpoint !== 'object') return null;
    const value = rawEndpoint as Partial<ExplicitNoteTieEndpoint>;
    const offset = safeFraction(value.offset);
    return Number.isInteger(value.measure) && value.measure! >= 0
      && Number.isInteger(value.pitch) && value.pitch! >= 0 && value.pitch! <= 127
      && Number.isInteger(value.occurrence) && value.occurrence! >= 0
      && offset && offset.compareTo(ZERO) >= 0
      ? { measure: value.measure!, offset: offset.toString(), pitch: value.pitch!, occurrence: value.occurrence! } : null;
  };
  return raw.flatMap((item): ExplicitNoteTie[] => {
    if (!item || typeof item !== 'object') return [];
    const value = item as Partial<ExplicitNoteTie>;
    const from = endpoint(value.from); const to = endpoint(value.to);
    return Number.isInteger(value.part) && value.part! >= 0 && from && to && from.pitch === to.pitch
      && (to.measure > from.measure || to.measure === from.measure
        && Fraction.fromString(to.offset).compareTo(Fraction.fromString(from.offset)) > 0)
      ? [{ part: value.part!, from, to }] : [];
  });
}

interface CrossArpeggioMembers {
  mark: CrossPartArpeggio;
  members: Array<{ part: number; note: Note; start: Fraction }>;
}
function captureCrossArpeggioMembers(score: Score): CrossArpeggioMembers[] {
  return score.crossPartArpeggios.map(mark => {
    const chords = new Map(mark.parts.map(part => [part,
      score.parts[part]?.measures[mark.measure]?.entries.find((entry): entry is Chord =>
        entry instanceof Chord && entry.position.equals(mark.offset))]));
    const requested = mark.pitches.length ? mark.pitches : [...chords].flatMap(([part, chord]) =>
      chord?.notes.filter(note => !note.rest).map(note => ({ part, pitch: note.pitch })) ?? []);
    const used = new Set<Note>();
    const members = requested.flatMap(item => {
      const note = chords.get(item.part)?.notes.find(candidate => !candidate.rest
        && candidate.pitch === item.pitch && !used.has(candidate));
      if (!note) return [];
      used.add(note);
      return [{ part: item.part, note, start: note.absoluteTick }];
    });
    return { mark, members };
  });
}

/** Moving part of a rolled chord can leave valid rolls at two positions.
 * Reclassify each surviving group from its real members; no mark may remain
 * attached to the now-empty old attack position. */
function restoreMovedCrossArpeggios(score: Score, captures: readonly CrossArpeggioMembers[]): void {
  for (const { mark, members } of captures) {
    if (!members.some(member => !member.note.absoluteTick.equals(member.start))) continue;
    const groups = new Map<string, CrossArpeggioMembers['members']>();
    for (const member of members) {
      if (!member.note.chord.notes.includes(member.note)) continue;
      const chord = member.note.chord;
      const key = `${chord.measure.index}/${chord.position}`;
      const group = groups.get(key) ?? [];
      group.push(member); groups.set(key, group);
    }
    score.crossPartArpeggios = score.crossPartArpeggios.filter(candidate => candidate !== mark);
    let reused = false;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const parts = [...new Set(group.map(member => member.part))];
      if (parts.length === 1) {
        const chord = group[0].note.chord;
        setChordArpeggioPitchGroups(chord, [...chordArpeggioPitchGroups(chord), group.map(member => member.note.pitch)]);
      } else {
        const next = reused ? new CrossPartArpeggio() : mark;
        reused = true;
        next.measure = group[0].note.chord.measure.index;
        next.offset = group[0].note.chord.position;
        next.parts = parts;
        next.pitches = group.map(member => ({ part: member.part, pitch: member.note.pitch }));
        next.direction = mark.direction;
        score.crossPartArpeggios.push(next);
      }
    }
  }
}
