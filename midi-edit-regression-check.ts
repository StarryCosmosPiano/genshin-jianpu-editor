import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Chord, type Score } from "./src/score/score";
import { buildTimeline } from "./src/score/timeline";
import { parseMidi, analyzeMidi, midiToScore } from "./src/midi";
import { parseEditableDocument } from "./src/editor/document-parser";
import { preserveUnchangedSlashGroups } from "./src/editor/preserve-slash-delimiters";
import {
  analyzeSlashScore, defaultSlashScoreOptions, embedSlashScoreOptions,
  embedSlashScoreOptionsFromScore, notationAnnotationsFromScore,
  replaceSlashScoreLines, rewriteSlashDurationDirectives, scoreToSlashScore,
  type SlashScoreKind, type SlashScoreOptions,
} from "./src/slashscore";

const marker = "\u2063";
const epsilon = 1e-8;
const modes = { braceMode: "arpeggio", bracketMode: "triplet", barMode: "none",
  angleMode: "grace", parenMode: "chord", ordering: "pitch-asc" } as const;
let checks = 0;
const failures: string[] = [];
function check(label: string, action: () => void): void {
  try { action(); checks++; }
  catch (error) { failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
}
function optionsFor(text: string, kind: SlashScoreKind, rests: boolean): SlashScoreOptions {
  return { ...defaultSlashScoreOptions(kind, analyzeSlashScore(text)), ...modes,
    beats: 4, beatType: 4, voiceCount: 2, symbolDurations: { ".": 16 },
    noteDivision: null, showExplicitRests: rests };
}
const sounds = (score: Score) => buildTimeline(score).notes.map(note => ({
  part: note.part, pitch: note.pitch, start: note.t0, end: note.t1,
})).sort((a, b) => a.start - b.start || a.part - b.part || a.pitch - b.pitch);
function sameSounds(actual: ReturnType<typeof sounds>, expected: ReturnType<typeof sounds>): void {
  assert.equal(actual.length, expected.length, "attack count");
  expected.forEach((wanted, index) => {
    const found = actual[index]!;
    assert.equal(found.part, wanted.part, `voice at ${wanted.start}`);
    assert.equal(found.pitch, wanted.pitch, `pitch at ${wanted.start}`);
    assert(Math.abs(found.start - wanted.start) < epsilon, `onset at ${wanted.start}`);
    assert(Math.abs(found.end - wanted.end) < epsilon, `release at ${wanted.start}`);
  });
}
function chordAt(score: Score, part: number, measure: number, offset: number): Chord {
  const chord = score.parts[part]?.measures[measure]?.entries.find((entry): entry is Chord =>
    entry instanceof Chord && !entry.rest && Math.abs(entry.position.toFloat() - offset) < epsilon);
  assert(chord, `missing voice ${part}, measure ${measure + 1}, offset ${offset}`);
  return chord;
}
function writtenValues(score: Score): void {
  for (const part of score.parts) for (const measure of part.measures) for (const chord of measure.entries) {
    if (!(chord instanceof Chord) || !chord.duration) continue;
    const tuplet = chord.notes.find(note => note.tuplet)?.tuplet;
    const written = chord.beats / 2 ** chord.beams * (chord.dot ? 2 - 2 ** -chord.dot : 1);
    const actual = tuplet ? written * tuplet.ratioDenominator / tuplet.ratioNumerator : written;
    assert(Math.abs(actual - chord.duration.toFloat()) < epsilon,
      `invalid written value in measure ${measure.index + 1}, offset ${chord.position}: ${actual} != ${chord.duration}`);
  }
}
function adjacentTuplets(score: Score, measure: number, start: number, continued: boolean): void {
  const first = chordAt(score, 1, measure, start);
  const oldG = chordAt(score, 1, measure, start + 2 / 3);
  const nextG = chordAt(score, 1, measure, start + 1);
  const nextC = chordAt(score, 1, measure, start + 4 / 3);
  const nextD = chordAt(score, 1, measure, start + 5 / 3);
  const firstTuplet = first.notes.find(note => note.tuplet)?.tuplet;
  const secondTuplet = nextG.notes.find(note => note.tuplet)?.tuplet;
  assert(firstTuplet && secondTuplet && firstTuplet !== secondTuplet, "two distinct 3:2 groups");
  assert.equal(firstTuplet.memberChords().length, 2, "first group has two written members");
  assert.equal(secondTuplet.memberChords().length, 3, "second group retains its first member");
  assert(Math.abs((first.duration?.toFloat() ?? 0) - 2 / 3) < epsilon);
  assert.equal(first.beams, 0);
  for (const chord of [oldG, nextG, nextC, nextD]) {
    assert(Math.abs((chord.duration?.toFloat() ?? 0) - 1 / 3) < epsilon);
    assert.equal(chord.beams, 1);
    assert.equal(chord.dot, 0);
    assert(chord.notes.every(note => note.tuplet !== null));
  }
  assert(nextC.notes.every(note => note.tuplet === secondTuplet));
  assert(nextD.notes.every(note => note.tuplet === secondTuplet));
  assert.equal(nextG.transparentContinuation, continued, "second-group G continuation");
  const previousNote = oldG.notes.find(note => note.pitch === 55)!;
  const nextNote = nextG.notes.find(note => note.pitch === 55)!;
  assert(previousNote && nextNote, "both G3 written members exist");
  if (continued) {
    assert.equal(previousNote.tieNext, nextNote);
    assert.equal(nextNote.tiePrev, previousNote);
    assert(nextNote.tieEnd);
  } else {
    assert.equal(previousNote.tieNext, null, "real repeated G3 must end normally");
    assert.equal(nextNote.tiePrev, null, "real repeated G3 must attack again");
    assert.equal(nextNote.tieEnd, false);
  }
}
function reopen(text: string, options: SlashScoreOptions): Score {
  const parsed = parseEditableDocument(text, options.kind, options);
  assert(parsed, "editable document parses");
  assert.equal(parsed.slashTimingDiagnostics.length, 0, "timing diagnostics");
  return parsed.score;
}
/** Mirrors App.serializeCurrentScoreDocument for an ordinary pitch edit. */
function serializeEdit(text: string, score: Score, previous: SlashScoreOptions): string {
  const options: SlashScoreOptions = { ...previous, symbolDurations: { ...previous.symbolDurations },
    noteTimingEdits: [], sourceTimedRows: false, adjacentAsChord: undefined };
  const generated = scoreToSlashScore(score, options.kind, 16, ".", {
    ...modes, durationNotation: options,
  }, options.voiceCount);
  const rewritten = rewriteSlashDurationDirectives(
    replaceSlashScoreLines(text, generated, options.kind), options);
  options.annotations = notationAnnotationsFromScore(score);
  return embedSlashScoreOptionsFromScore(
    preserveUnchangedSlashGroups(text, rewritten, options.kind, options), score, options);
}
function pitchEditAndTwoSaves(text: string, options: SlashScoreOptions,
  inspect: (score: Score) => void, targetMeasure: number, targetOffset: number): void {
  let score = reopen(text, options);
  inspect(score);
  writtenValues(score);
  // This is the ordinary note branch of App.typeInputDegree: change one
  // selected pitch, preserving its existing duration and all other voices.
  const target = chordAt(score, 0, targetMeasure, targetOffset).notes.find(note => !note.rest)!;
  assert.equal(target.tiePrev, null);
  assert.equal(target.tieNext, null);
  target.pitch = target.pitch === 67 ? 69 : 67;
  target.number = target.pitch === 67 ? "5" : "6";
  target.jpOctave = 0;
  target.jpAlter = " ";
  const oracle = sounds(score);
  for (let pass = 0; pass < 2; pass++) {
    text = serializeEdit(text, score, options);
    score = reopen(text, options);
    sameSounds(sounds(score), oracle);
    writtenValues(score);
    inspect(score);
  }
}
function fixture(kind: SlashScoreKind, continued: boolean): string {
  if (kind === "keyboard") return `键盘谱\n4/4拍：\n. = 16分音符\n`
    + `[(N${marker}A)..${marker}S..(B${marker}D)..]/`
    + `[${continued ? `${marker}F` : `(B${marker}F)`}..(A${marker}G)..(S${marker}H)..]/`
    + `(C${marker}J)..../(V${marker}A)..../\n`;
  return `数字谱\n4/4拍：\n. = 16分音符\n`
    + `[(-6${marker}1)..${marker}2..(-5${marker}3)..]/`
    + `[${continued ? `${marker}4` : `(-5${marker}4)`}..(1${marker}5)..(2${marker}6)..]/`
    + `(-3${marker}7)..../(-4${marker}1)..../\n`;
}
for (const kind of ["keyboard", "number"] as const) for (const rests of [true, false]) {
  for (const continued of [false, true]) {
    check(`${kind}, rests=${rests}, ${continued ? "real cross-group sustain" : "real repeated G3"}`, () => {
      let text = fixture(kind, continued);
      const options = optionsFor(text, kind, rests);
      if (continued) options.annotations = [{ type: "triplet", part: 1, voice: 2,
        measure: 0, offset: 1, end: 2, scope: "all", members: [.5, .5, .5],
        memberContinuations: [true, false, false] }];
      text = embedSlashScoreOptions(text, options);
      const inspect = (score: Score) => {
        adjacentTuplets(score, 0, 0, continued);
        const notes = sounds(score);
        assert.equal(notes.length, continued ? 14 : 15);
        const gs = notes.filter(note => note.part === 1 && note.pitch === 55);
        assert.equal(gs.length, continued ? 1 : 2);
        assert(Math.abs(gs[0]!.start - 2 / 3) < epsilon);
        assert(Math.abs(gs[0]!.end - (continued ? 4 / 3 : 1)) < epsilon);
        if (!continued) {
          assert(Math.abs(gs[1]!.start - 1) < epsilon);
          assert(Math.abs(gs[1]!.end - 4 / 3) < epsilon);
        }
      };
      pitchEditAndTwoSaves(text, options, inspect, 0, 2);
    });
  }
}

if (process.argv[2]) {
  const midi = parseMidi(new Uint8Array(await readFile(process.argv[2])));
  assert.equal(midi.ppq, 480);
  assert.equal(midi.notes.length, 1217);
  for (const kind of ["keyboard", "number"] as const) for (const rests of [true, false]) {
    check(`provided accompaniment MIDI ${kind}, rests=${rests}, edit plus two saves`, () => {
      const source = midiToScore(midi, { outputFormat: kind, quantize: 16, detectTriplets: true,
        handMode: "auto", splitPitch: analyzeMidi(midi).splitPitch, scoreMode: "hands",
        fifths: 0, beats: 4, beatType: 4, tempoBpm: 114 }).score;
      const raw = scoreToSlashScore(source, kind, 16, ".", {
        sourceMidi: midi, ...modes, showExplicitRests: rests,
      }, 2);
      const options = optionsFor(raw, kind, rests);
      const text = embedSlashScoreOptionsFromScore(raw, source, options);
      const inspect = (score: Score) => {
        assert.equal(sounds(score).length, 1217, "all MIDI attacks survive");
        adjacentTuplets(score, 94, 2, false);
        const gs = sounds(score).filter(note => note.part === 1 && note.pitch === 55
          && note.start >= 378 - epsilon && note.start < 380 - epsilon);
        assert.equal(gs.length, 2);
        assert(Math.abs(gs[0]!.start - (378 + 2 / 3)) < epsilon);
        assert(Math.abs(gs[0]!.end - 379) < epsilon);
        assert(Math.abs(gs[1]!.start - 379) < epsilon);
        assert(Math.abs(gs[1]!.end - (379 + 1 / 3)) < epsilon);
      };
      // A note in another measure is edited; the m95 structure is untouched.
      pitchEditAndTwoSaves(text, options, inspect, 0, 2);
    });
  }
}
if (failures.length) {
  failures.forEach(message => console.error(message));
  throw new Error(`${failures.length} adjacent-tuplet edit checks failed`);
}
console.log(`midi-edit-regression-check: ${checks} checks passed`);
