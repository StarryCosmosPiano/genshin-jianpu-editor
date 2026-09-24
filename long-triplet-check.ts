import assert from "node:assert/strict";
import { Fraction } from "./src/common/fraction";
import { Chord, Score } from "./src/score/score";
import { createInputTriplet, inputNoteAtCursor } from "./src/score/input-edit";
import { analyzeSlashScore, defaultSlashScoreOptions, embedSlashScoreOptionsFromScore, parseSlashScore, scoreToSlashScore } from "./src/slashscore";

const z = "\u2063";
const header = "键盘谱\n4/4拍：\n点=16分音符\n";
const halfSource = header + `(V${z}D${z}G).${z}A.${z}N.( ${z}D${z}G)./.${z}A.${z}N.${z}A./(B${z}D${z}G).${z}A.${z}N.( ${z}D${z}G)./.${z}N.${z}A.${z}N./\n`.replaceAll("( ", "(");
const wholeSource = header + `(N${z}D${z}G).${z}A.${z}N.( ${z}D${z}G)./.${z}A.${z}N.${z}A./( ${z}D${z}G).${z}A.${z}N.( ${z}D${z}G)./.${z}A.${z}N../\n`.replaceAll("( ", "(");
const oldHalf = `[( ${z}${z}V${z}D${z}G)....${z}A${z}N${z}${z}0....(${z}D${z}G)${z}A${z}${z}0....${z}N${z}A]/..../(B${z}D${z}G).${z}A.${z}N.(${z}D${z}G)./.${z}N.${z}A.${z}N./`.replaceAll("( ", "(");
const oldWhole = `[( ${z}${z}N${z}D${z}G)........${z}A${z}N(${z}D${z}G)${z}A${z}${z}0........${z}N${z}A(${z}D${z}G)${z}A${z}N${z}${z}0........(${z}D${z}G)${z}A${z}N]/..../..../..../`.replaceAll("( ", "(");
function assertBeatSlices(text: string, first: number, count: number): void {
  const row = text.split(/\r?\n/).find((line) => line.includes("[") && line.includes("/") && !line.startsWith("//"));
  assert(row, text);
  const groups = row.split("/");
  for (let beat = first; beat < first + count; beat++) assert(/^\[.*\]$/.test(groups[beat] ?? ""), row);
}

const entries = (score: Score, part: number): Chord[] => score.parts[part]!.measures[0]!.entries
  .filter((entry): entry is Chord => entry instanceof Chord)
  .sort((left, right) => left.position.compareTo(right.position));
const state = (score: Score, part: number): string => JSON.stringify(entries(score, part).map((chord) => ({
  at: chord.position.toString(), dur: chord.duration?.toString(), rest: chord.rest,
  pitches: chord.notes.filter((note) => !note.rest).map((note) => note.pitch),
})));
const attackPitches = (score: Score, part: number): number[] => entries(score, part)
  .filter((chord) => !chord.generatedTimingContinuation)
  .flatMap((chord) => chord.notes.filter((note) => !note.rest && !note.tieEnd)
    .map((note) => note.pitch).sort((left, right) => left - right));

function run(source: string, duration: Fraction, member: Fraction, pitch: number, showExplicitRests: boolean): void {
  const options = { ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(source)), voiceCount: 2,
    beats: 4, beatType: 4, symbolDurations: { ".": 16 }, spaceDivision: null,
    noteDivision: null, showExplicitRests };
  const score = parseSlashScore(source, options).score;
  const sourceChord = entries(score, 1)[0]!;
  const basePitch = sourceChord.notes.find((note) => !note.rest)?.pitch ?? pitch;
  assert.equal(sourceChord.duration?.toString(), duration.toString());
  const part0Before = state(score, 0);
  const ordinaryAttacksBefore = attackPitches(score, 0);
  const created = createInputTriplet(score, { partIndex: 1, measureIndex: 0, offset: new Fraction(0) }, new Fraction(1, 4));
  assert(created.changed);
  const members = entries(score, 1).filter((chord) => chord.notes.some((note) => note.tuplet));
  assert.equal(members.length, 3);
  assert(members.every((chord) => chord.duration?.equals(member)));
  assert.equal(members[2]!.position.plus(members[2]!.duration!).toString(), duration.toString());
  assert.equal(state(score, 0), part0Before);
  const outsideState = (value: Score) => entries(value, 1).filter((chord) =>
    !chord.notes.some((note) => note.tuplet)).map((chord) => ({
      at: chord.position.toString(), duration: chord.duration?.toString(),
      rest: chord.rest, pitches: chord.notes.filter((note) => !note.rest).map((note) => note.pitch),
    }));
  const outsideBefore = outsideState(score);
  const optionsWithSave = { ...options, annotations: [] };
  const save = (value: Score): string => embedSlashScoreOptionsFromScore(scoreToSlashScore(value, "keyboard", 16, ".", {
    durationNotation: optionsWithSave, braceMode: "grace", bracketMode: "triplet", parenMode: "chord",
    preserveExplicitRestMeasures: [0],
  }, 2), value, optionsWithSave);
  let text = save(score);
  let parsed = parseSlashScore(text, defaultSlashScoreOptions("keyboard", analyzeSlashScore(text)));
  assert(parsed.summary.diagnostics.every((item) => item.severity !== "error"), JSON.stringify(parsed.summary.diagnostics));
  let roundTrip = parsed.score;
  assert.deepEqual(attackPitches(roundTrip, 0), ordinaryAttacksBefore);
  assertBeatSlices(text, 0, duration.toFloat());
  const legacyText = embedSlashScoreOptionsFromScore(header + (duration.equals(new Fraction(2)) ? oldHalf : oldWhole) + "\n", score, options);
  const legacy = parseSlashScore(legacyText, defaultSlashScoreOptions("keyboard", analyzeSlashScore(legacyText)));
  assert(!legacy.summary.diagnostics.some((item) => item.severity === "error"), JSON.stringify({ legacyText, diagnostics: legacy.summary.diagnostics }));
  assert.deepEqual(legacy.score.parts.map((_, part) => state(legacy.score, part)),
    score.parts.map((_, part) => state(score, part)));
  assertBeatSlices(save(legacy.score), 0, duration.toFloat());
  const footerless = text.replace(/^\s*\/\/\s*@jpeditor\s+\{[^\r\n]*\}\s*$/gmi, "");
  const footerlessOptions = { ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(footerless)),
    voiceCount: 2, beats: 4, beatType: 4, symbolDurations: { ".": 16 },
    spaceDivision: null, noteDivision: null, showExplicitRests };
  const footerlessParsed = parseSlashScore(footerless, footerlessOptions);
  assert(!footerlessParsed.summary.diagnostics.some((item) => item.severity === "error"),
    JSON.stringify(footerlessParsed.summary.diagnostics));
  assert.deepEqual(attackPitches(footerlessParsed.score, 0), ordinaryAttacksBefore);
  const assertReloaded = (value: Score, expectedPitches: Array<number | null>): void => {
    assert.deepEqual(outsideState(value), outsideBefore);
    assert.equal(value.parts.length, 2);
    assert(value.parts.every((part) => part.measures.length === 1));
    const cells = entries(value, 1).filter((chord) => chord.position.compareTo(duration) < 0);
    assert.deepEqual(cells.map((chord) => chord.position.toString()), ["0", member.toString(), member.timesInt(2).toString()]);
    assert(cells.every((chord) => chord.notes.some((note) => note.tuplet)
      && chord.duration?.equals(member)));
    assert.deepEqual(cells.map((chord) => chord.rest ? null
      : chord.notes.find((note) => !note.rest)?.pitch ?? null), expectedPitches);
    assert(cells.every((chord) => chord.notes.some((note) => note.tuplet)),
      "an ordinary rest leaked into the triplet range");
    assert.equal(cells[2]!.position.plus(cells[2]!.duration!).toString(), duration.toString());
  };
  assertReloaded(roundTrip, [basePitch, null, null]);
  for (const [offset, notePitch] of [[member, 60], [member.timesInt(2), 62]] as const) {
    const edit = inputNoteAtCursor(roundTrip, { partIndex: 1, measureIndex: 0, offset, division: 16, lane: "rest" }, { pitch: notePitch, number: "1" }, member);
    assert(edit.changed && edit.note && edit.note.tuplet !== null);
    text = save(roundTrip);
    parsed = parseSlashScore(text, defaultSlashScoreOptions("keyboard", analyzeSlashScore(text)));
    assert(parsed.summary.diagnostics.every((item) => item.severity !== "error"), JSON.stringify(parsed.summary.diagnostics));
    roundTrip = parsed.score;
    assertReloaded(roundTrip, offset.equals(member)
      ? [basePitch, notePitch, null]
      : [basePitch, 60, notePitch]);
    assert.equal(state(roundTrip, 0), part0Before);
  }
}

for (const showExplicitRests of [true, false]) {
  run(halfSource, new Fraction(2), new Fraction(2, 3), 60, showExplicitRests);
  run(wholeSource, new Fraction(4), new Fraction(4, 3), 60, showExplicitRests);
}

// Cover both the single-voice writer and a later beat-group origin. The
// bracket remains one container even though its ruler spans several slashes.
for (const fixture of [
  { source: halfSource, voices: 2, part: 1, offset: 2, span: 2 },
  { source: halfSource, voices: 1, part: 0, offset: 0, span: 2 },
  { source: wholeSource, voices: 1, part: 0, offset: 0, span: 4 },
]) {
  const options = { ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(fixture.source)),
    voiceCount: fixture.voices, beats: 4, beatType: 4, symbolDurations: { ".": 16 as const },
    spaceDivision: null, noteDivision: null, showExplicitRests: true };
  let score = parseSlashScore(fixture.source, { ...options, voiceCount: 2 }).score;
  if (fixture.voices === 1) {
    score.parts = [score.parts[1]];
    score.parts[0].voiceIndex = 1;
    score.piano = false;
    score.ensemble = false;
  }
  const cursor = { partIndex: fixture.part, measureIndex: 0, offset: new Fraction(fixture.offset) };
  const originalAttacks = attackPitches(score, fixture.part);
  assert(createInputTriplet(score, cursor, new Fraction(1, 4)).changed);
  if (fixture.voices === 1 && fixture.span === 2) {
    assert(createInputTriplet(score, { ...cursor, offset: new Fraction(2) }, new Fraction(1, 4)).changed);
  }
  const expected = score.parts.map((_, part) => attackPitches(score, part));
  for (let cycle = 0; cycle < 3; cycle++) {
    const saved = embedSlashScoreOptionsFromScore(scoreToSlashScore(score, "keyboard", 16, ".", {
      durationNotation: options, preserveExplicitRestMeasures: [0],
    }, fixture.voices), score, options);
    const parsed = parseSlashScore(saved, defaultSlashScoreOptions("keyboard", analyzeSlashScore(saved)));
    assert(!parsed.summary.diagnostics.some((item) => item.severity === "error"), saved);
    score = parsed.score;
    assertBeatSlices(saved, fixture.offset, fixture.span);
    const footerless = saved.replace(/^\s*\/\/\s*@jpeditor\s+\{[^\r\n]*\}\s*$/gmi, "");
    const footerlessOptions = { ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(footerless)),
      voiceCount: fixture.voices, beats: 4, beatType: 4, symbolDurations: { ".": 16 },
      spaceDivision: null, noteDivision: null, showExplicitRests: true };
    const footerlessParsed = parseSlashScore(footerless, footerlessOptions);
    assert(!footerlessParsed.summary.diagnostics.some((item) => item.severity === "error"),
      JSON.stringify(footerlessParsed.summary.diagnostics));
    const footerlessAttacks = attackPitches(footerlessParsed.score, fixture.part);
    assert.deepEqual(footerlessAttacks, originalAttacks);
    assert.deepEqual(score.parts.map((_, part) => attackPitches(score, part)), expected);
    const members = entries(score, fixture.part).filter((chord) => chord.notes.some((note) => note.tuplet)
      && chord.position.toFloat() >= fixture.offset && chord.position.toFloat() < fixture.offset + fixture.span);
    assert.deepEqual(members.map((chord) => chord.position.toString()), [0, 1, 2].map((index) =>
      new Fraction(fixture.offset).plus(new Fraction(fixture.span, 3).timesInt(index)).toString()));
    assert(members.every((chord) => chord.duration?.equals(new Fraction(fixture.span, 3))));
    assert(score.parts.every((part) => part.measures.length === 1));
    const sourceNotes = entries(score, fixture.part).flatMap((chord) =>
      chord.notes.filter((note) => !note.rest).map((note) => note.pitch));
    assert(sourceNotes.length >= originalAttacks.length,
      "later beat source notes were lost after long-triplet serialization");
    const bad = saved.replace("]", "].");
    assert(parseSlashScore(bad, { ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(bad)),
      voiceCount: fixture.voices, beats: 4, beatType: 4, symbolDurations: { ".": 16 },
      spaceDivision: null, noteDivision: null, showExplicitRests: true })
      .summary.diagnostics.some((item) => item.severity === "error"), "cross-beat metadata hid an excess duration suffix");
  }
}
console.log("long-triplet-check: ok");
