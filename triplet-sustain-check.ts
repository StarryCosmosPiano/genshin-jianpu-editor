import assert from "node:assert/strict";
import { Fraction } from "./src/common/fraction";
import { createInputTriplet, inputNoteAtCursor } from "./src/score/input-edit";
import { Chord, type Score } from "./src/score/score";
import { buildTimeline } from "./src/score/timeline";
import {
  analyzeSlashScore, defaultSlashScoreOptions, embedSlashScoreOptionsFromScore,
  parseSlashScore, scoreToSlashScore, type SlashScoreKind,
} from "./src/slashscore";

// Minimized R29 single-voice case: S starts at 1/4, crosses the first slash,
// and stops at beat 2. A normal save used to write the second beat as a rest.
const case29 = [
  "键盘谱",
  "// 每行一小节，/ 分隔拍组；未识别的其他文字作为注释保留。",
  "标题 = 键盘谱",
  "1 = C",
  "4/4拍：",
  "速度 = 每分钟90四分音符(90 BPM)",
  ". = 16分音符",
  "花括号 = 和弦（括号内音符同时发声）",
  "方括号 = 三连音（括号内三个时值按 3:2 压缩）",
  "尖括号 = 倚音（装饰音不增加小节拍长）",
  "圆括号 = 和弦（括号内音符同时发声）",
  "",
  "A.S.../..../0..../0..../",
  "",
  '// @jpeditor {"v":2,"vc":1,"k":"k","kl":false,"kz":false,"kh":false,"n":"","bpm":90,"bu":"quarter","f":0,"m":[4,4],"s":{".":16},"ms":false,"sp":null,"nd":null,"er":false,"ri":true,"b":"c","q":"t","vb":"n","x":"g","p":"c","o":"pitch-asc","i":"钢琴"}',
  "",
].join("\n");

// Exact two-voice R29-S0 pre-edit score from the browser replay. V1's second
// pitch sounds 1/4→9/4 while V2's first pitch is split into a 3:2 container.
const V = "\u2063";
const r29TwoVoice = [
  "数字谱",
  "// 每行一小节，/ 分隔拍组；未识别的其他文字作为注释保留。",
  "标题 = 数字谱",
  "1 = C",
  "4/4拍：",
  "速度 = 每分钟90四分音符(90 BPM)",
  ". = 16分音符",
  "花括号 = 琶音（括号内两个及以上音按滚奏和弦处理）",
  "方括号 = 三连音（括号内三个时值按 3:2 压缩）",
  "尖括号 = 倚音（装饰音不增加小节拍长）",
  "圆括号 = 和弦（括号内音符同时发声）",
  "",
  `(-5${V}7).${V}5.-2../..../.${V}3.(-2${V}7).${V}3./-7.${V}7.-2.${V}6./`,
  "",
  '// @jpeditor {"v":2,"vc":2,"k":"n","kl":false,"kz":false,"kh":false,"n":"","bpm":90,"bu":"quarter","f":0,"m":[4,4],"s":{".":16},"ms":false,"sp":null,"nd":null,"er":false,"ri":true,"b":"a","q":"t","vb":"n","x":"g","p":"c","o":"pitch-asc","i":"钢琴"}',
  "",
].join("\n");

// Random stress R292-S0: a V1 tuplet is sliced over two slash groups while
// V2's F is a whole note. Draft-rest preservation must not stop V2 at beat 2.
const r292TwoVoice = [
  "键盘谱",
  "// 每行一小节，/ 分隔拍组；未识别的其他文字作为注释保留。",
  "标题 = 键盘谱",
  "1 = C",
  "4/4拍：",
  "速度 = 每分钟90四分音符(90 BPM)",
  ". = 16分音符",
  "花括号 = 琶音（括号内两个及以上音按滚奏和弦处理）",
  "方括号 = 三连音（括号内三个时值按 3:2 压缩）",
  "尖括号 = 倚音（装饰音不增加小节拍长）",
  "圆括号 = 和弦（括号内音符同时发声）",
  "",
  `(M${V}F)..../..../..../${V}F..../`,
  "",
  '// @jpeditor {"v":2,"vc":2,"k":"k","kl":false,"kz":false,"kh":false,"n":"","bpm":90,"bu":"quarter","f":0,"m":[4,4],"s":{".":16},"ms":false,"sp":null,"nd":null,"er":false,"ri":false,"b":"a","q":"t","vb":"n","x":"g","p":"c","o":"pitch-asc","i":"钢琴"}',
  "",
].join("\n");

type Sound = Array<Array<{ measure: number; at: string; end: string; pitch: number }>>;
function sound(score: Score): Sound {
  return score.parts.map((part) => part.measures.flatMap((measure, measureIndex) =>
    measure.entries.filter((entry): entry is Chord => entry instanceof Chord)
      .flatMap((chord) => chord.notes.filter((note) => !note.rest && !note.tieEnd)
        .map((note) => {
          let end = chord.position.plus(chord.duration ?? new Fraction(0));
          const seen = new Set([note]);
          let next = note.tieNext;
          while (next && !seen.has(next)) {
            seen.add(next);
            end = next.chord.position.plus(next.chord.duration ?? new Fraction(0));
            next = next.tieNext;
          }
          return { measure: measureIndex, at: chord.position.toString(),
            end: end.toString(), pitch: note.pitch };
        })))
    .sort((a, b) => a.measure - b.measure
      || Fraction.fromString(a.at).compareTo(Fraction.fromString(b.at))
      || a.pitch - b.pitch));
}
function timeline(score: Score) {
  return buildTimeline(score).notes.map((note) => ({
    part: note.part, pitch: note.pitch, from: note.t0, to: note.t1,
  })).sort((a, b) => a.part - b.part || a.from - b.from || a.pitch - b.pitch || a.to - b.to);
}
function read(text: string, kind: SlashScoreKind) {
  const options = defaultSlashScoreOptions(kind, analyzeSlashScore(text));
  const result = parseSlashScore(text, options);
  assert.deepEqual(result.summary.diagnostics.filter((item) => item.severity === "error"), []);
  return { score: result.score, options };
}
function save(score: Score, options: ReturnType<typeof read>["options"], draft = false) {
  const generated = scoreToSlashScore(score, options.kind, 16, ".", {
    braceMode: options.braceMode,
    bracketMode: options.bracketMode,
    barMode: options.barMode,
    angleMode: options.angleMode,
    parenMode: options.parenMode,
    ordering: options.ordering,
    showExplicitRests: options.showExplicitRests,
    durationNotation: options,
    preserveExplicitRestMeasures: draft
      ? score.parts[0]?.measures.map((_measure, index) => index) : undefined,
  }, options.voiceCount);
  return embedSlashScoreOptionsFromScore(generated, score, options);
}
function assertRoundTrip(label: string, text: string, kind: SlashScoreKind, draft = false) {
  const before = read(text, kind);
  const first = read(save(before.score, before.options, draft), kind);
  assert.deepEqual(sound(first.score), sound(before.score), `${label}: sound after first save`);
  assert.deepEqual(timeline(first.score), timeline(before.score), `${label}: playback after first save`);
  const second = read(save(first.score, first.options, draft), kind);
  assert.deepEqual(sound(second.score), sound(before.score), `${label}: sound after second save`);
  assert.deepEqual(timeline(second.score), timeline(before.score), `${label}: playback after second save`);
  console.log(`${label}: OK`);
}

assertRoundTrip("case29 normal", case29, "keyboard");
assertRoundTrip("case29 input draft", case29, "keyboard", true);
const hiddenRests = case29.replace('"ri":true', '"ri":false')
  .replace("A.S.../..../0..../0..../", "A.S.../..../..../..../");
assertRoundTrip("case29 hidden rests", hiddenRests, "keyboard");
const twoMeasures = case29.replace("A.S.../..../0..../0..../\n\n// @",
  "A.S.../..../0..../0..../\nA..../..../0..../0..../\n\n// @");
assertRoundTrip("current and last measure", twoMeasures, "keyboard", true);
const crossBar = case29.replace("A.S.../..../0..../0..../",
  "A..../..../..../..../\n..../..../0..../0..../");
assert.deepEqual(timeline(read(crossBar, "keyboard").score)
  .filter((note) => note.pitch === 60).map((note) => [note.from, note.to]), [[0, 6]]);
assertRoundTrip("cross-bar carry normal", crossBar, "keyboard");
assertRoundTrip("cross-bar carry draft", crossBar, "keyboard", true);
assertRoundTrip("R29 two voices no-op", r29TwoVoice, "number");
assertRoundTrip("R292 two voices no-op", r292TwoVoice, "keyboard");

{
  const before = read(r29TwoVoice, "number");
  const v1 = sound(before.score)[0];
  const changed = createInputTriplet(before.score,
    { partIndex: 1, measureIndex: 0, offset: new Fraction(0) }, new Fraction(1, 2));
  assert.equal(changed.changed, true);
  assert.deepEqual(sound(before.score)[0], v1, "creating V2 triplet must preserve V1");
  const after = read(save(before.score, before.options, true), "number");
  assert.deepEqual(sound(after.score), sound(before.score), "R29 create: sound after save");
  assert.deepEqual(timeline(after.score), timeline(before.score), "R29 create: playback after save");
  assert.deepEqual(sound(after.score)[0]?.find((note) => note.at === "1/4"),
    { measure: 0, at: "1/4", end: "9/4", pitch: 67 });
  console.log("R29 two voices create triplet: OK");
}

{
  const before = read(r292TwoVoice, "keyboard");
  const changed = createInputTriplet(before.score,
    { partIndex: 0, measureIndex: 0, offset: new Fraction(0) }, new Fraction(1, 4));
  assert.equal(changed.changed, true);
  const expected = sound(before.score);
  assert.deepEqual(expected[1]?.find((note) => note.at === "0"),
    { measure: 0, at: "0", end: "4", pitch: 59 });
  const after = read(save(before.score, before.options, true), "keyboard");
  assert.deepEqual(sound(after.score), expected, "R292 create: whole-note voice after save");
  assert.deepEqual(timeline(after.score), timeline(before.score), "R292 create: playback after save");
  console.log("R292 parallel whole note after tuplet: OK");
}

{
  const before = read(r292TwoVoice, "keyboard");
  const changed = createInputTriplet(before.score,
    { partIndex: 0, measureIndex: 0, offset: new Fraction(0) }, new Fraction(1, 4));
  assert.equal(changed.changed, true);
  for (const member of changed.chords.slice(1)) {
    inputNoteAtCursor(before.score, { partIndex: 0, measureIndex: 0,
      offset: member.position, division: 16, lane: "rest" },
      { pitch: 65, number: "4" }, member.duration!);
  }
  const expected = sound(before.score);
  assert.deepEqual(expected[0]?.find((note) => note.at === "4/3"),
    { measure: 0, at: "4/3", end: "2", pitch: 65 });
  const after = read(save(before.score, before.options, true), "keyboard");
  assert.deepEqual(sound(after.score), expected, "R292 filled: V1 rest and V2 sustain");
  assert.deepEqual(timeline(after.score), timeline(before.score), "R292 filled: playback after save");
  console.log("R292 filled tuplet and parallel whole note: OK");
}
