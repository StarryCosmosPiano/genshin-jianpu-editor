import { Fraction } from "../common/fraction";
import { Chord, type Note, type Score } from "../score/score";
import { chordArpeggioPitchGroups, setChordArpeggioPitchGroups } from "../score/arpeggio";
import { appendInputChordAtCursor, replaceInputChordAtCursor, type NotationCursor } from "../score/input-edit";
import { noteTimingStep } from "../score/note-timing";
import { inputDegreeSpec, refreshInputAccidentals } from "./input-mode";
import { insertInputNoteWithDuration, synchronizedInputMeasure } from "./input-insertion";
import { dedupeInputTargets, inputTargetCursor, inputTargetFromNote, resolveInputTarget,
  type InputTarget, type InputTargetDuration, type MultiInputResult } from "./multi-input";
import { staffPitchSpec } from "./staff-edit";

const ZERO = new Fraction(0);
const soundingNotes = (chord: Chord | null): Note[] => chord?.notes.filter(note => !note.rest && !note.softDeleted) ?? [];
const positionKey = (target: InputTarget): string => `${target.partIndex}/${target.measureIndex}/${Fraction.fromString(target.offset)}`;
const failure = (targets: readonly InputTarget[], reason: MultiInputResult["reason"]): MultiInputResult =>
  ({ changed: 0, blocked: Math.max(1, targets.length), targets: [...targets], reason });

/** Add a degree without changing the selected anchors. An explicitly selected
 * member supplies its register. Whole selected chords are one destination in
 * their highest member's register; partial selections keep independent octaves.
 * Call only on an input transaction draft, publishing after format validation. */
export function addInputTargetsChordDegree(score: Score, targets: readonly InputTarget[],
  degree: 1 | 2 | 3 | 4 | 5 | 6 | 7, explicitOctave?: number,
  durationOf: InputTargetDuration = target => noteTimingStep(target.division)): MultiInputResult {
  const inputs = dedupeInputTargets(targets);
  const resolved = inputs.map(target => ({ target, ...resolveInputTarget(score, target) }));
  if (resolved.some(({ target, note }) => !score.parts[target.partIndex]
    || !Number.isInteger(target.measureIndex) || target.measureIndex < 0
    || target.measureIndex > score.parts[target.partIndex].measures.length
    || !Number.isFinite(Fraction.fromString(target.offset).toFloat())
    || Fraction.fromString(target.offset).compareTo(ZERO) < 0
    || (target.kind === "note" && !note))) return failure(inputs, "missing-target");
  const groups = new Map<string, typeof resolved>();
  for (const item of resolved) {
    const key = positionKey(item.target);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const plans: Array<{ target: InputTarget; chord: Chord | null; octave: number }> = [];
  const wholeChords = new Map<string, Chord>();
  for (const group of groups.values()) {
    const tones = soundingNotes(group[0].chord);
    const highest = tones.reduce<Note | null>((top, note) => !top || note.pitch > top.pitch ? note : top, null);
    const allSelected = tones.length > 0 && tones.every(note => group.some(item => item.note === note));
    if (allSelected && tones.length > 1) wholeChords.set(positionKey(group[0].target), group[0].chord!);
    for (const item of allSelected ? [group[0]] : group) {
      const member = allSelected ? highest : item.note ?? highest;
      plans.push({ target: item.target, chord: item.chord,
        octave: explicitOctave ?? member?.jpOctave ?? item.target.anchorOctave + item.target.octaveOffset });
    }
  }
  const prepared = plans.map(plan => ({ ...plan,
    spec: inputDegreeSpec(score, inputTargetCursor(plan.target), degree, plan.octave) }));
  if (prepared.some(plan => !Number.isInteger(plan.spec.pitch) || plan.spec.pitch < 0 || plan.spec.pitch > 127))
    return failure(inputs, "boundary");
  const seen = new Set<string>();
  let changed = 0, skipped = 0;
  const arpeggios = new Map<Chord, number[][]>();
  const inserted: Array<{ partIndex: number; note: Note }> = [];
  for (const { target, chord, spec } of prepared) {
    const key = `${positionKey(target)}/${spec.pitch}`;
    if (seen.has(key) || soundingNotes(chord).some(note => note.pitch === spec.pitch)) { skipped++; continue; }
    seen.add(key);
    if (chord && !arpeggios.has(chord)) arpeggios.set(chord, chordArpeggioPitchGroups(chord));
    const occupied = resolveInputTarget(score, target).chord;
    const result = soundingNotes(occupied).length > 0
      ? appendInputChordAtCursor(score, inputTargetCursor(target), segment => [segment === occupied ? spec
        : staffPitchSpec(score, { partIndex: target.partIndex,
          measureIndex: score.parts[target.partIndex].measures.indexOf(segment.measure), offset: segment.position.toString() }, spec.pitch)])
      : insertInputNoteWithDuration(score, inputTargetCursor(target), spec, durationOf(target, chord));
    if (("blocked" in result && result.blocked) || !result.note || !result.changed) return failure(inputs, "incompatible-target");
    inserted.push({ partIndex: target.partIndex, note: result.note });
    if (result.chord && soundingNotes(result.chord).length > 1) result.chord.ornaments = result.chord.ornaments
      .filter(ornament => ornament.kind !== "upper-mordent" && ornament.kind !== "lower-mordent" && ornament.kind !== "trill");
    changed++;
  }
  for (const [chord, groups] of arpeggios) setChordArpeggioPitchGroups(chord, groups);
  if (changed) for (const partIndex of new Set(inputs.map(target => target.partIndex))) {
    const measures = new Set(inputs.filter(target => target.partIndex === partIndex).map(target => target.measureIndex));
    for (const item of inserted.filter(item => item.partIndex === partIndex)) {
      const seenNotes = new Set<Note>();
      for (let note: Note | null = item.note; note && !seenNotes.has(note); note = note.tieNext) {
        seenNotes.add(note); measures.add(score.parts[partIndex].measures.indexOf(note.chord.measure));
      }
    }
    refreshInputAccidentals(score, partIndex, measures);
  }
  // A box-selected whole chord remains a whole selection after it grows.
  // A single explicitly selected member remains the same anchor.
  const retained = dedupeInputTargets(inputs.flatMap(target => {
    const whole = wholeChords.get(positionKey(target));
    return whole ? soundingNotes(whole).map(note => inputTargetFromNote(score, target.partIndex, note, target.division)) : [target];
  }));
  return { changed, blocked: 0, skipped, targets: retained, verifyTimings: true };
}

export interface MidiInputResult extends MultiInputResult {
  /** Null in chord mode. Ordinary step input normalizes the actual endpoint
   * into a measure-local cursor, creating that bar in every part when needed. */
  nextCursor: NotationCursor | null;
}

function noteEnd(note: Note): Fraction {
  const seen = new Set<Note>();
  let end = note.absoluteTick, current: Note | null = note;
  while (current && !seen.has(current)) {
    seen.add(current);
    const until = current.absoluteTick.plus(current.chord.duration ?? ZERO);
    if (until.compareTo(end) > 0) end = until;
    current = current.tieNext;
  }
  return end;
}

function cursorAtEnd(score: Score, cursor: NotationCursor, end: Fraction): NotationCursor {
  const part = score.parts[cursor.partIndex];
  let index = cursor.measureIndex;
  for (let guard = 0; guard < 1024; guard++) {
    synchronizedInputMeasure(score, index);
    const measure = part.measures[index];
    const length = new Fraction(measure.time.beats * 4, measure.time.beatType);
    if (end.compareTo(measure.position.plus(length)) < 0)
      return { ...cursor, measureIndex: index, offset: end.minus(measure.position), lane: "rest", verticalIndex: 0 };
    index++;
  }
  throw new Error("MIDI input endpoint exceeds supported score length");
}

/** One hardware gesture is one transaction. The supplied MIDI pitches are
 * absolute; no nearest-note/degree quantization is applied. Normal mode
 * replaces the occupied onset group; chord mode adds distinct pitches. */
export function applyMidiInputAtCursor(score: Score, cursor: NotationCursor,
  pitches: readonly number[], requestedDuration: Fraction, chordMode: boolean): MidiInputResult {
  const failed = (reason: MultiInputResult["reason"]): MidiInputResult => ({ ...failure([], reason), nextCursor: null });
  const part = score.parts[cursor.partIndex];
  if (!part || !Number.isInteger(cursor.measureIndex) || cursor.measureIndex < 0 || cursor.measureIndex > part.measures.length
    || !Number.isFinite(cursor.offset.toFloat()) || cursor.offset.compareTo(ZERO) < 0) return failed("missing-target");
  if (pitches.length === 0 || pitches.some(pitch => !Number.isInteger(pitch) || pitch < 0 || pitch > 127)) return failed("boundary");
  if (!Number.isFinite(requestedDuration.toFloat()) || requestedDuration.compareTo(ZERO) <= 0) return failed("boundary");
  const unique = [...new Set(pitches)].sort((left, right) => left - right);
  synchronizedInputMeasure(score, cursor.measureIndex);
  const measure = part.measures[cursor.measureIndex];
  if (cursor.offset.compareTo(new Fraction(measure.time.beats * 4, measure.time.beatType)) >= 0) return failed("boundary");
  const existing = measure.entries.find((entry): entry is Chord => entry instanceof Chord
    && entry.position.equals(cursor.offset) && !entry.rest && soundingNotes(entry).length > 0) ?? null;
  const spell = (chord: Chord, pitch: number) => staffPitchSpec(score,
    { partIndex: cursor.partIndex, measureIndex: part.measures.indexOf(chord.measure), offset: chord.position.toString() }, pitch);
  let notes: Note[] = [], changed = 0, skipped = 0;
  if (existing && !chordMode) {
    const replaced = replaceInputChordAtCursor(score, cursor, chord => unique.map(pitch => spell(chord, pitch)));
    if (!replaced.changed || !replaced.chord) return failed("incompatible-target");
    notes = soundingNotes(replaced.chord);
    changed = 1;
  } else {
    const arpeggios = existing ? chordArpeggioPitchGroups(existing) : null;
    for (const pitch of unique) {
      const duplicate = soundingNotes(existing).find(note => note.pitch === pitch);
      if (duplicate) { notes.push(duplicate); skipped++; continue; }
      const spec = staffPitchSpec(score, { partIndex: cursor.partIndex, measureIndex: cursor.measureIndex,
        offset: cursor.offset.toString() }, pitch);
      const result = existing
        ? appendInputChordAtCursor(score, cursor, segment => [spell(segment, pitch)])
        : insertInputNoteWithDuration(score, cursor, spec, requestedDuration);
      if (("blocked" in result && result.blocked) || !result.changed || !result.note) return failed("incompatible-target");
      notes.push(result.note); changed++;
    }
    if (existing && arpeggios) setChordArpeggioPitchGroups(existing, arpeggios);
    if (!existing && notes.length > 1) {
      // The first pitch may have created a tied span across beats/bars.
      // All simultaneous hardware pitches own that same full span.
      const grouped = replaceInputChordAtCursor(score, cursor, chord => unique.map(pitch => spell(chord, pitch)));
      if (!grouped.changed || !grouped.chord) return failed("incompatible-target");
      notes = soundingNotes(grouped.chord);
    }
  }
  const targets = notes.map(note => inputTargetFromNote(score, cursor.partIndex, note, cursor.division));
  if (changed) {
    const affectedMeasures = new Set<number>([cursor.measureIndex]);
    for (const note of notes) {
      const seen = new Set<Note>();
      for (let current: Note | null = note; current && !seen.has(current); current = current.tieNext) {
        seen.add(current); affectedMeasures.add(part.measures.indexOf(current.chord.measure));
      }
    }
    refreshInputAccidentals(score, cursor.partIndex, affectedMeasures);
  }
  const end = notes.reduce((latest, note) => noteEnd(note).compareTo(latest) > 0 ? noteEnd(note) : latest,
    measure.position.plus(cursor.offset));
  const nextCursor = chordMode ? null : cursorAtEnd(score, cursor, end);
  score.parseRepeatInf();
  return { changed, blocked: 0, skipped, targets, verifyTimings: true, nextCursor };
}
