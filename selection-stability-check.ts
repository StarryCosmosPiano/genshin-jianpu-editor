import assert from "node:assert/strict";
import { Fraction } from "./src/common/fraction";
import { Chord, type Score } from "./src/score/score";
import { parseEditableDocument } from "./src/editor/document-parser";
import { scoreToJpwabc } from "./src/score/jpscore";
import { analyzeSlashScore, defaultSlashScoreOptions, scoreToSlashScore } from "./src/slashscore";
import { ScoreInputSession } from "./src/editor/input-mode";
import { applyInputTargetsDegree, applyInputTargetsDegreeStep, inputTargetFromNote,
  inputNoteWrittenDuration, setInputTargetsWrittenDuration, rebindInputTargets, resolveInputTarget,
  type InputTarget } from "./src/editor/multi-input";

const fixture = ".Title\nKeyAndMeters = {1=C,4/4}\n.Voice\n[135] 3 6 7 |]\n";
function parse(text = fixture): Score {
  return parseEditableDocument(text, "jpw", null)!.score;
}
function chord(score: Score, offset = 0): Chord {
  return score.parts[0].measures[0].entries.find(entry => entry instanceof Chord
    && entry.position.equals(offset)) as Chord;
}
function roundTrip(score: Score, targets: readonly InputTarget[], format: "jpw" | "keyboard") {
  const text = format === "jpw" ? scoreToJpwabc(score) : scoreToSlashScore(score, format, 16, ".",
    { bracketMode: "triplet", braceMode: "arpeggio", showExplicitRests: true }, 1);
  const options = format === "jpw" ? null : defaultSlashScoreOptions(format, analyzeSlashScore(text));
  const next = parseEditableDocument(text, format, options)!.score;
  const rebound = rebindInputTargets(next, targets);
  assert.equal(rebound.length, targets.length, `${format}: lost a concrete member`);
  assert.deepEqual(rebound.map(target => target.memberId), targets.map(target => target.memberId));
  return { score: next, targets: rebound };
}

for (const format of ["jpw", "keyboard"] as const) {
  for (const originalDegree of ["1", "5"]) {
    let score = parse();
    let targets = [inputTargetFromNote(score, 0, chord(score).notes.find(note => note.number === originalDegree)!, 16)];
    const identity = targets[0].memberId;
    const untouched = chord(score).notes.filter(note => note.number !== originalDegree).map(note => note.pitch).sort();
    // Repeatedly cross the chord and enter/leave a unison with its middle
    // tone. Every next edit must modify the same written member only.
    for (const [degree, octave] of [[7, 1], [3, 0], [2, -1], [3, 0], [6, 0]] as const) {
      const result = applyInputTargetsDegree(score, targets, degree, undefined, octave);
      assert.equal(result.blocked, 0);
      ({ score, targets } = roundTrip(score, result.targets, format));
      assert.equal(targets[0].memberId, identity);
      const selected = resolveInputTarget(score, targets[0]).note!;
      assert.equal(selected.number, String(degree));
      assert.equal(selected.jpOctave, octave);
      assert.deepEqual(chord(score).notes.filter(note => note !== selected).map(note => note.pitch).sort(), untouched);
      const session = new ScoreInputSession();
      session.setTargets(score, targets);
      const reopened = roundTrip(score, targets, format).score;
      session.restore(reopened, session.snapshot());
      assert.equal(session.targets.length, 1);
      assert.equal(session.targets[0].memberId, identity);
      assert.equal(resolveInputTarget(reopened, session.targets[0]).note?.number, String(degree));
    }
  }
  // Two chosen chord members retain distinct identities when both become
  // the unselected member's pitch. Editing either one later leaves two 3s.
  let score = parse();
  let targets = chord(score).notes.filter(note => note.number !== "3").map(note => inputTargetFromNote(score, 0, note, 16));
  const result = applyInputTargetsDegree(score, targets, 3);
  ({ score, targets } = roundTrip(score, result.targets, format));
  assert.equal(new Set(targets.map(target => target.memberId)).size, 2);
  assert.notEqual(resolveInputTarget(score, targets[0]).note, resolveInputTarget(score, targets[1]).note);
  const next = applyInputTargetsDegreeStep(score, [targets[1]], 1);
  ({ score } = roundTrip(score, next.targets, format));
  assert.deepEqual(chord(score).notes.map(note => note.number).sort(), ["3", "3", "4"]);

  // Equal-pitch members can still have different endpoints. The selected
  // short attack must not inherit its longer neighbour's tied tail.
  score = parse();
  targets = chord(score).notes.filter(note => note.number !== "3").map(note => inputTargetFromNote(score, 0, note, 16));
  const shorter = setInputTargetsWrittenDuration(score, targets, () => new Fraction(1, 2));
  assert.equal(shorter.blocked, 0);
  ({ score, targets } = roundTrip(score, shorter.targets, format));
  targets = targets.filter(target => resolveInputTarget(score, target).note?.number === "1");
  const unison = applyInputTargetsDegree(score, targets, 3);
  ({ score, targets } = roundTrip(score, unison.targets, format));
  assert.equal(inputNoteWrittenDuration(resolveInputTarget(score, targets[0]).note!).toString(), "1/2",
    `${format}: same-pitch rebind chose the neighbouring member's duration`);
}

// The one-degree command crosses both diatonic half steps and the octave
// boundary as a batch, with an inverse operation restoring every note.
{
  const score = parse();
  const targets = [1, 2, 3].map(offset => inputTargetFromNote(score, 0, chord(score, offset).notes[0], 16));
  const up = applyInputTargetsDegreeStep(score, targets, 1);
  assert.equal(up.blocked, 0);
  assert.deepEqual(up.targets.map(target => resolveInputTarget(score, target).note?.number), ["4", "7", "1"]);
  assert.deepEqual(up.targets.map(target => resolveInputTarget(score, target).note?.pitch), [65, 71, 72]);
  const down = applyInputTargetsDegreeStep(score, up.targets, -1);
  assert.deepEqual(down.targets.map(target => resolveInputTarget(score, target).note?.pitch), [64, 69, 71]);
}

// An in-memory reordering must not redirect an existing concrete target.
{
  const score = parse();
  const selected = chord(score).notes[0];
  const target = inputTargetFromNote(score, 0, selected, 16);
  chord(score).notes.reverse();
  assert.equal(resolveInputTarget(score, target).note, selected);
}
console.log("selection-stability-check: ok (crossing, unisons, member identities, session restore, degree boundaries)");
