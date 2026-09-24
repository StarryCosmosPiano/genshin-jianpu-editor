import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { Fraction } from "./src/common/fraction";
import { buildScoreLayoutSnapshot } from "./src/layout/score-layout-snapshot";
import {
  BeamGroup, Chord, CrossPartArpeggio, KeyMark, Measure, Note,
  Part, Score, ScoreTextMark, TempoMark, Tuplet,
} from "./src/score/score";
import { analyzeSlashScore, defaultSlashScoreOptions, parseSlashScore } from "./src/slashscore";

function sample() {
  const score = new Score();
  const notes: Note[][] = [];
  const chords: Chord[][] = [];
  for (let partIndex = 0; partIndex < 2; partIndex++) {
    const part = new Part();
    part.hand = partIndex === 0 ? "right" : "left";
    score.parts.push(part);
    notes[partIndex] = [];
    chords[partIndex] = [];
    for (let measureIndex = 0; measureIndex < 3; measureIndex++) {
      const measure = new Measure(measureIndex);
      measure.position = new Fraction(measureIndex * 4);
      part.measures.push(measure);
      const chord = new Chord(measure);
      chord.position = new Fraction(0);
      chord.duration = new Fraction(1);
      chord.beats = 1;
      chord.ornaments.push({ kind: "trill", subdivision: 16 });
      measure.add(chord);
      const note = new Note(chord);
      note.number = String(measureIndex + 1);
      note.pitch = 60 + partIndex * 12 + measureIndex;
      chord.add(note);
      notes[partIndex].push(note);
      chords[partIndex].push(chord);
    }
  }
  notes[0][0].tieNext = notes[0][1];
  notes[0][1].tiePrev = notes[0][0];
  chords[1][0].slurEndChord = chords[1][1];
  notes[1][0].tuplet = new Tuplet(notes[1][0], notes[1][1]);
  notes[1][1].tuplet = notes[1][0].tuplet;
  const tempo = new TempoMark();
  tempo.measure = 1;
  tempo.bpm = 108;
  score.tempoMarks.push(tempo);
  score.keyMarks.push(new KeyMark(1, new Fraction(1, 2), 2));
  const text = new ScoreTextMark();
  text.measure = 1;
  text.text = "dolce";
  score.textMarks.push(text);
  const roll = new CrossPartArpeggio();
  roll.measure = 0;
  roll.parts = [0, 1];
  roll.pitches = [{ part: 0, pitch: 60 }, { part: 1, pitch: 72 }];
  score.crossPartArpeggios.push(roll);
  return { score, notes, chords, tempo, text, roll };
}

const first = sample();
const second = sample();
const initial = buildScoreLayoutSnapshot(first.score);
const reparsed = buildScoreLayoutSnapshot(second.score);
assert.deepEqual(reparsed.measureKeys, initial.measureKeys,
  "freshly parsed equivalent models must have stable keys");
assert.equal(reparsed.globalKey, initial.globalKey);
for (const [oldModel, address] of initial.modelKeys) {
  const newModel = reparsed.models.get(address);
  assert(newModel, `missing fresh model for ${address}`);
  assert.equal(reparsed.modelKeys.get(newModel), address);
  assert.notEqual(newModel, oldModel, "rebind must use the new score object");
}
assert.equal(reparsed.models.get(initial.modelKeys.get(first.chords[0][0].ornaments[0])!),
  second.chords[0][0].ornaments[0], "plain ornament data must rebind");
assert.equal(reparsed.models.get(initial.modelKeys.get(first.tempo)!), second.tempo);
assert.equal(reparsed.models.get(initial.modelKeys.get(first.text)!), second.text);
assert.equal(reparsed.models.get(initial.modelKeys.get(first.roll)!), second.roll);

second.chords[0][0].beamGroup = new BeamGroup();
assert.deepEqual(buildScoreLayoutSnapshot(second.score).measureKeys, initial.measureKeys,
  "autoBeamGroup's derived cache must not invalidate layout");

second.notes[0][1].pitch++;
const changedTie = buildScoreLayoutSnapshot(second.score);
assert.notEqual(changedTie.measureKeys[0][0], initial.measureKeys[0][0],
  "the source of a cross-measure tie depends on its destination's contents");
assert.notEqual(changedTie.measureKeys[0][1], initial.measureKeys[0][1]);
assert.equal(changedTie.measureKeys[0][2], initial.measureKeys[0][2],
  "an unrelated later measure remains reusable");
assert.equal(changedTie.measureKeys[1][0], initial.measureKeys[1][0],
  "an unrelated part remains reusable");

const changedSlur = sample();
changedSlur.notes[1][1].number = "7";
const slurKeys = buildScoreLayoutSnapshot(changedSlur.score).measureKeys;
assert.notEqual(slurKeys[1][0], initial.measureKeys[1][0],
  "cross-measure slur endpoints contribute to the source key");

const changedTuplet = sample();
changedTuplet.notes[1][0].tuplet!.ratioNumerator = 5;
const tupletKeys = buildScoreLayoutSnapshot(changedTuplet.score).measureKeys;
assert.notEqual(tupletKeys[1][0], initial.measureKeys[1][0]);
assert.notEqual(tupletKeys[1][1], initial.measureKeys[1][1],
  "shared tuplets invalidate members in other measures");

const changedOrnament = sample();
changedOrnament.chords[0][0].ornaments[0] = { kind: "lower-mordent" };
assert.notEqual(buildScoreLayoutSnapshot(changedOrnament.score).measureKeys[0][0],
  initial.measureKeys[0][0]);

const changedText = sample();
changedText.text.text = "cantabile";
const textKeys = buildScoreLayoutSnapshot(changedText.score).measureKeys;
assert.notEqual(textKeys[0][1], initial.measureKeys[0][1]);
assert.notEqual(textKeys[1][1], initial.measureKeys[1][1]);
assert.equal(textKeys[0][2], initial.measureKeys[0][2]);

const changedTempo = sample();
changedTempo.tempo.bpm = 120;
assert.notEqual(buildScoreLayoutSnapshot(changedTempo.score).globalKey,
  initial.globalKey, "tempo ramps conservatively invalidate all measures");

const sharedValues = sample();
sharedValues.notes[0][0].tieNext = null;
sharedValues.notes[0][1].tiePrev = null;
sharedValues.score.parts[0].measures[1].key = sharedValues.score.parts[0].measures[0].key;
sharedValues.score.parts[0].measures[1].time = sharedValues.score.parts[0].measures[0].time;
const sharedBefore = buildScoreLayoutSnapshot(sharedValues.score);
sharedValues.notes[0][0].pitch++;
const sharedAfter = buildScoreLayoutSnapshot(sharedValues.score);
assert.equal(sharedAfter.measureKeys[0][1], sharedBefore.measureKeys[0][1],
  "shared Key/Time value objects must not form dependencies");

const inserted = sample();
inserted.score.parts[0].measures.splice(0, 0, new Measure(0));
assert.notEqual(buildScoreLayoutSnapshot(inserted.score).measureKeys[0][1],
  initial.measureKeys[0][0], "measure position in its part participates in the key");

function withDetachedEndpoints() {
  const result = sample();
  const formerMeasure = new Measure(99);
  const tieChord = new Chord(formerMeasure);
  const tieTarget = new Note(tieChord);
  tieTarget.pitch = 83;
  tieChord.add(tieTarget);
  formerMeasure.add(tieChord);
  formerMeasure.entries = []; // A prior edit removed the endpoint from the score tree.
  result.notes[0][0].tieNext = tieTarget;
  tieTarget.tiePrev = result.notes[0][0];
  result.notes[0][1].tiePrev = null;

  const slurChord = new Chord(formerMeasure);
  const slurTarget = new Note(slurChord);
  slurTarget.pitch = 91;
  slurChord.add(slurTarget);
  result.chords[1][0].slurEndChord = slurChord;
  return { ...result, tieTarget, slurTarget };
}
const detachedA = withDetachedEndpoints();
const detachedB = withDetachedEndpoints();
const detachedBefore = buildScoreLayoutSnapshot(detachedA.score);
const detachedReparsed = buildScoreLayoutSnapshot(detachedB.score);
assert.deepEqual(detachedReparsed.measureKeys, detachedBefore.measureKeys,
  "equivalent detached endpoint graphs must serialize identically");
assert.equal(detachedBefore.modelKeys.has(detachedA.tieTarget), false,
  "only models in the current score tree receive rebind addresses");
detachedA.tieTarget.pitch++;
assert.notEqual(buildScoreLayoutSnapshot(detachedA.score).measureKeys[0][0],
  detachedBefore.measureKeys[0][0], "a detached tie target still affects layout");
detachedA.slurTarget.pitch++;
assert.notEqual(buildScoreLayoutSnapshot(detachedA.score).measureKeys[1][0],
  detachedBefore.measureKeys[1][0], "a detached slur target still affects layout");

const cyclicContainers = sample();
const cyclicMap = new Map<string, unknown>();
const cyclicSet = new Set<unknown>();
cyclicMap.set("self", cyclicMap);
cyclicSet.add(cyclicSet);
(cyclicContainers.score as Score & { extra?: unknown }).extra = [cyclicMap, cyclicSet];
assert.doesNotThrow(() => buildScoreLayoutSnapshot(cyclicContainers.score),
  "unregistered Map/Set containers must be tracked before expansion");

console.log("score layout snapshot checks passed");

// The production-sized piano fixture also detects accidental fan-out from
// shared value objects and measures the warm snapshot cost.
const z = "\u2063";
const longRow = ["V", "B", "N", "M"]
  .map((bass) => `(${bass}${z}G).${z}A.${z}S.${z}D./`).join("");
const longText = `键盘谱\n4/4拍：\n点=16分音符\n${Array(256).fill(longRow).join("\n")}\n`;
const longOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(longText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 },
};
const longScore = parseSlashScore(longText, longOptions).score;
buildScoreLayoutSnapshot(longScore);
const start = performance.now();
const before = buildScoreLayoutSnapshot(longScore);
const elapsed = performance.now() - start;
const finalMeasure = longScore.parts[0].measures.at(-1)!;
const finalChord = finalMeasure.entries.filter((entry): entry is Chord => entry instanceof Chord).at(-1)!;
finalChord.notes[0].pitch++;
const after = buildScoreLayoutSnapshot(longScore);
const invalidated = before.measureKeys.flatMap((part, partIndex) => part
  .filter((key, measureIndex) => key !== after.measureKeys[partIndex][measureIndex])).length;
assert(invalidated <= 2, `one changed final note invalidated ${invalidated} measures`);
console.log(JSON.stringify({ parts: longScore.parts.length,
  measures: longScore.parts[0].measures.length, snapshotMs: +elapsed.toFixed(1), invalidated,
  keyChars: before.measureKeys[0][0].length,
  playbackRanges: longScore.playData.measures.length }));
