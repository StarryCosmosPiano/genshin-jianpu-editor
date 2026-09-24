import assert from "node:assert/strict";
import { Fraction } from "./src/common/fraction";
import {
  BarStyle,
  Chord,
  Measure,
  Note,
  Part,
  Score,
  Tuplet,
} from "./src/score/score";
import {
  applyInputTimeSignature,
  completeInputMeasure,
  createInputTriplet,
  ensureInputMeasure,
  ensureInputTailMeasure,
  inputNoteAtCursor,
  inputRestAtCursor,
  inputTripletCursorDelta,
  inputTripletCellDuration,
  inputScaleDegreePitch,
  replaceInputContinuationAtCursor,
  moveInputNoteToPart,
  moveInputTieChainByNotationDomain,
  deleteInputMeasures,
  insertInputMeasure,
  isInputMeasureEmpty,
  removeInputTriplet,
  resizeInputTupletMember,
  extendInputTupletOutside,
  inputTupletMembers,
  tupletActualToWritten,
  tupletWrittenToActual,
  type NotationCursor,
  removeEmptyInputMeasures,
} from "./src/score/input-edit";
import { scoreToJpwabc } from "./src/score/jpscore";
import { JpwFile } from "./src/jpword/jpwfile";
import { fromJpw } from "./src/score/jpwimport";
import {
  moveScoreNotesOnTimeline,
  resizeScoreNoteSegmentsWithRests,
} from "./src/score/note-timing";
import {
  analyzeSlashScore,
  defaultSlashScoreOptions,
  parseSlashScore,
  scoreToSlashScore,
} from "./src/slashscore";

function check(value: unknown, message: string): asserts value {
  assert.ok(value, message);
}

function cursor(partIndex: number, measureIndex: number, offset: number, division: 1 | 2 | 4 | 8 | 16 | 32 | 64): NotationCursor {
  return {
    partIndex,
    measureIndex,
    offset: new Fraction(offset),
    division,
    lane: "rest",
  };
}

function restMeasure(score: Score, partIndex = 0, measureIndex = 0): Measure {
  const ensured = ensureInputMeasure(score, partIndex, measureIndex);
  const measure = ensured.measure;
  measure.entries = [];
  const rest = new Chord(measure);
  rest.rest = true;
  rest.duration = new Fraction(4);
  const note = new Note(rest);
  note.rest = true;
  note.number = "0";
  rest.add(note);
  measure.add(rest);
  return measure;
}

function addRawRest(measure: Measure, position: Fraction, duration: Fraction): Chord {
  const rest = new Chord(measure);
  rest.position = position;
  rest.duration = duration;
  rest.rest = true;
  const note = new Note(rest);
  note.rest = true;
  note.number = "0";
  rest.add(note);
  measure.add(rest);
  return rest;
}

// Middle C's numbered 3 is the anchor for the explicit upper/lower octave rules.
const anchor = new Note(new Chord(new Measure(0)));
anchor.pitch = 64;
anchor.number = "3";

for (const degree of [1, 2, 3] as const) {
  check(inputScaleDegreePitch(anchor, degree, "above") > anchor.pitch,
    `upper ${degree} should be above the anchor`);
}
for (const degree of [4, 5, 6, 7] as const) {
  check(inputScaleDegreePitch(anchor, degree, "above") < anchor.pitch + 12,
    `upper ${degree} should stay in the anchor octave`);
}
for (const degree of [3, 4, 5, 6, 7] as const) {
  check(inputScaleDegreePitch(anchor, degree, "below") < anchor.pitch,
    `lower ${degree} should be below the anchor`);
}
for (const degree of [1, 2] as const) {
  check(inputScaleDegreePitch(anchor, degree, "below") > anchor.pitch - 12,
    `lower ${degree} should stay in the anchor octave`);
}

// A quarter-grid input splits the existing four-quarter rest into before/after rests.
const splitScore = new Score();
splitScore.parts.push(new Part());
const split = restMeasure(splitScore);
const splitResult = inputNoteAtCursor(splitScore, cursor(0, 0, 1, 4), { pitch: 64, number: "3" });
check(splitResult.changed && splitResult.splitRests === 1, "rest insertion should report a split");
check(split.entries.filter((entry) => entry instanceof Chord).length === 4,
  "one rest should become beat-local rests around the inserted note");
const splitNote = splitResult.note;
check(splitNote?.chord.position.equals(1), "inserted note should use the cursor offset");
check(splitNote?.chord.duration?.equals(1), "new rest insertion should use the selected grid duration");
const splitRests = split.entries
  .filter((entry): entry is Chord => entry instanceof Chord && entry.rest)
  .sort((left, right) => left.position.compareTo(right.position));
check(splitRests[0]?.position.equals(0) && splitRests[0].duration?.equals(1),
  "rest before the inserted note should keep its original start");
check(splitRests[1]?.position.equals(2) && splitRests[1].duration?.equals(1)
  && splitRests[2]?.position.equals(3) && splitRests[2].duration?.equals(1),
"rests after the inserted note must remain split at beat boundaries");

// Navigation grid and written value are independent. A quarter-note input
// on a whole-note cursor grid still occupies exactly one beat rather than
// inheriting the whole rest that covers the cursor.
const independentDurationScore = new Score();
independentDurationScore.parts.push(new Part());
const independentDurationMeasure = restMeasure(independentDurationScore);
const independentDurationResult = inputNoteAtCursor(
  independentDurationScore,
  cursor(0, 0, 0, 1),
  { pitch: 60, number: "1" },
  new Fraction(1),
);
check(independentDurationResult.chord?.duration?.equals(1),
  "quarter-note input inherited the whole-note cursor grid");
const independentDurationRests = independentDurationMeasure.entries
  .filter((entry): entry is Chord => entry instanceof Chord && entry.rest);
check(independentDurationRests.length === 3
  && independentDurationRests.every((rest, index) =>
    rest.position.equals(index + 1) && rest.duration?.equals(1)),
  "quarter-note input did not leave three beat-local rests behind");

// Extending must consume a contiguous run, not require one rest to be at
// least as long as the active toolbar step. This also repairs older files
// whose tail silence was persisted as dotted/short fragments.
const fragmentedRestScore = new Score();
fragmentedRestScore.parts.push(new Part());
const fragmentedMeasure = ensureInputMeasure(fragmentedRestScore, 0, 0).measure;
fragmentedMeasure.entries = [];
const fragmentedAttack = new Chord(fragmentedMeasure);
fragmentedAttack.position = new Fraction(0);
fragmentedAttack.duration = new Fraction(1);
const fragmentedNote = new Note(fragmentedAttack);
fragmentedNote.pitch = 60;
fragmentedNote.number = "1";
fragmentedAttack.add(fragmentedNote);
fragmentedMeasure.add(fragmentedAttack);
addRawRest(fragmentedMeasure, new Fraction(1), new Fraction(1, 2));
addRawRest(fragmentedMeasure, new Fraction(3, 2), new Fraction(1, 2));
addRawRest(fragmentedMeasure, new Fraction(2), new Fraction(2));
const fragmentedExtended = resizeScoreNoteSegmentsWithRests(
  fragmentedRestScore,
  [{ partIndex: 0, note: fragmentedNote, grace: false }],
  new Fraction(1),
);
check(fragmentedExtended.changed === 1 && fragmentedAttack.duration?.equals(2),
  "a note could not extend through adjacent short rest fragments");
check(fragmentedMeasure.entries
  .filter((entry): entry is Chord => entry instanceof Chord && entry.rest)
  .every((rest) => rest.position.compareTo(new Fraction(2)) >= 0),
  "consumed rest fragments remained under the extended note");

// Adding another tone at the same cursor preserves the chord's existing duration.
const chordScore = new Score();
chordScore.parts.push(new Part());
const chordMeasure = restMeasure(chordScore);
const first = inputNoteAtCursor(chordScore, cursor(0, 0, 0, 8), { pitch: 60, number: "1" });
check(first.chord !== null, "first note should create a chord");
first.chord!.duration = new Fraction(2);
const second = inputNoteAtCursor(chordScore, cursor(0, 0, 0, 16), { pitch: 64, number: "3" });
check(second.chord === first.chord, "same cursor should reuse the existing chord");
check(second.chord!.duration?.equals(2), "chord tone should inherit current chord duration");
check(second.chord!.notes.length === 2, "same-time input should form a chord");
void chordMeasure;

// Input into a future measure creates all formal measures up to that index.
const draftScore = new Score();
draftScore.parts.push(new Part());
const draft = inputNoteAtCursor(draftScore, cursor(0, 2, 0, 16), { pitch: 67, number: "5" });
check(draft.createdMeasure, "future input should create formal measures");
check(draftScore.parts[0].measures.length === 3, "future input should fill missing measures");
check(draftScore.parts[0].measures[2].entries.some((entry) =>
  entry instanceof Chord && !entry.rest && entry.position.equals(0)),
"future measure should contain the input chord");

// A tone can be moved to a synchronized part without changing its absolute time.
const moveScore = new Score();
moveScore.parts.push(new Part(), new Part());
const sourceMeasure = restMeasure(moveScore, 0, 0);
const targetMeasure = restMeasure(moveScore, 1, 0);
const sourceResult = inputNoteAtCursor(moveScore, cursor(0, 0, 0, 16), { pitch: 72, number: "1" });
check(sourceResult.note !== null, "source tone should exist before cross-part move");
const moved = moveInputNoteToPart(moveScore, 0, sourceResult.chord!, sourceResult.note!, 1);
check(moved.changed && moved.targetChord !== null, "cross-part move should succeed");
check(moved.targetChord!.measure === targetMeasure, "moved tone should use target part's matching measure");
check(moved.targetChord!.position.equals(0), "moved tone should preserve its absolute time");
check(moved.note?.pitch === 72, "moved tone should preserve pitch");
void sourceMeasure;

// Completing with explicit rests fills gaps; implicit mode extends the prior attack.
const explicitScore = new Score();
explicitScore.parts.push(new Part());
const explicitMeasure = restMeasure(explicitScore);
inputNoteAtCursor(explicitScore, cursor(0, 0, 0, 4), { pitch: 60, number: "1" });
completeInputMeasure(explicitScore, { partIndex: 0, measureIndex: 0 }, true);
check(explicitMeasure.entries.some((entry) => entry instanceof Chord && entry.rest),
  "explicit completion should retain rests");

const implicitScore = new Score();
implicitScore.parts.push(new Part());
const implicitMeasure = restMeasure(implicitScore);
const implicitNote = inputNoteAtCursor(implicitScore, cursor(0, 0, 0, 4), { pitch: 60, number: "1" }).note!;
completeInputMeasure(implicitScore, { partIndex: 0, measureIndex: 0 }, false);
check(!implicitMeasure.entries.some((entry) => entry instanceof Chord && entry.rest),
  "implicit completion should remove rests after an attack");
check(implicitNote.chord.duration?.equals(4), "implicit completion should extend the attack to the barline");

// A leading silent span remains a rest in implicit mode, and completion is idempotent.
const pickupScore = new Score();
pickupScore.parts.push(new Part());
const pickupMeasure = restMeasure(pickupScore);
const pickupNote = inputNoteAtCursor(pickupScore, cursor(0, 0, 1, 4), { pitch: 60, number: "1" }).note!;
completeInputMeasure(pickupScore, { partIndex: 0, measureIndex: 0 }, false);
const pickupRests = pickupMeasure.entries.filter((entry): entry is Chord => entry instanceof Chord && entry.rest);
check(pickupRests.length === 1 && pickupRests[0].position.equals(0)
  && pickupRests[0].duration?.equals(1), "implicit mode should preserve a leading silent rest");
const pickupCount = pickupMeasure.entries.length;
completeInputMeasure(pickupScore, { partIndex: 0, measureIndex: 0 }, false);
check(pickupMeasure.entries.length === pickupCount, "implicit completion should be idempotent");
check(pickupNote.chord.duration?.equals(3), "the pickup attack should extend to the barline");

// Inserting into a sustained chord cuts it and leaves a non-overlapping continuation.
const interiorScore = new Score();
interiorScore.parts.push(new Part());
const interior = ensureInputMeasure(interiorScore, 0, 0).measure;
const sustained = inputNoteAtCursor(interiorScore, cursor(0, 0, 0, 4), { pitch: 60, number: "1" }).chord!;
sustained.duration = new Fraction(4);
const interiorResult = inputNoteAtCursor(interiorScore, cursor(0, 0, 1, 4), { pitch: 64, number: "3" });
check(interiorResult.changed, "insertion inside a sustained note should succeed");
const interiorChords = interior.entries
  .filter((entry): entry is Chord => entry instanceof Chord && !entry.rest)
  .sort((left, right) => left.position.compareTo(right.position));
check(interiorChords.length === 2, `interior insertion should truncate the source at the new attack: ${interiorChords.map((chord) => `${chord.position}/${chord.duration}/${chord.rest}`).join(",")}`);
check(interiorChords[0].position.equals(0) && interiorChords[0].duration?.equals(1),
  "sustained source should be truncated at the cursor");
check(interiorChords[1].position.equals(1) && interiorChords[1].duration?.equals(1),
  "inserted note should occupy only one grid cell");
check(interiorChords[1].position.equals(1) && interiorChords[1].duration?.equals(1),
  "inserted note should keep its grid duration without restoring the source tail");
const interiorJpw = scoreToJpwabc(interiorScore);
const interiorRoundTrip = fromJpw(JpwFile.fromString(interiorJpw)!);
const interiorRoundTripChords = interiorRoundTrip.parts[0].measures[0].entries
  .filter((entry): entry is Chord => entry instanceof Chord && !entry.rest);
check(interiorRoundTripChords.length === 2
  && interiorRoundTripChords.flatMap((chord) => chord.notes.map((note) => note.number)).sort().join(",") === "1,3",
`interior input should not restore the source tail through JPW serialization:\n${interiorJpw}\n${
  interiorRoundTripChords.map((chord) => `${chord.position}:${chord.duration}:${
    chord.notes.map((note) => `${note.number}/${note.tieStart}/${note.tieEnd}`).join(",")
  }`).join("|")
}`);
completeInputMeasure(interiorScore, { partIndex: 0, measureIndex: 0 }, true);
check(interior.entries.some((entry) => entry instanceof Chord && entry.rest),
  "measure completion should fill the truncated tail with a rest");
void interior;

// A grid-sized zero inside a whole note replaces only that grid cell and
// leaves the remaining duration as a new sounding tail.
const zeroScore = new Score();
zeroScore.parts.push(new Part());
const zeroMeasure = ensureInputMeasure(zeroScore, 0, 0).measure;
const zeroNote = inputNoteAtCursor(zeroScore, cursor(0, 0, 0, 2), { pitch: 60, number: "1" }).chord!;
zeroNote.duration = new Fraction(4);
const insertedZero = inputRestAtCursor(zeroScore, cursor(0, 0, 0, 2));
check(insertedZero.changed && insertedZero.rest?.rest,
  "zero input should create a real rest column");
const zeroEntries = zeroMeasure.entries
  .filter((entry): entry is Chord => entry instanceof Chord)
  .sort((left, right) => left.position.compareTo(right.position));
check(zeroEntries.length >= 2
  && zeroEntries[0].rest && zeroEntries[0].duration?.equals(2)
  && !zeroEntries[1].rest && zeroEntries[1].position.equals(2)
  && zeroEntries[1].duration?.equals(2),
`zero input should truncate the source and preserve its tail: ${zeroEntries.map((chord) => `${chord.position}/${chord.duration}/${chord.rest}`).join(",")}`);

// Delete removes only the focused tone from a chord; deleting the last tone
// converts its column to a rest without changing the written duration.
const deleteScore = new Score();
deleteScore.parts.push(new Part());
const deleteMeasure = ensureInputMeasure(deleteScore, 0, 0).measure;
const deleteChord = inputNoteAtCursor(deleteScore, cursor(0, 0, 0, 4), { pitch: 60, number: "1" }).chord!;
const secondTone = inputNoteAtCursor(deleteScore, cursor(0, 0, 0, 4), { pitch: 64, number: "3" }).note!;
const deleteOne = inputRestAtCursor(deleteScore, cursor(0, 0, 0, 4), new Fraction(1), secondTone);
check(deleteOne.changed && deleteChord.notes.length === 1 && deleteChord.notes[0].pitch === 60,
  "deleting one chord tone should preserve its neighbour");
const deleteLast = inputRestAtCursor(deleteScore, cursor(0, 0, 0, 4), new Fraction(1), deleteChord.notes[0]);
check(deleteLast.changed && deleteMeasure.entries.some((entry) => entry instanceof Chord && entry.rest),
  "deleting the last chord tone should leave a rest");

// A 32nd/64th attack leaves a non-single-token remainder in its beat (7/8 or
// 15/16 of one quarter). Every generated rest must nevertheless have an exact
// JPW spelling; repeated input/delete round-trips must keep the bar at 4/4 and
// must release all silence instead of dropping the unspellable remainder.
for (const division of [32, 64] as const) {
  const step = new Fraction(4, division);
  let fineScore = new Score();
  fineScore.parts.push(new Part());
  restMeasure(fineScore);
  const fineCursor = (offset: Fraction): NotationCursor => ({
    partIndex: 0,
    measureIndex: 0,
    offset,
    division,
    lane: "rest",
  });
  const assertFineBar = (label: string, sounding: number): void => {
    const measure = fineScore.parts[0].measures[0];
    const chords = measure.entries.filter((entry): entry is Chord => entry instanceof Chord);
    const end = chords.reduce((latest, chord) => {
      const candidate = chord.position.plus(chord.duration ?? new Fraction(0));
      return candidate.compareTo(latest) > 0 ? candidate : latest;
    }, new Fraction(0));
    const restTotal = chords.filter((chord) => chord.rest)
      .reduce((total, chord) => total.plus(chord.duration ?? new Fraction(0)), new Fraction(0));
    check(end.equals(4)
      && chords.filter((chord) => !chord.rest).length === sounding
      && restTotal.equals(new Fraction(4).minus(step.timesInt(sounding)))
      && chords.every((chord) => chord.duration !== null),
    `${division}th JPW ${label} changed/swallowed the bar: ${
      chords.map((chord) => `${chord.position}/${chord.duration}/${chord.rest ? "r" : "n"}/b${chord.beams}`).join(",")
    }; end=${end}; rests=${restTotal}`);
  };
  const roundTripFine = (): void => {
    fineScore = fromJpw(JpwFile.fromString(scoreToJpwabc(fineScore))!);
  };

  inputNoteAtCursor(fineScore, fineCursor(new Fraction(0)), { pitch: 60, number: "1" }, step);
  roundTripFine();
  assertFineBar("first input", 1);
  inputNoteAtCursor(fineScore, fineCursor(step), { pitch: 62, number: "2" }, step);
  roundTripFine();
  assertFineBar("second input", 2);

  let firstFine = fineScore.parts[0].measures[0].entries.find((entry): entry is Chord =>
    entry instanceof Chord && !entry.rest && entry.position.equals(0))!;
  inputRestAtCursor(fineScore, fineCursor(new Fraction(0)), step, firstFine.notes[0]);
  roundTripFine();
  assertFineBar("first deletion", 1);
  const secondFine = fineScore.parts[0].measures[0].entries.find((entry): entry is Chord =>
    entry instanceof Chord && !entry.rest && entry.position.equals(step))!;
  inputRestAtCursor(fineScore, fineCursor(step), step, secondFine.notes[0]);
  roundTripFine();
  assertFineBar("second deletion", 0);
}

// Alt-moving one short JPW note repeatedly through its following silence can
// make the relocated tail-rest onset meet an existing rest onset exactly.
// That boundary is one rhythmic zero, never a vertical `[00]` chord, and a
// save/reparse must retain a gap-free four-beat bar.
let altFineMoveScore = new Score();
altFineMoveScore.parts.push(new Part());
restMeasure(altFineMoveScore);
inputNoteAtCursor(
  altFineMoveScore,
  cursor(0, 0, 0, 16),
  { pitch: 60, number: "1" },
  new Fraction(1, 4),
);
for (let moveIndex = 1; moveIndex <= 5; moveIndex++) {
  const root = altFineMoveScore.parts[0].measures[0].entries.find((entry): entry is Chord =>
    entry instanceof Chord && !entry.rest
      && entry.notes.some((note) => !note.rest && note.tiePrev === null))!;
  const movedFine = moveScoreNotesOnTimeline(
    altFineMoveScore,
    [{ partIndex: 0, note: root.notes.find((note) => !note.rest)!, grace: false }],
    new Fraction(1, 4),
    { preserveRests: true, moveWholeTieChain: true },
  );
  check(movedFine.changed === 1, `fine Alt move ${moveIndex} was unexpectedly blocked`);
  altFineMoveScore = fromJpw(JpwFile.fromString(scoreToJpwabc(altFineMoveScore))!);
  const chords = altFineMoveScore.parts[0].measures[0].entries
    .filter((entry): entry is Chord => entry instanceof Chord)
    .sort((left, right) => left.position.compareTo(right.position));
  let timeline = new Fraction(0);
  for (const chord of chords) {
    check(chord.position.equals(timeline),
      `fine Alt move ${moveIndex} left an overlap/gap at ${chord.position}, expected ${timeline}`);
    check(!chord.rest || (chord.notes.length === 1 && chord.notes[0].rest),
      `fine Alt move ${moveIndex} merged coincident rests into a zero chord`);
    timeline = timeline.plus(chord.duration ?? new Fraction(0));
  }
  check(timeline.equals(4), `fine Alt move ${moveIndex} changed the 4/4 bar to ${timeline}`);
}

// Extending by a 32nd/64th from a beat-aligned quarter leaves 7/8 or 15/16
// of the following beat. Those remainders need multiple exact JPW rest
// tokens; treating either as one guessed rest changes the bar on round-trip.
for (const division of [32, 64] as const) {
  const step = new Fraction(4, division);
  let extendFineScore = new Score();
  extendFineScore.parts.push(new Part());
  restMeasure(extendFineScore);
  inputNoteAtCursor(
    extendFineScore,
    cursor(0, 0, 0, 4),
    { pitch: 60, number: "1" },
    new Fraction(1),
  );
  for (let editIndex = 1; editIndex <= 3; editIndex++) {
    const root = extendFineScore.parts[0].measures[0].entries.find((entry): entry is Chord =>
      entry instanceof Chord && !entry.rest
        && entry.notes.some((note) => !note.rest && note.tiePrev === null))!;
    if (editIndex === 1) {
      extendFineScore.noteTimingEdits = [{ part: 0, chord: 0, move: "0", duration: "1" }];
      root.timingOriginal = {
        measureIndex: 0,
        position: root.position,
        beats: 1,
        beams: 0,
        dot: 0,
        tieStart: false,
        tieEnd: false,
      };
    }
    const resized = resizeScoreNoteSegmentsWithRests(
      extendFineScore,
      [{ partIndex: 0, note: root.notes.find((note) => !note.rest)!, grace: false }],
      step,
    );
    check(resized.changed === 1, `${division}th extension ${editIndex} was unexpectedly blocked`);
    check(extendFineScore.noteTimingEdits.length === 0
      && extendFineScore.parts.flatMap((part) => part.measures)
        .flatMap((measure) => measure.entries)
        .filter((entry): entry is Chord => entry instanceof Chord)
        .every((chord) => chord.timingOriginal === null),
    `${division}th structural extension retained a stale timing overlay`);
    extendFineScore = fromJpw(JpwFile.fromString(scoreToJpwabc(extendFineScore))!);
    const chords = extendFineScore.parts[0].measures[0].entries
      .filter((entry): entry is Chord => entry instanceof Chord)
      .sort((left, right) => left.position.compareTo(right.position));
    let timeline = new Fraction(0);
    for (const chord of chords) {
      check(chord.position.equals(timeline),
        `${division}th extension ${editIndex} left an overlap/gap at ${chord.position}, expected ${timeline}`);
      timeline = timeline.plus(chord.duration ?? new Fraction(0));
    }
    check(timeline.equals(4),
      `${division}th extension ${editIndex} changed the 4/4 bar to ${timeline}`);
  }
}

// Deleting a long note releases silence back to the notated beat grid. A
// half/dotted-half/whole note at the first beat of 4/4 must not survive as one
// equally long `0`; each occupied beat becomes one quarter rest instead.
for (const releasedDuration of [2, 3, 4]) {
  const releasedScore = new Score();
  releasedScore.parts.push(new Part());
  const releasedMeasure = ensureInputMeasure(releasedScore, 0, 0).measure;
  releasedMeasure.entries = [];
  const attack = inputNoteAtCursor(
    releasedScore,
    cursor(0, 0, 0, 4),
    { pitch: 60, number: "1" },
    new Fraction(releasedDuration),
  );
  check(attack.note !== null && attack.chord?.duration?.equals(releasedDuration),
    `could not create the ${releasedDuration}-quarter deletion fixture`);
  const deleted = inputRestAtCursor(
    releasedScore,
    cursor(0, 0, 0, 4),
    attack.chord!.duration!,
    attack.note,
  );
  const rests = releasedMeasure.entries
    .filter((entry): entry is Chord => entry instanceof Chord && entry.rest)
    .sort((left, right) => left.position.compareTo(right.position));
  check(deleted.changed && rests.length === releasedDuration
    && rests.every((rest, index) => rest.position.equals(index) && rest.duration?.equals(1)),
  `deleting a ${releasedDuration}-quarter note did not release ${releasedDuration} beat-local quarter rests: ${
    rests.map((rest) => `${rest.position}/${rest.duration}`).join(",")
  }`);
}

// Released fragments still fuse inside one beat, but the result must stop at
// the next beat boundary.
const fusedDeleteScore = new Score();
fusedDeleteScore.parts.push(new Part());
const fusedDeleteMeasure = ensureInputMeasure(fusedDeleteScore, 0, 0).measure;
fusedDeleteMeasure.entries = [];
addRawRest(fusedDeleteMeasure, new Fraction(0), new Fraction(1, 4));
const fusedDeleteAttack = inputNoteAtCursor(
  fusedDeleteScore,
  cursor(0, 0, 1 / 4, 16),
  { pitch: 60, number: "1" },
  new Fraction(1, 4),
);
addRawRest(fusedDeleteMeasure, new Fraction(1, 2), new Fraction(1, 2));
addRawRest(fusedDeleteMeasure, new Fraction(1), new Fraction(1));
inputRestAtCursor(
  fusedDeleteScore,
  cursor(0, 0, 1 / 4, 16),
  new Fraction(1, 4),
  fusedDeleteAttack.note,
);
const fusedDeleteRests = fusedDeleteMeasure.entries
  .filter((entry): entry is Chord => entry instanceof Chord && entry.rest)
  .sort((left, right) => left.position.compareTo(right.position));
check(fusedDeleteRests.length === 2
  && fusedDeleteRests[0].position.equals(0) && fusedDeleteRests[0].duration?.equals(1)
  && fusedDeleteRests[1].position.equals(1) && fusedDeleteRests[1].duration?.equals(1),
`deleted sixteenth fragments did not fuse inside their beat, or crossed the next beat: ${
  fusedDeleteRests.map((rest) => `${rest.position}/${rest.duration}`).join(",")
}`);

function tiedDeleteFixture(): {
  score: Score;
  measure: Measure;
  root: Note;
  continuation: Note;
} {
  const score = new Score();
  score.parts.push(new Part());
  const measure = ensureInputMeasure(score, 0, 0).measure;
  measure.entries = [];
  const root = inputNoteAtCursor(
    score,
    cursor(0, 0, 0, 4),
    { pitch: 60, number: "1" },
    new Fraction(1),
  ).note!;
  const continuationChord = new Chord(measure);
  continuationChord.position = new Fraction(1);
  continuationChord.duration = new Fraction(3, 4);
  continuationChord.beats = 1;
  continuationChord.beams = 1;
  continuationChord.dot = 1;
  continuationChord.transparentContinuation = true;
  continuationChord.generatedTimingContinuation = true;
  const continuation = new Note(continuationChord);
  continuation.pitch = root.pitch;
  continuation.number = root.number;
  continuation.tieEnd = true;
  continuation.tiePrev = root;
  continuationChord.add(continuation);
  measure.add(continuationChord);
  root.tieStart = true;
  root.tieNext = continuation;
  addRawRest(measure, new Fraction(7, 4), new Fraction(1, 4));
  addRawRest(measure, new Fraction(2), new Fraction(1));
  addRawRest(measure, new Fraction(3), new Fraction(1));
  return { score, measure, root, continuation };
}

// Deleting either the attack or its gray continuation removes the complete
// semantic held note. The released dotted-eighth continuation and the final
// sixteenth silence fuse into the second beat's quarter rest.
for (const selection of ["root", "continuation"] as const) {
  const fixture = tiedDeleteFixture();
  const selected = fixture[selection];
  inputRestAtCursor(
    fixture.score,
    cursor(0, 0, selected.chord.position.toFloat(), 16),
    selected.chord.duration ?? new Fraction(1, 4),
    selected,
  );
  const sounding = fixture.measure.entries
    .filter((entry): entry is Chord => entry instanceof Chord && !entry.rest);
  const rests = fixture.measure.entries
    .filter((entry): entry is Chord => entry instanceof Chord && entry.rest)
    .sort((left, right) => left.position.compareTo(right.position));
  check(sounding.length === 0
    && rests.length === 4
    && rests.every((rest, index) => rest.position.equals(index) && rest.duration?.equals(1)),
  `deleting the tied ${selection} left a continuation or lost released silence: ${
    fixture.measure.entries.map((entry) => entry instanceof Chord
      ? `${entry.position}/${entry.duration}/${entry.rest}/${entry.notes.map((note) => `${note.number}:${note.tieStart}:${note.tieEnd}`).join("+")}`
      : String(entry)).join(",")
  }`);
}

// A selected pitch can be only one member of a tied chord. Removing its
// complete chain must leave the neighbouring pitch and that pitch's own tie
// untouched in both printed columns.
const chordTieDelete = tiedDeleteFixture();
const chordTieRoot = inputNoteAtCursor(
  chordTieDelete.score,
  cursor(0, 0, 0, 4),
  { pitch: 64, number: "3" },
  new Fraction(1),
).note!;
const chordTieContinuation = new Note(chordTieDelete.continuation.chord);
chordTieContinuation.pitch = 64;
chordTieContinuation.number = "3";
chordTieContinuation.tieEnd = true;
chordTieContinuation.tiePrev = chordTieRoot;
chordTieDelete.continuation.chord.add(chordTieContinuation);
chordTieRoot.tieStart = true;
chordTieRoot.tieNext = chordTieContinuation;
inputRestAtCursor(
  chordTieDelete.score,
  cursor(0, 0, 0, 4),
  new Fraction(1),
  chordTieDelete.root,
);
const remainingChordTones = chordTieDelete.measure.entries
  .filter((entry): entry is Chord => entry instanceof Chord && !entry.rest)
  .flatMap((entry) => entry.notes.filter((note) => !note.rest));
check(remainingChordTones.length === 2
  && remainingChordTones.every((note) => note.pitch === 64)
  && chordTieRoot.tieNext === chordTieContinuation
  && chordTieContinuation.tiePrev === chordTieRoot,
"deleting one tied chord tone damaged the neighbouring pitch or its tie");

// The same semantic deletion crosses barlines: choosing the gray segment in
// the following measure also releases the original attack in the prior bar.
const crossBarDeleteScore = new Score();
crossBarDeleteScore.parts.push(new Part());
const crossBarRoot = inputNoteAtCursor(
  crossBarDeleteScore,
  cursor(0, 0, 3, 4),
  { pitch: 60, number: "1" },
  new Fraction(1),
).note!;
const crossBarTail = inputNoteAtCursor(
  crossBarDeleteScore,
  cursor(0, 1, 0, 16),
  { pitch: 60, number: "1" },
  new Fraction(3, 4),
).note!;
crossBarRoot.tieStart = true;
crossBarRoot.tieNext = crossBarTail;
crossBarTail.tieEnd = true;
crossBarTail.tiePrev = crossBarRoot;
crossBarTail.chord.transparentContinuation = true;
crossBarTail.chord.generatedTimingContinuation = true;
inputRestAtCursor(
  crossBarDeleteScore,
  cursor(0, 1, 0, 16),
  new Fraction(3, 4),
  crossBarTail,
);
const crossBarRootRest = crossBarRoot.chord.measure.entries.find(
  (entry): entry is Chord => entry instanceof Chord && entry.rest
    && entry.position.equals(3) && entry.duration?.equals(1),
);
const crossBarTailRest = crossBarTail.chord.measure.entries.find(
  (entry): entry is Chord => entry instanceof Chord && entry.rest
    && entry.position.equals(0) && entry.duration?.equals(1),
);
check(Boolean(crossBarRootRest && crossBarTailRest)
  && crossBarDeleteScore.parts[0].measures.every((measure) =>
    measure.entries.every((entry) => !(entry instanceof Chord) || entry.rest)),
"deleting a cross-bar continuation did not release both measures as rests");

// Both persistent document formats must keep the released beat-local rests
// after their normal save/reparse cycle.
const roundTripDeleteFixture = tiedDeleteFixture();
const roundTripDeleteScore = roundTripDeleteFixture.score;
inputRestAtCursor(
  roundTripDeleteScore,
  cursor(0, 0, 0, 4),
  roundTripDeleteFixture.root.chord.duration ?? new Fraction(1),
  roundTripDeleteFixture.root,
);
const jpwDeleteText = scoreToJpwabc(roundTripDeleteScore);
const jpwDeleteScore = fromJpw(JpwFile.fromString(jpwDeleteText)!);
const jpwDeleteRests = jpwDeleteScore.parts[0].measures[0].entries
  .filter((entry): entry is Chord => entry instanceof Chord && entry.rest)
  .sort((left, right) => left.position.compareTo(right.position));
check(jpwDeleteRests.length === 4
  && jpwDeleteRests.every((rest, index) => rest.position.equals(index) && rest.duration?.equals(1))
  && jpwDeleteScore.parts[0].measures[0].entries.every((entry) =>
    !(entry instanceof Chord) || entry.rest),
`JPW round-trip restored a deleted continuation or lost released rests:\n${jpwDeleteText}`);

const slashDeleteOptions = defaultSlashScoreOptions(
  "number",
  analyzeSlashScore("数字谱\n4/4拍：\n点=16分音符\n0..../0..../0..../0..../\n"),
);
slashDeleteOptions.symbolDurations = { ".": 16 };
slashDeleteOptions.noteDivision = null;
slashDeleteOptions.showExplicitRests = true;
const slashDeleteText = scoreToSlashScore(
  roundTripDeleteScore,
  "number",
  16,
  ".",
  {
    braceMode: "arpeggio",
    bracketMode: "triplet",
    showExplicitRests: true,
    preserveExplicitRestMeasures: [0],
    durationNotation: slashDeleteOptions,
  },
  1,
);
const slashDeleteScore = parseSlashScore(slashDeleteText, slashDeleteOptions).score;
const slashDeleteRests = slashDeleteScore.parts[0].measures[0].entries
  .filter((entry): entry is Chord => entry instanceof Chord && entry.rest)
  .sort((left, right) => left.position.compareTo(right.position));
check(slashDeleteRests.length === 4
  && slashDeleteRests.every((rest, index) => rest.position.equals(index) && rest.duration?.equals(1))
  && slashDeleteScore.parts[0].measures[0].entries.every((entry) =>
    !(entry instanceof Chord) || entry.rest),
`TXT round-trip restored a deleted continuation or lost released rests:\n${slashDeleteText}`);

// The barline belongs to the next measure and must never create a zero-duration chord.
const boundaryScore = new Score();
boundaryScore.parts.push(new Part());
const boundaryMeasure = ensureInputMeasure(boundaryScore, 0, 0).measure;
const boundaryResult = inputNoteAtCursor(boundaryScore, cursor(0, 0, 4, 16), { pitch: 60, number: "1" });
check(!boundaryResult.changed && boundaryMeasure.entries.every((entry) =>
  !(entry instanceof Chord) || entry.rest),
  "input at the measure end should be rejected instead of creating a zero-duration note");

// When a split source was tied into the next measure, inserting a new attack
// cuts the old chain instead of restoring the original pitch after it.
const tiedSplitScore = new Score();
tiedSplitScore.parts.push(new Part());
const tiedSource = inputNoteAtCursor(tiedSplitScore, cursor(0, 0, 0, 4), { pitch: 60, number: "1" });
tiedSource.chord!.duration = new Fraction(4);
const tiedFuture = inputNoteAtCursor(tiedSplitScore, cursor(0, 1, 0, 4), { pitch: 60, number: "1" });
tiedSource.note!.tieStart = true;
tiedSource.note!.tieNext = tiedFuture.note;
tiedFuture.note!.tieEnd = true;
tiedFuture.note!.tiePrev = tiedSource.note;
inputNoteAtCursor(tiedSplitScore, cursor(0, 0, 1, 4), { pitch: 64, number: "3" });
check(!tiedSource.note!.tieStart && tiedSource.note!.tieNext === null
  && !tiedFuture.note!.tieEnd && tiedFuture.note!.tiePrev === null,
  "the truncated source must not keep a stale tie across the inserted note");

// Typing over a rendered gray continuation must turn that segment into a
// normal attack and remove only its incoming tie.
const continuationScore = new Score();
continuationScore.parts.push(new Part());
const continuationSource = inputNoteAtCursor(
  continuationScore,
  cursor(0, 0, 0, 16),
  { pitch: 60, number: "1" },
).note!;
continuationSource.chord.duration = new Fraction(1);
const continuationSegment = new Chord(continuationSource.chord.measure);
continuationSegment.position = new Fraction(1);
continuationSegment.duration = new Fraction(1);
continuationSegment.generatedTimingContinuation = true;
continuationSegment.transparentContinuation = true;
const continuationNote = new Note(continuationSegment);
continuationNote.pitch = 60;
continuationNote.number = "1";
continuationNote.tiePrev = continuationSource;
continuationNote.tieEnd = true;
continuationSource.tieNext = continuationNote;
continuationSource.tieStart = true;
continuationSegment.add(continuationNote);
continuationSegment.measure.add(continuationSegment);
const replacedContinuation = replaceInputContinuationAtCursor(
  continuationScore,
  cursor(0, 0, 1, 16),
  { pitch: 64, number: "3" },
  60,
);
check(replacedContinuation.changed && replacedContinuation.note === continuationNote,
  "a gray continuation should be editable at its own cursor position");
check(!continuationNote.tieEnd && continuationNote.tiePrev === null
  && !continuationSource.tieStart && continuationSource.tieNext === null,
  "typing over a continuation should remove its incoming tie");
check(!continuationSegment.generatedTimingContinuation
  && !continuationSegment.transparentContinuation
  && continuationNote.pitch === 64,
  "the edited continuation should become a normal attack with the new pitch");

// Creating at the cursor splits only the current note's complete value into
// three 3:2 members. Following attacks remain ordinary notes.
const tripletScore = new Score();
tripletScore.parts.push(new Part());
restMeasure(tripletScore);
inputNoteAtCursor(tripletScore, cursor(0, 0, 0, 16), { pitch: 60, number: "1" });
const followingTriplet = inputNoteAtCursor(
  tripletScore,
  cursor(0, 0, 0.25, 16),
  { pitch: 62, number: "2" },
);
const outsideTriplet = inputNoteAtCursor(
  tripletScore,
  cursor(0, 0, 0.5, 16),
  { pitch: 64, number: "3" },
);
const ornamentedTripletSource = tripletScore.parts[0].measures[0].entries.find(
  (entry): entry is Chord => entry instanceof Chord && entry.position.equals(new Fraction(0)),
);
ornamentedTripletSource?.ornaments.push({ kind: "upper-mordent" });
const createdTriplet = createInputTriplet(
  tripletScore,
  cursor(0, 0, 0, 16),
  new Fraction(1, 4),
);
check(createdTriplet.changed && createdTriplet.chords.length === 3,
  "the current note should become a three-member triplet");
check(createdTriplet.chords.every((chord) => chord.duration?.equals(new Fraction(1, 12)))
  && createdTriplet.chords[1].position.equals(new Fraction(1, 12))
  && createdTriplet.chords[2].position.equals(new Fraction(1, 6)),
  "one sixteenth should split into three real twelfths (written 32nds)");
check(createdTriplet.chords[0].notes.every((note) => note.tupletBegin && note.tuplet !== null)
  && createdTriplet.chords[2].notes.every((note) => note.tupletEnd && note.tuplet !== null),
  "triplet begin/end markers should cover all chord tones");
check(createdTriplet.chords.every((chord) => chord.ornaments.length === 0),
  "creating a real triplet retained an incompatible mordent or trill");
// An augmentation dot belongs to the binary source value, not to the
// triplet's written member. Creating over dotted eighth/quarter values first
// removes the dot and uses the corresponding undotted container span.
const dottedTripletScore = new Score();
dottedTripletScore.parts.push(new Part());
const dottedMeasure = restMeasure(dottedTripletScore);
const dottedSource = inputNoteAtCursor(
  dottedTripletScore,
  cursor(0, 0, 0, 16),
  { pitch: 60, number: "1" },
  new Fraction(1, 2),
).chord!;
dottedSource.duration = new Fraction(3, 4);
dottedSource.beats = 1;
dottedSource.beams = 1;
dottedSource.dot = 1;
const dottedTriplet = createInputTriplet(
  dottedTripletScore,
  cursor(0, 0, 0, 16),
  new Fraction(1, 4),
);
const dottedMembers = dottedTriplet.chords.filter((chord) => chord.notes.some((note) => note.tuplet));
check(dottedTriplet.changed
  && dottedMembers.length === 3
  && dottedMembers.every((chord) => chord.duration?.equals(new Fraction(1, 6)))
  && dottedMembers[0]?.dot === 0
  && dottedMeasure.entries.some((entry) => entry instanceof Chord && entry.rest
    && entry.position.equals(new Fraction(1, 2))
    && entry.duration?.equals(new Fraction(1, 2))),
"creating a triplet from a dotted eighth should undot the source and release the remaining quarter space");
const dottedQuarterScore = new Score();
dottedQuarterScore.parts.push(new Part());
const dottedQuarterMeasure = restMeasure(dottedQuarterScore);
const dottedQuarterSource = inputNoteAtCursor(
  dottedQuarterScore,
  cursor(0, 0, 0, 4),
  { pitch: 60, number: "1" },
  new Fraction(1),
).chord!;
dottedQuarterSource.duration = new Fraction(3, 2);
dottedQuarterSource.beats = 1;
dottedQuarterSource.beams = 0;
dottedQuarterSource.dot = 1;
const dottedQuarterTriplet = createInputTriplet(
  dottedQuarterScore,
  cursor(0, 0, 0, 4),
  new Fraction(1),
);
const dottedQuarterMembers = dottedQuarterTriplet.chords.filter((chord) => chord.notes.some((note) => note.tuplet));
check(dottedQuarterTriplet.changed
  && dottedQuarterMembers.length === 3
  && dottedQuarterMembers.every((chord) => chord.duration?.equals(new Fraction(1, 3)))
  && dottedQuarterMembers[0]?.dot === 0
    && dottedQuarterMeasure.entries.some((entry) => entry instanceof Chord && entry.rest
    && entry.position.equals(new Fraction(1))
    && entry.duration?.compareTo(new Fraction(0)) === 1),
"creating a triplet from a dotted quarter should use an undotted quarter container of total span one");
const createdTupletMark = createdTriplet.chords[0].notes[0].tuplet!;
check(createdTupletMark.scope === "voice"
  && createdTupletMark.partIndex === 0
  && createdTupletMark.voiceIndex === 1,
"a cursor-created triplet should retain its concrete part/voice ownership");
check(inputTripletCursorDelta(
  tripletScore,
  { partIndex: 0, measureIndex: 0, offset: new Fraction(0) },
  1,
)?.equals(new Fraction(1, 12))
  && inputTripletCursorDelta(
    tripletScore,
    { partIndex: 0, measureIndex: 0, offset: new Fraction(1, 6) },
    -1,
  )?.equals(new Fraction(-1, 12)),
"plain input navigation should follow real triplet member positions instead of the binary ruler");
check(createdTriplet.chords[2].rest
  && followingTriplet.chord?.position.equals(new Fraction(1, 4))
  && followingTriplet.note?.tuplet === null
  && outsideTriplet.chord?.position.equals(new Fraction(1, 2))
  && outsideTriplet.note?.tuplet === null,
"the two new rests must not absorb either following attack");

// An eighth is likewise the complete container: it creates three written
// sixteenths and does not leave a generated tail after the bracket.
const eighthTripletScore = new Score();
eighthTripletScore.parts.push(new Part());
restMeasure(eighthTripletScore);
const eighthSource = inputNoteAtCursor(
  eighthTripletScore,
  cursor(0, 0, 0, 8),
  { pitch: 60, number: "1" },
  new Fraction(1, 2),
).note!;
const eighthFollowing = inputNoteAtCursor(
  eighthTripletScore,
  cursor(0, 0, 1, 4),
  { pitch: 62, number: "2" },
).note!;
const eighthTriplet = createInputTriplet(
  eighthTripletScore,
  cursor(0, 0, 0, 8),
  new Fraction(1, 2),
);
check(eighthTriplet.changed
  && eighthTriplet.chords.every((chord) => chord.duration?.equals(new Fraction(1, 6)))
  && eighthTriplet.chords.map((chord) => chord.position.toString()).join(",") === "0,1/6,1/3"
  && eighthTriplet.chords[0].notes[0].tuplet?.writtenUnit?.equals(new Fraction(1, 4))
  && eighthSource.tieNext === null
  && eighthFollowing.chord.position.equals(new Fraction(1)),
"an eighth should become three written-sixteenth triplet members without an extra tail");

// Filling the transformed measure must count an existing generated tie
// continuation as occupied time. Otherwise a second rest is inserted on top
// of it and TXT serialization later turns the entire sustain into silence.
const sustainedTripletScore = new Score();
sustainedTripletScore.parts.push(new Part());
restMeasure(sustainedTripletScore);
inputNoteAtCursor(sustainedTripletScore, cursor(0, 0, 0, 16), { pitch: 60, number: "1" });
inputNoteAtCursor(sustainedTripletScore, cursor(0, 0, 0.25, 16), { pitch: 62, number: "2" });
inputNoteAtCursor(sustainedTripletScore, cursor(0, 0, 0.5, 16), { pitch: 64, number: "3" });
const sustainedRoot = inputNoteAtCursor(
  sustainedTripletScore,
  cursor(0, 0, 0.75, 16),
  { pitch: 65, number: "4" },
).note!;
const sustainedMeasure = sustainedTripletScore.parts[0].measures[0];
const sustainedContinuation = new Chord(sustainedMeasure);
sustainedContinuation.position = new Fraction(1);
sustainedContinuation.duration = new Fraction(3);
sustainedContinuation.generatedTimingContinuation = true;
sustainedContinuation.transparentContinuation = true;
const sustainedContinuationNote = new Note(sustainedContinuation);
sustainedContinuationNote.pitch = sustainedRoot.pitch;
sustainedContinuationNote.number = sustainedRoot.number;
sustainedContinuationNote.tiePrev = sustainedRoot;
sustainedContinuationNote.tieEnd = true;
sustainedRoot.tieNext = sustainedContinuationNote;
sustainedRoot.tieStart = true;
sustainedContinuation.add(sustainedContinuationNote);
sustainedMeasure.add(sustainedContinuation);
createInputTriplet(
  sustainedTripletScore,
  cursor(0, 0, 0, 16),
  new Fraction(1, 4),
);
check(sustainedMeasure.entries.includes(sustainedContinuation)
  && !sustainedMeasure.entries.some((entry) => entry instanceof Chord
    && entry.rest && entry.position.equals(new Fraction(1))),
"creating a triplet inserted a rest over another note's generated continuation");

// Empty space is a valid creation target and produces three explicit tuplet
// zeroes rather than requiring three pre-existing attacks.
const emptyTripletScore = new Score();
emptyTripletScore.parts.push(new Part());
restMeasure(emptyTripletScore);
const emptyTriplet = createInputTriplet(
  emptyTripletScore,
  cursor(0, 0, 0, 16),
  new Fraction(1, 4),
);
check(emptyTriplet.changed && emptyTriplet.chords.length === 3
  && emptyTriplet.chords.every((chord) => chord.rest && chord.notes[0].tuplet !== null),
"an empty cursor window should create three marked triplet rests");
const emptyTuplet = emptyTriplet.chords[0].notes[0].tuplet!;
check(tupletWrittenToActual(new Fraction(1, 16), emptyTuplet).equals(new Fraction(1, 24))
  && tupletActualToWritten(new Fraction(1, 24), emptyTuplet).equals(new Fraction(1, 16))
  && tupletActualToWritten(new Fraction(1, 12), emptyTuplet).equals(new Fraction(1, 8))
  && tupletActualToWritten(new Fraction(1, 8), emptyTuplet).equals(new Fraction(3, 16)),
"triplet written/actual conversion should cover 32nd, 16th, eighth and dotted-eighth totals");

// End-to-end editable slot sequence inside an eighth-note container: written
// 16th -> 32nd+32nd rest -> 16th, then consume the two remaining triplet rests (printed eighth and
// dotted-eighth totals), finally crossing the Tuplet boundary as an ordinary
// 16th transparent continuation.
const sequenceScore = new Score();
sequenceScore.parts.push(new Part());
const sequenceMeasure = restMeasure(sequenceScore);
sequenceMeasure.time.beats = 2;
sequenceMeasure.time.beatType = 4;
const sequenceWholeRest = sequenceMeasure.entries.find(
  (entry): entry is Chord => entry instanceof Chord && entry.rest,
);
if (sequenceWholeRest) sequenceWholeRest.duration = new Fraction(2);
const sequenceNote = inputNoteAtCursor(
  sequenceScore,
  cursor(0, 0, 0, 16),
  { pitch: 60, number: "1" },
  new Fraction(1, 2),
).note!;
const sequenceCreation = createInputTriplet(
  sequenceScore,
  cursor(0, 0, 0, 16),
  new Fraction(1, 4),
);
const sequenceTuplet = sequenceCreation.chords[0].notes[0].tuplet!;
check(sequenceCreation.changed && sequenceNote.tuplet === sequenceTuplet
  && sequenceNote.chord.duration?.equals(new Fraction(1, 6)),
"an eighth-note source should store one written 16th member as 1/6 actual quarter time");
check(resizeInputTupletMember(sequenceScore, sequenceNote, new Fraction(-1, 12)).changed
  && sequenceNote.chord.duration?.equals(new Fraction(1, 12))
  && inputTupletMembers(sequenceTuplet).some((chord) => chord.rest
    && chord.duration?.equals(new Fraction(1, 12))),
"shrinking a 16th triplet member should leave a 32nd triplet rest");
check(resizeInputTupletMember(sequenceScore, sequenceNote, new Fraction(1, 12)).changed
  && sequenceNote.chord.duration?.equals(new Fraction(1, 6)),
"the adjacent 32nd triplet rest should merge back into the 16th member");
check(resizeInputTupletMember(sequenceScore, sequenceNote, new Fraction(1, 6)).changed
  && sequenceNote.chord.duration?.equals(new Fraction(1, 3)),
"two 16th triplet slots should merge into a written eighth member");
check(resizeInputTupletMember(sequenceScore, sequenceNote, new Fraction(1, 6)).changed
  && sequenceNote.chord.duration?.equals(new Fraction(1, 2)),
"three 16th triplet slots should merge into a written dotted-eighth total");
const singleMemberTupletText = scoreToJpwabc(sequenceScore);
const singleMemberTupletFile = JpwFile.fromString(singleMemberTupletText);
const singleMemberTupletScore = singleMemberTupletFile ? fromJpw(singleMemberTupletFile) : null;
const singleMemberTupletChord = singleMemberTupletScore?.parts[0]?.measures[0]?.entries.find(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest,
) ?? null;
check(singleMemberTupletChord?.duration?.equals(new Fraction(1, 2))
  && singleMemberTupletChord.notes.every((note) => note.tuplet !== null
    && note.tupletBegin && note.tupletEnd),
`a dotted-eighth spelling that fills the entire tuplet lost its single-member boundaries:
${singleMemberTupletText}`);
const sequenceOutside = extendInputTupletOutside(
  sequenceScore,
  sequenceNote,
  new Fraction(1, 4),
);
check(sequenceOutside.changed && sequenceOutside.continuation !== null
  && sequenceOutside.continuation.duration?.equals(new Fraction(1, 4))
  && sequenceOutside.continuation.notes.every((note) => note.tuplet === null)
  && sequenceNote.tieNext?.chord === sequenceOutside.continuation,
"extending after the completed triplet should create an ordinary 16th tie outside it");
const outsideBoundaryText = scoreToJpwabc(sequenceScore);
const outsideBoundaryFile = JpwFile.fromString(outsideBoundaryText);
const outsideBoundaryScore = outsideBoundaryFile ? fromJpw(outsideBoundaryFile) : null;
const outsideBoundaryRoot = outsideBoundaryScore?.parts[0]?.measures[0]?.entries.find(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest
    && entry.notes.some((note) => note.tupletBegin),
) ?? null;
const outsideBoundaryNote = outsideBoundaryRoot?.notes.find((note) => !note.rest) ?? null;
check(outsideBoundaryRoot?.duration?.equals(new Fraction(1, 2))
  && outsideBoundaryNote?.tuplet !== null
  && outsideBoundaryNote?.tieNext?.chord.duration?.equals(new Fraction(1, 4))
  && outsideBoundaryNote.tieNext.tuplet === null,
`JPW normalization merged an ordinary continuation back into its Tuplet source:
${outsideBoundaryText}`);
const sequenceSlashOptions = defaultSlashScoreOptions(
  "number",
  analyzeSlashScore("数字谱\n4/4拍：\n点=16分音符\n0..../0..../0..../0..../\n"),
);
sequenceSlashOptions.symbolDurations = { ".": 16 };
sequenceSlashOptions.noteDivision = null;
sequenceSlashOptions.showExplicitRests = true;
sequenceSlashOptions.bracketMode = "triplet";
sequenceSlashOptions.angleMode = "subdivide";
const outsideBoundarySlash = scoreToSlashScore(
  sequenceScore,
  "number",
  16,
  ".",
  {
    braceMode: "arpeggio",
    bracketMode: "triplet",
    angleMode: "subdivide",
    preserveExplicitRestMeasures: [0],
    durationNotation: sequenceSlashOptions,
  },
  1,
);
const outsideBoundarySlashScore = parseSlashScore(
  outsideBoundarySlash,
  sequenceSlashOptions,
).score;
const outsideBoundarySlashRoot = outsideBoundarySlashScore.parts[0]?.measures[0]?.entries.find(
  (entry): entry is Chord => entry instanceof Chord && !entry.rest
    && entry.notes.some((note) => note.tupletBegin),
) ?? null;
const outsideBoundarySlashNote = outsideBoundarySlashRoot?.notes.find((note) => !note.rest) ?? null;
check(outsideBoundarySlashRoot?.duration?.equals(new Fraction(1, 2))
  && outsideBoundarySlashNote?.tieNext?.chord.duration?.equals(new Fraction(1, 4))
  && outsideBoundarySlashNote.tieNext.tuplet === null,
`TXT round-trip stretched the ordinary 16th after a completed Tuplet:
${outsideBoundarySlash}`);
const outsideScore = new Score();
outsideScore.parts.push(new Part());
restMeasure(outsideScore);
const outsideSource = inputNoteAtCursor(
  outsideScore,
  cursor(0, 0, 0, 16),
  { pitch: 60, number: "1" },
).note!;
const outsideCreated = createInputTriplet(
  outsideScore,
  cursor(0, 0, 0, 16),
  new Fraction(1, 4),
);
const outsideTuplet = outsideCreated.chords[0].notes[0].tuplet!;
const outsideLastInput = inputNoteAtCursor(
  outsideScore,
  { ...cursor(0, 0, 0, 16), offset: new Fraction(1, 6) },
  { pitch: 60, number: "1" },
).note!;
const outsideResult = extendInputTupletOutside(outsideScore, outsideLastInput, new Fraction(1, 4));
check(outsideResult.changed && outsideResult.continuation !== null
  && outsideResult.continuation.notes.every((note) => note.tuplet === null)
  && outsideLastInput.tuplet === outsideTuplet
  && outsideLastInput.tieNext?.chord === outsideResult.continuation,
"extending past a tuplet should create an ordinary tied continuation outside the group");
// Shortening a member that was extended outside the group inserts silence;
// the old outgoing tie must not cross that newly released cell.
const shortenedExtended = resizeInputTupletMember(
  outsideScore,
  outsideLastInput,
  new Fraction(-1, 24),
);
check(shortenedExtended.changed
  && outsideLastInput.tieNext === null
  && outsideResult.continuation.notes.every((note) => note.tiePrev === null
    && !note.tieEnd)
  && !outsideResult.continuation.transparentContinuation,
"shortening an extended triplet member should break its tie across the inserted rest");
completeInputMeasure(outsideScore, { partIndex: 0, measureIndex: 0 }, false);
check(outsideLastInput.tuplet === outsideTuplet
  && outsideCreated.chords.some((chord) => chord.notes.some((note) => note.tuplet === outsideTuplet)),
"completing a measure must not erase tuplets or their actual member durations");
const firstEmptyMember = emptyTriplet.chords[0];
const firstEmptyNote = firstEmptyMember.notes[0];
const resizedShort = resizeInputTupletMember(
  emptyTripletScore,
  firstEmptyNote,
  new Fraction(-1, 24),
);
check(resizedShort.changed
  && firstEmptyMember.duration?.equals(new Fraction(1, 24))
  && emptyTripletScore.parts[0].measures[0].entries.some((entry) =>
    entry instanceof Chord && entry.rest && entry.position.equals(new Fraction(1, 24))
      && entry.notes.some((note) => note.tuplet === emptyTuplet)),
"shortening a triplet member should insert a same-tuplet rest at its tail");
const resizedLong = resizeInputTupletMember(emptyTripletScore, firstEmptyNote, new Fraction(1, 24));
check(resizedLong.changed && firstEmptyMember.duration?.equals(new Fraction(1, 12))
  && !emptyTripletScore.parts[0].measures[0].entries.some((entry) =>
    entry instanceof Chord && entry.rest && entry.position.equals(new Fraction(1, 24))
      && entry.notes.some((note) => note.tuplet === emptyTuplet)),
"extending a triplet member should consume its adjacent same-tuplet rest");
const emptyTripletJpw = scoreToJpwabc(emptyTripletScore);
const emptyTripletJpwFile = JpwFile.fromString(emptyTripletJpw);
check(emptyTripletJpwFile !== null && emptyTripletJpw.includes("{(3}"),
  "JPW serialization should retain an all-rest tuplet container");
const emptyTripletJpwScore = fromJpw(emptyTripletJpwFile!);
const emptyJpwTupleEntries = emptyTripletJpwScore.parts[0].measures[0].entries.filter(
  (entry): entry is Chord => entry instanceof Chord,
);
check(emptyJpwTupleEntries.length >= 3
  && emptyJpwTupleEntries.some((entry) => entry.notes.some((note) => note.tupletBegin))
  && emptyJpwTupleEntries.some((entry) => entry.notes.some((note) => note.tupletEnd)),
"JPW round-trip should retain all three zeroes and their tuplet boundaries");
const emptyTripletTxt = scoreToSlashScore(
  emptyTripletScore,
  "number",
  16,
  ".",
  { braceMode: "grace", bracketMode: "triplet", showExplicitRests: true },
  1,
);
const emptyTripletTxtOptions = defaultSlashScoreOptions(
  "number",
  analyzeSlashScore(emptyTripletTxt),
);
emptyTripletTxtOptions.showExplicitRests = true;
const emptyTripletTxtScore = parseSlashScore(emptyTripletTxt, emptyTripletTxtOptions).score;
check(emptyTripletTxt.includes("[")
  && emptyTripletTxtScore.parts[0].measures[0].entries.filter((entry) =>
    entry instanceof Chord && entry.notes.some((note) => note.tuplet !== null)).length === 3,
"number TXT round-trip should retain an all-rest triplet container");
const editableTupleCursor = {
  ...cursor(0, 0, 0, 16),
  offset: new Fraction(1, 6),
};
// A persisted timing overlay stores the pre-edit spelling on every chord.
// Replacing a tuplet zero must bake the live 3:2 notation and clear those
// stale snapshots; otherwise JPW serialization can restore a finer value for
// the whole group after the first typed note.
emptyTripletScore.noteTimingEdits = [{ part: 0, chord: 0, move: "0", duration: "1/8" }];
for (const chord of inputTupletMembers(emptyTuplet)) {
  chord.timingOriginal = {
    measureIndex: 0,
    position: chord.position,
    beats: 1,
    beams: 3,
    dot: 0,
    tieStart: false,
    tieEnd: false,
  };
}
const typedTupleMember = inputNoteAtCursor(
  emptyTripletScore,
  editableTupleCursor,
  { pitch: 64, number: "3" },
);
check(typedTupleMember.changed
  && typedTupleMember.chord?.duration?.equals(new Fraction(1, 12))
  && typedTupleMember.note?.tupletEnd
  && typedTupleMember.note.tuplet !== null
  && typedTupleMember.fixedTupletCell === true,
"typing over a triplet zero should retain the exact member duration and end marker");
check(emptyTripletScore.noteTimingEdits.length === 0
  && inputTupletMembers(emptyTuplet).every((chord) => chord.timingOriginal === null),
"typing into a fixed triplet cell should clear stale JPW timing overlays");
const typedTupleJpw = scoreToJpwabc(emptyTripletScore);
const typedTupleJpwScore = fromJpw(JpwFile.fromString(typedTupleJpw)!);
const typedTupleJpwMembers = typedTupleJpwScore.parts[0].measures[0].entries
  .filter((entry): entry is Chord => entry instanceof Chord
    && entry.notes.some((note) => note.tuplet !== null));
check(typedTupleJpwMembers.length === 3
  && typedTupleJpwMembers.every((chord) => chord.duration?.equals(new Fraction(1, 12))
    && chord.beams === 3),
`typing the third JPW triplet member changed the whole group value:\n${typedTupleJpw}\n${
  typedTupleJpwMembers.map((chord) => `${chord.position}/${chord.duration}/b${chord.beams}`).join(",")
}`);

// A legacy/hand-written JPW group can close after two equal members and leave
// its conventional third cell as ordinary blank/rest time. Input at that
// cell must join the existing Tuplet instead of creating a finer ordinary
// note and shrinking the group on the next parse.
const twoMemberTupleFile = JpwFile.fromString(`.Title
KeyAndMeters = {1=C,4/4}
.Voice
{(3}1__ 2__) 0... 0 0 0 |]
`)!;
const twoMemberTupleScore = fromJpw(twoMemberTupleFile);
const twoMemberTuple = twoMemberTupleScore.parts[0].measures[0].entries
  .find((entry): entry is Chord => entry instanceof Chord
    && entry.notes.some((note) => note.tupletBegin))!.notes[0].tuplet!;
const twoMemberNote = twoMemberTuple.first;
check(inputTripletCellDuration(twoMemberNote)?.equals(new Fraction(1, 6))
  && inputTripletCursorDelta(
    twoMemberTupleScore,
    { ...cursor(0, 0, 0, 16), offset: new Fraction(1, 3) },
    -1,
  )?.equals(new Fraction(-1, 6)),
"a compact two-member triplet should expose its inferred empty third cell to input navigation");
const filledThirdTuple = inputNoteAtCursor(
  twoMemberTupleScore,
  { ...cursor(0, 0, 0, 16), offset: new Fraction(1, 3) },
  { pitch: 64, number: "3" },
  new Fraction(1, 4),
);
const filledThirdMembers = inputTupletMembers(twoMemberTuple);
check(filledThirdTuple.note?.tuplet === twoMemberTuple
  && filledThirdMembers.length === 3
  && filledThirdMembers.every((chord) => chord.duration?.equals(new Fraction(1, 6))
    && chord.beams === 2),
`typing a missing third JPW triplet cell did not preserve three written sixteenths: ${
  filledThirdMembers.map((chord) => `${chord.position}/${chord.duration}/b${chord.beams}`).join(",")
}`);
const filledThirdJpw = scoreToJpwabc(twoMemberTupleScore);
const filledThirdRoundTrip = fromJpw(JpwFile.fromString(filledThirdJpw)!);
const filledThirdRoundTripMembers = filledThirdRoundTrip.parts[0].measures[0].entries
  .filter((entry): entry is Chord => entry instanceof Chord
    && entry.notes.some((note) => note.tuplet !== null));
check(filledThirdRoundTripMembers.length === 3
  && filledThirdRoundTripMembers.every((chord) => chord.duration?.equals(new Fraction(1, 6))
    && chord.beams === 2),
`the filled JPW triplet shrank after serialization:\n${filledThirdJpw}\n${
  filledThirdRoundTripMembers.map((chord) => `${chord.position}/${chord.duration}/b${chord.beams}`).join(",")
}`);

// JPW rhythmic normalization is part-wide. A semantic tie elsewhere in the
// same part must not make that normalizer reinterpret compressed tuplet
// durations as ordinary binary values. Otherwise every save/reparse changes
// 16th-triplet beams to 32nds and compresses the bar again on the next edit.
let tiedPartTupleScore = fromJpw(JpwFile.fromString(`.Title
KeyAndMeters = {1=C,4/4}
.Voice
(1 1) {(3}0__ 0__ 0__) 0. |]
`)!);
const tiedTupleOffsets = [new Fraction(2), new Fraction(13, 6), new Fraction(7, 3)];
for (let edit = 0; edit <= tiedTupleOffsets.length; edit++) {
  const measure = tiedPartTupleScore.parts[0].measures[0];
  const members = measure.entries.filter((entry): entry is Chord =>
    entry instanceof Chord && entry.notes.some((note) => note.tuplet !== null));
  const measureEnd = measure.entries.reduce((end, entry) => {
    if (!(entry instanceof Chord) || !entry.duration) return end;
    const candidate = entry.position.plus(entry.duration);
    return candidate.compareTo(end) > 0 ? candidate : end;
  }, new Fraction(0));
  check(members.length === 3
    && members.every((chord) => chord.beams === 2
      && chord.duration?.equals(new Fraction(1, 6)))
    && measureEnd.equals(new Fraction(4)),
  `a tie elsewhere repeatedly compressed the JPW triplet after edit ${edit}: ${
    members.map((chord) => `${chord.position}/${chord.duration}/b${chord.beams}`).join(",")
  }; end=${measureEnd}`);
  if (edit === tiedTupleOffsets.length) break;
  inputNoteAtCursor(
    tiedPartTupleScore,
    { ...cursor(0, 0, 0, 16), offset: tiedTupleOffsets[edit] },
    { pitch: 60 + edit * 2, number: String(edit + 1) },
    new Fraction(1, 4),
  );
  tiedPartTupleScore = fromJpw(JpwFile.fromString(scoreToJpwabc(tiedPartTupleScore))!);
}

// Alt movement inside a 3:2 domain always follows that domain's own member
// grid, even when a different global toolbar value is passed by a caller.
const tupleMoveScore = new Score();
tupleMoveScore.parts.push(new Part());
restMeasure(tupleMoveScore);
const tupleMoveNote = inputNoteAtCursor(
  tupleMoveScore,
  cursor(0, 0, 0, 8),
  { pitch: 60, number: "1" },
  new Fraction(1, 2),
).note!;
const tupleMoveCreated = createInputTriplet(
  tupleMoveScore,
  cursor(0, 0, 0, 8),
  new Fraction(1, 2),
);
const tupleMoveMark = tupleMoveCreated.chords[0].notes[0].tuplet!;
const tupleMoveResult = moveInputTieChainByNotationDomain(
  tupleMoveScore,
  0,
  tupleMoveNote,
  new Fraction(1, 2),
  1,
);
const tupleMoveSounding = tupleMoveScore.parts[0].measures[0].entries
  .filter((entry): entry is Chord => entry instanceof Chord && !entry.rest);
check(tupleMoveResult.changed
  && tupleMoveResult.delta.equals(new Fraction(1, 6))
  && tupleMoveSounding.length === 1
  && tupleMoveSounding[0].position.equals(new Fraction(1, 6))
  && tupleMoveSounding[0].duration?.equals(new Fraction(1, 6))
  && tupleMoveSounding[0].beams === 2
  && tupleMoveSounding[0].notes[0].tuplet === tupleMoveMark,
`Alt-moving an eighth inside its triplet used ordinary timing or lost the group: ${
  tupleMoveScore.parts[0].measures[0].entries.flatMap((entry) => entry instanceof Chord
    ? [`${entry.position}/${entry.duration}/r${entry.rest}/b${entry.beams}/t${entry.notes[0]?.tuplet === tupleMoveMark}`]
    : []).join(",")
}`);

const restoredTupleZero = inputRestAtCursor(
  emptyTripletScore,
  editableTupleCursor,
  new Fraction(1, 4),
  typedTupleMember.note,
);
check(restoredTupleZero.changed
  && restoredTupleZero.rest?.duration?.equals(new Fraction(1, 12))
  && restoredTupleZero.rest.notes[0].tupletEnd,
"deleting a triplet member should restore a marked zero without returning to the binary grid");

// Creating in the middle of an already sounding ordinary note is rejected:
// the command only splits the value whose attack is exactly at the cursor.
const heldTripletScore = new Score();
heldTripletScore.parts.push(new Part());
const heldMeasure = restMeasure(heldTripletScore);
heldMeasure.entries = [];
const heldRoot = new Chord(heldMeasure);
heldRoot.position = new Fraction(0);
heldRoot.duration = new Fraction(1);
heldRoot.beats = 1;
const heldNote = new Note(heldRoot);
heldNote.pitch = 60;
heldNote.number = "1";
heldRoot.add(heldNote);
heldMeasure.add(heldRoot);
const heldTriplet = createInputTriplet(
  heldTripletScore,
  { ...cursor(0, 0, 0, 16), offset: new Fraction(1, 4) },
  new Fraction(1, 4),
);
check(!heldTriplet.changed && heldTriplet.reason === "finer-rhythm"
  && heldRoot.position.equals(new Fraction(0))
  && heldRoot.duration?.equals(new Fraction(1))
  && heldNote.tuplet === null,
"creating a triplet away from the current attack should not split a held note");

const crossingTriplet = createInputTriplet(
  emptyTripletScore,
  { ...cursor(0, 0, 0, 16), offset: new Fraction(15, 4) },
  new Fraction(1, 2),
);
check(!crossingTriplet.changed && crossingTriplet.reason === "cross-measure",
"a triplet container must never cross the current barline");

// Without free space after the group, deleting ABC retains the two ordinary
// values that fit and drops the trailing member.
const thirdTripletAttack = inputNoteAtCursor(
  tripletScore,
  { ...cursor(0, 0, 0, 16), offset: new Fraction(1, 6) },
  { pitch: 65, number: "4" },
);
check(thirdTripletAttack.note?.tupletEnd,
  "the third rest should be editable as a sounding triplet member before removal");
const tuple = createdTriplet.chords[0].notes[0].tuplet!;
const removedTriplet = removeInputTriplet(tripletScore, tuple);
check(removedTriplet.changed && removedTriplet.dropped === 2
  && removedTriplet.kept.length === 1
  && removedTriplet.kept.every((chord) => chord.duration?.equals(new Fraction(1, 4)))
  && !tripletScore.parts[0].measures[0].entries.some((entry) => entry instanceof Chord
    && entry.notes.some((note) => note.pitch === 65)),
"removing a triplet before an occupied boundary should retain only members that fit");

const removeCompactTripletFixture = (
  writtenValues: Array<{ value: Fraction; beams: number; dot?: number }>,
  availableEnd: Fraction,
): { kept: Chord[]; dropped: number } => {
  const score = new Score();
  score.parts.push(new Part());
  const measure = restMeasure(score);
  measure.entries = [];
  const memberNotes: Note[] = [];
  let position = new Fraction(0);
  writtenValues.forEach((written, index) => {
    const chord = new Chord(measure);
    chord.position = position;
    chord.duration = written.value.timesInt(2).divInt(3);
    chord.beats = 1;
    chord.beams = written.beams;
    chord.dot = written.dot ?? 0;
    const note = new Note(chord);
    note.pitch = 60 + index;
    note.number = String(index + 1);
    chord.add(note);
    measure.add(chord);
    memberNotes.push(note);
    position = position.plus(chord.duration);
  });
  const boundary = new Chord(measure);
  boundary.position = availableEnd;
  boundary.duration = new Fraction(1, 4);
  boundary.beams = 2;
  const boundaryNote = new Note(boundary);
  boundaryNote.pitch = 72;
  boundaryNote.number = "1";
  boundary.add(boundaryNote);
  measure.add(boundary);
  const tuplet = new Tuplet(memberNotes[0], memberNotes[memberNotes.length - 1]);
  tuplet.partIndex = 0;
  tuplet.voiceIndex = 1;
  tuplet.scope = "voice";
  tuplet.writtenUnit = new Fraction(1, 8);
  tuplet.binaryRestoreUnit = new Fraction(1, 4);
  tuplet.actualStart = new Fraction(0);
  tuplet.actualEnd = position;
  memberNotes.forEach((note, index) => {
    note.tuplet = tuplet;
    note.tupletBegin = index === 0;
    note.tupletEnd = index === memberNotes.length - 1;
  });
  const result = removeInputTriplet(score, tuplet);
  return { kept: result.kept, dropped: result.dropped };
};

const removedThreeThirtySeconds = removeCompactTripletFixture([
  { value: new Fraction(1, 8), beams: 3 },
  { value: new Fraction(1, 8), beams: 3 },
  { value: new Fraction(1, 8), beams: 3 },
], new Fraction(1, 2));
check(removedThreeThirtySeconds.kept.length === 2
  && removedThreeThirtySeconds.dropped === 1
  && removedThreeThirtySeconds.kept.every((chord) => chord.duration?.equals(new Fraction(1, 4))),
"removing three 32nd-triplet members did not restore the first two as ordinary 16ths");

const removedSixteenthThenThirtySecond = removeCompactTripletFixture([
  { value: new Fraction(1, 4), beams: 2 },
  { value: new Fraction(1, 8), beams: 3 },
], new Fraction(1, 4));
check(removedSixteenthThenThirtySecond.kept.length === 1
  && removedSixteenthThenThirtySecond.kept[0].duration?.equals(new Fraction(1, 4))
  && removedSixteenthThenThirtySecond.dropped === 1,
"a 16th+32nd tuplet did not retain only the leading ordinary 16th when space ended");

const removedDottedSixteenth = removeCompactTripletFixture([
  { value: new Fraction(3, 8), beams: 2, dot: 1 },
], new Fraction(1, 2));
check(removedDottedSixteenth.kept.length === 1
  && removedDottedSixteenth.kept[0].duration?.equals(new Fraction(1, 2))
  && removedDottedSixteenth.kept[0].dot === 0,
"a dotted 16th tuplet member did not restore as one ordinary eighth");

const removedThirtySecondThenSixteenth = removeCompactTripletFixture([
  { value: new Fraction(1, 8), beams: 3 },
  { value: new Fraction(1, 4), beams: 2 },
], new Fraction(1, 2));
check(removedThirtySecondThenSixteenth.kept.length === 2
  && removedThirtySecondThenSixteenth.kept.every((chord) => chord.duration?.equals(new Fraction(1, 4)))
  && removedThirtySecondThenSixteenth.dropped === 0,
"a 32nd+16th tuplet did not restore both members on the ordinary 16th grid");

// Measure operations are synchronized across piano/full-score parts. Newly
// inserted bars are immediately editable beat rests and score anchors move
// with the timeline.
const measureOps = new Score();
measureOps.parts.push(new Part(), new Part());
restMeasure(measureOps, 0, 0);
restMeasure(measureOps, 0, 1);
restMeasure(measureOps, 1, 0);
restMeasure(measureOps, 1, 1);
measureOps.tempoMarks.push({ measure: 1, offset: new Fraction(0), kind: "tempo", bpm: 90, beatUnit: "quarter", softDeleted: false });
measureOps.keyMarks.push({ measure: 1, offset: new Fraction(0), fifths: 2 });
const insertedBars = insertInputMeasure(measureOps, 0, { side: "after" });
check(insertedBars.length === 2 && measureOps.parts.every((part) => part.measures.length === 3),
  "inserting a measure should update every part");
check(insertedBars[0].entries.filter((entry) => entry instanceof Chord).length === 4,
  "inserted measure should contain one rest per beat");
check(measureOps.tempoMarks[0].measure === 2 && measureOps.keyMarks[0].measure === 2,
  "timeline marks after an inserted measure should shift right");
check(isInputMeasureEmpty(measureOps, 1), "a newly inserted rest bar should be empty");
const removedBars = deleteInputMeasures(measureOps, [1]);
check(removedBars === 1 && measureOps.parts.every((part) => part.measures.length === 2),
  "deleting a measure should update every part");
check(measureOps.tempoMarks[0].measure === 1 && measureOps.keyMarks[0].measure === 1,
  "timeline marks should move back after deletion");
check(removeEmptyInputMeasures(measureOps) === 1 && measureOps.parts.every((part) => part.measures.length === 1),
  "empty synchronized bars should be removed while retaining one bar");

// A committed score can keep one formal editable tail: beat-sized zeros and
// the terminal |] barline move with it when another measure is appended.
const tailScore = new Score();
tailScore.parts.push(new Part());
const tailSource = inputNoteAtCursor(tailScore, cursor(0, 0, 0, 16), { pitch: 60, number: "1" });
check(tailSource.changed, "tail fixture should contain a real source note");
const tail = ensureInputTailMeasure(tailScore, 0);
check(tail !== null && tail.barline === BarStyle.LIGHT_HEAVY && tail.entries
  .filter((entry): entry is Chord => entry instanceof Chord)
  .every((chord) => chord.rest),
  "formal tail should contain only rests and a terminal barline");
check(tailScore.parts[0].measures[0].barline === BarStyle.REGULAR,
  "the previous measure should become an interior barline");

// While TXT input mode is still open, a newly typed quarter inside an
// implicit whole-bar sustain must materialize the remaining draft silence.
// Otherwise the next TXT round-trip stretches the second attack to the end
// of the bar and prints it as a dotted/tied value.
const draftTailScore = new Score();
draftTailScore.parts.push(new Part());
const draftTailMeasure = ensureInputMeasure(draftTailScore, 0, 0).measure;
draftTailMeasure.entries = [];
const draftHeld = new Chord(draftTailMeasure);
draftHeld.position = new Fraction(0);
draftHeld.duration = new Fraction(4);
draftHeld.beats = 4;
const draftHeldNote = new Note(draftHeld);
draftHeldNote.pitch = 60;
draftHeldNote.number = "1";
draftHeld.add(draftHeldNote);
draftTailMeasure.add(draftHeld);
const draftSecondBeat = inputNoteAtCursor(
  draftTailScore,
  cursor(0, 0, 1, 16),
  { pitch: 62, number: "2" },
  new Fraction(1),
);
check(draftSecondBeat.changed, "a quarter attack should replace the held second beat");
completeInputMeasure(draftTailScore, cursor(0, 0, 1, 16), true);
const draftTailChords = draftTailMeasure.entries
  .filter((entry): entry is Chord => entry instanceof Chord)
  .sort((left, right) => left.position.compareTo(right.position));
check(draftHeld.duration?.equals(new Fraction(1)),
  "the previous implicit sustain should stop at the new attack");
check(draftSecondBeat.chord?.duration?.equals(new Fraction(1)),
  "the newly typed quarter must retain its selected duration");
check(draftTailChords.filter((entry) => entry.rest).some((entry) =>
  entry.position.equals(new Fraction(2)) && entry.duration?.equals(new Fraction(1)))
  && draftTailChords.filter((entry) => entry.rest).some((entry) =>
    entry.position.equals(new Fraction(3)) && entry.duration?.equals(new Fraction(1))),
  "the unfilled last two beats should immediately become two beat-local rests");

// Moving into a target rest keeps the remaining target silence and fills the source gap.
const moveRestScore = new Score();
moveRestScore.parts.push(new Part(), new Part());
const moveSourceMeasure = restMeasure(moveRestScore, 0, 0);
const moveTargetMeasure = restMeasure(moveRestScore, 1, 0);
const moveSource = inputNoteAtCursor(moveRestScore, cursor(0, 0, 0, 4), { pitch: 72, number: "1" });
moveSource.chord!.duration = new Fraction(1);
const movedWithRest = moveInputNoteToPart(moveRestScore, 0, moveSource.chord!, moveSource.note!, 1);
check(movedWithRest.changed, "move into a target rest should succeed");
check(moveTargetMeasure.entries.includes(movedWithRest.targetChord!),
  "a note moved into a split rest was attached to a detached target chord");
const targetRests = moveTargetMeasure.entries
  .filter((entry): entry is Chord => entry instanceof Chord && entry.rest);
check([1, 2, 3].every((position) => targetRests.some((rest) =>
  rest.position.equals(position) && rest.duration?.equals(1))),
  "target rest should retain its unused beat-local tail");
check(moveSourceMeasure.entries.some((entry) => entry instanceof Chord && entry.rest),
  "source voice should receive a rest after its note is moved");

// Moving into another voice's held region truncates that sustain. Moving the
// tone back must attach it to a live Chord rather than the consumed rest
// object, and the released target tail remains silence.
const returnMoveScore = new Score();
returnMoveScore.parts.push(new Part(), new Part());
const returnSourceMeasure = restMeasure(returnMoveScore, 0, 0);
const returnTargetMeasure = restMeasure(returnMoveScore, 1, 0);
const returnSource = inputNoteAtCursor(
  returnMoveScore,
  { ...cursor(0, 0, 0, 16), offset: new Fraction(1, 4) },
  { pitch: 60, number: "1" },
  new Fraction(1, 4),
);
returnTargetMeasure.entries = [];
const heldTargetChord = new Chord(returnTargetMeasure);
heldTargetChord.position = new Fraction(0);
heldTargetChord.duration = new Fraction(2);
const heldTargetNote = new Note(heldTargetChord);
heldTargetNote.pitch = 53;
heldTargetNote.number = "4";
heldTargetChord.add(heldTargetNote);
returnTargetMeasure.add(heldTargetChord);
const movedDown = moveInputNoteToPart(
  returnMoveScore,
  0,
  returnSource.chord!,
  returnSource.note!,
  1,
);
check(movedDown.changed
  && heldTargetChord.duration?.equals(new Fraction(1, 4))
  && movedDown.targetChord?.position.equals(new Fraction(1, 4))
  && movedDown.targetChord.duration?.equals(new Fraction(1, 4))
  && returnTargetMeasure.entries.some((entry) => entry instanceof Chord && entry.rest
    && entry.position.equals(new Fraction(1, 2))),
"moving into a held target did not truncate its tail into rests");
const movedUp = moveInputNoteToPart(
  returnMoveScore,
  1,
  movedDown.targetChord!,
  movedDown.note!,
  0,
);
check(movedUp.changed
  && movedUp.targetChord !== null
  && returnSourceMeasure.entries.includes(movedUp.targetChord)
  && movedUp.targetChord.position.equals(new Fraction(1, 4))
  && movedUp.note?.pitch === 60
  && !returnTargetMeasure.entries.some((entry) => entry instanceof Chord
    && !entry.rest && entry.notes.some((note) => note.pitch === 60)),
"a tone disappeared when moved back from the adjacent voice");

// A target staff with less remaining room clips the moved tone at its barline.
const clippedMoveScore = new Score();
clippedMoveScore.parts.push(new Part(), new Part());
const clippedSourceMeasure = ensureInputMeasure(clippedMoveScore, 0, 0).measure;
clippedSourceMeasure.time.beats = 6;
const clippedSourceChord = new Chord(clippedSourceMeasure);
clippedSourceChord.position = new Fraction(3);
clippedSourceChord.duration = new Fraction(2);
const clippedSourceNote = new Note(clippedSourceChord);
clippedSourceNote.pitch = 67;
clippedSourceNote.number = "5";
clippedSourceChord.add(clippedSourceNote);
clippedSourceMeasure.add(clippedSourceChord);
const clippedTargetMeasure = restMeasure(clippedMoveScore, 1, 0);
const clippedMove = moveInputNoteToPart(clippedMoveScore, 0, clippedSourceChord, clippedSourceNote, 1);
check(clippedMove.changed && clippedMove.targetChord?.duration?.equals(1),
  "cross-part movement should stop at the target measure barline");
check(clippedMove.targetChord!.position.equals(3) && clippedTargetMeasure.duration.equals(4),
  "clipped cross-part movement should keep the synchronized target position");

// Moving a tied tone to another staff must detach both neighbours instead of
// leaving a continuation pointing at the removed source Note object.
const tiedMoveScore = new Score();
tiedMoveScore.parts.push(new Part(), new Part());
const tiedMoveSourceMeasure = restMeasure(tiedMoveScore, 0, 0);
restMeasure(tiedMoveScore, 1, 0);
const tiedMoveSource = inputNoteAtCursor(tiedMoveScore, cursor(0, 0, 0, 4), { pitch: 60, number: "1" });
const tiedMoveFuture = inputNoteAtCursor(tiedMoveScore, cursor(0, 1, 0, 4), { pitch: 60, number: "1" });
tiedMoveSource.note!.tieStart = true;
tiedMoveSource.note!.tieNext = tiedMoveFuture.note;
tiedMoveFuture.note!.tieEnd = true;
tiedMoveFuture.note!.tiePrev = tiedMoveSource.note;
const detachedMove = moveInputNoteToPart(
  tiedMoveScore,
  0,
  tiedMoveSource.chord!,
  tiedMoveSource.note!,
  1,
);
check(detachedMove.changed && detachedMove.note !== null
  && !detachedMove.note.tieStart && !detachedMove.note.tieEnd
  && detachedMove.note.tiePrev === null && detachedMove.note.tieNext === null,
"a tone moved to another staff should start with a clean tie state");
check(!tiedMoveFuture.note!.tieEnd && tiedMoveFuture.note!.tiePrev === null,
  "the old following continuation must be detached from a moved tone");
void tiedMoveSourceMeasure;

// Moving a selected tie continuation in input mode is a move of the complete
// sounding chain. The chain may cross a barline, but its total written span
// and one-shot playback identity must remain intact.
const tieTimelineScore = new Score();
tieTimelineScore.parts.push(new Part());
const tieM0 = restMeasure(tieTimelineScore, 0, 0);
const tieM1 = restMeasure(tieTimelineScore, 0, 1);
tieM0.position = new Fraction(0);
tieM1.position = new Fraction(4);
tieM0.entries = tieM0.entries.filter((entry) => !(entry instanceof Chord));
tieM1.entries = tieM1.entries.filter((entry) => !(entry instanceof Chord));
const makeRest = (measure: Measure, position: number, duration: number): Chord => {
  const rest = new Chord(measure);
  rest.rest = true;
  rest.position = new Fraction(position);
  rest.duration = new Fraction(duration);
  const note = new Note(rest);
  note.rest = true;
  note.number = "0";
  rest.add(note);
  measure.add(rest);
  return rest;
};
makeRest(tieM0, 0, 3);
makeRest(tieM1, 1, 3);
const tieRoot = new Chord(tieM0);
tieRoot.position = new Fraction(3);
tieRoot.duration = new Fraction(1);
const tieRootNote = new Note(tieRoot);
tieRootNote.pitch = 60;
tieRootNote.number = "1";
tieRootNote.tieStart = true;
tieRoot.add(tieRootNote);
tieM0.add(tieRoot);
const tieTail = new Chord(tieM1);
tieTail.position = new Fraction(0);
tieTail.duration = new Fraction(1);
const tieTailNote = new Note(tieTail);
tieTailNote.pitch = 60;
tieTailNote.number = "1";
tieTailNote.tieEnd = true;
tieTailNote.tiePrev = tieRootNote;
tieRootNote.tieNext = tieTailNote;
tieTail.add(tieTailNote);
tieM1.add(tieTail);
const chainMove = moveScoreNotesOnTimeline(
  tieTimelineScore,
  [{ partIndex: 0, note: tieTailNote, grace: false }],
  new Fraction(1, 2),
  { preserveRests: true, moveWholeTieChain: true },
);
const movedChain = tieTimelineScore.parts[0].measures.flatMap((measure) =>
  measure.entries.filter((entry): entry is Chord => entry instanceof Chord
    && entry.notes.some((note) => !note.rest && note.pitch === 60)));
const movedRoot = movedChain.find((chord) => chord.notes.some((note) => note.tiePrev === null));
const movedTail = movedChain.find((chord) => chord.notes.some((note) => note.tiePrev !== null));
check(chainMove.changed === 1 && movedRoot && movedTail,
  "moving a tie continuation should relocate the complete chain");
check(movedRoot!.measure.position.plus(movedRoot!.position).equals(new Fraction(7, 2)),
  "the tie root should move by the requested grid step");
check(movedRoot!.duration!.plus(movedTail!.duration!).equals(new Fraction(2)),
  "moving a tie chain must preserve its total duration");
check(movedRoot!.notes[0].tieNext === movedTail!.notes[0]
  && movedTail!.notes[0].tiePrev === movedRoot!.notes[0],
"a cross-bar tie must be rebuilt after moving the chain");

// TXT's compact 32nd spelling must survive the complete input-mode edit
// sequence, including the asymmetric state where a written 16th-triplet
// member is followed by one remaining 32nd-triplet rest.  This used to save
// as `[1.0]`, reload the final zero as a 16th, and change the bar length.
const compactTripletMoveScore = new Score();
compactTripletMoveScore.parts.push(new Part());
restMeasure(compactTripletMoveScore);
const compactTripletCreated = createInputTriplet(
  compactTripletMoveScore,
  cursor(0, 0, 0, 32),
  new Fraction(1, 8),
  new Fraction(1, 4),
);
const compactTripletInput = inputNoteAtCursor(
  compactTripletMoveScore,
  cursor(0, 0, 0, 32),
  { pitch: 60, number: "1" },
  new Fraction(1, 8),
).note!;
const compactTripletMovedRight = moveInputTieChainByNotationDomain(
  compactTripletMoveScore,
  0,
  compactTripletInput,
  new Fraction(1, 8),
  1,
);
const compactTripletExtended = resizeInputTupletMember(
  compactTripletMoveScore,
  compactTripletMovedRight.note!,
  new Fraction(1, 12),
);
const compactTripletRightTxt = scoreToSlashScore(
  compactTripletMoveScore,
  "number",
  16,
  ".",
  { braceMode: "arpeggio", bracketMode: "triplet", showExplicitRests: true },
  1,
);
const compactTripletRightOptions = defaultSlashScoreOptions(
  "number",
  analyzeSlashScore(compactTripletRightTxt),
);
compactTripletRightOptions.showExplicitRests = true;
const compactTripletRightReload = parseSlashScore(
  compactTripletRightTxt,
  compactTripletRightOptions,
);
const compactTripletRightMembers = compactTripletRightReload.score.parts[0]?.measures[0]?.entries
  .filter((entry): entry is Chord => entry instanceof Chord
    && entry.notes.some((note) => note.tuplet !== null)) ?? [];
check(compactTripletRightTxt.includes("[01.]")
  && compactTripletRightReload.summary.diagnostics.every((item) => item.severity !== "error")
  && compactTripletRightMembers.length === 2
  && compactTripletRightMembers[0]!.duration?.equals(new Fraction(1, 12))
  && compactTripletRightMembers[1]!.duration?.equals(new Fraction(1, 6)),
`a lengthened trailing 32nd-triplet member did not round-trip exactly:\n${compactTripletRightTxt}\n${
  JSON.stringify(compactTripletRightReload.summary.diagnostics)
}`);
const compactTripletMovedLeft = moveInputTieChainByNotationDomain(
  compactTripletMoveScore,
  0,
  compactTripletMovedRight.note!,
  new Fraction(1, 8),
  -1,
);
const compactTriplet = compactTripletCreated.chords[0]!.notes[0]!.tuplet!;
const compactTripletMembers = inputTupletMembers(compactTriplet);
check(compactTripletMovedRight.changed && compactTripletExtended.changed
  && compactTripletMovedLeft.changed
  && compactTripletMovedLeft.note?.chord.position.equals(new Fraction(0))
  && compactTripletMovedLeft.note.chord.duration?.equals(new Fraction(1, 6))
  && compactTripletMembers.length === 2
  && compactTripletMembers.some((chord) => chord.rest
    && chord.position.equals(new Fraction(1, 6))
    && chord.duration?.equals(new Fraction(1, 12))),
"moving an extended 32nd-triplet member should preserve its trailing fine rest");
const compactTripletTxt = scoreToSlashScore(
  compactTripletMoveScore,
  "number",
  16,
  ".",
  { braceMode: "arpeggio", bracketMode: "triplet", showExplicitRests: true },
  1,
);
const compactTripletTxtOptions = defaultSlashScoreOptions(
  "number",
  analyzeSlashScore(compactTripletTxt),
);
compactTripletTxtOptions.showExplicitRests = true;
const compactTripletReload = parseSlashScore(compactTripletTxt, compactTripletTxtOptions);
const compactTripletReloadMembers = compactTripletReload.score.parts[0]?.measures[0]?.entries
  .filter((entry): entry is Chord => entry instanceof Chord
    && entry.notes.some((note) => note.tuplet !== null)) ?? [];
check(compactTripletTxt.includes("[1.0]")
  && compactTripletReload.summary.diagnostics.every((item) => item.severity !== "error")
  && compactTripletReloadMembers.length === 2
  && compactTripletReloadMembers[0]!.duration?.equals(new Fraction(1, 6))
  && compactTripletReloadMembers[1]!.duration?.equals(new Fraction(1, 12)),
`mixed 32nd-triplet TXT did not round-trip exactly:\n${compactTripletTxt}\n${
  JSON.stringify(compactTripletReload.summary.diagnostics)
}`);

// A meter edit is structural: it propagates until the next explicit change,
// clips the editable bars, fills their rests, and rebuilds absolute positions.
const meterScore = new Score();
meterScore.parts.push(new Part());
ensureInputMeasure(meterScore, 0, 2);
const meterChanged = applyInputTimeSignature(meterScore, 1, 3, 4, true);
const meterMeasures = meterScore.parts[0].measures;
check(meterChanged && meterMeasures[0].time.beats === 4
  && meterMeasures[1].time.beats === 3 && meterMeasures[1].time.beatType === 4
  && meterMeasures[1].timeChange
  && meterMeasures[2].time.beats === 3 && meterMeasures[2].time.beatType === 4,
"a 3/4 edit should begin at the selected measure and remain active afterwards");
check(meterMeasures[1].duration.equals(3) && meterMeasures[2].position.equals(7),
  "meter editing should rebuild measure durations and absolute positions");
const meterRests = meterMeasures[1].entries
  .filter((entry): entry is Chord => entry instanceof Chord && entry.rest);
check(meterRests.length === 3 && meterRests.every((rest, index) =>
  rest.position.equals(index) && rest.duration?.equals(1)),
  "the shortened edited measure should contain three beat-local rests");

// Moving a sounding triplet tone to an empty voice must copy the editable
// 3:2 container, while an incompatible target container must reject the move.
const crossVoiceTuplet = new Score();
crossVoiceTuplet.parts.push(new Part(), new Part());
restMeasure(crossVoiceTuplet, 0, 0);
restMeasure(crossVoiceTuplet, 1, 0);
const crossSource = inputNoteAtCursor(
  crossVoiceTuplet,
  cursor(0, 0, 0, 16),
  { pitch: 60, number: "1" },
  new Fraction(1, 4),
).note!;
const crossCreated = createInputTriplet(crossVoiceTuplet, cursor(0, 0, 0, 16), new Fraction(1, 4));
const crossTuplet = crossCreated.chords[0]!.notes[0]!.tuplet!;
const crossMoved = moveInputNoteToPart(crossVoiceTuplet, 0, crossSource.chord, crossSource, 1);
const movedMembers = crossVoiceTuplet.parts[1].measures[0].entries.filter(
  (entry): entry is Chord => entry instanceof Chord
    && entry.notes.some((note) => note.tuplet !== null),
);
check(crossMoved.changed && movedMembers.length === 3
  && movedMembers.every((chord) => chord.notes.some((note) => note.tuplet !== null))
  && crossVoiceTuplet.parts[0].measures[0].entries.some((entry) =>
    entry instanceof Chord && entry.rest && entry.notes.some((note) => note.tuplet === crossTuplet)),
"moving a triplet tone to an empty voice should preserve a complete editable triplet container");
const movedJpw = fromJpw(JpwFile.fromString(scoreToJpwabc(crossVoiceTuplet))!);
const movedTxt = scoreToSlashScore(
  crossVoiceTuplet,
  "number",
  16,
  ".",
  { braceMode: "grace", bracketMode: "triplet", showExplicitRests: true },
  2,
);
const movedTxtReload = parseSlashScore(
  movedTxt,
  defaultSlashScoreOptions("number", analyzeSlashScore(movedTxt)),
).score;
check(movedJpw.parts.some((part) => part.measures.some((measure) => measure.entries.some((entry) =>
    entry instanceof Chord && entry.notes.some((note) => note.tuplet !== null))))
  && movedTxtReload.parts.some((part) => part.measures.some((measure) => measure.entries.some((entry) =>
    entry instanceof Chord && entry.notes.some((note) => note.tuplet !== null)))),
"a cross-voice triplet should retain its group through JPW and TXT round-trip");
const incompatibleTarget = new Score();
incompatibleTarget.parts.push(new Part(), new Part());
restMeasure(incompatibleTarget, 0, 0);
restMeasure(incompatibleTarget, 1, 0);
const incompatibleSource = inputNoteAtCursor(
  incompatibleTarget,
  cursor(0, 0, 0, 16),
  { pitch: 60, number: "1" },
  new Fraction(1, 4),
).note!;
createInputTriplet(incompatibleTarget, cursor(0, 0, 0, 16), new Fraction(1, 4));
const incompatibleTargetNote = inputNoteAtCursor(
  incompatibleTarget,
  cursor(1, 0, 0, 8),
  { pitch: 65, number: "4" },
  new Fraction(1, 2),
).note!;
createInputTriplet(incompatibleTarget, cursor(1, 0, 0, 8), new Fraction(1, 2));
const targetBefore = scoreToJpwabc(incompatibleTarget);
const rejectedMove = moveInputNoteToPart(
  incompatibleTarget,
  0,
  incompatibleSource.chord,
  incompatibleSource,
  1,
);
check(!rejectedMove.changed && scoreToJpwabc(incompatibleTarget) === targetBefore
  && incompatibleSource.chord.notes.includes(incompatibleSource),
"moving into an incompatible target triplet should be rejected without changing either voice");

console.log("input-edit-check: ok");
