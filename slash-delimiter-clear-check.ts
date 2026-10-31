import { Chord } from "./src/score/score";
import { buildTimeline } from "./src/score/timeline";
import { buildSlashSourceNotes } from "./src/editor/note-selection";
import { clearSlashDelimiters, defaultSlashScoreOptions, embedSlashScoreOptions,
  parseSlashScore, scoreToSlashScore, slashPitchSources, slashScoreDiagnostics,
  SLASH_VOICE_SEPARATOR, type SlashScoreOptions } from "./src/slashscore";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const base: SlashScoreOptions = { ...defaultSlashScoreOptions("keyboard"),
  beats: 4, beatType: 4, symbolDurations: { ".": 16 }, multiDurationSymbols: true,
  noteDivision: null, spaceDivision: null, wholeMeasureGroups: false };
const bare = { ...base, braceMode: "none" as const, bracketMode: "none" as const,
  parenMode: "none" as const, angleMode: "none" as const, barMode: "none" as const };
const tones = (text: string, options: SlashScoreOptions) => parseSlashScore(text, options).score.parts
  .flatMap(part => part.measures.flatMap(measure => measure.entries
    .filter((entry): entry is Chord => entry instanceof Chord && !entry.rest
      && !entry.transparentContinuation && entry.notes.some(note => !note.tiePrev))
    .map(entry => ({ at: measure.position.toFloat() + entry.position.toFloat(),
      duration: entry.duration?.toFloat(), pitches: entry.notes.map(note => note.pitch) }))));
const chordText = "键盘谱\nAB..../..../..../..../\n";
const clearedChord = clearSlashDelimiters(chordText.replace("AB", "(AB)"), base, bare);
check(clearedChord.removed === 1 && clearedChord.text === chordText, "clearing chord must remove physical parentheses");
const chords = tones(chordText, bare);
check(chords[0]?.pitches.length === 2 && chords[0].duration === 1, "bare adjacent notes must share one duration");
check(slashScoreDiagnostics(chordText, bare).every(item => item.severity !== "error"), "bare chord diagnostics counted every tone's duration");
const chordSources = slashPitchSources(chordText, bare);
check(chordSources.length === 2 && chordSources[0].eventIndex === chordSources[1].eventIndex,
  "bare chord tones must share a source event");
const chordScore = parseSlashScore(chordText, bare).score;
check(buildSlashSourceNotes(chordText, bare, chordScore).length === 2, "bare chord source bridge lost a tone");
const written = scoreToSlashScore(chordScore, "keyboard", 16, ".", { ...bare, durationNotation: bare }, 1);
check(!/\([A-Z]+\)/.test(written), "serializer restored disabled chord parentheses");
check(tones(written, bare)[0]?.pitches.length === 2, "bare chord lost simultaneous notes during serialization");

const intrinsic = { ...bare, noteDivision: 16 as const };
check(tones("键盘谱\nAB.../..../..../..../", intrinsic)[0]?.duration === 1,
  "intrinsic note duration must count once per bare chord");
const sequenced = "键盘谱\nA.\tB.../..../..../..../";
check(tones(sequenced, { ...bare, spaceDivision: 16, symbolDurations: { ".": 16, "\t": 4 } }).length === 2,
  "Tab must separate ordinary notes even with a legacy Tab mapping");
check(slashScoreDiagnostics(sequenced, { ...bare, spaceDivision: 16, symbolDurations: { ".": 16, "\t": 4 } })
  .every(item => item.severity !== "error"), "Tab contributed duration in diagnostics");

const voiced = `键盘谱\nA${SLASH_VOICE_SEPARATOR}B..../..../..../..../`;
const voiceOptions = { ...bare, voiceCount: 2 };
const voiceSources = slashPitchSources(voiced, voiceOptions);
check(voiceSources.length === 2 && voiceSources[0].voiceIndex === 2 && voiceSources[1].voiceIndex === 1,
  "bare chord must preserve voice markers");
const voiceTimeline = buildTimeline(parseSlashScore(voiced, voiceOptions).score);
check(voiceTimeline.notes.length === 2 && voiceTimeline.notes[0].t0 === voiceTimeline.notes[1].t0,
  "bare chord voices did not start together");

const tripletOptions = { ...base, noteDivision: 16 as const,
  annotations: [{ type: "triplet" as const, part: 0, voice: 1, measure: 0, offset: 0,
    end: .5, scope: "all" as const, members: [.25, .25, .25], restoreUnit: .5 }] };
const ordinary = clearSlashDelimiters("键盘谱\n[ABC]/..../..../..../", tripletOptions, { ...tripletOptions, bracketMode: "none" });
check(ordinary.text.includes("A B C/") && !ordinary.text.includes("[ABC]"), "triplet restoration must preserve sequential members");
const ordinaryTones = tones(ordinary.text, ordinary.options);
check(ordinaryTones.length === 3 && ordinaryTones.every(tone => tone.duration === .25),
  "triplet clear used restoreUnit or retained 3:2 compression");
check(!ordinary.options.annotations?.some(item => item.type === "triplet"), "triplet timing metadata survived clearing");
const embedded = embedSlashScoreOptions(ordinary.text, ordinary.options);
check(tones(embedded, ordinary.options).length === 3, "triplet clear failed save/reload");
const spaceOptions = { ...tripletOptions, spaceDivision: 16 as const };
const tabOrdinary = clearSlashDelimiters("键盘谱\n[ABC]/..../..../..../", spaceOptions, { ...spaceOptions, bracketMode: "none" });
check(tabOrdinary.text.includes("A\tB\tC/"), "restoration inserted duration-bearing spaces");
check(tones(tabOrdinary.text, tabOrdinary.options).every(tone => tone.duration === .25), "Tab restoration changed ordinary durations");

const expectReject = (text: string, current: SlashScoreOptions, next: SlashScoreOptions, match: string) => {
  const before = JSON.stringify({ text, current, next });
  let error = "";
  try { clearSlashDelimiters(text, current, next); } catch (reason) { error = (reason as Error).message; }
  check(error.includes(match), `expected ${match}, received ${error}`);
  check(JSON.stringify({ text, current, next }) === before, "failed migration mutated inputs");
};
expectReject("键盘谱\n[A.B.C.]../..../..../..../", base, { ...base, bracketMode: "none" }, "腾出空间");
expectReject("键盘谱\n[ABC]/..../..../..../", base, { ...base, bracketMode: "none" }, "32 分音符");
const nested = clearSlashDelimiters("键盘谱\n[(AB).C.D.]/..../..../..../", base, { ...base, bracketMode: "none" });
check(nested.text.includes("(AB). C. D./"), "clearing triplet destroyed a still-enabled nested chord");
const untouched = "// (comment) [ABC]\r\n键盘谱\r\n(AB)..../..../..../..../ ; (keep)\r\n数字谱\r\n(13)..../..../..../..../\r\n";
const untouchedResult = clearSlashDelimiters(untouched, base, { ...base, parenMode: "none" });
check(untouchedResult.text.includes("// (comment) [ABC]\r\n")
  && untouchedResult.text.includes("; (keep)") && untouchedResult.text.includes("数字谱\r\n(13)"),
  "delimiter clearing rewrote comments, another score kind or line endings");
const sameRole = clearSlashDelimiters("键盘谱\n(AB)..../..../..../..../", base,
  { ...base, braceMode: "chord", parenMode: "none" });
check(sameRole.text.includes("AB..../") && !sameRole.text.includes("{AB}"), "explicitly clearing one container migrated its role to another");
const decorated = { ...base, annotations: [{ type: "cross-arpeggio" as const,
  measure: 0, offset: 0, parts: [0], pitches: [{ part: 0, pitch: 60 }, { part: 0, pitch: 62 }],
  direction: "up" as const }] };
const clearedRoll = clearSlashDelimiters("键盘谱\n(B{DG})..../..../..../..../", decorated,
  { ...decorated, braceMode: "none" });
check(clearedRoll.text.includes("(BDG)") && !clearedRoll.options.annotations?.length,
  "nested arpeggio clearing kept a cross-part effect at the owning chord");
const emptyRole = clearSlashDelimiters("\uFEFF键盘谱\r\n(AB)..../..../..../..../", base, bare);
check(emptyRole.text.startsWith("\uFEFF") && emptyRole.text.includes("\r\n"), "clearing discarded BOM/line endings");
const numericOptions = { ...bare, kind: "number" as const };
const numbers = "数字谱\n135..../..../..../..../";
check(tones(numbers, numericOptions)[0]?.pitches.length === 3
  && slashPitchSources(numbers, numericOptions).every(source => source.eventIndex === 0),
  "bare numeric chord did not share score/source semantics");
expectReject("键盘谱\n[A.[B.C.D.]E.]/..../..../..../", base, { ...base, bracketMode: "none" }, "嵌套节奏");
const keepTriplet = clearSlashDelimiters("键盘谱\n[(AB).C.D.]/..../..../..../", base,
  { ...base, parenMode: "none" });
check(keepTriplet.text.includes("[AB. C. D.]") && !keepTriplet.text.includes("(AB)"),
  "clearing the last chord container did not preserve a still-enabled triplet's atom boundaries");
const keptTripletTones = tones(keepTriplet.text, keepTriplet.options);
check(keptTripletTones.length === 3 && keptTripletTones[0].pitches.length === 2
  && Math.abs(keptTripletTones[0].duration! - 1 / 6) < 1e-8,
  "a bare chord inside a kept triplet lost its simultaneous notes or ratio");
const keepIntrinsic = clearSlashDelimiters("键盘谱\n[ABC]/..../..../..../", tripletOptions,
  { ...tripletOptions, parenMode: "none" });
check(keepIntrinsic.text.includes("[A B C]"), "still-enabled intrinsic triplet collapsed into a bare chord");
const preservedScore = parseSlashScore(keepIntrinsic.text, keepIntrinsic.options).score;
const preservedWrite = scoreToSlashScore(preservedScore, "keyboard", 16, ".",
  { ...keepIntrinsic.options, durationNotation: keepIntrinsic.options }, 1);
check(tones(preservedWrite, keepIntrinsic.options).length === 3,
  "serializer collapsed sequential members of a still-enabled triplet");
const bareGrace = { ...bare, angleMode: "grace" as const };
const graceScore = parseSlashScore("键盘谱\n<G>AB..../..../..../..../", bareGrace).score;
const graceWrite = scoreToSlashScore(graceScore, "keyboard", 16, ".", { ...bareGrace, durationNotation: bareGrace }, 1);
check(graceWrite.includes("<G>") && parseSlashScore(graceWrite, bareGrace).score.parts[0].measures[0].entries
  .some(entry => entry instanceof Chord && entry.graceNotes.length === 1 && entry.notes.length === 2),
  "bare chord serialization converted a still-enabled grace into a chord tone");
const literal = { ...base, sourceTimedRows: true, adjacentAsChord: false };
const literalClear = clearSlashDelimiters("键盘谱\n(AB)..../..../..../..../", literal,
  { ...literal, parenMode: "none" });
const literalClock = buildTimeline(parseSlashScore(literalClear.text, literalClear.options).score);
check(literalClock.notes.length === 2 && literalClock.notes.every(note => note.t0 === 0 && note.t1 === 4),
  "clearing chord delimiters in literal source-timed rows lost confirmed timing");
check(buildSlashSourceNotes(keepTriplet.text, keepTriplet.options,
  parseSlashScore(keepTriplet.text, keepTriplet.options).score).length === 4,
  "bare chord inside triplet did not preserve exact source tone identity");

const subdivisionOptions = { ...base, angleMode: "subdivide" as const };
const subdivisionText = "键盘谱\n[A.<B.C.>D.]/..../..../..../";
const originalSubdivision = tones(subdivisionText, subdivisionOptions);
check(originalSubdivision.length === 4 && originalSubdivision.every(tone =>
  Math.abs(tone.duration! - 1 / 6) < 1e-8), "nested subdivision fixture must be supported by the source parser");
const restoredSubdivision = clearSlashDelimiters(subdivisionText, subdivisionOptions,
  { ...subdivisionOptions, bracketMode: "none" });
check(restoredSubdivision.text.includes("A. <B.. C..> D."),
  "clearing outer triplet must retain the enabled subdivision wrapper");
const restoredSubdivisionTones = tones(restoredSubdivision.text, restoredSubdivision.options);
check(restoredSubdivisionTones.length === 4 && restoredSubdivisionTones.every((tone, index) =>
  tone.duration === .25 && tone.at === index / 4
  && JSON.stringify(tone.pitches) === JSON.stringify(originalSubdivision[index].pitches)),
  "nested subdivision restoration lost a member, onset, pitch or ordinary outer value");
check(slashScoreDiagnostics(restoredSubdivision.text, restoredSubdivision.options)
  .every(item => item.severity !== "error"), "subdivision duration diagnostics disagree with the restored score");
check(JSON.stringify(tones(embedSlashScoreOptions(restoredSubdivision.text, restoredSubdivision.options),
  restoredSubdivision.options)) === JSON.stringify(restoredSubdivisionTones),
  "nested subdivision changed on save/reload");
check(buildSlashSourceNotes(restoredSubdivision.text, restoredSubdivision.options,
  parseSlashScore(restoredSubdivision.text, restoredSubdivision.options).score).length === 4,
  "nested subdivision restoration lost a source selection target");
const keptSubdivision = clearSlashDelimiters(subdivisionText, subdivisionOptions,
  { ...subdivisionOptions, parenMode: "none" });
check(keptSubdivision.text.includes("<B. C.>")
  && JSON.stringify(tones(keptSubdivision.text, keptSubdivision.options)) === JSON.stringify(originalSubdivision),
  "clearing chord syntax altered an enabled outer triplet and inner subdivision");
const bothSubdivision = clearSlashDelimiters(subdivisionText, subdivisionOptions,
  { ...subdivisionOptions, bracketMode: "none", angleMode: "none" });
check(bothSubdivision.removed === 2 && !bothSubdivision.text.includes("<")
  && JSON.stringify(tones(bothSubdivision.text, bothSubdivision.options)) === JSON.stringify(restoredSubdivisionTones),
  "clearing both timing wrappers changed ordinary members or miscounted removals");
expectReject(subdivisionText.replace("D.]", "D.].."), subdivisionOptions,
  { ...subdivisionOptions, bracketMode: "none" }, "腾出空间");
const spaceSubdivisionOptions = { ...subdivisionOptions, symbolDurations: { ".": 4 as const },
  spaceDivision: 16 as const };
const spaceSubdivision = clearSlashDelimiters("键盘谱\n[A <B C >D ]/    /    /    /",
  spaceSubdivisionOptions, { ...spaceSubdivisionOptions, bracketMode: "none" });
check(spaceSubdivision.text.includes("<B  \tC  >")
  && tones(spaceSubdivision.text, spaceSubdivision.options).slice(0, 4)
    .every((tone, index) => tone.duration === .25 && tone.at === index / 4),
  "nested rewriting trimmed a duration-bearing final space or inserted timed separators");
const deepSubdivisionOptions = { ...subdivisionOptions, braceMode: "subdivide" as const };
const deepSubdivisionText = subdivisionText.replace("<B.C.>", "<{B.C.}>");
check(JSON.stringify(tones(deepSubdivisionText, deepSubdivisionOptions)) === JSON.stringify(originalSubdivision),
  "the source parser must flatten nested subdivision nominal values without stacking ratios");
const deepSubdivision = clearSlashDelimiters(deepSubdivisionText, deepSubdivisionOptions,
  { ...deepSubdivisionOptions, bracketMode: "none" });
check(deepSubdivision.text.includes("<{B.. C..}>")
  && JSON.stringify(tones(deepSubdivision.text, deepSubdivision.options)) === JSON.stringify(restoredSubdivisionTones),
  "deep subdivision restoration must preserve the source parser's single outer half-value");

const innerOrnamentOptions = { ...base, barMode: "triplet" as const, annotations: [
  { type: "ornament" as const, kind: "lower-mordent" as const,
    part: 0, voice: 1, measure: 0, offset: 1 / 6 },
] };
const innerOrnamentText = "键盘谱\n[A.|BCB|D.]/..../..../..../";
const originalInnerOrnament = tones(innerOrnamentText, innerOrnamentOptions);
check(originalInnerOrnament.length === 3, "metadata-owned inner mordent fixture must contain three attacks");
const retainedInnerOrnament = clearSlashDelimiters(innerOrnamentText, innerOrnamentOptions,
  { ...innerOrnamentOptions, bracketMode: "none" });
check(retainedInnerOrnament.text.includes("|BCB|")
  && retainedInnerOrnament.options.annotations?.some(item => item.type === "ornament" && item.offset === .25),
  "clearing outer triplet removed a still-enabled inner semantic mordent or its ownership");
const innerOrnamentTones = tones(retainedInnerOrnament.text, retainedInnerOrnament.options);
check(innerOrnamentTones.length === 3 && innerOrnamentTones.every(tone => tone.duration === .25),
  "inner mordent helper pitches entered the restored ordinary stream");
const clearedInnerOrnament = clearSlashDelimiters(innerOrnamentText, innerOrnamentOptions,
  { ...innerOrnamentOptions, bracketMode: "none", barMode: "none" });
check(clearedInnerOrnament.removed === 2 && !clearedInnerOrnament.text.includes("|")
  && !clearedInnerOrnament.options.annotations?.length
  && JSON.stringify(tones(clearedInnerOrnament.text, clearedInnerOrnament.options))
    === JSON.stringify(innerOrnamentTones),
  "clearing an inner semantic mordent must retain its main attack without sounding decorative helpers");
console.log("slash delimiter clear: semantic, source, exact timing, rejection and round-trip checks passed");
