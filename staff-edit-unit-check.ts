import { Fraction } from "./src/common/fraction";
import { Chord, CrossPartArpeggio, KeyMark, Note, type Score } from "./src/score/score";
import { chordArpeggioPitchGroups, setChordArpeggioPitchGroups } from "./src/score/arpeggio";
import { JpwFile } from "./src/jpword/jpwfile";
import { fromJpw } from "./src/score/jpwimport";
import { scoreToJpwabc } from "./src/score/jpscore";
import { createInputTriplet, tupletActualToWritten } from "./src/score/input-edit";
import { inputTargetFromNote, type InputTarget } from "./src/editor/multi-input";
import { applyStaffPitch, moveStaffPitches, setStaffDurations, staffDurationIsDotted, staffLetterPitch, staffMovedPitch, staffPitchSpec, staffWrittenDuration } from "./src/editor/staff-edit";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function load(voice: string, key = "C", lower?: string): Score {
  const text = `.Title\nTitle = 五线谱编辑回归\nKeyAndMeters = {1=${key},4/4}\n`
    + (lower === undefined ? `.Voice\n${voice}\n` : `.Voice.RH\n${voice}\n.Voice.LH\n${lower}\n`);
  const score = fromJpw(JpwFile.fromString(text)!);
  check(score, "fixture failed to parse");
  return score;
}
function attacks(score: Score, part = 0, measure = 0): Chord[] {
  return score.parts[part].measures[measure].entries.filter((entry): entry is Chord => entry instanceof Chord && !entry.rest);
}
function target(score: Score, note: Note, part = 0): InputTarget {
  return inputTargetFromNote(score, part, note, 16);
}
function cursor(partIndex = 0, measureIndex = 0, offset = "0") {
  return { partIndex, measureIndex, offset };
}
function pitches(score: Score): string {
  return JSON.stringify(score.parts.map(part => part.measures.map(measure => measure.entries
    .filter((entry): entry is Chord => entry instanceof Chord)
    .map(chord => ({ at: chord.position.toString(), duration: chord.duration?.toString(),
      rest: chord.rest, pitches: chord.notes.map(note => note.pitch), dot: chord.dot })) )));
}

// Pitch movement keeps each independent wave attached to its written members.
{
  const score = load("[1357] 0 0 0 |]", "C", "1, 0 0 0 |]");
  const chord = attacks(score)[0];
  setChordArpeggioPitchGroups(chord, [[60, 64], [67, 71]]);
  const cross = new CrossPartArpeggio();
  cross.parts = [0, 1]; cross.pitches = [{ part: 0, pitch: 60 }, { part: 1, pitch: 48 }];
  score.crossPartArpeggios.push(cross);
  const moved = moveStaffPitches(score, [target(score, chord.notes.find(note => note.pitch === 60)!)], "diatonic", 1);
  check(moved.changed === 1 && moved.blocked === 0, "Staff arpeggio pitch edit was rejected");
  const expected = JSON.stringify([[62, 64], [67, 71]]);
  check(JSON.stringify(chordArpeggioPitchGroups(chord)) === expected, "Staff pitch edit lost an independent local wave");
  check(cross.pitches[0].pitch === 62, "Staff pitch edit detached its cross-part wave");
  const reopened = fromJpw(JpwFile.fromString(scoreToJpwabc(score))!)!;
  check(JSON.stringify(chordArpeggioPitchGroups(attacks(reopened)[0])) === expected,
    "Staff local waves changed on JPW save/reopen");
  check(reopened.crossPartArpeggios[0].pitches.some(member => member.part === 0 && member.pitch === 62),
    "Staff cross-part wave changed on JPW save/reopen");
}
{
  const score = load("[1135] 0 0 0 |]");
  const chord = attacks(score)[0];
  setChordArpeggioPitchGroups(chord, [[60, 64], [60, 67]]);
  const unisons = chord.notes.filter(note => note.pitch === 60);
  check(unisons.length === 2, "Staff unison fixture lost a written note");
  applyStaffPitch(unisons[1], staffPitchSpec(score, cursor(), 62));
  check(JSON.stringify(chordArpeggioPitchGroups(chord)) === JSON.stringify([[60, 64], [62, 67]]),
    "Staff direct pitch entry reassigned an unselected unison's wave");
}
{
  const score = load("[1345] 0 0 0 |]", "C", "1, 0 0 0 |]");
  const chord = attacks(score)[0];
  setChordArpeggioPitchGroups(chord, [[60, 64], [65, 67]]);
  const cross = new CrossPartArpeggio();
  cross.parts = [0, 1]; cross.pitches = [{ part: 0, pitch: 64 }, { part: 1, pitch: 48 }];
  score.crossPartArpeggios.push(cross);
  const e = chord.notes.find(note => note.pitch === 64)!, f = chord.notes.find(note => note.pitch === 65)!;
  const changed = moveStaffPitches(score, [target(score, e), target(score, f)], "diatonic", 1);
  check(changed.changed === 2 && changed.blocked === 0, "Staff overlapping-pitch batch was rejected");
  check(JSON.stringify(chordArpeggioPitchGroups(chord)) === JSON.stringify([[60, 65], [67, 67]]),
    "Staff batch temporarily equal pitches swapped wave membership");
  check(cross.pitches[0].pitch === 65, "Staff batch moved its wave onto the previously equal-pitched member");
  const reopened = fromJpw(JpwFile.fromString(scoreToJpwabc(score))!)!;
  check(JSON.stringify(chordArpeggioPitchGroups(attacks(reopened)[0])) === JSON.stringify([[60, 65], [67, 67]]),
    "Staff overlapping-pitch groups changed on JPW save/reopen");
}

// Staff positions advance one written scale step, using the local key.
// Pitch-only arpeggio metadata must never silently change written ownership.
for (const kind of ["local", "cross"] as const) {
  const original = load(kind === "local" ? "[134567] 0 0 0 |]" : "[45] 0 0 0 |]", "C", "1, 0 0 0 |]");
  const first = attacks(original)[0];
  if (kind === "local") setChordArpeggioPitchGroups(first, [[60, 64], [65, 69], [67, 71]]);
  else {
    const mark = new CrossPartArpeggio(); mark.parts = [0, 1];
    mark.pitches = [{ part: 0, pitch: 65 }, { part: 1, pitch: 48 }]; original.crossPartArpeggios.push(mark);
  }
  const before = scoreToJpwabc(original);
  const draft = fromJpw(JpwFile.fromString(before)!)!;
  const selected = (kind === "local" ? [64, 65] : [65]).map(pitch =>
    target(draft, attacks(draft)[0].notes.find(note => note.pitch === pitch)!));
  const result = moveStaffPitches(draft, selected, "diatonic", 1);
  check(result.blocked === 1 && result.changed === 0 && result.reason === "incompatible-target",
    `${kind}: an ambiguous final unison reassigned arpeggio ownership`);
  check(scoreToJpwabc(original) === before, `${kind}: a rejected draft changed the original document`);
}

{
  const score = load("3 4 5 0 |]");
  const [e, f, g] = attacks(score).map(chord => chord.notes[0]);
  check(e.pitch === 64 && f.pitch === 65 && g.pitch === 67, "C-key fixture pitches differ");
  const movedE = staffMovedPitch(score, target(score, e), e, "diatonic", 1);
  const movedF = staffMovedPitch(score, target(score, f), f, "diatonic", 1);
  check(movedE.pitch === 65 && movedE.step === "F", "E4 → F4 must move one semitone");
  check(movedF.pitch === 67 && movedF.step === "G", "F4 → G4 must move two semitones");
  check(staffMovedPitch(score, target(score, g), g, "diatonic", -1).pitch === 65, "G4 → F4 must move two semitones");
  check(staffMovedPitch(score, target(score, f), f, "semitone", 1).pitch === 66, "Ctrl+Alt up must move exactly one semitone");
  check(staffMovedPitch(score, target(score, e), e, "semitone", -1).pitch === 63, "Ctrl+Alt down must move exactly one semitone");
  check(staffMovedPitch(score, target(score, e), e, "octave", 1).pitch === 76, "Ctrl up must retain pitch class");
  const applied = moveStaffPitches(score, [target(score, e), target(score, f)], "diatonic", 1);
  check(applied.changed === 2 && applied.blocked === 0 && e.pitch === 65 && f.pitch === 67, "Batch diatonic shift differs per scale interval");
}
{
  const score = load("6, 7, 1 0 |]", "G");
  const [e, fs] = attacks(score).map(chord => chord.notes[0]);
  check(e.pitch === 64 && fs.pitch === 66, "G-key fixture lacks E4/F#4");
  const spec = staffMovedPitch(score, target(score, e), e, "diatonic", 1);
  check(spec.pitch === 66 && spec.step === "F" && spec.alter === 1, "G major E4 → F#4 lost key signature");
  check(staffMovedPitch(score, target(score, fs), fs, "diatonic", 1).pitch === 67, "G major F#4 → G4 must move a semitone");
}
{
  const score = load("3 3 3 0 |]");
  score.keyMarks.push(new KeyMark(0, new Fraction(1), 1));
  const [before, at, after] = attacks(score).map(chord => chord.notes[0]);
  check(staffMovedPitch(score, target(score, before), before, "diatonic", 1).pitch === 65, "Key change retuned an earlier target");
  check(staffMovedPitch(score, target(score, at), at, "diatonic", 1).pitch === 66, "Midbar key must apply at its exact anchor");
  check(staffMovedPitch(score, target(score, after), after, "diatonic", 1).pitch === 66, "Midbar key must apply after its anchor");
  check(staffLetterPitch(score, cursor(0, 0, "1"), "f").pitch === 66, "Letter input ignored midbar key");
}

// Letter entry takes the previous attack's averaged written register, strictly
// before the cursor. Entering more tones at that cursor cannot change it.
{
  const score = load("[134] 0 0 0 |]");
  const at = cursor(0, 0, "1");
  for (const [letter, expected] of [["C", 60], ["E", 64], ["F", 65]] as const) {
    const spec = staffLetterPitch(score, at, letter);
    check(spec.pitch === expected && spec.octave === 4, `C4/E4/F4 register lost for ${letter}`);
  }
  const measure = score.parts[0].measures[0];
  const current = new Chord(measure); current.position = new Fraction(1); current.duration = new Fraction(1);
  const newlyAdded = new Note(current);
  applyStaffPitch(newlyAdded, staffPitchSpec(score, at, 96)); current.add(newlyAdded); measure.add(current);
  check(staffLetterPitch(score, at, "G").pitch === 67, "Newly added C7 at the current beat changed the register");
  const following = cursor(0, 0, "2");
  const nextLetter = staffLetterPitch(score, following, "F");
  check(nextLetter.pitch === 101, `Previous attack was excluded at a later beat: ${JSON.stringify(nextLetter)}, previous ${JSON.stringify({ pitch: newlyAdded.pitch, step: newlyAdded.step, octave: newlyAdded.octave })}`);
}
{
  const score = load("1 0 0 0 |0 0 0 0 |]");
  const previous = attacks(score)[0].notes[0];
  applyStaffPitch(previous, staffPitchSpec(score, cursor(), 84));
  check(staffLetterPitch(score, cursor(0, 1, "0"), "E").pitch === 88, "Previous measure's register was not retained");
  const at = cursor(0, 1, "0");
  const added = new Chord(score.parts[0].measures[1]); added.duration = new Fraction(1);
  const current = new Note(added); applyStaffPitch(current, staffPitchSpec(score, at, 48)); added.add(current); added.measure.add(added);
  check(staffLetterPitch(score, at, "F").pitch === 89, "Current attack in next bar changed its own letter register");
}
{
  const score = load("0 0 0 0 |]", "C", "0 0 0 0 |]");
  check(staffLetterPitch(score, cursor(0), "C").pitch === 60, "Treble without previous attacks must start at C4");
  check(staffLetterPitch(score, cursor(1), "C").pitch === 48, "Bass without previous attacks must start at C3");
  const rest = score.parts[0].measures[0].entries.find(entry => entry instanceof Chord) as Chord;
  rest.notes[0].pitch = 108;
  check(staffLetterPitch(score, cursor(0, 0, "1"), "F").pitch === 65, "Rest affected letter register");
}
{
  const score = load("0 1, 0 0 |]");
  check(!score.piano && score.parts[0].hand === null, "Low single-part fixture unexpectedly has a piano hand");
  check(staffLetterPitch(score, cursor(), "C").pitch === 48,
    "Single-part bass-clef first entry must start at C3 even without a piano hand marker");
  const piano = load("0 0 0 0 |]", "C", "0 0 0 0 |]");
  piano.parts[1].hand = null;
  check(staffLetterPitch(piano, cursor(1), "C").pitch === 48, "Piano lower staff without a hand marker must still start at C3");
}
{
  const score = load("1 3 0 0 |]");
  const notes = attacks(score).map(chord => chord.notes[0]);
  const continuation = new Chord(score.parts[0].measures[0]); continuation.position = new Fraction(3, 2); continuation.duration = new Fraction(1, 2);
  const tied = new Note(continuation); applyStaffPitch(tied, staffPitchSpec(score, cursor(0, 0, "3/2"), 96));
  tied.tiePrev = notes[0]; tied.tieEnd = true; continuation.add(tied); continuation.measure.add(continuation);
  check(staffLetterPitch(score, cursor(0, 0, "2"), "F").pitch === 65, "Continuation was treated as a new attack");
}

// Selecting multiple tones inside the same chord changes its shared duration
// exactly once; dotted and plain absolute values must replace one another.
{
  const score = load("3--- |3--- |]");
  score.keyMarks.push(new KeyMark(1, new Fraction(0), 1));
  const first = attacks(score, 0, 0)[0].notes[0];
  const continued = attacks(score, 0, 1)[0].notes[0];
  applyStaffPitch(continued, staffPitchSpec(score, target(score, continued), 64, { step: "E", octave: 4 }));
  first.tieNext = continued; first.tieStart = true; continued.tiePrev = first; continued.tieEnd = true;
  const moved = moveStaffPitches(score, [target(score, first)], "diatonic", 1);
  check(moved.changed === 1 && first.pitch === 65 && continued.pitch === 65, "Tie chain was not shifted together");
  const reopened = fromJpw(JpwFile.fromString(scoreToJpwabc(score))!)!;
  check(attacks(reopened, 0, 0)[0].notes[0].pitch === 65 && attacks(reopened, 0, 1)[0].notes[0].pitch === 65,
    "Tie chain spanning a key change changed pitch on JPW save/reopen");
}
{
  const score = load("1--- |1--- |]");
  const first = attacks(score, 0, 0)[0].notes[0];
  const continued = attacks(score, 0, 1)[0].notes[0];
  first.tieNext = continued; first.tieStart = true; continued.tiePrev = first; continued.tieEnd = true;
  applyStaffPitch(first, staffPitchSpec(score, target(score, first), 126, { step: "F", octave: 9 }));
  applyStaffPitch(continued, staffPitchSpec(score, target(score, continued), 126, { step: "F", octave: 9 }));
  const moved = moveStaffPitches(score, [target(score, first), target(score, continued)], "diatonic", 1);
  check(moved.blocked === 0 && first.pitch === 127 && continued.pitch === 127,
    "Selecting both tied segments repeated the pitch movement or incorrectly rejected the MIDI boundary");
}
{
  const score = load("[13] 0 5- |]");
  const chord = attacks(score)[0];
  const targets = chord.notes.map(note => target(score, note));
  const resized = setStaffDurations(score, targets, () => new Fraction(2));
  check(resized.changed === 1 && resized.blocked === 0 && chord.duration?.equals(2), "Shared chord was resized more than once");
  const dotted = setStaffDurations(score, targets, () => new Fraction(3, 2));
  check(dotted.changed === 1 && chord.duration?.equals(new Fraction(3, 2)) && chord.dot === 1, "Absolute dotted-quarter failed");
  const plain = setStaffDurations(score, targets, () => new Fraction(1));
  check(plain.changed === 1 && chord.duration?.equals(1) && chord.dot === 0, "Absolute quarter retained its dot");
  const unchanged = setStaffDurations(score, targets, () => new Fraction(1));
  check(unchanged.changed === 0 && unchanged.blocked === 0, "Already matching duration must be a no-op");
  const before = pitches(score);
  const rejected = setStaffDurations(score, targets, () => new Fraction(0));
  check(rejected.blocked === 1 && pitches(score) === before, "Zero duration mutated the score");
}
{
  const score = load("1 0 2_ 0_ 3 0 |]");
  const notes = attacks(score).slice(0, 2).map(chord => chord.notes[0]);
  const resized = setStaffDurations(score, notes.map(note => target(score, note)), () => new Fraction(1));
  check(resized.blocked === 0 && resized.changed === 1 && notes.every(note => note.chord.duration?.equals(1)),
    "Different initial durations were shifted by a common delta instead of set absolutely");
}

// A crossbar absolute duration includes the selected segment's tied tail.
// Repeating the same value cannot append another beat on every key press.
{
  const score = load("0 0 0 (1 |1) 0 0 0 |]");
  const note = attacks(score)[0].notes[0];
  const selected = target(score, note);
  check(note.chord.duration?.equals(1) && note.tieNext?.chord.duration?.equals(1), "Crossbar half-note fixture differs");
  check(staffWrittenDuration(note).equals(2), "Crossbar written duration excluded the tied tail");
  check(!staffDurationIsDotted(note), "Plain crossbar half note was reported as dotted");
  const unchanged = setStaffDurations(score, [selected], () => new Fraction(2));
  check(unchanged.changed === 0 && unchanged.blocked === 0 && staffWrittenDuration(note).equals(2),
    "Repeating half-note length grew the crossbar tail");
  const dotted = setStaffDurations(score, [selected], item => staffWrittenDuration(item).times(new Fraction(3, 2)));
  check(dotted.changed === 1 && dotted.blocked === 0 && staffWrittenDuration(note).equals(3),
    "Adding a dot to a crossbar half note did not produce three beats");
  check(note.chord.dot === 0 && staffDurationIsDotted(note), "Crossbar dotted status used the onset segment's dot");
  const repeated = setStaffDurations(score, [selected], () => new Fraction(3));
  check(repeated.changed === 0 && repeated.blocked === 0 && staffWrittenDuration(note).equals(3),
    "Repeating dotted half-note length grew the crossbar tail");
  const plain = setStaffDurations(score, [selected], item => staffWrittenDuration(item).times(new Fraction(2, 3)));
  check(plain.changed === 1 && plain.blocked === 0 && staffWrittenDuration(note).equals(2),
    "Removing a crossbar half-note dot did not restore two beats");
  check(!staffDurationIsDotted(note), "Dot removal left the complete written value dotted");
  const shortened = setStaffDurations(score, [selected], () => new Fraction(1));
  check(shortened.changed === 1 && shortened.blocked === 0 && staffWrittenDuration(note).equals(1) && !note.tieNext,
    "Absolute quarter did not remove the whole crossbar continuation");
}
{
  const score = load("0 0 0 (1 |1) 0 0 0 |]");
  const root = attacks(score)[0].notes[0];
  const continuation = root.tieNext!;
  check(staffWrittenDuration(continuation).equals(1), "Selecting a continuation counted its preceding segment");
  const selected = target(score, continuation);
  const resized = setStaffDurations(score, [selected], () => new Fraction(2));
  check(resized.changed === 1 && resized.blocked === 0 && root.chord.duration?.equals(1)
    && staffWrittenDuration(continuation).equals(2) && staffWrittenDuration(root).equals(3),
    "Resizing a selected continuation changed the preceding segment");
  const repeated = setStaffDurations(score, [selected], () => new Fraction(2));
  check(repeated.changed === 0 && repeated.blocked === 0 && staffWrittenDuration(root).equals(3),
    "Repeating a continuation's absolute duration grew its tail");
}
{
  const score = load("0 0 0 ([13] |[13]) 0 0 0 |]");
  const chord = attacks(score)[0];
  const selected = chord.notes.map(note => target(score, note));
  check(chord.notes.every(note => staffWrittenDuration(note).equals(2)), "Tied chord duration excluded its tail");
  const resized = setStaffDurations(score, selected, () => new Fraction(3));
  check(resized.changed === 1 && resized.blocked === 0 && chord.notes.every(note => staffWrittenDuration(note).equals(3)),
    "Selected tones repeated the shared crossbar chord resize");
  const repeated = setStaffDurations(score, selected, () => new Fraction(3));
  check(repeated.changed === 0 && repeated.blocked === 0, "Tied shared chord absolute duration was not idempotent");
}
{
  const score = load("1 2 0 0 |]");
  const [first, next] = attacks(score).map(chord => chord.notes[0]);
  first.tieNext = next; next.tiePrev = first; next.tieEnd = true;
  const newAttack = new Note(next.chord); newAttack.pitch = 67; next.chord.add(newAttack);
  check(staffWrittenDuration(first).equals(1), "Written duration crossed a tied chord containing a new attack");
  next.chord.generatedTimingContinuation = true;
  check(staffWrittenDuration(first).equals(2), "Generated timing continuation did not follow resize semantics");
  next.chord.generatedTimingContinuation = false; next.chord.transparentContinuation = true;
  check(staffWrittenDuration(first).equals(2), "Transparent continuation did not follow resize semantics");
}
{
  const score = load("1 0 0 0 |]");
  const note = attacks(score)[0].notes[0];
  for (const division of [1, 2, 4, 8, 16, 32, 64]) {
    note.chord.duration = new Fraction(6, division);
    check(staffDurationIsDotted(note), `Supported dotted duration 6/${division} was not recognized`);
    note.chord.duration = new Fraction(4, division);
    check(!staffDurationIsDotted(note), `Plain duration 4/${division} was reported as dotted`);
  }
  note.chord.duration = new Fraction(7, 4); note.chord.dot = 2;
  check(!staffDurationIsDotted(note), "Double dotted value was treated as a supported single dot");
  note.chord.duration = new Fraction(6, 128);
  check(!staffDurationIsDotted(note), "Unsupported 128th dotted value was enabled");
}

// Tuplet requests are written durations; consumed rests remain inside the
// ratio. A request extending past the tuplet domain must be rejected.
{
  const score = load("1 0 0 0 |]");
  const made = createInputTriplet(score, { partIndex: 0, measureIndex: 0, offset: new Fraction(0) }, new Fraction(1, 2));
  check(made.changed, "Triplet fixture was not created");
  const note = attacks(score)[0].notes[0];
  check(note.tuplet && note.chord.duration?.equals(new Fraction(1, 3)), "Triplet fixture lacks an eighth member");
  check(staffWrittenDuration(note).equals(new Fraction(1, 2)), "Triplet duration must return its member's written value");
  const resized = setStaffDurations(score, [target(score, note)], () => new Fraction(3, 4));
  check(resized.changed === 1 && resized.blocked === 0 && note.chord.duration?.equals(new Fraction(1, 2)), "Dotted tuplet written value was treated as actual duration");
  check(tupletActualToWritten(note.chord.duration!, note.tuplet).equals(new Fraction(3, 4)) && note.chord.dot === 1, "Tuplet written dot lost");
  check(staffDurationIsDotted(note), "Tuplet dotted status used actual duration instead of written duration");
}
{
  const source = "1 0 0 0 |]";
  const live = load(source);
  const draft = load(source);
  createInputTriplet(draft, { partIndex: 0, measureIndex: 0, offset: new Fraction(0) }, new Fraction(1, 2));
  const note = attacks(draft)[0].notes[0];
  const liveBefore = pitches(live);
  const rejected = setStaffDurations(draft, [target(draft, note)], () => new Fraction(4));
  check(rejected.changed === 0 && rejected.blocked === 1 && rejected.reason === "incompatible-target", "Tuplet domain boundary was accepted");
  check(pitches(live) === liveBefore, "Rejected draft affected the live score");
}

// Helpers mutate only disposable drafts. A later boundary or occupied target
// can fail after an earlier edit; callers must discard the entire draft.
{
  const live = load("3 4 0 0 |]");
  const draft = load("3 4 0 0 |]");
  const notes = attacks(draft).map(chord => chord.notes[0]);
  applyStaffPitch(notes[1], staffPitchSpec(draft, target(draft, notes[1]), 127, { step: "G", octave: 9 }));
  const before = pitches(live);
  const rejected = moveStaffPitches(draft, notes.map(note => target(draft, note)), "diatonic", 1);
  check(rejected.changed === 0 && rejected.blocked === 1 && rejected.reason === "boundary", "MIDI upper boundary was accepted");
  check(notes[0].pitch === 65, "Partial draft fixture did not exercise an earlier successful mutation");
  check(pitches(live) === before, "Discarding the pitch draft changed live state");
}
{
  const live = load("1 0 2 3 |]");
  const draft = fromJpw(JpwFile.fromString(scoreToJpwabc(live))!)!;
  const notes = attacks(draft).slice(0, 2).map(chord => chord.notes[0]);
  const before = pitches(live);
  const rejected = setStaffDurations(draft, notes.map(note => target(draft, note)), () => new Fraction(3, 2));
  check(rejected.changed === 0 && rejected.blocked === 1, "Occupied duration target was accepted");
  check(notes[0].chord.duration?.equals(new Fraction(3, 2)), "Partial duration draft did not exercise mutation");
  check(pitches(live) === before, "Discarding the duration draft changed live state");
}
console.log("staff-edit-unit-check: local-key diatonic/chromatic pitch, letter registers, shared absolute/dotted durations, tuplets and draft rejection passed");
