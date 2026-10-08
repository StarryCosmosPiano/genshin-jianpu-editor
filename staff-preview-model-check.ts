import assert from "node:assert/strict";
import { Fraction } from "./src/common/fraction";
import { Chord, Measure, Note, Part, Score, TempoMark, Tuplet } from "./src/score/score";
import { buildStaffModel } from "./src/staff-preview/model";
import { createStaffNoteRegistry } from "./src/staff-preview/identity";
import type { JpwSourceNote } from "./src/editor/note-selection";
import type { StaffPreviewSnapshot } from "./src/staff-preview/types";

function fixture(piano = false): Score {
  const score = new Score(); score.piano = piano;
  score.parts = Array.from({ length: piano ? 2 : 1 }, (_, i) => {
    const part = new Part(); part.hand = piano ? i === 0 ? "right" : "left" : null;
    part.measures = [new Measure(0), new Measure(1)];
    part.measures[1].position = new Fraction(4);
    return part;
  });
  return score;
}
function chord(score: Score, part: number, mid: number, pos: Fraction, duration: Fraction, pitches: number[]): Chord {
  const measure = score.parts[part].measures[mid];
  const ch = new Chord(measure); ch.position = pos; ch.duration = duration;
  for (const pitch of pitches) { const note = new Note(ch); note.pitch = pitch; note.number = "1"; ch.add(note); }
  measure.entries.push(ch); return ch;
}
function snapshot(score: Score, revision = 1): StaffPreviewSnapshot {
  const sources: JpwSourceNote[] = [];
  score.parts.forEach((part, partIndex) => part.measures.forEach(measure => {
    measure.entries.forEach((entry, chordIndex) => {
      if (!(entry instanceof Chord)) return;
      for (const [grace, notes] of [[false, entry.notes], [true, entry.graceNotes]] as const) notes.forEach(note => {
        // Continuation notes are deliberately mapped through their attack.
        if (note.tiePrev) return;
        const from = sources.length * 2;
        sources.push({ note, chord: entry, grace, partIndex, chordIndex, from, to: from + 1, tokenFrom: from, tokenTo: from + 1 });
      });
    });
  }));
  return { score, sources, revision, current: true, registry: createStaffNoteRegistry(score, sources, revision) };
}
function fingerprint(score: Score): string {
  return JSON.stringify(score.parts.map(part => part.measures.map(measure => measure.entries.map(entry =>
    entry instanceof Chord ? [entry.position.toString(), entry.duration?.toString(), entry.notes.map(note =>
      [note.pitch, note.number, note.tieStart, note.tieEnd, note.tuplet?.ratioNumerator])] : null))));
}

const score = fixture(true);
const first = chord(score, 0, 0, new Fraction(0), new Fraction(3), [60, 60, 64]);
const next = chord(score, 0, 0, new Fraction(3), new Fraction(1), [60]);
const continuation = chord(score, 0, 1, new Fraction(0), new Fraction(4), [60]);
continuation.transparentContinuation = true;
next.notes[0].tieNext = continuation.notes[0]; continuation.notes[0].tiePrev = next.notes[0];
const grace = new Note(first); grace.pitch = 62; first.graceNotes.push(grace);
first.slurEndChord = next;
chord(score, 1, 0, new Fraction(0), new Fraction(4), [48]);
chord(score, 1, 1, new Fraction(0), new Fraction(4), [48]);
const snap = snapshot(score);
const before = fingerprint(score);
const model = buildStaffModel(snap);
assert.equal(fingerprint(score), before, "adapter mutated the editable score");
assert.deepEqual(model.staves.map(staff => staff.clef), ["treble", "bass"]);
assert.equal(model.measures.length, 2);
const refs = first.notes.map(note => snap.registry.refFor(note)!);
assert.notEqual(refs[0].id, refs[1].id, "same-pitch chord tones lost their identity");
assert.equal(snap.registry.resolve(refs[1])?.note, first.notes[1]);
assert.equal(snap.registry.resolve({ ...refs[0], revision: 0 }), null, "outdated reference resolved");
assert.equal(snap.registry.resolve(snap.registry.refFor(continuation.notes[0])!)?.source?.note, next.notes[0]);
assert.equal(snap.registry.resolve(snap.registry.refFor(grace)!)?.grace, true);
assert(model.ties.length > 0 && model.slurs.length > 0);
const sourcePitch = model.measures[0].rows[0].events.flatMap(event => event.notes).find(pitch => pitch.sourceNote === next.notes[0]);
const continuationPitch = model.measures[1].rows[0].events.flatMap(event => event.notes).find(pitch => pitch.sourceNote === continuation.notes[0]);
assert(sourcePitch && continuationPitch && model.ties.some(tie => tie.from === sourcePitch.id && tie.to === continuationPitch.id),
  "transparent continuation lost its cross-measure tie or target note");
assert.equal(model.measures[0].rows[0].events[0].dots, 1);
assert.equal(model.measures[0].rows[0].events[0].grace[0].sourceNote, grace);

const tripletScore = fixture();
const members = [0, 1, 2].map(index => chord(tripletScore, 0, 0, new Fraction(index * 2, 3), new Fraction(2, 3), [60 + index * 2]));
const tuple = new Tuplet(members[0].notes[0], members[2].notes[0]); tuple.writtenUnit = new Fraction(1);
members.forEach(member => member.notes[0].tuplet = tuple);
chord(tripletScore, 0, 0, new Fraction(2), new Fraction(2), [65]);
const tupleModel = buildStaffModel(snapshot(tripletScore));
const events = tupleModel.measures[0].rows[0].events.filter(event => event.tuplet);
assert.equal(events.length, 3);
assert(events.every(event => event.duration === "q" && event.actualDuration.equals(new Fraction(2, 3))));
assert.equal(events.reduce((total, event) => total.plus(event.actualDuration), new Fraction(0)).toString(), "2");
const fresh = buildStaffModel(snapshot(tripletScore, 2));
assert.equal(fresh.measures[0].signature, tupleModel.measures[0].signature, "version invalidated identical geometry cache");

const fractional = fixture();
chord(fractional, 0, 0, new Fraction(0), new Fraction(1, 5), [60]);
assert.throws(() => buildStaffModel(snapshot(fractional)), /无法精确表示/);
const ensemble = fixture(true); ensemble.ensemble = true;
assert.throws(() => buildStaffModel(snapshot(ensemble)), /仅支持/);
const tempoScore = fixture();
chord(tempoScore, 0, 0, new Fraction(0), new Fraction(4), [60]);
tempoScore.tempoBpm = 90; tempoScore.tempoBeatUnit = "dotted-quarter";
assert.equal(buildStaffModel(snapshot(tempoScore)).measures[0].labels[0].text, "♩. = 60");
const tempoMark = new TempoMark(); tempoMark.bpm = 100; tempoMark.beatUnit = "eighth";
tempoScore.tempoMarks.push(tempoMark);
const tempoLabels = buildStaffModel(snapshot(tempoScore)).measures[0].labels;
assert.equal(tempoLabels.length, 1, "initial tempo annotation was duplicated");
assert.equal(tempoLabels[0].text, "♪ = 200");
const pianoClefs = fixture(true);
pianoClefs.parts.forEach(part => { part.hand = null; });
chord(pianoClefs, 0, 0, new Fraction(0), new Fraction(4), [36]);
chord(pianoClefs, 1, 0, new Fraction(0), new Fraction(4), [84]);
assert.deepEqual(buildStaffModel(snapshot(pianoClefs)).staves.map(staff => staff.clef), ["treble", "bass"],
  "piano grand staff must retain treble/bass when the hands cross registers");
const gapScore = fixture();
chord(gapScore, 0, 0, new Fraction(1, 3), new Fraction(1), [60]);
assert(buildStaffModel(snapshot(gapScore)).diagnostics.some(item => item.includes("未补写休止符")),
  "unwritten non-binary rest gap must be explained");
console.log("staff-preview-model-check: identity, exact tuplets, pitch spelling, ties/slurs, readonly and eligibility OK");
