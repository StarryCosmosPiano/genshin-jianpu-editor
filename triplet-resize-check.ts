import assert from "node:assert/strict";
import { Fraction } from "./src/common/fraction";
import { Chord, Score } from "./src/score/score";
import { createInputTriplet, inputNoteAtCursor, inputRestAtCursor, resizeInputTupletMember } from "./src/score/input-edit";
import {
  analyzeSlashScore, defaultSlashScoreOptions, embedSlashScoreOptionsFromScore,
  parseSlashScore, scoreToSlashScore,
} from "./src/slashscore";

const z = "\u2063";
const source = `键盘谱\n4/4拍：\n点=16分音符\n(V${z}G).${z}W.${z}Y.(A${z}W)./.(V${z}W).A.${z}W./B.${z}Q.${z}U.(M${z}J)./.(B${z}Q).M.${z}W./\n`;
const options = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(source)),
  voiceCount: 2, symbolDurations: { ".": 16 as const }, spaceDivision: null, noteDivision: null,
};
const chords = (score: Score, part: number) => score.parts[part].measures[0].entries
  .filter((entry): entry is Chord => entry instanceof Chord);
const events = (score: Score, part: number, after = 0) => chords(score, part)
  .filter((chord) => chord.position.toFloat() >= after)
  .map((chord) => ({
    at: chord.position.toString(), duration: chord.duration?.toString(), rest: chord.rest,
    pitches: chord.notes.filter((note) => !note.rest).map((note) => note.pitch),
    beams: chord.beams, dot: chord.dot, tuplet: chord.notes.some((note) => note.tuplet),
  }));
const save = (score: Score) => embedSlashScoreOptionsFromScore(scoreToSlashScore(
  score, "keyboard", 16, ".", { ...options, durationNotation: options }, 2,
), score, options);
const reopen = (text: string) => {
  const result = parseSlashScore(text, defaultSlashScoreOptions("keyboard", analyzeSlashScore(text)));
  assert(!result.summary.diagnostics.some((item) => item.severity === "error"), JSON.stringify(result.summary));
  return result.score;
};
const cursor = (offset: Fraction) => ({ partIndex: 1, measureIndex: 0, offset, division: 16 as const, lane: "rest" as const });

for (const finalRest of [false, true]) for (const ordinarySplit of [0.125, 0.25, 0.375]) {
  let score = parseSlashScore(source, options).score;
  // Binary attacks can lie before or after the 1/3 triplet boundary. Keep
  // their exact durations even when their compact TXT placement uses a
  // 32nd-note adjacency between the printed triplet members.
  const [g, w] = chords(score, 0);
  g.duration = new Fraction(ordinarySplit);
  g.beams = ordinarySplit === 0.125 ? 3 : 2;
  g.dot = ordinarySplit === 0.375 ? 1 : 0;
  w.position = new Fraction(ordinarySplit);
  w.duration = new Fraction(0.5 - ordinarySplit);
  w.beams = ordinarySplit === 0.375 ? 3 : 2;
  w.dot = ordinarySplit === 0.125 ? 1 : 0;
  assert(createInputTriplet(score, cursor(new Fraction(0)), new Fraction(1, 4)).changed);
  if (!finalRest) assert(inputNoteAtCursor(score, cursor(new Fraction(1, 3)),
    { pitch: 60, number: "1" }, new Fraction(1, 4)).changed);
  assert(inputNoteAtCursor(score, cursor(new Fraction(1, 2)),
    { pitch: 64, number: "3" }, new Fraction(1, 4)).changed);
  const exactOrdinary = events(score, 0);
  score = reopen(save(score));
  assert.deepEqual(events(score, 0), exactOrdinary);
  const ordinaryBefore = events(score, 0);
  const tailBefore = events(score, 1, 0.5);
  const first = chords(score, 1).find((chord) => chord.position.equals(0))!;
  assert(resizeInputTupletMember(score, first.notes[0], new Fraction(1, 6)).changed);
  const expected = events(score, 1);
  for (let cycle = 0; cycle < 3; cycle++) {
    const saved = save(score);
    const bracket = saved.match(/\[[^\]\r\n]*\]/)?.[0].replaceAll(z, "") ?? "";
    if (ordinarySplit === 0.25) assert.equal(bracket, finalRest ? "[(VG)..W0.]" : "[(VG)..WA.]", saved);
    else assert(bracket.includes("G") && bracket.includes("W"), saved);
    score = reopen(saved);
    assert.deepEqual(events(score, 1), expected);
    assert.deepEqual(events(score, 0), ordinaryBefore);
    assert.deepEqual(events(score, 1, 0.5), tailBefore);
    const members = chords(score, 1).filter((chord) => chord.notes.some((note) => note.tuplet));
    assert.deepEqual(members.map((chord) => [chord.position.toString(), chord.duration?.toString(), chord.beams, chord.dot]),
      [["0", "1/3", 1, 0], ["1/3", "1/6", 2, 0]]);
  }
  const last = chords(score, 1).find((chord) => chord.position.equals(new Fraction(1, 3)))!;
  assert(inputRestAtCursor(score, cursor(last.position), last.duration!, last.notes[0]).changed);
  assert.deepEqual(events(reopen(save(score)), 0), ordinaryBefore);
}
console.log("triplet-resize-check: ok (variable members, shared binary atoms, repeated reload)");
