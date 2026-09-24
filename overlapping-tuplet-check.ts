import assert from "node:assert/strict";
import { Fraction } from "./src/common/fraction";
import { Chord, Part, Score } from "./src/score/score";
import { createInputTriplet, ensureInputMeasure, inputNoteAtCursor } from "./src/score/input-edit";
import {
  analyzeSlashScore, defaultSlashScoreOptions, embedSlashScoreOptionsFromScore,
  parseSlashScore, scoreToSlashScore, type SlashScoreOptions,
} from "./src/slashscore";

const seed = "键盘谱\n4/4拍：\n点=16分音符\n0.0.0.0./\n";
const options: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(seed)),
  voiceCount: 2, beats: 4, beatType: 4, symbolDurations: { ".": 16 }, noteDivision: null,
  braceMode: "chord", parenMode: "chord",
};
const cursor = (partIndex: number, offset: Fraction) => ({ partIndex, measureIndex: 0, offset });
const entries = (score: Score, partIndex: number) => score.parts[partIndex]!.measures[0]!.entries
  .filter((entry): entry is Chord => entry instanceof Chord)
  .filter((entry) => !entry.rest || entry.notes.some((note) => note.tuplet !== null))
  .sort((a, b) => a.position.compareTo(b.position));
const snapshot = (score: Score) => score.parts.map((_, partIndex) => entries(score, partIndex).map((entry) => ({
  at: entry.position.toString(), end: entry.position.plus(entry.duration ?? new Fraction(0)).toString(),
  pitches: entry.notes.filter((note) => !note.rest).map((note) => note.pitch).sort((a, b) => a - b),
  tuplet: entry.notes.some((note) => note.tuplet !== null),
})));
const save = (score: Score) => embedSlashScoreOptionsFromScore(scoreToSlashScore(
  score, "keyboard", 16, ".", { ...options, durationNotation: options }, 2,
), score, options);
const reopen = (text: string, label: string) => {
  const result = parseSlashScore(text, defaultSlashScoreOptions("keyboard", analyzeSlashScore(text)));
  assert(!result.summary.diagnostics.some((item) => item.severity === "error"),
    `${label}: ${JSON.stringify(result.summary.diagnostics)}\n${text}`);
  return result.score;
};
const verify = (score: Score, label: string, cycle: number): Score => {
  const expected = snapshot(score);
  const text = save(score);
  const actual = reopen(text, `${label} save ${cycle}`);
  assert.deepEqual(snapshot(actual), expected, `${label} save ${cycle}\n${text}`);
  return actual;
};

const z = "\u2063";
const userSource = `键盘谱\n4/4拍：\n点=16分音符\n(V${z}D${z}G).${z}A.${z}N.(${z}D${z}G)./.${z}A.${z}N.${z}A./(B${z}D${z}G).${z}A.${z}N.(${z}D${z}G)./.${z}N.${z}A.${z}N./\n`;
{
  let score = parseSlashScore(userSource, options).score;
  score = verify(score, "user fixture", 1);
  const ordinaryFirst = snapshot(score)[0]!.filter((event) => !event.tuplet);
  const second = createInputTriplet(score, cursor(1, new Fraction(0)), new Fraction(1, 4));
  assert(second.changed, `user fixture second: ${second.reason}`);
  score = verify(score, "user fixture", 2);
  assert.deepEqual(snapshot(score)[0]!.filter((event) => !event.tuplet), ordinaryFirst);
  const first = createInputTriplet(score, cursor(0, new Fraction(1, 4)), new Fraction(1, 4));
  assert(first.changed, `user fixture first: ${first.reason}`);
  const expected = snapshot(score);
  for (let cycle = 3; cycle <= 5; cycle++) {
    score = verify(score, "user fixture", cycle);
    assert.deepEqual(snapshot(score), expected, `user fixture drift after save ${cycle}`);
  }
  const validText = save(score);
  const overfullText = validText.replace(/\](?=\/)/, "].");
  assert.notEqual(overfullText, validText, "missing shared bracket for diagnostic negative case");
  const overfull = parseSlashScore(overfullText,
    defaultSlashScoreOptions("keyboard", analyzeSlashScore(overfullText)));
  assert(overfull.summary.diagnostics.some((item) => item.severity === "error"),
    `extra duration after metadata-backed shared bracket was accepted:\n${overfullText}`);
  for (const [offset, pitch, number] of [
    [new Fraction(1, 3), 62, "2"],
    [new Fraction(5, 12), 64, "3"],
  ] as const) {
    assert(inputNoteAtCursor(score,
      { ...cursor(0, offset), division: 16, lane: "rest" },
      { pitch, number }, new Fraction(1, 4)).changed,
    `user fixture fill ${offset}`);
  }
  const filled = snapshot(score);
  assert.deepEqual(filled[0]!.filter((event) => event.tuplet).map((event) => event.pitches),
    [[60], [62], [64]]);
  for (let cycle = 6; cycle <= 8; cycle++) {
    score = verify(score, "user fixture filled", cycle);
    assert.deepEqual(snapshot(score), filled, `filled triplet drift after save ${cycle}`);
  }
}

// A first voice can start within, at, or before the second voice's triplet.
// Sixteenth through whole values are clipped by the 4/4 measure.
for (const secondDuration of [new Fraction(1, 4), new Fraction(1, 2), new Fraction(1), new Fraction(2), new Fraction(4)]) {
  for (const firstDuration of [new Fraction(1, 4), new Fraction(1, 2), new Fraction(1), new Fraction(2), new Fraction(4)]) {
    for (const secondOffset of [new Fraction(0), new Fraction(1, 4), new Fraction(1, 2), new Fraction(1), new Fraction(2)]) {
      for (const firstOffset of [new Fraction(0), new Fraction(1, 4), new Fraction(1, 2), new Fraction(1), new Fraction(2)]) {
        if (secondOffset.plus(secondDuration).compareTo(4) > 0
          || firstOffset.plus(firstDuration).compareTo(4) > 0) continue;
        // Keep the source cells on their ordinary beat boundaries. A binary
        // note crossing its own beat group may be split into a tied printed
        // continuation before either tuplet is created.
        if (secondOffset.toFloat() % secondDuration.toFloat() !== 0
          || firstOffset.toFloat() % firstDuration.toFloat() !== 0) continue;
        if (firstOffset.compareTo(secondOffset.plus(secondDuration)) >= 0
          || secondOffset.compareTo(firstOffset.plus(firstDuration)) >= 0) continue;
        const label = `second=${secondOffset}/${secondDuration} first=${firstOffset}/${firstDuration}`;
        let score = new Score();
        score.parts.push(new Part(), new Part());
        score.parts[1]!.voiceIndex = 2;
        for (const partIndex of [0, 1]) ensureInputMeasure(score, partIndex, 0);
        assert(inputNoteAtCursor(score,
          { ...cursor(0, firstOffset), division: 16, lane: "rest" },
          { pitch: 60, number: "1" }, firstDuration).changed, label);
        assert(inputNoteAtCursor(score,
          { ...cursor(1, secondOffset), division: 16, lane: "rest" },
          { pitch: 67, number: "5" }, secondDuration).changed, label);
        score = verify(score, label, 1);
        const second = createInputTriplet(score, cursor(1, secondOffset), secondDuration);
        assert(second.changed, `${label}: second ${second.reason}`);
        score = verify(score, label, 2);
        const first = createInputTriplet(score, cursor(0, firstOffset), firstDuration);
        assert(first.changed, `${label}: first ${first.reason}`);
        score = verify(score, label, 3);
        score = verify(score, label, 4);
      }
    }
  }
}
console.log("overlapping-tuplet-check: ok");
