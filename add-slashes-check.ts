import { analyzeAddSlashes, convertAddSlashes, projectSourceTimedRows, reencodeSourceTimedRows, type AddSlashesOptions } from "./src/slashscore/add-slashes";
import { analyzeSlashScore, embedSlashScoreOptions, migrateSlashVoiceCount, parseSlashScore, slashPitchSources, SLASH_VOICE_SEPARATOR } from "./src/slashscore";
import { buildTimeline } from "./src/score/timeline";

function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const settings: AddSlashesOptions = { beats: 4, beatType: 4, symbolDurations: { "+": 4, "-": 8, "=": 16 }, noteDivision: null, adjacentAsChord: true };
function convert(text: string, extra: AddSlashesOptions = {}) {
  const result = convertAddSlashes(text, { ...settings, ...extra });
  check(result.canImport, `conversion: ${text}\n${result.errors.join("\n")}\n${result.text}`);
  return { result, notes: buildTimeline(parseSlashScore(result.text, result.options).score).notes };
}
function attacks(text: string, extra: AddSlashesOptions = {}) {
  const { notes } = convert(text, extra);
  return [...new Map(notes.map((note) => [`${note.t0}:${note.t1}`, { at: note.t0, duration: note.t1 - note.t0 }])).values()];
}
const mixed = attacks("VNAY-=R=-E-BMSW-J-W-Y-");
check(JSON.stringify(mixed.map((note) => note.duration)) === JSON.stringify([0.75, 0.75, 0.5, 0.5, 0.5, 0.5, 0.5]), "mixed symbol durations");
const literalSource = "QV+-JA+-QF+++++";
const inferred = analyzeAddSlashes(literalSource, { beats: 4, beatType: 4 }).durationCandidates[0];
check(inferred.symbolDurations["+"] === 8 && inferred.symbolDurations["-"] === 16, "one raw row one bar beats the old two-bar interpretation");
const held = attacks(literalSource, { symbolDurations: inferred.symbolDurations });
check(JSON.stringify(held.map((note) => note.duration)) === JSON.stringify([0.75, 0.75, 2.5]), "inferred literal durations survive boundaries within symbols");
check(held[2].at === 1.5, "held chord begins once at inferred offset");
const literal = convert(literalSource, { symbolDurations: inferred.symbolDurations });
const reencoded = reencodeSourceTimedRows(literal.result.text, literal.result.options,
  { ...literal.result.options, symbolDurations: { ".": 32 }, multiDurationSymbols: false });
check(reencoded.canImport, `reencoding preserves literal durations: ${reencoded.errors.join(";")}`);
check(reencoded.text === literal.result.text.replace(/\+/g, "....").replace(/-/g, ".."), "each plus eight becomes four dots thirty-two; each minus sixteen becomes two dots");
check(JSON.stringify(buildTimeline(parseSlashScore(reencoded.text, reencoded.options).score).notes.map(({ pitch, t0, t1 }) => [pitch, t0, t1]))
  === JSON.stringify(literal.notes.map(({ pitch, t0, t1 }) => [pitch, t0, t1])), "rewritten duration symbols preserve the full playback timeline");
const coarse = reencodeSourceTimedRows(literal.result.text, literal.result.options,
  { ...literal.result.options, symbolDurations: { ".": 8 }, multiDurationSymbols: false });
check(!coarse.canImport && coarse.errors.some((error) => error.includes("至少 16 分")), "coarse target rejects indivisible original lengths with required shortest unit");
const differentGrids = convert(`${literalSource}\nA~`, { symbolDurations: { "+": 8, "-": 16, "~": 32 } });
const coarseDifferentGrids = reencodeSourceTimedRows(differentGrids.result.text, differentGrids.result.options,
  { ...differentGrids.result.options, symbolDurations: { ".": 8 }, multiDurationSymbols: false });
check(!coarseDifferentGrids.canImport && coarseDifferentGrids.errors.length === 1
  && coarseDifferentGrids.errors[0].includes("至少 32 分"), "coarse symbol error scans all rows and reports the globally finest required unit once");
const unchangedTiming = reencodeSourceTimedRows(literal.result.text, literal.result.options,
  { ...literal.result.options, title: "新标题", fifths: 2, beats: 3 });
check(unchangedTiming.canImport && unchangedTiming.text === literal.result.text
  && unchangedTiming.options.fifths === 2 && unchangedTiming.options.beats === 3, "non-timing settings retain exact text and target choices");
const multiReencoded = reencodeSourceTimedRows(literal.result.text, literal.result.options,
  { ...literal.result.options, symbolDurations: { "*": 8, ".": 16 }, multiDurationSymbols: true });
check(multiReencoded.canImport && multiReencoded.text === literal.result.text.replace(/\+/g, "*").replace(/-/g, "."), "multiple output symbols keep equivalent durations");
const doubleCheck = reencodeSourceTimedRows(literal.result.text, literal.result.options,
  { ...literal.result.options, symbolDurations: { ".": 32 }, multiDurationSymbols: false });
check(doubleCheck.text === reencoded.text, "successive preview rebuilds derive from immutable first-step text");
check(literal.result.text.replace(/\//g, "") === literalSource, "conversion changes only slashes, never chords or symbols");
check(parseSlashScore(literal.result.text, literal.result.options).score.parts[0].measures.length === 1, "source row produces one inferred bar");
const projected = projectSourceTimedRows(literal.result.text, literal.result.options);
check(projected.sourceOffsets.length === projected.text.length && projected.options.sourceTimedRows === false, "internal projection disables recursive literal parsing");
for (let index = 0; index < projected.text.length; index++) {
  const original = projected.sourceOffsets[index];
  if (original >= 0) check(projected.text[index] === literal.result.text[original], "projection pitch origins point to exact original character");
}
const pitchSources = slashPitchSources(literal.result.text, literal.result.options);
check(pitchSources.length === 6 && pitchSources.every((item) => /[QVJAF]/.test(literal.result.text.slice(item.from, item.to))), "mapped literal sources retain all six pitch letters");
const persisted = embedSlashScoreOptions(literal.result.text, literal.result.options);
const restored = parseSlashScore(persisted, literal.result.options);
const persistedAnalysis = analyzeSlashScore(persisted);
check(persistedAnalysis.sourceTimedRows === true && persistedAnalysis.adjacentAsChord === true
  && buildTimeline(restored.score).notes.length === 6, "literal grammar options persist in TXT metadata");
const pickup = attacks("E-T-\nVNAY-=R=-E-BMSW-J-W-Y-");
check(pickup[0].at === 3 && pickup[1].at === 3.5 && pickup[2].at === 4, "first short row has front rests to fill meter");
const lonePickup = attacks("A+B+");
check(lonePickup[0].at === 2 && lonePickup[1].at === 3, "single short row also gets front rests");
check(attacks("N++A++G++A++").length === 4, "adjacent attack groups separated by markers");
check(attacks("A++++++++++++").length === 1, "pure continuation measure remains audible without repeated attack");
const partialContinuation = attacks("A++++++++++++-=");
check(partialContinuation.length === 1 && partialContinuation[0].duration === 12.75, "last standalone partial continuation group survives source detection");
check(attacks("AA++++").length === 1, "duplicate chord keys are one pitch");
check(attacks("A+A+A+A+").length === 4, "same-key repeated attacks are preserved");
check(convert("0-A-B+C++").notes[0].t0 === 0.5, "explicit short rest uses its given duration");
const continuation = attacks("A+++B+\n-C+++D-");
check(continuation[1].duration === 1.5 && continuation[2].at === 4.5, "leading symbol continues previous row note");
const comments = convert("E++++\nA+\n说明文字\nB+C+D+ // inline comment\n速度999");
check(comments.notes.filter((note) => note.t0 === 5).length === 1, "comments do not break a buffered beat or measure");
check(comments.result.options.tempoBpm === 90 && comments.result.text.includes("\n速度999"), "tempo remains inert verbatim preserved prose");
check(comments.result.text.replace(/\//g, "").includes("说明文字\nB+C+D+  inline comment\n速度999"), "prose and comments stay at their original rows");
check(convert("A＋B＋C＋D＋").result.lineStats[0].quarterNotes === 4, "fullwidth plus normalization");
check(convert("(AB)+(CD)+(EF)+(GH)+").notes.length === 8, "explicit parentheses are chords");
const intrinsic = convert("ABCD", { noteDivision: 4, adjacentAsChord: false });
check(intrinsic.notes.length === 4 && intrinsic.result.options.noteDivision === 4, "source intrinsic duration stays explicit in options without rewriting text");
const intrinsicFine = reencodeSourceTimedRows(intrinsic.result.text, intrinsic.result.options,
  { ...intrinsic.result.options, symbolDurations: { ".": 32 }, multiDurationSymbols: false, noteDivision: 8 });
check(intrinsicFine.canImport && intrinsicFine.options.noteDivision === 8
  && buildTimeline(parseSlashScore(intrinsicFine.text, intrinsicFine.options).score).notes.every((note) => note.t1 - note.t0 === 1), "intrinsic value changes subtract target baseline for each sequential pitch");
const intrinsicOnly = convert("A+B+C+D+");
const intrinsicOnlyChanged = reencodeSourceTimedRows(intrinsicOnly.result.text, intrinsicOnly.result.options,
  { ...intrinsicOnly.result.options, symbolDurations: { ".": 32 }, multiDurationSymbols: false, noteDivision: 4 });
check(intrinsicOnlyChanged.canImport && !intrinsicOnlyChanged.text.includes("+")
  && buildTimeline(parseSlashScore(intrinsicOnlyChanged.text, intrinsicOnlyChanged.options).score).notes.length === 4, "markers removed by exact intrinsic values still separate successive attacks");
const excessiveIntrinsic = reencodeSourceTimedRows(literal.result.text, literal.result.options,
  { ...literal.result.options, symbolDurations: { ".": 32 }, noteDivision: 4 });
check(!excessiveIntrinsic.canImport && excessiveIntrinsic.errors.some((error) => error.includes("超过原音长")), "target intrinsic cannot silently enlarge shorter original attacks");
check(convert("(AB)(CD)(EF)(GH)", { noteDivision: 4 }).notes.length === 8, "symbol-free parenthesized chords can use intrinsic value");
const compound = attacks("A++++++", { beats: 6, beatType: 8 });
check(compound.length === 1 && compound[0].duration === 6, "compound dotted-quarter groups preserve long note");
check(!convertAddSlashes("A++B++\nCD", settings).canImport, "bare final chord with missing duration is never dropped");
check(!convertAddSlashes("A+(BC", settings).canImport, "unbalanced parentheses reject conversion");
check(!convertAddSlashes("A+[BCD]++", settings).canImport, "special parentheses are not guessed as tuplets");
check(!convertAddSlashes("A+/B+/C+/D+/", settings).canImport, "existing slash score cannot be converted twice");
check(!convertAddSlashes("A+B+C+D+", { ...settings, symbolDurations: {} }).canImport, "cleared mapping is authoritative");
check(analyzeAddSlashes("A?B?C?D?", settings).observedSymbols.includes("?"), "unknown symbols remain visible for manual mapping");
check(analyzeAddSlashes("(AB)(CD)(EF)(GH)").detected, "symbol-free explicit chords still detected");
check(!convertAddSlashes("1+2-3=", { ...settings, kind: "number" }).canImport, "numeric octave/duration ambiguity requires explicit opt-in");
check(convert("1+2+3+4+", { kind: "number", numberPlusMinusAsDurations: true }).notes.length === 4, "numeric duration opt-in");
const ambiguous = analyzeAddSlashes("A++B++C++D++\nE++F++G++H++", { beats: null, symbolDurations: { "+": 4 } });
check(ambiguous.meterCandidates.some((meter) => meter.beats === 4 && meter.beatType === 4)
  && ambiguous.meterCandidates.some((meter) => meter.beats === 2 && meter.beatType === 4), "meter evidence remains non-unique");
check(analyzeAddSlashes("A++B++", { beats: 4 }).durationCandidates.length > 1, "known meter gives bounded duration alternatives");
check(!analyzeAddSlashes("TITLE\n速度50\n50\nEND").detected, "prose and tempo are not scores");
check(!convertAddSlashes("A+K+\nB+C+D+", settings).canImport, "invalid key names in score-like rows are errors, not discarded prose");
const unknownCandidates = analyzeAddSlashes("A*B*C*D*", { beats: 4, symbolDurations: {} }).durationCandidates;
check(unknownCandidates.some((candidate) => candidate.symbolDurations["*"] === 4), "unknown symbol values can be enumerated from supplied meter");
const sequentialCandidates = analyzeAddSlashes("AB(CD)E", { beats: 4 }).durationCandidates;
check(sequentialCandidates.some((candidate) => !candidate.adjacentAsChord && candidate.noteDivision !== null), "parentheses enable separate bare-note intrinsic candidates");
check(JSON.stringify(convert("A+B+C+D+").result.options.symbolDurations) === JSON.stringify(settings.symbolDurations), "literal output mapping cannot introduce aliases");
check(analyzeAddSlashes("A+B+C+D+", { beats: null }).durationCandidates.length === 0, "unknown meter cannot invent default symbol units");
const arbitrary = analyzeAddSlashes("A**B**C**D**", { beats: 4 }).durationCandidates[0];
check(arbitrary.symbolDurations["*"] === 8, "actual arbitrary symbol is inferred from one-row bar without a name prior");
const emojiSource = "A😀B😀C😀D😀";
const emoji = convert(emojiSource, { symbolDurations: { "😀": 4 } });
check(emoji.result.text.replace(/\//g, "") === emojiSource, "non-BMP duration symbols are not split when inserting slashes");
check(slashPitchSources(emoji.result.text, emoji.result.options).every((item) => /^[ABCD]$/.test(emoji.result.text.slice(item.from, item.to))), "UTF16 source offsets remain exact after non-BMP symbols");
const voiceText = literal.result.text.replace(/^Q/, `${SLASH_VOICE_SEPARATOR}Q`);
const voiceOptions = { ...literal.result.options, voiceCount: 2 };
const voiceProjection = projectSourceTimedRows(voiceText, voiceOptions);
check(voiceProjection.text.includes(`${SLASH_VOICE_SEPARATOR}Q`), "voice prefixes are passed through internal projection");
check(slashPitchSources(voiceText, voiceOptions)[0].voiceIndex === 1, "original voice ownership survives projected source mapping");
const migratedVoice = migrateSlashVoiceCount(voiceText, voiceOptions, 3);
check(parseSlashScore(migratedVoice.text, migratedVoice.options).summary.ignoredCharacters === 0, "voice migration markers are syntax rather than duration symbols");
const spaces = convert("A B C D", { symbolDurations: {}, noteDivision: 8, spaceDivision: 8, adjacentAsChord: false });
check(spaces.notes[0].t0 === 0.5 && spaces.notes[0].t1 === 1.5, "configured literal spaces contribute duration and projection precision");
const adjustedSpaces = reencodeSourceTimedRows(spaces.result.text, spaces.result.options,
  { ...spaces.result.options, symbolDurations: { ".": 32 }, multiDurationSymbols: false, spaceDivision: 16 });
check(adjustedSpaces.canImport && adjustedSpaces.options.spaceDivision === 16
  && adjustedSpaces.options.noteDivision === 8, "target intrinsic and space options are retained when exact source timing can be spelled");
check(JSON.stringify(buildTimeline(parseSlashScore(adjustedSpaces.text, adjustedSpaces.options).score).notes.map(({ pitch, t0, t1 }) => [pitch, t0, t1]))
  === JSON.stringify(spaces.notes.map(({ pitch, t0, t1 }) => [pitch, t0, t1])), "space changes compensate duration symbols and preserve first-step padding");
const parenthesizedSpaces = convert("(A B)+(C D)+(E F)+(G H)+", { noteDivision: null, spaceDivision: null });
const innerSpaceChange = reencodeSourceTimedRows(parenthesizedSpaces.result.text, parenthesizedSpaces.result.options,
  { ...parenthesizedSpaces.result.options, symbolDurations: { ".": 32 }, multiDurationSymbols: false, spaceDivision: 8 });
check(innerSpaceChange.canImport && innerSpaceChange.options.spaceDivision === 8, "newly configured inner chord spaces count once and compensate rewritten markers");
const proseReencodeSource = convert("标题\r\n  A＋B＋C＋D＋ ; 保留＋注释\r\n// A+ 不参与换写");
const proseReencoded = reencodeSourceTimedRows(proseReencodeSource.result.text, proseReencodeSource.result.options,
  { ...proseReencodeSource.result.options, symbolDurations: { "😀": 16 }, multiDurationSymbols: false });
check(proseReencoded.canImport && proseReencoded.text.includes("标题\r\n  A😀😀😀😀/")
  && proseReencoded.text.includes(" ; 保留＋注释\r\n// A+ 不参与换写"), "CRLF indentation Unicode target and untouched source comments survive reencoding");
const persistedReencoded = embedSlashScoreOptions(reencoded.text, reencoded.options);
check(analyzeSlashScore(persistedReencoded).sourceTimedRows === true
  && analyzeSlashScore(persistedReencoded).suggestedMappings["."] === 32,
  "saving rewritten source grammar records target alphabet for reimport");
const absentParenthesis = projectSourceTimedRows(literal.result.text, { ...literal.result.options, parenMode: "arpeggio" });
check(absentParenthesis.text.length > 0, "unrelated parenthesis settings cannot reject text without parentheses");
let specialParenError = "";
try { projectSourceTimedRows("(AB)+/C+++/", { ...literal.result.options, parenMode: "triplet" }); }
catch (error) { specialParenError = String(error); }
check(specialParenError.includes("圆括号") && specialParenError.includes("和弦"), "actual unsupported bracket semantics produce explicit error instead of silently changing behavior");
check(analyzeAddSlashes("A===B===C===D===\nZBADGQ", { beats: 4 }).durationCandidates.length === 0, "all zero-evidence candidates are never arbitrary automatic defaults");
check(!convertAddSlashes("A+B+C+D+", { ...settings,
  symbolDurations: { "+": 16, ".": 4, "_": 4, "~": 4, ":": 4, "*": 4, "·": 4 } }).canImport,
"exhausted continuation symbols return a draft error without throwing");
console.log("add-slashes checks passed");
