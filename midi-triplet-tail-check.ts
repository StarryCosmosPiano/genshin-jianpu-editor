import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { analyzeMidi, midiToScore, parseMidi, type MidiOutputFormat, type ParsedMidi } from "./src/midi";
import { JpwFile } from "./src/jpword/jpwfile";
import { fromJpw } from "./src/score/jpwimport";
import { scoreToJpwabc } from "./src/score/jpscore";
import { Chord, type Score } from "./src/score/score";
import { buildTimeline } from "./src/score/timeline";

const EPSILON = 1e-8;
const failures: string[] = [];
let checks = 0;

function check(name: string, action: () => void): void {
  try {
    action();
    checks++;
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface SourceNote { part: 0 | 1; start: number; end: number; pitch: number }

function fixture(notes: SourceNote[]): ParsedMidi {
  const ppq = 480;
  return {
    format: 1, ppq, trackCount: 3, title: "Triplet release regression",
    tracks: [
      { index: 0, name: "Conductor", noteCount: 0 },
      { index: 1, name: "Right Hand", noteCount: notes.filter(note => note.part === 0).length },
      { index: 2, name: "Left Hand", noteCount: notes.filter(note => note.part === 1).length },
    ],
    notes: notes.map(note => ({
      startTick: Math.round(note.start * ppq), endTick: Math.round(note.end * ppq),
      pitch: note.pitch, velocity: 100, channel: note.part, track: note.part + 1,
    })),
    tempos: [{ tick: 0, bpm: 114 }],
    timeSignatures: [{ tick: 0, beats: 4, beatType: 4 }],
    keySignatures: [{ tick: 0, fifths: 0, minor: false }],
    ignoredEvents: 0, endTick: 12 * ppq,
  };
}

function importScore(parsed: ParsedMidi, outputFormat: MidiOutputFormat): Score {
  const analysis = analyzeMidi(parsed);
  return midiToScore(parsed, {
    outputFormat, quantize: 16, detectTriplets: true, handMode: "auto",
    splitPitch: analysis.splitPitch, fifths: 0, beats: 4, beatType: 4,
  }).score;
}

function assertAttack(score: Score, part: number, pitch: number, start: number, end: number): void {
  const matches = buildTimeline(score).notes.filter(note => note.part === part && note.pitch === pitch
    && Math.abs(note.t0 - start) < EPSILON);
  assert.equal(matches.length, 1, `${pitch}@${start}: missing or repeated attack`);
  assert(Math.abs(matches[0]!.t1 - end) < EPSILON,
    `${pitch}@${start}: release ${matches[0]!.t1}, expected ${end}`);
}

function chords(score: Score, part: number, measure: number): Chord[] {
  return score.parts[part]!.measures[measure]!.entries.filter((entry): entry is Chord => entry instanceof Chord);
}

function notes(lastEnd: number, nextStart: number, nextPitch = 69): SourceNote[] {
  return [
    { part: 0, pitch: 60, start: 0, end: 2 },
    { part: 0, pitch: 62, start: 2, end: 7 / 3 },
    { part: 0, pitch: 64, start: 7 / 3, end: 8 / 3 },
    { part: 0, pitch: 67, start: 8 / 3, end: lastEnd },
    { part: 0, pitch: nextPitch, start: nextStart, end: nextStart + 1 },
    { part: 1, pitch: 48, start: 0, end: 4 },
    { part: 1, pitch: 50, start: 4, end: 8 },
    { part: 1, pitch: 52, start: 8, end: 12 },
  ];
}

for (const outputFormat of ["jpw", "keyboard", "number"] as const) {
  check(`${outputFormat}: unequal chord releases keep an ordinary binary tail`, () => {
    const source = notes(3.5, 4);
    source.push({ part: 0, pitch: 71, start: 8 / 3, end: 3.75 });
    let score = importScore(fixture(source), outputFormat);
    // Existing chord policy combines independently quantized releases using
    // their median, then rounds to the selected binary grid: 3.625 -> 3.75.
    // The ordinary tail must never be re-quantized to the tuplet grid (11/3).
    for (let cycle = 0; cycle < 3; cycle++) {
      assertAttack(score, 0, 67, 8 / 3, 3.75);
      assertAttack(score, 0, 71, 8 / 3, 3.75);
      const first = chords(score, 0, 0);
      const members = first.filter(chord => chord.notes.some(note => note.tuplet));
      assert.equal(members.length, 3, "The chord tail must stay outside the true tuplet members");
      const tail = first.find(chord => !chord.rest && Math.abs(chord.position.toFloat() - 3) < EPSILON);
      assert(tail && Math.abs(tail.duration!.toFloat() - 0.75) < EPSILON,
        "The ordinary tail must be a dotted eighth, not an unmarked fractional value");
      assert(tail.notes.every(note => note.tieEnd && !note.tuplet));
      score = fromJpw(JpwFile.fromString(scoreToJpwabc(score)));
    }
  });

  check(`${outputFormat}: last member sustains through a whole following measure`, () => {
    const score = importScore(fixture(notes(8, 8)), outputFormat);
    assertAttack(score, 0, 67, 8 / 3, 8);
    assertAttack(score, 0, 69, 8, 9);
    const first = chords(score, 0, 0);
    const members = first.filter(chord => chord.notes.some(note => note.tuplet));
    assert.equal(members.length, 3, "Only the three true members belong in the tuplet");
    assert(members.every(chord => Math.abs(chord.duration!.toFloat() - 1 / 3) < EPSILON));
    const following = chords(score, 0, 1);
    assert.equal(following.length, 1, "A whole-measure tail should be one written value");
    const whole = following[0]!;
    assert.equal(whole.duration!.toFloat(), 4);
    assert.equal(whole.beats, 4);
    assert.equal(whole.beams, 0);
    assert(whole.notes.every(note => note.tieEnd && !note.tuplet), "Whole tail must tie from the tuplet without joining it");
    const jpw = fromJpw(JpwFile.fromString(scoreToJpwabc(score)));
    assertAttack(jpw, 0, 67, 8 / 3, 8);
  });

  check(`${outputFormat}: preserve an actual release before the next attack`, () => {
    const score = importScore(fixture(notes(3.75, 4)), outputFormat);
    assertAttack(score, 0, 67, 8 / 3, 3.75);
    const rest = chords(score, 0, 0).find(chord => chord.rest && Math.abs(chord.position.toFloat() - 3.75) < EPSILON);
    assert(rest && Math.abs(rest.duration!.toFloat() - 0.25) < EPSILON,
      "An explicit source gap after the held member must remain a rest");
  });

  check(`${outputFormat}: a later attack clips an overlapping held triplet`, () => {
    const score = importScore(fixture(notes(8, 4)), outputFormat);
    assertAttack(score, 0, 67, 8 / 3, 4);
    assertAttack(score, 0, 69, 4, 5);
  });

  check(`${outputFormat}: a same-pitch retrigger stays a separate attack`, () => {
    const score = importScore(fixture(notes(8, 4, 67)), outputFormat);
    assertAttack(score, 0, 67, 8 / 3, 4);
    assertAttack(score, 0, 67, 4, 5);
    const attack = chords(score, 0, 1).find(chord => Math.abs(chord.position.toFloat()) < EPSILON)!;
    assert(attack.notes.every(note => !note.tieEnd), "A real same-pitch retrigger must not be tied");
  });
}

const midiPath = process.argv[2];
if (midiPath) {
  const parsed = parseMidi(new Uint8Array(await readFile(midiPath)));
  for (const outputFormat of ["jpw", "keyboard", "number"] as const) {
    check(`${outputFormat}: supplied MIDI measure 112 D4 release`, () => {
      const source = parsed.notes.find(note => note.pitch === 62
        && Math.abs(note.startTick / parsed.ppq - (446 + 2 / 3)) < EPSILON);
      assert(source, "Expected supplied MIDI D4 attack is missing");
      const score = importScore(parsed, outputFormat);
      assertAttack(score, 1, 62, source.startTick / parsed.ppq, source.endTick / parsed.ppq);
      const tail = chords(score, 1, 112);
      assert.equal(tail.length, 1, "Measure 113 should contain one whole-note tail");
      assert.equal(tail[0]!.duration!.toFloat(), 4);
      assert(tail[0]!.notes.every(note => note.pitch === 62 && note.tieEnd && !note.tuplet));
    });
  }
}

if (failures.length > 0) throw new Error(failures.join("\n"));
console.log(`midi-triplet-tail-check: ${checks} checks passed`);
