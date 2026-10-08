import assert from "node:assert/strict";
import { Fraction } from "./src/common/fraction";
import { Part, Score } from "./src/score/score";
import { createInputTriplet, ensureInputMeasure, inputNoteAtCursor } from "./src/score/input-edit";
import {
  analyzeSlashScore,
  defaultSlashScoreOptions,
  embedSlashScoreOptionsFromScore,
  scoreToSlashScore,
  slashScoreDiagnostics,
  type SlashScoreOptions,
} from "./src/slashscore";

const z = "\u2063";
const metadata = (kind: "k" | "n", annotations: unknown[]): string =>
  `// @jpeditor ${JSON.stringify({ v: 2, vc: 2, k: kind, m: [4, 4], s: { ".": 16 }, an: annotations })}`;
const header = (kind: "键盘谱" | "数字谱"): string =>
  `${kind}\n4/4拍：\n点=16分音符\n方括号=三连音\n`;
const errors = (text: string): string[] => {
  const analysis = analyzeSlashScore(text);
  const options = defaultSlashScoreOptions(analysis.detectedKind, analysis);
  return slashScoreDiagnostics(text, options)
    .filter((diagnostic) => diagnostic.severity === "error")
    .map((diagnostic) => diagnostic.message);
};

// Two adjacent voice-local triplets of different widths share one slash beat.
const numberGroup = `[(${z}${z}-1${z}6).${z}${z}0.${z}5${z}${z}0.][${z}${z}-2${z}${z}0${z}${z}0].-1.`;
const adjacentAnnotations = [
  { type: "triplet", part: 1, voice: 2, measure: 0, offset: 0,
    scope: "voice", end: 0.5, members: [0.25, 0.25, 0.25], memberRests: [false, true, true], restoreUnit: 0.5 },
  { type: "triplet", part: 1, voice: 2, measure: 0, offset: 0.5,
    scope: "voice", end: 0.75, members: [0.125, 0.125, 0.125], memberRests: [false, true, true], restoreUnit: 0.25 },
];
const number = (group: string): string =>
  header("数字谱") + `${group}/2..../3..../4..../\n` + metadata("n", adjacentAnnotations);
assert.deepEqual(errors(number(numberGroup)), []);
const keyboardGroup = `${z}D.[${z}${z}N.${z}${z}0.${z}A${z}${z}0.][${z}${z}Z${z}${z}X${z}${z}C].`;
const keyboard = header("键盘谱") +
  `Q..../W..../E..../${keyboardGroup}/\n` + metadata("k", adjacentAnnotations.map((annotation, index) => ({
    ...annotation, offset: index === 0 ? 3.25 : 3.75, end: index === 0 ? 3.75 : 4,
  })));
assert.deepEqual(errors(keyboard), []);
assert.match(errors(number(numberGroup.replace("].-1.", "]..-1.")))[0] ?? "", /超过/,
  "an extra suffix duration must remain an overfull beat");
assert.match(errors(number(numberGroup.replace("].-1.", "]-1.")))[0] ?? "", /只有/,
  "a removed suffix duration must remain a short beat");

// Two staggered voices still form a complete beat in the printed grammar.
const staggeredGroup = `[(${z}AG).${z}0.#G${z}0.](${z}#AH).[${z}${z}#H${z}${z}0${z}${z}0].`;
const staggered = header("键盘谱") +
  `${staggeredGroup}/Q..../Q..../Q..../\n` + metadata("k", [
    { type: "triplet", part: 0, voice: 1, measure: 0, offset: 0, scope: "voice", end: 0.5,
      members: [0.25, 0.25, 0.25], memberRests: [false, true, true], restoreUnit: 0.5,
      ordinary: [{ part: 1, offset: 0, duration: 0.25, rest: false },
        { part: 1, offset: 0.25, duration: 0.25, rest: false }] },
    { type: "triplet", part: 1, voice: 2, measure: 0, offset: 0.75, scope: "voice", end: 1,
      members: [0.125, 0.125, 0.125], memberRests: [false, true, true], restoreUnit: 0.25 },
  ]);
assert.deepEqual(errors(staggered), []);

// Separate clusters in one beat may have a normal chord between them. The
// complete unbounded grammar must be used before reconciling their spans.
const separatedGroup = `[${z}G${z}0${z}0].(B${z}J).[${z}H.${z}S.C${z}D.]`;
const separated = (group: string): string => header("键盘谱") +
  `Q..../W..../E..../${group}/\n` + metadata("k", [
    { type: "triplet", part: 0, voice: 1, measure: 0, offset: 3, scope: "voice", end: 3.25,
      members: [0.125, 0.125, 0.125], memberRests: [false, true, true], restoreUnit: 0.25 },
    { type: "triplet", part: 0, voice: 1, measure: 0, offset: 3.5, scope: "voice", end: 4,
      members: [0.25, 0.25, 0.25], memberRests: [false, false, false], restoreUnit: 0.5,
      ordinary: [{ part: 1, offset: 3.75, duration: 0.25, rest: false }] },
  ]);
assert.deepEqual(errors(separated(separatedGroup)), []);
assert.match(errors(separated(separatedGroup + "."))[0] ?? "", /超过/);
assert.match(errors(separated(separatedGroup.replace("].(", "](")))[0] ?? "", /只有/);

// A hand-written score without editor metadata still uses the bracket's
// actual 3:2 grammar and detects both directions of explicit duration edits.
const handwritten = (group: string): string =>
  `键盘谱\n4/4拍：\n. = 16分音符\n方括号 = 三连音\n${group}/Q..../Q..../Q..../`;
assert.deepEqual(errors(handwritten("[A.B.C.]..")), []);
assert.match(errors(handwritten("[A.B.C.]."))[0] ?? "", /只有/);
assert.match(errors(handwritten("[A.B.C.]..."))[0] ?? "", /超过/);

// Two voices may own overlapping triplet ranges; this remains a single
// cluster and must not enter the adjacent-same-voice correction path.
const overlapping = new Score();
overlapping.parts.push(new Part(), new Part());
overlapping.parts[1]!.voiceIndex = 2;
for (const part of [0, 1]) ensureInputMeasure(overlapping, part, 0);
for (const [part, offset, duration, pitch] of [
  [0, 0, 1, 60], [0, 1, 1, 62], [0, 2, 2, 64],
  [1, 0, 0.5, 67], [1, 0.5, 0.5, 69], [1, 1, 1, 71], [1, 2, 2, 72],
] as const) {
  assert(inputNoteAtCursor(overlapping,
    { partIndex: part, measureIndex: 0, offset: new Fraction(offset), division: 16, lane: "rest" },
    { pitch, number: "1" }, new Fraction(duration)).changed);
}
assert(createInputTriplet(overlapping,
  { partIndex: 0, measureIndex: 0, offset: new Fraction(0) }, new Fraction(1, 4)).changed);
assert(createInputTriplet(overlapping,
  { partIndex: 1, measureIndex: 0, offset: new Fraction(0) }, new Fraction(1, 4)).changed);
const baseOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard"),
  voiceCount: 2, beats: 4, beatType: 4,
  symbolDurations: { ".": 16 }, noteDivision: null,
};
const overlapText = embedSlashScoreOptionsFromScore(
  scoreToSlashScore(overlapping, "keyboard", 16, ".",
    { ...baseOptions, durationNotation: baseOptions }, 2),
  overlapping, baseOptions,
);
assert.deepEqual(errors(overlapText), []);
console.log("triplet-diagnostic-check: ok");
