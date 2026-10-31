import assert from "node:assert/strict";
import { Fraction } from "./src/common/fraction";
import { Chord, KeyMark, type Score } from "./src/score/score";
import { chordArpeggioPitchGroups, setChordArpeggioPitchGroups } from "./src/score/arpeggio";
import { JpwFile } from "./src/jpword/jpwfile";
import { fromJpw } from "./src/score/jpwimport";
import { scoreToJpwabc } from "./src/score/jpscore";
import { applyInputTargetsDegree, applyInputTargetsOctave, applyInputTargetsPitch,
  inputTargetFromNote, inputTargetFromSnapshot, resolveInputTarget } from "./src/editor/multi-input";
import { advanceScoreInputTarget, prepareScoreChordTargets, scorePositionKey,
  scoreScreenLetterPitch, validScoreInputPosition } from "./src/editor/score-commands";

const load = (upper: string, lower?: string, key = "C"): Score => fromJpw(JpwFile.fromString(
  `.Title\nKeyAndMeters = {1=${key},4/4}\n` + (lower === undefined ? `.Voice\n${upper}\n`
    : `.Voice.RH\n${upper}\n.Voice.LH\n${lower}\n`))!)!;
const at = (score: Score, part = 0, offset = 0, measure = 0): Chord => {
  const value = score.parts[part].measures[measure].entries.find(entry => entry instanceof Chord && entry.position.equals(offset));
  assert(value instanceof Chord); return value;
};
const quarter = () => new Fraction(1);

// Numeric screen keys retain the selected degree register, including a local
// key change and the C–B boundary inside a non-C tonic octave.
{
  const score = load("1' 0 0 0 |]", undefined, "G");
  const note = at(score).notes[0], target = inputTargetFromNote(score, 0, note, 4);
  assert.equal(note.pitch, 79);
  const result = applyInputTargetsDegree(score, [target], 7, quarter);
  assert.equal(result.blocked, 0); assert.equal(note.pitch, 90);
  assert.equal(note.jpOctave, 1); assert.equal(note.chord.position.toString(), "0");
  const reopened = fromJpw(JpwFile.fromString(scoreToJpwabc(score))!)!;
  assert.equal(at(reopened).notes[0].pitch, 90, "G-major high 7 changed during save/reopen");
}
{
  const score = load("1 2 0 0 |]"); score.keyMarks.push(new KeyMark(0, new Fraction(1), 1));
  const note = at(score, 0, 1).notes[0];
  assert.equal(applyInputTargetsDegree(score, [inputTargetFromNote(score, 0, note, 4)], 7).blocked, 0);
  assert.equal(note.pitch, 78, "screen degree ignored the mid-bar G-major key");
}

// Chord preparation is session-only, merges a chord's selected members, and
// never crosses into another part. The occupied column retains its duration.
{
  const score = load("[135] 0 0 0 |]", "1, 0 0 0 |]");
  const before = scoreToJpwabc(score), source = at(score), lower = at(score, 1).notes.map(note => note.pitch);
  const targets = source.notes.map(note => inputTargetFromNote(score, 0, note, 4));
  const ghosts = prepareScoreChordTargets(score, targets, "above");
  assert.equal(scoreToJpwabc(score), before); assert.equal(ghosts.length, 1);
  assert.equal(ghosts[0].kind, "ghost"); assert.equal(ghosts[0].partIndex, 0); assert.equal(ghosts[0].anchorPitch, 67);
  const result = applyInputTargetsDegree(score, ghosts, 2, () => new Fraction(2));
  assert.equal(result.blocked, 0); assert.deepEqual(source.notes.map(note => note.pitch).sort((a, b) => a - b), [60, 64, 67, 74]);
  assert.equal(source.duration?.toString(), "1"); assert.deepEqual(at(score, 1).notes.map(note => note.pitch), lower);
}

// Explicit 21-key octave bands override the relative above/below hint. Moving
// an insertion target to another staff adds there without moving source tones.
{
  const score = load("1 0 0 0 |]", "1, 0 0 0 |]");
  const source = at(score).notes[0];
  const ghost = prepareScoreChordTargets(score, [inputTargetFromNote(score, 0, source, 4)], "above")[0];
  ghost.partIndex = 1;
  const result = applyInputTargetsDegree(score, [ghost], 5, quarter, -1);
  assert.equal(result.blocked, 0); assert.equal(source.pitch, 60);
  assert.deepEqual(at(score, 1).notes.map(note => note.pitch), [48, 55]);
  assert.equal(at(score).notes.length, 1);
}

// A duplicate add is rejected before touching any note in the caller's draft.
{
  const score = load("[135] 0 0 0 |]");
  const ghost = prepareScoreChordTargets(score, [inputTargetFromNote(score, 0, at(score).notes[0], 4)], "above")[0];
  const before = scoreToJpwabc(score);
  const duplicate = applyInputTargetsDegree(score, [ghost], 1, quarter, 0);
  assert.equal(duplicate.reason, "occupied-target"); assert.equal(scoreToJpwabc(score), before);
}

// Pending octave buttons update both musical register and visible/audible
// preview; typing after two moves must not count an octave twice.
{
  const score = load("0 0 0 0 |]");
  let target = inputTargetFromSnapshot(score, { partIndex: 0, measureIndex: 0, offset: "0", division: 4,
    lane: "rest", focusPitch: 60, staffStep: "C", staffOctave: 4 });
  target = applyInputTargetsOctave(score, [target], 1).targets[0];
  target = applyInputTargetsOctave(score, [target], 1).targets[0];
  assert.equal(target.focusPitch, 84); assert.equal(target.staffOctave, 6); assert.equal(target.octaveOffset, 2);
  const result = applyInputTargetsDegree(score, [target], 1, quarter);
  assert.equal(resolveInputTarget(score, result.targets[0]).note?.pitch, 84);
}

// Named screen input follows current pitch rather than the previous attack's
// register, and preserves local/cross-note identity during a pitch edit.
{
  const score = load("1 5' 0 0 |]", undefined, "G");
  const note = at(score, 0, 1).notes[0], target = inputTargetFromNote(score, 0, note, 4);
  const spec = scoreScreenLetterPitch(score, target, note, "F");
  assert.equal(spec.pitch, 90); assert.equal(spec.step, "F"); assert.equal(spec.alter, 1);
  const result = applyInputTargetsPitch(score, [target], () => spec);
  assert.equal(result.blocked, 0); assert.equal(note.step, "F"); assert.equal(note.pitch, 90);
}
{
  const score = load("[13] 0 0 0 |]");
  const chord = at(score); setChordArpeggioPitchGroups(chord, [[60, 64]]);
  const target = inputTargetFromNote(score, 0, chord.notes.find(note => note.pitch === 60)!, 4);
  const result = applyInputTargetsPitch(score, [target], (input, note) => scoreScreenLetterPitch(score, input, note, "D"));
  assert.equal(result.blocked, 0); assert.deepEqual(chordArpeggioPitchGroups(chord), [[62, 64]]);
  const before = scoreToJpwabc(score);
  assert.equal(applyInputTargetsPitch(score, result.targets, () => ({ pitch: 128 })).reason, "boundary");
  assert.equal(scoreToJpwabc(score), before, "out-of-range pitch partially changed the draft");
}

// Automatic advance is applied to a successful disposable transaction. Both
// hands receive exactly one new bar and no existing note changes staff.
{
  const score = load("1 2 0 0 |]");
  const next = advanceScoreInputTarget(score, inputTargetFromNote(score, 0, at(score).notes[0], 4), new Fraction(1));
  assert.equal(next.kind, "note", "advancing onto an existing tone must not silently arm chord insertion");
  assert.equal(resolveInputTarget(score, next).note?.pitch, 62);
}
{
  const score = load("0 0 0 1 |]", "0 0 0 1, |]", "G");
  const target = inputTargetFromNote(score, 0, at(score, 0, 3).notes[0], 4);
  const next = advanceScoreInputTarget(score, target, new Fraction(1));
  assert.equal(next.kind, "ghost"); assert.equal(next.partIndex, 0);
  assert.equal(next.measureIndex, 1); assert.equal(next.offset, "0");
  assert.deepEqual(score.parts.map(part => part.measures.length), [2, 2]);
  assert.deepEqual(score.parts.map(part => part.measures[1].key.fifths), [1, 1]);
}
assert.equal(scorePositionKey({ partIndex: 1, measureIndex: 2, offset: "2/4" }), "1/2/1/2");
assert(validScoreInputPosition({ partIndex: 0, measureIndex: 0, offset: "1/3", midi: 60 }));
assert(!validScoreInputPosition({ partIndex: -1, measureIndex: 0, offset: "0" }));
assert(!validScoreInputPosition({ partIndex: 0, measureIndex: 0, offset: "0", midi: 128 }));
console.log("score-commands-check: local-key degrees, exact registers, chord ghosts, staff destinations, named pitches and atomic advance passed");
