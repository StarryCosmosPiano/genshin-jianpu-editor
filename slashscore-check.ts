import { Chord, CrossPartArpeggio, KeyMark, TempoMark, Tuplet } from "./src/score/score";
import { buildTimeline } from "./src/score/timeline";
import { fromJpw } from "./src/score/jpwimport";
import { JpwFile } from "./src/jpword/jpwfile";
import { parseEditableDocument } from "./src/editor/document-parser";
import { buildSlashSourceNotes, editSlashPitch } from "./src/editor/note-selection";
import {
  mergeDuplicateChordPitches,
  moveScoreNotesOnTimeline,
  resizeScoreNoteSegmentsWithRests,
} from "./src/score/note-timing";
import { Fraction } from "./src/common/fraction";
import { scoreToJpwabc } from "./src/score/jpscore";
import {
  completeInputMeasure,
  createInputTriplet,
  inputNoteAtCursor,
  moveInputTieChainByNotationDomain,
  resizeInputTupletMember,
} from "./src/score/input-edit";
import {
  analyzeSlashScore,
  defaultSlashScoreOptions,
  embedSlashScoreOptions,
  inferSlashVoiceCount,
  migrateSlashVoiceCount,
  migrateSlashDelimiters,
  parseSlashScore,
  parseSlashReadableDirectives,
  replaceSlashScoreLines,
  scoreToSlashScore,
  slashScoreTemplate,
  serializeSlashReadableDirectives,
  serializeSlashHumanDirectives,
  notationAnnotationsFromScore,
  embedSlashScoreOptionsFromScore,
  slashPitchSources,
  SLASH_VOICE_SEPARATOR,
  slashVoiceMarker,
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

const keyboardLabelText = `键盘谱
4/4拍：
Q../'Q../A../,V../
`;
const keyboardLabelOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(keyboardLabelText)),
  keyboardKeyLabels: true,
};
const keyboardLabelScore = parseSlashScore(keyboardLabelText, keyboardLabelOptions).score;
const keyboardLabelNotes = keyboardLabelScore.parts[0].measures[0].entries
  .filter((entry): entry is Chord => entry instanceof Chord && !entry.rest)
  .map((entry) => entry.notes.find((note) => !note.rest)!);
check(keyboardLabelNotes.map((note) => note.displayText).join("") === "QQAV",
  "keyboard-key staff labels did not preserve the three physical key rows");
check(keyboardLabelNotes.map((note) => note.displayOctave).join(",") === "0,1,0,-1",
  "keyboard-key labels did not convert only out-of-range octaves into dots");
check(keyboardLabelNotes.every((note) => /^[1-7]$/.test(note.number)),
  "keyboard-key display overwrote the underlying numbered pitch model");
const keyboardLabelStored = embedSlashScoreOptions(keyboardLabelText, keyboardLabelOptions);
check(analyzeSlashScore(keyboardLabelStored).keyboardKeyLabels,
  "keyboard-key display option did not survive @jpeditor metadata round-trip");
const keyboardTieDisplayStored = analyzeSlashScore(embedSlashScoreOptions(
  keyboardLabelText,
  {
    ...keyboardLabelOptions,
    keyboardTieAsZero: true,
    keyboardHideTieLabels: true,
  },
));
check(keyboardTieDisplayStored.keyboardTieAsZero
  && keyboardTieDisplayStored.keyboardHideTieLabels,
"keyboard continuation-display options did not survive @jpeditor metadata round-trip");

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
const bracketTripletScore = parseSlashScore(bracketTripletText, bracketTripletOptions).score;
const bracketTripletNotes = bracketTripletScore.parts[0].measures[0].entries
  .filter((entry): entry is Chord => entry instanceof Chord && !entry.rest)
  .flatMap((entry) => entry.notes.filter((note) => !note.rest));
check(bracketTripletNotes[0]?.tupletBegin && bracketTripletNotes[2]?.tupletEnd,
  "three nominal sixteenth values were timed as a triplet but the visible tuplet markers were not retained");
const tripletTextRoundTrip = scoreToSlashScore(
  bracketTripletScore,
  "number",
  16,
  ".",
  { bracketMode: "triplet", braceMode: "grace" },
  1,
);
check(/\[1\.2\.3\.+/.test(tripletTextRoundTrip),
  "explicit score tuplets were flattened instead of retaining a fixed 3:2 TXT group");
const tripletRoundTripScore = parseSlashScore(
  tripletTextRoundTrip,
  defaultSlashScoreOptions("number", analyzeSlashScore(tripletTextRoundTrip)),
).score;
const roundTripTimeline = buildTimeline(tripletRoundTripScore);
check(roundTripTimeline.notes.slice(0, 3).every((note, index) =>
  Math.abs(note.t0 - index / 6) < 1e-8),
  "fixed TXT triplet serialization changed the three member onset positions");
const braceTripletText = scoreToSlashScore(
  bracketTripletScore,
  "number",
  16,
  ".",
  { bracketMode: "none", braceMode: "triplet" },
  1,
);
check(/\{1\.2\.3\.+/.test(braceTripletText),
  "triplet serialization did not honor a curly-brace triplet assignment");

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
const zeroContinuationScore = parseSlashScore(prefixedArpeggioTieText, {
  ...prefixedArpeggioTieOptions,
  keyboardKeyLabels: true,
  keyboardTieAsZero: true,
}).score;
const zeroContinuation = zeroContinuationScore.parts[0].measures[0].entries
  .find((entry): entry is Chord =>
    entry instanceof Chord && entry.transparentContinuation);
check(zeroContinuation?.notes.every((note) =>
  note.displayText === "0"
  && note.displayOctave === 0
  && note.displayAlter === " "),
"keyboard-key tied continuations were not replaced by visual 0s");
const hiddenContinuationScore = parseSlashScore(prefixedArpeggioTieText, {
  ...prefixedArpeggioTieOptions,
  keyboardKeyLabels: true,
  keyboardTieAsZero: true,
  keyboardHideTieLabels: true,
}).score;
const hiddenContinuation = hiddenContinuationScore.parts[0].measures[0].entries
  .find((entry): entry is Chord =>
    entry instanceof Chord && entry.transparentContinuation);
const visibleContinuationScore = parseSlashScore(prefixedArpeggioTieText, {
  ...prefixedArpeggioTieOptions,
  keyboardKeyLabels: true,
}).score;
const visibleContinuation = visibleContinuationScore.parts[0].measures[0].entries
  .find((entry): entry is Chord =>
    entry instanceof Chord && entry.transparentContinuation);
check(hiddenContinuation?.notes.every((note, index) =>
  note.displayHidden
  && note.displayText === visibleContinuation?.notes[index]?.displayText
  && note.displayOctave === visibleContinuation?.notes[index]?.displayOctave
  && note.displayAlter === visibleContinuation?.notes[index]?.displayAlter),
"hidden keyboard-key tied labels did not preserve their visible layout values");
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
const storedIntrinsicText = embedSlashScoreOptions(intrinsicText, intrinsicOptions);
const storedIntrinsicAnalysis = analyzeSlashScore(storedIntrinsicText);
const storedIntrinsicOptions = defaultSlashScoreOptions("keyboard", storedIntrinsicAnalysis);
check(storedIntrinsicAnalysis.wholeMeasureGroups
  && storedIntrinsicOptions.wholeMeasureGroups,
"slash-delimited whole-measure mode was not retained in editable TXT settings");
const intrinsicRoundTripText = scoreToSlashScore(
  intrinsicResult.score,
  "keyboard",
  16,
  ".",
  { durationNotation: storedIntrinsicOptions },
  1,
);
const intrinsicRoundTripRows = intrinsicRoundTripText.split(/\r?\n/)
  .filter((line) => !line.trim().startsWith("//") && line.endsWith("/"));
check(intrinsicRoundTripRows.length === 4
  && intrinsicRoundTripRows.every((line) => line.split("/").length - 1 === 1)
  && parseSlashScore(intrinsicRoundTripText, storedIntrinsicOptions).summary.measures === 4,
"whole-measure slash TXT expanded every measure into four unrelated slash segments");

// Compact marker-only sustain at the end of a score normalizes to one whole
// note per voice, never a quarter plus tied dotted-quarter and bar sustain.
const fullTailVoice = SLASH_VOICE_SEPARATOR;
const fullTailText = `键盘谱\n4/4拍：\n点=16分音符\n(${fullTailVoice}AB)..${fullTailVoice}../..../..../..${fullTailVoice}../\n`;
const fullTailOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(fullTailText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 as const },
  noteDivision: 16 as const,
};
const fullTailScore = parseSlashScore(fullTailText, fullTailOptions).score;
check(fullTailScore.parts.every((part) => {
  const chords = part.measures[0].entries.filter(
    (entry): entry is Chord => entry instanceof Chord && !entry.rest,
  );
  return chords.length === 1
    && chords[0].duration?.equals(4)
    && chords[0].beats === 4
    && chords[0].dot === 0
    && chords[0].notes.every((note) => !note.tieStart && !note.tieEnd
      && note.tiePrev === null && note.tieNext === null);
}), "a compact final sustain did not normalize to one untied whole note per voice");

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
const restSpellingOptions = {
  braceMode: "none" as const,
  bracketMode: "triplet" as const,
  durationNotation: {
    symbolDurations: { ".": 16 as const },
    multiDurationSymbols: false,
    spaceDivision: null,
    noteDivision: null,
    emptyGroupsAsRests: false,
  },
};
const durationRestLine = scoreToSlashScore(
  restVariantResult.score,
  "number",
  16,
  ".",
  restSpellingOptions,
).trim().split("\n").at(-1) ?? "";
check(durationRestLine.startsWith("..../..../"),
  `emptyGroupsAsRests=false still serialized empty beats incorrectly: ${durationRestLine}`);
const minusRestLine = scoreToSlashScore(
  restVariantResult.score,
  "number",
  16,
  ".",
  {
    ...restSpellingOptions,
    durationNotation: {
      ...restSpellingOptions.durationNotation,
      emptyGroupsAsRests: true,
    },
  },
).trim().split("\n").at(-1) ?? "";
check(minusRestLine.startsWith(" - / - /"),
  "emptyGroupsAsRests=true did not serialize empty beats as / - /");

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
check(filledPickupChords.length === 3
  && filledPickupChords.map((chord) => chord.rest).join(",") === "true,false,false",
  "AW opening slash did not fuse its two leading sixteenth rests");
check(filledPickupChords[0].position.equals(0)
  && filledPickupChords[0].duration?.equals(new Fraction(1, 2))
  && filledPickupChords[1].position.equals(new Fraction(1, 2))
  && filledPickupChords[1].duration?.equals(new Fraction(1, 4))
  && filledPickupChords[2].position.equals(new Fraction(3, 4))
  && filledPickupChords[2].duration?.equals(new Fraction(1, 4)),
  "inserted pickup rests and AW notes did not keep their selected grid");
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

// The standalone Score→TXT API may omit voiceCount. A multi-Part score must
// still remain a multi-voice text score; otherwise the two independent lines
// are flattened into same-time chords and cannot be edited as separate rows.
const inferredVoiceText = scoreToSlashScore(overlappingVoicesJpw, "number", 16);
check(inferredVoiceText.includes(SLASH_VOICE_SEPARATOR)
  && analyzeSlashScore(inferredVoiceText).voiceCount === 2,
"Score→TXT did not infer the existing multi-Part voice count");
const inferredVoiceRoundTrip = parseSlashScore(
  inferredVoiceText,
  defaultSlashScoreOptions("number", analyzeSlashScore(inferredVoiceText)),
).score;
check(JSON.stringify(attackSignature(inferredVoiceRoundTrip))
  === JSON.stringify(attackSignature(overlappingVoicesJpw)),
"Score→TXT without an explicit voice count flattened independent Parts");

const voicedRestJpw = fromJpw(JpwFile.fromString(`.Title
Instrument = {钢琴}
KeyAndMeters = {1=C,4/4}
.Voice.RH
1 2 3 0 |]
.Voice.LH
6,--- |]
`)!);
check(voicedRestJpw, "voice-specific rest JPW fixture did not parse");
const voicedRestText = scoreToSlashScore(voicedRestJpw, "keyboard", 16, ".", undefined, 2);
check(voicedRestText.includes(`${SLASH_VOICE_SEPARATOR}0`),
  "a right-hand JPW rest was exported as an unmarked default-voice 0");
const voicedRestOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(voicedRestText)),
  voiceCount: 2,
  instrumentName: "钢琴",
  symbolDurations: { ".": 16 },
};
const voicedRestRoundTrip = parseSlashScore(voicedRestText, voicedRestOptions).score;
const rightRest = voicedRestRoundTrip.parts[0].measures[0].entries.find(
  (entry): entry is Chord => entry instanceof Chord
    && entry.rest
    && entry.position.equals(new Fraction(3)),
);
const leftSounding = voicedRestRoundTrip.parts[1].measures[0].entries.filter(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest,
);
check(rightRest
  && leftSounding.length >= 1
  && leftSounding[0].position.equals(0)
  && leftSounding.reduce((sum, chord) => sum + (chord.duration?.toFloat() ?? 0), 0) === 4,
"a voice-marked TXT 0 did not return to the right hand while the left hand sustained");
check(inferSlashVoiceCount(`键盘谱\n4/4拍：\n${SLASH_VOICE_SEPARATOR}0..../Z..../Z..../Z..../\n`) === 2,
  "a voice marker attached to 0 did not infer the upper rest voice");

const simultaneousRestJpw = fromJpw(JpwFile.fromString(`.Title
Instrument = {钢琴}
KeyAndMeters = {1=C,4/4}
.Voice.RH
1 0 3 4 |]
.Voice.LH
5, 6, 7, 1 |]
`)!);
check(simultaneousRestJpw, "simultaneous rest/attack JPW fixture did not parse");
const simultaneousRestText = scoreToSlashScore(
  simultaneousRestJpw,
  "keyboard",
  16,
  ".",
  undefined,
  2,
);
const simultaneousRestRoundTrip = parseSlashScore(
  simultaneousRestText,
  {
    ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(simultaneousRestText)),
    voiceCount: 2,
    instrumentName: "钢琴",
    symbolDurations: { ".": 16 },
  },
).score;
check(simultaneousRestText.includes(`(${SLASH_VOICE_SEPARATOR}0`)
  && simultaneousRestRoundTrip.parts[0].measures[0].entries.some((entry) =>
    entry instanceof Chord && entry.rest && entry.position.equals(1))
  && simultaneousRestRoundTrip.parts[1].measures[0].entries.some((entry) =>
    entry instanceof Chord && !entry.rest && entry.position.equals(1)),
"a rest and another voice's simultaneous attack did not round-trip independently");

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
const reportedVoiceText = `4/4拍：\n(V${v1}G).${v1}W.N.(G${v1}W)./.(A${v1}W).N.${v1}W./(BG).${v1}Q.N.(G${v1}J)./.(A${v1}Q).N.${v1}J./`;
const reportedVoiceOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(reportedVoiceText)),
  voiceCount: 2,
  instrumentName: "钢琴",
  symbolDurations: { ".": 16 },
  noteDivision: null,
  beats: 4,
  beatType: 4,
};
const reportedVoiceScore = parseSlashScore(reportedVoiceText, reportedVoiceOptions).score;
const reportedExpectedJpw = fromJpw(JpwFile.fromString(`.Title
KeyAndMeters = {1=C,4/4}
.Voice.RH
5__ 2'_ (2'__ 2'__) 2'_ (2'__ 2'__) 1'_ (7__ 7__) 1'_ 7__ |]
.Voice.LH
4,_ 6,__ (5__ 5__) 1__ 6,_ [5,5]_ 6,__ (5__ 5__) 1__ 6,_ |]
`)!);
check(reportedExpectedJpw, "reported JPW/TXT fixture did not parse");
const reportedConvertedText = scoreToSlashScore(
  reportedExpectedJpw,
  "keyboard",
  16,
  ".",
  undefined,
  2,
);
const notatedVoiceSignature = (score: typeof reportedExpectedJpw): string[][] =>
  score.parts.map((part) => part.measures.flatMap((measure) => measure.entries
    .filter((entry): entry is Chord => entry instanceof Chord && !entry.rest)
    .map((entry) => `${measure.index}:${entry.position.toString()}:${entry.duration?.toString()}:` +
      `${entry.notes.filter((note) => !note.rest).map((note) => note.pitch).sort((a, b) => a - b)}:` +
      `${entry.notes.some((note) => note.tieStart)}:${entry.notes.some((note) => note.tieEnd)}`)));
check(reportedConvertedText.includes(
  `(V${v1}G).${v1}W.N.(G${v1}W)./.(A${v1}W).N.${v1}W./` +
  `(BG).${v1}Q.N.(G${v1}J)./.(A${v1}Q).N.${v1}J./`,
), "JPW did not produce the reported compact two-voice keyboard TXT");
check(JSON.stringify(notatedVoiceSignature(reportedVoiceScore))
  === JSON.stringify(notatedVoiceSignature(reportedExpectedJpw)),
"an explicitly repeated TXT pitch was swallowed as a gray continuation instead of a new attack");
const reportedMaterializedJpw = scoreToJpwabc(reportedVoiceScore);
check(reportedMaterializedJpw.includes(
  "5__ 2'_ (2'__ 2'__) 2'_ (2'__ 2'__) 1'_ (7__ 7__) 1'_ 7__",
) && reportedMaterializedJpw.includes(
  "4,_ 6,__ (5__ 5__) 1__ 6,_ [5,5]_ 6,__ (5__ 5__) 1__ 6,_",
), "TXT-generated cross-beat continuations were lost when materialized back to JPW");
const continuationSpellingFixtures = [
  {
    kind: "keyboard" as const,
    longTail: `Z${v1}Q.../A.../S.../D.../${v1}W.../`,
    beatTail: `${v1}Q.../A.B..${v1}W/S.../D.../`,
    halfTail: `A..${v1}Q/B.../C.../${v1}W.../`,
    dottedAttack: `${v1}Q.../A..${v1}W./S.../D.../`,
  },
  {
    kind: "number" as const,
    longTail: `2.${v1}1../3.../4.../5.../${v1}2.../`,
    beatTail: `${v1}1.../3.4.. ${v1}2/5.../6.../`,
    halfTail: `3..${v1}1/4.../5.../${v1}2.../`,
    dottedAttack: `${v1}1.../3..${v1}2./4.../5.../`,
  },
];
const continuationChords = (
  kind: "keyboard" | "number",
  body: string,
): Chord[] => {
  const options: SlashScoreOptions = {
    ...defaultSlashScoreOptions(kind, analyzeSlashScore(`4/4拍：\n${body}`)),
    voiceCount: 2,
    instrumentName: "钢琴",
    symbolDurations: { ".": 16 },
    noteDivision: null,
    beats: 4,
    beatType: 4,
  };
  return parseSlashScore(`4/4拍：\n${body}`, options).score.parts[0].measures
    .flatMap((measure) => measure.entries)
    .filter((entry): entry is Chord => entry instanceof Chord && !entry.rest)
    .slice(0, 2);
};
for (const fixture of continuationSpellingFixtures) {
  const longTail = continuationChords(fixture.kind, fixture.longTail);
  check(longTail.length === 2
    && longTail[0].duration?.equals(new Fraction(3, 4))
    && longTail[0].dot === 1
    && longTail[1].duration?.equals(3)
    && longTail[1].beats === 2
    && longTail[1].dot === 1
    && longTail[1].transparentContinuation
    && longTail[1].notes.every((note) => note.tieEnd),
  `${fixture.kind} TXT did not combine dotted-eighth + quarter + half into dotted-eighth + dotted-half`);

  const beatTail = continuationChords(fixture.kind, fixture.beatTail);
  check(beatTail.length === 2
    && beatTail[0].duration?.equals(1)
    && beatTail[0].dot === 0
    && beatTail[1].duration?.equals(new Fraction(3, 4))
    && beatTail[1].beams === 1
    && beatTail[1].dot === 1
    && beatTail[1].transparentContinuation
    && beatTail[1].notes.every((note) => note.tieEnd),
  `${fixture.kind} TXT did not preserve the quarter attack and combine its same-beat tail into a dotted eighth`);

  const halfTail = continuationChords(fixture.kind, fixture.halfTail);
  check(halfTail.length === 2
    && halfTail[0].duration?.equals(new Fraction(1, 2))
    && halfTail[0].beams === 1
    && halfTail[0].dot === 0
    && halfTail[1].duration?.equals(2)
    && halfTail[1].beats === 2
    && halfTail[1].dot === 0
    && halfTail[1].transparentContinuation
    && halfTail[1].notes.every((note) => note.tieEnd),
  `${fixture.kind} TXT did not combine two beat-aligned quarter continuations into one half-note continuation`);

  const dottedAttack = continuationChords(fixture.kind, fixture.dottedAttack);
  check(dottedAttack.length === 2
    && dottedAttack[0].duration?.equals(new Fraction(3, 2))
    && dottedAttack[0].beats === 1
    && dottedAttack[0].dot === 1
    && dottedAttack[0].notes.every((note) => !note.tieStart && !note.tieEnd),
  `${fixture.kind} TXT did not collapse a beat-aligned quarter plus tied eighth into one dotted quarter`);
}
const alignedSustainOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore("4/4拍：\n(Q Z).../Z.../(W Z).../Z.../")),
  voiceCount: 2,
  instrumentName: "钢琴",
  symbolDurations: { ".": 16 },
  noteDivision: null,
  beats: 4,
  beatType: 4,
};
const alignedHalfScore = parseSlashScore(
  `4/4拍：
(${v1}Q Z).../Z.../(${v1}W Z).../Z.../
`,
  alignedSustainOptions,
).score;
const alignedHalfChords = alignedHalfScore.parts[0].measures
  .flatMap((measure) => measure.entries)
  .filter((entry): entry is Chord => entry instanceof Chord && !entry.rest);
check(alignedHalfChords.length === 2
  && alignedHalfChords.every((chord) =>
    chord.duration?.equals(2)
    && chord.beats === 2
    && chord.dot === 0
    && chord.notes.every((note) => !note.tieStart && !note.tieEnd)),
"beat-aligned quarter + quarter sustains did not collapse into untied half notes");

const alignedWholeScore = parseSlashScore(
  `4/4拍：
(${v1}E Z).../Z.../Z.../Z.../
`,
  alignedSustainOptions,
).score;
const alignedWholeChord = alignedWholeScore.parts[0].measures[0].entries.find(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest,
);
check(alignedWholeChord?.duration?.equals(4)
  && alignedWholeChord.beats === 4
  && alignedWholeChord.dot === 0
  && alignedWholeChord.notes.every((note) => !note.tieStart && !note.tieEnd),
"beat-aligned quarter + dotted-half sustain did not collapse into one untied whole note");

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
const multiVoiceTimeline = buildTimeline(multiVoiceScore);
const firstSoundingDuration = multiVoiceScore.parts.map((_part, partIndex) => {
  const note = multiVoiceTimeline.notes.find((item) =>
    item.part === partIndex && Math.abs(item.t0) < 1e-8);
  return note ? note.t1 - note.t0 : -1;
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
const twoVoiceContinuationTimeline = buildTimeline(twoVoiceContinuationScore);
const twoVoiceSustainLengths = twoVoiceContinuationScore.parts.map((_part, partIndex) => {
  const note = twoVoiceContinuationTimeline.notes.find((item) =>
    item.part === partIndex && Math.abs(item.t0) < 1e-8);
  return note ? note.t1 - note.t0 : -1;
});
check(JSON.stringify(twoVoiceSustainLengths) === JSON.stringify([2, 3]),
  "duration-only TXT groups did not preserve each voice's sustained length");
check(twoVoiceContinuationTimeline.notes.every((note) =>
  Math.abs(note.t0 - 1) > 1e-8),
"multi-voice transparent continuations retriggered during playback");

const detachedChordToneText = `.Title
KeyAndMeters = {1=C,4/4}
.Voice
1__ 2__ 3_ 4-- |]
`;
const detachedChordTone = fromJpw(JpwFile.fromString(detachedChordToneText)!);
check(detachedChordTone, "JPW detached chord-tone fixture did not parse");
const detachedPart = detachedChordTone.parts[0];
const movingTwo = detachedPart.measures[0].entries
  .filter((entry): entry is Chord => entry instanceof Chord)
  .flatMap((chord) => chord.notes)
  .find((note) => note.number === "2");
check(movingTwo, "JPW detached chord-tone fixture did not contain note 2");
check(moveScoreNotesOnTimeline(
  detachedChordTone,
  [{ partIndex: 0, note: movingTwo }],
  new Fraction(1, 4),
  { preserveRests: true },
).changed === 1
  && movingTwo.chord.duration?.equals(new Fraction(1, 2))
  && movingTwo.chord.notes.some((note) => note.number === "3"),
"moving a sixteenth right did not merge it into the following eighth-note chord");
check(moveScoreNotesOnTimeline(
  detachedChordTone,
  [{ partIndex: 0, note: movingTwo }],
  new Fraction(-1, 4),
  { preserveRests: true },
).changed === 1,
"a tone merged into an eighth-note chord could not move left at the selected sixteenth grid");
const retainedThree = detachedPart.measures[0].entries
  .filter((entry): entry is Chord => entry instanceof Chord)
  .find((chord) => chord.notes.some((note) => note.number === "3"));
check(movingTwo.absoluteTick.equals(new Fraction(1, 4))
  && movingTwo.chord.duration?.equals(new Fraction(1, 4))
  && retainedThree?.position.equals(new Fraction(1, 2))
  && retainedThree.duration?.equals(new Fraction(1, 2))
  && detachedPart.measures[0].duration.equals(4),
"moving one tone left did not use the selected grid value or changed the retained chord duration");
check(fromJpw(JpwFile.fromString(scoreToJpwabc(detachedChordTone))!),
  "the detached JPW chord tone did not survive serialization");

const duplicateMoveText = `.Title
KeyAndMeters = {1=C,4/4}
.Voice
3__ [35]_ 6- 7- |]
`;
const duplicateMove = fromJpw(JpwFile.fromString(duplicateMoveText)!);
check(duplicateMove, "JPW duplicate-move fixture did not parse");
const duplicateMovingThree = duplicateMove.parts[0].measures[0].entries
  .filter((entry): entry is Chord => entry instanceof Chord)
  .flatMap((chord) => chord.notes)
  .find((note) => note.number === "3" && note.absoluteTick.equals(0));
check(duplicateMovingThree, "JPW duplicate-move fixture did not contain its moving 3");
check(moveScoreNotesOnTimeline(
  duplicateMove,
  [{ partIndex: 0, note: duplicateMovingThree }],
  new Fraction(1, 4),
  { preserveRests: true },
).changed === 1,
"moving 3 onto [35] was rejected");
const transientDuplicate = duplicateMove.parts[0].measures[0].entries.find(
  (entry): entry is Chord => entry instanceof Chord
    && entry.notes.filter((note) => note.pitch === duplicateMovingThree.pitch).length === 2,
);
check(transientDuplicate
  && transientDuplicate.notes.map((note) => note.number).sort().join("") === "335",
"the selected same-pitch move was collapsed before deselection");
const serializedDuplicate = scoreToJpwabc(duplicateMove);
check(serializedDuplicate.includes("[335]")
  && fromJpw(JpwFile.fromString(serializedDuplicate)!),
"the transient [335] selected state did not survive JPW serialization");
check(mergeDuplicateChordPitches(duplicateMove) === 1
  && transientDuplicate.notes.map((note) => note.number).sort().join("") === "35",
"deselect normalization did not collapse transient [335] to [35]");

const targetDurationText = `.Title
KeyAndMeters = {1=C,4/4}
.Voice
1__ [35]__ 4_ 6--- |]
`;
const targetDurationMove = fromJpw(JpwFile.fromString(targetDurationText)!);
check(targetDurationMove, "JPW target-duration fixture did not parse");
const movingFour = targetDurationMove.parts[0].measures[0].entries
  .filter((entry): entry is Chord => entry instanceof Chord)
  .flatMap((chord) => chord.notes)
  .find((note) => note.number === "4");
check(movingFour, "JPW target-duration fixture did not contain note 4");
check(moveScoreNotesOnTimeline(
  targetDurationMove,
  [{ partIndex: 0, note: movingFour }],
  new Fraction(-1, 4),
  { preserveRests: true },
).changed === 1
  && movingFour.absoluteTick.equals(new Fraction(1, 4))
  && movingFour.chord.duration?.equals(new Fraction(1, 4))
  && movingFour.chord.notes.map((note) => note.number).sort().join("") === "345",
"a left-moved tone did not adopt the occupied target column's duration");

const duplicateSlashText = `数字谱
4/4拍：
点=16分音符
(335)..../1..../2..../3..../
`;
const duplicateSlashOptions = defaultSlashScoreOptions(
  "number",
  analyzeSlashScore(duplicateSlashText),
);
const duplicateSlash = parseSlashScore(duplicateSlashText, duplicateSlashOptions).score;
const duplicateSlashChord = duplicateSlash.parts[0].measures[0].entries.find(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest,
);
check(duplicateSlashChord
  && duplicateSlashChord.notes.map((note) => note.number).sort().join("") === "335",
"TXT parsing collapsed a same-pitch chord while it was still selected");
const duplicateSlashRoundTrip = scoreToSlashScore(
  duplicateSlash,
  "number",
  16,
  ".",
  { durationNotation: duplicateSlashOptions },
);
check(duplicateSlashRoundTrip.includes("(335)"),
  "TXT serialization collapsed a same-pitch chord while it was still selected");
check(mergeDuplicateChordPitches(duplicateSlash) === 1
  && scoreToSlashScore(
    duplicateSlash,
    "number",
    16,
    ".",
    { durationNotation: duplicateSlashOptions },
  ).includes("(35)"),
"TXT deselection did not normalize the transient same-pitch chord");

const dottedSpellingText = `.Title
KeyAndMeters = {1=C,4/4}
.Voice
0 (1- 1) |0__ (3_ 3__) 4-- |0 (5 5_) 6-- |0_ (7_ 7 7_) 0 |]
`;
const dottedSpelling = fromJpw(JpwFile.fromString(dottedSpellingText)!);
check(dottedSpelling, "JPW dotted-value fixture did not parse");
const dottedHalf = dottedSpelling.parts[0].measures[0].entries.find(
  (entry): entry is Chord =>
    entry instanceof Chord
    && !entry.rest
    && entry.notes.some((note) => note.number === "1"),
);
const dottedEighth = dottedSpelling.parts[0].measures[1].entries.find(
  (entry): entry is Chord =>
    entry instanceof Chord
    && !entry.rest
    && entry.notes.some((note) => note.number === "3"),
);
const dottedQuarter = dottedSpelling.parts[0].measures[2].entries.find(
  (entry): entry is Chord =>
    entry instanceof Chord
    && !entry.rest
    && entry.notes.some((note) => note.number === "5"),
);
const dottedContinuation = dottedSpelling.parts[0].measures[3].entries
  .filter((entry): entry is Chord =>
    entry instanceof Chord
    && !entry.rest
    && entry.notes.some((note) => note.number === "7"));
check(dottedHalf?.duration?.equals(3)
  && dottedHalf.position.equals(1)
  && dottedHalf.beats === 2
  && dottedHalf.dot === 1
  && dottedHalf.notes.every((note) => !note.tieStart && !note.tieEnd),
"an aligned half plus quarter continuation did not combine into one dotted half note");
check(dottedEighth?.duration?.equals(new Fraction(3, 4))
  && dottedEighth.beams === 1
  && dottedEighth.dot === 1
  && dottedEighth.notes.every((note) => !note.tieStart && !note.tieEnd),
"an eighth plus sixteenth inside one beat did not combine into one dotted eighth note");
check(dottedQuarter?.duration?.equals(new Fraction(3, 2))
  && dottedQuarter.position.equals(1)
  && dottedQuarter.beats === 1
  && dottedQuarter.dot === 1
  && dottedQuarter.notes.every((note) => !note.tieStart && !note.tieEnd),
"a beat-aligned quarter plus eighth continuation did not combine into one dotted quarter note");
check(dottedContinuation.length === 2
  && dottedContinuation[0].duration?.equals(new Fraction(1, 2))
  && dottedContinuation[1].position.equals(1)
  && dottedContinuation[1].duration?.equals(new Fraction(3, 2))
  && dottedContinuation[1].beats === 1
  && dottedContinuation[1].dot === 1
  && dottedContinuation[1].transparentContinuation
  && dottedContinuation[1].notes.every((note) => note.tieEnd),
"a beat-aligned tied quarter plus tied eighth did not combine into one dotted-quarter continuation");
const dottedSpellingOutput = scoreToJpwabc(dottedSpelling);
check(dottedSpellingOutput.includes("0 1.-")
  && dottedSpellingOutput.includes("0__ 3._"),
`dotted values were not written back with an augmentation dot:
${dottedSpellingOutput}`);

const jpwRestFusionText = `.Title
KeyAndMeters = {1=C,4/4}
.Voice
0__ 0__ 0__ 0__ 1 2 3 |0__ 0__ 1__ 2__ 3 4 5 |]
`;
const jpwRestFusion = fromJpw(JpwFile.fromString(jpwRestFusionText)!);
check(jpwRestFusion, "JPW rest-fusion fixture did not parse");
const jpwFirstMeasureRests = jpwRestFusion.parts[0].measures[0].entries.filter(
  (entry): entry is Chord => entry instanceof Chord && entry.rest,
);
const jpwSecondMeasureRests = jpwRestFusion.parts[0].measures[1].entries.filter(
  (entry): entry is Chord => entry instanceof Chord && entry.rest,
);
check(jpwFirstMeasureRests.length === 1
  && jpwFirstMeasureRests[0].position.equals(0)
  && jpwFirstMeasureRests[0].duration?.equals(1)
  && jpwSecondMeasureRests.length === 1
  && jpwSecondMeasureRests[0].position.equals(0)
  && jpwSecondMeasureRests[0].duration?.equals(new Fraction(1, 2)),
`JPW rests did not fuse inside one beat: ${JSON.stringify({
  first: jpwFirstMeasureRests.map((entry) => [entry.position.toString(), entry.duration?.toString()]),
  second: jpwSecondMeasureRests.map((entry) => [entry.position.toString(), entry.duration?.toString()]),
})}`);

const multiSources = buildSlashSourceNotes(multiVoiceText, multiVoiceOptions, multiVoiceScore);
check(multiSources.map((source) => source.voiceIndex).join(",") === "1,2,3,1,2,3",
  "voice-marked chord pitches were not mapped back to their own rendered rows");
check(inferSlashVoiceCount(multiVoiceText) === 3,
  "maximum consecutive U+2063 markers did not infer three voices");
const nineVoiceText = `键盘谱\n4/4拍：\n${SLASH_VOICE_SEPARATOR.repeat(8)}Q../Z../Z../Z../\n`;
check(inferSlashVoiceCount(nineVoiceText) === 9
  && defaultSlashScoreOptions("keyboard", analyzeSlashScore(nineVoiceText)).voiceCount === 9,
"eight consecutive U+2063 markers did not infer V1..V9 mode");
check(slashVoiceMarker(10, 2, 2) === SLASH_VOICE_SEPARATOR.repeat(11)
  && slashVoiceMarker(10, 1, 2) === SLASH_VOICE_SEPARATOR.repeat(10),
"voice reassignment marker encoding discarded compact fine-cell padding");
const migrationAccentText = `键盘谱
4/4拍：
${SLASH_VOICE_SEPARATOR.repeat(2)}#Q..../${SLASH_VOICE_SEPARATOR.repeat(2)}bA..../Q..../Q..../
`;
const migrationAccentOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(migrationAccentText)),
  voiceCount: 2,
};
const migratedAccent = migrateSlashVoiceCount(migrationAccentText, migrationAccentOptions, 1);
check(migratedAccent.text.includes("#Q")
  && migratedAccent.text.includes("bA")
  && !migratedAccent.text.includes(SLASH_VOICE_SEPARATOR),
"voice migration rejected accidental pitches when removing a marked voice");
const paddedDefaultText = `键盘谱
4/4拍：
${SLASH_VOICE_SEPARATOR.repeat(11)}#Q..../Q..../Q..../Q..../
`;
const paddedDefaultOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(paddedDefaultText)),
  voiceCount: 2,
};
const raisedPaddedDefault = migrateSlashVoiceCount(paddedDefaultText, paddedDefaultOptions, 3);
check(raisedPaddedDefault.text.includes(`${SLASH_VOICE_SEPARATOR.repeat(12)}#Q`)
  && raisedPaddedDefault.options.voiceCount === 3,
"increasing TXT voices dropped padding from an explicitly encoded default atom");

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

const migrationMetadataText = `数字谱
4/4拍：
${SLASH_VOICE_SEPARATOR}0..../${SLASH_VOICE_SEPARATOR.repeat(2)}1..../${SLASH_VOICE_SEPARATOR.repeat(3)}2..../1..../
`;
const migrationMetadataOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("number", analyzeSlashScore(migrationMetadataText)),
  voiceCount: 3,
  annotations: [
    { type: "triplet", part: 2, voice: 3, measure: 0, offset: 0, scope: "voice", members: [0.25, 0.25, 0.25] },
    { type: "text", part: 2, measure: 0, offset: 0, text: "V3" },
  ],
  noteTimingEdits: [{ part: 2, chord: 0, move: "0", duration: "1/4" }],
};
const migratedMetadata = migrateSlashVoiceCount(migrationMetadataText, migrationMetadataOptions, 2);
const migratedMetadataAnalysis = analyzeSlashScore(migratedMetadata.text);
check(!migratedMetadata.text.includes(`${SLASH_VOICE_SEPARATOR.repeat(3)}2`)
  && migratedMetadata.text.includes(`${SLASH_VOICE_SEPARATOR}0`)
  && migratedMetadata.text.includes(`${SLASH_VOICE_SEPARATOR.repeat(2)}1`)
  && migratedMetadataAnalysis.annotations.some((item) =>
    item.type === "triplet" && item.part === 1 && item.voice === 2)
  && migratedMetadataAnalysis.annotations.some((item) => item.type === "text" && item.part === 1)
  && migratedMetadataAnalysis.noteTimingEdits.some((item) => item.part === 1),
"reducing TXT voices did not migrate marked rests and persisted part/voice metadata");
const restoredMetadata = migrateSlashVoiceCount(
  migratedMetadata.text,
  { ...migrationMetadataOptions, voiceCount: 2, annotations: migratedMetadataAnalysis.annotations,
    noteTimingEdits: migratedMetadataAnalysis.noteTimingEdits },
  3,
);
check(restoredMetadata.text.includes(`${SLASH_VOICE_SEPARATOR}0`)
  && analyzeSlashScore(restoredMetadata.text).annotations.some((item) =>
    item.type === "triplet" && item.part === 2 && item.voice === 3),
"increasing TXT voices did not move the merged default metadata to the new default row");
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

// A parse's pitch scan can be passed directly to source-note association.
// Saved directives still participate when the caller has no explicit voice
// setting; an explicit dialog choice continues to take precedence.
const cachedSourceText = embedSlashScoreOptions(twoVoiceText, {
  ...twoVoiceOptions,
  voiceCount: 3,
});
const cachedSourceBase = {
  ...twoVoiceOptions,
  voiceCount: undefined as unknown as number,
};
const cachedSourceParse = parseEditableDocument(cachedSourceText, "keyboard", cachedSourceBase);
check(cachedSourceParse?.slashOptions && cachedSourceParse.slashSources,
  "TXT parse did not expose its pitch-source scan");
check(JSON.stringify(cachedSourceParse.slashSources)
  === JSON.stringify(slashPitchSources(cachedSourceText, cachedSourceParse.slashOptions)),
"shared pitch sources differ from the direct scan with saved directives");
check(cachedSourceParse.slashSources.some((source) => source.voiceIndex === 3)
  && slashPitchSources(cachedSourceText, { ...cachedSourceBase, voiceCount: 2 })
    .some((source) => source.voiceIndex === 2),
"saved voice-count directive did not affect the shared scan, or overrode an explicit dialog choice");
const sourceNoteSignature = (notes: ReturnType<typeof buildSlashSourceNotes>) =>
  notes.map((source) => [
    source.from, source.to, source.partIndex, source.chordIndex,
    source.note.pitch, source.voiceIndex, source.markerFrom, source.markerCount,
  ]);
check(JSON.stringify(sourceNoteSignature(buildSlashSourceNotes(
  cachedSourceText, cachedSourceParse.slashOptions, cachedSourceParse.score,
  cachedSourceParse.slashSources,
))) === JSON.stringify(sourceNoteSignature(buildSlashSourceNotes(
  cachedSourceText, cachedSourceParse.slashOptions, cachedSourceParse.score,
))), "shared and independent TXT source-note association differ");

// A long paired TXT score must remain a portable core regression: local song
// exports are intentionally ignored by Git and absent from CI checkouts.
const fullKeyboard = `键盘谱\n4/4拍：\n点=八分音符\n${Array.from(
  { length: 48 }, () => "(VJ).Q./(ZG)../B.S./D.Q./",
).join("\n")}\n`;
const fullNumber = `数字谱\n4/4拍：\n点=八分音符\n${Array.from(
  { length: 48 }, () => "(-47).+1./(-15)../-5.2./3.+1./",
).join("\n")}\n`;
const fullKeyboardResult = parseSlashScore(fullKeyboard, defaultSlashScoreOptions("keyboard", analyzeSlashScore(fullKeyboard)));
const fullNumberResult = parseSlashScore(fullNumber, defaultSlashScoreOptions("number", analyzeSlashScore(fullNumber)));
check(fullKeyboardResult.summary.measures === 48, "long keyboard fixture has 48 measures");
check(fullNumberResult.summary.measures === 48, "long number fixture has 48 measures");
check(!fullKeyboardResult.score.piano && !fullNumberResult.score.piano, "long TXT fixtures stay single-staff");
check(fullKeyboardResult.summary.clippedGroups === 0 && fullNumberResult.summary.clippedGroups === 0, "long TXT fixtures fit every slash group");
check(fullKeyboardResult.summary.ignoredCharacters === 0 && fullNumberResult.summary.ignoredCharacters === 0, "long TXT fixtures contain no unknown score symbols");
check(JSON.stringify(sounding(fullKeyboardResult.score)) === JSON.stringify(sounding(fullNumberResult.score)),
  "long keyboard and number fixtures changed pitch or timing correspondence");

const readableDirectives = [
  "// @key m=3 beat=2.5 1=D",
  "// @tempo rit from=24@1 to=26@1 target=65",
  "// @tempo set m=26 beat=1 bpm=65",
].join("\n");
const parsedReadable = parseSlashReadableDirectives(readableDirectives);
check(parsedReadable.keyChanges.length === 1
  && parsedReadable.keyChanges[0].measure === 2
  && parsedReadable.keyChanges[0].offset === 2.5
  && parsedReadable.keyChanges[0].fifths === 2,
"readable @key directive did not parse one-based measure and intra-measure offset");
check(parsedReadable.tempoMarks.length === 3
  && parsedReadable.tempoMarks[0].kind === "rit"
  && parsedReadable.tempoMarks[1].kind === "tempo"
  && parsedReadable.tempoMarks[1].bpm === 65,
"readable @tempo ramp/set directives did not produce playback marks");
const readableRoundTrip = serializeSlashReadableDirectives(parsedReadable.annotations).join("\n");
check(readableRoundTrip.includes("// @key m=3 beat=2.5 1=D")
  && readableRoundTrip.includes("// @tempo rit from=24@1 to=26@1 target=65"),
"readable notation annotations did not serialize stably");
const humanDirectives = serializeSlashHumanDirectives(parsedReadable.annotations).join("\n");
check(humanDirectives.includes('// "第3小节第3.5拍转调到D"')
  && humanDirectives.includes('// "第24小节第2拍到第26小节第2拍渐慢到65BPM"'),
"human notation annotations did not serialize beside the score");

const localMeterText = `键盘谱
4/4拍：
点=16分音符
3/4拍:
(NDE).H.(AG).E./.H.G.H./D.N.B.D./
4/4拍:
// "第93小节第1.75拍到第94小节第1拍渐慢到65BPM"
.(0B).S.N./(0D).S.G.D./(0H).G.W.H./E.W.T.E./
// "第94小节第2拍到第95小节第1拍渐快到87BPM"
(0Y)..../..../..../..../
`;
const localMeterOptions = defaultSlashScoreOptions(
  "keyboard",
  analyzeSlashScore(localMeterText),
);
localMeterOptions.voiceCount = 2;
localMeterOptions.braceMode = "grace";
localMeterOptions.bracketMode = "triplet";
localMeterOptions.showExplicitRests = true;
const localMeterResult = parseSlashScore(localMeterText, localMeterOptions);
check(localMeterResult.summary.diagnostics.every((item) => item.severity !== "error")
  && localMeterResult.score.parts[0].measures[0].time.beats === 3
  && localMeterResult.score.parts[0].measures[1].time.beats === 4,
`row-local 3/4 and 4/4 meters were diagnosed using one global group count: ${JSON.stringify({
  diagnostics: localMeterResult.summary.diagnostics,
  meters: localMeterResult.score.parts[0].measures.map((measure) => [measure.time.beats, measure.time.beatType]),
})}`);

const commentStableOriginal = `键盘谱
4/4拍：
A.../B.../C.../D.../
// "第1小节第2拍到第2小节第1拍渐慢到65BPM"
E.../F.../G.../H.../

// @jpeditor {"v":2,"vc":1,"k":"k"}
`;
const commentStableReplacement = `键盘谱
4/4拍：
Q.../W.../E.../R.../
T.../Y.../U.../I.../
0.../0.../0.../0.../
`;
const commentStableResult = replaceSlashScoreLines(
  commentStableOriginal,
  commentStableReplacement,
  "keyboard",
);
check(commentStableResult.indexOf("Q.../") < commentStableResult.indexOf("渐慢到65BPM")
  && commentStableResult.indexOf("渐慢到65BPM") < commentStableResult.indexOf("T.../")
  && commentStableResult.indexOf("T.../") < commentStableResult.indexOf("0.../")
  && commentStableResult.indexOf("0.../") < commentStableResult.indexOf("// @jpeditor"),
`adding an input-tail row moved an inter-measure annotation or reordered score rows:\n${commentStableResult}`);

const meterFile = JpwFile.fromString(`.Title
KeyAndMeters = {1=C,4/4}
.Voice
1 2 3 4 |5 6 7 1 |]
`);
check(meterFile !== null, "meter-change TXT fixture did not parse");
const meterScore = fromJpw(meterFile!);
const changedMeter = meterScore.parts[0].measures[1];
changedMeter.time.beats = 3;
changedMeter.time.beatType = 4;
changedMeter.timeChange = true;
changedMeter.entries = changedMeter.entries.filter((entry) =>
  !(entry instanceof Chord) || entry.position.compareTo(new Fraction(3)) < 0);
const meterBody = scoreToSlashScore(meterScore, "number", 16, ".");
const meterOptions = {
  ...defaultSlashScoreOptions("number", analyzeSlashScore(meterBody)),
  symbolDurations: { ".": 16 as const },
};
const storedMeter = embedSlashScoreOptionsFromScore(meterBody, meterScore, meterOptions);
const replacedMeterLines = replaceSlashScoreLines(
  meterBody.replace("3/4拍:\n", ""),
  meterBody,
  "number",
);
const replacedOpeningMeter = replaceSlashScoreLines(
  "数字谱\n2/4拍：\n1./2./\n",
  "数字谱\n3/4拍：\n1./2./3./\n",
  "number",
);
const reopenedMeter = parseSlashScore(
  storedMeter,
  defaultSlashScoreOptions("number", analyzeSlashScore(storedMeter)),
).score.parts[0].measures[1];
const meterLines = meterBody.split(/\r?\n/);
const meterDirectiveIndex = meterLines.findIndex((line) => line.trim() === "3/4拍:");
const changedMeterBody = meterDirectiveIndex >= 0 ? meterLines[meterDirectiveIndex + 1] ?? "" : "";
check(meterBody.includes("3/4拍:")
  && changedMeterBody.split("/").length - 1 === 3
  && (replacedMeterLines.match(/3\/4拍:/g)?.length ?? 0) === 1
  && replacedOpeningMeter.includes("3/4拍：")
  && !replacedOpeningMeter.includes("2/4拍：")
  && storedMeter.includes('"type":"meter"')
  && reopenedMeter.time.beats === 3
  && reopenedMeter.time.beatType === 4
  && reopenedMeter.timeChange,
"mid-score TXT meter change did not use exactly three groups or survive metadata round-trip");
const storedMeterNormalized = storedMeter.replace(/\r\n/g, "\n");
check(storedMeterNormalized.includes("\n\n// @jpeditor ")
  && !storedMeterNormalized.includes("\n\n\n// @jpeditor "),
"TXT footer did not keep exactly one blank line after the final score row");

const footerScore = fromJpw(meterFile!);
footerScore.keyMarks.push(new KeyMark(1, new Fraction(1), 2));
const footerRamp = new TempoMark();
footerRamp.measure = 0;
footerRamp.offset = new Fraction(1);
footerRamp.kind = "rit";
const footerTarget = new TempoMark();
footerTarget.measure = 1;
footerTarget.offset = new Fraction(0);
footerTarget.kind = "tempo";
footerTarget.bpm = 65;
footerScore.tempoMarks.push(footerRamp, footerTarget);
const machineFooter = embedSlashScoreOptionsFromScore(
  scoreToSlashScore(footerScore, "number", 16, "."),
  footerScore,
  meterOptions,
).replace(/\r\n/g, "\n");
const footerLines = machineFooter.trimEnd().split("\n");
const footerJp = footerLines.findIndex((line) => line.startsWith("// @jpeditor "));
const footerKey = footerLines.findIndex((line) => line.startsWith("// @key "));
const footerTempo = footerLines.findIndex((line) => line.startsWith("// @tempo "));
check(footerJp > 0 && footerKey > footerJp && footerTempo > footerKey
  && footerLines.slice(footerJp).every((line) => /^\/\/ @(?:jpeditor|key|tempo)\b/.test(line)),
"TXT machine metadata was not kept together at the document footer in jpeditor/key/tempo order");

const annotationText = `数字谱\n// @jpeditor {"v":2,"vc":1,"k":"n","ri":false,"kc":[{"measure":2,"offset":1.5,"fifths":2}],"an":[{"type":"tempo-ramp","mode":"rit","from":{"measure":1,"offset":1},"to":{"measure":3,"offset":0},"targetBpm":65},{"type":"future-unknown","x":1}]}\n4/4拍：\n1../2../3../4../\n`;
const annotationAnalysis = analyzeSlashScore(annotationText);
check(annotationAnalysis.showExplicitRests === false
  && annotationAnalysis.keyChanges[0]?.offset === 1.5
  && annotationAnalysis.annotations.length === 1
  && annotationAnalysis.annotations[0].type === "tempo-ramp",
"@jpeditor ri/kc/an metadata did not validate and restore safely");
const legacyRestAnalysis = analyzeSlashScore(
  "数字谱\n// @jpeditor {\"v\":2,\"vc\":1,\"k\":\"n\"}\n4/4拍：\n1../2../3../4../\n",
);
check(legacyRestAnalysis.showExplicitRests === true,
"legacy @jpeditor metadata did not default explicit rests to true");

const scoreAnnotationText = `数字谱
// @jpeditor {"v":2,"vc":2,"k":"n","an":[{"type":"ornament","part":0,"measure":0,"offset":0,"kind":"trill","subdivision":32},{"type":"cross-arpeggio","measure":0,"offset":0,"parts":[0,1],"pitches":[{"part":0,"pitch":60},{"part":1,"pitch":48}],"direction":"down"},{"type":"text","part":1,"measure":0,"offset":0,"text":"rit."},{"type":"unknown","x":1}]}
4/4拍：
1../2../3../4../
`;
const scoreAnnotationOptions = {
  ...defaultSlashScoreOptions("number", analyzeSlashScore(scoreAnnotationText)),
  voiceCount: 2,
};
const scoreAnnotation = parseSlashScore(scoreAnnotationText, scoreAnnotationOptions).score;
check(scoreAnnotation.parts[0]?.measures[0]?.entries.some((entry) =>
  entry instanceof Chord && entry.ornaments.some((item) => item.kind === "trill" && item.subdivision === 32)),
"TXT ornament annotation did not apply to its chord");
check(scoreAnnotation.crossPartArpeggios.length === 1
  && scoreAnnotation.crossPartArpeggios[0].parts.join(",") === "0,1"
  && scoreAnnotation.crossPartArpeggios[0].direction === "down"
  && scoreAnnotation.textMarks[0]?.partIndex === 1,
"TXT cross-part arpeggio/text annotations did not apply to Score");
const generatedAnnotations = notationAnnotationsFromScore(scoreAnnotation);
check(generatedAnnotations.some((annotation) => annotation.type === "ornament")
  && generatedAnnotations.some((annotation) => annotation.type === "cross-arpeggio")
  && generatedAnnotations.some((annotation) => annotation.type === "text" && annotation.part === 1),
"Score annotations were not collected for TXT metadata export");
const annotationRoundTrip = embedSlashScoreOptionsFromScore(
  "数字谱\n1../2../3../4../\n",
  scoreAnnotation,
  scoreAnnotationOptions,
);
check(annotationRoundTrip.includes('"an"') && analyzeSlashScore(annotationRoundTrip).annotations.length >= 3,
"Score annotation metadata helper did not persist annotations");
const machineHeader = annotationRoundTrip.indexOf("// @jpeditor");
const machineTempo = annotationRoundTrip.indexOf("// @tempo");
const humanTempo = annotationRoundTrip.indexOf('// "24到26');
check(machineHeader >= 0 && machineTempo === -1 && humanTempo === -1,
"annotation metadata unexpectedly leaked machine directives without corresponding Score marks");

const explicitRestFile = JpwFile.fromString(`.Title
KeyAndMeters = {1=C,4/4}
.Voice
1 0 2 0 |]
`);
check(explicitRestFile !== null, "explicit-rest JPW fixture did not parse");
const explicitRestScore = fromJpw(explicitRestFile!);
const restExportOptions = {
  braceMode: "grace" as const,
  bracketMode: "triplet" as const,
  durationNotation: {
    symbolDurations: { ".": 16 as const },
    multiDurationSymbols: false,
    spaceDivision: null,
    noteDivision: null,
    emptyGroupsAsRests: false,
    showExplicitRests: true,
  },
};
const explicitRestText = scoreToSlashScore(
  explicitRestScore,
  "number",
  16,
  ".",
  { ...restExportOptions, showExplicitRests: true },
);
const implicitRestText = scoreToSlashScore(
  explicitRestScore,
  "number",
  16,
  ".",
  {
    ...restExportOptions,
    showExplicitRests: false,
    durationNotation: { ...restExportOptions.durationNotation, showExplicitRests: false },
  },
);
check(/(?:^|[/(])0(?:[./)]|$)/m.test(explicitRestText),
`explicit-rest TXT export lost written 0 attacks:\n${explicitRestText}`);
check(!/(?:^|[/(])0(?:[./)]|$)/m.test(implicitRestText),
"implicit-sustain TXT export retained internal written 0 attacks");

// A mordent on one voice of a simultaneous chord is represented in TXT as a
// fixed 3:2 group.  The generated neighbour and return note retain the
// source voice marker, so a later parse cannot move the ornament to the other
// hand.
const mordentText = `数字谱
// @jpeditor {"v":2,"vc":2,"k":"n","q":"t","an":[{"type":"ornament","part":0,"measure":0,"offset":0,"kind":"upper-mordent"}]}
4/4拍：
(1${SLASH_VOICE_SEPARATOR}3)---/
`;
const mordentAnalysis = analyzeSlashScore(mordentText);
const mordentOptions = {
  ...defaultSlashScoreOptions("number", mordentAnalysis),
  voiceCount: 2,
  symbolDurations: { ".": 16 as const },
};
const mordentScore = parseSlashScore(mordentText, mordentOptions).score;
const mordentRoundTrip = scoreToSlashScore(
  mordentScore,
  "number",
  16,
  ".",
  { braceMode: "grace", bracketMode: "triplet" },
  2,
);
check(/\[\([^)]*\)[^\]]+\]/.test(mordentRoundTrip)
  && mordentRoundTrip.includes(SLASH_VOICE_SEPARATOR),
"TXT upper-mordent did not serialize as a voiced fixed triplet");
const mordentParsed = parseSlashScore(
  mordentRoundTrip,
  defaultSlashScoreOptions("number", analyzeSlashScore(mordentRoundTrip)),
).score;
const mordentEvents = mordentParsed.parts[0]?.measures[0]?.entries
  .filter((entry): entry is Chord => entry instanceof Chord && !entry.rest) ?? [];
const mordentTimeline = buildTimeline(mordentParsed);
check(mordentEvents.length >= 3 && mordentTimeline.notes.length >= 3
  && mordentTimeline.notes[0]?.t0 === 0,
"TXT mordent triplet did not retain its three parsed timing atoms");
const storedMordent = embedSlashScoreOptionsFromScore(
  mordentRoundTrip,
  mordentScore,
  mordentOptions,
);
const storedMordentOptions = defaultSlashScoreOptions(
  "number",
  analyzeSlashScore(storedMordent),
);
const storedMordentScore = parseSlashScore(storedMordent, storedMordentOptions).score;
const storedMordentTuplets = new Set(storedMordentScore.parts.flatMap((part) =>
  part.measures.flatMap((measure) => measure.entries.flatMap((entry) =>
    entry instanceof Chord ? entry.notes.flatMap((note) => note.tuplet ? [note.tuplet] : []) : []))));
const storedMordentAnnotations = notationAnnotationsFromScore(storedMordentScore);
check([...storedMordentTuplets].length === 0
  && storedMordentScore.parts[0].measures[0].entries.some((entry) =>
    entry instanceof Chord && entry.ornaments.some((item) => item.kind === "upper-mordent"))
  && storedMordentAnnotations.some((item) => item.type === "ornament"
    && item.kind === "upper-mordent")
  && !storedMordentAnnotations.some((item) => item.type === "triplet"),
"a semantic upper mordent persisted its helper pitches as a visible triplet");
const secondMordentRoundTrip = scoreToSlashScore(
  storedMordentScore,
  "number",
  16,
  ".",
  { braceMode: "grace", bracketMode: "triplet" },
  2,
);
const firstMordentRow = mordentRoundTrip.split(/\r?\n/)
  .find((line) => !line.trim().startsWith("//") && /\/$/.test(line.trim()));
const secondMordentRow = secondMordentRoundTrip.split(/\r?\n/)
  .find((line) => !line.trim().startsWith("//") && /\/$/.test(line.trim()));
check(firstMordentRow === secondMordentRow
  && (secondMordentRoundTrip.match(/\[/g)?.length ?? 0) === 1
  && storedMordentScore.parts[0]?.measures.length === 1,
`TXT semantic mordent changed after a second edit/save cycle:\nfirst=${firstMordentRow}\nsecond=${secondMordentRow}`);

const lowerMordentSource = mordentText.replace("upper-mordent", "lower-mordent");
const lowerMordentOptions = {
  ...defaultSlashScoreOptions("number", analyzeSlashScore(lowerMordentSource)),
  voiceCount: 2,
  symbolDurations: { ".": 16 as const },
};
const lowerMordentScore = parseSlashScore(lowerMordentSource, lowerMordentOptions).score;
const lowerMordentVisible = scoreToSlashScore(
  lowerMordentScore,
  "number",
  16,
  ".",
  { braceMode: "grace", bracketMode: "triplet" },
  2,
);
const lowerMordentStored = embedSlashScoreOptionsFromScore(
  lowerMordentVisible,
  lowerMordentScore,
  lowerMordentOptions,
);
const lowerMordentReloaded = parseSlashScore(
  lowerMordentStored,
  defaultSlashScoreOptions("number", analyzeSlashScore(lowerMordentStored)),
).score;
const lowerTuplets = new Set(lowerMordentReloaded.parts.flatMap((part) =>
  part.measures.flatMap((measure) => measure.entries.flatMap((entry) =>
    entry instanceof Chord ? entry.notes.flatMap((note) => note.tuplet ? [note.tuplet] : []) : []))));
check([...lowerTuplets].length === 0
  && notationAnnotationsFromScore(lowerMordentReloaded).some((item) =>
    item.type === "ornament" && item.kind === "lower-mordent")
  && !notationAnnotationsFromScore(lowerMordentReloaded).some((item) => item.type === "triplet"),
"a semantic lower mordent did not retain metadata without a visible tuplet annotation");

// A mordent on the TXT's finest ordinary value keeps one semantic `[ABA]`
// spelling. Square brackets must be assigned to triplets; no general-purpose
// attached or subdivision syntax is required.
const finestMordentText = `数字谱
4/4拍：
点=16分音符
1./0.../0.../0.../
`;
const finestMordentOptions = {
  ...defaultSlashScoreOptions("number", analyzeSlashScore(finestMordentText)),
  symbolDurations: { ".": 16 as const },
  braceMode: "arpeggio" as const,
  bracketMode: "triplet" as const,
};
const finestMordentScore = parseSlashScore(finestMordentText, finestMordentOptions).score;
const finestAttack = finestMordentScore.parts[0].measures[0].entries.find(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest,
);
check(finestAttack !== undefined && finestAttack.duration?.equals(new Fraction(1, 4)),
"finest-value mordent fixture did not retain its sixteenth-note duration");

// An explicit duration marker before a semantic mordent must not be counted
// again by the nested `<[...]>` container. The four cells below must remain
// four sixteenths rather than overflowing the beat.
const prefixedMordentText = `数字谱
4/4拍：
点=16分音符
// @jpeditor {"v":2,"vc":1,"k":"n","an":[{"type":"ornament","part":0,"measure":0,"offset":0.25,"kind":"upper-mordent"}]}
1.<[212]>2.3./0.../0.../0.../`;
const prefixedMordentOptions = {
  ...defaultSlashScoreOptions("number", analyzeSlashScore(prefixedMordentText)),
  symbolDurations: { ".": 16 as const },
  braceMode: "triplet" as const,
  bracketMode: "triplet" as const,
  angleMode: "subdivide" as const,
};
const prefixedMordent = parseSlashScore(prefixedMordentText, prefixedMordentOptions);
check(prefixedMordent.summary.diagnostics.every((item) => item.severity !== "error"),
  `a duration-prefixed semantic mordent double-counted its leading marker: ${JSON.stringify(prefixedMordent.summary.diagnostics)}`);
const prefixedMordentFirst = prefixedMordent.score.parts[0]?.measures[0]?.entries
  .filter((entry): entry is Chord => entry instanceof Chord && !entry.rest);
check(prefixedMordentFirst !== undefined
  && Math.abs(prefixedMordentFirst.reduce((sum, entry) =>
    sum + (entry.duration?.toFloat() ?? 0), 0) - 1) < 1e-8,
  `a duration-prefixed semantic mordent changed the beat span: ${prefixedMordentFirst
    ?.map((entry) => entry.duration?.toFloat())}`);

// The real two-voice keyboard spelling keeps the mordent's ordinary duration
// marker outside the nested semantic container: `<[ASA]>.`. Only its main A
// belongs in the score; S/A are playback spelling helpers and must neither
// render as extra digits, leave the beat one sixteenth short, nor move the
// following V1 attacks into the unmarked/default V2.
const voicedMordentText = `键盘谱
4/4拍：
. = 16分音符
(V${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G).<[${SLASH_VOICE_SEPARATOR}A${SLASH_VOICE_SEPARATOR}S${SLASH_VOICE_SEPARATOR}A]>.${SLASH_VOICE_SEPARATOR}N.(${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G)./.${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N.${SLASH_VOICE_SEPARATOR}A./(B${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G).${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N.(${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G)./.${SLASH_VOICE_SEPARATOR}N.${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N./`;
const voicedMordent = parseSlashScore(voicedMordentText, {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(voicedMordentText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 as const },
  bracketMode: "triplet",
  angleMode: "subdivide",
  annotations: [{
    type: "ornament",
    part: 0,
    measure: 0,
    offset: 0.25,
    kind: "upper-mordent",
  }],
});
check(voicedMordent.summary.diagnostics.every((item) => item.severity !== "error"),
  `a voiced <[ASA]> mordent corrupted its enclosing beat: ${JSON.stringify(voicedMordent.summary.diagnostics)}`);
const voicedMordentAttacks = voicedMordent.score.parts[0]?.measures[0]?.entries.filter(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest
    && entry.position.equals(new Fraction(1, 4)),
) ?? [];
check(voicedMordentAttacks.length === 1
  && voicedMordentAttacks[0]!.ornaments.some((item) => item.kind === "upper-mordent"),
"a voiced semantic mordent rendered its S/A helper pitches as ordinary notes");
const voicedMordentV1Attacks = voicedMordent.score.parts[0]?.measures[0]?.entries.filter(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest
    && !entry.generatedTimingContinuation,
) ?? [];
const voicedMordentV2Attacks = voicedMordent.score.parts[1]?.measures[0]?.entries.filter(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest
    && !entry.generatedTimingContinuation,
) ?? [];
check(voicedMordentV1Attacks.some((entry) => entry.position.equals(new Fraction(1, 2)))
  && voicedMordentV1Attacks.some((entry) => entry.position.equals(new Fraction(3, 4)))
  && !voicedMordentV2Attacks.some((entry) => entry.position.equals(new Fraction(1, 4))
    || entry.position.equals(new Fraction(1, 2))
    || entry.position.equals(new Fraction(3, 4))),
"a semantic V1 mordent moved the remaining first-beat attacks into V2");
const voicedMordentSaved = scoreToSlashScore(
  voicedMordent.score,
  "keyboard",
  16,
  ".",
  {
    braceMode: "arpeggio",
    bracketMode: "triplet",
    barMode: "grace",
    angleMode: "subdivide",
    parenMode: "chord",
    durationNotation: {
      ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(voicedMordentText)),
      voiceCount: 2,
      symbolDurations: { ".": 16 as const },
      noteDivision: 16 as const,
    },
  },
  2,
);
check(voicedMordentSaved.includes(`[${SLASH_VOICE_SEPARATOR}A${SLASH_VOICE_SEPARATOR}S${SLASH_VOICE_SEPARATOR}A].`)
  && !voicedMordentSaved.includes(`<[${SLASH_VOICE_SEPARATOR}A${SLASH_VOICE_SEPARATOR}S${SLASH_VOICE_SEPARATOR}A]>`)
  && !voicedMordentSaved.includes(`[${SLASH_VOICE_SEPARATOR}A${SLASH_VOICE_SEPARATOR}S${SLASH_VOICE_SEPARATOR}A]${SLASH_VOICE_SEPARATOR}N.`),
"voiced semantic mordent lost its external finest-value marker during TXT serialization");
const voicedMordentReload = parseSlashScore(voicedMordentSaved, {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(voicedMordentSaved)),
  voiceCount: 2,
  symbolDurations: { ".": 16 as const },
  noteDivision: 16 as const,
  annotations: [{
    type: "ornament",
    part: 0,
    measure: 0,
    offset: 0.25,
    kind: "upper-mordent",
  }],
});
check(voicedMordentReload.summary.diagnostics.every((item) => item.severity !== "error")
  && voicedMordentReload.score.parts[0]?.measures[0]?.entries.some((entry) =>
    entry instanceof Chord && entry.position.equals(new Fraction(1, 4))
      && entry.ornaments.some((item) => item.kind === "upper-mordent"))
  && voicedMordentReload.score.parts[0]?.measures[0]?.entries.some((entry) =>
    entry instanceof Chord && !entry.rest && entry.position.equals(new Fraction(1, 2)))
  && !voicedMordentReload.score.parts[1]?.measures[0]?.entries.some((entry) =>
    entry instanceof Chord && !entry.rest
      && (entry.position.equals(new Fraction(1, 4)) || entry.position.equals(new Fraction(1, 2)))),
`voiced semantic mordent with external marker did not round-trip cleanly:\n${voicedMordentSaved}\n${JSON.stringify(voicedMordentReload.summary.diagnostics)}`);

// An unmarked nested triplet uses the ordinary finest cell as its nominal
// span. It must not use the already-halved `braceUnit`, or each member is
// shortened one extra binary level (16ths becoming 64ths).
const nestedUnmarked16 = parseSlashScore(`数字谱
4/4拍：
点=16分音符
<[121]>A.../0.../0.../0.../`, {
  ...defaultSlashScoreOptions("number", analyzeSlashScore(`数字谱
4/4拍：
点=16分音符
<[121]>A.../0.../0.../0.../`)),
  symbolDurations: { ".": 16 as const },
  bracketMode: "triplet" as const,
  angleMode: "subdivide" as const,
});
const nested16Entries = nestedUnmarked16.score.parts[0]?.measures[0]?.entries
  .filter((entry): entry is Chord => entry instanceof Chord);
const nested16Members = nested16Entries?.slice(0, 3) ?? [];
check(nested16Members.length === 3
  && nested16Members.every((entry) => Math.abs((entry.duration?.toFloat() ?? 0) - 1 / 12) < 1e-8),
  `unmarked 16th nested triplet members were not 1/12 quarter each: ${nested16Members
    .map((entry) => entry.duration?.toFloat())}`);

const nestedUnmarked64Text = `数字谱
4/4拍：
点=64分音符
<[121]>1/0.../0.../0.../`;
const nestedUnmarked64Analysis = analyzeSlashScore(nestedUnmarked64Text);
const nestedUnmarked64 = parseSlashScore(nestedUnmarked64Text, {
  ...defaultSlashScoreOptions("number", nestedUnmarked64Analysis),
  symbolDurations: { ".": 64 as const },
  bracketMode: "triplet" as const,
  angleMode: "subdivide" as const,
});
const nested64Entries = nestedUnmarked64.score.parts[0]?.measures[0]?.entries
  .filter((entry): entry is Chord => entry instanceof Chord);
const nested64Members = nested64Entries?.slice(0, 3) ?? [];
check(nested64Members.length === 3
  && nested64Members.every((entry) => Math.abs((entry.duration?.toFloat() ?? 0) - 1 / 48) < 1e-8),
  `unmarked 64th nested triplet members were not 1/48 quarter each: ${nested64Members
    .map((entry) => entry.duration?.toFloat())}`);

finestAttack.ornaments = [{ kind: "upper-mordent" }];
const finestMordentRoundTrip = scoreToSlashScore(
  finestMordentScore,
  "number",
  16,
  ".",
  {
    braceMode: "arpeggio",
    bracketMode: "triplet",
    durationNotation: finestMordentOptions,
  },
  1,
);
check(finestMordentRoundTrip.includes("[121].") && !finestMordentRoundTrip.includes("<[") ,
`finest-value mordent did not use canonical square-triplet spelling:\n${finestMordentRoundTrip}`);
const reparsedFinestMordent = parseSlashScore(
  finestMordentRoundTrip,
  defaultSlashScoreOptions("number", analyzeSlashScore(finestMordentRoundTrip)),
).score;
const reparsedFinestNotes = buildTimeline(reparsedFinestMordent).notes
  .filter((note) => note.part === 0 && note.t0 < 0.25 - 1e-8);
check(reparsedFinestNotes.length >= 3,
"nested subdivision/triplet mordent did not parse back into three attacks");
const illegalFinestMordent = scoreToSlashScore(
  finestMordentScore,
  "number",
  16,
  ".",
  {
    braceMode: "grace",
    bracketMode: "triplet",
    durationNotation: { ...finestMordentOptions, braceMode: "grace", bracketMode: "triplet" },
  },
  1,
);
check(illegalFinestMordent.includes("[121].") && !illegalFinestMordent.includes("<["),
"a finest-value TXT mordent still required a subdivision wrapper");
const toolbarFineMordent = scoreToSlashScore(
  finestMordentScore,
  "number",
  16,
  ".",
  {
    braceMode: "grace",
    bracketMode: "triplet",
    angleMode: "subdivide",
    durationNotation: { ...finestMordentOptions, braceMode: "grace", bracketMode: "triplet" },
  },
  1,
);
check(toolbarFineMordent.includes("[121].")
  && !toolbarFineMordent.includes("<[")
  && !toolbarFineMordent.includes("<<"),
`toolbar fine-grid mode subdivided the semantic mordent twice:\n${toolbarFineMordent}`);

// A voiced explicit triplet keeps its U+2063 ownership and one common 4/4
// measure.  The lower/default voice sustains the opening 1 while V1 performs
// 3-4-3 in the fixed 3:2 container; the row must not grow on a save cycle.
const voicedTripletText = `数字谱\n// @jpeditor {"v":2,"vc":2,"k":"n","q":"t","s":{".":16}}\n4/4拍：\n[(1${SLASH_VOICE_SEPARATOR}3).${SLASH_VOICE_SEPARATOR}4.${SLASH_VOICE_SEPARATOR}3.]../..../..../..../\n`;
const voicedTripletAnalysis = analyzeSlashScore(voicedTripletText);
const voicedTripletOptions = {
  ...defaultSlashScoreOptions("number", voicedTripletAnalysis),
  voiceCount: 2,
  symbolDurations: { ".": 16 as const },
  bracketMode: "triplet" as const,
};
const voicedTripletScore = parseSlashScore(voicedTripletText, voicedTripletOptions).score;
check(voicedTripletScore.parts.length === 2
  && voicedTripletScore.parts.every((part) => part.measures.length === 1),
"voiced explicit triplet expanded into an extra measure");
const voicedTripletRoundTrip = scoreToSlashScore(
  voicedTripletScore,
  "number",
  16,
  ".",
  { braceMode: "grace", bracketMode: "triplet" },
  2,
);
const voicedRows = voicedTripletRoundTrip.split("\n")
  .filter((line) => !line.trim().startsWith("//") && /\/$/.test(line.trim()));
check(voicedRows.length === 1
  && voicedRows[0].replace(/\s/g, "") === `[(1${SLASH_VOICE_SEPARATOR}3).${SLASH_VOICE_SEPARATOR}4.${SLASH_VOICE_SEPARATOR}3.]../..../..../..../`,
`voiced explicit triplet changed during round-trip:\n${voicedTripletRoundTrip}`);

// A cursor-created triplet rest keeps the U+2063 voice immediately before 0;
// the parser must not silently move it into the unmarked/default voice.
const scopedTripletText = `键盘谱\n4/4拍：\n点=16分音符\n[(N${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G).${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}0.]${SLASH_VOICE_SEPARATOR}N.(${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G)./..../..../..../\n`;
const scopedTripletOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(scopedTripletText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 as const },
};
const scopedTripletScore = parseSlashScore(scopedTripletText, scopedTripletOptions).score;
const scopedTupleRest = scopedTripletScore.parts[0].measures[0].entries.find(
  (entry): entry is Chord => entry instanceof Chord && entry.rest
    && entry.position.equals(new Fraction(1, 3))
    && entry.notes.some((note) => note.tuplet !== null),
);
check(scopedTupleRest !== undefined
  && !scopedTripletScore.parts[1].measures[0].entries.some((entry) =>
    entry instanceof Chord && entry.rest && entry.position.equals(new Fraction(1, 3))
    && entry.notes.some((note) => note.tuplet !== null)),
"a U+2063 triplet zero was assigned to the default voice instead of V1");

// Even if all three time columns also contain lower-voice attacks, the
// metadata written by the input cursor limits the created bracket to V1.
const simultaneousScopedTripletText = `键盘谱\n4/4拍：\n点=16分音符\n[(${SLASH_VOICE_SEPARATOR}AZ).(${SLASH_VOICE_SEPARATOR}SX).(${SLASH_VOICE_SEPARATOR}DC).]../..../..../..../\n`;
const simultaneousScopedTripletOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(simultaneousScopedTripletText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 },
  annotations: [{
    type: "triplet",
    part: 0,
    voice: 1,
    measure: 0,
    offset: 0,
    scope: "voice",
  }],
};
const simultaneousScopedTriplet = parseSlashScore(
  simultaneousScopedTripletText,
  simultaneousScopedTripletOptions,
).score;
check(simultaneousScopedTriplet.parts[0].measures[0].entries.some((entry) =>
  entry instanceof Chord && entry.notes.some((note) => note.tuplet !== null))
  && !simultaneousScopedTriplet.parts[1].measures[0].entries.some((entry) =>
    entry instanceof Chord && entry.notes.some((note) => note.tuplet !== null)),
"a cursor-owned V1 triplet also created a bracket in a complete V2 stream");

// A normal default-voice attack at the same column belongs visually inside
// the longest bracket, but the persisted scope keeps it on the binary ruler.
// The repeated V1 chord after the bracket is a fresh attack, never an inferred
// tie merely because it has the same pitches as the last sounding member.
const mergedScopedText = `键盘谱
4/4拍：
. = 16分音符
(V${SLASH_VOICE_SEPARATOR}G).(${SLASH_VOICE_SEPARATOR}C${SLASH_VOICE_SEPARATOR}A).${SLASH_VOICE_SEPARATOR}N.(${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G)./.${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N.${SLASH_VOICE_SEPARATOR}A./[(${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G)(${SLASH_VOICE_SEPARATOR}A${SLASH_VOICE_SEPARATOR}S)${SLASH_VOICE_SEPARATOR}0]B.(${SLASH_VOICE_SEPARATOR}A${SLASH_VOICE_SEPARATOR}S).${SLASH_VOICE_SEPARATOR}N.(${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G)./.${SLASH_VOICE_SEPARATOR}N.${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N./
`;
const mergedScopedOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(mergedScopedText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 },
  annotations: [{
    type: "triplet",
    part: 0,
    voice: 1,
    measure: 0,
    offset: 2,
    end: 2.25,
    members: [0.125, 0.125, 0.125],
    scope: "voice",
  }],
};
const mergedScopedScore = parseSlashScore(mergedScopedText, mergedScopedOptions).score;
const mergedScopedBefore = attackSignature(mergedScopedScore);
const mergedScopedOutput = scoreToSlashScore(
  mergedScopedScore,
  "keyboard",
  16,
  ".",
  { durationNotation: mergedScopedOptions },
  2,
);
const mergedBracket = mergedScopedOutput.match(/\[[^\]]+\]/)?.[0] ?? "";
const mergedScopedReload = parseSlashScore(mergedScopedOutput, {
  ...mergedScopedOptions,
  annotations: notationAnnotationsFromScore(mergedScopedScore),
}).score;
const mergedReloadEntries = mergedScopedReload.parts[0].measures.flatMap((measure) => measure.entries);
const insideRepeated = mergedReloadEntries.find((entry) =>
  entry instanceof Chord && [60, 62].every((pitch) =>
    entry.notes.some((note) => note.tuplet !== null && note.pitch === pitch)));
const outsideRepeated = mergedReloadEntries.find((entry) =>
  entry instanceof Chord && entry !== insideRepeated
    && [60, 62].every((pitch) =>
      entry.notes.some((note) => note.tuplet === null && note.pitch === pitch)));
check(mergedBracket.includes("B") && !mergedScopedOutput.includes("]B.")
  && JSON.stringify(attackSignature(mergedScopedReload)) === JSON.stringify(mergedScopedBefore)
  && insideRepeated?.notes.filter((note) => note.pitch === 60 || note.pitch === 62)
    .every((note) => note.tieNext === null)
  && outsideRepeated?.notes.filter((note) => note.pitch === 60 || note.pitch === 62)
    .every((note) => note.tiePrev === null),
`a binary parallel voice was left outside its visible triplet span or repeated pitches were tied:\n${mergedScopedOutput}\n${JSON.stringify({
  before: mergedScopedBefore,
  after: attackSignature(mergedScopedReload),
})}`);

const repeatedPairState = (score: typeof mergedScopedScore): {
  inside: Chord | null;
  outside: Chord | null;
  untied: boolean;
} => {
  const entries = score.parts[0].measures.flatMap((measure) => measure.entries)
    .filter((entry): entry is Chord => entry instanceof Chord && [60, 62].every((pitch) =>
      entry.notes.some((note) => !note.rest && note.pitch === pitch)));
  const inside = entries.find((entry) => entry.notes.some((note) => note.tuplet !== null)) ?? null;
  const outside = entries.find((entry) => entry !== inside
    && entry.notes.every((note) => note.tuplet === null)) ?? null;
  return {
    inside,
    outside,
    untied: Boolean(inside && outside
      && inside.notes.every((note) => note.tieNext === null)
      && outside.notes.every((note) => note.tiePrev === null)),
  };
};

const resizedScopedScore = parseSlashScore(mergedScopedText, mergedScopedOptions).score;
const resizePair = repeatedPairState(resizedScopedScore);
const resizedScoped = resizePair.inside?.notes.find((note) => note.tuplet !== null);
const resizeResult = resizedScoped
  ? resizeInputTupletMember(resizedScopedScore, resizedScoped, new Fraction(1, 12))
  : null;
const resizedScopedOutput = scoreToSlashScore(
  resizedScopedScore,
  "keyboard",
  16,
  ".",
  { durationNotation: mergedScopedOptions },
  2,
);
const resizedScopedReload = parseSlashScore(resizedScopedOutput, {
  ...mergedScopedOptions,
  annotations: notationAnnotationsFromScore(resizedScopedScore),
}).score;
const resizedPairState = repeatedPairState(resizedScopedReload);
check(resizeResult?.changed && resizedPairState.untied,
`Ctrl+Right joined a lengthened tuplet chord to the later repeated attack:\n${resizedScopedOutput}\n${JSON.stringify({
  inside: resizedPairState.inside?.notes.map((note) => ({ pitch: note.pitch,
    next: note.tieNext?.chord.position.toString() ?? null })),
  outside: resizedPairState.outside?.notes.map((note) => ({ pitch: note.pitch,
    prev: note.tiePrev?.chord.position.toString() ?? null,
    transparent: note.chord.transparentContinuation,
    generated: note.chord.generatedTimingContinuation })),
})}`);

const movedScopedScore = parseSlashScore(mergedScopedText, mergedScopedOptions).score;
const movedPair = repeatedPairState(movedScopedScore);
const movedScoped = movedPair.inside?.notes.find((note) => note.tuplet !== null);
const movedPitch = movedScoped?.pitch ?? null;
const moveResult = movedScoped ? moveInputTieChainByNotationDomain(
  movedScopedScore,
  0,
  movedScoped,
  new Fraction(1, 8),
  1,
) : null;
const movedScopedOutput = scoreToSlashScore(
  movedScopedScore,
  "keyboard",
  16,
  ".",
  { durationNotation: mergedScopedOptions },
  2,
);
const movedScopedReload = parseSlashScore(movedScopedOutput, {
  ...mergedScopedOptions,
  annotations: notationAnnotationsFromScore(movedScopedScore),
}).score;
const movedPitchNotes = movedPitch === null ? [] : movedScopedReload.parts[0].measures
  .flatMap((measure) => measure.entries)
  .flatMap((entry) => entry instanceof Chord
    ? entry.notes.filter((note) => !note.rest && note.pitch === movedPitch)
    : []);
check(moveResult?.changed
  && movedPitchNotes.some((note) => note.tuplet !== null && note.tieNext === null)
  && movedPitchNotes.some((note) => note.tuplet === null && note.tiePrev === null),
`Alt+Right joined a moved tuplet chord to the later repeated attack:\n${movedScopedOutput}`);

// Overlapping voice-local tuplets share one longest visible bracket while
// retaining independent member grids. V1 uses three compact 32nd members in
// one 16th span; V2 uses three 16th members in one eighth span.
const unequalVoiceTupletText = `键盘谱
4/4拍：
. = 16分音符
[(${SLASH_VOICE_SEPARATOR}AE)${SLASH_VOICE_SEPARATOR}B(${SLASH_VOICE_SEPARATOR}CF)G.].../..../..../..../
`;
const unequalVoiceTupletOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(unequalVoiceTupletText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 },
  annotations: [
    { type: "triplet", part: 0, voice: 1, measure: 0, offset: 0,
      end: 0.25, members: [0.125, 0.125, 0.125], scope: "voice" },
    { type: "triplet", part: 1, voice: 2, measure: 0, offset: 0,
      end: 0.5, members: [0.25, 0.25, 0.25], scope: "voice" },
  ],
};
const unequalVoiceTupletScore = parseSlashScore(
  unequalVoiceTupletText,
  unequalVoiceTupletOptions,
).score;
const unequalV1 = unequalVoiceTupletScore.parts[0].measures[0].entries.filter(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest
    && entry.notes.some((note) => note.tuplet !== null),
);
const unequalV2 = unequalVoiceTupletScore.parts[1].measures[0].entries.filter(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest
    && entry.notes.some((note) => note.tuplet !== null),
);
const unequalVoiceOutput = scoreToSlashScore(
  unequalVoiceTupletScore,
  "keyboard",
  16,
  ".",
  { durationNotation: unequalVoiceTupletOptions },
  2,
);
const unequalVoiceReload = parseSlashScore(unequalVoiceOutput, {
  ...unequalVoiceTupletOptions,
  annotations: notationAnnotationsFromScore(unequalVoiceTupletScore),
}).score;
check(unequalV1.map((entry) => entry.position.toString()).join(",") === "0,1/12,1/6"
  && unequalV2.map((entry) => entry.position.toString()).join(",") === "0,1/6,1/3"
  && (unequalVoiceOutput.match(/\[/g) ?? []).length === 1
  && JSON.stringify(attackSignature(unequalVoiceReload))
    === JSON.stringify(attackSignature(unequalVoiceTupletScore)),
`overlapping unequal voice tuplets did not keep one longest bracket and independent grids:\n${unequalVoiceOutput}\n${JSON.stringify({
  v1: unequalV1.map((entry) => `${entry.position}/${entry.duration}`),
  v2: unequalV2.map((entry) => `${entry.position}/${entry.duration}`),
  before: attackSignature(unequalVoiceTupletScore),
  after: attackSignature(unequalVoiceReload),
})}`);

// The longer voice-local tuplet may begin after the shorter one. Its first
// mixed chord aligns that voice to the already-running fine grid.
const offsetVoiceTupletText = `键盘谱
4/4拍：
. = 16分音符
[${SLASH_VOICE_SEPARATOR}A${SLASH_VOICE_SEPARATOR}B(${SLASH_VOICE_SEPARATOR}CE).F.G.].../..../..../..../
`;
const offsetVoiceTupletOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(offsetVoiceTupletText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 },
  annotations: [
    { type: "triplet", part: 0, voice: 1, measure: 0, offset: 0,
      end: 0.25, members: [0.125, 0.125, 0.125], scope: "voice" },
    { type: "triplet", part: 1, voice: 2, measure: 0, offset: 1 / 6,
      end: 2 / 3, members: [0.25, 0.25, 0.25], scope: "voice" },
  ],
};
const offsetVoiceTupletScore = parseSlashScore(
  offsetVoiceTupletText,
  offsetVoiceTupletOptions,
).score;
const offsetVoiceOutput = scoreToSlashScore(
  offsetVoiceTupletScore,
  "keyboard",
  16,
  ".",
  { durationNotation: offsetVoiceTupletOptions },
  2,
);
const offsetVoiceReload = parseSlashScore(offsetVoiceOutput, {
  ...offsetVoiceTupletOptions,
  annotations: notationAnnotationsFromScore(offsetVoiceTupletScore),
}).score;
const offsetV2TupletPositions = offsetVoiceTupletScore.parts[1].measures[0].entries
  .filter((entry): entry is Chord => entry instanceof Chord
    && entry.notes.some((note) => note.tuplet !== null))
  .map((entry) => entry.position.toString()).join(",");
check(offsetV2TupletPositions === "1/6,1/3,1/2"
  && (offsetVoiceOutput.match(/\[/g) ?? []).length === 1
  && JSON.stringify(attackSignature(offsetVoiceReload))
    === JSON.stringify(attackSignature(offsetVoiceTupletScore)),
`offset overlapping tuplets did not align inside one longest bracket:\n${offsetVoiceOutput}\n${JSON.stringify({
  v2: offsetV2TupletPositions,
  before: attackSignature(offsetVoiceTupletScore),
  after: attackSignature(offsetVoiceReload),
})}`);

// Exact reported overlap: V belongs to the default/second TXT voice while W
// belongs to V1.  Creating a longer Tuplet on V must merge the already
// existing W Tuplet into one visible longest bracket, not emit `][` or move
// either voice on reload.
const reportedOverlapSource = `键盘谱
4/4拍：
点=16分音符
(V${SLASH_VOICE_SEPARATOR}G).${SLASH_VOICE_SEPARATOR}W.N.(G${SLASH_VOICE_SEPARATOR}W)./..../..../..../
`;
const reportedOverlapOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(reportedOverlapSource)),
  voiceCount: 2,
  symbolDurations: { ".": 16 },
  noteDivision: null,
  bracketMode: "triplet",
  showExplicitRests: true,
};
const reportedOverlapScore = parseSlashScore(reportedOverlapSource, reportedOverlapOptions).score;
const reportedW = reportedOverlapScore.parts[0].measures[0].entries.find(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest
    && !entry.generatedTimingContinuation && entry.position.equals(new Fraction(1, 4)),
);
const reportedV = reportedOverlapScore.parts[1].measures[0].entries.find(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest
    && !entry.generatedTimingContinuation && entry.position.equals(new Fraction(0)),
);
check(reportedW !== undefined && reportedV !== undefined,
  "reported overlapping-triplet fixture did not preserve the V/W voice attacks");
// The reported starting state already has W as a written sixteenth inside
// its shorter Tuplet.  The plain fixture's independent-voice sustain would
// otherwise normalize W to an eighth before we create that first group.
reportedW!.duration = new Fraction(1, 4);
reportedW!.beats = 1;
reportedW!.beams = 2;
reportedW!.dot = 0;
reportedW!.timingOriginal = null;
reportedW!.measure.entries = reportedW!.measure.entries.filter((entry) =>
  !(entry instanceof Chord
    && (entry.generatedTimingContinuation || entry.transparentContinuation
      || entry.notes.some((note) => note.tieEnd))
    && entry.position.compareTo(reportedW!.position) > 0
    && entry.notes.some((note) => note.pitch === reportedW!.notes[0]?.pitch)));
const reportedWTriplet = createInputTriplet(
  reportedOverlapScore,
  { partIndex: 0, measureIndex: 0, offset: reportedW!.position },
  new Fraction(1, 4),
);
check(reportedWTriplet.changed, "could not create the shorter V1 W triplet");
check(resizeInputTupletMember(
  reportedOverlapScore,
  reportedW!.notes.find((note) => !note.rest)!,
  new Fraction(1, 12),
).changed, "could not combine the first two W triplet cells into its reported written-sixteenth value");
check(createInputTriplet(
  reportedOverlapScore,
  { partIndex: 1, measureIndex: 0, offset: reportedV!.position },
  new Fraction(1, 2),
).changed, "could not create the overlapping default-voice V triplet");
const reportedOverlapAnnotations = notationAnnotationsFromScore(reportedOverlapScore);
const reportedOverlapOutput = scoreToSlashScore(
  reportedOverlapScore,
  "keyboard",
  16,
  ".",
  { bracketMode: "triplet", showExplicitRests: true, durationNotation: reportedOverlapOptions },
  2,
);
const reportedOverlapReload = parseSlashScore(reportedOverlapOutput, {
  ...reportedOverlapOptions,
  annotations: reportedOverlapAnnotations,
});
check((reportedOverlapOutput.match(/\[/g) ?? []).length === 1
  && !reportedOverlapOutput.includes("][")
  && reportedOverlapReload.summary.diagnostics.every((item) => item.severity !== "error")
  && JSON.stringify(attackSignature(reportedOverlapReload.score))
    === JSON.stringify(attackSignature(reportedOverlapScore)),
`the V/W overlap did not serialize as one stable longest triplet bracket:\n${reportedOverlapOutput}\n${JSON.stringify({
  before: attackSignature(reportedOverlapScore),
  after: attackSignature(reportedOverlapReload.score),
  diagnostics: reportedOverlapReload.summary.diagnostics,
  annotations: reportedOverlapAnnotations,
  entries: reportedOverlapReload.score.parts.map((part) => part.measures[0].entries.flatMap((entry) =>
    entry instanceof Chord ? [{
      at: entry.position.toString(), duration: entry.duration?.toString(), rest: entry.rest,
      pitches: entry.notes.map((note) => note.pitch), tuple: entry.notes.some((note) => note.tuplet !== null),
      continuation: entry.generatedTimingContinuation || entry.transparentContinuation,
      tieEnd: entry.notes.some((note) => note.tieEnd),
    }] : [])),
})}`);

const exactReportedOverlapText = `键盘谱
4/4拍：
点=16分音符
(V${SLASH_VOICE_SEPARATOR}G).[${SLASH_VOICE_SEPARATOR}W.${SLASH_VOICE_SEPARATOR}0].N.(G${SLASH_VOICE_SEPARATOR}W)./..../..../..../
`;
const exactReportedOverlapOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(exactReportedOverlapText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 },
  noteDivision: null,
  bracketMode: "triplet",
  showExplicitRests: true,
  annotations: [{
    type: "triplet", part: 0, voice: 1, measure: 0, offset: 0.25,
    scope: "voice", end: 0.5, members: [0.25, 0.125], restoreUnit: 0.25,
  }],
};
const exactReportedOverlapScore = parseSlashScore(
  exactReportedOverlapText,
  exactReportedOverlapOptions,
).score;
const exactReportedV = exactReportedOverlapScore.parts[1].measures[0].entries.find(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest
    && entry.position.equals(new Fraction(0))
    && entry.notes.some((note) => note.pitch === 53),
);
const exactReportedVSourceDuration = exactReportedV?.duration;
const exactReportedBefore = attackSignature(exactReportedOverlapScore);
const exactReportedCreated = exactReportedV && createInputTriplet(
  exactReportedOverlapScore,
  { partIndex: 1, measureIndex: 0, offset: new Fraction(0) },
  new Fraction(1, 2),
);
const exactReportedOutput = scoreToSlashScore(
  exactReportedOverlapScore,
  "keyboard",
  16,
  ".",
  { bracketMode: "triplet", showExplicitRests: true, durationNotation: exactReportedOverlapOptions },
  2,
);
const exactAnnotations = notationAnnotationsFromScore(exactReportedOverlapScore);
const exactReportedReload = parseSlashScore(exactReportedOutput, {
  ...exactReportedOverlapOptions,
  annotations: exactAnnotations,
});
const exactReportedCompact = exactReportedOutput.split(SLASH_VOICE_SEPARATOR).join("");
const exactBracketBody = /\[([^\]]*)\]/.exec(exactReportedCompact)?.[1] ?? "";
const exactReloadTuplets = new Set(exactReportedReload.score.parts.flatMap((part) =>
  part.measures.flatMap((measure) => measure.entries.flatMap((entry) =>
    entry instanceof Chord
      ? entry.notes.flatMap((note) => note.tuplet ? [note.tuplet] : [])
      : []))));
const exactLongTuplet = [...exactReloadTuplets].find((tuplet) => tuplet.partIndex === 1);
check(exactReportedVSourceDuration?.equals(new Fraction(1, 2))
  && exactReportedV?.duration?.equals(new Fraction(1, 6))
  && exactReportedCreated?.changed
  && (exactReportedOutput.match(/\[/g) ?? []).length === 1
  && (exactBracketBody.match(/0/g) ?? []).length === 1
  && exactReportedCompact.includes("[(VG).W.0]N.(GW).")
  && exactReloadTuplets.size === 2
  && exactLongTuplet?.actualEnd?.equals(new Fraction(1, 2))
  && exactLongTuplet.memberChords().length === 3
  && exactReportedReload.summary.diagnostics.every((item) => item.severity !== "error")
  && JSON.stringify(attackSignature(exactReportedReload.score)) === JSON.stringify(exactReportedBefore),
`the exact (VG).[W.0].N.(GW) overlap did not collapse to one compact three-atom bracket:\n${exactReportedOutput}\n${JSON.stringify({
  before: exactReportedBefore,
  after: attackSignature(exactReportedReload.score),
  diagnostics: exactReportedReload.summary.diagnostics,
  annotations: exactAnnotations,
})}`);

// A triplet whose every atom carries the explicit-default (V2) sentinel is
// voice-local even before @jpeditor metadata has been saved. Filling one of
// its rests used to make splitTimedEventsByVoice search for that pitch a
// second time in the ordinary event stream; it consumed a later pitch and
// shifted or erased the complete marked V1 line. Moving/resizing V triggered
// the same corruption on the following TXT save/reload.
const isolatedDefaultTupletText = `键盘谱
4/4拍：
点=16分音符
[${SLASH_VOICE_SEPARATOR}${SLASH_VOICE_SEPARATOR}V.${SLASH_VOICE_SEPARATOR}${SLASH_VOICE_SEPARATOR}0.${SLASH_VOICE_SEPARATOR}${SLASH_VOICE_SEPARATOR}0.]${SLASH_VOICE_SEPARATOR}G.${SLASH_VOICE_SEPARATOR}W\\.N.{G${SLASH_VOICE_SEPARATOR}W}./.{A${SLASH_VOICE_SEPARATOR}W}.N.${SLASH_VOICE_SEPARATOR}W./{BG}.${SLASH_VOICE_SEPARATOR}Q.N.{G${SLASH_VOICE_SEPARATOR}J}./.{A${SLASH_VOICE_SEPARATOR}Q}.N.${SLASH_VOICE_SEPARATOR}W./
`;
const isolatedDefaultTupletOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(isolatedDefaultTupletText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 },
  noteDivision: null,
  showExplicitRests: true,
  braceMode: "arpeggio",
  bracketMode: "triplet",
};
const isolatedTupletSignature = (score: ReturnType<typeof parseSlashScore>["score"]): string =>
  JSON.stringify(score.parts.map((part, partIndex) => part.measures.flatMap((measure) =>
    measure.entries.flatMap((entry) => entry instanceof Chord ? [{
      partIndex,
      measure: measure.index,
      at: entry.position.toString(),
      duration: entry.duration?.toString() ?? null,
      rest: entry.rest,
      pitches: entry.notes.filter((note) => !note.rest).map((note) => note.pitch)
        .sort((left, right) => left - right),
      tuplet: entry.notes.some((note) => note.tuplet !== null),
      generated: entry.generatedTimingContinuation,
      transparent: entry.transparentContinuation,
      tieStart: entry.notes.some((note) => note.tieStart),
      tieEnd: entry.notes.some((note) => note.tieEnd),
      arpeggio: entry.arpeggio,
    }] : []))));
const isolatedFirstVoiceSignature = (score: ReturnType<typeof parseSlashScore>["score"]): string =>
  JSON.stringify(score.parts[0]?.measures.flatMap((measure) => measure.entries.flatMap((entry) =>
    entry instanceof Chord ? [{
      at: entry.position.toString(),
      duration: entry.duration?.toString() ?? null,
      rest: entry.rest,
      pitches: entry.notes.filter((note) => !note.rest).map((note) => note.pitch)
        .sort((left, right) => left - right),
      generated: entry.generatedTimingContinuation,
      transparent: entry.transparentContinuation,
      tieStart: entry.notes.some((note) => note.tieStart),
      tieEnd: entry.notes.some((note) => note.tieEnd),
      arpeggio: entry.arpeggio,
    }] : [])) ?? []);
const isolatedDefaultTupletSource = parseSlashScore(
  isolatedDefaultTupletText,
  isolatedDefaultTupletOptions,
).score;
const isolatedSourceV1 = isolatedFirstVoiceSignature(isolatedDefaultTupletSource);
const isolatedSourceAnnotations = notationAnnotationsFromScore(isolatedDefaultTupletSource);
check(isolatedSourceAnnotations.some((annotation) => annotation.type === "triplet"
  && annotation.part === 1 && annotation.voice === 2 && annotation.scope === "voice"),
"an explicitly V2-marked triplet was inferred as an all-voice container");

const filledDefaultTupletText = isolatedDefaultTupletText.replace(
  `${SLASH_VOICE_SEPARATOR}${SLASH_VOICE_SEPARATOR}0.`,
  `${SLASH_VOICE_SEPARATOR}${SLASH_VOICE_SEPARATOR}A.`,
);
const filledDefaultTupletDirect = parseSlashScore(filledDefaultTupletText, {
  ...isolatedDefaultTupletOptions,
  annotations: isolatedSourceAnnotations,
});
const filledDirectMembers = filledDefaultTupletDirect.score.parts[1]?.measures[0]?.entries
  .filter((entry): entry is Chord => entry instanceof Chord
    && entry.notes.some((note) => note.tuplet !== null))
  .sort((left, right) => left.position.compareTo(right.position)) ?? [];
check(filledDefaultTupletDirect.summary.diagnostics.every((item) => item.severity !== "error")
  && isolatedFirstVoiceSignature(filledDefaultTupletDirect.score) === isolatedSourceV1
  && filledDirectMembers.length === 3
  && filledDirectMembers[0]?.notes.some((note) => note.pitch === 53)
  && filledDirectMembers[1]?.notes.some((note) => note.pitch === 60)
  && filledDirectMembers[2]?.rest,
`filling the explicit V2 triplet directly reassigned or shifted V1:
${filledDefaultTupletText}
${isolatedTupletSignature(filledDefaultTupletDirect.score)}`);

// Consumption is limited to pitches physically inside the Tuplet delimiter.
// An equal ordinary pitch earlier in the same voice must not be mistaken for
// the Tuplet member merely because it appears first in the source stream.
const precedingEqualTupletText = `键盘谱
4/4拍：
点=16分音符
A.[${SLASH_VOICE_SEPARATOR}${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}${SLASH_VOICE_SEPARATOR}0.${SLASH_VOICE_SEPARATOR}${SLASH_VOICE_SEPARATOR}0.]${SLASH_VOICE_SEPARATOR}G.../..../..../..../
`;
const precedingEqualTuplet = parseSlashScore(
  precedingEqualTupletText,
  { ...isolatedDefaultTupletOptions, annotations: [] },
);
const precedingEqualDefaultAttacks = precedingEqualTuplet.score.parts[1]?.measures[0]?.entries
  .filter((entry): entry is Chord => entry instanceof Chord && !entry.rest
    && !entry.generatedTimingContinuation && !entry.transparentContinuation)
  .sort((left, right) => left.position.compareTo(right.position)) ?? [];
check(precedingEqualTuplet.summary.diagnostics.every((item) => item.severity !== "error")
  && precedingEqualDefaultAttacks.length >= 2
  && precedingEqualDefaultAttacks[0]?.position.equals(new Fraction(0))
  && precedingEqualDefaultAttacks[0]?.notes.every((note) => note.tuplet === null)
  && precedingEqualDefaultAttacks[1]?.position.equals(new Fraction(1, 4))
  && precedingEqualDefaultAttacks[1]?.notes.some((note) => note.tuplet !== null),
`a same-pitch attack before a V2 triplet was consumed as its member:
${isolatedTupletSignature(precedingEqualTuplet.score)}`);

const checkIsolatedTupletRoundTrip = (
  label: string,
  score: ReturnType<typeof parseSlashScore>["score"],
): void => {
  const before = isolatedTupletSignature(score);
  const text = scoreToSlashScore(
    score,
    "keyboard",
    16,
    ".",
    {
      braceMode: "arpeggio",
      bracketMode: "triplet",
      barMode: "none",
      angleMode: "grace",
      parenMode: "chord",
      showExplicitRests: true,
      durationNotation: isolatedDefaultTupletOptions,
    },
    2,
  );
  const reloaded = parseSlashScore(text, {
    ...isolatedDefaultTupletOptions,
    annotations: notationAnnotationsFromScore(score),
  });
  check(reloaded.summary.diagnostics.every((item) => item.severity !== "error")
    && isolatedTupletSignature(reloaded.score) === before,
  `${label} changed another voice during TXT save/reload:
${text}
${JSON.stringify(reloaded.summary.diagnostics)}
before=${before}
after=${isolatedTupletSignature(reloaded.score)}`);
};

const typedDefaultTupletScore = parseSlashScore(
  isolatedDefaultTupletText,
  isolatedDefaultTupletOptions,
).score;
const typedDefaultTuplet = inputNoteAtCursor(
  typedDefaultTupletScore,
  { partIndex: 1, measureIndex: 0, offset: new Fraction(1, 6), division: 16 },
  { pitch: 60, number: "1" },
);
check(typedDefaultTuplet.note?.tuplet !== null,
  "the second explicit V2 triplet cell could not be filled");
checkIsolatedTupletRoundTrip("filling the second V2 triplet member", typedDefaultTupletScore);

const movedDefaultTupletScore = parseSlashScore(
  isolatedDefaultTupletText,
  isolatedDefaultTupletOptions,
).score;
const movedDefaultV = movedDefaultTupletScore.parts[1]?.measures[0]?.entries.find(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest
    && entry.position.equals(new Fraction(0)),
)?.notes.find((note) => !note.rest);
const movedDefaultResult = movedDefaultV ? moveInputTieChainByNotationDomain(
  movedDefaultTupletScore,
  1,
  movedDefaultV,
  new Fraction(1, 4),
  1,
) : null;
check(movedDefaultResult?.changed, "the first explicit V2 triplet member could not move right");
checkIsolatedTupletRoundTrip("moving the first V2 triplet member", movedDefaultTupletScore);

const resizedDefaultTupletScore = parseSlashScore(
  isolatedDefaultTupletText,
  isolatedDefaultTupletOptions,
).score;
const resizedDefaultV = resizedDefaultTupletScore.parts[1]?.measures[0]?.entries.find(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest
    && entry.position.equals(new Fraction(0)),
)?.notes.find((note) => !note.rest);
const resizedDefaultResult = resizedDefaultV
  ? resizeInputTupletMember(resizedDefaultTupletScore, resizedDefaultV, new Fraction(1, 6))
  : null;
check(resizedDefaultResult?.changed, "the first explicit V2 triplet member could not extend");
checkIsolatedTupletRoundTrip("resizing the first V2 triplet member", resizedDefaultTupletScore);

// Filling the reported third V2 member must keep the fixed 3:2 cell, merge
// the ordinary V1 attacks by their real onset inside the one visible bracket,
// and leave the silent V2 boundary silent. The old exporter emitted
// `[A.D.A..]...0`; on reload that both shortened the beat to 0.833 and turned
// the boundary rest into another A attack.
const thirdMemberTupletText = `键盘谱
4/4拍：
点=16分音符
[${SLASH_VOICE_SEPARATOR}${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}${SLASH_VOICE_SEPARATOR}D.${SLASH_VOICE_SEPARATOR}${SLASH_VOICE_SEPARATOR}0.]${SLASH_VOICE_SEPARATOR}G.${SLASH_VOICE_SEPARATOR}W\\..{G${SLASH_VOICE_SEPARATOR}W}./.{A${SLASH_VOICE_SEPARATOR}W}.N.${SLASH_VOICE_SEPARATOR}W./{BG}.${SLASH_VOICE_SEPARATOR}Q.N.{G${SLASH_VOICE_SEPARATOR}J}./.{A${SLASH_VOICE_SEPARATOR}Q}.N.${SLASH_VOICE_SEPARATOR}W./
`;
const thirdMemberTupletOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(thirdMemberTupletText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 },
  noteDivision: null,
  showExplicitRests: true,
  braceMode: "arpeggio",
  bracketMode: "triplet",
  parenMode: "chord",
};
const tripletTimingSignature = (score: ReturnType<typeof parseSlashScore>["score"]): string =>
  JSON.stringify(score.parts.map((part, partIndex) => part.measures.flatMap((measure) =>
    measure.entries.flatMap((entry) => entry instanceof Chord ? [{
      partIndex,
      measure: measure.index,
      at: entry.position.toString(),
      duration: entry.duration?.toString() ?? null,
      rest: entry.rest,
      pitches: entry.notes.filter((note) => !note.rest).map((note) => note.pitch)
        .sort((left, right) => left - right),
      tuplet: entry.notes.some((note) => note.tuplet !== null),
      arpeggio: entry.arpeggio,
    }] : []))));
const thirdMemberTupletScore = parseSlashScore(
  thirdMemberTupletText,
  thirdMemberTupletOptions,
).score;
const thirdMemberInput = inputNoteAtCursor(
  thirdMemberTupletScore,
  { partIndex: 1, measureIndex: 0, offset: new Fraction(1, 3), division: 16 },
  { pitch: 60, number: "1" },
  new Fraction(1, 4),
);
completeInputMeasure(thirdMemberTupletScore, { partIndex: 1, measureIndex: 0 }, true);
const thirdMemberSignature = tripletTimingSignature(thirdMemberTupletScore);
const thirdMemberOutput = scoreToSlashScore(
  thirdMemberTupletScore,
  "keyboard",
  16,
  ".",
  {
    braceMode: "arpeggio",
    bracketMode: "triplet",
    barMode: "none",
    angleMode: "grace",
    parenMode: "chord",
    showExplicitRests: true,
    durationNotation: thirdMemberTupletOptions,
  },
  2,
);
const thirdMemberCompact = thirdMemberOutput.split(SLASH_VOICE_SEPARATOR).join("");
const thirdMemberReload = parseSlashScore(thirdMemberOutput, {
  ...thirdMemberTupletOptions,
  annotations: notationAnnotationsFromScore(thirdMemberTupletScore),
});
check(thirdMemberInput.changed
  && thirdMemberInput.fixedTupletCell
  && thirdMemberInput.note?.tuplet !== null
  && thirdMemberCompact.includes("[(AG).D.WA.]")
  && thirdMemberCompact.includes("(GW)")
  && !thirdMemberCompact.includes("{GW}")
  && !thirdMemberCompact.includes("A..]")
  && !thirdMemberCompact.includes("]..0")
  && thirdMemberReload.summary.diagnostics.every((item) => item.severity !== "error")
  && tripletTimingSignature(thirdMemberReload.score) === thirdMemberSignature,
`filling the third V2 triplet member changed its duration, voice, boundary rest, or chord delimiter:
${thirdMemberOutput}
${JSON.stringify(thirdMemberReload.summary.diagnostics)}
before=${thirdMemberSignature}
after=${tripletTimingSignature(thirdMemberReload.score)}`);

// With a full-beat Tuplet, ordinary attacks at normalized 0.5 and 0.75 are
// sorted between/after the compressed 1/3 and 2/3 members. They are visual
// occupants of the shared bracket only; the V2 Tuplet still ends at beat 1
// and V1 keeps its independent binary durations after reload.
const orderedParallelTupletText = `键盘谱
4/4拍：
点=16分音符
[${SLASH_VOICE_SEPARATOR}${SLASH_VOICE_SEPARATOR}A..${SLASH_VOICE_SEPARATOR}${SLASH_VOICE_SEPARATOR}D..${SLASH_VOICE_SEPARATOR}${SLASH_VOICE_SEPARATOR}0..]${SLASH_VOICE_SEPARATOR}G..${SLASH_VOICE_SEPARATOR}W../..../..../..../
`;
const orderedParallelTupletOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(orderedParallelTupletText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 },
  noteDivision: null,
  showExplicitRests: true,
  braceMode: "arpeggio",
  bracketMode: "triplet",
  parenMode: "chord",
};
const orderedParallelTupletScore = parseSlashScore(
  orderedParallelTupletText,
  orderedParallelTupletOptions,
).score;
check(inputNoteAtCursor(
  orderedParallelTupletScore,
  { partIndex: 1, measureIndex: 0, offset: new Fraction(2, 3), division: 16 },
  { pitch: 60, number: "1" },
  new Fraction(1, 2),
).changed, "the full-beat Tuplet's third member could not be filled");
const orderedParallelAttack = inputNoteAtCursor(
  orderedParallelTupletScore,
  { partIndex: 0, measureIndex: 0, offset: new Fraction(3, 4), division: 16 },
  { pitch: 62, number: "2" },
  new Fraction(1, 4),
);
completeInputMeasure(orderedParallelTupletScore, { partIndex: 1, measureIndex: 0 }, true);
completeInputMeasure(orderedParallelTupletScore, { partIndex: 0, measureIndex: 0 }, true);
const firstBeatSignature = (score: ReturnType<typeof parseSlashScore>["score"]): string =>
  JSON.stringify(score.parts.map((part) => part.measures[0].entries.flatMap((entry) =>
    entry instanceof Chord && entry.position.compareTo(new Fraction(1)) < 0 ? [{
      at: entry.position.toString(),
      duration: entry.duration?.toString() ?? null,
      rest: entry.rest,
      pitches: entry.notes.filter((note) => !note.rest).map((note) => note.pitch)
        .sort((left, right) => left - right),
      tuplet: entry.notes.some((note) => note.tuplet !== null),
      arpeggio: entry.arpeggio,
    }] : [])));
const orderedParallelBefore = firstBeatSignature(orderedParallelTupletScore);
const orderedParallelTuplet = orderedParallelTupletScore.parts[1].measures[0].entries
  .flatMap((entry) => entry instanceof Chord
    ? entry.notes.flatMap((note) => note.tuplet ? [note.tuplet] : [])
    : [])[0] ?? null;
const orderedParallelOutput = scoreToSlashScore(
  orderedParallelTupletScore,
  "keyboard",
  16,
  ".",
  {
    braceMode: "arpeggio",
    bracketMode: "triplet",
    barMode: "none",
    angleMode: "grace",
    parenMode: "chord",
    showExplicitRests: true,
    durationNotation: orderedParallelTupletOptions,
  },
  2,
);
const orderedParallelCompact = orderedParallelOutput.split(SLASH_VOICE_SEPARATOR).join("");
const orderedParallelReload = parseSlashScore(orderedParallelOutput, {
  ...orderedParallelTupletOptions,
  annotations: notationAnnotationsFromScore(orderedParallelTupletScore),
});
const orderedParallelReloadTuplet = orderedParallelReload.score.parts[1].measures[0].entries
  .flatMap((entry) => entry instanceof Chord
    ? entry.notes.flatMap((note) => note.tuplet ? [note.tuplet] : [])
    : [])[0] ?? null;
check(orderedParallelAttack.changed
  && orderedParallelCompact.includes("[(AG)..D..WA..S]")
  && (orderedParallelCompact.match(/\[/g) ?? []).length === 1
  && !orderedParallelCompact.includes("][")
  && orderedParallelTuplet?.actualStart?.equals(new Fraction(0))
  && orderedParallelTuplet.actualEnd?.equals(new Fraction(1))
  && orderedParallelReloadTuplet?.actualStart?.equals(new Fraction(0))
  && orderedParallelReloadTuplet.actualEnd?.equals(new Fraction(1))
  && orderedParallelReload.summary.diagnostics.every((item) => item.severity !== "error")
  && firstBeatSignature(orderedParallelReload.score) === orderedParallelBefore,
`parallel attacks at 0.5/0.75 were not ordered inside one duration-stable Tuplet bracket:
${orderedParallelOutput}
${JSON.stringify(orderedParallelReload.summary.diagnostics)}
before=${orderedParallelBefore}
after=${firstBeatSignature(orderedParallelReload.score)}`);

// Creating a V1 triplet in the first beat must not replace an unrelated V1
// tie continuation later in the same measure with an explicit 0 rest.
const sustainedAfterTripletText = `键盘谱\n4/4拍：\n点=16分音符\n(N${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G).${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N.(${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G)./..../..../..../\n`;
const sustainedAfterTripletOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(sustainedAfterTripletText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 as const },
};
const sustainedAfterTripletScore = parseSlashScore(
  sustainedAfterTripletText,
  sustainedAfterTripletOptions,
).score;
check(createInputTriplet(
  sustainedAfterTripletScore,
  { partIndex: 0, measureIndex: 0, offset: new Fraction(0) },
  new Fraction(1, 4),
).changed, "voiced TXT triplet regression fixture could not create a triplet");
const sustainedAfterTripletAnnotations = notationAnnotationsFromScore(sustainedAfterTripletScore);
const sustainedAfterTripletOutput = scoreToSlashScore(
  sustainedAfterTripletScore,
  "keyboard",
  16,
  ".",
  {
    braceMode: "arpeggio",
    bracketMode: "triplet",
    barMode: "grace",
    angleMode: "subdivide",
    parenMode: "chord",
    durationNotation: sustainedAfterTripletOptions,
  },
  2,
);
const sustainedAfterTripletRoundTrip = parseSlashScore(
  sustainedAfterTripletOutput,
  { ...sustainedAfterTripletOptions, annotations: sustainedAfterTripletAnnotations },
).score;
check(sustainedAfterTripletRoundTrip.parts[0].measures[0].entries.some((entry) =>
  entry instanceof Chord && !entry.rest && entry.generatedTimingContinuation
    && entry.position.equals(new Fraction(1)))
  && !sustainedAfterTripletRoundTrip.parts[0].measures[0].entries.some((entry) =>
    entry instanceof Chord && entry.rest && entry.position.equals(new Fraction(1))),
"creating one TXT triplet replaced another note's later continuation with a rest");

// Creating the reported finest-grid triplet in the second beat must rewrite
// only that beat.  The selected 16th-note span is divided into three compact
// 32nd-triplet members (`[AN0]`); it must never append a duplicate copy of the
// surrounding four-beat row.
const compactCursorTripletText = `键盘谱
4/4拍：
点=16分音符
(V${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G).${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N.(${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G)./.${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N.${SLASH_VOICE_SEPARATOR}A./(B${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G).${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N.(${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G)./.${SLASH_VOICE_SEPARATOR}N.${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N./
`;
const compactCursorTripletOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(compactCursorTripletText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 },
  noteDivision: null,
  bracketMode: "triplet",
};
const compactCursorTripletScore = parseSlashScore(
  compactCursorTripletText,
  compactCursorTripletOptions,
).score;
const compactCursorTripletTarget = compactCursorTripletScore.parts[0].measures[0].entries.find(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest
    && entry.position.equals(new Fraction(5, 4)),
);
check(compactCursorTripletTarget !== undefined, "reported second-beat A was not parsed at 1.25 quarter notes");
const compactCursorTripletCreated = createInputTriplet(
  compactCursorTripletScore,
  { partIndex: 0, measureIndex: 0, offset: compactCursorTripletTarget.position },
  new Fraction(1, 8),
  new Fraction(1, 4),
);
check(compactCursorTripletCreated.changed, "reported finest-grid triplet could not be created");
const compactCursorTuplet = compactCursorTripletCreated.chords[0]?.notes[0]?.tuplet ?? null;
const compactFollowingAttack = compactCursorTripletScore.parts[0].measures[0].entries.find(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest
    && entry.position.equals(new Fraction(3, 2)),
);
check(compactCursorTripletCreated.chords.map((chord) => chord.position.toString()).join(",")
    === "5/4,4/3,17/12"
  && compactCursorTripletCreated.chords.every((chord) => chord.duration?.equals(new Fraction(1, 12)))
  && compactCursorTuplet?.writtenUnit?.equals(new Fraction(1, 8))
  && compactCursorTuplet.actualStart?.equals(new Fraction(5, 4))
  && compactCursorTuplet.actualEnd?.equals(new Fraction(3, 2))
  && compactFollowingAttack?.duration?.equals(new Fraction(1, 4))
  && compactFollowingAttack.notes.every((note) => note.tuplet === null),
"the compact 16-to-32 triplet did not keep one coherent inner domain or preserve the following attack");
const compactCursorTripletOutput = scoreToSlashScore(
  compactCursorTripletScore,
  "keyboard",
  16,
  ".",
  {
    braceMode: "arpeggio",
    bracketMode: "triplet",
    barMode: "grace",
    angleMode: "none",
    parenMode: "chord",
    durationNotation: compactCursorTripletOptions,
  },
  2,
);
const compactCursorTripletRows = compactCursorTripletOutput.split(/\r?\n/)
  .filter((line) => !line.trim().startsWith("//") && /\/$/.test(line.trim()));
check(compactCursorTripletRows.length === 1
  && (compactCursorTripletRows[0].match(/\[/g)?.length ?? 0) === 1
  && compactCursorTripletRows[0].split("/").length - 1 === 4,
`creating one compact triplet duplicated the surrounding score row:\n${compactCursorTripletOutput}`);
check(compactCursorTripletRows[0].split(SLASH_VOICE_SEPARATOR).join("").includes(".[A00].N.A."),
  `the selected 16th note did not serialize as [A00] while keeping N/A outside:\n${compactCursorTripletOutput}`);
const compactCursorTripletRewritten = replaceSlashScoreLines(
  compactCursorTripletText,
  compactCursorTripletOutput,
  "keyboard",
);
const compactCursorTripletRewrittenRows = compactCursorTripletRewritten.split(/\r?\n/)
  .filter((line) => !line.trim().startsWith("//") && /\/$/.test(line.trim()));
const compactCursorTripletReloaded = parseSlashScore(
  compactCursorTripletRewritten,
  {
    ...compactCursorTripletOptions,
    annotations: notationAnnotationsFromScore(compactCursorTripletScore),
  },
);
check(compactCursorTripletRewrittenRows.length === 1
  && (compactCursorTripletRewrittenRows[0].match(/\[/g)?.length ?? 0) === 1
  && compactCursorTripletReloaded.summary.diagnostics.every((item) => item.severity !== "error")
  && JSON.stringify(attackSignature(compactCursorTripletReloaded.score))
    === JSON.stringify(attackSignature(compactCursorTripletScore)),
`the compact cursor triplet duplicated or changed after the editor write-back:\n${compactCursorTripletRewritten}\n${JSON.stringify({
  diagnostics: compactCursorTripletReloaded.summary.diagnostics,
  before: attackSignature(compactCursorTripletScore),
  after: attackSignature(compactCursorTripletReloaded.score),
  entries: compactCursorTripletReloaded.score.parts[0].measures[0].entries.flatMap((entry) =>
    entry instanceof Chord ? [{
      at: entry.position.toString(),
      duration: entry.duration?.toString(),
      rest: entry.rest,
      transparent: entry.transparentContinuation,
      generated: entry.generatedTimingContinuation,
      notes: entry.notes.map((note) => ({
        pitch: note.pitch,
        rest: note.rest,
        tieEnd: note.tieEnd,
        tiePrev: note.tiePrev?.chord.position.toString() ?? null,
        tuplet: note.tuplet !== null,
      })),
    }] : []),
})}`);

// When note/chord atoms own duration, every slash segment can represent a
// whole measure. Creating a triplet must retain that structural mode instead
// of rewriting one measure as four slash-delimited measures. A coarser
// triplet value must also be rejected before it can squeeze finer attacks to
// zero-duration rests.
const wholeMeasureTripletText = `键盘谱
4/4拍：
点=16分音符
音符自身时值=16分音符
(V${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G).${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N.(${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G)./.${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N.${SLASH_VOICE_SEPARATOR}A./(B${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G).${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N.(${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G)./.${SLASH_VOICE_SEPARATOR}N.${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N./
`;
const wholeMeasureTripletAnalysis = analyzeSlashScore(wholeMeasureTripletText);
const wholeMeasureTripletOptions = {
  ...defaultSlashScoreOptions("keyboard", wholeMeasureTripletAnalysis),
  voiceCount: 2,
  symbolDurations: { ".": 16 as const },
  noteDivision: 16 as const,
};
check(wholeMeasureTripletOptions.wholeMeasureGroups
  && wholeMeasureTripletAnalysis.measureCount === 4,
"intrinsic-duration fixture was not recognized as four slash-delimited measures");
const coarseWholeTripletScore = parseSlashScore(
  wholeMeasureTripletText,
  wholeMeasureTripletOptions,
).score;
const coarseWholeTripletBefore = attackSignature(coarseWholeTripletScore);
const firstWholeMeasureAttack = coarseWholeTripletScore.parts[0].measures[0].entries.find(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest,
);
check(firstWholeMeasureAttack !== undefined, "intrinsic-duration triplet fixture has no V1 attack");
const currentValueTriplet = createInputTriplet(
  coarseWholeTripletScore,
  { partIndex: 0, measureIndex: 0, offset: firstWholeMeasureAttack!.position },
  new Fraction(1),
);
check(currentValueTriplet.changed
  && JSON.stringify(attackSignature(coarseWholeTripletScore))
    === JSON.stringify(coarseWholeTripletBefore),
"the global quarter selection changed or absorbed attacks after the current shorter note");

const wholeMeasureTripletScore = parseSlashScore(
  wholeMeasureTripletText,
  wholeMeasureTripletOptions,
).score;
const laterWholeMeasuresBefore = JSON.stringify(wholeMeasureTripletScore.parts.map((part) =>
  part.measures.slice(1).map((measure) => measure.entries.flatMap((entry) =>
    entry instanceof Chord ? [{
      at: entry.position.toString(),
      duration: entry.duration?.toString() ?? "0",
      rest: entry.rest,
      pitches: entry.notes.filter((note) => !note.rest).map((note) => note.pitch),
    }] : []))));
const matchingWholeAttack = wholeMeasureTripletScore.parts[0].measures[0].entries.find(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest,
)!;
check(createInputTriplet(
  wholeMeasureTripletScore,
  { partIndex: 0, measureIndex: 0, offset: matchingWholeAttack.position },
  new Fraction(1, 4),
).changed, "matching fine value could not create a triplet in whole-measure slash mode");
const wholeMeasureTripletAnnotations = notationAnnotationsFromScore(wholeMeasureTripletScore);
const wholeMeasureTripletOutput = scoreToSlashScore(
  wholeMeasureTripletScore,
  "keyboard",
  16,
  ".",
  { durationNotation: wholeMeasureTripletOptions },
  2,
);
const wholeMeasureTripletRows = wholeMeasureTripletOutput.split(/\r?\n/)
  .filter((line) => !line.trim().startsWith("//") && line.endsWith("/"));
const wholeMeasureTripletRoundTrip = parseSlashScore(
  wholeMeasureTripletOutput,
  { ...wholeMeasureTripletOptions, annotations: wholeMeasureTripletAnnotations },
).score;
const laterWholeMeasuresAfter = JSON.stringify(wholeMeasureTripletRoundTrip.parts.map((part) =>
  part.measures.slice(1).map((measure) => measure.entries.flatMap((entry) =>
    entry instanceof Chord ? [{
      at: entry.position.toString(),
      duration: entry.duration?.toString() ?? "0",
      rest: entry.rest,
      pitches: entry.notes.filter((note) => !note.rest).map((note) => note.pitch),
    }] : []))));
check(wholeMeasureTripletRows.length === 4
  && wholeMeasureTripletRows.every((line) => line.split("/").length - 1 === 1)
  && wholeMeasureTripletRoundTrip.parts.every((part) => part.measures.length === 4)
  && laterWholeMeasuresAfter === laterWholeMeasuresBefore,
"creating a TXT triplet replaced earlier/later whole-measure slash segments with rests");

// With intrinsic note values, a tuplet atom must only write the duration that
// remains after the note/chord/rest itself. The old serializer turned Q. into
// Q.. and also mistook Q's printed tie continuation for a second attack.
const intrinsicTripletText = `键盘谱
4/4拍：
点=16分音符
音符自身时值=16分音符
(V${SLASH_VOICE_SEPARATOR}G).${SLASH_VOICE_SEPARATOR}W\\.N.(G${SLASH_VOICE_SEPARATOR}W)./.(A${SLASH_VOICE_SEPARATOR}W).N.${SLASH_VOICE_SEPARATOR}W./(BG).${SLASH_VOICE_SEPARATOR}Q.N.(G${SLASH_VOICE_SEPARATOR}J)./.(A${SLASH_VOICE_SEPARATOR}Q).N.${SLASH_VOICE_SEPARATOR}J./
`;
const intrinsicTripletOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(intrinsicTripletText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 as const },
  noteDivision: null,
  wholeMeasureGroups: false,
  braceMode: "arpeggio" as const,
  bracketMode: "triplet" as const,
  barMode: "grace" as const,
  angleMode: "subdivide" as const,
  parenMode: "chord" as const,
};
for (const offset of [new Fraction(1, 4), new Fraction(3, 4), new Fraction(5, 4)]) {
  const positionedScore = parseSlashScore(intrinsicTripletText, intrinsicTripletOptions).score;
  const target = positionedScore.parts[0].measures[0].entries.find(
    (entry): entry is Chord => entry instanceof Chord && !entry.rest
      && entry.position.equals(offset)
      && !entry.generatedTimingContinuation
      && !entry.transparentContinuation
      && entry.notes.some((note) => !note.rest && !note.tieEnd),
  );
  const created = target ? createInputTriplet(
    positionedScore,
    { partIndex: 0, measureIndex: 0, offset: target.position },
    new Fraction(1, 2),
  ) : null;
  check(target !== undefined && created?.changed,
    `the W triplet fixture at ${offset.toString()} could not be created`);
  const positionedOutput = scoreToSlashScore(
    positionedScore,
    "keyboard",
    16,
    ".",
    {
      braceMode: "arpeggio",
      bracketMode: "triplet",
      barMode: "grace",
      angleMode: "subdivide",
      parenMode: "chord",
      durationNotation: intrinsicTripletOptions,
    },
    2,
  );
  const positionedRoundTrip = parseSlashScore(positionedOutput, {
    ...intrinsicTripletOptions,
    annotations: notationAnnotationsFromScore(positionedScore),
  });
  check(positionedRoundTrip.summary.diagnostics.every((item) => item.severity !== "error")
    && JSON.stringify(attackSignature(positionedRoundTrip.score))
      === JSON.stringify(attackSignature(positionedScore)),
  `a W triplet sharing its onset with another voice overfilled or shifted the beat at ${offset.toString()}:\n${positionedOutput}\n${JSON.stringify({
    diagnostics: positionedRoundTrip.summary.diagnostics,
    before: attackSignature(positionedScore),
    after: attackSignature(positionedRoundTrip.score),
  })}`);
}
// The final TXT voice is encoded by the absence of U+2063. Creating a Tuplet
// in that default voice must not pull a simultaneous marked V1 attack into the
// bracket or change V1's later onsets/durations.
const defaultVoiceTripletScore = parseSlashScore(
  intrinsicTripletText,
  intrinsicTripletOptions,
).score;
const markedVoiceBeforeDefaultTriplet = attackSignature(defaultVoiceTripletScore)[0];
const defaultVoiceTarget = defaultVoiceTripletScore.parts[1].measures[0].entries.find(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest
    && entry.position.equals(new Fraction(5, 4))
    && !entry.generatedTimingContinuation
    && !entry.transparentContinuation
    && entry.notes.some((note) => !note.rest && !note.tieEnd),
);
const defaultVoiceCreated = defaultVoiceTarget ? createInputTriplet(
  defaultVoiceTripletScore,
  { partIndex: 1, measureIndex: 0, offset: defaultVoiceTarget.position },
  new Fraction(1, 4),
) : null;
check(defaultVoiceTarget !== undefined && defaultVoiceCreated?.changed,
  `the unmarked default TXT voice could not create its voice-local triplet: ${JSON.stringify({
    reason: defaultVoiceCreated?.reason,
    entries: defaultVoiceTripletScore.parts[1].measures[0].entries.flatMap((entry) =>
      entry instanceof Chord ? [{ at: entry.position.toString(), rest: entry.rest,
        continuation: entry.generatedTimingContinuation || entry.transparentContinuation,
        pitches: entry.notes.map((note) => note.pitch) }] : []),
  })}`);
const defaultVoiceTripletOutput = scoreToSlashScore(
  defaultVoiceTripletScore,
  "keyboard",
  16,
  ".",
  {
    braceMode: "arpeggio",
    bracketMode: "triplet",
    barMode: "grace",
    angleMode: "subdivide",
    parenMode: "chord",
    durationNotation: intrinsicTripletOptions,
  },
  2,
);
const defaultVoiceTripletRoundTrip = parseSlashScore(defaultVoiceTripletOutput, {
  ...intrinsicTripletOptions,
  annotations: notationAnnotationsFromScore(defaultVoiceTripletScore),
});
check(defaultVoiceTripletRoundTrip.summary.diagnostics.every((item) => item.severity !== "error")
  && attackSignature(defaultVoiceTripletRoundTrip.score)[0] === markedVoiceBeforeDefaultTriplet
  && JSON.stringify(attackSignature(defaultVoiceTripletRoundTrip.score))
    === JSON.stringify(attackSignature(defaultVoiceTripletScore)),
`a default-voice triplet changed the marked parallel voice:\n${defaultVoiceTripletOutput}\n${JSON.stringify({
  escaped: JSON.stringify(defaultVoiceTripletOutput),
  annotations: notationAnnotationsFromScore(defaultVoiceTripletScore),
  diagnostics: defaultVoiceTripletRoundTrip.summary.diagnostics,
  before: attackSignature(defaultVoiceTripletScore),
  after: attackSignature(defaultVoiceTripletRoundTrip.score),
  entries: defaultVoiceTripletRoundTrip.score.parts.map((part) => part.measures[0].entries.flatMap((entry) =>
    entry instanceof Chord ? [{
      at: entry.position.toString(), duration: entry.duration?.toString(), rest: entry.rest,
      pitches: entry.notes.map((note) => note.pitch),
      tuple: entry.notes.some((note) => note.tuplet !== null),
      continuation: entry.generatedTimingContinuation || entry.transparentContinuation,
    }] : [])),
})}`);
const intrinsicTripletScore = parseSlashScore(
  intrinsicTripletText,
  intrinsicTripletOptions,
).score;
const intrinsicQ = intrinsicTripletScore.parts[0].measures[0].entries.find(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest
    && entry.position.compareTo(new Fraction(2)) >= 0
    && !entry.generatedTimingContinuation
    && !entry.transparentContinuation
    && entry.notes.some((note) => !note.rest && !note.tieEnd),
);
const intrinsicTripletCreation = intrinsicQ === undefined ? null : createInputTriplet(
  intrinsicTripletScore,
  { partIndex: 0, measureIndex: 0, offset: intrinsicQ.position },
  new Fraction(1, 2),
);
check(intrinsicQ !== undefined && intrinsicTripletCreation?.changed,
`the exact voiced Q eighth-note fixture could not create a triplet: ${JSON.stringify({
  reason: intrinsicTripletCreation?.reason,
  entries: intrinsicTripletScore.parts[0].measures[0].entries.flatMap((entry) =>
    entry instanceof Chord ? [{
      at: entry.position.toString(),
      duration: entry.duration?.toString(),
      rest: entry.rest,
      continuation: entry.generatedTimingContinuation || entry.transparentContinuation,
      tieEnd: entry.notes.some((note) => note.tieEnd),
      pitches: entry.notes.filter((note) => !note.rest).map((note) => note.pitch),
    }] : []),
})}`);
const intrinsicTripletOutput = scoreToSlashScore(
  intrinsicTripletScore,
  "keyboard",
  16,
  ".",
  {
    braceMode: "arpeggio",
    bracketMode: "triplet",
    barMode: "grace",
    angleMode: "subdivide",
    parenMode: "chord",
    durationNotation: intrinsicTripletOptions,
  },
  2,
);
const intrinsicTripletReparse = parseSlashScore(
  intrinsicTripletOutput,
  {
    ...intrinsicTripletOptions,
    annotations: notationAnnotationsFromScore(intrinsicTripletScore),
  },
);
check(intrinsicTripletOutput.includes("[")
  && intrinsicTripletReparse.summary.diagnostics.every((item) => item.severity !== "error")
  && JSON.stringify(attackSignature(intrinsicTripletReparse.score))
    === JSON.stringify(attackSignature(intrinsicTripletScore)),
`voiced eighth-note triplet duplicated a tied continuation or overfilled the beat:\n${intrinsicTripletOutput}\n${JSON.stringify({
  diagnostics: intrinsicTripletReparse.summary.diagnostics,
  before: attackSignature(intrinsicTripletScore),
  after: attackSignature(intrinsicTripletReparse.score),
})}`);

const intrinsicValueTripletText = `键盘谱
4/4拍：
点=16分音符
音符自身时值=16分音符
${SLASH_VOICE_SEPARATOR}Q.${SLASH_VOICE_SEPARATOR}J./..../..../..../
`;
const intrinsicValueTripletOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(intrinsicValueTripletText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 as const },
  noteDivision: 16 as const,
  wholeMeasureGroups: false,
  bracketMode: "triplet" as const,
};
const intrinsicValueTripletScore = parseSlashScore(
  intrinsicValueTripletText,
  intrinsicValueTripletOptions,
).score;
const intrinsicValueQ = intrinsicValueTripletScore.parts[0].measures[0].entries.find(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest
    && !entry.generatedTimingContinuation && !entry.transparentContinuation,
)!;
check(createInputTriplet(
  intrinsicValueTripletScore,
  { partIndex: 0, measureIndex: 0, offset: intrinsicValueQ.position },
  new Fraction(1, 2),
).changed, "an intrinsic eighth-note pair could not be converted to a triplet");
const intrinsicValueTripletOutput = scoreToSlashScore(
  intrinsicValueTripletScore,
  "keyboard",
  16,
  ".",
  {
    braceMode: "arpeggio",
    bracketMode: "triplet",
    barMode: "grace",
    angleMode: "subdivide",
    parenMode: "chord",
    durationNotation: intrinsicValueTripletOptions,
  },
  2,
);
const intrinsicValueTripletReparse = parseSlashScore(
  intrinsicValueTripletOutput,
  {
    ...intrinsicValueTripletOptions,
    annotations: notationAnnotationsFromScore(intrinsicValueTripletScore),
  },
);
check(!intrinsicValueTripletOutput.includes(`${SLASH_VOICE_SEPARATOR}Q..`)
  && !intrinsicValueTripletOutput.includes(`${SLASH_VOICE_SEPARATOR}J..`)
  && intrinsicValueTripletReparse.summary.diagnostics.every((item) => item.severity !== "error"),
`intrinsic note value was counted twice inside a triplet:\n${intrinsicValueTripletOutput}\n${JSON.stringify(intrinsicValueTripletReparse.summary.diagnostics)}`);

// Nested subdivision may contain more than the three visible members of a
// plain triplet.  Six 32nd members in one <[...]> container must survive the
// parse/export/reparse cycle as one variable-member tuplet rather than being
// truncated to the first three events.
const sixFineTripletText = `键盘谱
4/4拍：
点=16分音符
<[Q.J.A.S.D.F.]>..../..../..../..../
`;
const sixFineTripletOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(sixFineTripletText)),
  voiceCount: 1,
  symbolDurations: { ".": 16 as const },
  noteDivision: null,
  wholeMeasureGroups: false,
  bracketMode: "triplet" as const,
  angleMode: "subdivide" as const,
};
const sixFineTripletScore = parseSlashScore(sixFineTripletText, sixFineTripletOptions).score;
const sixFineTuplets = new Set(sixFineTripletScore.parts[0].measures[0].entries.flatMap((entry) =>
  entry instanceof Chord ? entry.notes.map((note) => note.tuplet).filter((tuplet): tuplet is Tuplet => tuplet !== null) : [],
));
check([...sixFineTuplets].some((tuplet) => {
  const members = sixFineTripletScore.parts[0].measures[0].entries.filter((entry) =>
    entry instanceof Chord && entry.notes.some((note) => note.tuplet === tuplet));
  return members.length === 6;
}), "a six-member <[...]> subdivision was truncated to three triplet events");
const sixFineOutput = scoreToSlashScore(
  sixFineTripletScore,
  "keyboard",
  16,
  ".",
  {
    braceMode: "arpeggio",
    bracketMode: "triplet",
    barMode: "grace",
    angleMode: "subdivide",
    parenMode: "chord",
    durationNotation: sixFineTripletOptions,
  },
  1,
);
const sixFineReparseResult = parseSlashScore(
  sixFineOutput,
  {
    ...sixFineTripletOptions,
    annotations: notationAnnotationsFromScore(sixFineTripletScore),
  },
);
const sixFineReparse = sixFineReparseResult.score;
const sixFineReloadedTuplets = new Set(sixFineReparse.parts[0].measures[0].entries.flatMap((entry) =>
  entry instanceof Chord ? entry.notes.map((note) => note.tuplet).filter((tuplet): tuplet is Tuplet => tuplet !== null) : [],
));
check(sixFineOutput.includes("[QJASDF]") && !sixFineOutput.includes("<[")
  && [...sixFineReloadedTuplets].some((tuplet) => {
    const members = sixFineReparse.parts[0].measures[0].entries.filter((entry) =>
      entry instanceof Chord && entry.notes.some((note) => note.tuplet === tuplet));
    return members.length === 6
      && members.every((entry) => entry instanceof Chord
        && entry.beams === 3
        && entry.dot === 0
        && entry.duration?.equals(new Fraction(1, 12)));
  })
  && sixFineReparseResult.summary.diagnostics.every((item) => item.severity !== "error"),
`six-member attached triplet did not round-trip as six written 32nds:
${sixFineOutput}
${JSON.stringify(sixFineReparseResult.summary.diagnostics)}`);

// Continuation spelling must use the real row-local meter boundary. A 4/4
// measure after 3/4 starts at absolute quarter 3, not at a global multiple of
// four; the marked Y is therefore one whole note, not quarter + tied dotted
// half. The unmarked simultaneous 0 remains one whole rest in V2.
const changedMeterWholeText = `键盘谱
点=16分音符
3/4拍：
-/-/-/
4/4拍：
(0${SLASH_VOICE_SEPARATOR}Y)..../..../..../..../
`;
const changedMeterWholeOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(changedMeterWholeText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 as const },
};
const changedMeterWholeScore = parseSlashScore(
  changedMeterWholeText,
  changedMeterWholeOptions,
).score;
const changedMeterY = changedMeterWholeScore.parts[0].measures[1].entries.filter(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest,
);
const changedMeterRest = changedMeterWholeScore.parts[1].measures[1].entries.filter(
  (entry): entry is Chord => entry instanceof Chord && entry.rest,
);
check(changedMeterY.length === 1
  && changedMeterY[0].position.equals(new Fraction(0))
  && changedMeterY[0].duration?.equals(new Fraction(4))
  && changedMeterY[0].notes.every((note) => !note.tieStart && !note.tieEnd)
  && changedMeterRest.length === 1
  && changedMeterRest[0].duration?.equals(new Fraction(4)),
  "a 4/4 whole note after a 3/4 row was split against the old global meter origin");

// Explicit rests stop a compact voice sustain after a meter change. Replacing
// the lower/default whole rest with one quarter attack must leave three beats
// of rest instead of stretching that attack back to a whole note.
const changedMeterQuarterText = `键盘谱
点=16分音符
3/4拍：
-/-/-/
4/4拍：
(A${SLASH_VOICE_SEPARATOR}Y)..../0..../..../..../
`;
const changedMeterQuarterOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(changedMeterQuarterText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 as const },
  showExplicitRests: true,
};
const changedMeterQuarterScore = parseSlashScore(
  changedMeterQuarterText,
  changedMeterQuarterOptions,
).score;
const changedMeterQuarterAttack = changedMeterQuarterScore.parts[1].measures[1].entries.find(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest && entry.position.equals(0),
);
const changedMeterQuarterRests = changedMeterQuarterScore.parts[1].measures[1].entries.filter(
  (entry): entry is Chord => entry instanceof Chord && entry.rest,
);
check(changedMeterQuarterAttack?.duration?.equals(1)
  && changedMeterQuarterRests.reduce((sum, entry) => sum + (entry.duration?.toFloat() ?? 0), 0) === 3,
`a quarter attack after 3/4 -> 4/4 ignored its explicit rests: ${JSON.stringify({
  attack: changedMeterQuarterAttack?.duration?.toString(),
  rests: changedMeterQuarterRests.map((entry) => [entry.position.toString(), entry.duration?.toString()]),
  allParts: changedMeterQuarterScore.parts.map((part) => part.measures[1].entries
    .filter((entry): entry is Chord => entry instanceof Chord)
    .map((entry) => ({ rest: entry.rest, at: entry.position.toString(), duration: entry.duration?.toString(), pitches: entry.notes.map((note) => note.pitch) }))),
})}`);

// Editing the first 4/4 bar immediately after 3/4 must use the row meter from
// the beginning of the conversion pipeline. Previously the synthetic MIDI
// bridge discarded its tick-zero 3/4 event, so only this transition bar used
// a hidden one-beat-shifted boundary while the following 4/4 bar was normal.
const transitionInputText = `键盘谱
点=16分音符
3/4拍：
-/-/-/
4/4拍：
(0${SLASH_VOICE_SEPARATOR}Y)..../..../..../..../
(0${SLASH_VOICE_SEPARATOR}T)..../..../..../..../
`;
const transitionInputOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(transitionInputText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 as const },
  showExplicitRests: true,
};
const transitionInputScore = parseSlashScore(transitionInputText, transitionInputOptions).score;
const transitionPart = transitionInputScore.parts[1];
const transitionMeasure = transitionPart.measures[1];
const transitionInput = inputNoteAtCursor(
  transitionInputScore,
  {
    partIndex: 1,
    measureIndex: 1,
    offset: new Fraction(0),
    division: 16,
    lane: "rest",
  },
  { pitch: 60, number: "1" },
  new Fraction(1, 4),
);
check(transitionInput.note !== null, "the transition-bar rest could not receive a sixteenth note");
completeInputMeasure(transitionInputScore, { partIndex: 1, measureIndex: 1 }, true);
let transitionExtensions = 0;
for (let step = 0; step < 15; step++) {
  transitionExtensions += resizeScoreNoteSegmentsWithRests(
    transitionInputScore,
    [{ partIndex: 1, note: transitionInput.note!, grace: false }],
    new Fraction(1, 4),
  ).changed;
}
let transitionDuration = new Fraction(0);
let transitionNote = transitionInput.note;
const transitionVisited = new Set<typeof transitionNote>();
while (transitionNote && !transitionVisited.has(transitionNote)) {
  transitionVisited.add(transitionNote);
  transitionDuration = transitionDuration.plus(transitionNote.chord.duration ?? new Fraction(0));
  transitionNote = transitionNote.tieNext;
}
check(transitionPart.measures[0].position.equals(0)
  && transitionPart.measures[1].position.equals(3)
  && transitionPart.measures[2].position.equals(7)
  && transitionMeasure.time.beats === 4
  && transitionMeasure.time.beatType === 4
  && transitionExtensions === 15
  && transitionDuration.equals(4)
  && transitionMeasure.entries.every((entry) => !(entry instanceof Chord) || !entry.rest),
`the first 4/4 bar after 3/4 still used a shifted edit boundary: ${JSON.stringify({
  positions: transitionPart.measures.map((measure) => measure.position.toString()),
  meters: transitionPart.measures.map((measure) => `${measure.time.beats}/${measure.time.beatType}`),
  extensions: transitionExtensions,
  duration: transitionDuration.toString(),
  rests: transitionMeasure.entries.filter((entry) => entry instanceof Chord && entry.rest)
    .map((entry) => [entry.position.toString(), entry.duration?.toString()]),
})}`);

// A leading duration before an explicit zero belongs to the preceding voice:
// `.0...` means one sixteenth of continuation followed by three sixteenths of
// rest. It is not a whole-beat zero. Treating every pitchless `0` group as an
// early full-rest shortcut erased cross-beat input extensions on save/reload.
const leadingContinuationText = `键盘谱
点=16分音符
3/4拍：
-/-/-/
4/4拍：
(A${SLASH_VOICE_SEPARATOR}Y)..../.0.../0..../0..../
`;
const leadingContinuationOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(leadingContinuationText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 as const },
  showExplicitRests: true,
};
const leadingContinuationScore = parseSlashScore(
  leadingContinuationText,
  leadingContinuationOptions,
).score;
const leadingContinuationMeasure = leadingContinuationScore.parts[1].measures[1];
const leadingContinuationSounds = leadingContinuationMeasure.entries
  .filter((entry): entry is Chord => entry instanceof Chord && !entry.rest)
  .sort((left, right) => left.position.compareTo(right.position));
const leadingContinuationRests = leadingContinuationMeasure.entries
  .filter((entry): entry is Chord => entry instanceof Chord && entry.rest)
  .sort((left, right) => left.position.compareTo(right.position));
check(leadingContinuationSounds.length >= 2
  && leadingContinuationSounds[0].position.equals(0)
  && leadingContinuationSounds[0].duration?.equals(1)
  && leadingContinuationSounds[1].position.equals(1)
  && leadingContinuationSounds[1].duration?.equals(new Fraction(1, 4))
  && leadingContinuationSounds[1].transparentContinuation
  && leadingContinuationSounds[0].notes.some((note) => note.tieNext?.chord === leadingContinuationSounds[1])
  && leadingContinuationRests[0]?.position.equals(new Fraction(5, 4))
  && leadingContinuationRests[0].duration?.equals(new Fraction(3, 4)),
`a leading duration before 0 was collapsed into a whole-beat rest: ${JSON.stringify({
  sounds: leadingContinuationSounds.map((entry) => ({
    at: entry.position.toString(),
    duration: entry.duration?.toString(),
    continuation: entry.transparentContinuation,
  })),
  rests: leadingContinuationRests.map((entry) => ({
    at: entry.position.toString(), duration: entry.duration?.toString(),
  })),
})}`);

// Ordinary rests share the same metrical combiner as JPW: merge adjacent
// values inside one beat, but never combine across the beat boundary.
const beatLocalRestText = `键盘谱
4/4拍：
点=16分音符
0000/00AB/C.../D.../
`;
const beatLocalRestOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(beatLocalRestText)),
  voiceCount: 1,
  noteDivision: 16 as const,
  symbolDurations: { ".": 16 as const },
  showExplicitRests: true,
};
const beatLocalRests = parseSlashScore(beatLocalRestText, beatLocalRestOptions)
  .score.parts[0].measures[0].entries.filter(
    (entry): entry is Chord => entry instanceof Chord && entry.rest,
  );
check(beatLocalRests.length === 2
  && beatLocalRests[0].position.equals(0)
  && beatLocalRests[0].duration?.equals(1)
  && beatLocalRests[1].position.equals(1)
  && beatLocalRests[1].duration?.equals(new Fraction(1, 2)),
`TXT rests did not merge only inside their beat: ${JSON.stringify(beatLocalRests.map((entry) => [
  entry.position.toString(), entry.duration?.toString(),
]))}`);

// A new attack in the default/lower TXT voice must not truncate the marked
// upper voice. Y begins with D in beat one and has no later V1 attack, so it
// remains one whole note even though the default voice repeats D in beat two.
const independentTailText = `键盘谱
点=16分音符
4/4拍：
(D${SLASH_VOICE_SEPARATOR}Y)..../D..../..../..../
`;
const independentTailOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(independentTailText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 as const },
  noteDivision: null,
};
const independentTailScore = parseSlashScore(independentTailText, independentTailOptions).score;
const independentUpper = independentTailScore.parts[0].measures[0].entries.filter(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest,
);
const independentLowerAttacks = independentTailScore.parts[1].measures[0].entries.filter(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest
    && !entry.transparentContinuation
    && entry.notes.some((note) => !note.rest && !note.tieEnd),
);
check(independentUpper.length === 1
  && independentUpper[0].position.equals(new Fraction(0))
  && independentUpper[0].duration?.equals(new Fraction(4))
  && independentUpper[0].notes.every((note) => !note.tieStart && !note.tieEnd)
  && independentLowerAttacks.length === 2
  && independentLowerAttacks[0].position.equals(new Fraction(0))
  && independentLowerAttacks[1].position.equals(new Fraction(1)),
"a beat-two attack in V2 truncated the independent V1 tail or produced a dotted tie fragment");

// Source coloring is lexical: one malformed/unclosed triplet may report an
// error, but it must not consume the U+2063 markers on every following line.
const malformedTripletText = `键盘谱\n4/4拍：\n点=16分音符\n[${SLASH_VOICE_SEPARATOR}A.../\n${SLASH_VOICE_SEPARATOR}B.C.D.E./\n`;
const malformedTripletOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(malformedTripletText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 as const },
};
const sourcesAfterMalformedTriplet = slashPitchSources(
  malformedTripletText,
  malformedTripletOptions,
);
check(sourcesAfterMalformedTriplet.some((source) => source.voiceIndex === 1
  && malformedTripletText.slice(source.from, source.to) === "B")
  && sourcesAfterMalformedTriplet.some((source) => source.voiceIndex === 2
    && malformedTripletText.slice(source.from, source.to) === "C"),
"a malformed earlier triplet swallowed later U+2063 voice coloring");

// New delimiter defaults: braces are arpeggios, brackets are triplets, angles
// are grace notes and parentheses remain simultaneous chords. Settings
// migration follows the old semantic role rather than blindly reinterpreting
// the characters.
const delimiterText = `键盘谱\n4/4拍：\n点=16分音符\n{ABC}D/<Q>W.../(GH).../D.../\n`;
const delimiterOptions = defaultSlashScoreOptions("keyboard", analyzeSlashScore(delimiterText));
delimiterOptions.noteDivision = 16;
delimiterOptions.symbolDurations = { ".": 16 };
const delimiterScore = parseSlashScore(delimiterText, delimiterOptions).score;
check(delimiterScore.parts[0].measures[0].entries.some((entry) =>
  entry instanceof Chord && entry.arpeggio)
  && delimiterScore.parts[0].measures[0].entries.some((entry) =>
    entry instanceof Chord && entry.graceNotes.length === 1)
  && delimiterScore.parts[0].measures[0].entries.some((entry) =>
    entry instanceof Chord && entry.notes.filter((note) => !note.rest).length === 2),
"default {} arpeggio / <> grace / [] triplet / () chord parsing did not reach the Score");
const swappedDelimiterOptions: SlashScoreOptions = {
  ...delimiterOptions,
  braceMode: "grace",
  angleMode: "triplet",
  bracketMode: "arpeggio",
};
const migratedDelimiters = migrateSlashDelimiters(
  `键盘谱\n{ABC}D/[EF]../<G>H/`,
  delimiterOptions,
  swappedDelimiterOptions,
);
check(migratedDelimiters.changed === 3
  && migratedDelimiters.text.includes("[ABC]D")
  && migratedDelimiters.text.includes("<EF>")
  && migratedDelimiters.text.includes("{G}H"),
"confirmed delimiter migration did not preserve the old arpeggio/triplet roles");
const disabledDelimiterOptions = { ...delimiterOptions, braceMode: "none" as const };
check(parseSlashScore(delimiterText, disabledDelimiterOptions).summary.diagnostics.some((item) =>
  item.severity === "error" && item.message.includes("尚未分配括号功能")),
"an unassigned delimiter still present in TXT should produce a red diagnostic");

// A local arpeggio remains nested inside the simultaneous multi-voice chord,
// while a true cross-staff mark owns one brace around every participating
// pitch. This is the editable TXT distinction between `(B{DG})` and `{BDG}`.
const partialArpeggioText = `键盘谱\n4/4拍：\n点=16分音符\n(B${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G).../..../..../..../\n`;
const partialArpeggioOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(partialArpeggioText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 as const },
};
const partialArpeggioScore = parseSlashScore(partialArpeggioText, partialArpeggioOptions).score;
const upperArpeggioChord = partialArpeggioScore.parts[0].measures[0].entries.find(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest,
)!;
upperArpeggioChord.arpeggio = true;
upperArpeggioChord.arpeggioPitches = upperArpeggioChord.notes.map((note) => note.pitch);
const partialArpeggioOutput = scoreToSlashScore(
  partialArpeggioScore,
  "keyboard",
  16,
  ".",
  { braceMode: "arpeggio", bracketMode: "triplet", barMode: "grace", angleMode: "subdivide", parenMode: "chord" },
  2,
);
check(partialArpeggioOutput.includes(`(B{${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G})`),
"a one-voice arpeggio was not nested inside its simultaneous multi-voice chord");
upperArpeggioChord.arpeggio = false;
upperArpeggioChord.arpeggioPitches = null;
const crossArpeggio = new CrossPartArpeggio();
crossArpeggio.measure = 0;
crossArpeggio.offset = new Fraction(0);
crossArpeggio.parts = [0, 1];
crossArpeggio.pitches = partialArpeggioScore.parts.flatMap((part, partIndex) =>
  part.measures[0].entries.filter((entry): entry is Chord => entry instanceof Chord && !entry.rest)
    .flatMap((chord) => chord.notes.filter((note) => !note.rest)
      .map((note) => ({ part: partIndex, pitch: note.pitch }))));
partialArpeggioScore.crossPartArpeggios = [crossArpeggio];
const crossPlayback = buildTimeline(partialArpeggioScore).notes
  .filter((note) => crossArpeggio.pitches.some((item) => item.part === note.part && item.pitch === note.pitch))
  .sort((left, right) => left.pitch - right.pitch);
check(crossPlayback.length >= 2
  && crossPlayback.every((note, index) => index === 0 || note.t0 > crossPlayback[index - 1]!.t0),
"cross-staff arpeggio playback did not roll all participating parts in pitch order");
const crossArpeggioOutput = scoreToSlashScore(
  partialArpeggioScore,
  "keyboard",
  16,
  ".",
  { braceMode: "arpeggio", bracketMode: "triplet", barMode: "grace", angleMode: "subdivide", parenMode: "chord" },
  2,
);
check(crossArpeggioOutput.includes(`{B${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G}`)
  && !crossArpeggioOutput.includes(`(B{${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G})`),
"a cross-staff arpeggio did not serialize as one outer arpeggio group");
const crossArpeggioRoundTrip = parseSlashScore(crossArpeggioOutput, {
  ...partialArpeggioOptions,
  annotations: notationAnnotationsFromScore(partialArpeggioScore),
}).score;
check(crossArpeggioRoundTrip.crossPartArpeggios.length === 1
  && crossArpeggioRoundTrip.parts.every((part) =>
    part.measures[0].entries.every((entry) => !(entry instanceof Chord) || !entry.arpeggio)),
"cross-staff arpeggio metadata also left a duplicate per-staff wave");

// Silent source rows are authoritative in input mode: both voices and every
// declared trailing measure must exist until input mode closes and cleans the
// empty tail.
const silentTailText = `键盘谱\n4/4拍：\n(${SLASH_VOICE_SEPARATOR}00)..../(${SLASH_VOICE_SEPARATOR}00)..../(${SLASH_VOICE_SEPARATOR}00)..../(${SLASH_VOICE_SEPARATOR}00)..../\n(${SLASH_VOICE_SEPARATOR}00)..../(${SLASH_VOICE_SEPARATOR}00)..../(${SLASH_VOICE_SEPARATOR}00)..../(${SLASH_VOICE_SEPARATOR}00)..../\n`;
const silentTailOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(silentTailText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 as const },
};
const silentTailScore = parseSlashScore(silentTailText, silentTailOptions).score;
check(silentTailScore.parts.length === 2
  && silentTailScore.parts.every((part) => part.measures.length === 2)
  && silentTailScore.parts.every((part) => part.measures[1].entries.some((entry) =>
    entry instanceof Chord && entry.rest))
  && silentTailScore.playData.measures.some((item) => item.end === 2),
"declared all-rest tail measures disappeared before input-mode layout");
const preservedSilentTailText = scoreToSlashScore(
  silentTailScore,
  "keyboard",
  16,
  ".",
  {
    durationNotation: { ...silentTailOptions, showExplicitRests: false },
    preserveExplicitRestMeasures: [1],
  },
  2,
);
const preservedSilentTailRow = preservedSilentTailText.split("\n")
  .filter((line) => !line.trim().startsWith("//") && line.endsWith("/"))[1] ?? "";
check(preservedSilentTailRow.split(`(${SLASH_VOICE_SEPARATOR}00)`).length - 1 === 4,
"a synchronized two-voice input tail did not serialize one explicit rest column per beat");

// While the notation cursor is editing one measure, its remaining 0 cells
// must not be collapsed into an implicit long sustain merely because the
// document normally hides rests. Other measures keep the saved preference.
const inputTailRestText = `键盘谱\n4/4拍：\n点=16分音符\nA.../0.../0.../0.../\nB.../0.../0.../0.../\n`;
const inputTailRestOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(inputTailRestText)),
  voiceCount: 1,
  symbolDurations: { ".": 16 as const },
  showExplicitRests: true,
};
const inputTailRestScore = parseSlashScore(inputTailRestText, inputTailRestOptions).score;
const preservedInputTailText = scoreToSlashScore(
  inputTailRestScore,
  "keyboard",
  16,
  ".",
  {
    braceMode: "arpeggio",
    bracketMode: "triplet",
    barMode: "grace",
    angleMode: "subdivide",
    parenMode: "chord",
    showExplicitRests: false,
    preserveExplicitRestMeasures: [1],
    durationNotation: { ...inputTailRestOptions, showExplicitRests: false },
  },
  1,
);
const preservedInputRows = preservedInputTailText.split("\n")
  .filter((line) => !line.trim().startsWith("//") && line.endsWith("/"));
check(!preservedInputRows[0].includes("0") && preservedInputRows[1].includes("0"),
"input-mode rest cells were collapsed into an abnormal tied sustain");

const leadingRestFile = JpwFile.fromString(`.Title
KeyAndMeters = {1=C,4/4}
.Voice
0 1--- |]
`);
check(leadingRestFile !== null, "leading-rest JPW fixture did not parse");
const leadingRestText = scoreToSlashScore(
  fromJpw(leadingRestFile!),
  "number",
  16,
  ".",
  {
    ...restExportOptions,
    showExplicitRests: false,
    durationNotation: { ...restExportOptions.durationNotation, showExplicitRests: false },
  },
);
check(/(?:^|[/(])0(?:[./)]|$)/m.test(leadingRestText),
"implicit-sustain TXT export removed leading silence that has no previous note");

// Single-bar grace spelling is canonical; the historical doubled bars remain
// readable for old files. Nested subdivision+triplet ornaments are folded to
// one timed attack when their metadata identifies the ornament target.
const ornamentText = `键盘谱\n// @jpeditor ${JSON.stringify({
  v: 2, vc: 1, k: "k", s: { ".": 16 }, x: "s", q: "t",
  an: [{ type: "ornament", part: 0, measure: 0, offset: 0, kind: "upper-mordent" }],
})}\n4/4拍：\n<[DFD]>/-/-/-/`;
const ornamentAnalysis = analyzeSlashScore(ornamentText);
const ornamentResult = parseSlashScore(ornamentText, {
  ...defaultSlashScoreOptions("keyboard", ornamentAnalysis),
  annotations: ornamentAnalysis.annotations,
  symbolDurations: { ".": 16 },
  angleMode: "subdivide",
  bracketMode: "triplet",
});
const ornamentEntries = ornamentResult.score.parts[0]?.measures[0]?.entries
  .filter((entry): entry is Chord => entry instanceof Chord && !entry.rest) ?? [];
check(ornamentEntries.length === 1 && ornamentEntries[0]!.ornaments.some((item) => item.kind === "upper-mordent"),
  "nested ornament was expanded into extra timed notes");
const legacyBar = parseSlashScore("键盘谱\n4/4拍：\n||A||/-/-/-/", {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore("键盘谱\n4/4拍：\n||A||/-/-/-/")),
  barMode: "grace",
});
const singleBar = parseSlashScore("键盘谱\n4/4拍：\n|A|/-/-/-/", {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore("键盘谱\n4/4拍：\n|A|/-/-/-/")),
  barMode: "grace",
});
check(legacyBar.score.parts[0]?.measures[0]?.entries.some((entry) => entry instanceof Chord && !entry.rest)
  && singleBar.score.parts[0]?.measures[0]?.entries.some((entry) => entry instanceof Chord && !entry.rest),
"single-bar grace spelling or legacy doubled-bar spelling was not parsed");
const trillText = `数字谱
4/4拍：
花括号 = 颤音（括号内音符仅作装饰，不增加小节拍长）
{3}/-/-/-/
`;
const trillOptions = defaultSlashScoreOptions("number", analyzeSlashScore(trillText));
const trillScore = parseSlashScore(trillText, trillOptions).score;
check(trillOptions.braceMode === "trill"
  && trillScore.parts[0]?.measures[0]?.entries.some((entry) =>
    entry instanceof Chord && entry.ornaments.some((item) => item.kind === "trill")),
"trill delimiter setting did not create one semantic Tr ornament");

const mordentSourceText = `键盘谱
4/4拍：
. = 16分音符
D.E.F.G./-/-/-/
`;
const mordentSourceOptions = defaultSlashScoreOptions("keyboard", analyzeSlashScore(mordentSourceText));
const mordentSourceScore = parseSlashScore(mordentSourceText, mordentSourceOptions).score;
const mordentSourceChord = mordentSourceScore.parts[0]?.measures[0]?.entries.find(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest,
);
check(mordentSourceChord !== undefined, "mordent serialization fixture has no source chord");
mordentSourceChord.ornaments.push({ kind: "upper-mordent" });
const mordentBody = scoreToSlashScore(
  mordentSourceScore,
  "keyboard",
  16,
  ".",
  {
    braceMode: "arpeggio",
    bracketMode: "triplet",
    barMode: "grace",
    angleMode: "subdivide",
    parenMode: "chord",
    durationNotation: mordentSourceOptions,
  },
  1,
);
check(mordentBody.includes("[DFD].") && !mordentBody.includes("<[DFD]>")
  && notationAnnotationsFromScore(mordentSourceScore)
  .some((annotation) => annotation.type === "ornament" && annotation.kind === "upper-mordent"),
"TXT upper mordent was not encoded as metadata-backed [DFD].");
const mordentSaved = embedSlashScoreOptionsFromScore(mordentBody, mordentSourceScore, mordentSourceOptions);
const mordentReloadAnalysis = analyzeSlashScore(mordentSaved);
const mordentReload = parseSlashScore(
  mordentSaved,
  defaultSlashScoreOptions("keyboard", mordentReloadAnalysis),
).score;
check(sounding(mordentReload).filter((item) => item.at < 1).length === 4
  && mordentReload.parts[0]?.measures[0]?.entries.some((entry) =>
    entry instanceof Chord && entry.ornaments.some((item) => item.kind === "upper-mordent")),
"metadata-backed TXT mordent rendered its helper pitches as extra timed notes");
const slurChords = mordentSourceScore.parts[0]?.measures[0]?.entries.filter(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest,
) ?? [];
check(slurChords.length >= 2, "slur metadata fixture has too few chords");
slurChords[0]!.slurStart = true;
slurChords[0]!.slurEndChord = slurChords[slurChords.length - 1]!;
slurChords[slurChords.length - 1]!.slurEnd = true;
const slurSaved = embedSlashScoreOptionsFromScore(mordentBody, mordentSourceScore, mordentSourceOptions);
const slurReloadAnalysis = analyzeSlashScore(slurSaved);
const slurReload = parseSlashScore(
  slurSaved,
  defaultSlashScoreOptions("keyboard", slurReloadAnalysis),
).score;
const slurReloadStart = slurReload.parts[0]?.measures[0]?.entries.find(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest,
);
check(slurReloadStart?.slurStart && slurReloadStart.slurEndChord?.slurEnd,
  "selected-note TXT slur was not stored only in metadata and restored on reload");

// Tight adjacency never creates a hidden 128th grid, even when the configured
// minimum is 64th. The leading 1 is an unmeasured grace note for the main 2.
const finestImplicitGraceText = `数字谱
4/4拍：
+ = 64分音符
12++++++++++++++++/-/-/-/
`;
const finestImplicitGraceOptions = defaultSlashScoreOptions(
  "number",
  analyzeSlashScore(finestImplicitGraceText),
);
const finestImplicitGraceScore = parseSlashScore(
  finestImplicitGraceText,
  finestImplicitGraceOptions,
).score;
const finestImplicitGraceChord = finestImplicitGraceScore.parts[0]?.measures[0]?.entries.find(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest,
);
check(finestImplicitGraceChord?.graceNotes.length === 1
  && finestImplicitGraceChord.position.equals(new Fraction(0))
  && finestImplicitGraceChord.duration?.equals(new Fraction(1)),
"tight 64th-note TXT created a hidden 128th attack instead of one grace note");

// A TXT key change is a real transposition: visible degrees stay unchanged,
// while playback pitches move to the new tonic and survive save/reload.
const keyTransposeText = `数字谱
1 = C
4/4拍：
音符自身时值 = 4分音符
1/1/1/1/

// @jpeditor ${JSON.stringify({
  v: 2, vc: 1, k: "n", nd: 4,
  an: [{ type: "key", measure: 0, offset: 1, fifths: 1 }],
})}
`;
const keyTransposeAnalysis = analyzeSlashScore(keyTransposeText);
const keyTransposeOptions = defaultSlashScoreOptions("number", keyTransposeAnalysis);
const keyTransposeScore = parseSlashScore(keyTransposeText, keyTransposeOptions).score;
const transposedNotes = sounding(keyTransposeScore);
check(transposedNotes.map((item) => item.pitches[0]).join(",") === "60,67,67,67",
  "TXT key change altered visible degrees instead of transposing playback pitches");
const keyTransposeBody = scoreToSlashScore(
  keyTransposeScore,
  "number",
  4,
  ".",
  {
    braceMode: "arpeggio",
    bracketMode: "triplet",
    barMode: "grace",
    angleMode: "subdivide",
    parenMode: "chord",
    durationNotation: keyTransposeOptions,
  },
  1,
);
check(keyTransposeBody.split(/\r?\n/).some((line) => line === "1/1/1/1/"),
  "TXT key-change serialization rewrote unchanged scale degrees as absolute pitches");
const keyTransposeSaved = embedSlashScoreOptionsFromScore(
  keyTransposeBody,
  keyTransposeScore,
  keyTransposeOptions,
);
const keyTransposeReloadAnalysis = analyzeSlashScore(keyTransposeSaved);
const keyTransposeReload = parseSlashScore(
  keyTransposeSaved,
  defaultSlashScoreOptions("number", keyTransposeReloadAnalysis),
).score;
check(sounding(keyTransposeReload).map((item) => item.pitches[0]).join(",") === "60,67,67,67",
  "TXT key-change playback transposition was lost after metadata reload");

// Duration-marked atoms remain ordinary 16ths.
const stickySubdivisionText = `键盘谱
4/4拍：
点=16分音符
A.B.C.D./..../..../..../
`;
const stickySubdivision = parseSlashScore(stickySubdivisionText, {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(stickySubdivisionText)),
  symbolDurations: { ".": 16 as const },
  noteDivision: null,
});
const stickyEntries = stickySubdivision.score.parts[0]!.measures[0]!.entries
  .filter((entry): entry is Chord => entry instanceof Chord && !entry.rest
    && !entry.generatedTimingContinuation && !entry.transparentContinuation);
check(stickyEntries.length === 4
  && stickyEntries.every((entry) => entry.duration?.equals(new Fraction(1, 4))),
  `dot-marked adjacent notes were not kept as four ordinary sixteenths: ${stickyEntries.map((entry) => entry.duration?.toFloat()).join(",")}`);

const compactSubdivisionText = `键盘谱
4/4拍：
点=16分音符
ABC/..../..../..../
`;
const compactSubdivision = parseSlashScore(compactSubdivisionText, {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(compactSubdivisionText)),
  symbolDurations: { ".": 16 as const },
  noteDivision: null,
});
const compactEntries = compactSubdivision.score.parts[0]!.measures[0]!.entries
  .filter((entry): entry is Chord => entry instanceof Chord && !entry.rest
    && !entry.generatedTimingContinuation && !entry.transparentContinuation);
const compactSources = slashPitchSources(compactSubdivisionText, {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(compactSubdivisionText)),
  symbolDurations: { ".": 16 as const },
  noteDivision: null,
});
check(compactEntries.length === 1
  && compactEntries[0]!.graceNotes.length === 2
  && compactEntries[0]!.duration?.equals(new Fraction(1))
  && compactSources.length >= 3
  && compactSources.slice(0, 3).map((source) => source.grace).join(",") === "true,true,false"
  && new Set(compactSources.slice(0, 3).map((source) => source.eventIndex)).size === 1,
  "tight ABC did not become two unmeasured grace notes attached to main C");

// An intrinsic note value disables implicit grace recognition: every attached
// glyph is an ordinary note unless an explicitly configured grace delimiter is used.
const intrinsicCompactText = `键盘谱
4/4拍：
点=16分音符
音符自身时值=16分音符
ABC./..../..../..../
`;
const intrinsicCompact = parseSlashScore(intrinsicCompactText, {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(intrinsicCompactText)),
  symbolDurations: { ".": 16 as const },
  noteDivision: 16,
});
const intrinsicCompactEntries = intrinsicCompact.score.parts[0]!.measures[0]!.entries
  .filter((entry): entry is Chord => entry instanceof Chord && !entry.rest
    && !entry.generatedTimingContinuation && !entry.transparentContinuation);
check(intrinsicCompactEntries.length === 3
  && intrinsicCompactEntries.every((entry) => entry.graceNotes.length === 0)
  && intrinsicCompactEntries[0]!.duration?.equals(new Fraction(1, 4))
  && intrinsicCompactEntries[1]!.duration?.equals(new Fraction(1, 4))
  && intrinsicCompactEntries[2]!.duration?.equals(new Fraction(1, 2)),
  "intrinsic note duration was ignored or tight ABC became implicit grace notes");

const implicitGraceChordText = `键盘谱
4/4拍：
. = 16分音符
A(BS)..../..../..../..../
`;
const implicitGraceChordOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(implicitGraceChordText)),
  symbolDurations: { ".": 16 as const },
  noteDivision: null,
};
const implicitGraceChordScore = parseSlashScore(
  implicitGraceChordText,
  implicitGraceChordOptions,
).score;
const implicitGraceMain = implicitGraceChordScore.parts[0]!.measures[0]!.entries.find(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest,
);
const implicitGraceChordSources = slashPitchSources(
  implicitGraceChordText,
  implicitGraceChordOptions,
).slice(0, 3);
check(implicitGraceMain?.notes.filter((note) => !note.rest).length === 2
  && implicitGraceMain.graceNotes.length === 1
  && implicitGraceChordSources.map((source) => source.grace).join(",") === "true,false,false"
  && new Set(implicitGraceChordSources.map((source) => source.eventIndex)).size === 1,
"A(BS) did not map A as an unmeasured grace note for the main (BS) chord");
const implicitGraceChordSaved = scoreToSlashScore(
  implicitGraceChordScore,
  "keyboard",
  16,
  ".",
  {
    braceMode: "arpeggio",
    bracketMode: "triplet",
    barMode: "grace",
    angleMode: "none",
    parenMode: "chord",
    durationNotation: implicitGraceChordOptions,
  },
  1,
);
check(implicitGraceChordSaved.includes("A(BS)....")
  && !implicitGraceChordSaved.includes("|A|"),
"marker-only TXT did not serialize grace A directly before main chord (BS)");

const intrinsicExplicitGraceText = `键盘谱
4/4拍：
. = 16分音符
音符自身时值 = 16分音符
|A|(BS).../..../..../..../
`;
const intrinsicExplicitGraceOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(intrinsicExplicitGraceText)),
  symbolDurations: { ".": 16 as const },
  noteDivision: 16 as const,
  barMode: "grace" as const,
};
const intrinsicExplicitGraceMain = parseSlashScore(
  intrinsicExplicitGraceText,
  intrinsicExplicitGraceOptions,
).score.parts[0]!.measures[0]!.entries.find(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest,
);
check(intrinsicExplicitGraceMain?.graceNotes.length === 1
  && intrinsicExplicitGraceMain.notes.filter((note) => !note.rest).length === 2,
"intrinsic TXT did not retain explicitly delimited grace A");

const adjacentRestText = `键盘谱
4/4拍：
. = 16分音符
00.../..../..../..../
`;
const adjacentRestResult = parseSlashScore(adjacentRestText, {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(adjacentRestText)),
  symbolDurations: { ".": 16 as const },
  noteDivision: null,
});
check(adjacentRestResult.summary.diagnostics.every((item) => item.severity !== "error")
  && adjacentRestResult.score.parts[0]!.measures[0]!.entries
    .filter((entry): entry is Chord => entry instanceof Chord && entry.rest)
    .every((entry) => (entry.duration?.compareTo(new Fraction(1, 4)) ?? -1) >= 0),
"tight rests still created a value finer than the configured 16th minimum");

check(!implicitGraceChordSaved.includes("尖括号 =")
  && !implicitGraceChordSaved.includes("留空（不指定特殊功能")
  && slashScoreTemplate("keyboard").includes("尖括号 = 倚音")
  && !slashScoreTemplate("keyboard").includes("竖线括号 ="),
"custom unassigned delimiters or the new angle-grace template default were written incorrectly");

// U+2063 is ownership metadata, not an atom.  Compact adjacent notes must
// still land in the intended voices and the marker must never alter timing.
const voicedCompactText = `键盘谱
4/4拍：
点=16分音符
${SLASH_VOICE_SEPARATOR}A.B.C./..../..../..../
`;
const voicedCompact = parseSlashScore(voicedCompactText, {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(voicedCompactText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 as const },
  noteDivision: null,
});
const voicedCompactV1 = voicedCompact.score.parts[0]!.measures[0]!.entries
  .filter((entry): entry is Chord => entry instanceof Chord && !entry.rest
    && !entry.generatedTimingContinuation && !entry.transparentContinuation);
const voicedCompactV2 = voicedCompact.score.parts[1]!.measures[0]!.entries
  .filter((entry): entry is Chord => entry instanceof Chord && !entry.rest
    && !entry.generatedTimingContinuation && !entry.transparentContinuation);
check(voicedCompactV1.length === 1 && voicedCompactV2.length === 2
  && voicedCompactV1[0]!.position.equals(new Fraction(0))
  && voicedCompactV2[0]!.position.equals(new Fraction(1, 4))
  && voicedCompactV2[1]!.position.equals(new Fraction(1, 2)),
  `U+2063 marker was lost while parsing compact adjacent notes: V1=${voicedCompactV1.map((entry) => entry.duration?.toFloat())}; V2=${voicedCompactV2.map((entry) => entry.duration?.toFloat())}`);

const sameVoiceCompactText = `键盘谱
4/4拍：
点=16分音符
${SLASH_VOICE_SEPARATOR}A${SLASH_VOICE_SEPARATOR}B/..../..../..../
`;
const sameVoiceCompact = parseSlashScore(sameVoiceCompactText, {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(sameVoiceCompactText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 as const },
  noteDivision: null,
}).score.parts[0]!.measures[0]!.entries.filter((entry): entry is Chord =>
  entry instanceof Chord && !entry.rest
  && !entry.generatedTimingContinuation && !entry.transparentContinuation);
check(sameVoiceCompact.length === 1
  && sameVoiceCompact[0]!.position.equals(new Fraction(0))
  && sameVoiceCompact[0]!.graceNotes.length === 1,
"same-voice U+2063 ownership markers broke implicit grace adjacency");

// Historical half-grid edit fixtures are retained as documentation, but the
// public TXT grammar no longer exposes attached subdivision.
const legacyAttachedSubdivisionEnabled = false;
if (legacyAttachedSubdivisionEnabled) {
// A fine Ctrl+Left edit releases one 32nd-note rest at the audible end of a
// long default-voice sustain.  The serializer writes that fine rest adjacent
// to the neighbouring rest atom; save/reload must keep the final beat whole
// instead of reading `00` as two ordinary 16ths and dropping a V1 attack.
const fineVoiceEditText = `键盘谱
4/4拍：
点=16分音符
(N${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G).${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N.(${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G)./.${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N.${SLASH_VOICE_SEPARATOR}A./(${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G).${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N.(${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G)./.${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N.${SLASH_VOICE_SEPARATOR}A./
`;
const fineVoiceEditOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(fineVoiceEditText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 },
  noteDivision: null,
  showExplicitRests: true,
};
const fineVoiceEditScore = parseSlashScore(fineVoiceEditText, fineVoiceEditOptions).score;
const sustainedDefaultVoiceN = fineVoiceEditScore.parts[1]!.measures[0]!.entries.find((entry) =>
  entry instanceof Chord && !entry.rest && entry.position.equals(new Fraction(0))) as Chord | undefined;
check(sustainedDefaultVoiceN?.notes[0], "fine voice edit fixture did not contain the default-voice N");
const fineVoiceResize = resizeScoreNoteSegmentsWithRests(
  fineVoiceEditScore,
  [{ partIndex: 1, note: sustainedDefaultVoiceN.notes[0]!, grace: false }],
  new Fraction(-1, 8),
);
check(fineVoiceResize.changed === 1, "32nd Ctrl+Left did not shorten the sustained N");
const fineVoiceSaved = scoreToSlashScore(
  fineVoiceEditScore,
  "keyboard",
  16,
  ".",
  {
    braceMode: fineVoiceEditOptions.braceMode,
    bracketMode: fineVoiceEditOptions.bracketMode ?? "triplet",
    barMode: fineVoiceEditOptions.barMode ?? "grace",
    angleMode: fineVoiceEditOptions.angleMode ?? "none",
    parenMode: fineVoiceEditOptions.parenMode ?? "chord",
    compactSubdivision: true,
    durationNotation: fineVoiceEditOptions,
  },
  2,
);
const fineVoiceReload = parseSlashScore(fineVoiceSaved, fineVoiceEditOptions);
check(fineVoiceReload.summary.diagnostics.every((item) => item.severity !== "error"),
  `32nd Ctrl+Left produced an incomplete TXT beat: ${fineVoiceSaved}\n${JSON.stringify(fineVoiceReload.summary.diagnostics)}`);
const fineVoiceLastV1 = fineVoiceReload.score.parts[0]!.measures.at(-1)!;
const fineVoiceLastV2 = fineVoiceReload.score.parts[1]!.measures.at(-1)!;
check(fineVoiceLastV1.entries.some((entry) => entry instanceof Chord
  && !entry.rest && entry.position.equals(new Fraction(15, 4))),
"32nd Ctrl+Left swallowed the other voice's final sixteenth attack");
check(fineVoiceLastV2.entries.some((entry) => entry instanceof Chord
  && entry.rest && entry.position.equals(new Fraction(31, 8))
  && entry.duration?.equals(new Fraction(1, 8))),
"32nd Ctrl+Left did not round-trip its released 32nd rest");

const fineAltMoveText = `键盘谱
4/4拍：
点=16分音符
${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}0.${SLASH_VOICE_SEPARATOR}B../..../..../..../
`;
const fineAltMoveOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(fineAltMoveText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 },
  noteDivision: null,
  showExplicitRests: true,
};
const fineAltMoveScore = parseSlashScore(fineAltMoveText, fineAltMoveOptions).score;
const fineAltOriginalTimeline = JSON.stringify(buildTimeline(fineAltMoveScore).notes
  .map((note) => [note.part, note.pitch, note.t0, note.t1]));
const fineAltAttack = fineAltMoveScore.parts[0]!.measures[0]!.entries.find((entry) =>
  entry instanceof Chord && !entry.rest && entry.position.equals(new Fraction(0))) as Chord | undefined;
check(fineAltAttack?.notes[0], "fine Alt fixture did not contain its opening V1 attack");
const fineAltMove = moveScoreNotesOnTimeline(
  fineAltMoveScore,
  [{ partIndex: 0, note: fineAltAttack.notes[0]!, grace: false }],
  new Fraction(1, 8),
  { preserveRests: true, moveWholeTieChain: true },
);
check(fineAltMove.changed === 1, "32nd Alt+Right did not move the V1 attack into its rest");
const fineAltSaved = scoreToSlashScore(
  fineAltMoveScore,
  "keyboard",
  16,
  ".",
  {
    braceMode: fineAltMoveOptions.braceMode,
    bracketMode: fineAltMoveOptions.bracketMode ?? "triplet",
    barMode: fineAltMoveOptions.barMode ?? "grace",
    angleMode: fineAltMoveOptions.angleMode ?? "none",
    parenMode: fineAltMoveOptions.parenMode ?? "chord",
    compactSubdivision: true,
    durationNotation: fineAltMoveOptions,
  },
  2,
);
const fineAltReload = parseSlashScore(fineAltSaved, fineAltMoveOptions);
check(fineAltReload.summary.diagnostics.every((item) => item.severity !== "error"),
  `32nd Alt movement produced an incomplete TXT beat: ${fineAltSaved}\n${JSON.stringify(fineAltReload.summary.diagnostics)}`);
const fineAltMovedAttack = fineAltReload.score.parts[0]!.measures[0]!.entries.find((entry) =>
  entry instanceof Chord && !entry.rest && entry.position.equals(new Fraction(1, 8))) as Chord | undefined;
check(fineAltMovedAttack?.notes[0], "32nd Alt round-trip lost the moved V1 attack");
check(moveScoreNotesOnTimeline(
  fineAltReload.score,
  [{ partIndex: 0, note: fineAltMovedAttack.notes[0]!, grace: false }],
  new Fraction(-1, 8),
  { preserveRests: true, moveWholeTieChain: true },
).changed === 1, "32nd Alt+Left could not restore the moved V1 attack");
const fineAltRestoredText = scoreToSlashScore(
  fineAltReload.score,
  "keyboard",
  16,
  ".",
  {
    braceMode: fineAltMoveOptions.braceMode,
    bracketMode: fineAltMoveOptions.bracketMode ?? "triplet",
    barMode: fineAltMoveOptions.barMode ?? "grace",
    angleMode: fineAltMoveOptions.angleMode ?? "none",
    parenMode: fineAltMoveOptions.parenMode ?? "chord",
    compactSubdivision: true,
    durationNotation: fineAltMoveOptions,
  },
  2,
);
const fineAltRestored = parseSlashScore(fineAltRestoredText, fineAltMoveOptions);
check(fineAltRestored.summary.diagnostics.every((item) => item.severity !== "error")
  && JSON.stringify(buildTimeline(fineAltRestored.score).notes
    .map((note) => [note.part, note.pitch, note.t0, note.t1])) === fineAltOriginalTimeline,
"32nd Alt right/left round-trip did not restore the original timeline");

// Moving the first fine V1 A onto N releases one 32nd cell immediately after
// an existing V1 zero.  Those two silent cells are one 16th rest (`0.`), not
// two new compact rest attacks (`00`).
const adjacentReleasedRestText = `键盘谱
4/4拍：
点=16分音符
(V${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G).${SLASH_VOICE_SEPARATOR}0${SLASH_VOICE_SEPARATOR}A${SLASH_VOICE_SEPARATOR}N.(${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G)./.${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N.${SLASH_VOICE_SEPARATOR}A./(B${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G).${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N.(${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G)./.${SLASH_VOICE_SEPARATOR}N.${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N./
`;
const adjacentReleasedRestOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(adjacentReleasedRestText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 },
  noteDivision: null,
  showExplicitRests: true,
};
const adjacentReleasedRestScore = parseSlashScore(
  adjacentReleasedRestText,
  adjacentReleasedRestOptions,
).score;
const adjacentReleasedV2 = JSON.stringify(buildTimeline(adjacentReleasedRestScore).notes
  .filter((note) => note.part === 1)
  .map((note) => [note.pitch, note.t0, note.t1]));
const adjacentReleasedA = adjacentReleasedRestScore.parts[0]!.measures[0]!.entries
  .filter((entry): entry is Chord => entry instanceof Chord && !entry.rest
    && entry.position.compareTo(new Fraction(0)) > 0)
  .sort((left, right) => left.position.compareTo(right.position))[0];
check(adjacentReleasedA?.notes[0], "adjacent-rest Alt fixture did not contain the first V1 A");
check(moveScoreNotesOnTimeline(
  adjacentReleasedRestScore,
  [{ partIndex: 0, note: adjacentReleasedA.notes[0]!, grace: false }],
  new Fraction(1, 8),
  { preserveRests: true, moveWholeTieChain: true },
).changed === 1, "the first compact V1 A could not move right by one 32nd");
const adjacentReleasedRestSaved = scoreToSlashScore(
  adjacentReleasedRestScore,
  "keyboard",
  16,
  ".",
  {
    braceMode: adjacentReleasedRestOptions.braceMode,
    bracketMode: adjacentReleasedRestOptions.bracketMode ?? "triplet",
    barMode: adjacentReleasedRestOptions.barMode ?? "grace",
    angleMode: adjacentReleasedRestOptions.angleMode ?? "none",
    parenMode: adjacentReleasedRestOptions.parenMode ?? "chord",
    compactSubdivision: true,
    durationNotation: adjacentReleasedRestOptions,
  },
  2,
);
const adjacentReleasedExpected = `(V${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G).${SLASH_VOICE_SEPARATOR}0.(${SLASH_VOICE_SEPARATOR}N${SLASH_VOICE_SEPARATOR}A)${SLASH_VOICE_SEPARATOR}0(${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G)./`;
check(adjacentReleasedRestSaved.includes(adjacentReleasedExpected),
  `moving the first V1 A duplicated its released rest:\n${adjacentReleasedRestSaved}`);
const adjacentReleasedRestReload = parseSlashScore(
  adjacentReleasedRestSaved,
  adjacentReleasedRestOptions,
);
check(adjacentReleasedRestReload.summary.diagnostics.every((item) => item.severity !== "error")
  && JSON.stringify(buildTimeline(adjacentReleasedRestReload.score).notes
    .filter((note) => note.part === 1)
    .map((note) => [note.pitch, note.t0, note.t1])) === adjacentReleasedV2,
"fusing the released V1 rest changed the beat length or the other voice");
const adjacentMovedChord = adjacentReleasedRestReload.score.parts[0]!.measures[0]!.entries
  .find((entry): entry is Chord => entry instanceof Chord && !entry.rest
    && entry.position.equals(new Fraction(1, 2))
    && entry.notes.filter((note) => !note.rest).length === 2);
const adjacentMovedA = adjacentMovedChord?.notes
  .filter((note) => !note.rest)
  .sort((left, right) => right.pitch - left.pitch)[0];
check(adjacentMovedA, "the right-moved A was not selectable in its N/A chord");
check(moveScoreNotesOnTimeline(
  adjacentReleasedRestReload.score,
  [{ partIndex: 0, note: adjacentMovedA, grace: false }],
  new Fraction(-1, 8),
  { preserveRests: true, moveWholeTieChain: true },
).changed === 1, "the moved V1 A could not move left by one 32nd");
const adjacentReleasedLeftSaved = scoreToSlashScore(
  adjacentReleasedRestReload.score,
  "keyboard",
  16,
  ".",
  {
    braceMode: adjacentReleasedRestOptions.braceMode,
    bracketMode: adjacentReleasedRestOptions.bracketMode ?? "triplet",
    barMode: adjacentReleasedRestOptions.barMode ?? "grace",
    angleMode: adjacentReleasedRestOptions.angleMode ?? "none",
    parenMode: adjacentReleasedRestOptions.parenMode ?? "chord",
    compactSubdivision: true,
    durationNotation: adjacentReleasedRestOptions,
  },
  2,
);
const adjacentReleasedLeftPrefix = `(V${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G).${SLASH_VOICE_SEPARATOR}0${SLASH_VOICE_SEPARATOR}A`;
check(adjacentReleasedLeftSaved.includes(adjacentReleasedLeftPrefix),
  `Alt+Left moved the released zero into the default voice:\n${adjacentReleasedLeftSaved}`);

// Moving the first V1 A left when the source has no written rest creates one
// V1 half-cell rest at the vacated edge.  The compact serializer used to add a
// second visible default-voice zero only to advance the shared fine grid,
// yielding `A0⁣0N`; invisible padding must keep the text at one real `0`.
const directAltLeftText = `键盘谱
4/4拍：
. = 16分音符
(V${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G).${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N.(${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G)./.${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N.${SLASH_VOICE_SEPARATOR}A./(B${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G).${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N.(${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G)./.${SLASH_VOICE_SEPARATOR}N.${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N./
`;
const directAltLeftOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(directAltLeftText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 },
  noteDivision: null,
  showExplicitRests: true,
};
const directAltLeftScore = parseSlashScore(directAltLeftText, directAltLeftOptions).score;
const directAltLeftA = directAltLeftScore.parts[0]!.measures[0]!.entries
  .find((entry): entry is Chord => entry instanceof Chord
    && !entry.rest
    && entry.position.equals(new Fraction(1, 4)))
  ?.notes.find((note) => !note.rest);
check(directAltLeftA, "direct Alt+Left fixture did not contain its first V1 A");
check(moveScoreNotesOnTimeline(
  directAltLeftScore,
  [{ partIndex: 0, note: directAltLeftA, grace: false }],
  new Fraction(-1, 8),
  { preserveRests: true, moveWholeTieChain: true },
).changed === 1, "direct V1 A could not move left by one 32nd");
const directAltLeftSaved = scoreToSlashScore(
  directAltLeftScore,
  "keyboard",
  16,
  ".",
  {
    braceMode: directAltLeftOptions.braceMode,
    bracketMode: directAltLeftOptions.bracketMode ?? "triplet",
    barMode: directAltLeftOptions.barMode ?? "grace",
    angleMode: directAltLeftOptions.angleMode ?? "none",
    parenMode: directAltLeftOptions.parenMode ?? "chord",
    compactSubdivision: true,
    durationNotation: directAltLeftOptions,
  },
  2,
);
const directAltLeftVisible = stripSlashVoiceMarkers(directAltLeftSaved);
check(directAltLeftVisible.includes("(VDG)A.0N.(DG)./")
  && !directAltLeftVisible.includes("(VDG)A.00N"),
`direct Alt+Left wrote a visible padding rest:\n${directAltLeftSaved}`);
const directAltLeftReload = parseSlashScore(directAltLeftSaved, directAltLeftOptions);
const directAltLeftReloadRests = directAltLeftReload.score.parts.map((part) =>
  part.measures[0]!.entries.filter((entry): entry is Chord =>
    entry instanceof Chord && entry.rest));
check(directAltLeftReload.summary.diagnostics.every((item) => item.severity !== "error")
  && directAltLeftReloadRests[0]?.length === 1
  && directAltLeftReloadRests[0]![0]!.position.equals(new Fraction(3, 8))
  && directAltLeftReloadRests[0]![0]!.duration?.equals(new Fraction(1, 8))
  && directAltLeftReloadRests[1]?.length === 0,
`direct Alt+Left did not round-trip one V1 rest:\n${directAltLeftSaved}`);

// A fine V1 attack can be sandwiched between two fine rests. Moving it left
// consumes the first rest and fuses the released cells on its right; moving it
// right does the mirror image. Both results contain one written 16th rest
// (`0.`), never two visible zero atoms, and must remain a complete 4/4 beat.
const sandwichedAltText = `键盘谱
4/4拍：
. = 16分音符
(V${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G)${SLASH_VOICE_SEPARATOR}0${SLASH_VOICE_SEPARATOR}A${SLASH_VOICE_SEPARATOR}0${SLASH_VOICE_SEPARATOR}N.(${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G)./.${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N.${SLASH_VOICE_SEPARATOR}A./(B${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G).${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N.(${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G)./.${SLASH_VOICE_SEPARATOR}N.${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N./
`;
const sandwichedAltOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(sandwichedAltText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 },
  noteDivision: null,
  showExplicitRests: true,
};
const serializeSandwichedAlt = (direction: -1 | 1): string => {
  const parsed = parseSlashScore(sandwichedAltText, sandwichedAltOptions).score;
  const attack = parsed.parts[0]!.measures[0]!.entries
    .find((entry): entry is Chord => entry instanceof Chord
      && !entry.rest
      && entry.position.equals(new Fraction(1, 4)))
    ?.notes.find((note) => !note.rest);
  check(attack, `sandwiched Alt ${direction} fixture lost A`);
  check(moveScoreNotesOnTimeline(
    parsed,
    [{ partIndex: 0, note: attack, grace: false }],
    new Fraction(direction, 8),
    { preserveRests: true, moveWholeTieChain: true },
  ).changed === 1, `sandwiched A could not move ${direction < 0 ? "left" : "right"}`);
  return scoreToSlashScore(parsed, "keyboard", 16, ".", {
    braceMode: sandwichedAltOptions.braceMode,
    bracketMode: sandwichedAltOptions.bracketMode ?? "triplet",
    barMode: sandwichedAltOptions.barMode ?? "grace",
    angleMode: sandwichedAltOptions.angleMode ?? "none",
    parenMode: sandwichedAltOptions.parenMode ?? "chord",
    compactSubdivision: true,
    durationNotation: sandwichedAltOptions,
  }, 2);
};
const sandwichedAltLeftSaved = serializeSandwichedAlt(-1);
const sandwichedAltRightSaved = serializeSandwichedAlt(1);
check(stripSlashVoiceMarkers(sandwichedAltLeftSaved).includes("(VDG)A0.N.(DG)./")
  && stripSlashVoiceMarkers(sandwichedAltRightSaved).includes("(VDG)0.AN.(DG)./"),
`sandwiched Alt movement did not fuse its rests:\n${sandwichedAltLeftSaved}\n${sandwichedAltRightSaved}`);
for (const [label, saved, restPosition] of [
  ["left", sandwichedAltLeftSaved, new Fraction(1, 4)],
  ["right", sandwichedAltRightSaved, new Fraction(1, 8)],
] as const) {
  const reloaded = parseSlashScore(saved, sandwichedAltOptions);
  const rests = reloaded.score.parts[0]!.measures[0]!.entries.filter(
    (entry): entry is Chord => entry instanceof Chord && entry.rest,
  );
  check(reloaded.summary.diagnostics.every((item) => item.severity !== "error")
    && rests.length === 1
    && rests[0]!.position.equals(restPosition)
    && rests[0]!.duration?.equals(new Fraction(1, 4)),
  `sandwiched Alt ${label} changed its beat length or rest value:\n${saved}`);
}

// Consuming the fine A immediately after a shared chord leaves a 32nd cell
// beside an existing 16th rest. They are one dotted-16th rest (3/32), not a
// short beat and not two separate zeros.
const dottedRestMergeText = `键盘谱
4/4拍：
. = 16分音符
(V${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G)${SLASH_VOICE_SEPARATOR}A${SLASH_VOICE_SEPARATOR}0.${SLASH_VOICE_SEPARATOR}N${SLASH_VOICE_SEPARATOR}0(${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G)./.${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N.${SLASH_VOICE_SEPARATOR}A./(B${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G).${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N.(${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G)./.${SLASH_VOICE_SEPARATOR}N.${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N./
`;
const dottedRestMergeOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(dottedRestMergeText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 },
  noteDivision: null,
  showExplicitRests: true,
};
const dottedRestMergeScore = parseSlashScore(
  dottedRestMergeText,
  dottedRestMergeOptions,
).score;
const dottedRestMergeA = dottedRestMergeScore.parts[0]!.measures[0]!.entries
  .find((entry): entry is Chord => entry instanceof Chord
    && !entry.rest
    && entry.position.equals(new Fraction(1, 8)))
  ?.notes.find((note) => !note.rest);
check(dottedRestMergeA, "dotted-rest merge fixture did not contain its fine A");
check(moveScoreNotesOnTimeline(
  dottedRestMergeScore,
  [{ partIndex: 0, note: dottedRestMergeA, grace: false }],
  new Fraction(-1, 8),
  { preserveRests: true, moveWholeTieChain: true },
).changed === 1, "fine A could not join the opening shared chord");
const dottedRestMergeSaved = scoreToSlashScore(
  dottedRestMergeScore,
  "keyboard",
  16,
  ".",
  {
    braceMode: dottedRestMergeOptions.braceMode,
    bracketMode: dottedRestMergeOptions.bracketMode ?? "triplet",
    barMode: dottedRestMergeOptions.barMode ?? "grace",
    angleMode: dottedRestMergeOptions.angleMode ?? "none",
    parenMode: dottedRestMergeOptions.parenMode ?? "chord",
    compactSubdivision: true,
    durationNotation: dottedRestMergeOptions,
  },
  2,
);
const dottedRestMergeReload = parseSlashScore(dottedRestMergeSaved, dottedRestMergeOptions);
const mergedDottedRest = dottedRestMergeReload.score.parts[0]!.measures[0]!.entries.find(
  (entry): entry is Chord => entry instanceof Chord
    && entry.rest
    && entry.position.equals(new Fraction(1, 8)),
);
check(stripSlashVoiceMarkers(dottedRestMergeSaved).includes("(VADG)0.N0(DG)./")
  && dottedRestMergeReload.summary.diagnostics.every((item) => item.severity !== "error")
  && mergedDottedRest?.duration?.equals(new Fraction(3, 8))
  && mergedDottedRest.beams === 2
  && mergedDottedRest.dot === 1,
`32nd + 16th rests did not round-trip as one dotted 16th:\n${dottedRestMergeSaved}`);

// Moving the default-voice V out of a shared opening chord leaves a fine rest
// in that voice while the first voice's existing dotted-16th rest must remain
// exactly 3/32.  The following slash group also starts with one continuation
// half-cell before both voices become rests.  Neither cell may be serialized
// as a visible padding zero, and every sounding tie chain must round-trip.
const sharedChordDottedRestText = `键盘谱
4/4拍：
. = 16分音符
(V${SLASH_VOICE_SEPARATOR}A${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G)${SLASH_VOICE_SEPARATOR}0${SLASH_VOICE_SEPARATOR}.${SLASH_VOICE_SEPARATOR}N.(${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G)./${SLASH_VOICE_SEPARATOR}${SLASH_VOICE_SEPARATOR}0${SLASH_VOICE_SEPARATOR}0${SLASH_VOICE_SEPARATOR}A${SLASH_VOICE_SEPARATOR}0${SLASH_VOICE_SEPARATOR}N.${SLASH_VOICE_SEPARATOR}A./(B${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G).${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N.(${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G)./.${SLASH_VOICE_SEPARATOR}N.${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N./
`;
const sharedChordDottedRestOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(sharedChordDottedRestText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 },
  noteDivision: null,
  showExplicitRests: true,
};
const sharedChordDottedRestScore = parseSlashScore(
  sharedChordDottedRestText,
  sharedChordDottedRestOptions,
).score;
const sharedChordV = sharedChordDottedRestScore.parts[1]!.measures[0]!.entries.find((entry) =>
  entry instanceof Chord && !entry.rest && entry.position.equals(new Fraction(0))) as Chord | undefined;
check(sharedChordV?.notes[0], "shared-chord fixture did not contain its opening V");
check(moveScoreNotesOnTimeline(
  sharedChordDottedRestScore,
  [{ partIndex: 1, note: sharedChordV.notes[0]!, grace: false }],
  new Fraction(1, 8),
  { preserveRests: true, moveWholeTieChain: true },
).changed === 1, "opening V could not move right by one 32nd");
const sharedChordMovedTimeline = JSON.stringify(buildTimeline(sharedChordDottedRestScore).notes
  .map((note) => [note.part, note.pitch, note.t0, note.t1]));
const sharedChordDottedRestSaved = scoreToSlashScore(
  sharedChordDottedRestScore,
  "keyboard",
  16,
  ".",
  {
    braceMode: sharedChordDottedRestOptions.braceMode,
    bracketMode: sharedChordDottedRestOptions.bracketMode ?? "triplet",
    barMode: sharedChordDottedRestOptions.barMode ?? "grace",
    angleMode: sharedChordDottedRestOptions.angleMode ?? "none",
    parenMode: sharedChordDottedRestOptions.parenMode ?? "chord",
    compactSubdivision: true,
    durationNotation: sharedChordDottedRestOptions,
  },
  2,
);
const sharedChordDottedRestReload = parseSlashScore(
  sharedChordDottedRestSaved,
  sharedChordDottedRestOptions,
);
const sharedChordReloadedDottedRest = sharedChordDottedRestReload.score.parts[0]!
  .measures[0]!.entries.find((entry) => entry instanceof Chord
    && entry.rest
    && entry.position.equals(new Fraction(1, 8))) as Chord | undefined;
check(sharedChordDottedRestReload.summary.diagnostics.every((item) => item.severity !== "error")
  && sharedChordReloadedDottedRest?.duration?.equals(new Fraction(3, 8))
  && JSON.stringify(buildTimeline(sharedChordDottedRestReload.score).notes
    .map((note) => [note.part, note.pitch, note.t0, note.t1])) === sharedChordMovedTimeline,
`Alt+Right from a shared chord shortened a dotted rest or tie chain:\n${sharedChordDottedRestSaved}\n${JSON.stringify(sharedChordDottedRestReload.summary.diagnostics)}`);
check(stripSlashVoiceMarkers(sharedChordDottedRestSaved)
  .includes("(0ADG)(0V).N.(DG)./(00)A0N.A0/"),
`Alt+Right wrote a visible padding zero at the next beat:\n${sharedChordDottedRestSaved}`);

// Moving one default-voice pitch out of a cross-voice chord must retain its
// half-cell value in TXT.  An unmarked `V` between two explicitly marked V1
// pitches is otherwise ambiguous with an ordinary cross-voice sequence and
// used to leave the first beat only 0.75 quarters long after reload.
const crossVoiceFineMoveText = `键盘谱
4/4拍：
点=16分音符
(0${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G).${SLASH_VOICE_SEPARATOR}A.(V${SLASH_VOICE_SEPARATOR}N).(${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G)./0.${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N.${SLASH_VOICE_SEPARATOR}A./(B${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G).${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N.(${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G)./.${SLASH_VOICE_SEPARATOR}N.${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N./
`;
const crossVoiceFineMoveOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(crossVoiceFineMoveText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 },
  noteDivision: null,
  showExplicitRests: true,
};
const crossVoiceFineMoveScore = parseSlashScore(
  crossVoiceFineMoveText,
  crossVoiceFineMoveOptions,
).score;
const crossVoiceFineMoveV1 = JSON.stringify(buildTimeline(crossVoiceFineMoveScore).notes
  .filter((note) => note.part === 0)
  .map((note) => [note.pitch, note.t0, note.t1]));
const crossVoiceFineMoveChord = crossVoiceFineMoveScore.parts[1]!.measures[0]!.entries.find((entry) =>
  entry instanceof Chord && !entry.rest && entry.position.equals(new Fraction(1, 2))) as Chord | undefined;
check(crossVoiceFineMoveChord?.notes[0], "cross-voice fixture did not contain the first default-voice V");
check(moveScoreNotesOnTimeline(
  crossVoiceFineMoveScore,
  [{ partIndex: 1, note: crossVoiceFineMoveChord.notes[0]!, grace: false }],
  new Fraction(-1, 8),
  { preserveRests: true, moveWholeTieChain: true },
).changed === 1, "default-voice V could not move left by one 32nd");
const crossVoiceFineMoveSaved = scoreToSlashScore(
  crossVoiceFineMoveScore,
  "keyboard",
  16,
  ".",
  {
    braceMode: crossVoiceFineMoveOptions.braceMode,
    bracketMode: crossVoiceFineMoveOptions.bracketMode ?? "triplet",
    barMode: crossVoiceFineMoveOptions.barMode ?? "grace",
    angleMode: crossVoiceFineMoveOptions.angleMode ?? "none",
    parenMode: crossVoiceFineMoveOptions.parenMode ?? "chord",
    compactSubdivision: true,
    durationNotation: crossVoiceFineMoveOptions,
  },
  2,
);
const crossVoiceFineMoveReload = parseSlashScore(
  crossVoiceFineMoveSaved,
  crossVoiceFineMoveOptions,
);
const movedVSource = slashPitchSources(
  crossVoiceFineMoveSaved,
  crossVoiceFineMoveOptions,
).find((source) => crossVoiceFineMoveSaved.slice(source.from, source.to) === "V");
check(movedVSource?.voiceIndex === 2
  && movedVSource.markerCount === 2,
"the moved V lost its selectable default-voice TXT source mapping");
check(crossVoiceFineMoveReload.summary.diagnostics.every((item) => item.severity !== "error"),
  `moving the default-voice V left broke its beat:\n${crossVoiceFineMoveSaved}\n${JSON.stringify(crossVoiceFineMoveReload.summary.diagnostics)}`);
check(JSON.stringify(buildTimeline(crossVoiceFineMoveReload.score).notes
  .filter((note) => note.part === 0)
  .map((note) => [note.pitch, note.t0, note.t1])) === crossVoiceFineMoveV1,
"moving the default-voice V altered V1");
check(crossVoiceFineMoveReload.score.parts[1]!.measures[0]!.entries.some((entry) =>
  entry instanceof Chord && !entry.rest && entry.position.equals(new Fraction(3, 8))),
"the moved default-voice V did not round-trip at the preceding 32nd grid line");

// Reproduce the reported real score exactly and commit every Ctrl edit through
// TXT before applying the next one. A single in-memory resize is insufficient:
// the app reparses after every key press, so the released rest and tie tail
// must remain editable after each serialization boundary.
const repeatedFineText = `键盘谱
4/4拍：
点=16分音符
(N${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G).${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N.(${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G)./.${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N.${SLASH_VOICE_SEPARATOR}A./(${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G).${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N.(${SLASH_VOICE_SEPARATOR}D${SLASH_VOICE_SEPARATOR}G)./.${SLASH_VOICE_SEPARATOR}A.${SLASH_VOICE_SEPARATOR}N../
`;
const repeatedFineOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(repeatedFineText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 },
  noteDivision: null,
  showExplicitRests: true,
};
let repeatedFineScore = parseSlashScore(repeatedFineText, repeatedFineOptions).score;
const repeatedFineHistory: string[] = [];
const repeatedFineV1Signature = JSON.stringify(buildTimeline(repeatedFineScore).notes
  .filter((note) => note.part === 0)
  .map((note) => [note.pitch, note.t0, note.t1]));
const repeatedFineInitialNSpan = (() => {
  const note = buildTimeline(repeatedFineScore).notes.find((item) =>
    item.part === 1 && Math.abs(item.t0) < 1e-8);
  return note ? note.t1 - note.t0 : -1;
})();
const repeatedFineDeltas = [
  ...Array.from({ length: 10 }, () => new Fraction(-1, 8)),
  ...Array.from({ length: 10 }, () => new Fraction(1, 8)),
];
for (const [stepIndex, delta] of repeatedFineDeltas.entries()) {
  const rootChord = repeatedFineScore.parts[1]!.measures[0]!.entries.find((entry) =>
    entry instanceof Chord && !entry.rest && entry.position.equals(new Fraction(0))) as Chord | undefined;
  check(rootChord?.notes[0], `repeated 32nd edit ${stepIndex + 1} lost the default-voice N root`);
  const resized = resizeScoreNoteSegmentsWithRests(
    repeatedFineScore,
    [{ partIndex: 1, note: rootChord.notes[0]!, grace: false }],
    delta,
  );
  check(resized.changed === 1,
    `repeated 32nd edit ${stepIndex + 1} could not ${delta.compareTo(0) < 0 ? "shorten" : "extend"} N`);
  const saved = scoreToSlashScore(
    repeatedFineScore,
    "keyboard",
    16,
    ".",
    {
      braceMode: repeatedFineOptions.braceMode,
      bracketMode: repeatedFineOptions.bracketMode ?? "triplet",
      barMode: repeatedFineOptions.barMode ?? "grace",
      angleMode: repeatedFineOptions.angleMode ?? "none",
      parenMode: repeatedFineOptions.parenMode ?? "chord",
      compactSubdivision: true,
      durationNotation: repeatedFineOptions,
    },
    2,
  );
  repeatedFineHistory.push(saved);
  const reloaded = parseSlashScore(saved, repeatedFineOptions);
  check(reloaded.summary.diagnostics.every((item) => item.severity !== "error"),
    `repeated 32nd edit ${stepIndex + 1} changed the bar duration:\n${repeatedFineHistory.join("\n---\n")}\n${JSON.stringify(reloaded.summary.diagnostics)}`);
  check(JSON.stringify(buildTimeline(reloaded.score).notes
    .filter((note) => note.part === 0)
    .map((note) => [note.pitch, note.t0, note.t1])) === repeatedFineV1Signature,
  `repeated 32nd edit ${stepIndex + 1} altered the untouched V1 timeline`);
  repeatedFineScore = reloaded.score;
}
const repeatedFineFinalN = buildTimeline(repeatedFineScore).notes.find((item) =>
  item.part === 1 && Math.abs(item.t0) < 1e-8);
check(repeatedFineFinalN !== undefined
  && Math.abs((repeatedFineFinalN.t1 - repeatedFineFinalN.t0) - repeatedFineInitialNSpan) < 1e-8,
"repeated 32nd shrinks followed by matching extensions did not restore the original N span");
}

// The new wave/mordent spelling is a bracket group with an external ordinary
// duration marker.  Its helper pitches are ornamental only; metadata decides
// the voice and the enclosing beat remains complete.  A bracket without that
// annotation remains a real three-note triplet.
const mordentMarker = SLASH_VOICE_SEPARATOR;
const waveText = `键盘谱
4/4拍：
点=16分音符
// @jpeditor {"v":2,"vc":2,"k":"k","an":[{"type":"ornament","part":0,"measure":0,"offset":0.25,"kind":"upper-mordent"}]}
(V${mordentMarker}D${mordentMarker}G).${mordentMarker}[${mordentMarker}A${mordentMarker}S${mordentMarker}A].${mordentMarker}N.(D${mordentMarker}G)./.${mordentMarker}A.${mordentMarker}N.${mordentMarker}A./
`;
const waveResult = parseSlashScore(waveText, {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(waveText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 as const },
  noteDivision: null,
  annotations: [{ type: "ornament", part: 0, measure: 0, offset: 0.25, kind: "upper-mordent" }],
});
check(waveResult.summary.diagnostics.every((item) => item.severity !== "error"),
  `wave spelling changed the enclosing beat: ${JSON.stringify(waveResult.summary.diagnostics)}`);
check(waveResult.score.parts[0]!.measures[0]!.entries.some((entry) =>
  entry instanceof Chord && entry.ornaments.some((item) => item.kind === "upper-mordent"))
  && !waveResult.score.parts[1]!.measures[0]!.entries.some((entry) =>
    entry instanceof Chord && entry.position.equals(new Fraction(1, 4))),
  "wave spelling moved its ornament or following V1 attack into the other voice");

// A direct metadata-backed `[ASA].` wave is one decorated V1 attack.  Its S
// and return A are playback helpers, not source events: exposing all three
// shifts every following event index, causing red V1 notes to map onto V2 or
// lose their rendered voice colour even though the parsed score is correct.
const directWaveText = `键盘谱
4/4拍：
点=16分音符
// @jpeditor {"v":2,"vc":2,"k":"k","an":[{"type":"ornament","part":0,"measure":0,"offset":0.25,"kind":"upper-mordent"}]}
(V${mordentMarker}D${mordentMarker}G).[${mordentMarker}A${mordentMarker}S${mordentMarker}A].${mordentMarker}N.(${mordentMarker}D${mordentMarker}G)./.${mordentMarker}A.${mordentMarker}N.${mordentMarker}A./(B${mordentMarker}D${mordentMarker}G).${mordentMarker}A.${mordentMarker}N.(${mordentMarker}D${mordentMarker}G)./.${mordentMarker}N.${mordentMarker}A.${mordentMarker}N./
`;
const directWaveOptions: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(directWaveText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 },
  noteDivision: null,
};
const directWaveScore = parseSlashScore(directWaveText, directWaveOptions).score;
const directWaveSources = slashPitchSources(directWaveText, directWaveOptions);
const directWaveOpen = directWaveText.lastIndexOf("[");
const directWaveClose = directWaveText.indexOf("]", directWaveOpen);
const directWaveHelperSources = directWaveSources.filter((source) =>
  source.from > directWaveOpen && source.to <= directWaveClose);
check(directWaveHelperSources.length === 1
  && directWaveHelperSources[0]!.voiceIndex === 1,
"a direct semantic mordent exposed its S/return-A helpers as real source events");
const directWaveMapped = buildSlashSourceNotes(
  directWaveText,
  directWaveOptions,
  directWaveScore,
);
check(directWaveMapped.filter((source) => source.voiceIndex === 1)
  .every((source) => source.partIndex === 0)
  && directWaveScore.parts[0]!.measures[0]!.entries.some((entry) =>
    entry instanceof Chord && !entry.rest
      && entry.position.equals(new Fraction(1, 2)))
  && !directWaveScore.parts[1]!.measures[0]!.entries.some((entry) =>
    entry instanceof Chord && !entry.rest
      && (entry.position.equals(new Fraction(1, 4))
        || entry.position.equals(new Fraction(1, 2))
        || entry.position.equals(new Fraction(3, 4)))),
"a direct V1 mordent shifted following coloured notes into the default voice");

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
