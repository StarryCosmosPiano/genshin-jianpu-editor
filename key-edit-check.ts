import { Fraction } from "./src/common/fraction";
import { Chord, CrossPartArpeggio, KeyMark, Measure, Note, Part, Score } from "./src/score/score";
import { applyKeyChangeKeepingDegrees } from "./src/score/key-edit";
import { chordArpeggioPitchGroups, setChordArpeggioPitchGroups } from "./src/score/arpeggio";
import { JpwFile } from "./src/jpword/jpwfile";
import { fromJpw } from "./src/score/jpwimport";
import { scoreToJpwabc } from "./src/score/jpscore";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function note(measure: Measure, position: Fraction, pitch: number, number: string): Note {
  const chord = new Chord(measure);
  chord.position = position;
  chord.duration = new Fraction(1, 4);
  const nt = new Note(chord);
  nt.pitch = pitch;
  nt.number = number;
  nt.jpOctave = 0;
  chord.add(nt);
  measure.entries.push(chord);
  return nt;
}

const score = new Score();
const part = new Part();
const first = new Measure(0);
const second = new Measure(1);
first.key.fifths = 0;
second.key.fifths = 0;
part.measures.push(first, second);
score.parts.push(part);
score.keyMarks.push(new KeyMark(1, new Fraction(0), 0));

const before = note(first, new Fraction(0), 60, "1");
const tiedStart = note(first, new Fraction(1, 4), 62, "2");
const tiedContinuation = note(first, new Fraction(1, 2), 62, "2");
tiedStart.tieStart = true;
tiedContinuation.tieEnd = true;
tiedStart.tieNext = tiedContinuation;
tiedContinuation.tiePrev = tiedStart;
const retuned = note(first, new Fraction(3, 4), 64, "3");
const after = note(second, new Fraction(0), 65, "4");
const lowerPart = new Part();
const lowerFirst = new Measure(0);
const lowerSecond = new Measure(1);
lowerFirst.key.fifths = 0;
lowerSecond.key.fifths = 0;
lowerPart.measures.push(lowerFirst, lowerSecond);
score.parts.push(lowerPart);
const lowerRetuned = note(lowerFirst, new Fraction(3, 4), 48, "1");
const lowerAfter = note(lowerSecond, new Fraction(0), 50, "2");

assert(applyKeyChangeKeepingDegrees(score, 0, 0, new Fraction(1, 2), 1), "key edit rejected");
assert(before.pitch === 60, "note before anchor moved");
assert(tiedContinuation.pitch === 62, "tie crossing anchor was retuned");
assert(retuned.pitch === 71, "note after anchor did not transpose");
assert(after.pitch === 65, "note after next key mark moved");
assert(lowerRetuned.pitch === 55, "same-instrument lower part was not transposed at the global key mark");
assert(lowerAfter.pitch === 50, "lower part moved past the next key mark");
assert(retuned.number === "3", "visible degree changed");

{
  const decorated = fromJpw(JpwFile.fromString(".Title\nKeyAndMeters = {1=C,4/4}\n.Voice.RH\n[1357] 0 0 0 | [1357] 0 0 0 |]\n.Voice.LH\n1, 0 0 0 | 1, 0 0 0 |]\n")!)!;
  const chords = decorated.parts[0].measures.map(measure => measure.entries.find((entry): entry is Chord => entry instanceof Chord && !entry.rest)!);
  for (const chord of chords) setChordArpeggioPitchGroups(chord, [[60, 64], [67, 71]]);
  for (let measure = 0; measure < 2; measure++) {
    const mark = new CrossPartArpeggio(); mark.measure = measure; mark.parts = [0, 1];
    mark.pitches = [{ part: 0, pitch: 60 }, { part: 1, pitch: 48 }];
    decorated.crossPartArpeggios.push(mark);
  }
  decorated.keyMarks.push(new KeyMark(1, new Fraction(0), 0));
  assert(applyKeyChangeKeepingDegrees(decorated, 0, 0, new Fraction(0), 1), "Decorated key edit rejected");
  const expected = JSON.stringify([[67, 71], [74, 78]]);
  assert(JSON.stringify(chordArpeggioPitchGroups(chords[0])) === expected, "Key edit detached local waves");
  assert(JSON.stringify(chordArpeggioPitchGroups(chords[1])) === JSON.stringify([[60, 64], [67, 71]]), "Key edit altered waves past next key mark");
  assert(JSON.stringify(decorated.crossPartArpeggios.map(mark => mark.pitches.map(member => member.pitch))) === JSON.stringify([[67, 55], [60, 48]]),
    "Key edit detached cross-part waves or retuned members past next key mark");
  const reopened = fromJpw(JpwFile.fromString(scoreToJpwabc(decorated))!)!;
  const firstChord = reopened.parts[0].measures[0].entries.find((entry): entry is Chord => entry instanceof Chord && !entry.rest)!;
  assert(JSON.stringify(chordArpeggioPitchGroups(firstChord)) === expected, "Key-edited waves changed on JPW save/reopen");
  assert(JSON.stringify(reopened.crossPartArpeggios.map(mark => mark.pitches.map(member => member.pitch))) === JSON.stringify([[67, 55], [60, 48]]),
    "Key-edited cross-part waves changed on JPW save/reopen");
}

console.log("key edit checks passed");
