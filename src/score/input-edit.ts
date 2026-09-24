import { Fraction } from "../common/fraction";
import { BarStyle, Chord, Key, LineBreak, Measure, Note, Part, Score, Time, Tuplet } from "./score";
import {
  normalizeScoreRestSpelling,
  noteTimingStep,
  type NoteTimingDivision,
} from "./note-timing";

/** The logical row selected by the score-input cursor. */
export type InputLane = "rest" | "above" | "below";

/** A time-quantized cursor. `offset` is local to `measureIndex`. */
export interface NotationCursor {
  partIndex: number;
  measureIndex: number;
  offset: Fraction;
  division: NoteTimingDivision;
  lane: InputLane;
  /** Index in the chord's pitch-sorted stack; negative/overflow are placeholders. */
  verticalIndex?: number;
}

export interface InputEditResult {
  changed: boolean;
  measure: Measure;
  chord: Chord | null;
  note: Note | null;
  createdMeasure: boolean;
  splitRests: number;
  /** The attack replaced an already-notated 3:2 cell. Its written value is
   * fixed by that cell and must not be quantized again by the editor shell. */
  fixedTupletCell?: boolean;
}

export interface InputNoteSpec {
  pitch: number;
  number?: string;
  jpOctave?: number;
  jpAlter?: string;
  displayText?: string | null;
}

export interface MoveInputNoteResult {
  changed: boolean;
  sourceChord: Chord | null;
  targetChord: Chord | null;
  note: Note | null;
}

export interface InputRestResult {
  changed: boolean;
  measure: Measure;
  rest: Chord | null;
  createdMeasure: boolean;
}

export interface InputTripletResult {
  changed: boolean;
  chords: Chord[];
  reason?: "invalid-duration" | "cross-measure" | "overlapping-tuplet" | "finer-rhythm";
}

export interface RemoveInputTripletResult {
  changed: boolean;
  kept: Chord[];
  dropped: number;
}

const ZERO = new Fraction(0);
const SCALE_PITCH = [0, 2, 4, 5, 7, 9, 11] as const;

/** A structural input edit bakes the live timing into notation.  Persisted
 * timing overlays keep the pre-edit beams/dots in `timingOriginal`; leaving
 * those snapshots attached makes JPW serialization resurrect the stale
 * value after a tuplet member is edited (most visibly 16ths becoming 32nds).
 */
function clearInputTimingOverlay(score: Score): void {
  score.noteTimingEdits = [];
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

interface WrittenDuration {
  value: Fraction;
  beats: number;
  beams: number;
  dot: number;
}

const WRITTEN_DURATIONS: readonly WrittenDuration[] = [
  { value: new Fraction(4), beats: 4, beams: 0, dot: 0 },
  { value: new Fraction(3), beats: 2, beams: 0, dot: 1 },
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

function setWrittenDuration(chord: Chord, duration: Fraction): void {
  const exact = WRITTEN_DURATIONS.find((item) => item.value.equals(duration));
  chord.duration = duration;
  chord.beamGroup = null;
  chord.beats = exact?.beats ?? 1;
  chord.beams = exact?.beams ?? Math.max(0, Math.min(6,
    Math.round(Math.log2(1 / Math.max(1 / 64, duration.toFloat())))));
  chord.dot = exact?.dot ?? 0;
}

function writtenDuration(chord: Chord): Fraction {
  let result = new Fraction(Math.max(1, chord.beats || 1), 1 << Math.max(0, chord.beams));
  if (chord.dot > 0) result = result.timesInt(3).divInt(2);
  return result;
}

/** Return the undotted base represented by a printed value.  Tuplet creation
 * uses the selected attack's binary container, so an attached augmentation
 * dot must be removed before the 3:2 span is computed. */
function undottedWrittenDuration(chord: Chord): Fraction {
  if ((chord.dot || 0) <= 0) return writtenDuration(chord);
  return new Fraction(
    Math.max(1, chord.beats || 1),
    1 << Math.max(0, chord.beams),
  );
}

/** Keep the printed value binary/dotted while storing its real 3:2 time. */
function setTripletWrittenDuration(
  chord: Chord,
  nominalDuration: Fraction,
  actualDuration: Fraction,
): void {
  const exact = WRITTEN_DURATIONS.find((item) => item.value.equals(nominalDuration));
  chord.duration = actualDuration;
  chord.beamGroup = null;
  chord.beats = exact?.beats ?? 1;
  chord.beams = exact?.beams ?? Math.max(0, Math.min(6,
    Math.round(Math.log2(1 / Math.max(1 / 64, nominalDuration.toFloat())))));
  chord.dot = exact?.dot ?? 0;
}

/** Convert one ordinary written value to its real duration inside a Tuplet. */
export function tupletWrittenToActual(
  written: Fraction,
  tuplet?: Pick<Tuplet, "ratioNumerator" | "ratioDenominator">,
): Fraction {
  const numerator = tuplet?.ratioNumerator ?? 3;
  const denominator = tuplet?.ratioDenominator ?? 2;
  return written.timesInt(denominator).divInt(numerator);
}

/** Convert one real duration to the ordinary value printed by a Tuplet. */
export function tupletActualToWritten(
  actual: Fraction,
  tuplet?: Pick<Tuplet, "ratioNumerator" | "ratioDenominator">,
): Fraction {
  const numerator = tuplet?.ratioNumerator ?? 3;
  const denominator = tuplet?.ratioDenominator ?? 2;
  return actual.timesInt(numerator).divInt(denominator);
}

/** Return the complete, ordered member list of an editable Tuplet. */
export function inputTupletMembers(tuplet: Tuplet): Chord[] {
  return tuplet.memberChords();
}

interface InputTupletDomain {
  start: Fraction;
  end: Fraction;
  writtenUnit: Fraction;
  actualUnit: Fraction;
}

/** Resolve the full editable 3:2 window, including a conventional missing
 * third cell in hand-written JPW such as two equal 16th-triplet members. */
function inputTupletDomain(tuplet: Tuplet): InputTupletDomain | null {
  const members = inputTupletMembers(tuplet);
  if (members.length === 0) return null;
  const start = tuplet.actualStart ?? members[0].position;
  const last = members[members.length - 1];
  const occupiedEnd = last.position.plus(last.duration ?? ZERO);
  let writtenUnit = tuplet.writtenUnit;

  // Imported JPW has no separate tuplet metadata. If its bracket closes
  // after two equal written members, Tuplet.refreshTiming() can only see 2/3
  // of the intended window and derives a value one step too short. The two
  // printed values themselves unambiguously identify the missing third cell.
  if (members.length === 2) {
    const firstWritten = writtenDuration(members[0]);
    const secondWritten = writtenDuration(members[1]);
    if (firstWritten.equals(secondWritten)
      && (!writtenUnit || writtenUnit.compareTo(firstWritten) < 0)) {
      writtenUnit = firstWritten;
    }
  }
  if (!writtenUnit || writtenUnit.compareTo(ZERO) <= 0) {
    const occupied = occupiedEnd.minus(start);
    if (occupied.compareTo(ZERO) <= 0) return null;
    writtenUnit = occupied.divInt(tuplet.ratioDenominator);
  }
  const actualUnit = tupletWrittenToActual(writtenUnit, tuplet);
  if (actualUnit.compareTo(ZERO) <= 0) return null;
  const expectedEnd = start.plus(writtenUnit.timesInt(tuplet.ratioDenominator));
  const end = occupiedEnd.compareTo(expectedEnd) > 0 ? occupiedEnd : expectedEnd;
  return { start, end, writtenUnit, actualUnit };
}

/** Find the voice-local Tuplet occupying a notation cursor position. */
export function inputTupletAtCursor(
  score: Score,
  cursor: Pick<NotationCursor, "partIndex" | "measureIndex" | "offset">,
): Tuplet | null {
  const measure = score.parts[cursor.partIndex]?.measures[cursor.measureIndex];
  if (!measure) return null;
  const tuplets = new Set<Tuplet>();
  for (const entry of measure.entries) {
    if (!(entry instanceof Chord)) continue;
    for (const note of entry.notes) if (note.tuplet) tuplets.add(note.tuplet);
  }
  return [...tuplets].find((tuplet) => {
    const domain = inputTupletDomain(tuplet);
    return domain !== null
      && cursor.offset.compareTo(domain.start) >= 0
      && cursor.offset.compareTo(domain.end) < 0;
  }) ?? null;
}

/** Convert a written toolbar step into the real step used inside a Tuplet. */
export function inputTupletWrittenDelta(
  note: Note,
  writtenDelta: Fraction,
): Fraction {
  return note.tuplet ? tupletWrittenToActual(writtenDelta, note.tuplet) : writtenDelta;
}

function measureLength(measure: Measure): Fraction {
  return new Fraction(measure.time.beats * 4, measure.time.beatType);
}

function partMeasurePosition(part: Part, index: number): Fraction {
  const previous = part.measures[index - 1];
  return previous
    ? previous.position.plus(measureLength(previous))
    : new Fraction(0);
}

/** Populate a formal editable tail with one rest for every beat. */
function populateEmptyMeasure(measure: Measure): void {
  const beat = new Fraction(4, measure.time.beatType);
  for (let index = 0; index < measure.time.beats; index++) {
    addRest(measure, beat.timesInt(index), beat);
  }
  measure.barline = BarStyle.LIGHT_HEAVY;
}

/** Ensure a real, editable measure exists. The returned boolean says whether it was created. */
export function ensureInputMeasure(
  score: Score,
  partIndex: number,
  measureIndex: number,
): { measure: Measure; created: boolean } {
  if (partIndex < 0) throw new Error("input part index must be non-negative");
  if (measureIndex < 0) throw new Error("input measure index must be non-negative");
  while (score.parts.length <= partIndex) score.parts.push(new Part());
  const part = score.parts[partIndex];
  let created = false;
  while (part.measures.length <= measureIndex) {
    const index = part.measures.length;
    const previous = part.measures[index - 1];
    const measure = new Measure(index);
    if (previous) {
      // Appending after a formerly final measure turns that measure into a
      // normal interior bar. Move its terminal barline/page break to the new
      // tail instead of leaving a stale `|]`/page break in the middle.
      const terminalBreaks = previous.entries.filter((entry) => entry instanceof LineBreak);
      if (terminalBreaks.length > 0) {
        previous.entries = previous.entries.filter((entry) => !(entry instanceof LineBreak));
        for (const entry of terminalBreaks) {
          const moved = new LineBreak(measure);
          moved.newPage = entry.newPage;
          moved.pass = entry.pass;
          measure.entries.push(moved);
        }
      }
      const terminalBarline = previous.barline;
      if (terminalBarline === BarStyle.LIGHT_HEAVY || terminalBarline === BarStyle.HEAVY_HEAVY) {
        measure.barline = terminalBarline;
        previous.barline = BarStyle.REGULAR;
      }
      if (previous.barline !== BarStyle.LIGHT_HEAVY
        && previous.barline !== BarStyle.HEAVY_HEAVY) {
        previous.barline = BarStyle.REGULAR;
      }
      measure.newSystem = previous.newSystem;
      measure.newPage = previous.newPage;
      previous.newSystem = false;
      previous.newPage = false;
      measure.time.beats = previous.time.beats;
      measure.time.beatType = previous.time.beatType;
      measure.position = partMeasurePosition(part, index);
    } else {
      measure.position = new Fraction(0);
    }
    populateEmptyMeasure(measure);
    part.measures.push(measure);
    created = true;
  }
  return { measure: part.measures[measureIndex], created };
}

/** Ensure a persistent empty measure follows the last real measure. */
export function ensureInputTailMeasure(score: Score, partIndex = 0): Measure | null {
  if (partIndex < 0) return null;
  while (score.parts.length <= partIndex) score.parts.push(new Part());
  const part = score.parts[partIndex];
  const last = part.measures[part.measures.length - 1];
  if (!last) return ensureInputMeasure(score, partIndex, 0).measure;
  const isEmpty = last.entries
    .filter((entry): entry is Chord => entry instanceof Chord)
    .every((chord) => chord.rest);
  if (isEmpty) {
    last.barline = BarStyle.LIGHT_HEAVY;
    return last;
  }
  return ensureInputMeasure(score, partIndex, part.measures.length).measure;
}

function addRest(measure: Measure, position: Fraction, duration: Fraction): Chord {
  const chord = new Chord(measure);
  chord.position = position;
  chord.rest = true;
  const note = new Note(chord);
  note.rest = true;
  note.number = "0";
  chord.add(note);
  setWrittenDuration(chord, duration);
  measure.add(chord);
  return chord;
}

/**
 * Fill an automatically generated silent span without letting one rest cross
 * a notated beat boundary.  Rest fusion is intentionally beat-local: in 4/4
 * the silence after a quarter-note attack is therefore written as three
 * quarter rests at beats 2, 3 and 4, rather than one metrically ambiguous
 * three-quarter rest.  Compound x/8 meters use the same dotted-quarter beat
 * grouping as the rhythm ruler and note-timing normalizer.
 */
function addBeatGroupedRests(
  measure: Measure,
  start: Fraction,
  duration: Fraction,
): Chord[] {
  const compound = measure.time.beatType === 8
    && measure.time.beats >= 6
    && measure.time.beats % 3 === 0;
  const beat = compound
    ? new Fraction(3, 2)
    : new Fraction(4, measure.time.beatType);
  const result: Chord[] = [];
  let position = start;
  let remaining = duration;
  let guard = 0;
  const binaryValues = WRITTEN_DURATIONS
    .filter((written) => written.dot === 0)
    .map((written) => written.value)
    .sort((left, right) => right.compareTo(left));
  while (remaining.compareTo(ZERO) > 0 && guard++ < 1024) {
    const beatIndex = Math.floor(position.div(beat).toFloat() + 1e-10);
    const beatEnd = beat.timesInt(beatIndex + 1);
    const available = beatEnd.minus(position);
    let piece = available.compareTo(ZERO) > 0 && available.compareTo(remaining) < 0
      ? available
      : remaining;
    if (piece.compareTo(ZERO) <= 0) break;
    // A partial beat after a 32nd/64th input is often not one directly
    // writable JPW value (for example 7/8 of a quarter beat).  Storing that
    // span in one Chord lets `setWrittenDuration` fall back to a quarter rest,
    // so the next save/reparse changes the bar length and later deletion seems
    // to swallow silence. Split it into aligned binary values whose sum is
    // exact; beat-local rest normalization may merge them into dotted values
    // afterwards without changing the timeline.
    while (piece.compareTo(ZERO) > 0 && guard++ < 1024) {
      const value = binaryValues.find((candidate) =>
        candidate.compareTo(piece) <= 0
        && position.div(candidate).denominator === 1)
        ?? WRITTEN_DURATIONS.find((candidate) => candidate.value.equals(piece))?.value
        ?? piece;
      result.push(addRest(measure, position, value));
      position = position.plus(value);
      remaining = remaining.minus(value);
      piece = piece.minus(value);
    }
  }
  return result;
}

function removeEntry(measure: Measure, chord: Chord): void {
  measure.entries = measure.entries.filter((entry) => entry !== chord);
}

function sortEntries(measure: Measure): void {
  measure.entries.sort((left, right) => {
    const position = left.position.compareTo(right.position);
    if (position !== 0) return position;
    if (left instanceof Chord && !(right instanceof Chord)) return -1;
    if (!(left instanceof Chord) && right instanceof Chord) return 1;
    return 0;
  });
}

function cloneInputNote(source: Note, chord: Chord): Note {
  const note = new Note(chord);
  note.pitch = source.pitch;
  note.step = source.step;
  note.alter = source.alter;
  note.octave = source.octave;
  note.jpOctave = source.jpOctave;
  note.jpAlter = source.jpAlter;
  note.number = source.number;
  note.displayText = source.displayText;
  note.displayOctave = source.displayOctave;
  note.displayAlter = source.displayAlter;
  return note;
}

/** Remove one note from its current tie chain without leaving either
 * neighbour pointing at a note that is about to be deleted or moved. */
function detachInputTie(note: Note): void {
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

function applyInputSpec(note: Note, spec: InputNoteSpec): void {
  note.pitch = spec.pitch;
  if (spec.number !== undefined) note.number = spec.number;
  if (spec.jpOctave !== undefined) note.jpOctave = spec.jpOctave;
  if (spec.jpAlter !== undefined) note.jpAlter = spec.jpAlter;
  if (spec.displayText !== undefined) note.displayText = spec.displayText;
}

function chordAt(measure: Measure, offset: Fraction): Chord | null {
  return measure.entries.find((entry): entry is Chord =>
    entry instanceof Chord && !entry.generatedTimingContinuation
    && entry.position.equals(offset)) ?? null;
}

function chordCovering(measure: Measure, offset: Fraction): Chord | null {
  return measure.entries.find((entry): entry is Chord => {
    if (!(entry instanceof Chord) || !entry.duration) return false;
    return entry.position.compareTo(offset) <= 0
      && entry.position.plus(entry.duration).compareTo(offset) > 0;
  }) ?? null;
}

function soundingChordCovering(measure: Measure, offset: Fraction): Chord | null {
  return measure.entries.find((entry): entry is Chord => {
    if (!(entry instanceof Chord) || entry.rest || !entry.duration) return false;
    return entry.position.compareTo(offset) <= 0
      && entry.position.plus(entry.duration).compareTo(offset) > 0;
  }) ?? null;
}

function splitRestAt(
  measure: Measure,
  rest: Chord,
  offset: Fraction,
  insertedDuration: Fraction,
): { before: Fraction; after: Fraction } {
  const start = rest.position;
  const duration = rest.duration ?? ZERO;
  const end = start.plus(duration);
  const before = offset.minus(start);
  const insertedEnd = offset.plus(insertedDuration);
  const after = end.minus(insertedEnd);
  removeEntry(measure, rest);
  if (before.compareTo(ZERO) > 0) addBeatGroupedRests(measure, start, before);
  if (after.compareTo(ZERO) > 0) addBeatGroupedRests(measure, insertedEnd, after);
  return { before, after };
}

/** Consume one requested span from a contiguous run of ordinary rests.
 * Fine JPW rests are deliberately split at binary boundaries, so an eighth
 * input may need to consume two adjacent sixteenth rests instead of being
 * incorrectly shortened to the first fragment. Tuplet rests are fixed cells
 * and are handled before this helper is reached. */
function consumeOrdinaryRestSpan(
  measure: Measure,
  offset: Fraction,
  requested: Fraction,
): Fraction {
  const rests = measure.entries
    .filter((entry): entry is Chord => entry instanceof Chord
      && entry.rest
      && !entry.notes.some((note) => note.tuplet !== null))
    .sort((left, right) => left.position.compareTo(right.position));
  const requestedEnd = offset.plus(requested);
  let availableEnd = offset;
  let guard = 0;
  while (availableEnd.compareTo(requestedEnd) < 0 && guard++ < 1024) {
    const rest = rests.find((candidate) => {
      const end = candidate.position.plus(candidate.duration ?? ZERO);
      return candidate.position.compareTo(availableEnd) <= 0
        && end.compareTo(availableEnd) > 0;
    });
    if (!rest) break;
    const end = rest.position.plus(rest.duration ?? ZERO);
    if (end.compareTo(availableEnd) <= 0) break;
    availableEnd = end;
  }
  const available = availableEnd.minus(offset);
  const consumed = available.compareTo(requested) < 0 ? available : requested;
  if (consumed.compareTo(ZERO) <= 0) return ZERO;
  const consumedEnd = offset.plus(consumed);
  for (const rest of rests) {
    const start = rest.position;
    const end = start.plus(rest.duration ?? ZERO);
    if (end.compareTo(offset) <= 0 || start.compareTo(consumedEnd) >= 0) continue;
    removeEntry(measure, rest);
    if (start.compareTo(offset) < 0) {
      addBeatGroupedRests(measure, start, offset.minus(start));
    }
    if (end.compareTo(consumedEnd) > 0) {
      addBeatGroupedRests(measure, consumedEnd, end.minus(consumedEnd));
    }
  }
  return consumed;
}

function continuationOf(source: Chord, measure: Measure, position: Fraction, duration: Fraction): Chord {
  const continuation = new Chord(measure);
  continuation.position = position;
  // This tail resumes after a newly inserted pitch, so it is a fresh attack,
  // not a non-retriggered tie continuation across the intervening note.
  continuation.voice = source.voice;
  continuation.stemUp = source.stemUp;
  continuation.rest = false;
  for (const sourceNote of source.notes.filter((note) => !note.rest)) {
    const note = cloneInputNote(sourceNote, continuation);
    // If the original note continued beyond this measure, the resumed tail is
    // now the segment that reaches that following tie. Do not leave a stale
    // pointer on the source segment across the newly inserted attack.
    note.tieStart = sourceNote.tieStart;
    note.tieNext = sourceNote.tieNext;
    if (note.tieNext) note.tieNext.tiePrev = note;
    sourceNote.tieStart = false;
    sourceNote.tieNext = null;
    continuation.add(note);
  }
  setWrittenDuration(continuation, duration);
  measure.add(continuation);
  return continuation;
}

/** Collect one semantic held note from its first attack through every tied
 * continuation.  Input-mode Delete treats these printed pieces as one note,
 * regardless of which gray continuation the user clicked. */
function inputTieChain(note: Note): Note[] {
  let root = note;
  const backwards = new Set<Note>();
  while (root.tiePrev && !backwards.has(root)) {
    backwards.add(root);
    root = root.tiePrev;
  }
  const result: Note[] = [];
  const forwards = new Set<Note>();
  let cursor: Note | null = root;
  while (cursor && !forwards.has(cursor)) {
    forwards.add(cursor);
    result.push(cursor);
    cursor = cursor.tieNext;
  }
  return result;
}

/** Delete every printed segment of one tied note and release its occupied
 * timeline as rests. Other pitches sharing any chord are preserved. */
function deleteInputTieChain(score: Score, selectedNote: Note): Chord | null {
  const chain = inputTieChain(selectedNote);
  if (chain.length <= 1) return null;
  const selectedMeasure = selectedNote.chord.measure;
  const selectedPosition = selectedNote.chord.position;
  const affectedMeasures = new Set<Measure>();
  const affectedTuplets = new Set<Tuplet>();

  for (const member of chain) {
    const chord = member.chord;
    const measure = chord.measure;
    const position = chord.position;
    const duration = chord.duration ?? ZERO;
    const tuplet = member.tuplet;
    affectedMeasures.add(measure);
    if (tuplet) affectedTuplets.add(tuplet);

    // The chain was collected before links are detached, so clearing one
    // segment cannot make the following continuation unreachable.
    detachInputTie(member);
    const remaining = chord.notes.filter((note) => note !== member && !note.rest);
    if (remaining.length > 0) {
      chord.notes = chord.notes.filter((note) => note !== member);
      const replacementBoundary = tuplet
        ? chord.notes.find((note) => note.tuplet === tuplet) ?? null
        : null;
      if (tuplet?.first === member && replacementBoundary) tuplet.first = replacementBoundary;
      if (tuplet?.last === member && replacementBoundary) tuplet.last = replacementBoundary;
      const allContinued = remaining.every((note) => note.tiePrev !== null && note.tieEnd);
      chord.transparentContinuation = allContinued;
      chord.generatedTimingContinuation = allContinued && chord.generatedTimingContinuation;
      continue;
    }

    if (tuplet) {
      // A tuplet member keeps its exact compressed cell and boundary flags;
      // only its sounding content changes to a written zero.
      const restNote = new Note(chord);
      restNote.rest = true;
      restNote.number = "0";
      restNote.tuplet = tuplet;
      restNote.tupletBegin = member.tupletBegin;
      restNote.tupletEnd = member.tupletEnd;
      chord.notes = [];
      chord.add(restNote);
      chord.rest = true;
      chord.transparentContinuation = false;
      chord.generatedTimingContinuation = false;
      if (tuplet.first === member) tuplet.first = restNote;
      if (tuplet.last === member) tuplet.last = restNote;
      continue;
    }

    removeEntry(measure, chord);
    if (duration.compareTo(ZERO) > 0) {
      addBeatGroupedRests(measure, position, duration);
    }
  }

  for (const measure of affectedMeasures) sortEntries(measure);
  for (const tuplet of affectedTuplets) tuplet.refreshTiming();
  // Merge the released continuation span with an adjacent trailing rest only
  // inside its current beat.  This is what turns dotted-eighth silence plus
  // the existing final sixteenth into one quarter rest.
  normalizeScoreRestSpelling(score);
  const rest = chordCovering(selectedMeasure, selectedPosition);
  return rest?.rest ? rest : null;
}

function splitSoundingChordAt(
  measure: Measure,
  chord: Chord,
  offset: Fraction,
  insertedDuration: Fraction,
  preserveTail = true,
): Fraction {
  const start = chord.position;
  const end = start.plus(chord.duration ?? ZERO);
  const before = offset.minus(start);
  const after = end.minus(offset.plus(insertedDuration));
  if (before.compareTo(ZERO) > 0) setWrittenDuration(chord, before);
  if (preserveTail && after.compareTo(ZERO) > 0) {
    continuationOf(chord, measure, offset.plus(insertedDuration), after);
  } else if (!preserveTail) {
    for (const note of chord.notes.filter((candidate) => !candidate.rest)) {
      const next = note.tieNext;
      if (next) {
        next.tiePrev = null;
        next.tieEnd = false;
      }
      note.tieStart = false;
      note.tieNext = null;
    }
  }
  return after;
}

/**
 * Put a rest at the cursor.  Unlike typing a numbered zero in the text
 * editor, this is a structural edit: a sounding event at the cursor is
 * split, its first segment is replaced by the rest, and the tail remains in
 * place.  This is what makes inserting a rest into a whole note preserve the
 * remaining half of the note instead of deleting the whole event.
 */
export function inputRestAtCursor(
  score: Score,
  cursor: NotationCursor,
  duration: Fraction = noteTimingStep(cursor.division),
  selectedNote: Note | null = null,
): InputRestResult {
  const ensured = ensureInputMeasure(score, cursor.partIndex, cursor.measureIndex);
  const measure = ensured.measure;
  const length = measureLength(measure);
  const offset = cursor.offset.compareTo(ZERO) < 0 ? ZERO : cursor.offset;
  if (offset.compareTo(length) >= 0) {
    return { changed: false, measure, rest: null, createdMeasure: ensured.created };
  }
  if (selectedNote && (selectedNote.tiePrev || selectedNote.tieNext)) {
    const rest = deleteInputTieChain(score, selectedNote);
    clearInputTimingOverlay(score);
    return { changed: true, measure, rest, createdMeasure: ensured.created };
  }
  const grid = duration.compareTo(ZERO) > 0 ? duration : noteTimingStep(cursor.division);
  const available = length.minus(offset);
  const actual = grid.compareTo(available) > 0 ? available : grid;
  let chord = chordAt(measure, offset);
  // A stale/generated rest can overlap a manually extended sounding event;
  // prefer the sounding event so a new attack still truncates that event.
  if (chord?.rest && soundingChordCovering(measure, offset)) chord = null;

  // Replacing an exact tuplet cell must not fall back to the surrounding
  // binary grid. Keep the cell's real 3:2 duration and boundary markers while
  // changing only its content to a written zero.
  const tupleTemplate = chord?.notes.find((note) => note.tuplet !== null) ?? null;
  if (chord && tupleTemplate && (!selectedNote || chord.notes.length <= 1)) {
    for (const note of chord.notes) detachInputTie(note);
    const restNote = new Note(chord);
    restNote.rest = true;
    restNote.number = "0";
    restNote.tuplet = tupleTemplate.tuplet;
    restNote.tupletBegin = tupleTemplate.tupletBegin;
    restNote.tupletEnd = tupleTemplate.tupletEnd;
    chord.notes = [];
    chord.add(restNote);
    chord.rest = true;
    chord.transparentContinuation = false;
    sortEntries(measure);
    clearInputTimingOverlay(score);
    return { changed: true, measure, rest: chord, createdMeasure: ensured.created };
  }

  // Deleting a single tone from a chord should not erase its neighbours.
  // A chord cannot contain a rest, so the selected tone is simply removed;
  // when it was the final tone, the column becomes a real rest.
  if (chord && !chord.rest && selectedNote && chord.notes.length > 1) {
    detachInputTie(selectedNote);
    chord.notes = chord.notes.filter((note) => note !== selectedNote);
    sortEntries(measure);
    clearInputTimingOverlay(score);
    return { changed: true, measure, rest: null, createdMeasure: ensured.created };
  }

  const covering = chord ?? chordCovering(measure, offset);
  if (covering?.rest) {
    // Split an existing rest only when the requested duration is shorter;
    // this keeps the rest after the cursor available for later input.
    const end = covering.position.plus(covering.duration ?? ZERO);
    const remaining = end.minus(offset);
    if (remaining.compareTo(actual) > 0) splitRestAt(measure, covering, offset, actual);
    chord = null;
  } else if (covering && covering.position.compareTo(offset) < 0) {
    // Inside a sustained note the old pitch ends at the cursor. The rest
    // occupies the selected cell; no copy of the old pitch is restored after
    // that cell.
    splitSoundingChordAt(measure, covering, offset, actual, false);
    chord = null;
  } else if (covering && covering.position.equals(offset)) {
    // Split at the start of a sounding event so its tail remains after the
    // newly inserted rest. Remove the zero-length source column below.
    if (!covering.rest && (covering.duration ?? ZERO).compareTo(actual) > 0) {
      splitSoundingChordAt(measure, covering, offset, actual);
    }
    chord = covering;
  }

  if (chord && !chord.rest) {
    for (const note of chord.notes) detachInputTie(note);
    removeEntry(measure, chord);
  }
  // Delete releases the selected note's whole span back into the rhythmic
  // grid.  Do not replace a half/whole note with one equally long `0`: rests
  // are grouped per notated beat, so a half note on beat one in 4/4 becomes
  // two quarter rests.  Typing `0` remains a grid-sized structural insertion
  // and therefore keeps its existing split/preserved-tail behaviour.
  const releasedRests = selectedNote
    ? addBeatGroupedRests(measure, offset, actual)
    : [addRest(measure, offset, actual)];
  const insertedRests = new Set(releasedRests);
  let rest: Chord | null = releasedRests[0] ?? null;
  const restEnd = offset.plus(actual);
  const soundingPositions = new Set(measure.entries
    .filter((entry): entry is Chord => entry instanceof Chord && !entry.rest)
    .map((entry) => entry.position.toString()));
  // Remove stale rests that overlap the newly occupied cell, or sit exactly
  // under a preserved sounding tail created by the split.
  measure.entries = measure.entries.filter((entry) => {
    if (!(entry instanceof Chord) || !entry.rest || insertedRests.has(entry)) return true;
    const start = entry.position;
    const end = start.plus(entry.duration ?? ZERO);
    return !(start.compareTo(restEnd) < 0 && end.compareTo(offset) > 0)
      && !soundingPositions.has(start.toString());
  });
  sortEntries(measure);
  if (selectedNote) {
    // Join newly released fragments to adjacent rests only when they remain
    // inside the same beat. This gives two sixteenth rests one eighth-rest
    // spelling without ever joining silence across a beat boundary.
    normalizeScoreRestSpelling(score);
    rest = chordCovering(measure, offset);
    if (!rest?.rest) rest = null;
  }
  clearInputTimingOverlay(score);
  return { changed: true, measure, rest, createdMeasure: ensured.created };
}

/** Input a note at the cursor. Existing same-time chords receive a new tone. */
export function inputNoteAtCursor(
  score: Score,
  cursor: NotationCursor,
  spec: InputNoteSpec,
  requestedDuration: Fraction = noteTimingStep(cursor.division),
): InputEditResult {
  const ensured = ensureInputMeasure(score, cursor.partIndex, cursor.measureIndex);
  const measure = ensured.measure;
  const length = measureLength(measure);
  if (cursor.offset.compareTo(length) >= 0) {
    return { changed: false, measure, chord: null, note: null, createdMeasure: ensured.created, splitRests: 0 };
  }
  const offset = cursor.offset.compareTo(ZERO) < 0 ? ZERO : cursor.offset;
  let chord = chordAt(measure, offset);
  if (chord?.rest && soundingChordCovering(measure, offset)) chord = null;
  let splitRests = 0;
  // Cursor navigation and written duration are independent toolbar values.
  // Using only `cursor.division` made a quarter-note input inherit a coarser
  // automatic grid/rest (occasionally the whole remaining bar). Split the
  // occupied slot with the explicitly selected writing value instead.
  const gridDuration = requestedDuration.compareTo(ZERO) > 0
    ? requestedDuration
    : noteTimingStep(cursor.division);
  let insertionDuration = gridDuration;
  const cursorTuplet = inputTupletAtCursor(score, cursor);

  // An explicit 0 inside a tuplet is an editable member, not an ordinary rest
  // to be re-split by the binary input division. Reuse the same Chord so the
  // Tuplet object, printed value and exact real duration remain unchanged.
  const tupleRest = chord?.rest
    ? chord.notes.find((note) => note.tuplet !== null) ?? null
    : null;
  if (chord?.rest && tupleRest) {
    const note = new Note(chord);
    applyInputSpec(note, spec);
    note.tuplet = tupleRest.tuplet;
    note.tupletBegin = tupleRest.tupletBegin;
    note.tupletEnd = tupleRest.tupletEnd;
    chord.notes = [];
    chord.add(note);
    chord.rest = false;
    sortEntries(measure);
    clearInputTimingOverlay(score);
    return {
      changed: true,
      measure,
      chord,
      note,
      createdMeasure: ensured.created,
      splitRests: 0,
      fixedTupletCell: true,
    };
  }

  const covering = chord ?? chordCovering(measure, offset);
  const vacantTupletDomain = cursorTuplet ? inputTupletDomain(cursorTuplet) : null;
  if ((!chord || chord.rest) && cursorTuplet && vacantTupletDomain
    && (!covering || covering.rest)) {
    const relative = offset.minus(vacantTupletDomain.start);
    const slot = relative.div(vacantTupletDomain.actualUnit);
    const atMemberBoundary = slot.denominator === 1
      && slot.numerator >= 0
      && slot.numerator < cursorTuplet!.ratioNumerator;
    if (atMemberBoundary) {
      // Remove only this missing member's real cell from an ordinary rest.
      // The remaining silence stays ordinary outside the bracket.
      const actualDuration = vacantTupletDomain.actualUnit;
      if (covering?.rest) {
        const restStart = covering.position;
        const restEnd = restStart.plus(covering.duration ?? ZERO);
        removeEntry(measure, covering);
        const before = offset.minus(restStart);
        const after = restEnd.minus(offset.plus(actualDuration));
        if (before.compareTo(ZERO) > 0) addBeatGroupedRests(measure, restStart, before);
        if (after.compareTo(ZERO) > 0) {
          addBeatGroupedRests(measure, offset.plus(actualDuration), after);
        }
      }
      chord = new Chord(measure);
      chord.position = offset;
      chord.rest = false;
      setTripletWrittenDuration(
        chord,
        vacantTupletDomain.writtenUnit,
        actualDuration,
      );
      const note = new Note(chord);
      applyInputSpec(note, spec);
      note.tuplet = cursorTuplet;
      chord.add(note);
      measure.add(chord);
      // Preserve the inferred 16th/eighth member value before refreshing the
      // now-complete group; otherwise the former two-member span is divided a
      // second time and reappears as 64th notes after JPW serialization.
      cursorTuplet.writtenUnit = vacantTupletDomain.writtenUnit;
      refreshInputTupletMarkers(cursorTuplet);
      sortEntries(measure);
      clearInputTimingOverlay(score);
      return {
        changed: true,
        measure,
        chord,
        note,
        createdMeasure: ensured.created,
        splitRests: 1,
        fixedTupletCell: true,
      };
    }
  }
  if (covering?.rest) {
    insertionDuration = consumeOrdinaryRestSpan(measure, offset, gridDuration);
    if (insertionDuration.compareTo(ZERO) <= 0) insertionDuration = gridDuration;
    splitRests++;
    chord = null;
  } else if (!chord && covering && covering.position.compareTo(offset) < 0) {
    const remaining = covering.position.plus(covering.duration ?? ZERO).minus(offset);
    insertionDuration = remaining.compareTo(gridDuration) < 0 ? remaining : gridDuration;
    // A newly typed attack replaces the sustained source from this point;
    // do not recreate the old pitch as a resumed tail.
    splitSoundingChordAt(measure, covering, offset, insertionDuration, false);
  } else if (!chord && covering?.position.equals(offset)) {
    // Generated timing continuations are excluded by chordAt(), but are still
    // valid sounding columns for adding another tone at the same cursor.
    chord = covering;
    insertionDuration = chord.duration ?? gridDuration;
  }

  const duration = chord?.duration ?? insertionDuration;
  if (!chord) {
    chord = new Chord(measure);
    chord.position = offset;
    chord.rest = false;
    setWrittenDuration(chord, duration.compareTo(length.minus(offset)) > 0
      ? length.minus(offset)
      : duration);
    measure.add(chord);
  }
  chord.rest = false;
  const existing = chord.notes.find((note) => !note.rest && note.pitch === spec.pitch);
  if (existing) {
    applyInputSpec(existing, spec);
    sortEntries(measure);
    clearInputTimingOverlay(score);
    return { changed: true, measure, chord, note: existing, createdMeasure: ensured.created, splitRests };
  }
  const note = new Note(chord);
  applyInputSpec(note, spec);
  const tupleMember = chord.notes.find((candidate) => candidate.tuplet !== null);
  if (tupleMember) {
    note.tuplet = tupleMember.tuplet;
    note.tupletBegin = tupleMember.tupletBegin;
    note.tupletEnd = tupleMember.tupletEnd;
  }
  chord.add(note);
  const chordEnd = offset.plus(chord.duration ?? ZERO);
  // A previously filled rest can overlap a manually lengthened source. Once
  // a real attack is written at this column, discard only the overlapping
  // stale rest and retain silence outside the new attack.
  measure.entries = measure.entries.filter((entry) => {
    if (!(entry instanceof Chord) || !entry.rest) return true;
    const start = entry.position;
    const end = start.plus(entry.duration ?? ZERO);
    return !(start.compareTo(chordEnd) < 0 && end.compareTo(offset) > 0);
  });
  sortEntries(measure);
  clearInputTimingOverlay(score);
  return { changed: true, measure, chord, note, createdMeasure: ensured.created, splitRests };
}

/**
 * Turn a rendered gray timing continuation into a real attack at the cursor.
 *
 * Continuation chords are normally hidden from `chordAt()` because they are
 * generated from the source attack.  Input mode still needs a way to edit
 * the continuation directly: typing a degree over it must remove the
 * incoming tie and keep the continuation's written duration as the new
 * attack.  The optional pitch chooses one tone in a continuation chord.
 */
export function replaceInputContinuationAtCursor(
  score: Score,
  cursor: NotationCursor,
  spec: InputNoteSpec,
  focusPitch: number | null = null,
): InputEditResult {
  const ensured = ensureInputMeasure(score, cursor.partIndex, cursor.measureIndex);
  const measure = ensured.measure;
  const continuation = measure.entries.find((entry): entry is Chord =>
    entry instanceof Chord
    && (entry.generatedTimingContinuation
      || entry.transparentContinuation
      || (entry.notes.some((note) => !note.rest)
        && entry.notes.filter((note) => !note.rest)
          .every((note) => note.tiePrev !== null && note.tieEnd)))
    && entry.position.equals(cursor.offset)) ?? null;
  if (!continuation) {
    return {
      changed: false,
      measure,
      chord: null,
      note: null,
      createdMeasure: ensured.created,
      splitRests: 0,
    };
  }
  const candidates = continuation.notes.filter((note) => !note.rest);
  const note = candidates.sort((left, right) =>
    focusPitch === null
      ? left.pitch - right.pitch
      : Math.abs(left.pitch - focusPitch) - Math.abs(right.pitch - focusPitch)
        || left.pitch - right.pitch)[0] ?? null;
  if (!note) {
    return {
      changed: false,
      measure,
      chord: continuation,
      note: null,
      createdMeasure: ensured.created,
      splitRests: 0,
    };
  }
  // Only the edited tone's incoming tie is broken.  This preserves other
  // voices in a multi-tone continuation while making the selected tone a
  // normal, black, retriggered note.
  detachInputTie(note);
  continuation.generatedTimingContinuation = false;
  continuation.transparentContinuation = false;
  continuation.rest = false;
  applyInputSpec(note, spec);
  sortEntries(measure);
  return {
    changed: true,
    measure,
    chord: continuation,
    note,
    createdMeasure: ensured.created,
    splitRests: 0,
  };
}

/** Return the nearest strictly higher/lower tone in a chord. */
export function nearestStrictChordNote(
  chord: Chord,
  pitch: number,
  lane: Exclude<InputLane, "rest">,
): Note | null {
  const notes = chord.notes.filter((note) => !note.rest);
  const candidates = notes
    .filter((note) => lane === "above" ? note.pitch > pitch : note.pitch < pitch)
    .sort((left, right) => lane === "above" ? left.pitch - right.pitch : right.pitch - left.pitch);
  return candidates[0] ?? null;
}

/** Convert a typed scale degree to the octave implied by the selected row. */
export function inputScaleDegreePitch(
  anchor: Note,
  degree: 1 | 2 | 3 | 4 | 5 | 6 | 7,
  lane: Exclude<InputLane, "rest">,
): number {
  const anchorDegree = Math.max(1, Math.min(7, parseInt(anchor.number, 10) || 1));
  const anchorBase = anchor.pitch - SCALE_PITCH[anchorDegree - 1];
  let pitch = anchorBase + SCALE_PITCH[degree - 1];
  if (lane === "above" && degree <= anchorDegree) pitch += 12;
  if (lane === "below" && degree >= anchorDegree) pitch -= 12;
  return pitch;
}

/** Add a typed degree to the closest existing chord at the cursor. */
export function inputChordDegreeAtCursor(
  score: Score,
  cursor: NotationCursor,
  anchor: Note,
  degree: 1 | 2 | 3 | 4 | 5 | 6 | 7,
  requestedDuration: Fraction = noteTimingStep(cursor.division),
): InputEditResult {
  if (cursor.lane === "rest") {
    return inputNoteAtCursor(
      score,
      cursor,
      { pitch: inputScaleDegreePitch(anchor, degree, "above"), number: String(degree) },
      requestedDuration,
    );
  }
  const chord = chordAt(cursor.measureIndex < score.parts[cursor.partIndex]?.measures.length
    ? score.parts[cursor.partIndex].measures[cursor.measureIndex]
    : ensureInputMeasure(score, cursor.partIndex, cursor.measureIndex).measure, cursor.offset);
  if (!chord) return inputNoteAtCursor(
    score,
    cursor,
    { pitch: inputScaleDegreePitch(anchor, degree, cursor.lane), number: String(degree) },
    requestedDuration,
  );
  const pitch = inputScaleDegreePitch(anchor, degree, cursor.lane);
  return inputNoteAtCursor(score, cursor, { pitch, number: String(degree) }, requestedDuration);
}

/** Preserve one member's exact rhythmic domain while changing its part. All
 * compatibility checks precede mutation, since Alt+Up/Down edits the live model. */
function moveInputTupletNoteToPart(
  score: Score,
  sourceChord: Chord,
  sourceNote: Note,
  targetPartIndex: number,
  targetMeasure: Measure,
  targetOffset: Fraction,
): MoveInputNoteResult {
  const blocked = (): MoveInputNoteResult => ({ changed: false, sourceChord, targetChord: null, note: null });
  const sourceTuplet = sourceNote.tuplet;
  const domain = sourceTuplet ? inputTupletDomain(sourceTuplet) : null;
  const sourceDuration = sourceChord.duration;
  if (!sourceTuplet || !domain || !sourceDuration) return blocked();
  const sourceMeasureStart = sourceTuplet.first.chord.measure.position;
  const start = sourceMeasureStart.plus(domain.start).minus(targetMeasure.position);
  const end = sourceMeasureStart.plus(domain.end).minus(targetMeasure.position);
  if (start.compareTo(ZERO) < 0 || end.compareTo(measureLength(targetMeasure)) > 0) return blocked();
  const overlapping = absoluteInputTupletDomains(score.parts[targetPartIndex]).filter((candidate) =>
    candidate.absoluteStart.compareTo(targetMeasure.position.plus(end)) < 0
    && candidate.absoluteEnd.compareTo(targetMeasure.position.plus(start)) > 0);
  let targetTuplet: Tuplet | null = null;
  let targetChord = chordAt(targetMeasure, targetOffset);
  if (overlapping.length > 0) {
    const compatible = overlapping.length === 1 ? overlapping[0] : null;
    if (!compatible
      || !compatible.absoluteStart.equals(targetMeasure.position.plus(start))
      || !compatible.absoluteEnd.equals(targetMeasure.position.plus(end))
      || !compatible.actualUnit.equals(domain.actualUnit)
      || compatible.tuplet.ratioNumerator !== sourceTuplet.ratioNumerator
      || compatible.tuplet.ratioDenominator !== sourceTuplet.ratioDenominator
      || !targetChord?.duration?.equals(sourceDuration)
      || !targetChord.notes.some((note) => note.tuplet === compatible.tuplet)) return blocked();
    targetTuplet = compatible.tuplet;
  } else {
    // Existing attacks must not be erased to make room for the copied group.
    // A chord at the exact moved cell can be shared only at the same duration.
    const attacks = targetMeasure.entries.filter((entry): entry is Chord =>
      entry instanceof Chord && !entry.rest
      && entry.position.compareTo(end) < 0
      && entry.position.plus(entry.duration ?? ZERO).compareTo(start) > 0);
    if (attacks.some((entry) => !entry.position.equals(targetOffset)
      || !entry.duration?.equals(sourceDuration))) return blocked();
    targetChord = attacks[0] ?? null;
  }
  if (targetChord?.notes.some((note) => !note.rest && note.pitch === sourceNote.pitch)) return blocked();

  if (!targetTuplet) {
    const cells: Array<{ position: Fraction; duration: Fraction }> = [];
    let at = start;
    for (const member of inputTupletMembers(sourceTuplet)) {
      const position = member.measure.position.plus(member.position).minus(targetMeasure.position);
      const duration = member.duration;
      if (!duration || position.compareTo(at) < 0 || position.plus(duration).compareTo(end) > 0) return blocked();
      if (position.compareTo(at) > 0) cells.push({ position: at, duration: position.minus(at) });
      cells.push({ position, duration });
      at = position.plus(duration);
    }
    if (at.compareTo(end) < 0) cells.push({ position: at, duration: end.minus(at) });
    if (!cells.some((cell) => cell.position.equals(targetOffset) && cell.duration.equals(sourceDuration))) return blocked();

    // Cut rests at the container boundaries, preserving all silence outside.
    const rests = targetMeasure.entries.filter((entry): entry is Chord =>
      entry instanceof Chord && entry.rest && entry.position.compareTo(end) < 0
      && entry.position.plus(entry.duration ?? ZERO).compareTo(start) > 0);
    for (const rest of rests) {
      const restEnd = rest.position.plus(rest.duration ?? ZERO);
      removeEntry(targetMeasure, rest);
      if (rest.position.compareTo(start) < 0) addBeatGroupedRests(targetMeasure, rest.position, start.minus(rest.position));
      if (restEnd.compareTo(end) > 0) addBeatGroupedRests(targetMeasure, end, restEnd.minus(end));
    }
    const chords = cells.map((cell) => {
      const chord = cell.position.equals(targetOffset) && targetChord
        ? targetChord : new Chord(targetMeasure);
      chord.position = cell.position;
      if (chord.notes.length === 0) {
        chord.rest = true;
        const rest = new Note(chord);
        rest.rest = true;
        rest.number = "0";
        chord.add(rest);
      }
      setTripletWrittenDuration(chord, tupletActualToWritten(cell.duration, sourceTuplet), cell.duration);
      if (!targetMeasure.entries.includes(chord)) targetMeasure.add(chord);
      return chord;
    });
    targetChord = chords.find((chord) => chord.position.equals(targetOffset))!;
    targetTuplet = new Tuplet(chords[0].notes[0], chords[chords.length - 1].notes[0]);
    targetTuplet.scope = "voice";
    targetTuplet.partIndex = targetPartIndex;
    targetTuplet.voiceIndex = targetPartIndex + 1;
    targetTuplet.ratioNumerator = sourceTuplet.ratioNumerator;
    targetTuplet.ratioDenominator = sourceTuplet.ratioDenominator;
    targetTuplet.writtenUnit = sourceTuplet.writtenUnit;
    targetTuplet.binaryRestoreUnit = sourceTuplet.binaryRestoreUnit;
    targetTuplet.actualStart = start;
    targetTuplet.actualEnd = end;
    for (const chord of chords) for (const note of chord.notes) note.tuplet = targetTuplet;
  }

  const destination = targetChord!;
  const moved = cloneInputNote(sourceNote, destination);
  moved.tuplet = targetTuplet;
  const replacedFirst = targetTuplet.first.chord === destination;
  const replacedLast = targetTuplet.last.chord === destination;
  destination.notes = destination.notes.filter((note) => !note.rest);
  destination.rest = false;
  destination.transparentContinuation = false;
  destination.generatedTimingContinuation = false;
  destination.add(moved);
  if (replacedFirst) targetTuplet.first = destination.notes[0];
  if (replacedLast) targetTuplet.last = destination.notes[destination.notes.length - 1];
  setTripletWrittenDuration(destination, tupletActualToWritten(sourceDuration, sourceTuplet), sourceDuration);

  detachInputTie(sourceNote);
  sourceChord.notes = sourceChord.notes.filter((note) => note !== sourceNote);
  if (sourceChord.notes.length === 0) {
    const rest = new Note(sourceChord);
    rest.rest = true;
    rest.number = "0";
    rest.tuplet = sourceTuplet;
    sourceChord.add(rest);
    sourceChord.rest = true;
    sourceChord.transparentContinuation = false;
    sourceChord.generatedTimingContinuation = false;
  }
  if (sourceTuplet.first === sourceNote) sourceTuplet.first = sourceChord.notes[0];
  if (sourceTuplet.last === sourceNote) sourceTuplet.last = sourceChord.notes[sourceChord.notes.length - 1];
  // Once the voices diverge, both groups need explicit ownership in TXT.
  // Leaving an imported source group as scope="all" omits its metadata and
  // lets the other voice's bracket reinterpret the surviving members.
  sourceTuplet.scope = "voice";
  sourceTuplet.partIndex = score.parts.findIndex((part) => part.measures.includes(sourceChord.measure));
  sourceTuplet.voiceIndex = sourceTuplet.partIndex + 1;
  refreshInputTupletMarkers(sourceTuplet);
  refreshInputTupletMarkers(targetTuplet);
  sortEntries(targetMeasure);
  clearInputTimingOverlay(score);
  return { changed: true, sourceChord, targetChord: destination, note: moved };
}

/** Move one selected tone to another part at the same absolute musical time. */
export function moveInputNoteToPart(
  score: Score,
  sourcePartIndex: number,
  sourceChord: Chord,
  sourceNote: Note,
  targetPartIndex: number,
): MoveInputNoteResult {
  if (sourcePartIndex === targetPartIndex) return { changed: false, sourceChord, targetChord: sourceChord, note: sourceNote };
  const absolute = sourceChord.measure.position.plus(sourceChord.position);
  const targetPart = score.parts[targetPartIndex];
  if (!targetPart) return { changed: false, sourceChord, targetChord: null, note: null };
  const targetMeasure = targetPart.measures.find((measure) =>
    absolute.compareTo(measure.position) >= 0
    && absolute.compareTo(measure.position.plus(measureLength(measure))) < 0);
  if (!targetMeasure) return { changed: false, sourceChord, targetChord: null, note: null };
  const targetOffset = absolute.minus(targetMeasure.position);
  if (sourceNote.tuplet) {
    return moveInputTupletNoteToPart(score, sourceChord, sourceNote, targetPartIndex, targetMeasure, targetOffset);
  }
  const sourceDuration = sourceChord.duration ?? noteTimingStep(16);
  if (absoluteInputTupletDomains(targetPart).some((domain) =>
    domain.absoluteStart.compareTo(absolute.plus(sourceDuration)) < 0
    && domain.absoluteEnd.compareTo(absolute) > 0)) {
    return { changed: false, sourceChord, targetChord: null, note: null };
  }
  let targetDuration = sourceDuration;
  const measureRemaining = measureLength(targetMeasure).minus(targetOffset);
  if (measureRemaining.compareTo(targetDuration) < 0) targetDuration = measureRemaining;
  if (targetDuration.compareTo(ZERO) <= 0) {
    return { changed: false, sourceChord, targetChord: null, note: null };
  }
  let targetChord = chordAt(targetMeasure, targetOffset);
  if (!targetChord || targetChord.rest) {
    const targetRest = targetChord?.rest ? targetChord : chordCovering(targetMeasure, targetOffset);
    if (targetRest?.rest) {
      const restRemaining = targetRest.position.plus(targetRest.duration ?? ZERO).minus(targetOffset);
      if (restRemaining.compareTo(targetDuration) < 0) targetDuration = restRemaining;
      splitRestAt(targetMeasure, targetRest, targetOffset, targetDuration);
      targetChord = null;
    } else if (targetRest && !targetRest.rest && targetRest.position.compareTo(targetOffset) < 0) {
      const soundingRemaining = targetRest.position.plus(targetRest.duration ?? ZERO).minus(targetOffset);
      if (soundingRemaining.compareTo(targetDuration) < 0) targetDuration = soundingRemaining;
      const released = splitSoundingChordAt(targetMeasure, targetRest, targetOffset, targetDuration, false);
      if (released.compareTo(ZERO) > 0) {
        addBeatGroupedRests(targetMeasure, targetOffset.plus(targetDuration), released);
      }
      targetChord = null;
    }
    const existingAtTarget = chordAt(targetMeasure, targetOffset);
    targetChord = existingAtTarget && !existingAtTarget.rest ? existingAtTarget : null;
  }
  if (!targetChord) {
    targetChord = new Chord(targetMeasure);
    targetChord.position = targetOffset;
    targetChord.rest = false;
    setWrittenDuration(targetChord, targetDuration);
    targetMeasure.add(targetChord);
  }
  const moved = cloneInputNote(sourceNote, targetChord);
  targetChord.add(moved);
  detachInputTie(sourceNote);
  sourceChord.notes = sourceChord.notes.filter((note) => note !== sourceNote);
  if (sourceChord.notes.length === 0) {
    const duration = sourceChord.duration ?? noteTimingStep(16);
    removeEntry(sourceChord.measure, sourceChord);
    addRest(sourceChord.measure, sourceChord.position, duration);
  }
  sortEntries(targetMeasure);
  return { changed: true, sourceChord, targetChord, note: moved };
}

function fillRests(measure: Measure, preservedRests: ReadonlySet<Chord> = new Set()): void {
  const length = measureLength(measure);
  measure.entries = measure.entries.filter((entry) =>
    !(entry instanceof Chord && entry.rest
      && !preservedRests.has(entry)
      && !entry.notes.some((note) => note.tuplet !== null)));
  const occupied = measure.entries
    .filter((entry): entry is Chord => entry instanceof Chord
      && (!entry.rest || preservedRests.has(entry)
        || entry.notes.some((note) => note.tuplet !== null)))
    .sort((left, right) => left.position.compareTo(right.position));
  let cursor = ZERO;
  for (const chord of occupied) {
    if (chord.position.compareTo(cursor) > 0) {
      addBeatGroupedRests(measure, cursor, chord.position.minus(cursor));
    }
    const end = chord.position.plus(chord.duration ?? ZERO);
    if (end.compareTo(cursor) > 0) cursor = end;
  }
  if (cursor.compareTo(length) < 0) {
    addBeatGroupedRests(measure, cursor, length.minus(cursor));
  }
  sortEntries(measure);
}

function extendAcrossGaps(measure: Measure): void {
  const length = measureLength(measure);
  measure.entries = measure.entries.filter((entry) => !(entry instanceof Chord && entry.rest
    && !entry.notes.some((note) => note.tuplet !== null)));
  const tuplets = measure.entries.filter((entry): entry is Chord => entry instanceof Chord
    && entry.notes.some((note) => note.tuplet !== null));
  if (tuplets.length > 0) {
    // Keep the editing model explicit around a ratio-based container. Let the
    // TXT serializer hide ordinary rests when requested; stretching a binary
    // attack here would overlap the Tuplet and destroy its 3:2 boundaries.
    fillRests(measure, new Set(tuplets.filter((entry) => entry.rest)));
    return;
  }
  const sounding = measure.entries
    .filter((entry): entry is Chord => entry instanceof Chord && !entry.rest && !entry.generatedTimingContinuation)
    .filter((entry) => !entry.notes.some((note) => note.tuplet !== null))
    .sort((left, right) => left.position.compareTo(right.position));
  if (sounding.length === 0) {
    if (tuplets.length === 0) addRest(measure, ZERO, length);
    sortEntries(measure);
    return;
  }
  const first = sounding[0];
  if (first.position.compareTo(ZERO) > 0) addRest(measure, ZERO, first.position);
  const attackPositions = [...new Set(sounding.map((chord) => chord.position.toString()))]
    .map((value) => Fraction.fromString(value))
    .sort((left, right) => left.compareTo(right));
  for (const chord of sounding) {
    const next = attackPositions.find((position) => position.compareTo(chord.position) > 0);
    const end = next ?? length;
    if (end.compareTo(chord.position) > 0) setWrittenDuration(chord, end.minus(chord.position));
  }
  sortEntries(measure);
}

/** Merge a local printed tie continuation back into its attack before the
 * two ordinary source cells are transformed into a 3:2 group. The slash
 * parser may spell one logical eighth as `J` plus a tied sixteenth at the
 * next beat boundary; treating that gray segment as another attack produced
 * two triplet chords at the same position and one was reduced to zero time. */
export function absorbTripletWindowContinuations(
  measure: Measure,
  start: Fraction,
  end: Fraction,
): void {
  let merged = true;
  while (merged) {
    merged = false;
    const chords = measure.entries
      .filter((entry): entry is Chord => entry instanceof Chord)
      .sort((left, right) => left.position.compareTo(right.position));
    for (const continuation of chords) {
      if (continuation.rest
        || continuation.position.compareTo(start) < 0
        || continuation.position.compareTo(end) >= 0) continue;
      const sounding = continuation.notes.filter((note) => !note.rest);
      if (sounding.length === 0 || sounding.some((note) => note.tiePrev === null)) continue;
      const roots = new Set(sounding.map((note) => note.tiePrev!.chord));
      if (roots.size !== 1) continue;
      const root = [...roots][0];
      if (root.measure !== measure
        || root.position.compareTo(start) < 0
        || root.position.plus(root.duration ?? ZERO).compareTo(continuation.position) !== 0) continue;
      const rootNotes = root.notes.filter((note) => !note.rest);
      const pairs = rootNotes.map((note) => sounding.find((candidate) => candidate.tiePrev === note) ?? null);
      if (pairs.some((note) => note === null) || pairs.length !== sounding.length) continue;

      setWrittenDuration(root, (root.duration ?? ZERO).plus(continuation.duration ?? ZERO));
      rootNotes.forEach((note, index) => {
        const continued = pairs[index]!;
        const next = continued.tieNext;
        note.tieStart = next !== null;
        note.tieNext = next;
        if (next) {
          next.tiePrev = note;
          next.tieEnd = true;
        }
        continued.tiePrev = null;
        continued.tieNext = null;
        continued.tieStart = false;
        continued.tieEnd = false;
      });
      removeEntry(measure, continuation);
      merged = true;
      break;
    }
  }
}

/** Finalize one input measure, choosing explicit rests or implicit sustain. */
export function completeInputMeasure(
  score: Score,
  cursor: Pick<NotationCursor, "partIndex" | "measureIndex">,
  showExplicitRests: boolean,
): Measure {
  const measure = ensureInputMeasure(score, cursor.partIndex, cursor.measureIndex).measure;
  if (showExplicitRests) fillRests(measure);
  else extendAcrossGaps(measure);
  return measure;
}

interface AbsoluteInputTupletDomain extends InputTupletDomain {
  tuplet: Tuplet;
  measure: Measure;
  absoluteStart: Fraction;
  absoluteEnd: Fraction;
}

interface InputDomainMovePiece {
  absolute: Fraction;
  actual: Fraction;
  written: Fraction;
  domain: AbsoluteInputTupletDomain | null;
}

export interface InputDomainMoveResult {
  /** False lets callers use the ordinary binary timeline mover. */
  handled: boolean;
  changed: boolean;
  note: Note | null;
  delta: Fraction;
}

function absoluteInputTupletDomains(part: Part): AbsoluteInputTupletDomain[] {
  const tuplets = new Set<Tuplet>();
  for (const measure of part.measures) {
    for (const entry of measure.entries) {
      if (!(entry instanceof Chord)) continue;
      for (const note of entry.notes) if (note.tuplet) tuplets.add(note.tuplet);
    }
  }
  return [...tuplets].flatMap((tuplet) => {
    const domain = inputTupletDomain(tuplet);
    if (!domain) return [];
    const measure = tuplet.first.chord.measure;
    return [{
      ...domain,
      tuplet,
      measure,
      absoluteStart: measure.position.plus(domain.start),
      absoluteEnd: measure.position.plus(domain.end),
    }];
  }).sort((left, right) => left.absoluteStart.compareTo(right.absoluteStart));
}

function absoluteTupletDomainAt(
  domains: readonly AbsoluteInputTupletDomain[],
  position: Fraction,
): AbsoluteInputTupletDomain | null {
  return domains.find((domain) =>
    position.compareTo(domain.absoluteStart) >= 0
    && position.compareTo(domain.absoluteEnd) < 0) ?? null;
}

function inputDomainMoveDelta(
  domains: readonly AbsoluteInputTupletDomain[],
  focus: Fraction,
  writtenStep: Fraction,
  direction: -1 | 1,
): Fraction {
  const normal = writtenStep.timesInt(direction);
  const current = absoluteTupletDomainAt(domains, focus);
  if (current) {
    // Inside a fixed 3:2 container the member grid is authoritative.  A
    // global eighth/quarter selection must not make a 32nd-member tuplet jump
    // over cells or merge with the following equal pitch.
    const internal = current.actualUnit.timesInt(direction);
    const candidate = focus.plus(internal);
    if (candidate.compareTo(current.absoluteStart) >= 0
      && candidate.compareTo(current.absoluteEnd) < 0) return internal;
    // A note that starts inside a fixed 3:2 container cannot be moved out of
    // that container. Cursor navigation remains independent and can still
    // cross the closing bracket.
    return ZERO;
  }

  const normalTarget = focus.plus(normal);
  const target = absoluteTupletDomainAt(domains, normalTarget);
  if (target) {
    const internal = target.actualUnit.timesInt(direction);
    const internalTarget = focus.plus(internal);
    if (internalTarget.compareTo(target.absoluteStart) >= 0
      && internalTarget.compareTo(target.absoluteEnd) < 0) return internal;
    // Snap an entering move to the first/last real member anchor instead of
    // landing between the binary ruler and the compressed triplet grid.
    const anchor = direction > 0
      ? target.absoluteStart
      : target.absoluteEnd.minus(target.actualUnit);
    return anchor.minus(focus);
  }

  const crossed = direction > 0
    ? domains.find((domain) => domain.absoluteStart.compareTo(focus) > 0
      && domain.absoluteStart.compareTo(normalTarget) <= 0)
    : [...domains].reverse().find((domain) => domain.absoluteEnd.compareTo(focus) <= 0
      && domain.absoluteEnd.compareTo(normalTarget) >= 0);
  if (!crossed) return normal;
  const anchor = direction > 0
    ? crossed.absoluteStart
    : crossed.absoluteEnd.minus(crossed.actualUnit);
  return anchor.minus(focus);
}

function inputMeasureAtAbsolute(part: Part, position: Fraction): Measure | null {
  return part.measures.find((measure) => {
    const end = measure.position.plus(measureLength(measure));
    return position.compareTo(measure.position) >= 0 && position.compareTo(end) < 0;
  }) ?? null;
}

function planInputDomainMove(
  part: Part,
  domains: readonly AbsoluteInputTupletDomain[],
  start: Fraction,
  writtenSegments: readonly Fraction[],
): InputDomainMovePiece[] | null {
  const pieces: InputDomainMovePiece[] = [];
  let position = start;
  let guard = 0;
  for (const segment of writtenSegments) {
    let remaining = segment;
    while (remaining.compareTo(ZERO) > 0 && guard++ < 1024) {
      const measure = inputMeasureAtAbsolute(part, position);
      if (!measure) return null;
      const measureEnd = measure.position.plus(measureLength(measure));
      const domain = absoluteTupletDomainAt(domains, position);
      let boundary = measureEnd;
      if (domain) {
        if (domain.absoluteEnd.compareTo(boundary) < 0) boundary = domain.absoluteEnd;
      } else {
        const next = domains.find((candidate) =>
          candidate.absoluteStart.compareTo(position) > 0
          && candidate.absoluteStart.compareTo(boundary) < 0);
        if (next) boundary = next.absoluteStart;
      }
      const available = boundary.minus(position);
      if (available.compareTo(ZERO) <= 0) return null;
      const desiredActual = domain
        ? tupletWrittenToActual(remaining, domain.tuplet)
        : remaining;
      const actual = desiredActual.compareTo(available) <= 0 ? desiredActual : available;
      const written = domain
        ? tupletActualToWritten(actual, domain.tuplet)
        : actual;
      if (actual.compareTo(ZERO) <= 0 || written.compareTo(ZERO) <= 0) return null;
      pieces.push({ absolute: position, actual, written, domain });
      position = position.plus(actual);
      remaining = remaining.minus(written);
    }
  }
  return guard < 1024 ? pieces : null;
}

/** Move one semantic tied note while preserving the fixed 3:2 containers it
 * crosses. Each printed segment is remapped by its destination domain: inside
 * a Tuplet it uses compressed real time, outside it uses ordinary time. */
export function moveInputTieChainByNotationDomain(
  score: Score,
  partIndex: number,
  focusNote: Note,
  writtenStep: Fraction,
  direction: -1 | 1,
): InputDomainMoveResult {
  const part = score.parts[partIndex];
  if (!part || writtenStep.compareTo(ZERO) <= 0 || focusNote.rest) {
    return { handled: false, changed: false, note: null, delta: ZERO };
  }
  const domains = absoluteInputTupletDomains(part);
  if (domains.length === 0) {
    return { handled: false, changed: false, note: null, delta: ZERO };
  }
  const chain = inputTieChain(focusNote);
  const root = chain[0];
  if (!root) return { handled: false, changed: false, note: null, delta: ZERO };
  const focus = focusNote.chord.measure.position.plus(focusNote.chord.position);
  const delta = inputDomainMoveDelta(domains, focus, writtenStep, direction);
  if (delta.equals(ZERO)) return { handled: true, changed: false, note: root, delta };
  const rootStart = root.chord.measure.position.plus(root.chord.position);
  const targetStart = rootStart.plus(delta);
  const writtenSegments = chain.map((note) => note.tuplet
    ? tupletActualToWritten(note.chord.duration ?? ZERO, note.tuplet)
    : note.chord.duration ?? writtenDuration(note.chord));
  const pieces = planInputDomainMove(part, domains, targetStart, writtenSegments);
  const touchesTuplet = chain.some((note) => note.tuplet !== null)
    || pieces?.some((piece) => piece.domain !== null);
  if (!touchesTuplet) {
    return { handled: false, changed: false, note: null, delta };
  }
  if (!pieces || pieces.length === 0) {
    return { handled: true, changed: false, note: root, delta };
  }
  const targetTuplet = pieces[0]?.domain?.tuplet ?? null;
  if (targetTuplet && pieces.some((piece) => piece.domain?.tuplet !== targetTuplet)) {
    // Do not split a moved note/tie chain across the closing edge.  Every
    // destination segment must remain in the same Tuplet domain once its
    // first segment lands inside it.
    return { handled: true, changed: false, note: root, delta };
  }

  const chainSet = new Set(chain);
  for (const piece of pieces) {
    const pieceEnd = piece.absolute.plus(piece.actual);
    const collision = part.measures.some((measure) => measure.entries.some((entry) => {
      if (!(entry instanceof Chord)) return false;
      const remaining = entry.notes.filter((note) => !note.rest && !chainSet.has(note));
      if (remaining.length === 0) return false;
      const start = measure.position.plus(entry.position);
      const end = start.plus(entry.duration ?? ZERO);
      if (end.compareTo(piece.absolute) <= 0 || start.compareTo(pieceEnd) >= 0) return false;
      if (!start.equals(piece.absolute) || !(entry.duration ?? ZERO).equals(piece.actual)) return true;
      if (!piece.domain) return remaining.some((note) => note.tuplet !== null);
      return remaining.some((note) => note.tuplet !== piece.domain!.tuplet);
    }));
    if (collision) return { handled: true, changed: false, note: root, delta };
  }

  const affectedMeasures = new Set<Measure>();
  const affectedTuplets = new Set<Tuplet>(domains.map((domain) => domain.tuplet));
  const sourceVoice = root.chord.voice;
  const sourceStemUp = root.chord.stemUp;
  for (const member of chain) {
    const chord = member.chord;
    const tuplet = member.tuplet;
    affectedMeasures.add(chord.measure);
    detachInputTie(member);
    const remaining = chord.notes.filter((note) => note !== member && !note.rest);
    if (remaining.length > 0) {
      chord.notes = chord.notes.filter((note) => note !== member);
      const boundary = tuplet
        ? chord.notes.find((note) => note.tuplet === tuplet) ?? null
        : null;
      if (tuplet?.first === member && boundary) tuplet.first = boundary;
      if (tuplet?.last === member && boundary) tuplet.last = boundary;
      continue;
    }
    if (tuplet) {
      const rest = new Note(chord);
      rest.rest = true;
      rest.number = "0";
      rest.tuplet = tuplet;
      rest.tupletBegin = member.tupletBegin;
      rest.tupletEnd = member.tupletEnd;
      chord.notes = [];
      chord.add(rest);
      chord.rest = true;
      chord.transparentContinuation = false;
      chord.generatedTimingContinuation = false;
      if (tuplet.first === member) tuplet.first = rest;
      if (tuplet.last === member) tuplet.last = rest;
    } else {
      removeEntry(chord.measure, chord);
    }
  }

  const movedNotes: Note[] = [];
  for (let index = 0; index < pieces.length; index++) {
    const piece = pieces[index];
    const measure = inputMeasureAtAbsolute(part, piece.absolute);
    if (!measure) return { handled: true, changed: false, note: root, delta };
    const local = piece.absolute.minus(measure.position);
    affectedMeasures.add(measure);

    // A combined member may cover one or more explicit tuplet zeroes.
    if (piece.domain) {
      const pieceEnd = local.plus(piece.actual);
      const overlappingRests = measure.entries.filter((entry): entry is Chord => {
        if (!(entry instanceof Chord) || !entry.rest) return false;
        if (!entry.notes.some((note) => note.tuplet === piece.domain!.tuplet)) return false;
        const end = entry.position.plus(entry.duration ?? ZERO);
        return end.compareTo(local) > 0 && entry.position.compareTo(pieceEnd) < 0;
      });
      for (const rest of overlappingRests) {
        const start = rest.position;
        const end = start.plus(rest.duration ?? ZERO);
        removeEntry(measure, rest);
        // Moving a long member by one fine tuplet cell often overlaps only
        // half of the released source rest.  Deleting that whole rest shrinks
        // the Tuplet domain and moves the unused half onto the ordinary beat
        // (`[01.]` became `[1.]0....`). Preserve both non-overlapping pieces
        // as exact compressed rests inside the same Tuplet.
        const preserveRest = (position: Fraction, duration: Fraction): void => {
          if (duration.compareTo(ZERO) <= 0) return;
          const fragment = addRest(measure, position, duration);
          for (const note of fragment.notes) note.tuplet = piece.domain!.tuplet;
          setTripletWrittenDuration(
            fragment,
            tupletActualToWritten(duration, piece.domain!.tuplet),
            duration,
          );
        };
        if (start.compareTo(local) < 0) preserveRest(start, local.minus(start));
        if (end.compareTo(pieceEnd) > 0) preserveRest(pieceEnd, end.minus(pieceEnd));
      }
      piece.domain.tuplet.writtenUnit = piece.domain.writtenUnit;
    }

    let target = measure.entries.find((entry): entry is Chord =>
      entry instanceof Chord && !entry.rest && entry.position.equals(local)) ?? null;
    if (!target) {
      target = new Chord(measure);
      target.position = local;
      target.voice = sourceVoice;
      target.stemUp = sourceStemUp;
      measure.add(target);
    }
    target.notes = target.notes.filter((note) => !note.rest);
    target.rest = false;
    target.generatedTimingContinuation = false;
    target.transparentContinuation = index > 0 && target.notes.length === 0;
    if (piece.domain) setTripletWrittenDuration(target, piece.written, piece.actual);
    else setWrittenDuration(target, piece.actual);

    const moved = index === 0 ? root : cloneInputNote(root, target);
    moved.chord = target;
    moved.tiePrev = null;
    moved.tieNext = null;
    moved.tieStart = false;
    moved.tieEnd = false;
    moved.tuplet = piece.domain?.tuplet ?? null;
    moved.tupletBegin = false;
    moved.tupletEnd = false;
    target.add(moved);
    movedNotes.push(moved);
  }

  for (let index = 0; index + 1 < movedNotes.length; index++) {
    const left = movedNotes[index];
    const right = movedNotes[index + 1];
    left.tieStart = true;
    left.tieNext = right;
    right.tieEnd = true;
    right.tiePrev = left;
  }
  for (const tuplet of affectedTuplets) refreshInputTupletMarkers(tuplet);
  for (const measure of affectedMeasures) fillRests(measure);
  normalizeScoreRestSpelling(score);
  score.noteTimingEdits = [];
  return { handled: true, changed: true, note: root, delta };
}

/** Split exactly the note value at the cursor into a 3:2 container.
 *
 * The current note supplies the complete real span.  It becomes the first
 * member and two explicit rests become the remaining members; following
 * attacks are never pulled into the bracket.  Thus a sixteenth becomes three
 * written thirty-seconds in the time of that sixteenth, while an eighth
 * becomes three written sixteenths in the time of that eighth.  On empty
 * space the selected toolbar value is used as the container span.
 *
 * `sourceCellDuration` remains as a compatibility/fallback argument for
 * callers that know the selected binary cell separately.  It no longer makes
 * the operation consume a second source cell. */
export function createInputTriplet(
  score: Score,
  cursor: Pick<NotationCursor, "partIndex" | "measureIndex" | "offset">,
  nominalDuration: Fraction,
  sourceCellDuration: Fraction = nominalDuration,
): InputTripletResult {
  const measure = score.parts[cursor.partIndex]?.measures[cursor.measureIndex];
  const written = WRITTEN_DURATIONS.find((item) => item.value.equals(nominalDuration));
  const sourceWritten = WRITTEN_DURATIONS.find((item) => item.value.equals(sourceCellDuration));
  if (!measure || !written || !sourceWritten
    || nominalDuration.compareTo(ZERO) <= 0
    || sourceCellDuration.compareTo(nominalDuration) < 0) {
    return { changed: false, chords: [], reason: "invalid-duration" };
  }
  const start = cursor.offset;
  const currentAtCursor = measure.entries
    .filter((entry): entry is Chord => entry instanceof Chord)
    .find((chord) => chord.position.equals(start)) ?? null;
  const currentWrittenDuration = currentAtCursor && !currentAtCursor.rest
    ? undottedWrittenDuration(currentAtCursor)
    : null;
  const sourceDuration = currentWrittenDuration?.compareTo(ZERO) === 1
    ? currentWrittenDuration
    : sourceCellDuration;
  const groupSpan = sourceDuration;
  const end = start.plus(groupSpan);
  if (start.compareTo(ZERO) < 0 || groupSpan.compareTo(ZERO) <= 0
    || end.compareTo(measureLength(measure)) > 0) {
    return { changed: false, chords: [], reason: "cross-measure" };
  }
  const memberDuration = groupSpan.divInt(3);
  const entries = measure.entries
    .filter((entry): entry is Chord => entry instanceof Chord)
    .sort((left, right) => left.position.compareTo(right.position));
  if (currentAtCursor?.notes.some((note) => note.tuplet !== null)) {
    return { changed: false, chords: [], reason: "overlapping-tuplet" };
  }
  const conflictingAttack = entries.some((chord) => {
    if (chord === currentAtCursor || chord.rest) return false;
    const chordEnd = chord.position.plus(chord.duration ?? ZERO);
    return chord.position.compareTo(end) < 0 && chordEnd.compareTo(start) > 0;
  });
  if (conflictingAttack) {
    return { changed: false, chords: [], reason: "finer-rhythm" };
  }
  const releasedTailMeasures = new Set<Measure>();
  const tripletChords: Chord[] = [];
  if (currentAtCursor && !currentAtCursor.rest) {
    // The old two-cell transformation generated a tied tail at `end`, which
    // was the extra note users saw after an eighth-note triplet.  The current
    // note is now the whole container, so its outside tie is detached rather
    // than recreated after the bracket.
    for (const note of currentAtCursor.notes) {
      const generatedTail: Note[] = [];
      const seen = new Set<Note>();
      let next = note.tieNext;
      while (next && !seen.has(next)
        && (next.chord.generatedTimingContinuation || next.chord.transparentContinuation)) {
        seen.add(next);
        generatedTail.push(next);
        next = next.tieNext;
      }
      detachInputTie(note);
      for (const tail of generatedTail) {
        const tailChord = tail.chord;
        detachInputTie(tail);
        tailChord.notes = tailChord.notes.filter((candidate) => candidate !== tail);
        if (tailChord.notes.every((candidate) => candidate.rest)) {
          removeEntry(tailChord.measure, tailChord);
          releasedTailMeasures.add(tailChord.measure);
        } else {
          tailChord.rest = false;
        }
      }
    }
    currentAtCursor.generatedTimingContinuation = false;
    currentAtCursor.persistGeneratedContinuation = false;
    currentAtCursor.transparentContinuation = false;
    setTripletWrittenDuration(currentAtCursor, sourceDuration.divInt(2), memberDuration);
    tripletChords.push(currentAtCursor);
  }

  // Replace only silence inside this one current value.  A following attack
  // exactly at `end` remains untouched.
  measure.entries = measure.entries.filter((entry) => {
    if (!(entry instanceof Chord) || !entry.rest) return true;
    const entryEnd = entry.position.plus(entry.duration ?? ZERO);
    return entryEnd.compareTo(start) <= 0 || entry.position.compareTo(end) >= 0;
  });
  const tupleRests = new Set<Chord>();
  for (let index = 0; index < 3; index++) {
    const position = start.plus(memberDuration.timesInt(index));
    const covered = tripletChords.some((chord) =>
      chord.position.compareTo(position) <= 0
      && chord.position.plus(chord.duration ?? ZERO).compareTo(position) > 0);
    if (covered) continue;
    const rest = addRest(measure, position, memberDuration);
    setTripletWrittenDuration(rest, sourceDuration.divInt(2), memberDuration);
    tupleRests.add(rest);
    tripletChords.push(rest);
  }
  tripletChords.sort((left, right) => left.position.compareTo(right.position));
  const first = tripletChords[0]?.notes[0];
  const last = tripletChords[tripletChords.length - 1]?.notes[0];
  if (!first || !last) return { changed: false, chords: [] };
  const tuplet = new Tuplet(first, last);
  tuplet.partIndex = cursor.partIndex;
  tuplet.voiceIndex = score.parts[cursor.partIndex]?.voiceIndex ?? cursor.partIndex + 1;
  tuplet.scope = "voice";
  tuplet.writtenUnit = sourceDuration.divInt(2);
  tuplet.binaryRestoreUnit = sourceDuration;
  tuplet.actualStart = start;
  tuplet.actualEnd = end;
  tripletChords.forEach((chord, index) => {
    // Mordents and trills are semantic repetitions of one ordinary note and
    // cannot themselves live inside a real 3:2 container. Creating a tuplet
    // over such a chord deterministically removes the incompatible ornament.
    chord.ornaments = [];
    for (const note of chord.notes) {
      note.tuplet = tuplet;
      note.tupletBegin = index === 0;
      note.tupletEnd = index === tripletChords.length - 1;
    }
  });
  tuplet.refreshTiming();
  fillRests(measure, tupleRests);
  for (const released of releasedTailMeasures) {
    if (released !== measure) fillRests(released);
  }
  score.noteTimingEdits = [];
  return { changed: true, chords: tripletChords };
}

/** Remove one explicit tuplet and expand its printed values into the
 * following free space. If the next attack leaves no room, trailing members
 * are dropped (ABC -> AB); an oversized dotted member is shortened to the
 * largest ordinary value that still fits. */
export function removeInputTriplet(score: Score, tuplet: Tuplet): RemoveInputTripletResult {
  const measure = tuplet.first.chord.measure;
  if (tuplet.last.chord.measure !== measure) return { changed: false, kept: [], dropped: 0 };
  const members = measure.entries
    .filter((entry): entry is Chord => entry instanceof Chord
      && entry.notes.some((note) => note.tuplet === tuplet))
    .sort((left, right) => left.position.compareTo(right.position));
  if (members.length === 0) return { changed: false, kept: [], dropped: 0 };
  const memberSet = new Set(members);
  const targetPartIndex = tuplet.partIndex;
  const start = members[0].position;
  const groupEnd = members.reduce((latest, chord) => {
    const chordEnd = chord.position.plus(chord.duration ?? ZERO);
    return chordEnd.compareTo(latest) > 0 ? chordEnd : latest;
  }, start);
  const nextAttack = measure.entries
    .filter((entry): entry is Chord => entry instanceof Chord
      && !memberSet.has(entry)
      && !entry.rest
      && (targetPartIndex === null || targetPartIndex === undefined
        || score.parts[targetPartIndex]?.measures.includes(entry.measure))
      && entry.position.compareTo(groupEnd) >= 0)
    .sort((left, right) => left.position.compareTo(right.position))[0];
  const availableEnd = nextAttack?.position ?? measureLength(measure);
  measure.entries = measure.entries.filter((entry) => {
    if (entry instanceof Chord && memberSet.has(entry)) return false;
    if (!(entry instanceof Chord) || !entry.rest) return true;
    const restEnd = entry.position.plus(entry.duration ?? ZERO);
    return restEnd.compareTo(start) <= 0 || entry.position.compareTo(availableEnd) >= 0;
  });

  const kept: Chord[] = [];
  let dropped = 0;
  let cursor = start;
  const restoreUnit = tuplet.binaryRestoreUnit ?? tuplet.writtenUnit ?? new Fraction(1, 16);
  const ordinaryValues = WRITTEN_DURATIONS.filter((item) => item.dot === 0)
    .map((item) => item.value)
    .sort((left, right) => right.compareTo(left));
  for (const chord of members) {
    for (const note of chord.notes) {
      note.tuplet = null;
      note.tupletBegin = false;
      note.tupletEnd = false;
    }
    const remaining = availableEnd.minus(cursor);
    if (remaining.compareTo(ZERO) <= 0) {
      for (const note of chord.notes) detachInputTie(note);
      dropped++;
      continue;
    }
    const desired = writtenDuration(chord);
    const restored = [...ordinaryValues].reverse().find((value) =>
      value.compareTo(restoreUnit) >= 0 && value.compareTo(desired) >= 0) ?? restoreUnit;
    const duration = restored.compareTo(remaining) <= 0
      ? restored
      : ordinaryValues.find((value) => value.compareTo(restoreUnit) >= 0
        && value.compareTo(remaining) <= 0) ?? ZERO;
    if (duration.compareTo(ZERO) <= 0) {
      for (const note of chord.notes) detachInputTie(note);
      dropped++;
      continue;
    }
    chord.position = cursor;
    chord.transparentContinuation = chord.notes.some((note) => note.tiePrev !== null);
    setWrittenDuration(chord, duration);
    measure.add(chord);
    kept.push(chord);
    cursor = cursor.plus(duration);
  }
  fillRests(measure);
  score.noteTimingEdits = [];
  tuplet.actualStart = null;
  tuplet.actualEnd = null;
  tuplet.writtenUnit = null;
  tuplet.binaryRestoreUnit = null;
  return { changed: true, kept, dropped };
}

/** Real cursor step for a note/rest that belongs to a 3:2 group. */
export function inputTripletCellDuration(note: Note): Fraction | null {
  const tuplet = note.tuplet;
  if (!tuplet || tuplet.first.chord.measure !== tuplet.last.chord.measure) return null;
  // `inputTupletDomain` also restores the conventional empty third cell of
  // a hand-written two-member group.  Deriving the step from `last` alone
  // made that group use a 2/3-sized cell and caused the third cell to fall
  // back to the ordinary binary ruler during editing.
  return inputTupletDomain(tuplet)?.actualUnit ?? null;
}

/**
 * Move the notation cursor along the real member positions of the tuplet it
 * currently touches.  Plain left/right input navigation must not land on the
 * surrounding binary ruler while it is inside a 3:2 container.
 */
export function inputTripletCursorDelta(
  score: Score,
  cursor: Pick<NotationCursor, "partIndex" | "measureIndex" | "offset">,
  direction: -1 | 1,
): Fraction | null {
  const measure = score.parts[cursor.partIndex]?.measures[cursor.measureIndex];
  if (!measure) return null;
  const byTuplet = new Map<Tuplet, Chord[]>();
  for (const entry of measure.entries) {
    if (!(entry instanceof Chord)) continue;
    for (const tuplet of new Set(entry.notes.flatMap((note) => note.tuplet ? [note.tuplet] : []))) {
      const members = byTuplet.get(tuplet) ?? [];
      if (!members.includes(entry)) members.push(entry);
      byTuplet.set(tuplet, members);
    }
  }
  for (const members of byTuplet.values()) {
    members.sort((left, right) => left.position.compareTo(right.position));
    const first = members[0];
    const last = members[members.length - 1];
    if (!first || !last) continue;
    const tuplet = first.notes.find((note) => note.tuplet)?.tuplet ?? null;
    const domain = tuplet ? inputTupletDomain(tuplet) : null;
    const start = domain?.start ?? first.position;
    const end = domain?.end ?? last.position.plus(last.duration ?? ZERO);
    const within = direction > 0
      ? cursor.offset.compareTo(start) >= 0 && cursor.offset.compareTo(end) < 0
      : cursor.offset.compareTo(start) > 0 && cursor.offset.compareTo(end) <= 0;
    if (!within) continue;
    const positions = members.map((chord) => chord.position);
    // A compact JPW group may intentionally close after two equal members;
    // expose the inferred third anchor so left/right navigation can enter
    // the vacant cell that inputNoteAtCursor already knows how to fill.
    if (domain && tuplet && members.length === 2) {
      const third = domain.start.plus(domain.actualUnit.timesInt(2));
      if (!positions.some((position) => position.equals(third))) positions.push(third);
      positions.sort((left, right) => left.compareTo(right));
    }
    if (direction > 0) {
      const next = positions.find((position) => position.compareTo(cursor.offset) > 0) ?? end;
      const delta = next.minus(cursor.offset);
      return delta.compareTo(ZERO) > 0 ? delta : null;
    }
    const previous = [...positions].reverse()
      .find((position) => position.compareTo(cursor.offset) < 0) ?? start;
    const delta = previous.minus(cursor.offset);
    return delta.compareTo(ZERO) < 0 ? delta : null;
  }
  return null;
}

export interface InputTupletResizeResult {
  changed: boolean;
  blocked: boolean;
  chord: Chord | null;
  tuplet: Tuplet | null;
  outside?: boolean;
  consumed?: Fraction;
  continuation?: Chord | null;
}

function refreshInputTupletMarkers(tuplet: Tuplet): void {
  const members = inputTupletMembers(tuplet);
  if (members.length === 0) return;
  for (const chord of members) {
    for (const note of chord.notes) {
      note.tupletBegin = false;
      note.tupletEnd = false;
    }
  }
  const first = members[0];
  const last = members[members.length - 1];
  for (const note of first.notes) if (note.tuplet === tuplet) note.tupletBegin = true;
  for (const note of last.notes) if (note.tuplet === tuplet) note.tupletEnd = true;
  tuplet.first = first.notes.find((note) => note.tuplet === tuplet) ?? tuplet.first;
  tuplet.last = last.notes.find((note) => note.tuplet === tuplet) ?? tuplet.last;
  tuplet.refreshTiming();
}

/**
 * Resize one member without leaving its 3:2 container. Negative delta releases
 * a same-tuplet rest immediately after the selected member. Positive delta
 * consumes only an adjacent rest or same-pitch gray continuation; a black
 * attack is never swallowed.
 */
export function resizeInputTupletMember(
  score: Score,
  note: Note,
  delta: Fraction,
): InputTupletResizeResult {
  const tuplet = note.tuplet;
  if (!tuplet || delta.equals(ZERO)) {
    return { changed: false, blocked: false, chord: note.chord, tuplet: tuplet ?? null };
  }
  const members = inputTupletMembers(tuplet);
  const index = members.findIndex((chord) => chord === note.chord);
  if (index < 0 || !note.chord.duration) {
    return { changed: false, blocked: true, chord: note.chord, tuplet };
  }
  const amount = delta.compareTo(ZERO) > 0 ? delta : delta.timesInt(-1);
  const currentDuration = note.chord.duration;
  if (delta.compareTo(ZERO) < 0 && amount.compareTo(currentDuration) >= 0) {
    return { changed: false, blocked: true, chord: note.chord, tuplet };
  }

  if (delta.compareTo(ZERO) < 0) {
    const resized = currentDuration.minus(amount);
    // A newly released cell is silence.  A tie from the shortened member
    // would otherwise continue sounding through that rest (especially when
    // the member had previously been extended beyond the tuplet boundary).
    // Keep a valid incoming tie from the preceding member, but turn the
    // following segment into a fresh attack.
    for (const shortenedNote of note.chord.notes.filter((item) => !item.rest)) {
      const outgoing = shortenedNote.tieNext;
      if (!outgoing) continue;
      shortenedNote.tieNext = null;
      shortenedNote.tieStart = false;
      outgoing.tiePrev = null;
      outgoing.tieEnd = false;
      if (outgoing.chord.transparentContinuation
        && outgoing.chord.notes.every((item) => item.rest || item.tiePrev === null)) {
        outgoing.chord.transparentContinuation = false;
        outgoing.chord.generatedTimingContinuation = false;
      }
    }
    const rest = new Chord(note.chord.measure);
    rest.position = note.chord.position.plus(resized);
    rest.rest = true;
    const restNote = new Note(rest);
    restNote.rest = true;
    restNote.number = "0";
    restNote.tuplet = tuplet;
    rest.add(restNote);
    setTripletWrittenDuration(rest, tupletActualToWritten(amount, tuplet), amount);
    setTripletWrittenDuration(note.chord, tupletActualToWritten(resized, tuplet), resized);
    note.chord.measure.add(rest);
    refreshInputTupletMarkers(tuplet);
    score.noteTimingEdits = [];
    return { changed: true, blocked: false, chord: note.chord, tuplet, consumed: ZERO };
  }

  const currentEnd = note.chord.position.plus(currentDuration);
  const next = inputTupletMembers(tuplet).find((candidate) => candidate.position.equals(currentEnd));
  const samePitch = (left: Chord, right: Chord): boolean => {
    const a = left.notes.filter((item) => !item.rest).map((item) => item.pitch).sort();
    const b = right.notes.filter((item) => !item.rest).map((item) => item.pitch).sort();
    return a.length > 0 && a.length === b.length && a.every((pitch, i) => pitch === b[i]);
  };
  const grayContinuation = next && !next.rest
    && (next.transparentContinuation || next.notes.every((item) => item.tieEnd))
    && samePitch(note.chord, next);
  if (!next || (!next.rest && !grayContinuation)) {
    return { changed: false, blocked: true, outside: !next, chord: note.chord, tuplet };
  }
  const consume = next.duration && next.duration.compareTo(amount) <= 0 ? next.duration : amount;
  if (!consume || consume.compareTo(ZERO) <= 0) {
    return { changed: false, blocked: true, chord: note.chord, tuplet };
  }
  const resized = currentDuration.plus(consume);
  const remaining = (next.duration ?? ZERO).minus(consume);
  setTripletWrittenDuration(
    note.chord,
    tupletActualToWritten(resized, tuplet),
    resized,
  );
  if (remaining.compareTo(ZERO) <= 0) {
    for (const memberNote of next.notes) {
      if (!memberNote.rest) detachInputTie(memberNote);
      memberNote.tuplet = null;
      memberNote.tupletBegin = false;
      memberNote.tupletEnd = false;
    }
    removeEntry(next.measure, next);
  } else {
    next.position = next.position.plus(consume);
    setTripletWrittenDuration(next, tupletActualToWritten(remaining, tuplet), remaining);
  }
  refreshInputTupletMarkers(tuplet);
  score.noteTimingEdits = [];
  return { changed: true, blocked: false, chord: note.chord, tuplet, consumed: consume };
}

/** Alias used by cursor integrations that describe the operation as a resize. */
export const resizeInputTuplet = resizeInputTupletMember;

export interface InputTupletOutsideExtension {
  changed: boolean;
  blocked: boolean;
  consumed: Fraction;
  continuation: Chord | null;
}

/** Extend the final sounding member beyond a Tuplet without carrying the
 * Tuplet marker into the ordinary rhythm after its boundary. */
export function extendInputTupletOutside(
  score: Score,
  note: Note,
  ordinaryAmount: Fraction,
): InputTupletOutsideExtension {
  const tuplet = note.tuplet;
  if (!tuplet || ordinaryAmount.compareTo(ZERO) <= 0) {
    return { changed: false, blocked: true, consumed: ZERO, continuation: null };
  }
  const members = inputTupletMembers(tuplet);
  const sounding = members.filter((entry) => !entry.rest && entry.notes.some((item) => !item.rest));
  const source = sounding[sounding.length - 1];
  if (!source?.duration) {
    return { changed: false, blocked: true, consumed: ZERO, continuation: null };
  }
  const boundary = tuplet.actualEnd ?? source.position.plus(source.duration);
  if (!source.position.plus(source.duration).equals(boundary)) {
    return { changed: false, blocked: true, consumed: ZERO, continuation: null };
  }
  const rest = source.measure.entries.find((entry): entry is Chord =>
    entry instanceof Chord && entry.rest && entry.notes.every((item) => item.tuplet === null)
      && entry.position.equals(boundary)) ?? null;
  if (!rest?.duration) {
    return { changed: false, blocked: true, consumed: ZERO, continuation: null };
  }
  const consumed = rest.duration.compareTo(ordinaryAmount) < 0 ? rest.duration : ordinaryAmount;
  const continuation = new Chord(source.measure);
  continuation.position = boundary;
  continuation.rest = false;
  continuation.transparentContinuation = true;
  continuation.generatedTimingContinuation = false;
  setWrittenDuration(continuation, consumed);
  for (const sourceNote of source.notes.filter((item) => !item.rest)) {
    const target = cloneInputNote(sourceNote, continuation);
    target.tuplet = null;
    target.tupletBegin = false;
    target.tupletEnd = false;
    target.tiePrev = sourceNote;
    target.tieEnd = true;
    sourceNote.tieNext = target;
    sourceNote.tieStart = true;
    continuation.add(target);
  }
  source.measure.add(continuation);
  if (rest.duration.equals(consumed)) {
    removeEntry(rest.measure, rest);
  } else {
    rest.position = rest.position.plus(consumed);
    setWrittenDuration(rest, rest.duration.minus(consumed));
  }
  sortEntries(source.measure);
  score.noteTimingEdits = [];
  return { changed: true, blocked: false, consumed, continuation };
}

/** Apply a meter at one measure and keep it active until the next explicit
 * meter change. Chords outside the shortened bar are removed, crossing
 * chords are clipped at the new barline, and every following absolute
 * measure position is rebuilt. */
export function applyInputTimeSignature(
  score: Score,
  measureIndex: number,
  beats: number,
  beatType: 2 | 4 | 8 | 16,
  showExplicitRests: boolean,
): boolean {
  if (measureIndex < 0 || beats < 1 || ![2, 4, 8, 16].includes(beatType)) return false;
  let changed = false;
  for (let partIndex = 0; partIndex < score.parts.length; partIndex++) {
    ensureInputMeasure(score, partIndex, measureIndex);
    const part = score.parts[partIndex];
    let affected = false;
    for (let index = measureIndex; index < part.measures.length; index++) {
      const measure = part.measures[index];
      if (index > measureIndex && measure.timeChange) break;
      affected = true;
      measure.time.beats = beats;
      measure.time.beatType = beatType;
      if (index === measureIndex) measure.timeChange = measureIndex > 0;
      const length = measureLength(measure);
      const retained: typeof measure.entries = [];
      for (const entry of measure.entries) {
        if (!(entry instanceof Chord)) {
          retained.push(entry);
          continue;
        }
        if (entry.position.compareTo(length) >= 0) {
          for (const note of entry.notes) detachInputTie(note);
          continue;
        }
        const end = entry.position.plus(entry.duration ?? ZERO);
        if (end.compareTo(length) > 0) {
          setWrittenDuration(entry, length.minus(entry.position));
          for (const note of entry.notes) {
            if (!note.tieNext) continue;
            note.tieNext.tiePrev = null;
            note.tieNext.tieEnd = false;
            note.tieNext = null;
            note.tieStart = false;
          }
        }
        retained.push(entry);
      }
      measure.entries = retained;
      if (showExplicitRests) fillRests(measure);
      else extendAcrossGaps(measure);
      changed = true;
    }
    if (!affected) continue;
    let position = ZERO;
    for (const measure of part.measures) {
      measure.position = position;
      position = position.plus(measureLength(measure));
    }
  }
  return changed;
}

/** Options used by the score-level measure editing helpers. */
export interface InputMeasureInsertOptions {
  /** Part used as the template for the new bar. Defaults to the first part. */
  templatePartIndex?: number;
  /** Insert before or after the supplied measure index. Defaults to after. */
  side?: "before" | "after";
}

function copyMeasureHeader(source: Measure | undefined, target: Measure): void {
  if (!source) return;
  target.time = new Time(source.time.beats, source.time.beatType);
  target.key = new Key();
  target.key.fifths = source.key.fifths;
  target.keyChange = false;
  target.timeChange = false;
  target.pickup = false;
  target.displayNumber = target.index + 1;
}

function detachMeasureTies(measure: Measure): void {
  for (const entry of measure.entries) {
    if (!(entry instanceof Chord)) continue;
    for (const note of entry.notes) detachInputTie(note);
  }
}

function rebuildMeasurePositions(score: Score): void {
  for (const part of score.parts) {
    let position = ZERO;
    part.measures.forEach((measure, index) => {
      measure.index = index;
      measure.position = position;
      position = position.plus(measureLength(measure));
    });
    let number = 1;
    part.measures.forEach((measure, index) => {
      if (index === 0 && measure.pickup) {
        measure.displayNumber = null;
        return;
      }
      measure.displayNumber = number++;
    });
  }
}

function remapMeasureAnchors(score: Score, removedIndex: number): void {
  const remap = (value: number): number => {
    if (value > removedIndex) return value - 1;
    // An annotation attached to a deleted bar stays at the following bar;
    // when that was the final bar, keep it on the new final bar.
    if (value === removedIndex) {
      const count = score.parts[0]?.measures.length ?? 0;
      return Math.max(0, Math.min(value, count - 1));
    }
    return value;
  };
  for (const mark of score.tempoMarks) mark.measure = remap(mark.measure);
  for (const mark of score.keyMarks) mark.measure = remap(mark.measure);
  for (const mark of score.textMarks) mark.measure = remap(mark.measure);
  for (const mark of score.crossPartArpeggios) mark.measure = remap(mark.measure);
}

/**
 * Insert one synchronized, editable measure in every part.
 *
 * `measureIndex` is the existing bar used as the reference. With `side:
 * "before"` the new bar receives that index; with `"after"` it is inserted
 * immediately after it. The new bar is populated with beat-sized rests so it
 * can be edited by the input cursor immediately.
 */
export function insertInputMeasure(
  score: Score,
  measureIndex: number,
  options: InputMeasureInsertOptions = {},
): Measure[] {
  if (!Number.isInteger(measureIndex) || measureIndex < 0) return [];
  if (score.parts.length === 0) score.parts.push(new Part());
  const side = options.side ?? "after";
  const insertionIndex = side === "before" ? measureIndex : measureIndex + 1;
  const templatePart = score.parts[options.templatePartIndex ?? 0] ?? score.parts[0];
  const template = templatePart.measures[measureIndex]
    ?? templatePart.measures[measureIndex - 1]
    ?? templatePart.measures[0];
  const inserted: Measure[] = [];

  for (const part of score.parts) {
    const reference = part.measures[measureIndex]
      ?? part.measures[measureIndex - 1]
      ?? template;
    const next = new Measure(Math.max(0, Math.min(insertionIndex, part.measures.length)));
    copyMeasureHeader(reference, next);
    populateEmptyMeasure(next);
    const at = Math.max(0, Math.min(insertionIndex, part.measures.length));
    // A terminal barline belongs to the new final bar after insertion.
    if (at === part.measures.length && reference
      && (reference.barline === BarStyle.LIGHT_HEAVY || reference.barline === BarStyle.HEAVY_HEAVY)) {
      next.barline = reference.barline;
      reference.barline = BarStyle.REGULAR;
    }
    part.measures.splice(at, 0, next);
    inserted.push(next);
  }
  for (const mark of score.tempoMarks) if (mark.measure >= insertionIndex) mark.measure++;
  for (const mark of score.keyMarks) if (mark.measure >= insertionIndex) mark.measure++;
  for (const mark of score.textMarks) if (mark.measure >= insertionIndex) mark.measure++;
  for (const mark of score.crossPartArpeggios) if (mark.measure >= insertionIndex) mark.measure++;
  rebuildMeasurePositions(score);
  return inserted;
}

/** Insert before/after convenience aliases for callers such as the context menu. */
export function insertInputMeasureBefore(score: Score, measureIndex: number): Measure[] {
  return insertInputMeasure(score, measureIndex, { side: "before" });
}

export function insertInputMeasureAfter(score: Score, measureIndex: number): Measure[] {
  return insertInputMeasure(score, measureIndex, { side: "after" });
}

function deleteInputMeasureAt(score: Score, measureIndex: number): boolean {
  if (score.parts.length === 0 || measureIndex < 0) return false;
  const available = score.parts.some((part) => measureIndex < part.measures.length);
  if (!available) return false;
  // Keep one editable bar in a score. This also avoids leaving a score that
  // cannot be rendered or targeted by the input cursor.
  const maxCount = Math.max(...score.parts.map((part) => part.measures.length));
  if (maxCount <= 1) return false;
  const deleted = score.parts.map((part) => part.measures[measureIndex]).find(Boolean);
  for (const part of score.parts) {
    const measure = part.measures[measureIndex];
    if (!measure) continue;
    const prior = part.measures[measureIndex - 1];
    const successor = part.measures[measureIndex + 1];
    detachMeasureTies(measure);
    // Preserve a terminal double bar and explicit change on the surviving bar.
    if (prior && (measure.barline === BarStyle.LIGHT_HEAVY || measure.barline === BarStyle.HEAVY_HEAVY)) {
      prior.barline = measure.barline;
    }
    if (successor && measure.timeChange && !successor.timeChange) successor.timeChange = true;
    if (successor && measure.keyChange && !successor.keyChange) {
      successor.keyChange = true;
      successor.key.fifths = measure.key.fifths;
    }
    part.measures.splice(measureIndex, 1);
  }
  void deleted;
  remapMeasureAnchors(score, measureIndex);
  rebuildMeasurePositions(score);
  return true;
}

/** Delete one or more synchronized bars. Indices may be repeated or unsorted. */
export function deleteInputMeasures(score: Score, measureIndices: readonly number[]): number {
  const indices = [...new Set(measureIndices)]
    .filter((index) => Number.isInteger(index) && index >= 0)
    .sort((left, right) => right - left);
  let deleted = 0;
  for (const index of indices) if (deleteInputMeasureAt(score, index)) deleted++;
  return deleted;
}

/** Return true when a measure contains no sounding attack in any part. */
export function isInputMeasureEmpty(score: Score, measureIndex: number): boolean {
  if (score.parts.length === 0) return false;
  return score.parts.every((part) => {
    const measure = part.measures[measureIndex];
    if (!measure) return true;
    return !measure.entries.some((entry) => entry instanceof Chord && !entry.rest
      && entry.notes.some((note) => !note.rest && !note.softDeleted));
  });
}

/** Remove only synchronized trailing all-rest bars, retaining at least one
 * editable bar. Interior silent measures are musical content and must never
 * disappear merely because input mode was closed. */
export function removeEmptyInputMeasures(score: Score): number {
  const count = score.parts[0]?.measures.length ?? 0;
  const removable: number[] = [];
  for (let index = count - 1; index > 0; index--) {
    if (score.parts[0]?.measures[index]?.pickup) continue;
    if (!isInputMeasureEmpty(score, index)) break;
    removable.push(index);
  }
  return deleteInputMeasures(score, removable);
}
