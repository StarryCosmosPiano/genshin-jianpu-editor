import assert from "node:assert/strict";
import { Fraction } from "./src/common/fraction";
import { Chord, Score } from "./src/score/score";
import { createInputTriplet, inputNoteAtCursor, inputRestAtCursor } from "./src/score/input-edit";
import { analyzeSlashScore, defaultSlashScoreOptions, embedSlashScoreOptionsFromScore, parseSlashScore, scoreToSlashScore, type SlashScoreOptions } from "./src/slashscore";

const source = "键盘谱\n4/4拍：\n点=16分音符\n(V\u2063G).\u2063W.\u2063Y.(A\u2063W)./.(V\u2063W).A.\u2063W./B.\u2063Q.\u2063U.(M\u2063J)./.(B\u2063Q).M.\u2063J./\n";
const state = (score: Score, part: number, min = 0): string => JSON.stringify(score.parts[part]?.measures.flatMap((measure) => measure.entries.filter((entry): entry is Chord => entry instanceof Chord && entry.position.compareTo(new Fraction(min)) >= 0).map((chord) => ({ at: chord.position.toString(), dur: chord.duration?.toString(), pitches: chord.notes.filter((note) => !note.rest).map((note) => note.pitch), rest: chord.rest, dot: chord.dot, tuple: chord.notes.some((note) => note.tuplet) }))) ?? []);
const noErrors = (text: string): void => assert.equal(parseSlashScore(text, defaultSlashScoreOptions("keyboard", analyzeSlashScore(text))).summary.diagnostics.some((item) => item.severity === "error"), false);

function run(showExplicitRests: boolean): void {
  const options: SlashScoreOptions = { ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(source)), voiceCount: 2, beats: 4, beatType: 4, symbolDurations: { ".": 16 }, spaceDivision: null, noteDivision: null, showExplicitRests };
  const score = parseSlashScore(source, options).score;
  const initial = score.parts[1]?.measures[0]?.entries.find((entry) => entry instanceof Chord && entry.position.equals(new Fraction(0))) as Chord;
  assert.equal(initial.duration?.toString(), "3/4");
  const p0 = state(score, 0); const p1Tail = state(score, 1, 3 / 4);
  const created = createInputTriplet(score, { partIndex: 1, measureIndex: 0, offset: new Fraction(0) }, new Fraction(1, 4));
  const members = created.chords.filter((chord) => chord.notes.some((note) => note.tuplet));
  assert(created.changed); assert.deepEqual(members.map((chord) => chord.position.toString()), ["0", "1/6", "1/3"]);
  assert(members.every((chord) => chord.duration?.equals(new Fraction(1, 6)) && chord.beams === 2 && chord.dot === 0));
  assert.equal(state(score, 0), p0); assert.equal(state(score, 1, 3 / 4), p1Tail);
  assert(score.parts[1].measures[0].entries.some((entry) => entry instanceof Chord && entry.rest && entry.position.equals(new Fraction(1, 2)) && entry.duration?.equals(new Fraction(1, 4))));
  const save = (value: Score): string => embedSlashScoreOptionsFromScore(scoreToSlashScore(value, "keyboard", 16, ".", { durationNotation: options, braceMode: options.braceMode, bracketMode: "triplet", parenMode: "chord", preserveExplicitRestMeasures: [0] }, 2), value, options);
  let text = save(score);
  const annotation = analyzeSlashScore(text).annotations.find((item) => item.type === "triplet");
  assert(annotation
    && annotation.ordinary?.some((item) => item.part === 0 && item.offset === 0 && item.duration === 0.25)
    && annotation.ordinary?.some((item) => item.part === 0 && item.offset === 0.25 && item.duration === 0.25));
  noErrors(text);
  let reloaded = parseSlashScore(text, defaultSlashScoreOptions("keyboard", analyzeSlashScore(text))).score;
  const assertTripletCell = (value: Score, pitch: number | null, rest: boolean): void => {
    const cell = value.parts[1]?.measures[0]?.entries.find((entry) => entry instanceof Chord
      && entry.position.equals(new Fraction(1, 3))) as Chord | undefined;
    assert(cell && cell.duration?.equals(new Fraction(1, 6))
      && cell.beams === 2 && cell.dot === 0
      && cell.rest === rest
      && cell.notes.length === 1
      && cell.notes[0]!.tuplet !== null
      && (rest ? cell.notes[0]!.rest : cell.notes[0]!.pitch === pitch));
  };
  const assertParallelRest = (value: Score): void => {
    assert(value.parts[1]!.measures[0]!.entries.some((entry) => entry instanceof Chord
      && entry.rest && entry.position.equals(new Fraction(1, 2))
      && entry.duration?.equals(new Fraction(1, 4))));
  };
  assertTripletCell(reloaded, null, true);
  for (const pitch of [60, 62, 65]) {
    const edit = inputNoteAtCursor(reloaded,
      { partIndex: 1, measureIndex: 0, offset: new Fraction(1, 3), division: 16, lane: "rest" },
      { pitch, number: "1" }, new Fraction(1, 4));
    assert(edit.changed && edit.note && edit.note.tuplet !== null);
    text = save(reloaded);
    noErrors(text);
    reloaded = parseSlashScore(text, defaultSlashScoreOptions("keyboard", analyzeSlashScore(text))).score;
    assertTripletCell(reloaded, pitch, false);
    assert.equal(state(reloaded, 0), p0);
    assert.equal(state(reloaded, 1, 3 / 4), p1Tail);
    assertParallelRest(reloaded);
    const selected = reloaded.parts[1]!.measures[0]!.entries.find((entry) => entry instanceof Chord
      && entry.position.equals(new Fraction(1, 3))) as Chord;
    const deleted = inputRestAtCursor(reloaded,
      { partIndex: 1, measureIndex: 0, offset: new Fraction(1, 3), division: 16, lane: "rest" },
      new Fraction(1, 6), selected.notes.find((note) => !note.rest) ?? null);
    assert(deleted.changed && deleted.rest?.notes[0]?.tuplet !== null);
    text = save(reloaded);
    noErrors(text);
    reloaded = parseSlashScore(text, defaultSlashScoreOptions("keyboard", analyzeSlashScore(text))).score;
    assertTripletCell(reloaded, null, true);
    assert.equal(state(reloaded, 0), p0);
    assert.equal(state(reloaded, 1, 3 / 4), p1Tail);
    assertParallelRest(reloaded);
  }
}
run(true); run(false); console.log("dotted-triplet-check: ok");
