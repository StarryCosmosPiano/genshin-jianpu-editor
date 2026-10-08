import assert from "node:assert/strict";
import fixtures from "./fixtures/triplet-roundtrip-repairs.json";
import randomFixtures from "./fixtures/triplet-random-repairs.json";
import { Fraction } from "./src/common/fraction";
import { createInputTriplet, inputNoteAtCursor } from "./src/score/input-edit";
import { Score } from "./src/score/score";
import { buildTimeline } from "./src/score/timeline";
import {
  analyzeSlashScore, defaultSlashScoreOptions, embedSlashScoreOptionsFromScore,
  parseSlashScore, scoreToSlashScore,
} from "./src/slashscore";

const read = (text: string) => {
  const analysis = analyzeSlashScore(text);
  const options = defaultSlashScoreOptions(analysis.detectedKind, analysis);
  const result = parseSlashScore(text, options);
  assert.deepEqual(result.summary.diagnostics.filter((d) => d.severity === "error"), []);
  return { score: result.score, options };
};
const snapshot = (score: Score) => {
  const timeline = buildTimeline(score);
  const tick = (value: number) => Math.round(value * 192);
  return { duration: tick(timeline.duration), notes: timeline.notes.map((note) => ({
    part: note.part, pitch: note.pitch, start: tick(note.t0), end: tick(note.t1),
  })).sort((a, b) => a.part - b.part || a.start - b.start || a.pitch - b.pitch || a.end - b.end) };
};
let saves = 0;
for (const fixture of fixtures) {
  let { score, options } = read(fixture.beforeText);
  const roundtrip = () => {
    const expected = snapshot(score);
    const text = embedSlashScoreOptionsFromScore(scoreToSlashScore(score, options.kind, 16, ".", {
      ...options, durationNotation: options,
      preserveExplicitRestMeasures: score.parts[0]!.measures.map((_, i) => i),
    }, options.voiceCount), score, options);
    const next = read(text);
    assert.deepEqual(snapshot(next.score), expected, `${fixture.id}: sound changed during save ${saves}`);
    score = next.score;
    options = next.options;
    saves++;
  };
  // The unedited save is a control for unrelated serialization drift.
  roundtrip();
  const op = fixture.operation;
  const edit = createInputTriplet(score, {
    partIndex: op.part - 1, measureIndex: op.measure - 1,
    offset: Fraction.fromString(op.offset),
  }, new Fraction(1, 4), Fraction.fromString(op.span));
  assert(edit.changed, `${fixture.id}: ${edit.reason}`);
  for (let cycle = 0; cycle < 3; cycle++) roundtrip();
  if (fixture.id === "R8-S0") {
    for (const [offset, pitch] of [["29/12", 62], ["31/12", 64]] as const) {
      const fill = inputNoteAtCursor(score, {
        partIndex: 0, measureIndex: 0, offset: Fraction.fromString(offset), division: 16, lane: "rest",
      }, { pitch, number: pitch === 62 ? "2" : "3" }, new Fraction(1, 6));
      assert(fill.changed);
      roundtrip();
    }
    for (let cycle = 0; cycle < 3; cycle++) roundtrip();
  }
}

// Independently assert the original minimal parser failures. A same-pitch
// attack after a tied duration must remain a separate new attack.
const filled = fixtures.find((fixture) => fixture.id === "R8-S0")!.filledText!;
const held = snapshot(read(filled).score).notes.filter((note) => note.part === 0 && note.pitch === 65);
assert.deepEqual(held, [
  { part: 0, pitch: 65, start: 528, end: 720 },
  { part: 0, pitch: 65, start: 720, end: 768 },
]);
const saved = fixtures.find((fixture) => fixture.id === "M127")!.savedText!;
assert(snapshot(read(saved).score).notes.some((note) => note.part === 0
  && note.pitch === 63 && note.start === 576 && note.end === 768),
"the earlier mixed bracket must not consume a later voice-local tuplet source");
console.log(`triplet-roundtrip-repair-check: six confirmed UI failures, ${saves} saves and exact playback OK`);

for (const fixture of randomFixtures) {
  let { score, options } = read(fixture.beforeText);
  const save = () => {
    const expected = snapshot(score);
    const text = embedSlashScoreOptionsFromScore(scoreToSlashScore(score, options.kind, 16, ".", {
      ...options, durationNotation: options,
      preserveExplicitRestMeasures: score.parts[0]!.measures.map((_, i) => i),
    }, options.voiceCount), score, options);
    const next = read(text);
    assert.deepEqual(snapshot(next.score), expected, `${fixture.id}: randomized sound replay`);
    score = next.score;
    options = next.options;
  };
  // Freeze every previously failing random operation, including no-op save.
  save();
  if (fixture.operation) {
    const op = fixture.operation;
    const cursor = { partIndex: op.part - 1, measureIndex: op.measure - 1,
      offset: Fraction.fromString(op.offset) };
    const edit = createInputTriplet(score, cursor, new Fraction(1, 4));
    assert(edit.changed, `${fixture.id}: ${edit.reason}`);
    for (const [index, pitch] of fixture.filledPitches.entries()) {
      if (pitch === null) continue;
      const chord = edit.chords[index + 1]!;
      assert(inputNoteAtCursor(score, { ...cursor, offset: chord.position, division: 16, lane: "rest" },
        { pitch, number: String(index + 2) }, chord.duration!).changed);
    }
  }
  for (let cycle = 0; cycle < 3; cycle++) save();
}
console.log(`triplet-roundtrip-repair-check: ${randomFixtures.length} frozen random cases, four saves each OK`);
