import { Fraction } from "./src/common/fraction";
import { Chord, KeyMark, Measure, Note, Part, Score } from "./src/score/score";
import { applyKeyChangeKeepingDegrees } from "./src/score/key-edit";

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

console.log("key edit checks passed");
