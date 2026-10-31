import assert from "node:assert/strict";
import { Fraction } from "./src/common/fraction";
import { Chord, CrossPartArpeggio, KeyMark, Note, type Score } from "./src/score/score";
import { chordArpeggioPitchGroups, setChordArpeggioPitchGroups } from "./src/score/arpeggio";
import { parseEditableDocument } from "./src/editor/document-parser";
import { ScoreInputSession } from "./src/editor/input-mode";
import { scoreToJpwabc } from "./src/score/jpscore";
import { ensureInputMeasure } from "./src/score/input-edit";
import { scoreNoteTimingFingerprint } from "./src/score/note-timing";
import { staffPitchSpec } from "./src/editor/staff-edit";
import { analyzeSlashScore, defaultSlashScoreOptions, scoreToSlashScore } from "./src/slashscore";
import {
  applyInputTargetsDegree, applyInputTargetsDegreeStep, applyInputTargetsOctave, applyInputTargetsPitch, applyInputTargetsToPart,
  deleteInputTargets,
  inputTargetFromNote, inputTargetFromSnapshot, moveInputTargetsVertical,
  rebindInputTargets, resolveInputTarget,
} from "./src/editor/multi-input";

function fixture(): Score {
  const parsed = parseEditableDocument(".Title\nKeyAndMeters = {1=C,4/4}\n.Voice.Piano.V1\n[135] 2 3 4 | 1 2 3 4 |]\n.Voice.Piano.V2\n[246] 5 6 7 | 4 5 6 7 |]\n", "jpw", null);
  assert(parsed);
  return parsed.score;
}
function chord(score: Score, part = 0, at = 0): Chord {
  const result = score.parts[part].measures[0].entries.find((entry) => entry instanceof Chord && entry.position.equals(at));
  assert(result instanceof Chord);
  return result;
}
function tone(score: Score, part: number, at: number, degree: string): Note {
  const result = chord(score, part, at).notes.find((note) => note.number === degree);
  assert(result);
  return result;
}

// Pitch transactions preserve silence in every bar, even when explicit TXT
// export zeroes are disabled. The shared named-pitch route has the same contract.
for (const operation of ["degree", "degree-step", "octave", "named-pitch"] as const) {
  const source = "数字谱\n4/4拍：\n点=八分音符\n1./2./3./4./\n6./7./2./3./\n";
  const options = { ...defaultSlashScoreOptions("number", analyzeSlashScore(source)), showExplicitRests: false };
  const score = parseEditableDocument(source, "number", options)!.score;
  const target = inputTargetFromNote(score, 0, chord(score).notes[0], 16);
  const untouched = score.parts[0].measures[1].entries.flatMap(entry =>
    entry instanceof Chord ? entry.notes.filter(note => !note.rest).map(note => note.pitch) : []);
  const result = operation === "degree" ? applyInputTargetsDegree(score, [target], 5)
    : operation === "degree-step" ? applyInputTargetsDegreeStep(score, [target], 1)
    : operation === "octave" ? applyInputTargetsOctave(score, [target], 1)
    : applyInputTargetsPitch(score, [target], () => ({ pitch: 64, number: "3", jpOctave: 0, jpAlter: " ",
      step: "E", octave: 4, alter: 0 }));
  assert.equal(result.blocked, 0, `${operation} failed`);
  assert.equal(result.verifyTimings, true, `${operation} omitted full-score verification`);
  const expected = scoreNoteTimingFingerprint(score);
  const serialized = scoreToSlashScore(score, "number", 8, ".", {
    durationNotation: options, preserveExplicitRestMeasures: [0, 1],
  }, 1);
  const reopened = parseEditableDocument(serialized, "number", options)!.score;
  assert.equal(scoreNoteTimingFingerprint(reopened), expected, `${operation} changed sounding endpoints`);
  assert.deepEqual(reopened.parts[0].measures[1].entries.flatMap(entry =>
    entry instanceof Chord ? entry.notes.filter(note => !note.rest).map(note => note.pitch) : []), untouched,
  `${operation} changed an unselected bar`);
  assert.equal(options.showExplicitRests, false, `${operation} changed the explicit export preference`);
}

// Numbered accidentals persist by degree across octaves. Chromatic named
// input must reset a later original B4/C5 rather than retune the unselected note.
{
  const source = ".Title\nKeyAndMeters = {1=G,4/4}\n.Voice\n1 2 3 4 | 5 6 7 1' |]\n";
  let score = parseEditableDocument(source, "jpw", null)!.score;
  const untouchedPitches = () => score.parts[0].measures.flatMap(measure => measure.entries.flatMap(entry =>
    entry instanceof Chord ? entry.notes.filter(note => !note.rest).map(note => note.pitch) : [])).slice(1);
  const original = untouchedPitches();
  for (const pitch of [60, 66, 65, 58, 73]) {
    const target = inputTargetFromNote(score, 0, chord(score).notes[0], 16);
    const result = applyInputTargetsPitch(score, [target], at => staffPitchSpec(score, at, pitch));
    assert.equal(result.blocked, 0, `chromatic input ${pitch} failed`);
    const expected = scoreNoteTimingFingerprint(score);
    score = parseEditableDocument(scoreToJpwabc(score), "jpw", null)!.score;
    assert.equal(chord(score).notes[0].pitch, pitch, `chromatic input ${pitch} changed its target on reopen`);
    assert.deepEqual(untouchedPitches(), original, `chromatic input ${pitch} retuned an unselected note`);
    assert.equal(scoreNoteTimingFingerprint(score), expected, `chromatic input ${pitch} changed the complete fingerprint`);
  }
}

// A temporary equal pitch while moving a batch must not swap wave members.
for (const operation of ["octave", "degree"] as const) {
  const parsed = parseEditableDocument(".Title\nKeyAndMeters = {1=C,4/4}\n.Voice.Piano.V1\n[11'1''35'] 0 0 0 |]\n.Voice.Piano.V2\n1, 0 0 0 |]\n", "jpw", null)!;
  const score = parsed.score, first = chord(score);
  setChordArpeggioPitchGroups(first, [[60, 64], [72, 79]]);
  const cross = new CrossPartArpeggio(); cross.parts = [0, 1];
  cross.pitches = [{ part: 0, pitch: 84 }, { part: 1, pitch: 48 }];
  score.crossPartArpeggios.push(cross);
  const targets = [60, 72, 84].map(pitch => inputTargetFromNote(score, 0, first.notes.find(note => note.pitch === pitch)!, 16));
  const result = operation === "octave" ? applyInputTargetsOctave(score, targets, 1)
    : applyInputTargetsDegree(score, targets, 3);
  assert.equal(result.blocked, 0);
  const expected = operation === "octave" ? [[72, 64], [84, 79]] : [[64, 64], [76, 79]];
  const crossPitch = operation === "octave" ? 96 : 88;
  assert.deepEqual(chordArpeggioPitchGroups(first), expected, `${operation} reassigned an independent wave`);
  assert.equal(cross.pitches[0].pitch, crossPitch, `${operation} reassigned a cross-part member`);
  for (const format of ["jpw", "keyboard"] as const) {
    const text = format === "jpw" ? scoreToJpwabc(score) : scoreToSlashScore(score, "keyboard", 16, ".",
      { bracketMode: "triplet", braceMode: "arpeggio", showExplicitRests: true }, 2);
    const options = format === "jpw" ? null : defaultSlashScoreOptions("keyboard", analyzeSlashScore(text));
    const reopened = parseEditableDocument(text, format, options)!;
    assert(reopened, `${operation} ${format} did not reopen`);
    assert.deepEqual(chordArpeggioPitchGroups(chord(reopened.score)).map(group => [...group].sort((a,b)=>a-b)).sort(),
      expected.map(group => [...group].sort((a,b)=>a-b)).sort(), `${operation} ${format} changed independent waves`);
    assert(reopened.score.crossPartArpeggios[0].pitches.some(member => member.part === 0 && member.pitch === crossPitch),
      `${operation} ${format} lost its cross-part member`);
  }
}

// Resolve all targets before editing: crossing two selected chord pitches
// Reject final unisons that cannot retain which written note owns a wave.
for (const operation of ["octave", "degree"] as const) for (const kind of ["local", "cross"] as const) {
  const parsed = parseEditableDocument(".Title\nKeyAndMeters = {1=C,4/4}\n.Voice.Piano.V1\n[11'35] 0 0 0 |]\n.Voice.Piano.V2\n1, 0 0 0 |]\n", "jpw", null)!;
  const original = parsed.score, first = chord(original);
  if (kind === "local") setChordArpeggioPitchGroups(first, [[60, 64], [72, 67]]);
  else {
    const mark = new CrossPartArpeggio(); mark.parts = [0, 1];
    mark.pitches = [{ part: 0, pitch: 60 }, { part: 1, pitch: 48 }]; original.crossPartArpeggios.push(mark);
  }
  const before = scoreToJpwabc(original);
  const draft = parseEditableDocument(before, "jpw", null)!.score;
  const selected = [inputTargetFromNote(draft, 0, chord(draft).notes.find(note => note.pitch === 60)!, 16)];
  const result = operation === "octave" ? applyInputTargetsOctave(draft, selected, 1)
    : applyInputTargetsDegree(draft, selected, 5);
  assert.equal(result.blocked, 1, `${operation}/${kind} final unison changed arpeggio ownership`);
  assert.equal(result.changed, 0);
  assert.equal(result.reason, "incompatible-target");
  assert.equal(scoreToJpwabc(original), before, "Rejected pitch draft changed the original document");
}

// Resolve all targets before editing: crossing two selected chord pitches
// must never pick the unselected third tone after the first edit.
{
  const score = fixture();
  const first = tone(score, 0, 0, "1");
  const third = tone(score, 0, 0, "3");
  const untouched = tone(score, 0, 0, "5");
  const before = untouched.pitch;
  const targets = [first, third].map((note) => inputTargetFromNote(score, 0, note, 16));
  const result = applyInputTargetsDegree(score, targets, 7);
  assert.equal(result.blocked, 0);
  assert.equal(result.targets.length, 2, "same-pitch selected tones lost their distinct ordinals");
  assert.equal(untouched.pitch, before);
  assert.equal(untouched.number, "5");
  assert(result.targets.every((target) => resolveInputTarget(score, target).note?.number === "7"));
  const reparsed = parseEditableDocument(scoreToJpwabc(score), "jpw", null);
  assert(reparsed);
  const rebound = rebindInputTargets(reparsed.score, result.targets);
  assert.equal(rebound.length, 2);
  assert(rebound.every((target) => resolveInputTarget(reparsed.score, target).note?.number === "7"));
}

// One lower empty layer per selected column; Ctrl only changes the pending
// register until digits fill those empty layers.
{
  const score = fixture();
  const selected = [tone(score, 0, 0, "1"), tone(score, 0, 1, "2")];
  const before = selected.map((note) => note.pitch);
  const targets = selected.map((note) => inputTargetFromNote(score, 0, note, 16));
  const moved = moveInputTargetsVertical(score, targets, 1);
  assert(moved.targets.every((target) => target.kind === "ghost" && target.lane === "below"));
  assert(moved.targets.every((target) => resolveInputTarget(score, target).note === null));
  const shifted = applyInputTargetsOctave(score, moved.targets, -1);
  assert.deepEqual(selected.map((note) => note.pitch), before, "pending ghost octave edited the anchor notes");
  assert(shifted.targets.every((target) => target.octaveOffset === -1));
  const filled = applyInputTargetsDegree(score, shifted.targets, 7);
  assert.equal(filled.blocked, 0);
  assert.equal(filled.targets.length, 2);
  assert(filled.targets.every((target) => resolveInputTarget(score, target).note?.jpOctave === -2));
  assert.deepEqual(selected.map((note) => note.pitch), before);
}

// Moving multiple tones from one chord must not resolve the second tone by
// its now-shifted ordinal. Other source tones stay selected nowhere.
{
  const score = fixture();
  const first = tone(score, 0, 0, "1");
  const fifth = tone(score, 0, 0, "5");
  const third = tone(score, 0, 0, "3");
  const targets = [first, fifth].map((note) => inputTargetFromNote(score, 0, note, 16));
  const result = applyInputTargetsToPart(score, targets, 1);
  assert.equal(result.blocked, 0);
  assert(result.targets.every((target) => target.partIndex === 1));
  assert.deepEqual(chord(score, 0).notes.map((note) => note.number), ["3"]);
  assert.equal(third.pitch, 64);
  assert(result.targets.every((target) => resolveInputTarget(score, target).note !== third));
}

// Adjacent selected rows may move together: vacate the furthest row first.
// An unselected equal-pitch destination remains a collision, never a merge.
{
  const score = fixture();
  ensureInputMeasure(score, 2, 0);
  const upper = tone(score, 0, 1, "2");
  const lower = tone(score, 1, 1, "5");
  lower.pitch = upper.pitch;
  lower.number = upper.number;
  const result = applyInputTargetsToPart(score, [inputTargetFromNote(score, 0, upper, 16),
    inputTargetFromNote(score, 1, lower, 16)], 1);
  assert.equal(result.blocked, 0);
  assert.deepEqual(result.targets.map((target) => target.partIndex), [1, 2]);
  assert(result.targets.every((target) => resolveInputTarget(score, target).note?.number === "2"));
}
{
  const score = fixture();
  const upper = tone(score, 0, 1, "2");
  const lower = tone(score, 1, 1, "5");
  lower.pitch = upper.pitch;
  const before = upper.pitch;
  const result = applyInputTargetsToPart(score, [inputTargetFromNote(score, 0, upper, 16)], 1);
  assert.equal(result.reason, "occupied-target");
  assert.equal(result.changed, 0);
  assert.equal(upper.pitch, before);
  assert(chord(score, 0, 1).notes.includes(upper));
}

// A real target's projected replacement must not be silently reused as the
// note created for a ghost in the same column.
{
  const score = fixture();
  const third = tone(score, 0, 0, "3");
  const fifth = tone(score, 0, 0, "5");
  const real = inputTargetFromNote(score, 0, third, 16);
  const ghost = moveInputTargetsVertical(score, [inputTargetFromNote(score, 0, fifth, 16)], -1).targets[0];
  assert.equal(ghost.kind, "ghost");
  const before = third.pitch;
  const result = applyInputTargetsDegree(score, [real, ghost], 7);
  assert.equal(result.reason, "occupied-target");
  assert.equal(third.pitch, before);
}

// Ghost movement between rows updates only the pending coordinates. At a
// boundary a batch move is rejected without changing any real source tone.
{
  const score = fixture();
  const anchor = tone(score, 0, 1, "2");
  const ghost = moveInputTargetsVertical(score, [inputTargetFromNote(score, 0, anchor, 16)], -1).targets[0];
  const before = anchor.pitch;
  const moved = applyInputTargetsToPart(score, [ghost], 1);
  assert.equal(moved.blocked, 0);
  assert.equal(moved.targets[0].kind, "ghost");
  assert.equal(moved.targets[0].partIndex, 1);
  assert.equal(anchor.pitch, before);
  assert.equal(resolveInputTarget(score, moved.targets[0]).note, null);
  const blocked = applyInputTargetsToPart(score, [inputTargetFromNote(score, 0, anchor, 16),
    inputTargetFromNote(score, 1, tone(score, 1, 1, "5"), 16)], 1);
  assert.equal(blocked.reason, "boundary");
  assert.equal(anchor.pitch, before);
  assert(chord(score, 0, 1).notes.includes(anchor));
}

// Precise restoration never substitutes the neighbour when an old target no
// longer exists. Invalid/occupied transaction drafts are explicitly blocked.
{
  const score = fixture();
  const first = tone(score, 0, 0, "1");
  const target = inputTargetFromNote(score, 0, first, 16);
  first.pitch += 1;
  assert.equal(resolveInputTarget(score, target).note, null);
  assert.deepEqual(rebindInputTargets(score, [target]), []);
  const result = applyInputTargetsOctave(score, [target], 1);
  assert.equal(result.reason, "missing-target");
  assert.equal(result.changed, 0);
  assert.equal(tone(score, 0, 0, "3").pitch, 64);
}

// Batch octave follows each selected note's own octave and one tie chain is
// shifted only once even when both visible segments are explicitly selected.
{
  const score = fixture();
  const first = tone(score, 0, 1, "2");
  const next = tone(score, 0, 2, "3");
  next.pitch = first.pitch;
  next.number = first.number;
  first.tieNext = next;
  next.tiePrev = first;
  const before = first.pitch;
  const targets = [first, next].map((note) => inputTargetFromNote(score, 0, note, 16));
  const result = applyInputTargetsOctave(score, targets, 1);
  assert.equal(result.blocked, 0);
  assert.equal(first.pitch, before + 12);
  assert.equal(next.pitch, before + 12);
  assert.equal(result.targets.length, 2);
  next.chord.transparentContinuation = true;
  const degrees = applyInputTargetsDegree(score, [inputTargetFromNote(score, 0, next, 16)], 7);
  assert.equal(degrees.blocked, 0);
  assert.equal(first.number, "7");
  assert.equal(next.number, "7");
  assert.equal(first.pitch, next.pitch);
  assert.equal(first.tieNext, next, "numeric multi-input broke an existing transparent tie");
  assert.equal(next.tiePrev, first);
}

// Cross-key ties retain one sounding pitch; each segment writes the correct
// local numbered degree so JPW serialization cannot retune the continuation.
{
  const score = fixture();
  const first = tone(score, 0, 3, "4");
  const measure = ensureInputMeasure(score, 0, 1).measure;
  ensureInputMeasure(score, 1, 1);
  measure.key.fifths = 1;
  score.keyMarks.push(new KeyMark(1, new Fraction(0), 1));
  const continuation = new Chord(measure);
  continuation.position = new Fraction(0);
  continuation.duration = new Fraction(1);
  continuation.beats = 1;
  const next = new Note(continuation);
  next.pitch = first.pitch;
  next.number = "7";
  next.jpAlter = "b";
  next.jpOctave = -1;
  continuation.add(next);
  measure.entries = [continuation];
  first.tieNext = next;
  first.tieStart = true;
  next.tiePrev = first;
  next.tieEnd = true;
  const result = applyInputTargetsDegree(score, [inputTargetFromNote(score, 0, first, 16)], 3);
  assert.equal(result.blocked, 0);
  assert.equal(first.pitch, 64);
  assert.equal(next.pitch, 64);
  assert.equal(first.number, "3");
  assert.equal(next.number, "6");
  assert.equal(next.jpOctave, -1);
  const parsed = parseEditableDocument(scoreToJpwabc(score), "jpw", null);
  assert(parsed);
  const firstReloaded = parsed.score.parts[0].measures[0].entries.find((entry) => entry instanceof Chord && entry.position.equals(3));
  const nextReloaded = parsed.score.parts[0].measures[1].entries.find((entry) => entry instanceof Chord && entry.position.equals(0));
  assert(firstReloaded instanceof Chord && nextReloaded instanceof Chord);
  assert.equal(firstReloaded.notes[0].pitch, 64);
  assert.equal(nextReloaded.notes[0].pitch, 64);
}

// Targets are session-only snapshots, contain no recursive targets, and
// preserve the existing cursor API for single-note consumers.
{
  const score = fixture();
  const targets = [tone(score, 0, 0, "3"), tone(score, 0, 1, "2")]
    .map((note) => inputTargetFromNote(score, 0, note, 16));
  const session = new ScoreInputSession();
  session.setTargets(score, targets, 1);
  assert.equal(session.cursor?.offset.toString(), "1");
  assert.equal(session.focusPitch, targets[1].focusPitch);
  const snapshot = session.snapshot();
  assert(snapshot?.targets);
  const fromSnapshot = inputTargetFromSnapshot(score, snapshot);
  assert.equal("targets" in fromSnapshot, false);
  const emptySnapshot = { ...snapshot, offset: "1/4", focusPitch: null };
  assert.equal("targets" in inputTargetFromSnapshot(score, emptySnapshot), false,
    "ghost snapshots retained a recursive session envelope");
  const restored = new ScoreInputSession();
  restored.restore(score, JSON.parse(JSON.stringify(snapshot)));
  assert.equal(restored.targets.length, 2);
  assert.equal(restored.primaryTargetIndex, 1);
  assert.equal(restored.cursor?.offset.toString(), "1");
  restored.setDivision(32);
  assert(restored.targets.every((target) => target.division === 32));
  restored.setCursor(score, { partIndex: 0, measureIndex: 0, offset: new Fraction(0), division: 16, lane: "rest" });
  assert.equal(restored.targets.length, 0);
  assert.equal(restored.cursor?.offset.toString(), "0");
}

// Delete resolves the complete set before mutating: two pitches in the same
// chord are deleted, while its unselected third pitch remains untouched.
{
  const score = fixture();
  const selected = [tone(score, 0, 0, "1"), tone(score, 0, 0, "3")];
  const untouched = tone(score, 0, 0, "5");
  const result = deleteInputTargets(score, selected.map((note) => inputTargetFromNote(score, 0, note, 16)));
  assert.equal(result.blocked, 0);
  assert.equal(result.changed, 2);
  assert.deepEqual(chord(score, 0).notes, [untouched]);
  assert.equal(untouched.pitch, 67);
  assert(result.targets.every((target) => target.kind === "ghost" && target.focusPitch === null));
  assert(result.targets.every((target) => resolveInputTarget(score, target).note === null));
  assert.deepEqual(result.targets.map((target) => target.anchorPitch).sort((a, b) => a! - b!), [60, 64]);
}

// A ghost is not a deletion instruction for its real anchor; mixed batches
// delete only concrete targets and preserve the existing ghost destination.
{
  const score = fixture();
  const anchor = tone(score, 0, 1, "2");
  const ghost = moveInputTargetsVertical(score, [inputTargetFromNote(score, 0, anchor, 16)], 1).targets[0];
  const before = scoreToJpwabc(score);
  const empty = deleteInputTargets(score, [ghost]);
  assert.equal(empty.changed, 0);
  assert.equal(scoreToJpwabc(score), before);
  const real = tone(score, 0, 2, "3");
  const mixed = deleteInputTargets(score, [ghost, inputTargetFromNote(score, 0, real, 16)]);
  assert.equal(mixed.blocked, 0);
  assert.equal(mixed.changed, 1);
  assert.deepEqual(mixed.targets[0], ghost);
  assert.equal(tone(score, 0, 1, "2"), anchor);
  assert.equal(anchor.pitch, 62);
  assert(chord(score, 0, 2).rest);
}

// Missing deletion targets are rejected before deleting an otherwise valid
// earlier target. No partial batch or guessed neighbouring tone is allowed.
{
  const score = fixture();
  const valid = tone(score, 0, 0, "1");
  const missing = inputTargetFromNote(score, 0, tone(score, 0, 2, "3"), 16);
  missing.focusPitch! += 1;
  const before = scoreToJpwabc(score);
  const result = deleteInputTargets(score, [inputTargetFromNote(score, 0, valid, 16), missing]);
  assert.equal(result.reason, "missing-target");
  assert.equal(result.changed, 0);
  assert.equal(scoreToJpwabc(score), before);
  assert(chord(score, 0).notes.includes(valid));
}

// Selecting both visible segments of one tie deletes that chain once and
// cannot delete an unrelated pitch sharing the continuation chord.
{
  const score = fixture();
  const first = tone(score, 0, 1, "2");
  const next = tone(score, 0, 2, "3");
  next.pitch = first.pitch;
  next.number = first.number;
  const untouched = new Note(next.chord);
  untouched.pitch = 67;
  untouched.number = "5";
  next.chord.add(untouched);
  first.tieNext = next;
  next.tiePrev = first;
  const result = deleteInputTargets(score, [first, next].map((note) => inputTargetFromNote(score, 0, note, 16)));
  assert.equal(result.blocked, 0);
  assert.equal(result.changed, 2);
  assert(chord(score, 0, 1).rest);
  assert.deepEqual(chord(score, 0, 2).notes, [untouched]);
  assert.equal(untouched.pitch, 67);
}

// MIDI limits are checked across the entire octave batch before modifying
// any legal earlier target, including a ghost's pending register.
{
  const score = fixture();
  const valid = tone(score, 0, 0, "1");
  const high = tone(score, 0, 2, "3");
  high.pitch = 127;
  const result = applyInputTargetsOctave(score, [valid, high].map((note) => inputTargetFromNote(score, 0, note, 16)), 1);
  assert.equal(result.reason, "boundary");
  assert.equal(valid.pitch, 60);
  assert.equal(high.pitch, 127);
  const ghost = moveInputTargetsVertical(score, [inputTargetFromNote(score, 0, high, 16)], -1).targets[0];
  const pending = applyInputTargetsOctave(score, [inputTargetFromNote(score, 0, valid, 16), ghost], 1);
  assert.equal(pending.reason, "boundary");
  assert.equal(valid.pitch, 60);
  assert.equal(ghost.octaveOffset, 0);
  valid.pitch = 0;
  assert.equal(applyInputTargetsOctave(score, [inputTargetFromNote(score, 0, valid, 16)], -1).reason, "boundary");
  assert.equal(valid.pitch, 0);
}

// The default keyboard TXT route retains multiple independent ghost inserts
// through the same serialization/parser boundary as the editor transaction.
{
  const original = fixture();
  const text = scoreToSlashScore(original, "keyboard", 16, ".",
    { bracketMode: "triplet", braceMode: "grace", showExplicitRests: true }, 2);
  const options = defaultSlashScoreOptions("keyboard", analyzeSlashScore(text));
  const parsed = parseEditableDocument(text, "keyboard", options);
  assert(parsed);
  const score = parsed.score;
  const selected = [tone(score, 0, 1, "2"), tone(score, 0, 2, "3")];
  const before = selected.map((note) => note.pitch);
  const ghosts = moveInputTargetsVertical(score,
    selected.map((note) => inputTargetFromNote(score, 0, note, 16)), 1).targets;
  const inserted = applyInputTargetsDegree(score, ghosts, 1);
  assert.equal(inserted.blocked, 0);
  assert.deepEqual(selected.map((note) => note.pitch), before);
  const nextText = scoreToSlashScore(score, "keyboard", 16, ".",
    { bracketMode: "triplet", braceMode: "grace", showExplicitRests: true }, 2);
  const final = parseEditableDocument(nextText, "keyboard", defaultSlashScoreOptions("keyboard", analyzeSlashScore(nextText)));
  assert(final);
  const targets = rebindInputTargets(final.score, inserted.targets);
  assert.equal(targets.length, 2);
  assert(targets.every((target) => resolveInputTarget(final.score, target).note?.number === "1"));
  assert.deepEqual([tone(final.score, 0, 1, "2").pitch, tone(final.score, 0, 2, "3").pitch], before);
}
console.log("multi-input-check: ok (exact multi-target identity, ghosts, octave, part moves, reparse and snapshot)");
