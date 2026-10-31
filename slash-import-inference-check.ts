import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Chord } from "./src/score/score";
import {
  analyzeSlashScore, defaultSlashScoreOptions, embedSlashScoreOptions, parseSlashScore,
} from "./src/slashscore";

const literal = "    /H   /Q   /(VW)   /\nHQFH/(SE) Q /H FH/Q  W/";
const analysis = analyzeSlashScore(literal);
assert.equal(analysis.suggestedNoteDivision, 16);
assert.equal(analysis.suggestedSpaceDivision, 16);
assert.deepEqual(analysis.suggestedMappings, {});
assert.deepEqual([analysis.meter.beats, analysis.meter.beatType], [4, 4]);
assert.equal(analysis.requiresMeterInput, false);
assert.equal(analysis.timingInferred, true);
assert.deepEqual([analysis.suggestedBraceMode, analysis.suggestedBracketMode,
  analysis.suggestedBarMode, analysis.suggestedAngleMode, analysis.suggestedParenMode],
["none", "none", "none", "none", "chord"]);
const options = defaultSlashScoreOptions("keyboard", analysis);
const parsed = parseSlashScore(literal, options);
assert.deepEqual(parsed.summary.diagnostics, []);
const attacks = parsed.score.parts[0].measures.map(measure => measure.entries
  .filter((entry): entry is Chord => entry instanceof Chord)
  .map(chord => [chord.position.toFloat(), chord.duration?.toFloat(), chord.notes.length, chord.rest]));
assert.deepEqual(attacks[0].map(([at, duration, , rest]) => [at, duration, rest]),
  [[0, 1, true], [1, 1, false], [2, 1, false], [3, 1, false]]);
assert.deepEqual(attacks[1].slice(0, 6).map(([at, duration]) => [at, duration]),
  [[0, .25], [.25, .25], [.5, .25], [.75, .25], [1, .5], [1.5, .5]]);
assert.equal(attacks[0][3][2], 2, "parenthesized chord must occupy one intrinsic duration");

const pending = analyzeSlashScore(`${literal}\nH   /Q   /[DHQ(VW)]/HQFH/`);
assert.equal(pending.suggestedNoteDivision, 16);
assert.equal(pending.suggestedSpaceDivision, 16);
assert.deepEqual(pending.observedDelimiters, ["bracket", "paren"]);
const pendingResult = parseSlashScore(`${literal}\nH   /Q   /[DHQ(VW)]/HQFH/`,
  defaultSlashScoreOptions("keyboard", pending));
assert(pendingResult.summary.diagnostics.some(diagnostic => diagnostic.message.includes("[] 尚未分配")));
assert(pendingResult.score.parts[0].measures.every(measure => measure.entries.every(entry =>
  !(entry instanceof Chord) || entry.notes.every(note => note.tuplet === null))),
"unassigned square brackets must not silently create a triplet");

const independent = analyzeSlashScore("A../B=/C../D=/");
assert.deepEqual(independent.suggestedMappings, { ".": 8, "=": 4 }, "infer real symbols independently");
assert.equal(independent.suggestedNoteDivision, null);
assert.equal(independent.requiresMeterInput, false);
assert.equal(independent.multiDurationSymbols, true);
assert.deepEqual(parseSlashScore("A../B=/C../D=/", defaultSlashScoreOptions("keyboard", independent))
  .score.parts[0].measures[0].entries.filter(entry => entry instanceof Chord).map(entry => entry.duration?.toFloat()),
  [1, 1, 1, 1]);
const ambiguousSymbols = analyzeSlashScore("A...B=/C...D=/E...F=/G...H=/");
assert.equal(ambiguousSymbols.requiresMeterInput, true, "equal beat totals with different inner attacks are ambiguous");
assert.equal(ambiguousSymbols.timingInferred, false);
assert.deepEqual(ambiguousSymbols.suggestedMappings, {});
assert.equal(ambiguousSymbols.requiresSymbolMapping, true);
const explicitSymbolMeter = analyzeSlashScore("4/4拍\nA...B=/C...D=/E...F=/G...H=/");
assert.equal(explicitSymbolMeter.requiresMeterInput, false);
assert.equal(explicitSymbolMeter.requiresSymbolMapping, true, "a known meter does not resolve unknown symbol units");
assert.deepEqual(Object.keys(analyzeSlashScore("A*/B*/C*/D*/").suggestedMappings), ["*"]);
assert.deepEqual(analyzeSlashScore("A/B/C/D/").suggestedMappings, {}, "do not invent an absent duration symbol");
const ambiguous = analyzeSlashScore("A /B /C /D /");
assert.equal(ambiguous.requiresMeterInput, true, "ambiguous spaces require a manual decision");
assert.equal(ambiguous.timingInferred, false);
assert.equal(ambiguous.suggestedNoteDivision, null);
assert.equal(ambiguous.suggestedSpaceDivision, null);
assert.equal(analyzeSlashScore("A/B/C/D/E/F/G/").requiresMeterInput, true);
assert.equal(analyzeSlashScore("A./B=/C*/D~/").requiresMeterInput, true,
  "more than three independent unknown symbols require manual values");
assert.deepEqual(analyzeSlashScore("A./B=/C*/D~/").suggestedMappings, {});
assert.deepEqual(analyzeSlashScore("点=八分音符\nA../B=/C../D=/").suggestedMappings, { ".": 8 },
  "a partial explicit directive cannot invent a value for another symbol");
const three = analyzeSlashScore("ABCD/EFGH/QWER/\nA   /B   /C   /");
assert.deepEqual([three.meter.beats, three.meter.beatType], [3, 4], "prefer common quarter-note meter");

const explicit = analyzeSlashScore("3/4拍\n音符自身时值=八分音符\n空格=八分音符\nA /B /C /");
assert.equal(explicit.suggestedNoteDivision, 8);
assert.equal(explicit.suggestedSpaceDivision, 8);
assert.deepEqual([explicit.meter.beats, explicit.meter.beatType], [3, 4]);
const explicitAmbiguous = analyzeSlashScore("3/4拍\nA /B /C /");
assert.deepEqual([explicitAmbiguous.meter.beats, explicitAmbiguous.meter.beatType], [3, 4]);
assert.equal(explicitAmbiguous.requiresMeterInput, false, "explicit meter cannot be cleared by ambiguous timing");
assert.equal(explicitAmbiguous.timingInferred, false);
const ornamentText = "键盘谱\n4/4拍\n花括号=琶音\n(,ZZ){F#GQR}/-/-/-/";
const ornament = analyzeSlashScore(ornamentText);
assert.equal(ornament.suggestedNoteDivision, null, "explicit ornament syntax preserves its implicit timing model");
assert(parseSlashScore(ornamentText, defaultSlashScoreOptions("keyboard", ornament)).score.parts[0].measures[0].entries
  .some(entry => entry instanceof Chord && entry.arpeggio));
const savedOptions = { ...defaultSlashScoreOptions("keyboard"), symbolDurations: {},
  noteDivision: null, spaceDivision: null };
const saved = analyzeSlashScore(embedSlashScoreOptions("A/B/C/D/", savedOptions));
assert.equal(saved.suggestedNoteDivision, null);
assert.equal(saved.suggestedSpaceDivision, null);
assert.deepEqual(saved.suggestedMappings, {});
assert.equal(saved.suggestedBracketMode, "triplet", "saved legacy modes retain their meaning");
assert.equal(analyzeSlashScore(embedSlashScoreOptions("A*/B*/C*/D*/", savedOptions)).requiresSymbolMapping, false,
  "saved intentional empty mappings are not a new unresolved import");
const legacy = analyzeSlashScore('// @jpeditor {"k":"k","m":[4,4],"s":{},"sp":null,"nd":null}\nA/B/C/D/');
assert.deepEqual([legacy.suggestedBraceMode, legacy.suggestedBracketMode, legacy.suggestedAngleMode],
  ["arpeggio", "triplet", "grace"]);
assert.deepEqual(analyzeSlashScore(`// prose ([{<>}])\n${literal}`).observedDelimiters, ["paren"]);

if (process.argv[2]) {
  const imported = analyzeSlashScore(readFileSync(process.argv[2], "utf8"));
  assert.deepEqual([imported.suggestedNoteDivision, imported.suggestedSpaceDivision], [16, 16]);
  assert.deepEqual([imported.meter.beats, imported.meter.beatType], [4, 4]);
  assert.deepEqual(imported.suggestedMappings, {});
  assert.equal(imported.requiresMeterInput, false);
  console.log("PASS optional real-world space-timed score");
}
console.log("PASS slash import timing: intrinsic/space units, common meters, actual symbols, bracket defaults and saved options");
