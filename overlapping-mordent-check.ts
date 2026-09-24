import assert from "node:assert/strict";
import { Fraction } from "./src/common/fraction";
import { Chord, Score } from "./src/score/score";
import { createInputTriplet } from "./src/score/input-edit";
import {
  analyzeSlashScore, defaultSlashScoreOptions, embedSlashScoreOptionsFromScore,
  parseSlashScore, scoreToSlashScore, type SlashScoreOptions,
} from "./src/slashscore";

// The exact two-voice source from the reported editor session. The invisible
// separator fixes each pitch's voice assignment inside shared chord columns.
const z = "\u2063";
const source = `(V${z}D${z}G).${z}A.${z}N.(${z}D${z}G)./.${z}A.${z}N.${z}A./(B${z}D${z}G).${z}A.${z}N.(${z}D${z}G)./.${z}N.${z}A.${z}N./`;
const header = `键盘谱\n4/4拍：\n点=16分音符\n`;
const options: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(header + source)),
  voiceCount: 2, beats: 4, beatType: 4,
  symbolDurations: { ".": 16 }, spaceDivision: null, noteDivision: null,
};
const chords = (score: Score, part: number) => score.parts[part].measures[0].entries
  .filter((entry): entry is Chord => entry instanceof Chord);
const timeline = (score: Score, part: number) => chords(score, part).map((chord) => ({
  at: chord.position.toString(), duration: chord.duration?.toString(),
  pitches: chord.notes.filter((note) => !note.rest).map((note) => note.pitch),
  rest: chord.rest,
  tuplet: chord.notes.some((note) => note.tuplet !== null && !note.tuplet.ornamentProxy),
}));
const save = (score: Score) => embedSlashScoreOptionsFromScore(scoreToSlashScore(
  score, "keyboard", 16, ".", { ...options, durationNotation: options }, 2,
), score, options);
const reopen = (text: string) => {
  const result = parseSlashScore(text, defaultSlashScoreOptions("keyboard", analyzeSlashScore(text)));
  assert(!result.summary.diagnostics.some((item) => item.severity === "error"), JSON.stringify(result.summary));
  return result.score;
};
const body = (text: string) => text.split(/\r?\n/)
  .find((line) => (line.startsWith("[") || line.startsWith("(")) && line.includes("/"))
  ?.replaceAll(z, "") ?? "";
const firstA = (score: Score) => {
  const chord = chords(score, 0).find((candidate) => candidate.position.equals(new Fraction(1, 4)));
  assert(chord);
  assert.deepEqual(chord.notes.filter((note) => !note.rest).map((note) => note.pitch), [60]);
  return chord;
};

for (const [kind, neighbour] of [["upper-mordent", "S"], ["lower-mordent", "M"]] as const) {
  let score = parseSlashScore(header + source, options).score;
  // Control: the ordinary single-note wave must have three explicit pitches.
  firstA(score).ornaments.push({ kind });
  assert(body(save(score)).includes(`[A${neighbour}A]`));

  score = parseSlashScore(header + source, options).score;
  assert(createInputTriplet(score,
    { partIndex: 1, measureIndex: 0, offset: new Fraction(0) },
    new Fraction(1, 4)).changed);
  // Match the app's edit cycle: a triplet is serialized and reparsed before
  // the user selects the first A in voice 1 and adds its wave ornament.
  score = reopen(save(score));
  const expectedFirstVoice = timeline(score, 0);
  const expectedTripletVoice = timeline(score, 1);
  assert.deepEqual(expectedTripletVoice.filter((event) => event.tuplet)
    .map((event) => [event.at, event.duration, event.pitches]), [
    ["0", "2/3", [53]], ["2/3", "2/3", []], ["4/3", "2/3", []],
  ]);
  firstA(score).ornaments.push({ kind });

  for (let cycle = 0; cycle < 3; cycle++) {
    const saved = save(score);
    // Metadata alone is insufficient: the visible TXT must contain the A,
    // diatonic neighbour, A realization in the ordinary voice.
    assert(body(saved).includes(`[A${neighbour}A]`),
      `${kind} cycle ${cycle}: missing three-pitch wave in TXT body: ${body(saved)}`);
    score = reopen(saved);
    assert.deepEqual(timeline(score, 0), expectedFirstVoice);
    assert.deepEqual(timeline(score, 1), expectedTripletVoice);
    assert(firstA(score).ornaments.some((ornament) => ornament.kind === kind),
      `${kind} cycle ${cycle}: semantic wave missing after reload`);
  }
}
console.log("overlapping-mordent-check: ok (explicit ABA, stable ordinary voice and parallel triplet)");
