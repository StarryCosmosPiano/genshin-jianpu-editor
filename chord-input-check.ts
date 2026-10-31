import assert from "node:assert/strict";
import { Fraction } from "./src/common/fraction";
import { Chord, type Note, type Score } from "./src/score/score";
import { scoreToJpwabc } from "./src/score/jpscore";
import { createInputTriplet, type NotationCursor } from "./src/score/input-edit";
import { scoreNoteTimingFingerprint } from "./src/score/note-timing";
import { chordArpeggioPitchGroups, setChordArpeggioPitchGroups } from "./src/score/arpeggio";
import { parseEditableDocument } from "./src/editor/document-parser";
import { addInputTargetsChordDegree, applyMidiInputAtCursor } from "./src/editor/chord-input";
import { insertInputNoteWithDuration } from "./src/editor/input-insertion";
import { inputTargetFromNote, inputTargetFromSnapshot, rebindInputTargets, type InputTarget } from "./src/editor/multi-input";
import { analyzeSlashScore, defaultSlashScoreOptions, embedSlashScoreOptionsFromScore, scoreToSlashScore } from "./src/slashscore";

function load(upper: string, lower = "0 0 0 0 |]"): Score {
  return parseEditableDocument(`.Title\nKeyAndMeters = {1=C,4/4}\n.Voice.Piano.V1\n${upper}\n.Voice.Piano.V2\n${lower}\n`, "jpw", null)!.score;
}
function at(offset = "0", partIndex = 0, measureIndex = 0): NotationCursor {
  return { partIndex, measureIndex, offset: Fraction.fromString(offset), division: 16, lane: "rest" };
}
function chord(score: Score, offset = "0", part = 0, measure = 0): Chord {
  const found = score.parts[part].measures[measure].entries.find(entry => entry instanceof Chord
    && entry.position.equals(Fraction.fromString(offset)))!;
  assert(found instanceof Chord); return found;
}
function pitches(chord: Chord): number[] { return chord.notes.filter(note => !note.rest).map(note => note.pitch).sort((a,b)=>a-b); }
function target(score: Score, note: Note, part = 0): InputTarget { return inputTargetFromNote(score, part, note, 16); }
function ghost(score: Score, offset = "0", partIndex = 0): InputTarget {
  return inputTargetFromSnapshot(score, { ...at(offset, partIndex), offset, focusPitch: null });
}
function duration(note: Note): string {
  let sum = new Fraction(0); const seen = new Set<Note>();
  for (let cursor: Note | null = note; cursor && !seen.has(cursor); cursor = cursor.tieNext) {
    seen.add(cursor); sum = sum.plus(cursor.chord.duration!);
  }
  return sum.toString();
}
let checks = 0;
function roundTrip(score: Score, selected: readonly InputTarget[] = [], division: 16 | 64 = 16): void {
  const expected = scoreNoteTimingFingerprint(score);
  for (const format of ["jpw", "keyboard", "number"] as const) {
    let text = format === "jpw" ? scoreToJpwabc(score) : scoreToSlashScore(score, format, division, ".",
      { bracketMode: "triplet", braceMode: "arpeggio", showExplicitRests: true }, score.parts.length);
    if (format !== "jpw") text = embedSlashScoreOptionsFromScore(text, score, defaultSlashScoreOptions(format, analyzeSlashScore(text)));
    const parsed = parseEditableDocument(text, format, format === "jpw" ? null : defaultSlashScoreOptions(format, analyzeSlashScore(text)));
    assert(parsed, `${format} reopen`);
    assert.equal(scoreNoteTimingFingerprint(parsed.score), expected, `${format} altered pitch or exact endpoints\n${text}`);
    assert.equal(rebindInputTargets(parsed.score, selected).length, selected.length, `${format} lost anchors`);
    checks++;
  }
}

// A clicked low member overrides the chord's highest register and remains
// selected while several different degrees are accumulated.
{
  const score = load("[1,35'] 2 3 4 |]");
  const first = chord(score), targets = [target(score, first.notes.find(note => note.pitch === 48)!)];
  const original = JSON.stringify(targets);
  assert.equal(addInputTargetsChordDegree(score, targets, 2).changed, 1);
  assert.equal(addInputTargetsChordDegree(score, targets, 4).changed, 1);
  assert.deepEqual(pitches(first), [48, 50, 53, 64, 79]);
  assert.equal(JSON.stringify(targets), original);
  assert.equal(first.duration?.toString(), "1");
  const before = scoreToJpwabc(score);
  const repeated = addInputTargetsChordDegree(score, targets, 2);
  assert.equal(repeated.changed, 0); assert.equal(repeated.blocked, 0);
  assert.equal(scoreToJpwabc(score), before, "duplicate changed existing spelling/content");
  roundTrip(score, targets);
}
// Whole-chord and unqualified cursor input choose the highest register once.
for (const wholeSelection of [true, false]) {
  const score = load("[1,35'] 2 3 4 |]");
  const first = chord(score), targets = wholeSelection ? first.notes.map(note => target(score, note)) : [ghost(score)];
  const result = addInputTargetsChordDegree(score, targets, 2);
  assert.equal(result.changed, 1);
  assert.deepEqual(pitches(first), [48, 64, 74, 79]);
  assert.equal(addInputTargetsChordDegree(score, result.targets, 4).changed, 1);
  assert.deepEqual(pitches(first), [48, 64, 74, 77, 79], "whole selection changed register on repeated chord entry");
  roundTrip(score, result.targets);
}
// Partial selection retains every selected register, collapsing equal new
// pitches at one onset while preserving the original rolled subset.
{
  const score = load("[1,3,35'] 2 3 4 |]");
  const first = chord(score), targets = first.notes.filter(note => note.pitch <= 64).map(note => target(score, note));
  setChordArpeggioPitchGroups(first, [[48, 52]]);
  const result = addInputTargetsChordDegree(score, targets, 2);
  assert.equal(result.changed, 2);
  assert.deepEqual(pitches(first), [48, 50, 52, 62, 64, 79]);
  assert.deepEqual(chordArpeggioPitchGroups(first), [[48, 52]]);
  roundTrip(score, targets);
}
// Independent parts receive their own register and keep their own durations.
{
  const score = load("[13'] 2 3 4 |]", "[1,3,]_ 0_ 0 0 0 |]");
  const targets = [target(score, chord(score).notes.find(note => note.pitch === 60)!), target(score, chord(score, "0", 1).notes[0], 1)];
  assert.equal(addInputTargetsChordDegree(score, targets, 5, undefined, () => new Fraction(4)).changed, 2);
  assert.deepEqual(pitches(chord(score)), [60, 67, 76]);
  assert.deepEqual(pitches(chord(score, "0", 1)), [48, 52, 55]);
  assert.equal(chord(score, "0", 1).duration?.toString(), "1/2");
  roundTrip(score, targets);
}
// Manual rest entry uses the selected duration, clipped to the free interval.
{
  const score = load("0__ 3__ 0_ 0 0 0 |]");
  const result = addInputTargetsChordDegree(score, [ghost(score)], 5, undefined, () => new Fraction(1, 2));
  assert.equal(result.changed, 1); assert.equal(duration(chord(score).notes[0]), "1/4");
  assert.equal(chord(score, "1/4").notes[0].pitch, 64);
  roundTrip(score, result.targets);
}
// Normal hardware input replaces an entire onset, retaining its duration;
// chord mode adds exact chromatic MIDI pitches and does not advance.
{
  const score = load("[135] 2 3 4 |]", "1 2 3 4 |]");
  const lowerBefore = JSON.parse(scoreNoteTimingFingerprint(score)).filter((item: { part: number }) => item.part === 1);
  const result = applyMidiInputAtCursor(score, at(), [72, 61, 66, 61], new Fraction(2), false);
  assert.equal(result.blocked, 0); assert.deepEqual(pitches(chord(score)), [61, 66, 72]);
  assert.equal(chord(score).duration?.toString(), "1");
  assert.equal(result.nextCursor?.offset.toString(), "1");
  const added = applyMidiInputAtCursor(score, at(), [63, 72], new Fraction(4), true);
  assert.equal(added.nextCursor, null); assert.equal(added.changed, 1);
  assert.deepEqual(pitches(chord(score)), [61, 63, 66, 72]);
  assert.deepEqual(JSON.parse(scoreNoteTimingFingerprint(score)).filter((item: { part: number }) => item.part === 1), lowerBefore);
  roundTrip(score, added.targets);
}
// Absolute hardware pitches survive local sharp/flat key signatures.
for (const key of ["G", "F", "bB"]) {
  const text = `.Title\nKeyAndMeters = {1=${key},4/4}\n.Voice.Piano.V1\n[135] 2 3 4 |]\n`;
  const score = parseEditableDocument(text, "jpw", null)!.score;
  const result = applyMidiInputAtCursor(score, at(), [60, 61, 64, 66, 72], new Fraction(1), false);
  assert.equal(result.blocked, 0); assert.deepEqual(pitches(chord(score)), [60, 61, 64, 66, 72]);
  roundTrip(score, result.targets);
}
// A held member can share a later column with an unrelated new attack.
// Replacing the earlier group must retain that independent later attack.
{
  const score = load("[13]_ [15]_ 0 0 0 |]");
  const root = chord(score).notes.find(note => note.pitch === 60)!;
  const tail = chord(score, "1/2").notes.find(note => note.pitch === 60)!;
  root.tieNext = tail; root.tieStart = true; tail.tiePrev = root; tail.tieEnd = true;
  const result = applyMidiInputAtCursor(score, at(), [62, 65], new Fraction(4), false);
  assert.equal(result.blocked, 0);
  assert(chord(score).notes.every(note => duration(note) === "1"));
  assert.deepEqual(pitches(chord(score, "1/2")), [62, 65, 67]);
  assert.equal(chord(score, "1/2").notes.find(note => note.pitch === 67)!.tiePrev, null);
  roundTrip(score, result.targets);
}
// Every pitch in a gesture gets the complete selected cross-bar duration.
{
  const score = load("0 0 0 0 |]");
  const result = applyMidiInputAtCursor(score, at("3"), [60, 64, 67], new Fraction(2), false);
  assert.equal(result.blocked, 0); assert.deepEqual(pitches(chord(score, "3")), [60, 64, 67]);
  assert(chord(score, "3").notes.every(note => duration(note) === "2"));
  assert.equal(result.nextCursor?.measureIndex, 1); assert.equal(result.nextCursor?.offset.toString(), "1");
  assert.deepEqual(score.parts.map(part => part.measures.length), [2, 2]);
  roundTrip(score, result.targets);
}
// A fully held onset is replaced through its forward tie chain. A second
// Adding to an existing cross-bar chord gives the new member its entire held
// span, regardless of the currently selected writing value. Existing members
// retain both their exact endpoints and their original note identities.
for (const mode of ["midi", "manual"] as const) {
  const score = load("0 0 0 0 |]", "1 2 3 4 |]");
  applyMidiInputAtCursor(score, at("3"), [60, 64], new Fraction(2), false);
  const first = chord(score, "3"), oldNotes = [...first.notes];
  const before = JSON.parse(scoreNoteTimingFingerprint(score));
  const result = mode === "midi"
    ? applyMidiInputAtCursor(score, at("3"), [67], new Fraction(1, 4), true)
    : addInputTargetsChordDegree(score, [target(score, first.notes.find(note => note.pitch === 60)!)], 5,
      undefined, () => new Fraction(1, 4));
  assert.equal(result.blocked, 0); assert.equal(result.changed, 1);
  assert.equal(duration(first.notes.find(note => note.pitch === 67)!), "2", `${mode} truncated the added tone at the barline`);
  assert.deepEqual(pitches(chord(score, "0", 0, 1)), [60, 64, 67]);
  assert(oldNotes.every(note => first.notes.includes(note) && duration(note) === "2"));
  assert.deepEqual(JSON.parse(scoreNoteTimingFingerprint(score)).filter((span: { part: number; pitch: number }) =>
    span.part !== 0 || span.pitch !== 67), before, `${mode} changed an existing held member or another part`);
  roundTrip(score, result.targets);
}
// When members have different tails, addition uses the longest span while
// retaining the shorter member and the independent attack in a later column.
for (const mode of ["midi", "manual"] as const) {
  const score = load("[13]_ [15]_ 0 0 0 |]");
  const first = chord(score), root = first.notes.find(note => note.pitch === 60)!;
  const short = first.notes.find(note => note.pitch === 64)!;
  const tail = chord(score, "1/2").notes.find(note => note.pitch === 60)!;
  root.tieNext = tail; root.tieStart = true; tail.tiePrev = root; tail.tieEnd = true;
  const before = JSON.parse(scoreNoteTimingFingerprint(score));
  const result = mode === "midi" ? applyMidiInputAtCursor(score, at(), [62], new Fraction(4), true)
    : addInputTargetsChordDegree(score, [target(score, short)], 2);
  assert.equal(result.blocked, 0); assert.equal(result.changed, 1);
  assert.equal(duration(first.notes.find(note => note.pitch === 62)!), "1");
  assert.equal(duration(short), "1/2"); assert.equal(duration(root), "1");
  assert.deepEqual(pitches(chord(score, "1/2")), [60, 62, 67]);
  assert.deepEqual(JSON.parse(scoreNoteTimingFingerprint(score)).filter((span: { pitch: number }) => span.pitch !== 62), before);
  roundTrip(score, result.targets);
}
// A fully held onset is replaced through its forward tie chain. A second
// edit at its continuation keeps the preceding segment and changes the suffix.
{
  const score = load("0 0 0 0 |]");
  applyMidiInputAtCursor(score, at("3"), [60, 64], new Fraction(2), false);
  let result = applyMidiInputAtCursor(score, at("3"), [62, 65, 69], new Fraction(1, 4), false);
  assert.equal(result.blocked, 0);
  assert(chord(score, "3").notes.every(note => duration(note) === "2"));
  assert.deepEqual(pitches(chord(score, "0", 0, 1)), [62, 65, 69]);
  roundTrip(score, result.targets);
  result = applyMidiInputAtCursor(score, at("0", 0, 1), [71], new Fraction(4), false);
  assert.equal(result.blocked, 0);
  assert.deepEqual(pitches(chord(score, "3")), [62, 65, 69]);
  assert(chord(score, "3").notes.every(note => duration(note) === "1" && !note.tieNext));
  assert.deepEqual(pitches(chord(score, "0", 0, 1)), [71]);
  assert.equal(result.nextCursor?.offset.toString(), "1");
  roundTrip(score, result.targets);
}
// Binary gaps that cannot be printed as one note are spelled as exact ties.
{
  const score = load("0____ 0____ 0____ 0____ 0____ 0____ 0____ 3____ 0_ 0 0 0 |]");
  const result = applyMidiInputAtCursor(score, at(), [60, 67], new Fraction(1, 2), false);
  assert.equal(result.blocked, 0);
  assert(chord(score).notes.every(note => duration(note) === "7/16"));
  assert.equal(result.nextCursor?.offset.toString(), "7/16");
  assert.equal(chord(score, "7/16").notes[0].pitch, 64);
  roundTrip(score, result.targets, 64);
}
// Fixed tuplet members retain their actual duration; the MIDI cursor follows
// the real compressed endpoint rather than the ordinary writing selection.
{
  const score = load("0 0 0 0 |]");
  assert(createInputTriplet(score, at(), new Fraction(1, 2)).changed);
  const fixedDuration = chord(score).duration!.toString();
  const result = applyMidiInputAtCursor(score, at(), [60, 64], new Fraction(4), false);
  assert.equal(result.blocked, 0); assert.equal(result.nextCursor?.offset.toString(), fixedDuration);
  assert(chord(score).notes.every(note => note.tuplet));
  roundTrip(score, result.targets);
}
// Unrepresentable ordinary gaps and invalid MIDI values never alter content.
{
  const score = load("0 3 0 0 |]");
  chord(score, "1").position = new Fraction(1, 32);
  const before = scoreNoteTimingFingerprint(score);
  const result = insertInputNoteWithDuration(score, at(), { pitch: 60, number: "1", jpOctave: 0, jpAlter: " " }, new Fraction(1, 2));
  assert(result.blocked); assert.equal(scoreNoteTimingFingerprint(score), before);
  assert(applyMidiInputAtCursor(score, at(), [60, 128], new Fraction(1), false).blocked);
  assert.equal(scoreNoteTimingFingerprint(score), before);
}
console.log(`Chord/MIDI input checks passed: member/whole/partial registers, exact pitches, clipping, tie suffixes, ${checks} JPW/TXT round trips`);
