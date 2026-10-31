import assert from "node:assert/strict";
import { Fraction } from "./src/common/fraction";
import { Chord, CrossPartArpeggio, Measure, Note, Part, PlayItem, Score, TempoMark } from "./src/score/score";
import { buildSelectionTimeline, buildTimeline, quarterToSeconds } from "./src/score/timeline";
import { timelineToMidi } from "./src/score/midi";
import { parseMidi } from "./src/midi/parser";
import { selectionAudition } from "./src/editor/selection-playback";

function fixture(parts = 2, measures = 2): Score {
  const score = new Score(); score.tempoBpm = 120;
  for (let p = 0; p < parts; p++) {
    const part = new Part(); score.parts.push(part);
    for (let m = 0; m < measures; m++) {
      const measure = new Measure(m);
      measure.position = new Fraction(m * 4);
      measure.timingMinimumDuration = new Fraction(4);
      part.measures.push(measure);
    }
  }
  return score;
}
function tone(score: Score, part: number, measure: number, at: number | Fraction, pitch: number, duration = 1): Note {
  const owner = score.parts[part].measures[measure];
  const chord = new Chord(owner);
  chord.position = at instanceof Fraction ? at : new Fraction(at);
  chord.duration = new Fraction(duration);
  const note = new Note(chord); note.pitch = pitch; note.number = "1";
  chord.add(note); owner.entries.push(chord);
  return note;
}

const score = fixture();
const first = tone(score, 0, 0, 0, 60);
const unselectedDuplicate = new Note(first.chord); unselectedDuplicate.pitch = first.pitch;
first.chord.add(unselectedDuplicate);
const aligned = tone(score, 1, 0, 0, 67);
const later = tone(score, 0, 0, 2, 62);
const final = tone(score, 0, 1, 0, 65, 2);
const almostAligned = tone(score, 1, 1, new Fraction(1, 1000000), 70);
assert.equal(selectionAudition(score, [first, aligned]).length, 2, "cross-part same onset auditions only selected tones");
assert.deepEqual(selectionAudition(score, [first, later]), [], "different onsets stay silent");
assert.deepEqual(selectionAudition(score, [final, almostAligned]), [], "exact Fraction comparison rejects nearly aligned notes");
assert.deepEqual(selectionAudition(score, []), []);
const subset = buildSelectionTimeline(score, new Set([first, final]));
assert.deepEqual(subset.notes.map(n => [n.pitch, n.t0, n.t1]), [[60, 0, 1], [65, 4, 6]], "gaps retained, same-pitch unselected tone excluded");
assert.equal(subset.duration, 6, "selected playback ends at final note off");
assert.deepEqual(buildSelectionTimeline(score, new Set([later])).notes.map(n => [n.t0, n.t1]), [[2, 3]], "one-note marquee has bounded timeline");
const midi = parseMidi(timelineToMidi(score, subset));
assert.deepEqual(midi.notes.map(n => [n.pitch, n.startTick / midi.ppq, n.endTick / midi.ppq]), [[60, 0, 1], [65, 4, 6]], "native MIDI shares filtered timeline");

const rolled = fixture();
const low = tone(rolled, 0, 0, 0, 60);
const high = tone(rolled, 1, 0, 0, 72);
const cross = new CrossPartArpeggio();
cross.parts = [0, 1]; cross.pitches = [{ part: 0, pitch: 60 }, { part: 1, pitch: 72 }];
rolled.crossPartArpeggios.push(cross);
let audition = selectionAudition(rolled, [low, high]);
assert.equal(audition[0].offsetSeconds, 0);
assert.equal(audition[1].offsetSeconds, 0.0625, "cross-part roll preserves delay");
cross.direction = "down";
audition = selectionAudition(rolled, [low, high]);
assert.equal(audition[0].offsetSeconds, 0.0625);
assert.equal(audition[1].offsetSeconds, 0, "descending arpeggio starts at high tone");
const unequalRoll = fixture(3, 1);
const unequalLow = tone(unequalRoll, 0, 0, 0, 60, 1);
const unequalMiddle = tone(unequalRoll, 1, 0, 0, 64, 4);
const unequalHigh = tone(unequalRoll, 2, 0, 0, 67, 1 / 16);
const unequalMark = new CrossPartArpeggio();
unequalMark.parts = [0, 1, 2];
unequalMark.pitches = [{ part: 0, pitch: 60 }, { part: 1, pitch: 64 }, { part: 2, pitch: 67 }];
unequalRoll.crossPartArpeggios.push(unequalMark);
const unequalSelection = [unequalLow, unequalMiddle, unequalHigh];
const increasing = selectionAudition(unequalRoll, unequalSelection).map(note => note.offsetSeconds!);
assert.deepEqual(increasing, [0, 1 / 320, 1 / 160],
  "unequal-duration cross-part arpeggio must use the shortest real note for one common ascending roll clock");
assert.ok(increasing[0] < increasing[1] && increasing[1] < increasing[2],
  "short high voice must not precede middle voice");
unequalMark.direction = "down";
const decreasing = selectionAudition(unequalRoll, unequalSelection).map(note => note.offsetSeconds!);
assert.deepEqual(decreasing, [1 / 160, 1 / 320, 0],
  "unequal-duration descending arpeggio must reverse ranks on the same common roll clock");
const unequalSubset = buildSelectionTimeline(unequalRoll, new Set(unequalSelection));
const unequalMidi = parseMidi(timelineToMidi(unequalRoll, unequalSubset));
assert.deepEqual(unequalMidi.notes.map(note => [note.pitch, note.startTick]), [[67, 0], [64, 6], [60, 12]],
  "native selected MIDI must preserve the shared descending roll order");
rolled.crossPartArpeggios = [];
const middle = new Note(low.chord); middle.pitch = 64; low.chord.add(middle); low.chord.arpeggio = true;
assert.ok(selectionAudition(rolled, [low, middle])[1].offsetSeconds! > 0, "local rolled chord is not flattened");

const tiedScore = fixture(1, 1);
const chain = [0, 1, 2].map(at => tone(tiedScore, 0, 0, at, 60));
chain.forEach((note, i) => {
  if (i > 0) { note.tieEnd = true; note.tiePrev = chain[i - 1]; }
  if (i < 2) { note.tieStart = true; note.tieNext = chain[i + 1]; }
});
assert.equal(buildTimeline(tiedScore).notes.length, 1);
assert.deepEqual(buildSelectionTimeline(tiedScore, new Set(chain)).notes.map(n => [n.t0, n.t1]), [[0, 3]], "adjacent selected tie segments do not retrigger");
assert.deepEqual(buildSelectionTimeline(tiedScore, new Set([chain[0]])).notes.map(n => [n.t0, n.t1]), [[0, 1]], "unselected tie tail is clipped");
assert.deepEqual(buildSelectionTimeline(tiedScore, new Set([chain[1]])).notes.map(n => [n.t0, n.t1]), [[1, 2]], "middle tie segment can start playback");
assert.deepEqual(buildSelectionTimeline(tiedScore, new Set([chain[0], chain[2]])).notes.map(n => [n.t0, n.t1]), [[0, 1], [2, 3]], "unselected gap inside a tie is silent");

const ornament = fixture(1, 1);
const embellished = tone(ornament, 0, 0, 0, 64);
embellished.number = "3";
embellished.chord.ornaments = [{ kind: "upper-mordent" }];
assert.deepEqual(buildSelectionTimeline(ornament, new Set([embellished])).notes.map(n => n.pitch), [64, 65, 64], "generated ornament pitches retain source identity");
assert.equal(selectionAudition(ornament, [embellished]).length, 3);

const repeated = fixture(1, 1);
const single = tone(repeated, 0, 0, 0, 60);
repeated.playData.measures = [1, 2].map(pass => Object.assign(new PlayItem(), { mid: 0, end: 1, pass }));
assert.equal(buildTimeline(repeated).notes.length, 2);
assert.equal(buildSelectionTimeline(repeated, new Set([single])).notes.length, 1, "selection plays written order once");
assert.equal(repeated.playData.measures.length, 2, "selection does not mutate full-score repeat order");

score.tempoMarks.push(Object.assign(new TempoMark(), { measure: 1, bpm: 60 }));
const tempoSubset = buildSelectionTimeline(score, new Set([first, final]));
assert.equal(quarterToSeconds(tempoSubset.tempo, 6), 4, "selection keeps local tempo changes");
assert.equal(quarterToSeconds(tempoSubset.tempo, 4), 2, "gap timing is unchanged");
assert.equal(buildSelectionTimeline(score, new Set()).duration, 0);
console.log("selection playback checks passed");
