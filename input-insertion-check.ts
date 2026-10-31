import assert from "node:assert/strict";
import { Fraction } from "./src/common/fraction";
import { Chord, type Note, type Score } from "./src/score/score";
import { JpwFile } from "./src/jpword/jpwfile";
import { fromJpw } from "./src/score/jpwimport";
import { scoreToJpwabc } from "./src/score/jpscore";
import { createInputTriplet, type NotationCursor } from "./src/score/input-edit";
import { insertInputNoteWithDuration } from "./src/editor/input-insertion";

function load(voice: string, lower?: string): Score {
  return fromJpw(JpwFile.fromString(`.Title\nTitle = 插入时值回归\nKeyAndMeters = {1=C,4/4}\n`
    + (lower === undefined ? `.Voice\n${voice}\n` : `.Voice.RH\n${voice}\n.Voice.LH\n${lower}\n`))!)!;
}
const at = (offset: Fraction, partIndex = 0): NotationCursor => ({ partIndex, measureIndex: 0, offset, division: 4, lane: "rest" });
const spec = { pitch: 60, number: "1", jpOctave: 0, jpAlter: " " };
function total(note: Note): Fraction {
  let sum = new Fraction(0); const seen = new Set<Note>(); let cursor: Note | null = note;
  while (cursor && !seen.has(cursor)) { seen.add(cursor); sum = sum.plus(cursor.chord.duration!); cursor = cursor.tieNext; }
  return sum;
}
{
  const score = load("0 0 0 0 |]");
  const result = insertInputNoteWithDuration(score, at(new Fraction(3)), spec, new Fraction(2));
  assert(result.changed && !result.blocked && result.note);
  assert.equal(total(result.note).toString(), "2", "bar-end half note was silently truncated to a quarter");
  assert.equal(score.parts[0].measures.length, 2);
  assert(result.note.tieNext, "cross-bar insertion lacks its continuation");
  const reopened = fromJpw(JpwFile.fromString(scoreToJpwabc(score))!)!;
  const first = reopened.parts[0].measures[0].entries.find(entry => entry instanceof Chord && !entry.rest) as Chord;
  assert.equal(total(first.notes[0]).toString(), "2", "cross-bar insertion changed after save/reopen");
}
{
  const score = load("0 0 0 0 |]", "0 0 0 0 |]");
  const result = insertInputNoteWithDuration(score, at(new Fraction(7, 2)), spec, new Fraction(3, 2));
  assert(result.note && !result.blocked);
  assert.equal(total(result.note).toString(), "3/2", "off-beat dotted-quarter insertion was truncated");
  assert.deepEqual(score.parts.map(part => part.measures.length), [2, 2], "new sounding time was appended in only one hand");
  assert.deepEqual(score.parts.map(part => part.measures[1].position.toString()), ["4", "4"]);
}
{
  const score = load("0 0 0 0 |0 3 0 0 |]");
  const result = insertInputNoteWithDuration(score, at(new Fraction(3)), spec, new Fraction(4));
  assert(!result.blocked && result.note);
  assert.equal(total(result.note).toString(), "2", "cross-bar insertion must clip at the next independent onset");
  const later = score.parts[0].measures[1].entries.find(entry => entry instanceof Chord && entry.position.equals(1)) as Chord;
  assert.equal(later.notes[0].pitch, 64, "clipping erased a later real onset");
}
{
  const score = load("3 0 0 0 |]");
  const first = score.parts[0].measures[0].entries.find(entry => entry instanceof Chord && !entry.rest) as Chord;
  const result = insertInputNoteWithDuration(score, at(new Fraction(0)), spec, new Fraction(4));
  assert(!result.blocked && result.note);
  assert.equal(first.notes.length, 2);
  assert.equal(first.duration?.toString(), "1", "adding a chord tone independently resized the shared column");
  assert.equal(score.parts[0].measures.length, 1);
}
{
  const score = load("0 0 0 0 |]");
  assert(createInputTriplet(score, { partIndex: 0, measureIndex: 0, offset: new Fraction(2) }, new Fraction(1, 2)).changed);
  const result = insertInputNoteWithDuration(score, at(new Fraction(3, 2)), spec, new Fraction(1));
  assert(!result.blocked && result.note);
  assert.equal(total(result.note).toString(), "1/2", "ordinary insertion must end at an explicit tuplet boundary");
  assert((score.parts[0].measures[0].entries.find(entry => entry instanceof Chord && entry.position.equals(2)) as Chord)
    .notes[0].tuplet, "clipping removed the following tuplet");
}
{
  const score = load("0 0 0 0 |]");
  assert(createInputTriplet(score, { partIndex: 0, measureIndex: 0, offset: new Fraction(0) }, new Fraction(1, 2)).changed);
  const fixed = (score.parts[0].measures[0].entries.find(entry => entry instanceof Chord && entry.position.equals(0)) as Chord).duration!.toString();
  const result = insertInputNoteWithDuration(score, at(new Fraction(0)), spec, new Fraction(4));
  assert(!result.blocked && result.fixedTupletCell && result.note?.tuplet);
  assert.equal(result.chord?.duration?.toString(), fixed, "fixed 3:2 cell changed its intrinsic duration");
  assert.equal(score.parts[0].measures.length, 1);
}
{
  const score = load("0 0 3 0 |]");
  const result = insertInputNoteWithDuration(score, at(new Fraction(0)), spec, new Fraction(2));
  assert(result.note && !result.blocked);
  assert.equal(total(result.note).toString(), "2", "a new attack ending exactly at an existing onset was rejected");
  const next = score.parts[0].measures[0].entries.find(entry => entry instanceof Chord && entry.position.equals(2)) as Chord;
  assert.equal(next.notes[0].pitch, 64);
}
{
  const score = load("0--- |]");
  const before = scoreToJpwabc(score);
  assert(insertInputNoteWithDuration(score, at(new Fraction(0)), spec, new Fraction(0)).blocked);
  assert.equal(scoreToJpwabc(score), before, "invalid duration mutated the source draft");
}
console.log("Input insertion checks passed: full cross-bar duration, synchronized hands, chord sharing, onset/tuplet barriers and reopen");
