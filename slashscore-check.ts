import { Chord } from "./src/score/score";
import { buildTimeline } from "./src/score/timeline";
import { fromJpw } from "./src/score/jpwimport";
import { JpwFile } from "./src/jpword/jpwfile";
import { buildSlashSourceNotes, editSlashPitch } from "./src/editor/note-selection";
import { readFileSync } from "node:fs";
import {
  analyzeSlashScore,
  defaultSlashScoreOptions,
  embedSlashScoreOptions,
  inferSlashVoiceCount,
  migrateSlashVoiceCount,
  parseSlashScore,
  scoreToSlashScore,
  SLASH_VOICE_SEPARATOR,
  stripSlashVoiceMarkers,
  type SlashScoreOptions,
} from "./src/slashscore";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sounding(score: ReturnType<typeof parseSlashScore>["score"]): Array<{ pitches: number[]; at: number; duration: number }> {
  const part = score.parts[0];
  return part.measures.flatMap((measure) => measure.entries
    .filter((entry): entry is Chord => entry instanceof Chord && !entry.rest)
    .map((chord) => ({
      pitches: chord.notes.filter((note) => !note.rest).map((note) => note.pitch).sort((a, b) => a - b),
      at: measure.position.toFloat() + chord.position.toFloat(),
      duration: chord.duration?.toFloat() ?? 0,
    })));
}

const keyboard = `这里是会保留的说明文字
键盘谱
4/4拍：
速度=四分音符(123 BPM)
点=八分音符

 - / - /S.D./Q../ [line1]
(VJ).Q./(ZG)../B.S./D.Q./
`;

const number = `数字谱
4/4拍：
速度=四分音符(123 BPM)
点=八分音符

 - / - /2.3./+1../ [line1]
(-47).+1./(-15)../-5.2./3.+1./
`;

const keyboardAnalysis = analyzeSlashScore(keyboard);
check(keyboardAnalysis.detectedKind === "keyboard", "keyboard kind detection");
check(keyboardAnalysis.measureCount === 2, "keyboard measure count");
check(keyboardAnalysis.ignoredTagCount === 1, "line tag ignored");
check(keyboardAnalysis.commentCount >= 4, "non-score text retained as comments");
check(keyboardAnalysis.meter.beats === 4 && keyboardAnalysis.meter.beatType === 4, "explicit 4/4");

const keyboardOptions = defaultSlashScoreOptions("keyboard", keyboardAnalysis);
const numberOptions = defaultSlashScoreOptions("number", analyzeSlashScore(number));
const keyboardResult = parseSlashScore(keyboard, keyboardOptions);
const numberResult = parseSlashScore(number, numberOptions);
check(!keyboardResult.score.piano && keyboardResult.score.parts.length === 1, "keyboard must be a single staff");
check(!numberResult.score.piano && numberResult.score.parts.length === 1, "number must be a single staff");
check(JSON.stringify(sounding(keyboardResult.score)) === JSON.stringify(sounding(numberResult.score)), "keyboard/number correspondence");
check(sounding(keyboardResult.score).some((item) => item.pitches.length > 1), "parentheses become vertical chords");
check(keyboardResult.score.tempoBpm === 123, "manual tempo preserved");

const mixedNotation = `4/4拍：
点=八分音符
Q../W../E../R../
1../2../3../4../
A../S../D../F../
5../6../7../1../
`;
const mixedAnalysis = analyzeSlashScore(mixedNotation);
const mixedKeyboardOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", mixedAnalysis),
  kind: "keyboard",
  beats: 4,
  beatType: 4,
};
const mixedNumberOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("number", mixedAnalysis),
  kind: "number",
  beats: 4,
  beatType: 4,
};
const mixedKeyboardResult = parseSlashScore(mixedNotation, mixedKeyboardOptions);
const mixedNumberResult = parseSlashScore(mixedNotation, mixedNumberOptions);
check(mixedKeyboardResult.summary.measures === 2
  && mixedNumberResult.summary.measures === 2,
"mixed keyboard/number TXT did not ignore the unselected notation lines");
check(sounding(mixedKeyboardResult.score).length === 8
  && sounding(mixedNumberResult.score).length === 8,
"unselected mixed-notation lines became rest measures on the shared timeline");
const mixedKeyboardSources = buildSlashSourceNotes(
  mixedNotation,
  mixedKeyboardOptions,
  mixedKeyboardResult.score,
);
const mixedNumberSources = buildSlashSourceNotes(
  mixedNotation,
  mixedNumberOptions,
  mixedNumberResult.score,
);
check(mixedKeyboardSources.every((source) =>
  /^[A-Z]$/.test(mixedNotation.slice(source.from, source.to)))
  && mixedNumberSources.every((source) =>
    /^[1-7]$/.test(mixedNotation.slice(source.from, source.to))),
"mixed-notation text/score selection mapping retained pitches from the ignored notation");

const editableNumber = `数字谱
4/4拍：
点=八分音符
1./(35)./7./+1./
`;
const editableNumberOptions = defaultSlashScoreOptions("number", analyzeSlashScore(editableNumber));
const editableNumberScore = parseSlashScore(editableNumber, editableNumberOptions).score;
const numberSources = buildSlashSourceNotes(editableNumber, editableNumberOptions, editableNumberScore);
check(numberSources.length === 5, "number slash-score pitches were not mapped back to editable TXT ranges");
check(numberSources.map((source) => editableNumber.slice(source.from, source.to)).join("|") === "1|3|5|7|+1",
  "number slash-score source ranges do not cover the exact pitch spellings");
check(editSlashPitch("-3", "number", { kind: "number", number: "6" }) === "-6" &&
  editSlashPitch("-3", "number", { kind: "octave", delta: 1 }) === "3",
"number slash-score pitch editing lost the octave prefix");

const editableKeyboard = `键盘谱
4/4拍：
点=八分音符
A./(DG)./J./Q./
`;
const editableKeyboardOptions = defaultSlashScoreOptions("keyboard", analyzeSlashScore(editableKeyboard));
const editableKeyboardScore = parseSlashScore(editableKeyboard, editableKeyboardOptions).score;
const keyboardSources = buildSlashSourceNotes(editableKeyboard, editableKeyboardOptions, editableKeyboardScore);
check(keyboardSources.length === 5, "keyboard slash-score pitches were not mapped back to editable TXT ranges");
check(editSlashPitch("A", "keyboard", { kind: "number", number: "3" }) === "D" &&
  editSlashPitch("D", "keyboard", { kind: "octave", delta: 1 }) === "E",
"keyboard slash-score 1–7 / octave editing did not preserve its key-row spelling");

const spaceText = `数字谱
4/4拍：
空格=16分音符
1    /2    /3    /4    /
`;
const spaceAnalysis = analyzeSlashScore(spaceText);
const spaceOptions = defaultSlashScoreOptions("number", spaceAnalysis);
check(spaceOptions.spaceDivision === 16, "space duration directive");
const spaceResult = parseSlashScore(spaceText, spaceOptions);
check(sounding(spaceResult.score).length === 4, "spaces advance note durations");

const bracketTripletText = `数字谱
4/4拍：
空格=16分音符
方括号=三连音
[1 2 3 ]/-/-/-/
`;
const bracketTripletOptions = defaultSlashScoreOptions("number", analyzeSlashScore(bracketTripletText));
const bracketTripletTimeline = buildTimeline(parseSlashScore(bracketTripletText, bracketTripletOptions).score);
check(bracketTripletTimeline.notes.slice(0, 3).every((note, index) =>
  Math.abs(note.t0 - index / 6) < 1e-8),
"three nominal sixteenth values in square brackets were not compressed into one eighth-note triplet");

const blankGroupText = `键盘谱
4/4拍：
音符自身时值=8分音符
{QW}/[AS]/-/-/
`;
const blankGroupOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(blankGroupText)),
  braceMode: "none",
  bracketMode: "none",
};
const blankGroupScore = parseSlashScore(blankGroupText, blankGroupOptions).score;
const blankGroupTimeline = buildTimeline(blankGroupScore);
check(blankGroupTimeline.notes.slice(0, 4).every((note, index) =>
  Math.abs(note.t0 - index / 2) < 1e-8),
"blank brace/bracket assignment did not read container contents as ordinary notes");
check(blankGroupScore.parts[0].measures[0].entries.every((entry) =>
  !(entry instanceof Chord) || (!entry.arpeggio && entry.graceNotes.length === 0)),
"blank brace/bracket assignment still created an ornament");

const arpeggioText = `数字谱
4/4拍：
点=16分音符
花括号=琶音
{135}..../-/-/-/
`;
const arpeggioOptions = defaultSlashScoreOptions("number", analyzeSlashScore(arpeggioText));
const arpeggioScore = parseSlashScore(arpeggioText, arpeggioOptions).score;
const arpeggioNotes = sounding(arpeggioScore);
check(arpeggioNotes[0]?.pitches.length === 3 && Math.abs(arpeggioNotes[0].duration - 1) < 1e-8,
  "arpeggio braces did not become one rolled vertical chord with adjacent default duration");
check(arpeggioScore.parts[0].measures[0].entries.some((entry) =>
  entry instanceof Chord && entry.arpeggio),
"arpeggio braces did not retain their visible chord ornament");
const arpeggioSources = buildSlashSourceNotes(arpeggioText, arpeggioOptions, arpeggioScore);
check(arpeggioSources.length === 3 && arpeggioSources.every((source) =>
  source.chord.arpeggio && source.chord.notes.includes(source.note)),
"arpeggio chord tones were not mapped back to their editable source pitches");

const partialArpeggioCases = [
  {
    name: "keyboard braces",
    kind: "keyboard",
    directive: "花括号=琶音",
    token: "{F#GQR}(,ZZ)",
  },
  {
    name: "keyboard brackets",
    kind: "keyboard",
    directive: "方括号=琶音",
    token: "[F#GQR](,ZZ)",
  },
  {
    name: "number braces",
    kind: "number",
    directive: "花括号=琶音",
    token: "{4#5+1+4}(--1-1)",
  },
  {
    name: "number brackets",
    kind: "number",
    directive: "方括号=琶音",
    token: "[4#5+1+4](--1-1)",
  },
] as const;
for (const fixture of partialArpeggioCases) {
  const source = `${fixture.kind === "keyboard" ? "键盘谱" : "数字谱"}
4/4拍：
${fixture.directive}
${fixture.token}/-/-/-/
`;
  const options = defaultSlashScoreOptions(fixture.kind, analyzeSlashScore(source));
  const score = parseSlashScore(source, options).score;
  const chord = score.parts[0].measures[0].entries.find((entry): entry is Chord =>
    entry instanceof Chord && entry.arpeggio);
  check(chord, `${fixture.name} did not attach an arpeggio to the combined chord`);
  const chordPitches = chord.notes.filter((note) => !note.rest)
    .map((note) => note.pitch).sort((left, right) => left - right);
  check(JSON.stringify(chordPitches) === JSON.stringify([36, 48, 65, 68, 72, 77]),
    `${fixture.name} did not combine the simultaneous bass dyad and upper rolled chord`);
  check(JSON.stringify(chord.arpeggioPitches) === JSON.stringify([65, 68, 72, 77]),
    `${fixture.name} did not retain the rolled pitch subset`);
  const mappedSources = buildSlashSourceNotes(source, options, score);
  check(mappedSources.length === 6 && mappedSources.every((item) => item.chord === chord),
    `${fixture.name} did not map both simultaneous and rolled pitches to the combined editable chord`);

  const attacks = new Map(buildTimeline(score).notes
    .filter((note) => note.chord === chord)
    .map((note) => [note.pitch, note.t0]));
  const lowBass = attacks.get(36) ?? Number.NaN;
  const highBass = attacks.get(48) ?? Number.NaN;
  const rolledAttacks = [65, 68, 72, 77].map((pitch) => attacks.get(pitch) ?? Number.NaN);
  check([lowBass, highBass, ...rolledAttacks].every(Number.isFinite),
    `${fixture.name} playback omitted notes from the combined chord`);
  check(Math.abs(lowBass - highBass) < 1e-8 && lowBass < rolledAttacks[0],
    `${fixture.name} did not strike both bass notes together before the rolled subset`);
  check(rolledAttacks.every((attack, index) => index === 0 || rolledAttacks[index - 1] < attack),
    `${fixture.name} did not roll only the bracketed upper notes from low to high`);
}

const prefixedArpeggioTieText = `键盘谱
4/4拍：
点=16分音符
花括号=琶音
{,NZCB}A..../..../-/-/
`;
const prefixedArpeggioTieOptions = defaultSlashScoreOptions(
  "keyboard",
  analyzeSlashScore(prefixedArpeggioTieText),
);
const prefixedArpeggioTieScore = parseSlashScore(
  prefixedArpeggioTieText,
  prefixedArpeggioTieOptions,
).score;
const prefixedArpeggioChords = prefixedArpeggioTieScore.parts[0].measures[0].entries
  .filter((entry): entry is Chord => entry instanceof Chord && !entry.rest);
const prefixedArpeggio = prefixedArpeggioChords.find((chord) => chord.arpeggio);
const prefixedContinuation = prefixedArpeggioChords.find((chord) => chord.transparentContinuation);
check(prefixedArpeggio?.notes.length === 5 && prefixedArpeggio.arpeggioPitches?.length === 4,
  "a prefixed partial arpeggio was not combined with its simultaneous main pitch");
check(prefixedContinuation?.notes.length === 5 && prefixedContinuation.notes.every((note) =>
  note.tieEnd && note.tiePrev?.chord === prefixedArpeggio),
"the complete prefixed arpeggio chord was not tied into its transparent continuation");
const prefixedArpeggioTimeline = buildTimeline(prefixedArpeggioTieScore);
check(prefixedArpeggioTimeline.notes.length === 5 &&
  prefixedArpeggioTimeline.notes.every((note) => note.t0 < 1),
"the tied arpeggio continuation retriggered instead of extending the original five notes");
const prefixedArpeggioSources = buildSlashSourceNotes(
  prefixedArpeggioTieText,
  prefixedArpeggioTieOptions,
  prefixedArpeggioTieScore,
);
check(prefixedArpeggioSources.length === 5 &&
  prefixedArpeggioSources.every((source) => source.chord === prefixedArpeggio) &&
  prefixedArpeggioSources.map((source) =>
    prefixedArpeggioTieText.slice(source.from, source.to)).join("|") === ",N|Z|C|B|A",
"prefixed arpeggio pitches did not retain exact editable TXT highlight ranges");

const graceText = `数字谱
4/4拍：
点=16分音符
花括号=倚音
{2}3..../-/-/-/
`;
const graceOptions = defaultSlashScoreOptions("number", analyzeSlashScore(graceText));
const graceScore = parseSlashScore(graceText, graceOptions).score;
const graceTimeline = buildTimeline(graceScore);
check(graceTimeline.notes.length >= 2 && graceTimeline.notes[0].t0 < graceTimeline.notes[1].t0,
  "grace braces did not play before the following main note");
check(graceScore.parts[0].measures[0].entries.some((entry) =>
  entry instanceof Chord && entry.graceNotes.length === 1),
"grace braces did not remain attached to the main numbered note");
const graceSources = buildSlashSourceNotes(graceText, graceOptions, graceScore);
check(graceSources.length === 2
  && graceSources[0].grace
  && graceText.slice(graceSources[0].from, graceSources[0].to) === "2"
  && !graceSources[1].grace
  && graceText.slice(graceSources[1].from, graceSources[1].to) === "3",
"slash-score grace and main pitches were not mapped to separate editable TXT ranges");

const eighthSpaceText = `键盘谱
4/4拍：
 Q/-/-/-/
`;
const eighthSpaceOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(eighthSpaceText)),
  symbolDurations: {},
  spaceDivision: 8,
  noteDivision: null,
};
const eighthSpaceNotes = sounding(parseSlashScore(eighthSpaceText, eighthSpaceOptions).score);
check(eighthSpaceNotes[0]?.at === 0 && Math.abs((eighthSpaceNotes[0]?.duration ?? -1) - 0.5) < 1e-8,
  "a leading eighth-space did not become part of the first note's duration");

const intrinsicText = `键盘谱
4/4拍：
 Q (CBDGQ)/ Z (ZG)/ Z (CBQ)/ (ZSGW)(BM) /
`;
const intrinsicOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(intrinsicText)),
  symbolDurations: {},
  spaceDivision: 4,
  noteDivision: 4,
};
const intrinsicResult = parseSlashScore(intrinsicText, intrinsicOptions);
const intrinsicNotes = sounding(intrinsicResult.score);
check(intrinsicResult.summary.measures === 4 && intrinsicResult.summary.clippedGroups === 0,
  "note/space intrinsic rhythm did not recognize slash-delimited whole measures");
const finalMeasureNotes = intrinsicNotes.filter((item) => item.at >= 12 && item.at < 16);
check(finalMeasureNotes.length === 3 && finalMeasureNotes[0].at === 12 &&
  finalMeasureNotes[1].at === 13 && finalMeasureNotes[2].at === 14,
"a leading quarter space after slash did not continue the preceding chord");
check(finalMeasureNotes[0].duration === 1 && finalMeasureNotes[1].duration === 1 && finalMeasureNotes[2].duration === 2,
  "cross-group and trailing spaces were not combined into the expected chord durations");
check(finalMeasureNotes[1].pitches.length === 4 && finalMeasureNotes[2].pitches.length === 2,
  "a parenthesized chord counted its keys as separate rhythmic events");
check(analyzeSlashScore(embedSlashScoreOptions(intrinsicText, intrinsicOptions)).measureCount === 4,
  "stored intrinsic rhythm was not restored during the next import analysis");

const crossGroupText = `键盘谱
4/4拍：
(AB)(AC)/ (AD) (AE)/ (AF)  /(AG)  (AH)/
`;
const crossGroupOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(crossGroupText)),
  symbolDurations: {},
  spaceDivision: 16,
  noteDivision: 16,
};
const crossGroupResult = parseSlashScore(crossGroupText, crossGroupOptions);
const crossGroupChords = crossGroupResult.score.parts[0].measures[0].entries
  .filter((entry): entry is Chord => entry instanceof Chord);
const crossGroupRhythm = crossGroupChords.map((chord) => ({
  at: chord.position.toFloat(),
  duration: chord.duration?.toFloat() ?? 0,
  rest: chord.rest,
  continuation: chord.transparentContinuation,
}));
check(JSON.stringify(crossGroupRhythm) === JSON.stringify([
  { at: 0, duration: 0.5, rest: true, continuation: false },
  { at: 0.5, duration: 0.25, rest: false, continuation: false },
  { at: 0.75, duration: 0.25, rest: false, continuation: false },
  { at: 1, duration: 0.25, rest: false, continuation: true },
  { at: 1.25, duration: 0.5, rest: false, continuation: false },
  { at: 1.75, duration: 0.25, rest: false, continuation: false },
  { at: 2, duration: 0.25, rest: false, continuation: true },
  { at: 2.25, duration: 0.75, rest: false, continuation: false },
  { at: 3, duration: 0.75, rest: false, continuation: false },
  { at: 3.75, duration: 0.25, rest: false, continuation: false },
]), "cross-group spaces did not produce the requested rest, continuations, and combined note values");
check(crossGroupChords[2].notes.every((note) => note.tieStart) &&
  crossGroupChords[3].notes.every((note) => note.tieEnd) &&
  crossGroupChords[5].notes.every((note) => note.tieStart) &&
  crossGroupChords[6].notes.every((note) => note.tieEnd),
"transparent slash-group continuations were not tied to the preceding chord");
const crossGroupTimeline = buildTimeline(crossGroupResult.score);
check(crossGroupTimeline.notes.every((note) => note.t0 !== 1 && note.t0 !== 2),
  "transparent continuations must sustain instead of retriggering during playback");
check(crossGroupTimeline.notes.filter((note) => note.t0 === 0.75).every((note) => note.t1 === 1.25) &&
  crossGroupTimeline.notes.filter((note) => note.t0 === 1.75).every((note) => note.t1 === 2.25),
"tied continuation duration was not merged into playback");

const restVariants = `数字谱
4/4拍：
点=16分音符
-/ -.... /-1.../1.../
`;
const restVariantResult = parseSlashScore(
  restVariants,
  defaultSlashScoreOptions("number", analyzeSlashScore(restVariants)),
);
const restVariantNotes = sounding(restVariantResult.score);
check(restVariantNotes.length === 2, "minus-only groups with spacing or duration marks stay rests");
check(restVariantNotes[0]?.at === 2, "two minus-only slash groups consume two empty beats");
check(restVariantNotes[0]?.pitches[0] < restVariantNotes[1]?.pitches[0], "numeric -1 remains a low-octave note");

const pickupText = `数字谱
4/4拍：
3../4../
1../2../3../4../
`;
const pickupResult = parseSlashScore(
  pickupText,
  defaultSlashScoreOptions("number", analyzeSlashScore(pickupText)),
);
const pickupMeasures = pickupResult.score.parts[0].measures;
check(pickupResult.summary.pickupQuarterNotes === 2, "short opening slash measure should become a two-quarter pickup");
check(pickupMeasures[0]?.pickup && pickupMeasures[0].displayNumber === null, "pickup measure must not receive a formal number");
check(pickupMeasures[0]?.duration.toFloat() === 2, "generated leading/trailing rests were not removed from pickup");
check(sounding(pickupResult.score)[0]?.at === 0, "short opening measure did not start on the pickup timeline");
check(pickupMeasures[1]?.displayNumber === 1 && pickupMeasures[1].position.toFloat() === 2,
  "first full measure should be numbered 1 and follow the pickup without a timeline gap");

const filledPickupText = `键盘谱
4/4拍：
AW/
ASDF/ASDF/ASDF/ASDF/
`;
const filledPickupOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(filledPickupText)),
  symbolDurations: {},
  spaceDivision: null,
  noteDivision: 16,
};
const filledPickupResult = parseSlashScore(filledPickupText, filledPickupOptions);
const filledPickupMeasures = filledPickupResult.score.parts[0].measures;
const filledPickupChords = filledPickupMeasures[0].entries
  .filter((entry): entry is Chord => entry instanceof Chord);
check(filledPickupResult.summary.pickupQuarterNotes === 1 && filledPickupResult.summary.pickupRestCount === 2,
  "AW opening slash should become a one-quarter pickup with two inserted zeros");
check(filledPickupChords.length === 4 && filledPickupChords.map((chord) => chord.rest).join(",") === "true,true,false,false",
  "AW opening slash was not rendered in 00AW order");
check(filledPickupChords.every((chord, index) => chord.position.toFloat() === index * 0.25 && chord.duration?.toFloat() === 0.25),
  "inserted zeros and AW notes did not share the selected sixteenth-note grid");
check(filledPickupMeasures[1]?.displayNumber === 1 && filledPickupMeasures[1].position.toFloat() === 1,
  "full measure after 00AW did not start at measure number 1");
const quarterFilledResult = parseSlashScore(filledPickupText, {
  ...filledPickupOptions,
  symbolDurations: { ".": 8 },
  noteDivision: 4,
});
const quarterFilledChords = quarterFilledResult.score.parts[0].measures[0].entries
  .filter((entry): entry is Chord => entry instanceof Chord);
check(quarterFilledResult.summary.pickupRestCount === 2 &&
  quarterFilledChords.map((chord) => chord.rest).join(",") === "true,true,false,false" &&
  quarterFilledChords.every((chord) => chord.duration?.toFloat() === 1),
"intrinsic quarter-note AW must produce 00AW rather than four finer zeros from an unused symbol mapping");

const leadingEmptyFull = `数字谱
4/4拍：
//3../4../
1../2../3../4../
`;
const leadingEmptyFullResult = parseSlashScore(
  leadingEmptyFull,
  defaultSlashScoreOptions("number", analyzeSlashScore(leadingEmptyFull)),
);
check(leadingEmptyFullResult.summary.pickupQuarterNotes === 0 && sounding(leadingEmptyFullResult.score)[0]?.at === 2,
  "four written slash groups with two leading blanks must remain a full numbered measure");

const writtenRestOpening = `数字谱
4/4拍：
-/-/3../4../
1../2../3../4../
`;
const writtenRestResult = parseSlashScore(
  writtenRestOpening,
  defaultSlashScoreOptions("number", analyzeSlashScore(writtenRestOpening)),
);
check(writtenRestResult.summary.pickupQuarterNotes === 0 && !writtenRestResult.score.parts[0].measures[0]?.pickup,
  "explicit opening rest groups must remain a complete ordinary measure");

const continuous = `数字谱
点=八分音符
1../2../3../4../5../6../7../1../
`;
const continuousAnalysis = analyzeSlashScore(continuous);
check(continuousAnalysis.continuous, "continuous score detection");
const continuousOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("number", continuousAnalysis),
  beats: 4,
  beatType: 4,
};
const continuousResult = parseSlashScore(continuous, continuousOptions);
check(continuousResult.summary.measures === 2, "meter splits continuous groups into measures");
check(continuousResult.summary.warnings.some((item) => item.includes("自动分成 2 小节")), "continuous split summary");

const custom = `数字谱
2/4拍：
符号(=)=8分音符
1==/2==/
`;
const customAnalysis = analyzeSlashScore(custom);
check(customAnalysis.suggestedMappings["="] === 8, "custom equals mapping");
check(parseSlashScore(custom, defaultSlashScoreOptions("number", customAnalysis)).score.parts[0].measures.length === 1, "custom mapping import");
const persistedOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("number", customAnalysis),
  tempoBpm: 144,
  tempoBeatUnit: "dotted-quarter",
  symbolDurations: { "=": 16 },
  spaceDivision: 32,
  noteDivision: 4,
  tempoMarks: [
    { measure: 0, offset: 0, kind: "accel", bpm: null },
    { measure: 0, offset: 1, kind: "tempo", bpm: 144 },
  ],
};
const embedded = embedSlashScoreOptions(custom, persistedOptions);
const persistedAnalysis = analyzeSlashScore(embedded);
check(persistedAnalysis.tempoBpm === 144, "stored tempo setting");
check(persistedAnalysis.tempoBeatUnit === "dotted-quarter",
  "stored tempo beat unit was not restored");
check(persistedAnalysis.suggestedMappings["="] === 16, "stored symbol override");
check(persistedAnalysis.suggestedSpaceDivision === 32, "stored space duration");
check(persistedAnalysis.suggestedNoteDivision === 4, "stored intrinsic note duration");
check(persistedAnalysis.tempoMarks.length === 2 &&
  (() => {
    const restored = parseSlashScore(
      embedded,
      defaultSlashScoreOptions("number", persistedAnalysis),
    ).score;
    return restored.tempoMarks.length === 2
      && restored.tempoBeatUnit === "dotted-quarter"
      && restored.tempoBpm === 144;
  })(),
"stored TXT tempo annotations did not round-trip");

const emptyGroupModes: SlashScoreOptions = {
  ...defaultSlashScoreOptions("number", customAnalysis),
  braceMode: "none",
  bracketMode: "none",
};
const embeddedEmptyGroupModes = embedSlashScoreOptions(custom, emptyGroupModes);
const restoredEmptyGroupModes = analyzeSlashScore(embeddedEmptyGroupModes);
check(restoredEmptyGroupModes.suggestedBraceMode === "none"
  && restoredEmptyGroupModes.suggestedBracketMode === "none",
"blank brace/bracket assignments were not persisted and restored");

const sixFour = `数字谱
点=16分音符
1..../2..../3..../4..../5..../6..../
`;
const sixFourAnalysis = analyzeSlashScore(sixFour);
check(sixFourAnalysis.meter.beats === 6 && sixFourAnalysis.meter.beatType === 4, "six quarter groups infer 6/4");
const sixEight = `数字谱
点=16分音符
1...2.../3...4.../
`;
const sixEightAnalysis = analyzeSlashScore(sixEight);
check(sixEightAnalysis.meter.beats === 6 && sixEightAnalysis.meter.beatType === 8, "two dotted-quarter groups infer 6/8");

const regeneratedNumber = scoreToSlashScore(keyboardResult.score, "number", 8);
const regeneratedKeyboard = scoreToSlashScore(keyboardResult.score, "keyboard", 8);
check(analyzeSlashScore(regeneratedNumber).detectedKind === "number", "number serialization");
check(analyzeSlashScore(regeneratedKeyboard).detectedKind === "keyboard", "keyboard serialization");
check(!parseSlashScore(regeneratedNumber, defaultSlashScoreOptions("number", analyzeSlashScore(regeneratedNumber))).score.piano, "round-trip stays single staff");

for (const tonic of ["A", "B", "bA", "bB"]) {
  const upperTonicJpw = fromJpw(JpwFile.fromString(`.Title
KeyAndMeters = {1=${tonic},4/4}
.Voice
1 2 3 4 |5 6 7 1' |]
`)!);
  check(upperTonicJpw, `${tonic} JPW conversion fixture did not parse`);
  const upperTonicNumber = scoreToSlashScore(upperTonicJpw, "number", 16);
  const upperTonicKeyboard = scoreToSlashScore(upperTonicJpw, "keyboard", 16);
  check(upperTonicNumber.includes("\n1..../2..../3..../4..../")
    && !upperTonicNumber.includes("\n-1..../"),
  `JPW tonic ${tonic} was translated one octave too low in number TXT`);
  check(upperTonicKeyboard.includes("\nA..../S..../D..../F..../"),
    `JPW tonic ${tonic} was translated to the wrong keyboard row`);
}

const overlappingVoicesJpw = fromJpw(JpwFile.fromString(`.Title
Instrument = {钢琴}
KeyAndMeters = {1=C,4/4}
.Voice.RH
1__ 2__ 3__ 4_ 5__ 6__ 7__ 1'__ 2'__ 3'__ 4'__ 5'__ 6'__ 7'__ 1''__ |]
.Voice.LH
1,--- |]
`)!);
check(overlappingVoicesJpw, "overlapping-voice JPW conversion fixture did not parse");
const attackSignature = (score: typeof overlappingVoicesJpw): string[] =>
  score.parts.map((part) => part.measures[0].entries
    .filter((entry): entry is Chord =>
      entry instanceof Chord
      && !entry.rest
      && !entry.transparentContinuation
      && entry.notes.some((note) => !note.rest && !note.tieEnd))
    .map((entry) => `${entry.position.toFloat()}:${
      entry.notes.filter((note) => !note.rest && !note.tieEnd)
        .map((note) => note.pitch).sort((left, right) => left - right).join(",")
    }`)
    .join("|"));
const overlappingNumber = scoreToSlashScore(overlappingVoicesJpw, "number", 16, ".", undefined, 2);
const overlappingOptions = defaultSlashScoreOptions("number", analyzeSlashScore(overlappingNumber));
const overlappingRoundTrip = parseSlashScore(overlappingNumber, overlappingOptions).score;
check(JSON.stringify(attackSignature(overlappingRoundTrip))
  === JSON.stringify(attackSignature(overlappingVoicesJpw)),
"overlapping JPW voices duplicated duration cells and shifted following TXT attacks");

const tiedJpw = fromJpw(JpwFile.fromString(`.Title
KeyAndMeters = {1=C,4/4}
.Voice
(6 6) 0 0 |]
`)!);
check(tiedJpw, "tied JPW conversion fixture did not parse");
const tiedNumber = scoreToSlashScore(tiedJpw, "number", 16);
const tiedRoundTrip = parseSlashScore(
  tiedNumber,
  defaultSlashScoreOptions("number", analyzeSlashScore(tiedNumber)),
).score;
check(attackSignature(tiedRoundTrip)[0] === attackSignature(tiedJpw)[0],
  "JPW tie continuation became a repeated TXT attack");

const v1 = SLASH_VOICE_SEPARATOR;
const v2 = SLASH_VOICE_SEPARATOR.repeat(2);
const multiVoiceText = `键盘谱
4/4拍：
点=八分音符
(${v1}Q${v2}A Z)../${v1}W../${v2}S../X../
`;
const multiVoiceOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(multiVoiceText)),
  voiceCount: 3,
  instrumentName: "钢琴",
};
const multiVoiceScore = parseSlashScore(multiVoiceText, multiVoiceOptions).score;
check(multiVoiceScore.ensemble && multiVoiceScore.parts.length === 3,
  "three marked TXT voices did not become one multi-row instrument");
check(multiVoiceScore.parts.map((part) => part.voiceIndex).join(",") === "1,2,3",
  "multi-voice rows were not ordered V1..VN");
const firstSoundingDuration = multiVoiceScore.parts.map((part) => {
  const chord = part.measures[0].entries.find((entry): entry is Chord =>
    entry instanceof Chord && !entry.rest && !entry.transparentContinuation);
  return chord?.duration?.toFloat() ?? -1;
});
check(JSON.stringify(firstSoundingDuration) === JSON.stringify([1, 2, 3]),
  "each TXT voice did not sustain independently until its own next attack");

const twoVoiceContinuationText = `键盘谱
4/4拍：
点=八分音符
(${v1}Q Z)../../${v1}W../X../
`;
const twoVoiceContinuationOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(twoVoiceContinuationText)),
  voiceCount: 2,
  instrumentName: "钢琴",
};
const twoVoiceContinuationScore = parseSlashScore(
  twoVoiceContinuationText,
  twoVoiceContinuationOptions,
).score;
const explicitContinuations = twoVoiceContinuationScore.parts.map((part) =>
  part.measures.flatMap((measure) => measure.entries)
    .find((entry): entry is Chord =>
      entry instanceof Chord &&
      entry.transparentContinuation &&
      Math.abs(entry.position.toFloat() - 1) < 1e-8));
check(explicitContinuations.length === 2 && explicitContinuations.every((chord) =>
  chord !== undefined &&
  chord.notes.every((note) =>
    note.tieEnd &&
    note.tiePrev !== null &&
    note.tiePrev.tieStart &&
    note.tiePrev.tieNext === note)),
"a common duration-only slash group did not remain a grey tied continuation in every TXT voice");
check(buildTimeline(twoVoiceContinuationScore).notes.every((note) =>
  Math.abs(note.t0 - 1) > 1e-8),
"multi-voice transparent continuations retriggered during playback");

const multiSources = buildSlashSourceNotes(multiVoiceText, multiVoiceOptions, multiVoiceScore);
check(multiSources.map((source) => source.voiceIndex).join(",") === "1,2,3,1,2,3",
  "voice-marked chord pitches were not mapped back to their own rendered rows");
check(inferSlashVoiceCount(multiVoiceText) === 3,
  "maximum consecutive U+2063 markers did not infer three voices");
const nineVoiceText = `键盘谱\n4/4拍：\n${SLASH_VOICE_SEPARATOR.repeat(8)}Q../Z../Z../Z../\n`;
check(inferSlashVoiceCount(nineVoiceText) === 9
  && defaultSlashScoreOptions("keyboard", analyzeSlashScore(nineVoiceText)).voiceCount === 9,
"eight consecutive U+2063 markers did not infer V1..V9 mode");

const persistedThreeVoice = embedSlashScoreOptions(multiVoiceText, multiVoiceOptions);
check(analyzeSlashScore(persistedThreeVoice).voiceCount === 3 && /"v":2/.test(persistedThreeVoice),
  "vc:3/v2 settings were not persisted and restored");
const raisedToFour = migrateSlashVoiceCount(persistedThreeVoice, multiVoiceOptions, 4);
const raisedOptions = { ...multiVoiceOptions, voiceCount: 4 };
const raisedSources = buildSlashSourceNotes(
  raisedToFour.text,
  raisedOptions,
  parseSlashScore(raisedToFour.text, raisedOptions).score,
);
check(raisedSources.filter((source) => source.voiceIndex === 4).length === 2
  && raisedSources.every((source) => source.voiceIndex !== 3),
"increasing vc did not move the old unmarked default material to the new V4");
const reducedToThree = migrateSlashVoiceCount(raisedToFour.text, raisedOptions, 3);
check(!reducedToThree.text.includes(SLASH_VOICE_SEPARATOR.repeat(3))
  && analyzeSlashScore(reducedToThree.text).voiceCount === 3,
"decreasing vc did not merge removed/default rows into the new unmarked V3");
const originalSingleVoiceText = "键盘谱\n4/4拍：\nQ../A../Z../X../\n";
const originalSingleVoiceOptions = defaultSlashScoreOptions(
  "keyboard",
  analyzeSlashScore(originalSingleVoiceText),
);
const raisedSingleToTwo = migrateSlashVoiceCount(
  originalSingleVoiceText,
  originalSingleVoiceOptions,
  2,
);
const raisedSingleToTwoOptions = { ...originalSingleVoiceOptions, voiceCount: 2 };
const raisedSingleSources = buildSlashSourceNotes(
  raisedSingleToTwo.text,
  raisedSingleToTwoOptions,
  parseSlashScore(raisedSingleToTwo.text, raisedSingleToTwoOptions).score,
);
check(!raisedSingleToTwo.text.includes(SLASH_VOICE_SEPARATOR)
  && raisedSingleSources.every((source) => source.voiceIndex === 2),
"increasing a single TXT voice did not move all unmarked notes to default V2");
check(!stripSlashVoiceMarkers(raisedToFour.text, raisedOptions).includes(SLASH_VOICE_SEPARATOR)
  && analyzeSlashScore(stripSlashVoiceMarkers(raisedToFour.text, raisedOptions)).voiceCount === 1,
"single-voice TXT export retained U+2063 or vc:N");
const utf8VoiceRoundTrip = new TextDecoder().decode(
  new TextEncoder().encode(raisedToFour.text),
);
check(utf8VoiceRoundTrip === raisedToFour.text,
  "UTF-8 save/reopen changed invisible voice markers");
const markedRoundTrip = scoreToSlashScore(multiVoiceScore, "keyboard", 8, ".", undefined, 3);
check(markedRoundTrip.includes(SLASH_VOICE_SEPARATOR)
  && parseSlashScore(
    embedSlashScoreOptions(markedRoundTrip, multiVoiceOptions),
    multiVoiceOptions,
  ).score.parts.length === 3,
"multi-voice score serialization did not preserve voice markers");
const emptyUpperVoicesOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("number", analyzeSlashScore("数字谱\n4/4拍：\n1../2../3../4../\n")),
  voiceCount: 3,
};
const emptyUpperVoices = parseSlashScore(
  "数字谱\n4/4拍：\n1../2../3../4../\n",
  emptyUpperVoicesOptions,
).score;
check(emptyUpperVoices.parts.length === 3
  && emptyUpperVoices.parts[0].measures.every((measure) =>
    measure.entries.every((entry) => !(entry instanceof Chord) || entry.rest))
  && emptyUpperVoices.parts[1].measures.every((measure) =>
    measure.entries.every((entry) => !(entry instanceof Chord) || entry.rest)),
"enabled voices with no attacks did not remain visible as rests");
const twoVoiceOptions = { ...multiVoiceOptions, voiceCount: 2 };
const twoVoiceText = `键盘谱\n4/4拍：\n点=八分音符\n(${v1}Q Z)../${v1}W../X../Z../\n`;
const twoVoiceScore = parseSlashScore(twoVoiceText, twoVoiceOptions).score;
check(twoVoiceScore.piano && !twoVoiceScore.ensemble && twoVoiceScore.parts.length === 2,
  "two TXT voices did not reuse the paired piano layout");

const fullKeyboard = readFileSync("examples/所念皆星河 - 键盘谱.txt", "utf8");
const fullNumber = readFileSync("examples/所念皆星河 - 数字谱.txt", "utf8");
const fullKeyboardResult = parseSlashScore(fullKeyboard, defaultSlashScoreOptions("keyboard", analyzeSlashScore(fullKeyboard)));
const fullNumberResult = parseSlashScore(fullNumber, defaultSlashScoreOptions("number", analyzeSlashScore(fullNumber)));
check(fullKeyboardResult.summary.measures === 48, "generated keyboard example has 48 measures");
check(fullNumberResult.summary.measures === 48, "generated number example has 48 measures");
check(!fullKeyboardResult.score.piano && !fullNumberResult.score.piano, "generated MIDI examples stay single-staff");
check(fullKeyboardResult.summary.clippedGroups === 0 && fullNumberResult.summary.clippedGroups === 0, "generated examples fit every slash group");
check(fullKeyboardResult.summary.ignoredCharacters === 0 && fullNumberResult.summary.ignoredCharacters === 0, "generated examples contain no unknown score symbols");

console.log(JSON.stringify({
  keyboardMeasures: keyboardResult.summary.measures,
  numberMeasures: numberResult.summary.measures,
  chords: sounding(keyboardResult.score).length,
  emptyBeatVariants: 2,
  pickupQuarterNotes: pickupResult.summary.pickupQuarterNotes,
  pickupInsertedZeros: filledPickupResult.summary.pickupRestCount,
  intrinsicMeasures: intrinsicResult.summary.measures,
  eighthSpaceStart: eighthSpaceNotes[0]?.at,
  continuousMeasures: continuousResult.summary.measures,
  inferredMeters: [`${sixFourAnalysis.meter.beats}/${sixFourAnalysis.meter.beatType}`, `${sixEightAnalysis.meter.beats}/${sixEightAnalysis.meter.beatType}`],
  commentLines: keyboardResult.summary.comments,
  tagsIgnored: keyboardResult.summary.ignoredTags,
  generatedExampleMeasures: fullKeyboardResult.summary.measures,
}, null, 2));
