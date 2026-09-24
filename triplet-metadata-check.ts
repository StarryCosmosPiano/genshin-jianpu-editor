import assert from "node:assert/strict";
import { Fraction } from "./src/common/fraction";
import { Chord, Part, Score } from "./src/score/score";
import { createInputTriplet, ensureInputMeasure, inputNoteAtCursor } from "./src/score/input-edit";
import { analyzeSlashScore, defaultSlashScoreOptions, embedSlashScoreOptionsFromScore, parseSlashScore, scoreToSlashScore, type SlashScoreOptions } from "./src/slashscore";

const z = "\u2063";
const source = `键盘谱\n4/4拍：\n点=16分音符\n(V${z}G).${z}W.N.(A${z}W)./.(V${z}W).A.${z}W./B.${z}Q.U.(M${z}J)./.(B${z}Q).M.${z}J./\n`;
const options: SlashScoreOptions = { ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(source)), voiceCount: 2, beats: 4, beatType: 4, symbolDurations: { ".": 16 }, noteDivision: null };
const score = parseSlashScore(source, options).score;
assert(createInputTriplet(score, { partIndex: 1, measureIndex: 0, offset: new Fraction(0) }, new Fraction(1, 4)).changed);
assert(createInputTriplet(score, { partIndex: 0, measureIndex: 0, offset: new Fraction(2) }, new Fraction(1, 4)).changed);
const events = (candidate: Score): unknown[][][] => candidate.parts.map((part) => part.measures.map((measure) => measure.entries.filter((entry): entry is Chord => entry instanceof Chord).map((entry) => [measure.index, entry.position.toString(), entry.position.plus(entry.duration ?? new Fraction(0)).toString(), entry.rest, entry.notes.filter((note) => !note.rest).map((note) => note.pitch).sort((a, b) => a - b), entry.notes.some((note) => note.tuplet !== null), entry.notes.find((note) => note.tuplet)?.tuplet?.scope ?? null])));
const text = embedSlashScoreOptionsFromScore(scoreToSlashScore(score, "keyboard", 16, ".", { ...options, durationNotation: options }, 2), score, options);
const reopened = parseSlashScore(text, defaultSlashScoreOptions("keyboard", analyzeSlashScore(text))).score;
assert.deepEqual(events(reopened), events(score));
const overlapping = new Score();
overlapping.parts.push(new Part(), new Part());
overlapping.parts[1].voiceIndex = 2;
for (const partIndex of [0, 1]) ensureInputMeasure(overlapping, partIndex, 0);
for (const [partIndex, offset, duration, pitch] of [
  [0, 0, 1, 60], [0, 1, 1, 62], [0, 2, 2, 64],
  [1, 0, 0.5, 67], [1, 0.5, 0.5, 69], [1, 1, 1, 71], [1, 2, 2, 72],
]) {
  assert(inputNoteAtCursor(overlapping,
    { partIndex, measureIndex: 0, offset: new Fraction(offset), division: 16, lane: "rest" },
    { pitch, number: "1" }, new Fraction(duration)).changed);
}
const long = createInputTriplet(overlapping, { partIndex: 0, measureIndex: 0, offset: new Fraction(0) }, new Fraction(1, 4));
const short = createInputTriplet(overlapping, { partIndex: 1, measureIndex: 0, offset: new Fraction(0) }, new Fraction(1, 4));
assert(long.changed && long.chords[0].duration?.equals(new Fraction(1, 3)));
assert(short.changed && short.chords[0].duration?.equals(new Fraction(1, 6)));
const shared = embedSlashScoreOptionsFromScore(scoreToSlashScore(overlapping, "keyboard", 16, ".", { ...options, durationNotation: options }, 2), overlapping, options);
const sharedResult = parseSlashScore(shared, defaultSlashScoreOptions("keyboard", analyzeSlashScore(shared))).score;
assert.deepEqual(events(sharedResult), events(overlapping));
console.log("triplet-metadata-check: ok (separate and overlapping voice groups)");
