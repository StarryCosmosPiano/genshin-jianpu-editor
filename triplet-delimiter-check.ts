import assert from "node:assert/strict";
import { Fraction } from "./src/common/fraction";
import { preserveUnchangedSlashGroups } from "./src/editor/preserve-slash-delimiters";
import { Chord, type Score } from "./src/score/score";
import { createInputTriplet } from "./src/score/input-edit";
import {
  analyzeSlashScore, defaultSlashScoreOptions, embedSlashScoreOptionsFromScore,
  parseSlashScore, replaceSlashScoreLines, rewriteSlashDurationDirectives,
  scoreToSlashScore,
} from "./src/slashscore";

const z = "\u2063";
const row = `(V${z}D${z}G).${z}A.${z}N.(${z}D${z}G)./.${z}A.${z}N.${z}A./(B${z}D${z}G).${z}A.${z}N.(${z}D${z}G)./.${z}N.${z}A.${z}N./`;
const source = `键盘谱\n4/4拍：\n. = 16分音符\n${row}\n`;
const options = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(source)),
  voiceCount: 2,
  beats: 4,
  beatType: 4 as const,
  symbolDurations: { ".": 16 as const },
  braceMode: "chord" as const,
  bracketMode: "triplet" as const,
  parenMode: "chord" as const,
};
const score = parseSlashScore(source, options).score;
assert(createInputTriplet(score, {
  partIndex: 0, measureIndex: 0, offset: new Fraction(0),
}, new Fraction(1)).changed);
const generated = scoreToSlashScore(score, "keyboard", 16, ".", {
  ...options, durationNotation: options,
}, 2);
const rewritten = rewriteSlashDurationDirectives(
  replaceSlashScoreLines(source, generated, "keyboard"), options,
);
const preserved = preserveUnchangedSlashGroups(source, rewritten, "keyboard", options);
const final = embedSlashScoreOptionsFromScore(preserved, score, options);
const savedRow = final.split(/\r?\n/).find((line) => line.includes("/" ) && line.includes("G"))!;
assert(savedRow.includes("["), savedRow);
assert(savedRow.includes(`(B${z}D${z}G)`), savedRow);
assert(savedRow.includes(`(${z}D${z}G)`), savedRow);
const events = (value: Score) => value.parts.map((part) => part.measures.map((measure) =>
  measure.entries.filter((entry): entry is Chord => entry instanceof Chord)
    .map((entry) => [entry.position.toString(), entry.duration?.toString(), entry.rest,
      entry.notes.filter((note) => !note.rest).map((note) => note.pitch).sort((a, b) => a - b),
      entry.notes.some((note) => note.tuplet !== null)])));
assert.deepEqual(events(parseSlashScore(final, options).score), events(score));

// Equivalent custom delimiters retain the author's spelling in every
// untouched group, including one on the edited row.
const custom = { ...options, braceMode: "triplet" as const };
const customSource = `键盘谱\n[ABC]/(DE)/{FGH}/\n`;
const customGenerated = `键盘谱\n{ABC}/(DE)/{FGH}/\n`;
assert.equal(
  preserveUnchangedSlashGroups(customSource, customGenerated, "keyboard", custom),
  `键盘谱\n[ABC]/(DE)/{FGH}/\n`,
);
// Different configured meanings must never be substituted into an edited
// group merely because its characters look similar.
assert.equal(
  preserveUnchangedSlashGroups("键盘谱\n(AB)/\n", "键盘谱\n[AB]/\n", "keyboard", options),
  "键盘谱\n[AB]/\n",
);
// A compact line with multiple measures has no safe row mapping.
assert.equal(
  preserveUnchangedSlashGroups("键盘谱\n(AB)/(CD)/\n", "键盘谱\n{AB}/\n{CD}/\n", "keyboard", options),
  "键盘谱\n{AB}/\n{CD}/\n",
);
console.log("triplet-delimiter-check: ok");
