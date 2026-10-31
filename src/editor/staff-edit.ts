import { Fraction } from "../common/fraction";
import { AccidentalStat, Chord, MusicCommon, Note, type Score } from "../score/score";
import { clefForPart, spellPitch } from "../score/musicxml-export";
import { chordArpeggioNoteGroups, setChordArpeggioPitchGroups } from "../score/arpeggio";
import { resizeInputTuplet, tupletActualToWritten, tupletWrittenToActual } from "../score/input-edit";
import { resizeScoreNoteSegmentsWithRests } from "../score/note-timing";
import { inputKeyAt, refreshInputAccidentals } from "./input-mode";
import { inputTargetFromNote, resolveInputTarget, type InputTarget, type MultiInputResult } from "./multi-input";

export interface StaffPitchSpec {
  pitch: number; step: string; alter: number; octave: number;
  number: string; jpOctave: number; jpAlter: string;
}
export type StaffPitchMovement = "diatonic" | "semitone" | "octave";

export function staffPitchSpec(score: Score, target: Pick<InputTarget, "partIndex" | "measureIndex" | "offset">,
  pitch: number, spelling?: { step: string; octave: number }): StaffPitchSpec {
  const measure = score.parts[target.partIndex].measures[target.measureIndex];
  const fifths = inputKeyAt(score, target.partIndex, target.measureIndex, Fraction.fromString(target.offset)).fifths;
  const temporary = new Note(new Chord(measure));
  temporary.pitch = pitch;
  const spelled = spelling
    ? { ...spelling, alter: pitch - (spelling.octave + 1) * 12 - MusicCommon.stepToPitch(spelling.step) }
    : spellPitch(temporary, fifths);
  Object.assign(temporary, spelled);
  temporary.init(fifths, new AccidentalStat(fifths));
  return { pitch, ...spelled, number: temporary.number,
    jpOctave: temporary.jpOctave, jpAlter: temporary.jpAlter };
}

function crossArpeggioMembers(score: Score): Array<{ mark: object; member: { pitch: number }; note: Note }> {
  return score.crossPartArpeggios.flatMap(mark => {
    const available = new Map([...new Set(mark.pitches.map(member => member.part))].map(partIndex => [partIndex,
      score.parts[partIndex]?.measures[mark.measure]?.entries.flatMap(entry =>
        entry instanceof Chord && entry.position.equals(mark.offset)
          ? entry.notes.filter(member => !member.rest && !member.softDeleted) : []) ?? []]));
    return mark.pitches.flatMap(member => {
      const notes = available.get(member.part) ?? [];
      const index = notes.findIndex(candidate => candidate.pitch === member.pitch);
      return index < 0 ? [] : [{ mark, member, note: notes.splice(index, 1)[0] }];
    });
  });
}

export function applyStaffPitch(note: Note, spec: StaffPitchSpec, score?: Score): void {
  const groups = chordArpeggioNoteGroups(note.chord);
  const crossMembers = score ? crossArpeggioMembers(score).filter(item => item.note === note) : [];
  Object.assign(note, spec);
  note.displayText = null;
  note.displayAlter = null;
  note.displayOctave = null;
  note.chord.timingOriginal = null;
  note.chord.timingSourceIndex = null;
  setChordArpeggioPitchGroups(note.chord, groups.map(group => group.map(member => member.pitch)));
  for (const { member } of crossMembers) member.pitch = note.pitch;
}

export function staffMovedPitch(score: Score, target: Pick<InputTarget, "partIndex" | "measureIndex" | "offset">,
  note: Note, movement: StaffPitchMovement, direction: -1 | 1): StaffPitchSpec {
  const fifths = inputKeyAt(score, target.partIndex, target.measureIndex, Fraction.fromString(target.offset)).fifths;
  const spelled = spellPitch(note, fifths);
  if (movement === "semitone") return staffPitchSpec(score, target, note.pitch + direction);
  if (movement === "octave") return staffPitchSpec(score, target, note.pitch + direction * 12,
    { step: spelled.step, octave: spelled.octave + direction });
  const position = spelled.octave * 7 + MusicCommon.steps.indexOf(spelled.step) + direction;
  const octave = Math.floor(position / 7);
  const step = MusicCommon.steps[((position % 7) + 7) % 7];
  const pitch = (octave + 1) * 12 + MusicCommon.stepToPitch(step) + MusicCommon.getAlter(step, fifths);
  return staffPitchSpec(score, target, pitch, { step, octave });
}

/** The previous attack establishes a C–B register; newly entered tones at the
 * cursor are excluded so entering a chord cannot change its own octave. */
export function staffLetterPitch(score: Score, target: Pick<InputTarget, "partIndex" | "measureIndex" | "offset">,
  letter: string): StaffPitchSpec {
  const part = score.parts[target.partIndex];
  const measure = part.measures[target.measureIndex];
  const at = measure.position.plus(Fraction.fromString(target.offset));
  let previous: Fraction | null = null;
  let writtenPositions: number[] = [];
  for (const bar of part.measures) for (const entry of bar.entries) {
    if (!(entry instanceof Chord) || entry.rest) continue;
    const tick = bar.position.plus(entry.position);
    if (tick.compareTo(at) >= 0 || previous && tick.compareTo(previous) < 0) continue;
    const attacks = entry.notes.filter(note => !note.rest && !note.tiePrev && !note.tieEnd);
    if (!attacks.length) continue;
    if (!previous || tick.compareTo(previous) > 0) { previous = tick; writtenPositions = []; }
    const fifths = inputKeyAt(score, target.partIndex, bar.index, entry.position).fifths;
    for (const note of attacks) {
      const spelled = spellPitch(note, fifths);
      writtenPositions.push(spelled.octave * 7 + MusicCommon.steps.indexOf(spelled.step));
    }
  }
  const octave = writtenPositions.length
    ? Math.floor(writtenPositions.reduce((sum, position) => sum + position, 0) / writtenPositions.length / 7)
    : score.piano && target.partIndex === 1 || clefForPart(part).sign === "F" ? 3 : 4;
  const step = letter.toUpperCase();
  const fifths = inputKeyAt(score, target.partIndex, target.measureIndex, Fraction.fromString(target.offset)).fifths;
  return staffPitchSpec(score, target,
    (octave + 1) * 12 + MusicCommon.stepToPitch(step) + MusicCommon.getAlter(step, fifths), { step, octave });
}

/** Changes only the disposable draft supplied by the caller. */
export function moveStaffPitches(score: Score, targets: readonly InputTarget[], movement: StaffPitchMovement,
  direction: -1 | 1): MultiInputResult {
  const plans = targets.map(target => ({ target, ...resolveInputTarget(score, target) }));
  if (plans.some(item => !item.note)) return { changed: 0, blocked: 1, targets: [...targets], reason: "missing-target" };
  // Keep identities across the entire batch: an intermediate pitch may equal
  // another member's old pitch while both are being moved.
  const groups = score.parts.flatMap(part => part.measures.flatMap(measure => measure.entries.flatMap(entry =>
    entry instanceof Chord && entry.arpeggio ? [{ chord: entry, members: chordArpeggioNoteGroups(entry) }] : [])));
  const cross = crossArpeggioMembers(score);
  const edited = new Set<Note>();
  for (const { target, note } of plans) {
    if (edited.has(note!)) continue;
    const spec = staffMovedPitch(score, target, note!, movement, direction);
    if (spec.pitch < 0 || spec.pitch > 127) return { changed: 0, blocked: 1, targets: [...targets], reason: "boundary" };
    let root = note!;
    const seen = new Set<Note>();
    while (root.tiePrev && !seen.has(root)) { seen.add(root); root = root.tiePrev; }
    seen.clear();
    let item: Note | null = root;
    while (item && !seen.has(item)) {
      seen.add(item);
      if (!edited.has(item)) {
        const local = { partIndex: target.partIndex, measureIndex: item.chord.measure.index,
          offset: item.chord.position.toString() };
        applyStaffPitch(item, staffPitchSpec(score, local, spec.pitch, spec));
        edited.add(item);
      }
      item = item.tieNext;
    }
  }
  for (const { chord, members } of groups) {
    setChordArpeggioPitchGroups(chord, members.map(group => group.map(note => note.pitch)));
  }
  for (const { member, note } of cross) member.pitch = note.pitch;
  const restoredCross = crossArpeggioMembers(score);
  const faithfulLocal = groups.every(({ chord, members }) => {
    const restored = chordArpeggioNoteGroups(chord);
    return restored.length === members.length && restored.every((group, index) =>
      group.length === members[index].length && group.every(note => members[index].includes(note)));
  });
  const faithfulCross = cross.length === restoredCross.length && cross.every(({ mark, note }) =>
    restoredCross.some(item => item.mark === mark && item.note === note));
  // The caller owns this disposable draft. Refuse publication when the
  // pitch-only file representation would reattach a wave to another unison.
  if (!faithfulLocal || !faithfulCross) return { changed: 0, blocked: 1, targets: [...targets], reason: "incompatible-target" };
  for (const partIndex of new Set(targets.map(target => target.partIndex))) {
    const part = score.parts[partIndex];
    refreshInputAccidentals(score, partIndex, new Set([...edited].filter(note => part.measures.includes(note.chord.measure))
      .map(note => part.measures.indexOf(note.chord.measure))));
  }
  return { changed: plans.length, blocked: 0, verifyTimings: true, targets: plans.map(({ target, note }) =>
    inputTargetFromNote(score, target.partIndex, note!, target.division)) };
}

/** Written duration from the selected segment through its pure tied tail.
 * A tuplet member keeps its own written value, matching resizeInputTuplet. */
export function staffWrittenDuration(note: Note): Fraction {
  if (note.tuplet) return tupletActualToWritten(note.chord.duration ?? new Fraction(0), note.tuplet);
  let duration = new Fraction(0);
  const visited = new Set<Chord>();
  let chord: Chord | null = note.chord;
  while (chord && !visited.has(chord)) {
    visited.add(chord);
    duration = duration.plus(chord.duration ?? new Fraction(0));
    const next: Chord | undefined = chord.notes.find(item => !item.rest && item.tieNext)?.tieNext?.chord;
    if (!next) break;
    const sounding = next.notes.filter(item => !item.rest);
    // Keep the continuation rule aligned with note-timing's resize helper.
    const pure = next.generatedTimingContinuation || next.transparentContinuation
      || sounding.length > 0 && next.graceNotes.length === 0 && !next.arpeggio
        && sounding.every(item => item.tieEnd && item.tiePrev !== null);
    if (!pure) break;
    chord = next;
  }
  return duration;
}

/** Whether the complete written value is one of the supported single dots. */
export function staffDurationIsDotted(note: Note): boolean {
  const duration = staffWrittenDuration(note);
  return [1, 2, 4, 8, 16, 32, 64].some(division => duration.equals(new Fraction(6, division)));
}

/** Same shared-Chord semantics as numbered notation, with an absolute written
 * value rather than repeatedly applying one delta to differently sized notes. */
export function setStaffDurations(score: Score, targets: readonly InputTarget[],
  durationFor: (note: Note) => Fraction): MultiInputResult {
  const resolved = targets.map(target => ({ target, ...resolveInputTarget(score, target) }));
  if (resolved.some(item => !item.note || !item.chord?.duration))
    return { changed: 0, blocked: 1, targets: [...targets], reason: "missing-target" };
  const chords = new Map<Chord, typeof resolved[number]>();
  resolved.forEach(item => chords.set(item.chord!, item));
  let changed = 0;
  for (const { target, note, chord } of chords.values()) {
    const wanted = durationFor(note!);
    const current = staffWrittenDuration(note!);
    if (wanted.equals(current)) continue;
    if (wanted.compareTo(new Fraction(0)) <= 0) return { changed: 0, blocked: 1, targets: [...targets], reason: "boundary" };
    if (note!.tuplet) {
      const wantedActual = tupletWrittenToActual(wanted, note!.tuplet);
      let remaining = wantedActual.minus(chord!.duration!);
      let guard = 0;
      while (!remaining.equals(0) && guard++ < 1024) {
        const resized = resizeInputTuplet(score, note!, remaining);
        if (!resized.changed) return { changed: 0, blocked: 1, targets: [...targets], reason: "incompatible-target" };
        remaining = wantedActual.minus(chord!.duration!);
      }
      if (!remaining.equals(0)) return { changed: 0, blocked: 1, targets: [...targets], reason: "incompatible-target" };
    } else {
      const resized = resizeScoreNoteSegmentsWithRests(score,
        [{ partIndex: target.partIndex, note: note!, grace: false }], wanted.minus(current));
      if (resized.blocked || !resized.changed) return { changed: 0, blocked: 1, targets: [...targets], reason: "incompatible-target" };
    }
    changed++;
  }
  return { changed, blocked: 0, targets: resolved.map(({ target, note }) =>
    inputTargetFromNote(score, target.partIndex, note!, target.division)) };
}
