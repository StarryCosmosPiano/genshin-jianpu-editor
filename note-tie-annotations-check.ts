import assert from "node:assert/strict";
import { Fraction } from "./src/common/fraction";
import { Chord, type Note, type Score } from "./src/score/score";
import { scoreNoteTimingFingerprint } from "./src/score/note-timing";
import {
  analyzeSlashScore, defaultSlashScoreOptions, embedSlashScoreOptions,
  embedSlashScoreOptionsFromScore, parseSlashScore, scoreToSlashScore,
  type NotationAnnotationData,
} from "./src/slashscore";

let checks = 0;
const configurations = [
  { name: "key annotation", key: true, meter: false },
  { name: "meter annotation", key: false, meter: true },
  { name: "key and meter annotations", key: true, meter: true },
];
function noteAt(score: Score, measure: number, offset: Fraction, pitch: number): Note {
  const chord = score.parts[0].measures[measure].entries.find((entry): entry is Chord =>
    entry instanceof Chord && entry.position.equals(offset));
  const note = chord?.notes.find(note => !note.rest && note.pitch === pitch);
  assert(note, `missing ${pitch} at measure ${measure}, offset ${offset}`);
  return note;
}
for (const configuration of configurations) {
  // The original row is 4/4. Meter metadata makes its silent final beat
  // disappear before the next measure's absolute position is calculated.
  // Key metadata changes the sounding pitch used by the exact tie endpoints.
  const start = new Fraction(configuration.meter ? 5 : 7, 2);
  const nextMeasureStart = new Fraction(configuration.meter ? 7 : 8);
  const pitch = configuration.key ? 67 : 60;
  const partner = configuration.key ? 71 : 64;
  const firstRow = configuration.meter
    ? "0..../0..../0..(AD)../0..../"
    : "0..../0..../0..../0..(AD)../";
  const text = `键盘谱\n4/4拍：\n点=16分音符\n0..../0..../0..../0..../\n${firstRow}\nA..S../0..../0..../0..../\n`;
  const annotations: NotationAnnotationData[] = [
    ...(configuration.key ? [{ type: "key" as const, measure: 1, offset: 0, fifths: 1 }] : []),
    ...(configuration.meter ? [
      { type: "meter" as const, measure: 1, beats: 3, beatType: 4 as const },
      { type: "meter" as const, measure: 2, beats: 4, beatType: 4 as const },
    ] : []),
    { type: "note-tie", measure: 1, offset: start.toFloat(), part: 0,
      from: { measure: 1, offset: start.toString(), pitch, occurrence: 0 },
      to: { measure: 2, offset: "0", pitch, occurrence: 0 } },
  ];
  const options = { ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(text)),
    voiceCount: 1, showExplicitRests: true, symbolDurations: { ".": 16 as const }, annotations };
  const saved = embedSlashScoreOptions(text, options);
  const parsed = parseSlashScore(saved, defaultSlashScoreOptions("keyboard", analyzeSlashScore(saved)));
  assert(parsed.summary.diagnostics.every(item => item.severity !== "error"), configuration.name);
  let score = parsed.score;
  const from = noteAt(score, 1, start, pitch);
  const to = noteAt(score, 2, new Fraction(0), pitch);
  const other = noteAt(score, 1, start, partner);
  assert(score.parts[0].measures[2].position.equals(nextMeasureStart), `${configuration.name}: final measure position`);
  assert(from.tieNext === to && to.tiePrev === from, `${configuration.name}: final endpoints did not reconnect`);
  assert(other.tieNext === null && other.tiePrev === null, `${configuration.name}: unselected chord member was tied`);
  assert(from.absoluteTick.plus(from.chord.duration!).equals(to.absoluteTick), `${configuration.name}: noncontiguous tie`);
  const expected = scoreNoteTimingFingerprint(score);
  const attacks = JSON.parse(expected) as Array<{ part: number; pitch: number; start: string; end: string }>;
  assert.deepEqual(attacks.find(item => item.pitch === pitch), {
    part: 0, pitch, start: start.plus(new Fraction(4)).toString(), end: nextMeasureStart.plus(new Fraction(1, 2)).toString(),
  }, `${configuration.name}: exact logical duration`);
  checks++;
  for (const kind of ["keyboard", "number"] as const) {
    for (let pass = 0; pass < 2; pass++) {
      const output = scoreToSlashScore(score, kind, 16, ".", {
        bracketMode: "triplet", braceMode: "arpeggio", showExplicitRests: true,
      }, 1);
      const embedded = embedSlashScoreOptionsFromScore(output, score,
        defaultSlashScoreOptions(kind, analyzeSlashScore(output)));
      score = parseSlashScore(embedded, defaultSlashScoreOptions(kind, analyzeSlashScore(embedded))).score;
      assert.equal(scoreNoteTimingFingerprint(score), expected,
        `${configuration.name}: ${kind} save ${pass} changed a selected or unselected endpoint`);
      assert(noteAt(score, 1, start, partner).tieNext === null,
        `${configuration.name}: ${kind} save ${pass} tied an unselected member`);
      checks++;
    }
  }
}
console.log(`note-tie-annotations-check: ok (${checks} final-position and repeated TXT persistence cases)`);
