import assert from "node:assert/strict";
import { Fraction } from "./src/common/fraction";
import { Chord, CrossPartArpeggio, Note, type Score } from "./src/score/score";
import { parseEditableDocument } from "./src/editor/document-parser";
import { ScoreInputSession } from "./src/editor/input-mode";
import { applyInputTargetsDegree, editInputTargetsTiming, inputNoteWrittenDuration, setInputTargetsWrittenDuration, inputTargetFromNote, inputTargetsShareOnset, rebindInputTargets,
  resolveInputTarget, type InputTarget } from "./src/editor/multi-input";
import { scoreToJpwabc } from "./src/score/jpscore";
import { chordArpeggioPitchGroups, setChordArpeggioPitchGroups } from "./src/score/arpeggio";
import { analyzeSlashScore, defaultSlashScoreOptions, scoreToSlashScore, embedSlashScoreOptionsFromScore } from "./src/slashscore";
import { scoreNoteTimingFingerprint, partNeedsExplicitNoteTies } from "./src/score/note-timing";

const limited = `.Title\nKeyAndMeters = {1=C,4/4}\n.Voice.Piano.V1\n[135] 2 0 0 |]\n.Voice.Piano.V2\n[246]_ 0_ 0 0 0 |]\n`;
const moving = `.Title\nKeyAndMeters = {1=C,4/4}\n.Voice.Piano.V1\n0_ [135]_ 0 0 0 |]\n.Voice.Piano.V2\n0_ [246]_ 0 0 0 |]\n`;
function parse(text: string): Score {
  const result = parseEditableDocument(text, "jpw", null); assert(result); return result.score;
}
function tone(score: Score, part: number, at: string, degree: string, occurrence = 0): Note {
  const note = score.parts[part].measures.flatMap(measure => measure.entries.flatMap(entry =>
    entry instanceof Chord && entry.measure.position.plus(entry.position).equals(Fraction.fromString(at))
      ? entry.notes.filter(note => note.number === degree && !note.rest) : []))[occurrence];
  assert(note, `missing part ${part}, beat ${at}, degree ${degree}`); return note;
}
function targets(score: Score, at = "0"): InputTarget[] {
  return [[0, "1"], [0, "3"], [1, "2"]].map(([part, degree]) =>
    inputTargetFromNote(score, Number(part), tone(score, Number(part), at, String(degree)), 16));
}
function expectSpan(score: Score, part: number, pitch: number, start: string, end: string, occurrence = 0): void {
  const spans = JSON.parse(scoreNoteTimingFingerprint(score)) as Array<{part: number; pitch: number; start: string; end: string}>;
  const span = spans.filter(item => item.part === part && item.pitch === pitch && item.start === start)[occurrence];
  assert(span, `missing attack part ${part}, pitch ${pitch}, at ${start}`);
  assert.equal(span.end, end, `wrong tail part ${part}, pitch ${pitch}, at ${start}`);
}
function arpeggios(score: Score): string {
  const local = score.parts.flatMap((part, partIndex) => part.measures.flatMap(measure => measure.entries.flatMap(entry =>
    entry instanceof Chord ? chordArpeggioPitchGroups(entry).map(group =>
      ["local", partIndex, entry.measure.index, entry.position.toString(), [...group].sort((a, b) => a - b)]) : [])));
  const cross = score.crossPartArpeggios.map(mark => ["cross", mark.measure, mark.offset.toString(), mark.direction,
    mark.pitches.map(item => [item.part, item.pitch]).sort((a, b) => a[0] - b[0] || a[1] - b[1])]);
  return JSON.stringify([...local, ...cross].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}
let checked = 0;
function roundTrip(score: Score, selected: readonly InputTarget[], label: string, inspect?: (score: Score) => void): void {
  const expected = scoreNoteTimingFingerprint(score);
  const expectedArpeggios = arpeggios(score);
  for (const format of ["jpw", "keyboard", "number"] as const) {
    let current = score;
    let rebound = [...selected];
    for (let pass = 0; pass < 2; pass++) {
      let text = format === "jpw" ? scoreToJpwabc(current) : scoreToSlashScore(current, format, 16, ".",
        { bracketMode: "triplet", braceMode: "arpeggio", showExplicitRests: true }, current.parts.length);
      if (format !== "jpw") text = embedSlashScoreOptionsFromScore(text, current,
        defaultSlashScoreOptions(format, analyzeSlashScore(text)));
      const result = parseEditableDocument(text, format,
        format === "jpw" ? null : defaultSlashScoreOptions(format, analyzeSlashScore(text)));
      assert(result, `${label}: ${format} parse ${pass}`);
      assert.deepEqual(result.slashTimingDiagnostics, [], `${label}: ${format} diagnostics`);
      assert.equal(scoreNoteTimingFingerprint(result.score), expected, `${label}: ${format} round trip ${pass}\n${text}`);
      assert.equal(arpeggios(result.score), expectedArpeggios, `${label}: ${format} rolled subsets\n${text}`);
      if (inspect) try { inspect(result.score); } catch (error) {
        throw new Error(`${label}: ${format} notation round trip ${pass}\n${text}`, { cause: error });
      }
      rebound = rebindInputTargets(result.score, rebound);
      assert.equal(rebound.length, selected.length, `${label}: ${format} selected occurrences`);
      assert(rebound.every(target => resolveInputTarget(result.score, target).note));
      current = result.score;
      checked++;
    }
  }
}

// Two upper members are at the next attack. Only the selected lower member
// may lengthen; every unselected member keeps its independent original tail.
{
  const score = parse(limited); const selected = targets(score);
  const session = new ScoreInputSession(); session.setTargets(score, selected, 1);
  const beforeText = scoreToJpwabc(score); const before = session.snapshot();
  const result = editInputTargetsTiming(score, selected, "resize", new Fraction(1, 4));
  assert.equal(result.changed, 1); assert.equal(result.skipped, 2); assert.equal(result.blocked, 0);
  expectSpan(score, 0, 60, "0", "1"); expectSpan(score, 0, 64, "0", "1"); expectSpan(score, 0, 67, "0", "1");
  expectSpan(score, 1, 62, "0", "3/4"); expectSpan(score, 1, 65, "0", "1/2"); expectSpan(score, 1, 69, "0", "1/2");
  assert(partNeedsExplicitNoteTies(score.parts[1]));
  roundTrip(score, result.targets, "partial capacity");
  const restored = parse(beforeText); session.restore(restored, before);
  assert.deepEqual(session.snapshot(), before, "one undo session must restore the exact multi-selection");
  expectSpan(restored, 1, 62, "0", "1/2");
}
{
  const score = parse(limited); const result = editInputTargetsTiming(score, targets(score), "resize", new Fraction(-1, 4));
  assert.equal(result.changed, 3); assert.equal(result.skipped, 0); assert.equal(result.blocked, 0);
  expectSpan(score, 0, 60, "0", "3/4"); expectSpan(score, 0, 64, "0", "3/4"); expectSpan(score, 0, 67, "0", "1");
  expectSpan(score, 1, 62, "0", "1/4"); expectSpan(score, 1, 65, "0", "1/2"); expectSpan(score, 1, 69, "0", "1/2");
  roundTrip(score, result.targets, "subset shortening");
}
for (const direction of [-1, 1]) {
  const score = parse(moving); const result = editInputTargetsTiming(score, targets(score, "1/2"), "move", new Fraction(direction, 4));
  assert.equal(result.changed, 3); assert.equal(result.blocked, 0);
  const start = direction > 0 ? "3/4" : "1/4"; const end = direction > 0 ? "5/4" : "3/4";
  expectSpan(score, 0, 60, start, end); expectSpan(score, 0, 64, start, end); expectSpan(score, 1, 62, start, end);
  expectSpan(score, 0, 67, "1/2", "1"); expectSpan(score, 1, 65, "1/2", "1"); expectSpan(score, 1, 69, "1/2", "1");
  roundTrip(score, result.targets, `subset move ${direction}`);
}
{
  const score = parse(limited); const selected = targets(score).slice(0, 2); const before = scoreToJpwabc(score);
  const result = editInputTargetsTiming(score, selected, "resize", new Fraction(1, 4));
  assert.equal(result.changed, 0); assert.equal(result.skipped, 2); assert.equal(result.blocked, 0);
  assert.equal(scoreToJpwabc(score), before, "all-full gesture must not publish a fake success or undo entry");
}
{
  const score = parse(limited);
  const selected = [inputTargetFromNote(score, 0, tone(score, 0, "0", "1"), 16),
    inputTargetFromNote(score, 0, tone(score, 0, "1", "2"), 16)];
  const before = scoreNoteTimingFingerprint(score);
  assert.equal(inputTargetsShareOnset(score, selected), false);
  const result = editInputTargetsTiming(score, selected, "resize", new Fraction(1, 4));
  assert.equal(result.changed, 0); assert(result.blocked);
  assert.equal(scoreNoteTimingFingerprint(score), before, "different-onset requests must retain the old guard");
}
// Moving across a real barline preserves the entire selected tie and the
// unselected chord member ending exactly at the old barline.
{
  const score = parse(`.Title\nKeyAndMeters = {1=C,4/4}\n.Voice.Piano.V1\n0 0 0 [135] | 0 0 0 0 |]\n`);
  const selected = ["1", "3"].map(degree => inputTargetFromNote(score, 0, tone(score, 0, "3", degree), 16));
  const result = editInputTargetsTiming(score, selected, "move", new Fraction(1, 4));
  assert.equal(result.changed, 2); assert.equal(result.blocked, 0);
  expectSpan(score, 0, 60, "13/4", "17/4"); expectSpan(score, 0, 64, "13/4", "17/4");
  expectSpan(score, 0, 67, "3", "4");
  roundTrip(score, result.targets, "cross-bar selected ties");
}
// A collision in either selected voice prevents the whole move. This is
// distinct from ordinary duration capacity, which permits a partial result.
{
  const score = parse(limited); const before = scoreNoteTimingFingerprint(score);
  const result = editInputTargetsTiming(score, targets(score), "move", new Fraction(1, 4));
  assert.equal(result.changed, 0); assert(result.blocked);
  assert.equal(scoreNoteTimingFingerprint(score), before);
}
// Equal pitches in two voices retain two independent attacks and targets.
{
  const score = parse(moving.replace("[246]", "[146]"));
  const selected = [0, 1].map(part => inputTargetFromNote(score, part, tone(score, part, "1/2", "1"), 16));
  const result = editInputTargetsTiming(score, selected, "move", new Fraction(1, 4));
  assert.equal(result.changed, 2); assert.equal(result.blocked, 0);
  expectSpan(score, 0, 60, "3/4", "5/4"); expectSpan(score, 1, 60, "3/4", "5/4");
  roundTrip(score, result.targets, "equal pitch independent voices");
}
// Two identical pitches in one chord are still exact selected occurrences.
{
  const score = parse(moving.replace("[135]", "[1135]"));
  const selected = [0, 1].map(occurrence => inputTargetFromNote(score, 0, tone(score, 0, "1/2", "1", occurrence), 16));
  const result = editInputTargetsTiming(score, selected, "resize", new Fraction(-1, 4));
  assert.equal(result.changed, 2); assert.equal(result.blocked, 0);
  expectSpan(score, 0, 60, "1/2", "3/4", 0); expectSpan(score, 0, 60, "1/2", "3/4", 1);
  expectSpan(score, 0, 64, "1/2", "1"); expectSpan(score, 0, 67, "1/2", "1");
  roundTrip(score, result.targets, "equal pitch occurrences");
}
// Tuplet capacity uses its written member unit, while its actual domain stays
// fixed. Only the selected chord subset consumes the following tuplet rest.
{
  const score = parse(`.Title\nKeyAndMeters = {1=C,4/4}\n.Voice.Piano.V1\n{(3}[135]_ 0_ 2_) 0 0 0 |]\n`);
  const selected = ["1", "3"].map(degree => inputTargetFromNote(score, 0, tone(score, 0, "0", degree), 16));
  const result = editInputTargetsTiming(score, selected, "resize", new Fraction(1, 4));
  assert.equal(result.changed, 2); assert.equal(result.blocked, 0);
  expectSpan(score, 0, 60, "0", "2/3"); expectSpan(score, 0, 64, "0", "2/3"); expectSpan(score, 0, 67, "0", "1/3");
  expectSpan(score, 0, 62, "2/3", "1");
  roundTrip(score, result.targets, "tuplet subset extension");
}
// Independent rolled subsets follow their actual selected members instead
// of flattening into one larger wave after a note leaves the original chord.
{
  const score = parse(moving.replace("[135]", "[1234567]"));
  const first = tone(score, 0, "1/2", "1");
  setChordArpeggioPitchGroups(first.chord, [[60, 62], [67, 69]]);
  const selected = ["1", "2"].map(degree => inputTargetFromNote(score, 0, tone(score, 0, "1/2", degree), 16));
  const result = editInputTargetsTiming(score, selected, "move", new Fraction(1, 4));
  assert.equal(result.changed, 2); assert.equal(result.blocked, 0);
  assert.deepEqual(chordArpeggioPitchGroups(tone(score, 0, "3/4", "1").chord), [[60, 62]]);
  assert.deepEqual(chordArpeggioPitchGroups(tone(score, 0, "1/2", "5").chord), [[67, 69]]);
  roundTrip(score, result.targets, "independent arpeggio subsets after move");
}
{
  // Keep F unoccupied for this valid pitch edit. Ambiguous final-unison
  // ownership is rejected and covered by the multi-input regressions.
  const score = parse(limited.replace("[135]", "[123567]"));
  const first = tone(score, 0, "0", "1");
  setChordArpeggioPitchGroups(first.chord, [[60, 62], [67, 69]]);
  const mark = new CrossPartArpeggio(); mark.measure = 0; mark.offset = new Fraction(0);
  mark.parts = [0, 1]; mark.pitches = [{ part: 0, pitch: 60 }, { part: 1, pitch: 62 }];
  score.crossPartArpeggios.push(mark);
  const result = applyInputTargetsDegree(score, [inputTargetFromNote(score, 0, first, 16)], 4);
  assert.equal(result.blocked, 0);
  assert.deepEqual(chordArpeggioPitchGroups(first.chord), [[65, 62], [67, 69]]);
  assert.deepEqual(mark.pitches, [{ part: 0, pitch: 65 }, { part: 1, pitch: 62 }]);
}
// A complete cross-part roll follows both selected attacks to their new
// shared onset. Partial movement splits a roll into the still-valid subsets.
for (const complete of [true, false]) {
  const score = parse(moving);
  const mark = new CrossPartArpeggio(); mark.measure = 0; mark.offset = new Fraction(1, 2); mark.parts = [0, 1];
  mark.pitches = complete ? [{ part: 0, pitch: 60 }, { part: 1, pitch: 62 }]
    : [{ part: 0, pitch: 60 }, { part: 0, pitch: 64 }, { part: 1, pitch: 62 }, { part: 1, pitch: 65 }];
  score.crossPartArpeggios.push(mark);
  const selected = complete
    ? [inputTargetFromNote(score, 0, tone(score, 0, "1/2", "1"), 16), inputTargetFromNote(score, 1, tone(score, 1, "1/2", "2"), 16)]
    : ["1", "3"].map(degree => inputTargetFromNote(score, 0, tone(score, 0, "1/2", degree), 16));
  const result = editInputTargetsTiming(score, selected, "move", new Fraction(1, 4));
  assert.equal(result.changed, 2); assert.equal(result.blocked, 0);
  if (complete) {
    assert.equal(score.crossPartArpeggios.length, 1); assert.equal(mark.offset.toString(), "3/4");
    assert.deepEqual(mark.pitches, [{ part: 0, pitch: 60 }, { part: 1, pitch: 62 }]);
  } else {
    assert.equal(score.crossPartArpeggios.length, 0);
    assert.deepEqual(chordArpeggioPitchGroups(tone(score, 0, "3/4", "1").chord), [[60, 64]]);
    assert.deepEqual(chordArpeggioPitchGroups(tone(score, 1, "1/2", "2").chord), [[62, 65]]);
  }
  roundTrip(score, result.targets, complete ? "whole cross-part roll move" : "cross-part roll split into local subsets");
}
// Local rolls currently have only upward playback. A complete downward
// cross-part roll can move, but splitting it into local groups must reject
// the entire gesture before any note, tie or annotation is changed.
for (const complete of [true, false]) {
  const score = parse(moving);
  const mark = new CrossPartArpeggio(); mark.measure = 0; mark.offset = new Fraction(1, 2);
  mark.parts = [0, 1]; mark.direction = "down";
  mark.pitches = [{ part: 0, pitch: 60 }, { part: 0, pitch: 64 }, { part: 1, pitch: 62 }, { part: 1, pitch: 65 }];
  score.crossPartArpeggios.push(mark);
  const members: Array<[number, string]> = [[0, "1"], [0, "3"]];
  if (complete) members.push([1, "2"], [1, "4"]);
  const selected = members.map(([part, degree]) => inputTargetFromNote(score, part, tone(score, part, "1/2", degree), 16));
  const beforeText = scoreToJpwabc(score);
  const beforeTiming = scoreNoteTimingFingerprint(score);
  const beforeMarks = arpeggios(score);
  const result = editInputTargetsTiming(score, selected, "move", new Fraction(1, 4));
  if (complete) {
    assert.equal(result.changed, 4); assert.equal(result.blocked, 0);
    assert.equal(mark.offset.toString(), "3/4"); assert.equal(mark.direction, "down");
    assert.equal(score.crossPartArpeggios.length, 1);
    for (const item of mark.pitches) expectSpan(score, item.part, item.pitch, "3/4", "5/4");
    expectSpan(score, 0, 67, "1/2", "1"); expectSpan(score, 1, 69, "1/2", "1");
    roundTrip(score, result.targets, "whole downward cross-part roll move");
  } else {
    assert.equal(result.changed, 0); assert.equal(result.blocked, 1); assert.equal(result.skipped, 0);
    assert.equal(result.reason, "incompatible-target");
    assert.equal(scoreNoteTimingFingerprint(score), beforeTiming, "unsupported downward split keeps every attack and tail");
    assert.equal(arpeggios(score), beforeMarks, "unsupported downward split keeps every original roll and direction");
    assert.equal(scoreToJpwabc(score), beforeText, "blocked gesture does not change the saved source");
    assert.equal(score.crossPartArpeggios[0], mark, "blocked gesture retains the original mark object");
  }
}
// Both score surfaces share the right-click duration menu. Absolute values
// and dots operate on each logical note, including after a partial-tail edit.
for (const [duration, expectedChanged, upperEnd, lowerEnd] of [
  ["1/2", 2, "1/2", "1/2"], ["1/4", 3, "1/4", "1/4"], ["1", 1, "1", "1"],
] as const) {
  const score = parse(limited);
  const result = setInputTargetsWrittenDuration(score, targets(score), () => Fraction.fromString(duration));
  assert.equal(result.changed, expectedChanged); assert.equal(result.blocked, 0);
  expectSpan(score, 0, 60, "0", upperEnd); expectSpan(score, 0, 64, "0", upperEnd);
  expectSpan(score, 1, 62, "0", lowerEnd);
  expectSpan(score, 0, 67, "0", "1"); expectSpan(score, 1, 65, "0", "1/2"); expectSpan(score, 1, 69, "0", "1/2");
  roundTrip(score, result.targets, `absolute duration ${duration}`);
}
{
  const score = parse(limited);
  const result = setInputTargetsWrittenDuration(score, targets(score), note => inputNoteWrittenDuration(note).timesInt(3).divInt(2));
  assert.equal(result.changed, 1); assert.equal(result.skipped, 2); assert.equal(result.blocked, 0);
  expectSpan(score, 0, 60, "0", "1"); expectSpan(score, 0, 64, "0", "1"); expectSpan(score, 1, 62, "0", "3/4");
  expectSpan(score, 0, 67, "0", "1"); expectSpan(score, 1, 65, "0", "1/2"); expectSpan(score, 1, 69, "0", "1/2");
  roundTrip(score, result.targets, "menu dot with two capacity limits");
}
{
  const score = parse(limited);
  const shortened = setInputTargetsWrittenDuration(score, targets(score), () => new Fraction(1, 4));
  assert(shortened.targets.every(target => inputNoteWrittenDuration(resolveInputTarget(score, target).note!).equals(new Fraction(1, 4))));
  const restored = setInputTargetsWrittenDuration(score, shortened.targets, () => new Fraction(1));
  assert.equal(restored.changed, 3); assert.equal(restored.blocked, 0);
  expectSpan(score, 0, 60, "0", "1"); expectSpan(score, 0, 64, "0", "1"); expectSpan(score, 1, 62, "0", "1");
  expectSpan(score, 0, 67, "0", "1"); expectSpan(score, 1, 65, "0", "1/2");
  roundTrip(score, restored.targets, "absolute duration after partial ties");
}
// A moved complete chord may share its new column with an existing marked
// attack. Compatible marks survive from both origins, including after saving.
{
  const score = parse(`.Title\nKeyAndMeters = {1=C,4/4}\n.Voice.Piano.V1\n[135]_ [246]_ 0 0 0 |]\n`);
  const source = tone(score, 0, "0", "1").chord;
  const destination = tone(score, 0, "1/2", "2").chord;
  source.ornaments = [{ kind: "upper-mordent" }];
  destination.fermata = true;
  destination.ornaments = [{ kind: "lower-mordent" }];
  const selected = source.notes.map(note => inputTargetFromNote(score, 0, note, 16));
  const result = editInputTargetsTiming(score, selected, "move", new Fraction(1, 2));
  assert.equal(result.changed, 3); assert.equal(result.blocked, 0);
  for (const pitch of [60, 64, 67]) expectSpan(score, 0, pitch, "1/2", "1");
  for (const pitch of [62, 65, 69]) expectSpan(score, 0, pitch, "1/2", "1");
  const inspect = (restored: Score): void => {
    const chord = tone(restored, 0, "1/2", "2").chord;
    assert.deepEqual(chord.ornaments.map(item => item.kind).sort(), ["lower-mordent", "upper-mordent"]);
  };
  assert(tone(score, 0, "1/2", "2").chord.fermata);
  assert(tone(parse(scoreToJpwabc(score)), 0, "1/2", "2").chord.fermata,
    "destination fermata survives the edited JPW document");
  inspect(score); roundTrip(score, result.targets, "merged source/destination notation", inspect);
}
// Conflicting single-column notation is rejected before any notes, ties,
// grace ownership or notation references have been changed.
for (const conflict of ["grace", "slur", "trill"] as const) {
  const score = parse(`.Title\nKeyAndMeters = {1=C,4/4}\n.Voice.Piano.V1\n[135]_ [246]_ 0 0 0 |]\n`);
  const source = tone(score, 0, "0", "1").chord;
  const destination = tone(score, 0, "1/2", "2").chord;
  if (conflict === "grace") {
    const firstGrace = new Note(source); firstGrace.pitch = 72; firstGrace.number = "1"; firstGrace.jpOctave = 1;
    const secondGrace = new Note(destination); secondGrace.pitch = 74; secondGrace.number = "2"; secondGrace.jpOctave = 1;
    source.graceNotes = [firstGrace]; destination.graceNotes = [secondGrace];
  } else if (conflict === "slur") {
    source.slurStart = true; source.slurEndChord = destination;
    destination.slurStart = true;
  } else {
    source.ornaments = [{ kind: "trill", subdivision: 16 }];
    destination.ornaments = [{ kind: "trill", subdivision: 32 }];
  }
  const before = scoreNoteTimingFingerprint(score);
  const entries = [...score.parts[0].measures[0].entries];
  const ownership = source.notes.concat(destination.notes).map(note => note.chord);
  const graceOwnership = source.graceNotes.concat(destination.graceNotes).map(note => note.chord);
  const result = editInputTargetsTiming(score, source.notes.map(note => inputTargetFromNote(score, 0, note, 16)),
    "move", new Fraction(1, 2));
  assert.equal(result.changed, 0); assert.equal(result.blocked, 1); assert.equal(result.reason, "incompatible-target");
  assert.equal(scoreNoteTimingFingerprint(score), before);
  assert.deepEqual(score.parts[0].measures[0].entries, entries);
  assert.deepEqual(source.notes.concat(destination.notes).map(note => note.chord), ownership);
  assert.deepEqual(source.graceNotes.concat(destination.graceNotes).map(note => note.chord), graceOwnership);
}
// Complete and partial chord moves across a real key change preserve sounding
// pitch in each new segment, rather than reusing a degree under the new tonic.
for (const subset of [false, true]) {
  const score = parse(`.Title\nKeyAndMeters = {1=C,4/4}\nKeyChanges = {2=G}\n.Voice.Piano.V1\n0 0 0 [135] | 0 0 0 0 |]\n`);
  const selected = (subset ? ["1", "3"] : ["1", "3", "5"])
    .map(degree => inputTargetFromNote(score, 0, tone(score, 0, "3", degree), 16));
  const result = editInputTargetsTiming(score, selected, "move", new Fraction(1, 4));
  assert.equal(result.changed, subset ? 2 : 3); assert.equal(result.blocked, 0);
  expectSpan(score, 0, 60, "13/4", "17/4"); expectSpan(score, 0, 64, "13/4", "17/4");
  expectSpan(score, 0, 67, subset ? "3" : "13/4", subset ? "4" : "17/4");
  roundTrip(score, result.targets, subset ? "partial cross-key move" : "whole cross-key move");
}
// Moving into a changed key at the attack also respells reused root notes;
// untouched keys retain their original enharmonic numbered spelling.
{
  const score = parse(`.Title\nKeyAndMeters = {1=C,4/4}\nKeyChanges = {2=G}\n.Voice.Piano.V1\n0 0 0 0_ [#1b35]_ | 0 0 0 0 |]\n`);
  const source = tone(score, 0, "7/2", "5").chord;
  const selected = source.notes.map(note => inputTargetFromNote(score, 0, note, 16));
  const result = editInputTargetsTiming(score, selected, "move", new Fraction(1, 2));
  assert.equal(result.changed, 3); assert.equal(result.blocked, 0);
  for (const pitch of [61, 63, 67]) expectSpan(score, 0, pitch, "4", "9/2");
  roundTrip(score, result.targets, "root attack into changed key");
}
{
  const score = parse(`.Title\nKeyAndMeters = {1=C,4/4}\n.Voice.Piano.V1\n0_ [b2b35]_ 0 0 0 |]\n`);
  const source = tone(score, 0, "1/2", "5").chord;
  const before = source.notes.map(note => [note.pitch, note.number, note.jpAlter, note.jpOctave]);
  const result = editInputTargetsTiming(score, source.notes.map(note => inputTargetFromNote(score, 0, note, 16)),
    "move", new Fraction(1, 4));
  assert.equal(result.changed, 3); assert.equal(result.blocked, 0);
  assert.deepEqual(tone(score, 0, "3/4", "5").chord.notes.map(note => [note.pitch, note.number, note.jpAlter, note.jpOctave]), before);
  roundTrip(score, result.targets, "same-key enharmonic move");
}
console.log(`same-onset-input-check: ok (${checked} JPW/keyboard/number persistence checks, exact subset timing, limits and snapshots)`);
